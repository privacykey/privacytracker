//! "Allow phone connections": the desktop app's second listener.
//!
//! Inside the desktop app the server binds loopback and every `/api` call
//! needs the launch credential (desktop_auth.rs), so a phone on the same
//! Wi-Fi cannot reach it at all. Switching this on binds a SECOND listener
//! on the local network that serves only the companion routes, through
//! companion.rs's `required` middleware: every request must carry a valid
//! companion token and be a GET on the allowlist. It never serves pages,
//! the desktop bootstrap link, or any other route, and the loopback
//! listener is untouched.
//!
//! The connection is TLS with a self-signed certificate: there is no CA
//! for a LAN address, so the pairing code carries the certificate's
//! SHA-256 and the phone accepts that certificate and no other. The key
//! and certificate live in `<data dir>/companion-tls/` (0700 / 0600) and are
//! made on first use. `rustls` with the `ring` provider is already in the
//! build under reqwest; no certificate crate is, so [`self_signed_cert`]
//! writes the few DER structures a certificate needs by hand. Nothing
//! validates its contents but the phone's pin: rustls serves it, the phone
//! compares its hash.
//!
//! Only the core running inside the desktop app offers this
//! (`PRIVACYTRACKER_RUNTIME=desktop`). A Docker install is reached at its
//! own address; `pt-core serve` elsewhere reports the feature unsupported,
//! with the same reply the Node rollback gives.
//!
//! A process can hold several servers (the tests, the parity harness), so
//! the listener state is kept per server, keyed by its connection, as
//! live_runs.rs keys its registry.

use super::{lifecycle, settings, AppState};
use ring::{
    rand::SystemRandom,
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const ENABLED_KEY: &str = "companion_lan_enabled";
const PORT_KEY: &str = "companion_lan_port";
/// Fixed so a firewall rule or a phone's saved pairing keeps working
/// across launches. Unassigned by IANA.
pub(crate) const DEFAULT_PORT: u16 = 47831;
const TLS_DIR: &str = "companion-tls";
const CERT_FILE: &str = "cert.der";
const KEY_FILE: &str = "key.pk8";
/// How long a client may take over the TLS handshake before its
/// connection is dropped. hyper's header-read timeout starts after it.
pub(crate) const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

// ── Which servers can offer it ────────────────────────────────────────

#[cfg(test)]
thread_local! {
    static TEST_SUPPORTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(crate) fn set_test_supported(supported: bool) {
    TEST_SUPPORTED.with(|cell| cell.set(supported));
}

/// Whether this server may open the Wi-Fi listener: only inside the
/// desktop app.
pub(crate) fn supported() -> bool {
    #[cfg(test)]
    if TEST_SUPPORTED.with(std::cell::Cell::get) {
        return true;
    }
    crate::host_env::var("PRIVACYTRACKER_RUNTIME").is_ok_and(|v| v == "desktop")
}

// ── Per-server state ──────────────────────────────────────────────────

struct Running {
    stop: CancellationToken,
    port: u16,
    fingerprint: String,
}

struct Entry {
    parent: CancellationToken,
    state: AppState,
    running: Option<Running>,
    error: Option<String>,
}

fn servers() -> &'static Mutex<HashMap<usize, Entry>> {
    static SERVERS: OnceLock<Mutex<HashMap<usize, Entry>>> = OnceLock::new();
    SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key_of(state: &AppState) -> usize {
    Arc::as_ptr(&state.conn) as usize
}

fn lock_servers() -> std::sync::MutexGuard<'static, HashMap<usize, Entry>> {
    servers().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Called once by `serve_with`: remember how to stop this server's
/// listener with it, and open the listener now if it was left on.
pub(crate) fn attach(state: &AppState, parent: CancellationToken) {
    let key = key_of(state);
    lock_servers().insert(
        key,
        Entry {
            parent: parent.clone(),
            state: state.clone(),
            running: None,
            error: None,
        },
    );
    // Forget the entry once its server stops, so a later server that
    // happens to reuse the address never finds a stale one.
    tokio::spawn(async move {
        parent.cancelled().await;
        lock_servers().remove(&key);
    });
    if supported() && enabled_setting(state) {
        start(state);
    }
}

fn enabled_setting(state: &AppState) -> bool {
    settings::get_setting(state, ENABLED_KEY, "false").is_ok_and(|v| v == "true")
}

fn port_setting(state: &AppState) -> u16 {
    settings::get_setting(state, PORT_KEY, "")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(DEFAULT_PORT)
}

/// Switch the listener on or off, and remember the choice.
pub(crate) fn set_enabled(state: &AppState, enabled: bool) {
    {
        let conn = state.db();
        if let Err(e) = settings::set_setting_with(
            &conn,
            ENABLED_KEY,
            if enabled { "true" } else { "false" },
        ) {
            super::diag::log_error(format!("[companion] saving the Wi-Fi setting failed {e}"));
        }
    }
    if enabled {
        start(state);
    } else {
        stop(state);
    }
}

fn stop(state: &AppState) {
    let mut servers = lock_servers();
    if let Some(entry) = servers.get_mut(&key_of(state)) {
        if let Some(running) = entry.running.take() {
            running.stop.cancel();
        }
        entry.error = None;
    }
}

fn start(state: &AppState) {
    let key = key_of(state);
    let (parent, base_state) = {
        let servers = lock_servers();
        let Some(entry) = servers.get(&key) else {
            return;
        };
        if entry.running.is_some() {
            return;
        }
        (entry.parent.clone(), entry.state.clone())
    };
    let port = port_setting(&base_state);
    let outcome = open(&base_state, port, parent.child_token());
    let mut servers = lock_servers();
    if let Some(entry) = servers.get_mut(&key) {
        match outcome {
            Ok(running) => {
                entry.running = Some(running);
                entry.error = None;
            }
            Err(e) => {
                super::diag::log_warn(format!("[companion] Wi-Fi listener did not start: {e}"));
                entry.error = Some(e);
            }
        }
    } else if let Ok(running) = outcome {
        // The server stopped while the listener was opening.
        running.stop.cancel();
    }
}

fn open(state: &AppState, port: u16, stop: CancellationToken) -> Result<Running, String> {
    let identity = load_or_create_identity(&tls_dir())?;
    let acceptor = acceptor(&identity)?;
    let std_listener = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
        .map_err(|e| format!("port {port} is not available ({e})"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let listener = tokio::net::TcpListener::from_std(std_listener).map_err(|e| e.to_string())?;
    let lan_state = AppState {
        bound_port: port,
        ..state.clone()
    };
    tokio::spawn(lifecycle::accept_tls_loop(
        listener,
        super::lan_router(lan_state),
        stop.clone(),
        lifecycle::HEADER_READ_TIMEOUT,
        acceptor,
    ));
    Ok(Running {
        stop,
        port,
        fingerprint: identity.fingerprint,
    })
}

/// `GET /api/companion/lan`'s body. Outside the desktop app, exactly what
/// the Node rollback answers.
pub(crate) fn describe(state: &AppState) -> Value {
    if !supported() {
        return json!({
            "supported": false,
            "enabled": false,
            "running": false,
            "port": null,
            "addresses": [],
            "fingerprint": null,
            "error": null,
        });
    }
    let enabled = enabled_setting(state);
    let servers = lock_servers();
    let entry = servers.get(&key_of(state));
    let running = entry.and_then(|e| e.running.as_ref());
    json!({
        "supported": true,
        "enabled": enabled,
        "running": running.is_some(),
        "port": running.map_or_else(|| port_setting(state), |r| r.port),
        "addresses": if running.is_some() { lan_addresses() } else { Vec::new() },
        "fingerprint": running.map(|r| r.fingerprint.clone()),
        "error": entry.and_then(|e| e.error.clone()),
    })
}

// ── TLS identity ──────────────────────────────────────────────────────

pub(crate) struct Identity {
    pub cert_der: Vec<u8>,
    pub key_pkcs8: Vec<u8>,
    /// SHA-256 of `cert_der`, lowercase hex: what the pairing code carries.
    pub fingerprint: String,
}

fn tls_dir() -> PathBuf {
    super::data_layout().data_dir.join(TLS_DIR)
}

fn fingerprint_of(der: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, der)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(crate) fn load_or_create_identity(dir: &Path) -> Result<Identity, String> {
    let cert_path = dir.join(CERT_FILE);
    let key_path = dir.join(KEY_FILE);
    if let (Ok(cert_der), Ok(key_pkcs8)) = (std::fs::read(&cert_path), std::fs::read(&key_path)) {
        // A pair that no longer loads (a truncated write, a key from another
        // build) is replaced rather than served; phones re-pair.
        if acceptor_parts(&cert_der, &key_pkcs8).is_ok() {
            return Ok(Identity {
                fingerprint: fingerprint_of(&cert_der),
                cert_der,
                key_pkcs8,
            });
        }
    }
    let identity = create_identity()?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    set_mode(dir, 0o700);
    write_private(&key_path, &identity.key_pkcs8)?;
    write_private(&cert_path, &identity.cert_der)?;
    Ok(identity)
}

pub(crate) fn create_identity() -> Result<Identity, String> {
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng)
        .map_err(|_| "could not generate a key".to_string())?;
    let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
        .map_err(|_| "could not load the generated key".to_string())?;
    let cert_der = self_signed_cert(&key, &rng)?;
    Ok(Identity {
        fingerprint: fingerprint_of(&cert_der),
        cert_der,
        key_pkcs8: pkcs8.as_ref().to_vec(),
    })
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

// ── A self-signed X.509 v3 certificate, in DER ────────────────────────

fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = content.len();
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes: Vec<u8> = len
            .to_be_bytes()
            .into_iter()
            .skip_while(|b| *b == 0)
            .collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend(bytes);
    }
    out.extend_from_slice(content);
    out
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    der(0x30, &parts.concat())
}

/// A BIT STRING with no unused bits.
fn bit_string(bytes: &[u8]) -> Vec<u8> {
    let mut content = vec![0u8];
    content.extend_from_slice(bytes);
    der(0x03, &content)
}

// 1.2.840.10045.4.3.2 ecdsa-with-SHA256
const OID_ECDSA_SHA256: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
// 1.2.840.10045.2.1 id-ecPublicKey
const OID_EC_PUBLIC_KEY: &[u8] = &[0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
// 1.2.840.10045.3.1.7 prime256v1
const OID_P256: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
// 2.5.4.3 commonName
const OID_COMMON_NAME: &[u8] = &[0x06, 0x03, 0x55, 0x04, 0x03];

/// Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm,
/// signatureValue }, RFC 5280 §4.1, with the fields a pinned self-signed
/// server certificate needs and no extensions. Validity is a fixed window;
/// nothing checks it, since the phone trusts the pin and not the dates.
pub(crate) fn self_signed_cert(key: &EcdsaKeyPair, rng: &SystemRandom) -> Result<Vec<u8>, String> {
    let mut serial = [0u8; 16];
    ring::rand::SecureRandom::fill(rng, &mut serial)
        .map_err(|_| "the system random source failed".to_string())?;
    // A positive INTEGER with no leading zero byte.
    serial[0] = (serial[0] & 0x7f) | 0x40;

    let version = der(0xa0, &der(0x02, &[0x02]));
    let serial = der(0x02, &serial);
    let algorithm = seq(&[OID_ECDSA_SHA256]);
    let name = seq(&[&der(
        0x31,
        &seq(&[OID_COMMON_NAME, &der(0x0c, b"privacytracker companion")]),
    )]);
    let validity = seq(&[&der(0x17, b"260101000000Z"), &der(0x17, b"491231235959Z")]);
    let spki = seq(&[
        &seq(&[OID_EC_PUBLIC_KEY, OID_P256]),
        &bit_string(key.public_key().as_ref()),
    ]);
    let tbs = seq(&[&version, &serial, &algorithm, &name, &validity, &name, &spki]);
    let signature = key
        .sign(rng, &tbs)
        .map_err(|_| "could not sign the certificate".to_string())?;
    Ok(seq(&[&tbs, &algorithm, &bit_string(signature.as_ref())]))
}

// ── rustls ────────────────────────────────────────────────────────────

fn acceptor_parts(
    cert_der: &[u8],
    key_pkcs8: &[u8],
) -> Result<tokio_rustls::rustls::ServerConfig, String> {
    use tokio_rustls::rustls::{
        self,
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    };
    let mut config =
        rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert_der.to_vec())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pkcs8.to_vec())),
            )
            .map_err(|e| e.to_string())?;
    // The server speaks HTTP/1.1 only, as `next start` does.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

pub(crate) fn acceptor(identity: &Identity) -> Result<tokio_rustls::TlsAcceptor, String> {
    let config = acceptor_parts(&identity.cert_der, &identity.key_pkcs8)?;
    Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
}

// ── The addresses a phone can use ─────────────────────────────────────

/// Private IPv4 addresses of the interfaces that are up, in interface
/// order: what the pairing code can point a phone at. Includes Tailscale's
/// 100.64.0.0/10, which is as private as a home LAN.
pub(crate) fn lan_addresses() -> Vec<String> {
    let mut out = Vec::new();
    #[cfg(unix)]
    // SAFETY: getifaddrs fills a linked list that freeifaddrs releases; each
    // node is read only while the list is alive, and ifa_addr is checked
    // for null and for AF_INET before it is read as a sockaddr_in.
    unsafe {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut head) != 0 {
            return out;
        }
        let mut cursor = head;
        while !cursor.is_null() {
            let ifa = &*cursor;
            let up = ifa.ifa_flags & (libc::IFF_UP as u32) != 0;
            let loopback = ifa.ifa_flags & (libc::IFF_LOOPBACK as u32) != 0;
            if up
                && !loopback
                && !ifa.ifa_addr.is_null()
                && i32::from((*ifa.ifa_addr).sa_family) == libc::AF_INET
            {
                let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                let text = ip.to_string();
                if is_private_v4(ip) && !out.contains(&text) {
                    out.push(text);
                }
            }
            cursor = ifa.ifa_next;
        }
        libc::freeifaddrs(head);
    }
    out
}

pub(crate) fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_private() || (a == 100 && (64..=127).contains(&b))
}

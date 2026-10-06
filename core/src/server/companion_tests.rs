//! Companion pairing: the Rust half of tests/app/companion.test.ts, plus
//! what only the core has, the desktop app's Wi-Fi listener over TLS.

use super::*;
use crate::server::{companion_lan, ratelimit, trust};
use axum::body::Body;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tower::ServiceExt;

fn memory_state() -> AppState {
    let conn = crate::db::open_and_migrate(std::path::Path::new(":memory:")).unwrap();
    AppState {
        conn: Arc::new(Mutex::new(conn)),
        rate_limiter: Arc::new(ratelimit::RateLimiter::new()),
        started_at: Instant::now(),
        bound_port: 0,
    }
}

fn insert_token(state: &AppState, label: &str, token: &str, created_at: i64) -> String {
    let conn = state.db();
    let id = format!("pairing-{label}");
    conn.execute(
        "INSERT INTO companion_tokens
           (id, label, token_hash, scope, created_at, claim_expires_at, first_used_at, last_used_at)
         VALUES (?, ?, ?, 'read', ?, ?, NULL, NULL)",
        params![id, label, hash_token(token), created_at, created_at + CLAIM_WINDOW_MS],
    )
    .unwrap();
    id
}

fn token(fill: char) -> String {
    format!("ptc_{}", fill.to_string().repeat(64))
}

// ── Allowlist, shape and labels ───────────────────────────────────────

/// Until someone names it, an instance describes its host: the Mac's name
/// in the desktop app, a plain description anywhere else. The old default,
/// "privacytracker", says nothing a phone could tell instances apart by, so
/// it reads as unnamed whether it was stored or not. Mirrors the Node test.
#[test]
fn an_unnamed_instance_describes_its_host() {
    assert_eq!(default_instance_name_for(false, None), "privacytracker server");
    assert_eq!(default_instance_name_for(false, Some("Adam's MacBook Pro")), "privacytracker server");
    assert_eq!(default_instance_name_for(true, Some("  Adam's   MacBook Pro ")), "Adam's MacBook Pro");
    assert_eq!(default_instance_name_for(true, None), "My Mac");
    assert_eq!(default_instance_name_for(true, Some("   ")), "My Mac");
    assert_eq!(chosen_instance_name(""), None);
    assert_eq!(chosen_instance_name("privacytracker"), None);
    assert_eq!(chosen_instance_name("  Home   server "), Some("Home server".to_string()));

    // Through the database: nothing stored, then a name, then cleared.
    let state = memory_state();
    let conn = state.db();
    assert_eq!(instance_name(&conn), "privacytracker server");
    super::super::settings::set_setting_with(&conn, INSTANCE_NAME_KEY, "privacytracker").unwrap();
    assert_eq!(instance_name(&conn), "privacytracker server");
    super::super::settings::set_setting_with(&conn, INSTANCE_NAME_KEY, "Home server").unwrap();
    assert_eq!(instance_name(&conn), "Home server");
}

#[test]
fn the_allowlist_is_get_only_and_exact() {
    for path in [
        "/api/companion/status",
        "/api/apps",
        "/api/apps/389801252/detail",
        "/api/apps/389801252/changelog",
        "/api/apps/389801252/since-install",
        "/api/apps/389801252/history-stats",
        "/api/changelog",
        "/api/triage",
    ] {
        assert!(is_companion_route(&Method::GET, path), "{path}");
        assert!(!is_companion_route(&Method::HEAD, path), "HEAD {path}");
        assert!(!is_companion_route(&Method::POST, path), "POST {path}");
    }
    for path in [
        "/api/companion",
        "/api/companion/pairings",
        "/api/settings",
        "/api/backup/export",
        "/api/apps/abc/detail",
        "/api/apps/1/detail/extra",
        "/api/apps/",
        "/api/changelog/x",
        "/dashboard",
    ] {
        assert!(!is_companion_route(&Method::GET, path), "{path}");
    }
}

#[test]
fn token_shape_and_hash() {
    let minted = mint_token().unwrap();
    assert!(is_well_formed(&minted));
    assert!(!is_well_formed(&minted.to_uppercase()));
    assert!(!is_well_formed("ptc_abc"));
    // SHA-256("abc"), the FIPS 180-2 vector: the same hex Node's createHash gives.
    assert_eq!(
        hash_token("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn labels_are_cleaned_as_clean_label_cleans_them() {
    assert_eq!(clean_label(Some("  Adam's   Mac  "), "x", 60), "Adam's Mac");
    assert_eq!(clean_label(Some("\u{3000}\t "), "fallback", 60), "fallback");
    assert_eq!(clean_label(None, "fallback", 60), "fallback");
    assert_eq!(clean_label(Some(&"a".repeat(80)), "x", 60), "a".repeat(60));
    // The cap lands on a space, which the second trim removes.
    assert_eq!(clean_label(Some("abc def"), "x", 4), "abc");
}

// ── Verification ──────────────────────────────────────────────────────

#[test]
fn first_use_claims_and_an_unclaimed_token_expires() {
    let state = memory_state();
    let t0 = 1_800_000_000_000;
    let claimed = token('1');
    let unclaimed = token('2');
    insert_token(&state, "claimed", &claimed, t0);
    insert_token(&state, "unclaimed", &unclaimed, t0);
    let conn = state.db();
    assert!(matches!(verify(&conn, &claimed, t0 + 60_000), CompanionVerdict::Allowed(_)));
    let first: i64 = conn
        .query_row(
            "SELECT first_used_at FROM companion_tokens WHERE id = 'pairing-claimed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(first, t0 + 60_000);
    let late = t0 + CLAIM_WINDOW_MS + 1;
    assert!(matches!(verify(&conn, &claimed, late), CompanionVerdict::Allowed(_)));
    assert_eq!(verify(&conn, &unclaimed, late), CompanionVerdict::Invalid);
    assert_eq!(verify(&conn, &token('3'), t0), CompanionVerdict::Invalid);
    assert_eq!(verify(&conn, "not-a-token", t0), CompanionVerdict::Invalid);
}

#[test]
fn last_used_is_written_at_most_once_a_minute() {
    let state = memory_state();
    let t0 = 1_800_000_000_000;
    let t = token('4');
    insert_token(&state, "phone", &t, t0);
    let conn = state.db();
    let read = || -> i64 {
        conn.query_row(
            "SELECT last_used_at FROM companion_tokens WHERE id = 'pairing-phone'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    verify(&conn, &t, t0);
    verify(&conn, &t, t0 + 5_000);
    assert_eq!(read(), t0);
    verify(&conn, &t, t0 + LAST_USED_RESOLUTION_MS);
    assert_eq!(read(), t0 + LAST_USED_RESOLUTION_MS);
}

// ── The gate, through the whole router ────────────────────────────────

fn send(router: &axum::Router, method: &str, uri: &str, headers: &[(&str, &str)]) -> (StatusCode, Value) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "127.0.0.1:3000");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = rt
        .block_on(router.clone().oneshot(builder.body(Body::empty()).unwrap()))
        .unwrap();
    let status = response.status();
    let bytes = rt
        .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// A network-exposed install with an admin token, as Docker runs: the
/// companion token reads the allowlist and nothing else; every other
/// request still needs the admin token.
#[test]
fn a_companion_token_reads_the_allowlist_on_an_install_that_needs_the_admin_token() {
    let _env = trust::env_lock();
    std::env::set_var("PRIVACYTRACKER_BIND_HOST", "127.0.0.1");
    std::env::set_var("PRIVACYTRACKER_NETWORK_EXPOSED", "1");
    std::env::set_var("AUDITOR_ADMIN_TOKEN", "companion-test-admin");
    let state = memory_state();
    let now = super::super::now_ms();
    let t = token('5');
    insert_token(&state, "phone", &t, now);
    {
        let conn = state.db();
        conn.execute(
            "INSERT INTO apps (id, name, url, iconUrl, firstSeen, lastSynced, changeCount)
             VALUES ('389801252', 'Instagram', 'https://apps.apple.com/app/id389801252', '', 0, 0, 0)",
            [],
        )
        .unwrap();
    }
    let router = super::super::app(state);

    let (locked, _) = send(&router, "GET", "/api/apps", &[]);
    let (triage, _) = send(&router, "GET", "/api/triage", &[(HEADER, &t)]);
    let (status, body) = send(&router, "GET", "/api/companion/status", &[(HEADER, &t)]);
    let (settings, settings_body) = send(
        &router,
        "GET",
        "/api/settings",
        &[(HEADER, &t), ("x-auditor-admin-token", "companion-test-admin")],
    );
    let (delete, _) = send(&router, "DELETE", "/api/apps", &[(HEADER, &t)]);
    let (bad, bad_body) = send(&router, "GET", "/api/apps", &[(HEADER, &token('6'))]);
    let (listing, _) = send(&router, "GET", "/api/companion", &[(HEADER, &t)]);
    let (admin_status, admin_body) = send(
        &router,
        "GET",
        "/api/companion/status",
        &[("x-auditor-admin-token", "companion-test-admin")],
    );
    let (foreign_host, _) = {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let request = axum::http::Request::builder()
            .uri("/api/apps")
            .header("host", "evil.example")
            .header(HEADER, &t)
            .body(Body::empty())
            .unwrap();
        (rt.block_on(router.clone().oneshot(request)).unwrap().status(), ())
    };
    std::env::remove_var("PRIVACYTRACKER_BIND_HOST");
    std::env::remove_var("PRIVACYTRACKER_NETWORK_EXPOSED");
    std::env::remove_var("AUDITOR_ADMIN_TOKEN");

    assert_eq!(locked, StatusCode::UNAUTHORIZED, "baseline: locked");
    assert_eq!(triage, StatusCode::OK);
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["instanceName"], "privacytracker server", "an unnamed server says what it is");
    assert_eq!(body["appCount"], 1);
    assert_eq!(body["scope"], "read");
    assert_eq!(body["device"]["label"], "phone");
    let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["instanceName", "appCount", "version", "scope", "device"]);
    assert_eq!(settings, StatusCode::FORBIDDEN, "an admin token does not widen it");
    assert_eq!(settings_body["error"], OUT_OF_SCOPE);
    assert_eq!(delete, StatusCode::FORBIDDEN);
    assert_eq!(bad, StatusCode::UNAUTHORIZED);
    assert_eq!(bad_body["error"], INVALID);
    assert_eq!(listing, StatusCode::FORBIDDEN, "the Settings listing is not on the allowlist");
    assert_eq!(admin_status, StatusCode::UNAUTHORIZED);
    assert_eq!(admin_body["error"], STATUS_ONLY);
    assert_eq!(foreign_host, StatusCode::BAD_REQUEST, "the host allowlist runs first");
}

/// Outside the desktop app the Wi-Fi listener reports exactly what the
/// Node rollback reports, and refuses to switch on the same way.
#[test]
fn the_wifi_listener_is_unsupported_outside_the_desktop_app() {
    let state = memory_state();
    let described = companion_lan::describe(&state);
    assert_eq!(
        described,
        json!({
            "supported": false,
            "enabled": false,
            "running": false,
            "port": null,
            "addresses": [],
            "fingerprint": null,
            "error": null,
        })
    );
    assert!(!companion_lan::supported());
}

/// Inside the desktop app, before the listener is switched on: supported,
/// off, on the default port, with nothing to pin yet. Switching it on for a
/// server that was never attached records the choice and opens nothing.
#[test]
fn inside_the_desktop_app_the_listener_starts_off() {
    let state = memory_state();
    companion_lan::set_test_supported(true);
    let off = companion_lan::describe(&state);
    companion_lan::set_enabled(&state, true);
    let remembered = companion_lan::describe(&state);
    companion_lan::set_test_supported(false);
    assert_eq!(
        off,
        json!({
            "supported": true,
            "enabled": false,
            "running": false,
            "port": companion_lan::DEFAULT_PORT,
            "addresses": [],
            "fingerprint": null,
            "error": null,
        })
    );
    assert_eq!(remembered["enabled"], true);
    assert_eq!(remembered["running"], false);
}

// ── The certificate and the Wi-Fi listener ────────────────────────────

#[test]
fn the_self_signed_certificate_loads_into_rustls() {
    let identity = companion_lan::create_identity().unwrap();
    assert_eq!(identity.fingerprint.len(), 64);
    assert_eq!(identity.cert_der[0], 0x30, "a DER SEQUENCE");
    companion_lan::acceptor(&identity).expect("rustls accepts the certificate and key");
    let again = companion_lan::create_identity().unwrap();
    assert_ne!(identity.fingerprint, again.fingerprint, "each identity is its own");
}

#[test]
fn the_identity_is_kept_on_disk_privately_and_reused() {
    let dir = std::env::temp_dir().join(format!("pt-companion-tls-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let first = companion_lan::load_or_create_identity(&dir).unwrap();
    let second = companion_lan::load_or_create_identity(&dir).unwrap();
    assert_eq!(first.fingerprint, second.fingerprint);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("key.pk8")), 0o600);
        assert_eq!(mode(&dir.join("cert.der")), 0o600);
    }
    // A damaged pair is replaced, not served.
    std::fs::write(dir.join("cert.der"), b"not a certificate").unwrap();
    let third = companion_lan::load_or_create_identity(&dir).unwrap();
    assert_ne!(third.fingerprint, first.fingerprint);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn private_addresses() {
    use std::net::Ipv4Addr;
    for ip in ["192.168.1.20", "10.0.0.2", "172.20.1.1", "100.100.1.1"] {
        assert!(companion_lan::is_private_v4(ip.parse::<Ipv4Addr>().unwrap()), "{ip}");
    }
    for ip in ["8.8.8.8", "172.32.0.1", "100.128.0.1"] {
        assert!(!companion_lan::is_private_v4(ip.parse::<Ipv4Addr>().unwrap()), "{ip}");
    }
}

/// LAN addresses stay private, usable and deduplicated in interface order.
#[cfg(unix)]
#[test]
fn lan_addresses_filter_interfaces_and_preserve_order() {
    use nix::{ifaddrs::InterfaceAddress, net::if_::InterfaceFlags, sys::socket::SockaddrStorage};

    let interface = |ip: Option<&str>, flags| InterfaceAddress {
        interface_name: "fixture".into(),
        flags,
        address: ip.map(|ip| SockaddrStorage::from(ip.parse::<std::net::SocketAddr>().unwrap())),
        netmask: None,
        broadcast: None,
        destination: None,
    };
    let up = InterfaceFlags::IFF_UP;
    let addresses = companion_lan::private_interface_addresses([
        interface(Some("192.168.1.20:0"), up),
        interface(Some("10.0.0.2:0"), InterfaceFlags::empty()),
        interface(Some("127.0.0.1:0"), up | InterfaceFlags::IFF_LOOPBACK),
        interface(Some("8.8.8.8:0"), up),
        interface(Some("[::1]:0"), up),
        interface(None, up),
        interface(Some("100.100.1.1:0"), up),
        interface(Some("192.168.1.20:0"), up),
        interface(Some("10.0.0.2:0"), up),
    ]);
    assert_eq!(addresses, ["192.168.1.20", "100.100.1.1", "10.0.0.2"]);

    let actual = companion_lan::lan_addresses();
    assert!(actual.iter().all(|ip| companion_lan::is_private_v4(ip.parse().unwrap())));
    let mut unique = actual.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), actual.len());
}

/// Accepts exactly one certificate, by SHA-256: what the iPhone app does.
#[derive(Debug)]
struct Pinned {
    fingerprint: String,
    provider: Arc<tokio_rustls::rustls::crypto::CryptoProvider>,
}

impl tokio_rustls::rustls::client::danger::ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[tokio_rustls::rustls::pki_types::CertificateDer<'_>],
        _server_name: &tokio_rustls::rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: tokio_rustls::rustls::pki_types::UnixTime,
    ) -> Result<tokio_rustls::rustls::client::danger::ServerCertVerified, tokio_rustls::rustls::Error>
    {
        if hex(ring::digest::digest(&ring::digest::SHA256, end_entity.as_ref()).as_ref())
            == self.fingerprint
        {
            Ok(tokio_rustls::rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(tokio_rustls::rustls::Error::General("pin mismatch".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        dss: &tokio_rustls::rustls::DigitallySignedStruct,
    ) -> Result<tokio_rustls::rustls::client::danger::HandshakeSignatureValid, tokio_rustls::rustls::Error>
    {
        tokio_rustls::rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        dss: &tokio_rustls::rustls::DigitallySignedStruct,
    ) -> Result<tokio_rustls::rustls::client::danger::HandshakeSignatureValid, tokio_rustls::rustls::Error>
    {
        tokio_rustls::rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<tokio_rustls::rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// One HTTP/1.1 request over a TLS connection pinned to `fingerprint`.
async fn pinned_get(
    port: u16,
    fingerprint: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> Result<(u16, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_rustls::rustls;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned {
            fingerprint: fingerprint.to_string(),
            provider,
        }))
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|e| e.to_string())?;
    let name = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
    let mut tls = connector.connect(name, tcp).await.map_err(|e| e.to_string())?;
    let mut request = format!("GET {path} HTTP/1.1\r\nhost: 192.168.1.20:{port}\r\nconnection: close\r\n");
    for (k, v) in headers {
        request.push_str(&format!("{k}: {v}\r\n"));
    }
    request.push_str("\r\n");
    tls.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    let _ = tls.read_to_end(&mut raw).await;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("no status line in {text:?}"))?;
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Ok((status, body))
}

/// The whole path a phone takes: TLS pinned to the certificate, a LAN
/// `Host` the main listener would refuse, the companion token, the
/// allowlist and nothing else.
#[test]
fn the_wifi_listener_serves_the_allowlist_over_pinned_tls() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let state = memory_state();
        let now = super::super::now_ms();
        let t = token('7');
        insert_token(&state, "phone", &t, now);

        let identity = companion_lan::create_identity().unwrap();
        let acceptor = companion_lan::acceptor(&identity).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = tokio_util::sync::CancellationToken::new();
        let lan_state = AppState {
            bound_port: port,
            ..state.clone()
        };
        let served = tokio::spawn(super::super::lifecycle::accept_tls_loop(
            listener,
            super::super::lan_router(lan_state),
            stop.clone(),
            std::time::Duration::from_secs(5),
            acceptor,
        ));

        let fp = identity.fingerprint.as_str();
        let (status, body) = pinned_get(port, fp, "/api/companion/status", &[(HEADER, &t)])
            .await
            .unwrap();
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("\"appCount\":0"), "{body}");

        let (no_token, _) = pinned_get(port, fp, "/api/apps", &[]).await.unwrap();
        assert_eq!(no_token, 401);
        let (off_list, _) = pinned_get(port, fp, "/api/settings", &[(HEADER, &t)]).await.unwrap();
        assert_eq!(off_list, 403);
        let (page, _) = pinned_get(port, fp, "/dashboard", &[(HEADER, &t)]).await.unwrap();
        assert_eq!(page, 403, "no pages on the Wi-Fi listener");
        let (bad, _) = pinned_get(port, fp, "/api/apps", &[(HEADER, &token('8'))]).await.unwrap();
        assert_eq!(bad, 401);

        let wrong_pin = pinned_get(port, &"0".repeat(64), "/api/apps", &[(HEADER, &t)]).await;
        assert!(wrong_pin.is_err(), "a different certificate is refused by the client");

        stop.cancel();
        served.await.unwrap().unwrap();
    });
}

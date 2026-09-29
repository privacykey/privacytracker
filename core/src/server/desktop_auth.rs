//! The desktop app's launch credential.
//!
//! The desktop app serves this server from its own process on a loopback
//! port, with no admin token. The loopback bind keeps the network out, but
//! not the rest of the machine: any process under any account could read
//! the library over HTTP, and a mutation needs only an `Origin` that
//! matches its `Host`, which a non-browser client writes itself. So the
//! shell mints a fresh random credential on every launch and hands it over
//! in the host environment (`PRIVACYTRACKER_DESKTOP_TOKEN`). While it is
//! set, every `/api/*` request must present it, as the
//! `X-PrivacyTracker-Desktop-Token` header or as the `pt_desktop_session`
//! cookie; the page shells stay public, because they are the same static
//! files for everyone and hold no data.
//!
//! **Why not the admin token.** `AUDITOR_ADMIN_TOKEN` is the operator's
//! posture for a server on a network, and the frontend reads it as such:
//! pages redirect to `/login`, Settings shows the unlock card and "Session
//! locked", the deployment diagnostics report it, and the dev routes, which
//! refuse to run on an install with no token configured, would start
//! running. A desktop user has nothing to type in, and every one of those
//! would change what they see. This mode touches none of them: the admin
//! token stays unconfigured, `/api/auth/admin-token/status` still answers
//! `configured: false`, and the only difference is who may ask.
//!
//! **How the window gets it without page scripts seeing it.** The shell
//! does not navigate straight to the start page. It asks this module for a
//! one-time link ([`issue_bootstrap_nonce`], [`bootstrap_path`]) and opens
//! that; the link answers with an `HttpOnly; SameSite=Strict` cookie and a
//! redirect to `/`, so the credential never appears in a URL, in the
//! page's `document.cookie` or in its history. A link works once, and only
//! for [`BOOTSTRAP_TTL`] after it was issued.
//!
//! **Same-user tools.** The shell also writes the credential to
//! `.desktop-token` in the data directory (0600, inside the 0700
//! directory) and removes it on a clean exit, so a tool running as the
//! same user (the MCP companion) can read it and send the header.
//!
//! **Scope.** Web and Docker never set the variable, so nothing changes
//! there, and the parity harnesses never see this mode: it has no route in
//! the router (the gate answers the link itself) and no `app/api` file,
//! so the manifest has nothing to classify. The Node server has no
//! counterpart: the desktop rollback build, which spawns it as a sidecar,
//! runs without this protection.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::http::{header, HeaderMap, Method};

/// The host-environment variable the shell passes the credential in.
pub const CREDENTIAL_ENV: &str = "PRIVACYTRACKER_DESKTOP_TOKEN";
/// The header a same-user tool (or the shell itself) sends it in.
pub const CREDENTIAL_HEADER: &str = "x-privacytracker-desktop-token";
/// The cookie the webview carries it in, set by the one-time link.
pub const SESSION_COOKIE: &str = "pt_desktop_session";
/// The one-time link. Answered by the gate, never routed.
pub const BOOTSTRAP_PATH: &str = "/api/desktop/bootstrap";
/// How long a one-time link stays usable after it was issued. The shell
/// opens it straight away; the margin is for a slow start at login.
pub const BOOTSTRAP_TTL: Duration = Duration::from_secs(60);

/// 32 bytes from the OS CSPRNG, as 64 hex characters.
const SECRET_BYTES: usize = 32;
/// Links issued and not yet used. The shell asks for one per launch; the
/// cap only bounds a caller that asks in a loop.
const MAX_PENDING: usize = 16;

/// A fresh launch credential: 32 bytes from the operating system's CSPRNG,
/// hex-encoded so it is safe in a header, a cookie and a file.
pub fn mint_credential() -> Result<String, String> {
    random_hex()
}

fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; SECRET_BYTES];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
        .map_err(|_| "the system random source failed".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
thread_local! {
    /// A credential for this thread's gate, so the gate's own tests can run
    /// in desktop mode without setting a process-wide variable other tests
    /// would see. The gate tests drive the router on a current-thread
    /// runtime, so the gate runs on the thread that set it.
    static TEST_CREDENTIAL: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_credential(credential: Option<&str>) {
    TEST_CREDENTIAL.with(|cell| *cell.borrow_mut() = credential.map(str::to_string));
}

/// The launch credential, when this server was given one. An empty value
/// counts as none, as an empty admin token does.
pub(crate) fn configured() -> Option<String> {
    #[cfg(test)]
    if let Some(credential) = TEST_CREDENTIAL.with(|cell| cell.borrow().clone()) {
        return Some(credential);
    }
    crate::host_env::var(CREDENTIAL_ENV)
        .ok()
        .filter(|v| !v.is_empty())
}

/// Whether `provided` is `expected`, in time that depends on neither.
///
/// Both sides are hashed first, so the comparison always runs over two
/// 32-byte digests: a guess of the wrong length takes as long as one of
/// the right length, and the fold never stops at the first difference.
fn same_secret(provided: &[u8], expected: &[u8]) -> bool {
    if provided.is_empty() || expected.is_empty() {
        return false;
    }
    let a = ring::digest::digest(&ring::digest::SHA256, provided);
    let b = ring::digest::digest(&ring::digest::SHA256, expected);
    let diff = a
        .as_ref()
        .iter()
        .zip(b.as_ref())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// The credential in the header. The one form that also stands in for a
/// matching `Origin` on a mutation, as the admin-token header does: a
/// browser cannot attach it to a cross-site request.
pub(crate) fn header_presented(headers: &HeaderMap, credential: &str) -> bool {
    headers
        .get_all(CREDENTIAL_HEADER)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| same_secret(v.trim().as_bytes(), credential.as_bytes()))
}

/// The credential in the session cookie. Every cookie of that name is
/// tried, not just the first: a stale one from an earlier launch must not
/// shadow the current one.
fn cookie_presented(headers: &HeaderMap, credential: &str) -> bool {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|pair| pair.split_once('='))
        .filter(|(name, _)| name.trim() == SESSION_COOKIE)
        .any(|(_, value)| same_secret(value.trim().as_bytes(), credential.as_bytes()))
}

/// The credential in either form.
pub(crate) fn presented(headers: &HeaderMap, credential: &str) -> bool {
    header_presented(headers, credential) || cookie_presented(headers, credential)
}

/// The `Set-Cookie` the one-time link answers with: session-only (gone
/// when the app quits, like the credential itself), unreadable by page
/// scripts, never sent on a cross-site request, and scoped to the API,
/// which is all it is for.
pub(crate) fn session_cookie(credential: &str) -> String {
    format!("{SESSION_COOKIE}={credential}; Path=/api; HttpOnly; SameSite=Strict")
}

/// The one-time links issued and not yet used or expired.
#[derive(Default)]
pub(crate) struct Nonces {
    pending: Vec<(String, Instant)>,
}

impl Nonces {
    pub(crate) const fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    fn prune(&mut self, now: Instant) {
        self.pending
            .retain(|(_, issued)| now.saturating_duration_since(*issued) < BOOTSTRAP_TTL);
    }

    pub(crate) fn issue(&mut self, nonce: String, now: Instant) {
        self.prune(now);
        if self.pending.len() >= MAX_PENDING {
            self.pending.remove(0);
        }
        self.pending.push((nonce, now));
    }

    /// Use `candidate` up: true once for a link issued less than
    /// [`BOOTSTRAP_TTL`] ago, false for anything else, including the same
    /// link a second time. Every pending link is compared, so where a
    /// match sits in the list is not timed.
    pub(crate) fn redeem(&mut self, candidate: &str, now: Instant) -> bool {
        self.prune(now);
        let mut found = None;
        for (index, (nonce, _)) in self.pending.iter().enumerate() {
            if same_secret(candidate.as_bytes(), nonce.as_bytes()) {
                found = Some(index);
            }
        }
        match found {
            Some(index) => {
                self.pending.remove(index);
                true
            }
            None => false,
        }
    }
}

/// The process's links. One server per process, like the environment.
static NONCES: Mutex<Nonces> = Mutex::new(Nonces::new());

pub(crate) fn nonces() -> &'static Mutex<Nonces> {
    &NONCES
}

/// Issue a one-time link for the window. The shell calls this in process
/// when it navigates the webview; nothing on the HTTP surface issues one.
pub fn issue_bootstrap_nonce() -> Result<String, String> {
    let nonce = random_hex()?;
    NONCES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .issue(nonce.clone(), Instant::now());
    Ok(nonce)
}

/// The path of the one-time link for `nonce`, to put after the base URL.
pub fn bootstrap_path(nonce: &str) -> String {
    format!("{BOOTSTRAP_PATH}?nonce={nonce}")
}

/// What the gate does with a request while a launch credential is set.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    /// Not the API, or the API with the credential: carry on through the
    /// rest of the gate.
    Pass,
    /// The API without the credential: 401.
    Refused,
    /// The one-time link, used: a redirect to the start page, with the
    /// session cookie when the link itself was good (a window that already
    /// holds the cookie is sent on without a new one).
    SignedIn { set_cookie: Option<String> },
    /// The one-time link, expired or already used, from a client holding
    /// no credential: 403.
    LinkRefused,
}

fn query_param<'a>(query: Option<&'a str>, name: &str) -> Option<&'a str> {
    query?
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

/// `/api` and everything under it: what the router serves from handlers
/// rather than from the build.
fn is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// The desktop step of the gate, for a server whose launch credential is
/// `credential`.
pub(crate) fn decide(
    method: &Method,
    path: &str,
    query: Option<&str>,
    headers: &HeaderMap,
    credential: &str,
    nonces: &Mutex<Nonces>,
    now: Instant,
) -> Decision {
    if path == BOOTSTRAP_PATH && method == Method::GET {
        let redeemed = query_param(query, "nonce").is_some_and(|nonce| {
            nonces
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .redeem(nonce, now)
        });
        return if redeemed {
            Decision::SignedIn {
                set_cookie: Some(session_cookie(credential)),
            }
        } else if presented(headers, credential) {
            Decision::SignedIn { set_cookie: None }
        } else {
            Decision::LinkRefused
        };
    }
    if is_api(path) && !presented(headers, credential) {
        return Decision::Refused;
    }
    Decision::Pass
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const CREDENTIAL: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                axum::http::HeaderName::from_bytes(name.as_bytes()).expect("name"),
                HeaderValue::from_str(value).expect("value"),
            );
        }
        map
    }

    fn decide_now(method: Method, path: &str, query: Option<&str>, h: &HeaderMap) -> Decision {
        let nonces = Mutex::new(Nonces::new());
        decide(&method, path, query, h, CREDENTIAL, &nonces, Instant::now())
    }

    #[test]
    fn a_minted_credential_is_32_random_bytes_in_hex() {
        let a = mint_credential().expect("random");
        let b = mint_credential().expect("random");
        assert_eq!(a.len(), 64);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b, "every launch gets its own");
    }

    #[test]
    fn the_api_needs_the_credential_and_the_pages_do_not() {
        let none = HeaderMap::new();
        for path in [
            "/api/apps",
            "/api/health",
            "/api/ready",
            "/api",
            "/api/backup/export",
        ] {
            assert_eq!(
                decide_now(Method::GET, path, None, &none),
                Decision::Refused,
                "{path}"
            );
        }
        for method in [Method::POST, Method::DELETE, Method::HEAD, Method::OPTIONS] {
            assert_eq!(
                decide_now(method.clone(), "/api/reset", None, &none),
                Decision::Refused,
                "{method}"
            );
        }
        // The page shells are the same static files for everyone.
        for path in [
            "/",
            "/dashboard",
            "/apps/view",
            "/login",
            "/apix",
            "/_next/data/x.json",
        ] {
            assert_eq!(
                decide_now(Method::GET, path, None, &none),
                Decision::Pass,
                "{path}"
            );
        }
    }

    #[test]
    fn the_header_and_the_cookie_both_carry_it() {
        let header = headers(&[(CREDENTIAL_HEADER, CREDENTIAL)]);
        assert_eq!(
            decide_now(Method::GET, "/api/apps", None, &header),
            Decision::Pass
        );
        assert!(header_presented(&header, CREDENTIAL));

        let cookie = headers(&[(
            "cookie",
            &format!("a=1; {SESSION_COOKIE}={CREDENTIAL}; b=2"),
        )]);
        assert_eq!(
            decide_now(Method::GET, "/api/apps", None, &cookie),
            Decision::Pass
        );
        assert!(
            !header_presented(&cookie, CREDENTIAL),
            "a cookie is not the header: it never stands in for the Origin"
        );
    }

    #[test]
    fn a_wrong_credential_is_refused_in_either_form() {
        let wrong = "f".repeat(64);
        for h in [
            headers(&[(CREDENTIAL_HEADER, &wrong)]),
            headers(&[(CREDENTIAL_HEADER, &CREDENTIAL[..63])]),
            headers(&[(CREDENTIAL_HEADER, &format!("{CREDENTIAL}0"))]),
            headers(&[(CREDENTIAL_HEADER, "")]),
            headers(&[("cookie", &format!("{SESSION_COOKIE}={wrong}"))]),
            headers(&[("cookie", &format!("{SESSION_COOKIE}="))]),
            headers(&[("cookie", &format!("other={CREDENTIAL}"))]),
            // The admin token's header and cookie are not this credential.
            headers(&[("x-auditor-admin-token", CREDENTIAL)]),
            headers(&[("cookie", &format!("pt_admin_token={CREDENTIAL}"))]),
        ] {
            assert_eq!(
                decide_now(Method::GET, "/api/apps", None, &h),
                Decision::Refused,
                "{h:?}"
            );
        }
    }

    #[test]
    fn a_stale_cookie_does_not_shadow_the_current_one() {
        let stale = "e".repeat(64);
        let both = headers(&[(
            "cookie",
            &format!("{SESSION_COOKIE}={stale}; {SESSION_COOKIE}={CREDENTIAL}"),
        )]);
        assert_eq!(
            decide_now(Method::GET, "/api/apps", None, &both),
            Decision::Pass
        );
    }

    #[test]
    fn a_link_signs_the_window_in_once() {
        let nonces = Mutex::new(Nonces::new());
        let now = Instant::now();
        nonces.lock().unwrap().issue("abc123".into(), now);
        let none = HeaderMap::new();
        let open = |query: &str| {
            decide(
                &Method::GET,
                BOOTSTRAP_PATH,
                Some(query),
                &none,
                CREDENTIAL,
                &nonces,
                now,
            )
        };

        assert_eq!(open("nonce=wrong"), Decision::LinkRefused);
        match open("nonce=abc123") {
            Decision::SignedIn {
                set_cookie: Some(cookie),
            } => {
                assert!(cookie.starts_with(&format!("{SESSION_COOKIE}={CREDENTIAL};")));
                for attribute in ["HttpOnly", "SameSite=Strict", "Path=/api"] {
                    assert!(cookie.contains(attribute), "{cookie} lacks {attribute}");
                }
                assert!(
                    !cookie.contains("Max-Age") && !cookie.contains("Expires"),
                    "a session cookie: it goes when the app quits"
                );
            }
            other => panic!("expected a signed-in redirect, got {other:?}"),
        }
        assert_eq!(open("nonce=abc123"), Decision::LinkRefused, "single use");
        assert_eq!(
            decide(
                &Method::GET,
                BOOTSTRAP_PATH,
                None,
                &none,
                CREDENTIAL,
                &nonces,
                now
            ),
            Decision::LinkRefused,
            "no nonce at all"
        );
    }

    #[test]
    fn a_window_that_already_holds_the_cookie_is_sent_on_without_a_new_one() {
        let nonces = Mutex::new(Nonces::new());
        let cookie = headers(&[("cookie", &format!("{SESSION_COOKIE}={CREDENTIAL}"))]);
        assert_eq!(
            decide(
                &Method::GET,
                BOOTSTRAP_PATH,
                Some("nonce=used"),
                &cookie,
                CREDENTIAL,
                &nonces,
                Instant::now()
            ),
            Decision::SignedIn { set_cookie: None }
        );
    }

    #[test]
    fn a_link_expires() {
        let mut nonces = Nonces::new();
        let issued = Instant::now();
        nonces.issue("late".into(), issued);
        nonces.issue("prompt".into(), issued);
        assert!(!nonces.redeem("late", issued + BOOTSTRAP_TTL));
        assert!(
            !nonces.redeem("prompt", issued + BOOTSTRAP_TTL + Duration::from_secs(1)),
            "past the TTL, however it is asked"
        );

        nonces.issue("fresh".into(), issued);
        assert!(nonces.redeem("fresh", issued + BOOTSTRAP_TTL - Duration::from_millis(1)));
    }

    #[test]
    fn only_a_get_is_the_link() {
        let nonces = Mutex::new(Nonces::new());
        let now = Instant::now();
        nonces.lock().unwrap().issue("n".into(), now);
        let none = HeaderMap::new();
        assert_eq!(
            decide(
                &Method::POST,
                BOOTSTRAP_PATH,
                Some("nonce=n"),
                &none,
                CREDENTIAL,
                &nonces,
                now
            ),
            Decision::Refused
        );
        assert!(
            nonces.lock().unwrap().redeem("n", now),
            "the POST did not use the link up"
        );
    }

    #[test]
    fn pending_links_are_bounded() {
        let mut nonces = Nonces::new();
        let now = Instant::now();
        for i in 0..(MAX_PENDING + 4) {
            nonces.issue(format!("n{i}"), now);
        }
        assert_eq!(nonces.pending.len(), MAX_PENDING);
        assert!(!nonces.redeem("n0", now), "the oldest went first");
        assert!(nonces.redeem(&format!("n{}", MAX_PENDING + 3), now));
    }

    #[test]
    fn issued_links_are_distinct_and_redeemable_once() {
        let a = issue_bootstrap_nonce().expect("random");
        let b = issue_bootstrap_nonce().expect("random");
        assert_ne!(a, b);
        assert_eq!(bootstrap_path(&a), format!("{BOOTSTRAP_PATH}?nonce={a}"));
        let now = Instant::now();
        assert!(nonces().lock().unwrap().redeem(&a, now));
        assert!(!nonces().lock().unwrap().redeem(&a, now));
        assert!(nonces().lock().unwrap().redeem(&b, now));
    }

    #[test]
    fn comparison_rejects_empty_and_mismatched_lengths() {
        assert!(same_secret(b"abc", b"abc"));
        assert!(!same_secret(b"", b""));
        assert!(!same_secret(b"abc", b""));
        assert!(!same_secret(b"ab", b"abc"));
        assert!(!same_secret(b"abd", b"abc"));
    }
}

//! Port of `lib/admin-auth.cjs` — admin-token recognition.
//!
//! Two details a "tidier" Rust version gets wrong:
//!
//!   1. The length check happens BEFORE the constant-time compare. Node does
//!      `provided.length === secret.length && timingSafeEqual(...)` because
//!      `timingSafeEqual` THROWS on unequal lengths. A differing-length token
//!      is therefore a plain `false`, never an error.
//!   2. The cookie fallback only runs when the header is absent or wrong, it
//!      splits each cookie at the FIRST `=`, trims the name, and percent-
//!      decodes the value inside a try/catch that skips a malformed escape.
//!      A strict cookie parser accepts or rejects a different set of
//!      malformed inputs than this does.
//!
//! Every `pt_admin_token` cookie is tried, not only the first: a browser
//! sends every cookie whose host and path match, so one planted by another
//! service on the same host (another port, or a parent domain) could
//! otherwise shadow the real one and lock the operator out. And what the
//! login route stores in the cookie is not the token but this boot's
//! session value, an HMAC of the token under a secret minted at start
//! ([`admin_session_cookie_value`]); a cookie value is accepted when it is
//! that, or the token itself.

use ring::hmac;
use std::sync::Mutex;

pub const ADMIN_TOKEN_COOKIE: &str = "pt_admin_token";

/// The secret this boot derives session cookies from, minted on first use.
static SESSION_SECRET: Mutex<Option<[u8; 32]>> = Mutex::new(None);

fn session_secret() -> [u8; 32] {
    let mut guard = SESSION_SECRET
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(secret) = *guard {
        return secret;
    }
    let mut minted = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut minted)
        .expect("the OS CSPRNG is available");
    *guard = Some(minted);
    minted
}

/// Pin the boot secret, so a replay reproduces the oracle's Set-Cookie.
#[cfg(test)]
pub(crate) fn set_session_secret_for_tests(secret: [u8; 32]) {
    *SESSION_SECRET
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(secret);
}

/// `adminSessionCookieValue`: HMAC-SHA256 of the configured token under the
/// boot secret, as hex; `None` while no token is configured.
pub fn admin_session_cookie_value() -> Option<String> {
    let token = crate::host_env::var("AUDITOR_ADMIN_TOKEN").ok()?;
    if token.is_empty() {
        return None;
    }
    let key = hmac::Key::new(hmac::HMAC_SHA256, &session_secret());
    Some(
        hmac::sign(&key, token.as_bytes())
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

/// `matchesCookie`: the session value, or the token itself.
fn matches_cookie(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let session = admin_session_cookie_value();
    session.is_some_and(|s| constant_time_eq(value.as_bytes(), s.as_bytes()))
        || matches_token(Some(value))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `adminTokenConfigured()` — truthiness of the env var, so an empty string
/// counts as unconfigured exactly as `!!process.env.X` does.
pub fn admin_token_configured() -> bool {
    matches!(crate::host_env::var("AUDITOR_ADMIN_TOKEN"), Ok(v) if !v.is_empty())
}

/// Constant-time comparison, guarded by a length pre-check.
fn matches_token(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    let Ok(expected) = crate::host_env::var("AUDITOR_ADMIN_TOKEN") else {
        return false;
    };
    if value.is_empty() || expected.is_empty() {
        return false;
    }
    let provided = value.as_bytes();
    let secret = expected.as_bytes();
    if provided.len() != secret.len() {
        return false;
    }
    // Constant-time over equal-length slices.
    let mut diff: u8 = 0;
    for (a, b) in provided.iter().zip(secret.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Minimal percent-decoder matching `decodeURIComponent`'s failure mode:
/// `None` on a malformed escape (which the Node code catches into `false`).
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `requestHasValidAdminToken` — header first, then every `pt_admin_token`
/// cookie; one that fails to decode is skipped.
pub fn request_has_valid_admin_token(header: Option<&str>, cookie_header: Option<&str>) -> bool {
    if matches_token(header) {
        return true;
    }
    for part in cookie_header.unwrap_or("").split(';') {
        let Some(sep) = part.find('=') else { continue };
        if part[..sep].trim() != ADMIN_TOKEN_COOKIE {
            continue;
        }
        let Some(decoded) = percent_decode(part[sep + 1..].trim()) else {
            continue;
        };
        if matches_cookie(&decoded) {
            return true;
        }
    }
    false
}

// ── The global login brute-force backstop ────────────────────────────

/// `LOGIN_GLOBAL_FAILURE_LIMIT` failed attempts inside
/// `LOGIN_GLOBAL_WINDOW_MS` trip a cooldown that no source address can
/// dodge; only failures count, and it heals itself as the window slides.
const LOGIN_GLOBAL_FAILURE_LIMIT: usize = 100;
const LOGIN_GLOBAL_WINDOW_MS: i64 = 15 * 60_000;

fn login_failures() -> &'static std::sync::Mutex<Vec<i64>> {
    static FAILURES: std::sync::OnceLock<std::sync::Mutex<Vec<i64>>> = std::sync::OnceLock::new();
    FAILURES.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// `loginBruteForceTripped`: the cooldown left, when tripped.
pub fn login_brute_force_tripped(now: i64) -> Option<i64> {
    let mut failures = login_failures().lock().ok()?;
    let cutoff = now - LOGIN_GLOBAL_WINDOW_MS;
    while failures.first().is_some_and(|&t| t < cutoff) {
        failures.remove(0);
    }
    if failures.len() >= LOGIN_GLOBAL_FAILURE_LIMIT {
        return Some((failures[0] + LOGIN_GLOBAL_WINDOW_MS - now).max(0));
    }
    None
}

/// `recordLoginFailure`.
pub fn record_login_failure(now: i64) {
    if let Ok(mut failures) = login_failures().lock() {
        failures.push(now);
    }
}

/// `_resetLoginBruteForce` — the test hook.
#[cfg(test)]
pub fn reset_login_failures() {
    if let Ok(mut failures) = login_failures().lock() {
        failures.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    // These mutate process env, so they run as one test to avoid races
    // between parallel test threads.
    #[test]
    fn token_recognition_matches_node() {
        env::set_var("AUDITOR_ADMIN_TOKEN", "s3cret");

        assert!(request_has_valid_admin_token(Some("s3cret"), None));
        assert!(!request_has_valid_admin_token(Some("wrong"), None));
        // Unequal length must be a plain false, never a panic.
        assert!(!request_has_valid_admin_token(Some("s3cre"), None));
        assert!(!request_has_valid_admin_token(Some("s3cretlonger"), None));
        assert!(!request_has_valid_admin_token(None, None));

        // Cookie fallback, including percent-decoding.
        assert!(request_has_valid_admin_token(
            None,
            Some("pt_admin_token=s3cret")
        ));
        assert!(request_has_valid_admin_token(
            None,
            Some("a=1; pt_admin_token=s3cret; b=2")
        ));
        assert!(request_has_valid_admin_token(
            None,
            Some(" pt_admin_token = s3cret ")
        ));
        assert!(!request_has_valid_admin_token(
            None,
            Some("pt_admin_token=nope")
        ));
        // Malformed escape → false, not an error.
        assert!(!request_has_valid_admin_token(
            None,
            Some("pt_admin_token=%zz")
        ));
        // A non-matching cookie name is skipped entirely.
        assert!(!request_has_valid_admin_token(None, Some("other=s3cret")));
        // Every pt_admin_token cookie is tried: a planted first one, nameless
        // or undecodable, no longer shadows the real one.
        for planted in [
            "pt_admin_token=junk; pt_admin_token=s3cret",
            "=junk; pt_admin_token=s3cret",
            "pt_admin_token=%zz; pt_admin_token=s3cret",
            "pt_admin_token=; pt_admin_token=s3cret",
        ] {
            assert!(request_has_valid_admin_token(None, Some(planted)), "{planted}");
        }
        assert!(!request_has_valid_admin_token(
            None,
            Some("pt_admin_token=junk; pt_admin_token=nope")
        ));

        // The session value the login cookie carries: an HMAC of the token
        // under the boot secret, accepted as a cookie, never as the header,
        // and dead once the secret changes.
        set_session_secret_for_tests([1u8; 32]);
        let session = admin_session_cookie_value().unwrap();
        assert_eq!(session.len(), 64);
        assert_ne!(session, "s3cret");
        assert!(request_has_valid_admin_token(
            None,
            Some(&format!("pt_admin_token={session}"))
        ));
        assert!(!request_has_valid_admin_token(Some(&session), None));
        set_session_secret_for_tests([2u8; 32]);
        assert_ne!(admin_session_cookie_value().unwrap(), session);
        assert!(!request_has_valid_admin_token(
            None,
            Some(&format!("pt_admin_token={session}"))
        ));
        // The same bytes give the same value, as the oracle replay relies on.
        set_session_secret_for_tests([1u8; 32]);
        assert_eq!(admin_session_cookie_value().unwrap(), session);

        assert!(admin_token_configured());
        env::remove_var("AUDITOR_ADMIN_TOKEN");
        assert!(!admin_token_configured());
        assert!(!request_has_valid_admin_token(Some("s3cret"), None));
    }
}

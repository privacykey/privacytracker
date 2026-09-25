//! Port of `lib/admin-token-guard.ts`: how many wrong admin tokens one
//! client may present before the server stops checking what it sends.
//!
//! The gate's check in front of every private page and API call, the login
//! form and the public status endpoint's `unlocked` each say whether a
//! presented token is right, so each counts failures here, by CLIENT:
//!
//! - The client is the socket peer, which `forwarded::inject` stamps on
//!   every request as `x-privacytracker-peer` after removing any copy the
//!   client sent (Node's request preloader does the same). Behind
//!   `PRIVACYTRACKER_TRUST_PROXY` it is the last forwarded hop instead, as
//!   the rate limiter reads it. With neither there is no client, and
//!   nothing here applies.
//! - Only failed checks count, each distinct wrong value once per window,
//!   so a cookie left over from before the token was rotated costs one
//!   failure however many requests carry it.
//! - Past `PER_CLIENT_FAILURE_LIMIT` distinct failures in the window, a
//!   token-bearing request from that client is refused with a 429 before
//!   its token is looked at. A request with no token gets its ordinary 401.
//! - Past `GLOBAL_FAILURE_LIMIT` distinct failures from all clients, only a
//!   client whose token checked out in the last `KNOWN_GOOD_MS` still
//!   reaches the check, so a signed-in operator is never locked out by
//!   someone else's guessing.
//!
//! Nothing is counted while no admin token is configured. The state is
//! process memory, forgotten on restart, and independent of Node's by
//! construction; the rules are the contract, pinned by the tests below and
//! by `lib/admin-token-guard.ts`'s own.
use super::auth::{admin_token_configured, request_has_valid_admin_token, ADMIN_TOKEN_COOKIE};
use super::ratelimit::trusted_client_ip;
use axum::http::{header, HeaderMap};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// The header `forwarded::inject` writes with the socket peer.
pub(crate) const PEER_HEADER: &str = "x-privacytracker-peer";

pub(crate) const PER_CLIENT_FAILURE_LIMIT: usize = 10;
pub(crate) const GLOBAL_FAILURE_LIMIT: usize = 100;
pub(crate) const FAILURE_WINDOW_MS: i64 = 15 * 60_000;
pub(crate) const KNOWN_GOOD_MS: i64 = 24 * 60 * 60_000;
const KNOWN_GOOD_MAX: usize = 1000;
const GC_THRESHOLD: usize = 5000;

/// `TOO_MANY_FAILURES`.
pub(crate) const TOO_MANY_FAILURES: &str = "Too many failed admin-token attempts. Try again later.";

#[derive(Default)]
struct GuardState {
    /// client → (hash of a wrong value → when it was first seen).
    clients: HashMap<String, HashMap<String, i64>>,
    /// `client value-hash` → when it was first seen.
    global: HashMap<String, i64>,
    /// client → last successful check.
    known_good: HashMap<String, i64>,
}

fn state() -> std::sync::MutexGuard<'static, GuardState> {
    static STATE: OnceLock<Mutex<GuardState>> = OnceLock::new();
    super::lifecycle::lock_state(STATE.get_or_init(|| Mutex::new(GuardState::default())))
}

/// `_resetAdminTokenGuard`, the test hook.
#[cfg(test)]
pub(crate) fn reset() {
    let mut s = state();
    s.clients.clear();
    s.global.clear();
    s.known_good.clear();
}

/// `::ffff:127.0.0.1` and `127.0.0.1` are one client.
fn normalise_peer(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    match lower.strip_prefix("::ffff:") {
        Some(v4) if v4.contains('.') => v4.to_string(),
        _ => lower,
    }
}

fn head<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// `adminTokenClientKey`: the last forwarded hop behind a trusted proxy,
/// else the socket peer, else `None`.
pub(crate) fn client_key(headers: &HeaderMap) -> Option<String> {
    if let Some(forwarded) =
        trusted_client_ip(head(headers, "x-forwarded-for"), head(headers, "x-real-ip"))
    {
        return Some(normalise_peer(&forwarded));
    }
    head(headers, PEER_HEADER)
        .map(normalise_peer)
        .filter(|p| !p.is_empty())
}

/// `presentedAdminCookie`: the first `pt_admin_token` cookie's raw value,
/// trimmed, when it is not empty, read the way `auth.rs` reads it.
fn presented_cookie(cookie_header: Option<&str>) -> Option<&str> {
    for part in cookie_header.unwrap_or("").split(';') {
        let Some(sep) = part.find('=') else { continue };
        if part[..sep].trim() != ADMIN_TOKEN_COOKIE {
            continue;
        }
        let value = part[sep + 1..].trim();
        return (!value.is_empty()).then_some(value);
    }
    None
}

/// `presentedValues`: the header's value, then the cookie's, each tagged.
fn presented_values(headers: &HeaderMap) -> Vec<String> {
    let mut values = vec![];
    if let Some(v) = head(headers, "x-auditor-admin-token").filter(|v| !v.is_empty()) {
        values.push(format!("header {v}"));
    }
    if let Some(v) = presented_cookie(head(headers, header::COOKIE.as_str())) {
        values.push(format!("cookie {v}"));
    }
    values
}

fn hash(value: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, value.as_bytes())
        .as_ref()
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn prune(s: &mut GuardState, now: i64) {
    let cutoff = now - FAILURE_WINDOW_MS;
    s.global.retain(|_, at| *at > cutoff);
    if s.clients.len() > GC_THRESHOLD {
        for failures in s.clients.values_mut() {
            failures.retain(|_, at| *at > cutoff);
        }
        s.clients.retain(|_, failures| !failures.is_empty());
    }
}

fn oldest(entries: &HashMap<String, i64>) -> i64 {
    entries.values().copied().min().unwrap_or(i64::MAX)
}

/// `adminTokenAttemptsBlocked`: the cooldown left when this client may not
/// present a token now. Never refuses while no token is configured or no
/// client is known.
pub(crate) fn attempts_blocked(client: Option<&str>, now: i64) -> Option<i64> {
    let client = client?;
    if !admin_token_configured() {
        return None;
    }
    let mut s = state();
    prune(&mut s, now);
    let cutoff = now - FAILURE_WINDOW_MS;
    if let Some(failures) = s.clients.get_mut(client) {
        failures.retain(|_, at| *at > cutoff);
        if failures.len() >= PER_CLIENT_FAILURE_LIMIT {
            return Some((oldest(failures) + FAILURE_WINDOW_MS - now).max(0));
        }
    }
    if s.global.len() >= GLOBAL_FAILURE_LIMIT {
        let known_good = s
            .known_good
            .get(client)
            .is_some_and(|last| now - last <= KNOWN_GOOD_MS);
        if !known_good {
            return Some((oldest(&s.global) + FAILURE_WINDOW_MS - now).max(0));
        }
    }
    None
}

/// `recordAdminTokenFailure`: one wrong value, once per window per value.
pub(crate) fn record_failure(client: Option<&str>, value: &str, now: i64) {
    let Some(client) = client else { return };
    if !admin_token_configured() {
        return;
    }
    let h = hash(value);
    let mut s = state();
    s.clients
        .entry(client.to_string())
        .or_default()
        .entry(h.clone())
        .or_insert(now);
    s.global.entry(format!("{client} {h}")).or_insert(now);
}

/// `recordAdminTokenSuccess`.
pub(crate) fn record_success(client: Option<&str>, now: i64) {
    let Some(client) = client else { return };
    let mut s = state();
    s.known_good.insert(client.to_string(), now);
    if s.known_good.len() > KNOWN_GOOD_MAX {
        if let Some(stalest) = s
            .known_good
            .iter()
            .min_by_key(|(_, at)| **at)
            .map(|(k, _)| k.clone())
        {
            s.known_good.remove(&stalest);
        }
    }
}

/// `AdminTokenCheck`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Check {
    Valid,
    Absent,
    Invalid,
    Throttled(i64),
}

/// `checkAdminTokenAttempt`: refuse a client past its budget before looking
/// at what it sent, else check the token and account for the result.
pub(crate) fn check_attempt(headers: &HeaderMap, now: i64) -> Check {
    let values = presented_values(headers);
    if values.is_empty() {
        return Check::Absent;
    }
    let client = client_key(headers);
    if let Some(retry_after_ms) = attempts_blocked(client.as_deref(), now) {
        return Check::Throttled(retry_after_ms);
    }
    if request_has_valid_admin_token(
        head(headers, "x-auditor-admin-token"),
        head(headers, header::COOKIE.as_str()),
    ) {
        record_success(client.as_deref(), now);
        return Check::Valid;
    }
    for value in &values {
        record_failure(client.as_deref(), value, now);
    }
    Check::Invalid
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const TOKEN: &str = "guard-test-token";

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.append(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        map
    }

    /// Run with a configured token, no trusted proxy and a fresh guard,
    /// under the env lock the rest of the server's tests share.
    fn scenario(f: impl FnOnce()) {
        let _env = super::super::trust::env_lock();
        let previous = std::env::var("AUDITOR_ADMIN_TOKEN").ok();
        std::env::set_var("AUDITOR_ADMIN_TOKEN", TOKEN);
        std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
        reset();
        f();
        reset();
        match previous {
            Some(v) => std::env::set_var("AUDITOR_ADMIN_TOKEN", v),
            None => std::env::remove_var("AUDITOR_ADMIN_TOKEN"),
        }
    }

    fn from(peer: &str, token: &str) -> HeaderMap {
        headers(&[(PEER_HEADER, peer), ("x-auditor-admin-token", token)])
    }

    #[test]
    fn a_client_past_its_budget_is_refused_before_its_token_is_checked() {
        scenario(|| {
            let now = 1_000_000;
            for i in 0..PER_CLIENT_FAILURE_LIMIT {
                assert_eq!(
                    check_attempt(&from("10.0.0.9", &format!("guess-{i}")), now),
                    Check::Invalid
                );
            }
            // Even the right token is not looked at now…
            assert_eq!(
                check_attempt(&from("10.0.0.9", TOKEN), now + 1),
                Check::Throttled(FAILURE_WINDOW_MS - 1)
            );
            // …while a request with no token still gets its ordinary answer.
            assert_eq!(
                check_attempt(&headers(&[(PEER_HEADER, "10.0.0.9")]), now + 1),
                Check::Absent
            );
            // Another client is untouched.
            assert_eq!(
                check_attempt(&from("10.0.0.8", TOKEN), now + 1),
                Check::Valid
            );
            // The window slides.
            assert_eq!(
                check_attempt(&from("10.0.0.9", TOKEN), now + FAILURE_WINDOW_MS),
                Check::Valid
            );
        });
    }

    #[test]
    fn a_repeated_wrong_value_counts_once() {
        scenario(|| {
            let stale = headers(&[
                (PEER_HEADER, "::ffff:10.0.0.7"),
                ("cookie", "theme=dark; pt_admin_token=rotated-away"),
            ]);
            for _ in 0..50 {
                assert_eq!(check_attempt(&stale, 5), Check::Invalid);
            }
            // The same client, as a plain IPv4 peer, signs in with the new token.
            assert_eq!(check_attempt(&from("10.0.0.7", TOKEN), 6), Check::Valid);
        });
    }

    #[test]
    fn without_a_client_or_a_token_nothing_is_counted() {
        scenario(|| {
            let anonymous = |i: usize| headers(&[("x-auditor-admin-token", &format!("g{i}"))]);
            for i in 0..3 * PER_CLIENT_FAILURE_LIMIT {
                assert_eq!(check_attempt(&anonymous(i), 1), Check::Invalid);
            }
            assert_eq!(
                check_attempt(&headers(&[("x-auditor-admin-token", TOKEN)]), 2),
                Check::Valid
            );
            std::env::remove_var("AUDITOR_ADMIN_TOKEN");
            for i in 0..3 * PER_CLIENT_FAILURE_LIMIT {
                assert_eq!(
                    check_attempt(&from("10.0.0.5", &format!("g{i}")), 3),
                    Check::Invalid
                );
            }
            assert_eq!(attempts_blocked(Some("10.0.0.5"), 4), None);
        });
    }

    #[test]
    fn the_global_backstop_spares_a_client_that_signed_in_recently() {
        scenario(|| {
            let now = 50_000_000;
            assert_eq!(
                check_attempt(&from("192.168.1.2", TOKEN), now),
                Check::Valid
            );
            // Guessing spread over many addresses, under each one's budget.
            for i in 0..GLOBAL_FAILURE_LIMIT {
                let peer = format!("10.1.{}.{}", i / 5, i % 5);
                assert_eq!(
                    check_attempt(&from(&peer, &format!("x{i}")), now),
                    Check::Invalid
                );
            }
            // A fresh address is refused before its token is looked at…
            assert!(matches!(
                check_attempt(&from("10.2.0.1", TOKEN), now + 1),
                Check::Throttled(_)
            ));
            // …the operator who signed in earlier is not.
            assert_eq!(
                check_attempt(&from("192.168.1.2", TOKEN), now + 1),
                Check::Valid
            );
        });
    }

    #[test]
    fn a_trusted_proxy_keys_on_the_last_forwarded_hop() {
        scenario(|| {
            std::env::set_var("PRIVACYTRACKER_TRUST_PROXY", "1");
            let via = |xff: &str| headers(&[(PEER_HEADER, "172.17.0.1"), ("x-forwarded-for", xff)]);
            assert_eq!(
                client_key(&via("1.1.1.1, 2.2.2.2")).as_deref(),
                Some("2.2.2.2")
            );
            std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
            assert_eq!(
                client_key(&via("1.1.1.1, 2.2.2.2")).as_deref(),
                Some("172.17.0.1")
            );
            assert_eq!(client_key(&HeaderMap::new()), None);
        });
    }

    #[test]
    fn the_cookie_is_read_as_the_token_check_reads_it() {
        assert_eq!(presented_cookie(Some("a=1; pt_admin_token= x ")), Some("x"));
        assert_eq!(
            presented_cookie(Some("pt_admin_token=first; pt_admin_token=second")),
            Some("first")
        );
        assert_eq!(presented_cookie(Some("pt_admin_token=")), None);
        assert_eq!(presented_cookie(Some("other=1")), None);
        assert_eq!(presented_cookie(None), None);
    }
}

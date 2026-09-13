//! Port of `lib/deployment-trust.ts` — host normalisation, loopback
//! detection, and the bind classification that decides whether auth is
//! required.
//!
//! The critical property, and the one a careless port inverts: this
//! **fails closed**. `isNetworkExposed()` is
//! `bindClassification() !== "loopback"`, and `bindClassification()` returns
//! `"unknown"` when `PRIVACYTRACKER_BIND_HOST` is unset. So with NO
//! environment configured at all, the deployment counts as network-exposed
//! and authentication is REQUIRED. A Rust port that writes
//! `env::var(..).is_ok()` and defaults to "not exposed" would silently drop
//! authentication on the most common configuration — and the parity harness
//! could never catch it, because the harness authenticates every request.

use std::env;

use axum::http::{header, HeaderMap};

/// Port of `normalizeHost`. Lowercases, strips a port, unwraps bracketed
/// IPv6, drops an IPv6 zone id and a single trailing FQDN dot.
pub fn normalize_host(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let mut h = raw.trim().to_lowercase();
    if h.is_empty() {
        return None;
    }

    if h.starts_with('[') {
        // Bracketed IPv6, optionally with a port: [::1]:3000 → ::1
        h = match h.find(']') {
            Some(end) => h[1..end].to_string(),
            None => h[1..].to_string(),
        };
    } else if h.matches(':').count() <= 1 {
        // At most one colon → host:port, drop the port. Bare IPv6 literals
        // have 2+ colons and fall through untouched.
        h = h.split(':').next().unwrap_or("").to_string();
    }

    if let Some(pct) = h.find('%') {
        h.truncate(pct); // strip IPv6 zone id
    }
    if h.ends_with('.') {
        h.pop(); // strip a single trailing FQDN dot
    }

    if h.is_empty() {
        None
    } else {
        Some(h)
    }
}

/// Port of `isLoopbackNormalized`: 127.0.0.0/8, ::1, localhost, *.localhost.
pub fn is_loopback_normalized(h: &str) -> bool {
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    if h == "::1" || h == "0:0:0:0:0:0:0:1" {
        return true;
    }
    // 127.0.0.0/8 — any dotted quad whose first octet is 127.
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        if let Ok(first) = parts[0].parse::<u8>() {
            return first == 127;
        }
    }
    false
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BindClassification {
    Loopback,
    Wildcard,
    Specific,
    Unknown,
}

fn bind_host_raw() -> Option<String> {
    env::var("PRIVACYTRACKER_BIND_HOST").ok()
}

fn is_ip_literal(h: &str) -> bool {
    h.parse::<std::net::IpAddr>().is_ok()
}

/// Port of `bindClassification`. Unset env → `Unknown` (NOT loopback).
pub fn bind_classification() -> BindClassification {
    let Some(b) = normalize_host(bind_host_raw().as_deref()) else {
        return BindClassification::Unknown;
    };
    if b == "0.0.0.0" || b == "::" {
        return BindClassification::Wildcard;
    }
    if is_loopback_normalized(&b) {
        return BindClassification::Loopback;
    }
    if is_ip_literal(&b) {
        return BindClassification::Specific;
    }
    BindClassification::Unknown
}

/// Port of `bindIsAmbiguous`: wildcard or unknown — the two answers on
/// which "reachable beyond localhost?" cannot be decided from config.
pub fn bind_is_ambiguous() -> bool {
    matches!(
        bind_classification(),
        BindClassification::Wildcard | BindClassification::Unknown
    )
}

/// Port of `envFlag` (deployment-trust.ts) and of `trustProxy`'s
/// `/^(1|true|yes|on)$/i` (request-origin.cjs): trimmed, case-insensitive.
/// The first cut special-cased `TRUE` and missed `Yes`, `ON` and friends.
fn env_flag(name: &str) -> bool {
    matches!(
        env::var(name)
            .ok()
            .map(|v| v.trim().to_lowercase())
            .as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Port of `isNetworkExposed`. Fails CLOSED — see the module doc.
pub fn is_network_exposed() -> bool {
    if env_flag("PRIVACYTRACKER_NETWORK_EXPOSED") {
        return true;
    }
    if allowlist_has_non_loopback() {
        return true;
    }
    bind_classification() != BindClassification::Loopback
}

/// The configured extra-host allowlist, as normalised patterns.
pub fn allowed_host_patterns() -> Vec<String> {
    env::var("PRIVACYTRACKER_ALLOWED_HOSTS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|p| normalize_host(Some(p)))
        .collect()
}

fn allowlist_has_non_loopback() -> bool {
    allowed_host_patterns()
        .iter()
        .any(|p| !is_loopback_normalized(p))
}

fn host_matches_pattern(h: &str, pattern: &str) -> bool {
    if let Some(suffix) = pattern.strip_prefix("*.") {
        return h == suffix || h.ends_with(&format!(".{suffix}"));
    }
    h == pattern
}

/// Port of `isHostAllowed`. Loopback always passes; otherwise the host must
/// match a configured allowlist pattern.
pub fn is_host_allowed(raw: Option<&str>) -> bool {
    let Some(h) = normalize_host(raw) else {
        return false;
    };
    if is_loopback_normalized(&h) {
        return true;
    }
    allowed_host_patterns()
        .iter()
        .any(|p| host_matches_pattern(&h, p))
}

// ── Port of `lib/request-origin.cjs` ────────────────────────────────────
//
// deployment-trust.ts re-exports these; they live in a dependency-free .cjs
// so proxy.ts (which runs in the middleware sandbox) can share them with the
// rate limiter. One flag drives all of it: `PRIVACYTRACKER_TRUST_PROXY`
// decides whether X-Forwarded-Host / -Proto / -For are believed. It is OFF
// by default, and off means the forwarded headers are ATTACKER-CONTROLLED.
// The first cut of the gate honoured X-Forwarded-Host unconditionally, which
// let a client satisfy the host allowlist — and, through the same helper,
// the CSRF same-origin check — with a header of its choosing.
//
// The trust flag is passed INTO these functions rather than read inside them
// so they are pure and testable without touching process env; the gate reads
// `trust_proxy()` once per request and threads it through.

/// Port of `trustProxy`.
pub fn trust_proxy() -> bool {
    env_flag("PRIVACYTRACKER_TRUST_PROXY")
}

/// Port of `firstHeaderValue`: the first comma-separated entry, trimmed;
/// `None` when the header is absent or that entry is empty.
fn first_header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(name)?.to_str().ok()?;
    let first = raw.split(',').next()?.trim();
    (!first.is_empty()).then(|| first.to_string())
}

/// Port of `effectiveHostFromHeaders`: the first `X-Forwarded-Host` entry
/// when — and only when — the proxy is trusted, else `Host` exactly as sent.
pub fn effective_host(headers: &HeaderMap, trust: bool) -> Option<String> {
    if trust {
        if let Some(forwarded) = first_header_value(headers, "x-forwarded-host") {
            return Some(forwarded);
        }
    }
    headers.get(header::HOST)?.to_str().ok().map(str::to_string)
}

/// Port of `requestOrigin`.
///
/// Node reads the scheme off `request.url`, which under `next start` is
/// always `http:` — this server likewise only ever listens on plain HTTP —
/// and lets a trusted proxy's `X-Forwarded-Proto` override it. That override
/// is compared CASE-SENSITIVELY: Node builds `${forwarded}:` and tests it
/// against `"http:"` / `"https:"`, so `X-Forwarded-Proto: HTTPS` yields no
/// origin at all (and so no same-origin match) rather than an https one.
pub fn request_origin(headers: &HeaderMap, trust: bool) -> Option<String> {
    let host = effective_host(headers, trust)?;
    let mut scheme = String::from("http");
    if trust {
        if let Some(forwarded) = first_header_value(headers, "x-forwarded-proto") {
            scheme = forwarded;
        }
    }
    if scheme != "http" && scheme != "https" {
        return None;
    }
    serialise_origin(&scheme, &host)
}

/// Port of `isSameOriginRequest`. The `Origin` header must parse to the
/// expected origin AND already be in canonical serialised form — the
/// `origin === parsed.origin` half — so a trailing slash, an uppercase
/// scheme or a default port spelled out all fail even when the origin
/// behind them matches. The expected side is normalised the same way, so an
/// uppercase `Host` still matches a lowercase `Origin`.
pub fn is_same_origin_request(headers: &HeaderMap, trust: bool) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if origin.is_empty() {
        return false;
    }
    let Some(expected) = request_origin(headers, trust) else {
        return false;
    };
    match parse_origin(origin) {
        Some(parsed) => parsed == expected && parsed == origin,
        None => false,
    }
}

/// `new URL(origin).origin` for the `Origin` header, or `None` where `URL`
/// would throw. Only the two schemes `request_origin` can produce are
/// parsed; anything else — `ftp:`, or the literal `null` an opaque-origin
/// browser sends — can never equal the expected origin, so it is `None`
/// here and `false` downstream, exactly as in Node.
fn parse_origin(origin: &str) -> Option<String> {
    let (scheme, rest) = origin.split_once("://")?;
    serialise_origin(scheme, rest)
}

/// What `new URL(`${scheme}://${rest}`).origin` serialises to, with the
/// `username || password || pathname !== "/"` rejection that `requestOrigin`
/// applies on top — or `None` where Node's `URL` would throw or that check
/// would fail. (Applying the rejection to the `Origin` header as well is
/// harmless: an `Origin` carrying a path or userinfo can never equal its own
/// serialised origin, so Node answers `false` for it too.)
///
/// Hand-rolled rather than pulled from the `url` crate, which is not in the
/// lockfile and brings IDNA/ICU with it. It covers what a `Host` or `Origin`
/// header carries in practice: scheme and host are lowercased, a default
/// port (80/443) is dropped, a bracketed IPv6 literal is kept as written, a
/// query or fragment is tolerated (the path stays `/`), and a path,
/// userinfo, whitespace, a non-numeric or out-of-range port, or an empty
/// host is a rejection. NOT covered: IPv4 shorthand (`127.1`), IDNA,
/// percent-decoding and IPv6 compression — none of which survive step 0's
/// `normalize_host` allowlist on either backend, so they never reach the
/// origin check.
fn serialise_origin(scheme: &str, rest: &str) -> Option<String> {
    let scheme = scheme.to_ascii_lowercase();
    let default_port: u16 = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };

    // The authority ends at the first path/query/fragment delimiter. A
    // backslash counts: WHATWG reads it as `/` for the special schemes.
    let end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    // Only an empty path or exactly `/` passes `url.pathname !== "/"`.
    if let Some(after) = tail.strip_prefix(['/', '\\']) {
        let path_end = after.find(['?', '#']).unwrap_or(after.len());
        if !after[..path_end].is_empty() {
            return None;
        }
    }
    if authority.contains('@') {
        return None; // username / password
    }

    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let close = inner.find(']')?;
        let host = &authority[..close + 2]; // keep the brackets
        let after = &inner[close + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) => p,
            None if after.is_empty() => "",
            None => return None,
        };
        (host, port)
    } else {
        match authority.rsplit_once(':') {
            // A second colon means an unbracketed IPv6 literal: invalid.
            Some((h, _)) if h.contains(':') => return None,
            Some((h, p)) => (h, p),
            None => (authority, ""),
        }
    };
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_ascii_whitespace() || c.is_ascii_control() || "<>^|%".contains(c))
    {
        return None;
    }

    let port = if port.is_empty() {
        None
    } else {
        if !port.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        // `parse` absorbs leading zeros (`:0080` is port 80) and overflows
        // on absurd lengths, both matching WHATWG.
        let n: u32 = port.parse().ok()?;
        if n > u32::from(u16::MAX) {
            return None;
        }
        (n != u32::from(default_port)).then_some(n)
    };

    let host = host.to_ascii_lowercase();
    let mut origin = format!("{scheme}://{host}");
    if let Some(p) = port {
        origin.push(':');
        origin.push_str(&p.to_string());
    }
    Some(origin)
}

/// Serialises the tests that touch `PRIVACYTRACKER_TRUST_PROXY`: the rate
/// limiter's tests set it transiently, and the gate's forwarded-host tests
/// need it UNSET for their whole duration. `cargo test` runs tests on
/// parallel threads, so both sides hold this.
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_hosts_like_the_node_helper() {
        assert_eq!(
            normalize_host(Some("127.0.0.1:3000")).as_deref(),
            Some("127.0.0.1")
        );
        assert_eq!(normalize_host(Some("[::1]:3000")).as_deref(), Some("::1"));
        assert_eq!(normalize_host(Some("::1")).as_deref(), Some("::1"));
        assert_eq!(
            normalize_host(Some("EXAMPLE.com.")).as_deref(),
            Some("example.com")
        );
        assert_eq!(
            normalize_host(Some("fe80::1%eth0")).as_deref(),
            Some("fe80::1")
        );
        assert_eq!(normalize_host(Some("  ")), None);
        assert_eq!(normalize_host(None), None);
    }

    #[test]
    fn detects_loopback() {
        for h in [
            "127.0.0.1",
            "127.1.2.3",
            "localhost",
            "app.localhost",
            "::1",
        ] {
            assert!(is_loopback_normalized(h), "{h} should be loopback");
        }
        for h in ["10.0.0.1", "example.com", "0.0.0.0", "128.0.0.1"] {
            assert!(!is_loopback_normalized(h), "{h} should NOT be loopback");
        }
    }

    #[test]
    fn loopback_hosts_are_allowed_without_an_allowlist() {
        assert!(is_host_allowed(Some("127.0.0.1:3001")));
        assert!(is_host_allowed(Some("localhost:3000")));
        assert!(!is_host_allowed(None));
    }

    fn hm(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                header::HeaderName::from_bytes(k.as_bytes()).expect("header name"),
                header::HeaderValue::from_str(v).expect("header value"),
            );
        }
        h
    }

    #[test]
    fn trust_flag_is_trimmed_and_case_insensitive() {
        let _env = env_lock();
        for (raw, want) in [
            ("1", true),
            ("true", true),
            (" Yes ", true),
            ("ON", true),
            ("0", false),
            ("false", false),
            ("", false),
        ] {
            env::set_var("PRIVACYTRACKER_TRUST_PROXY", raw);
            assert_eq!(trust_proxy(), want, "{raw:?}");
        }
        env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
        assert!(!trust_proxy());
    }

    #[test]
    fn forwarded_host_is_ignored_unless_the_proxy_is_trusted() {
        let h = hm(&[
            ("host", "127.0.0.1:3000"),
            ("x-forwarded-host", "evil.example, other"),
        ]);
        assert_eq!(effective_host(&h, false).as_deref(), Some("127.0.0.1:3000"));
        assert_eq!(effective_host(&h, true).as_deref(), Some("evil.example"));
        // An empty first entry falls back to Host even when trusted.
        let h = hm(&[("host", "127.0.0.1:3000"), ("x-forwarded-host", " , x")]);
        assert_eq!(effective_host(&h, true).as_deref(), Some("127.0.0.1:3000"));
        assert_eq!(effective_host(&hm(&[]), true), None);
    }

    /// Expected values generated with `node -e 'new URL(x).origin'`, plus
    /// the userinfo/path rejections `requestOrigin` layers on top.
    #[test]
    fn origin_serialisation_matches_the_whatwg_url_class() {
        for (input, want) in [
            ("http://127.0.0.1:3011", Some("http://127.0.0.1:3011")),
            ("HTTP://127.0.0.1:3011", Some("http://127.0.0.1:3011")),
            ("http://127.0.0.1:3011/", Some("http://127.0.0.1:3011")),
            ("http://127.0.0.1:80", Some("http://127.0.0.1")),
            ("http://127.0.0.1", Some("http://127.0.0.1")),
            ("https://127.0.0.1:443", Some("https://127.0.0.1")),
            ("http://LOCALHOST:3011", Some("http://localhost:3011")),
            ("http://[::1]:3011", Some("http://[::1]:3011")),
            ("http://[::1]", Some("http://[::1]")),
            ("http://127.0.0.1:3011?x", Some("http://127.0.0.1:3011")),
            ("http://127.0.0.1:3011#f", Some("http://127.0.0.1:3011")),
            ("http://127.0.0.1:", Some("http://127.0.0.1")),
            ("http://127.0.0.1:0", Some("http://127.0.0.1:0")),
            ("http://127.0.0.1:0080", Some("http://127.0.0.1")),
            // `URL` throws on these.
            ("http://127.0.0.1:99999", None),
            ("http://", None),
            ("http://a b", None),
            ("http://1:2:3", None),
            ("garbage", None),
            ("null", None),
            // Parses in Node, but can never equal an http(s) expectation.
            ("ftp://127.0.0.1", None),
            // requestOrigin's own rejections: userinfo and a real path.
            ("http://user:pw@127.0.0.1:3011", None),
            ("http://127.0.0.1:3011/x", None),
            ("http://127.0.0.1:3011\\x", None),
        ] {
            assert_eq!(parse_origin(input).as_deref(), want, "{input}");
        }
    }

    #[test]
    fn request_origin_follows_the_trust_flag() {
        let h = hm(&[
            ("host", "127.0.0.1:3011"),
            ("x-forwarded-host", "app.example"),
            ("x-forwarded-proto", "https"),
        ]);
        assert_eq!(
            request_origin(&h, false).as_deref(),
            Some("http://127.0.0.1:3011")
        );
        assert_eq!(
            request_origin(&h, true).as_deref(),
            Some("https://app.example")
        );
        // The proto override is case-sensitive: `HTTPS:` is neither
        // `http:` nor `https:`, so there is no origin at all.
        let h = hm(&[("host", "127.0.0.1:3011"), ("x-forwarded-proto", "HTTPS")]);
        assert_eq!(request_origin(&h, true), None);
        assert_eq!(
            request_origin(&h, false).as_deref(),
            Some("http://127.0.0.1:3011")
        );
        // Host values requestOrigin rejects, and two it normalises.
        for bad in ["127.0.0.1/x", "u@127.0.0.1", "127.0.0.1:3011,evil", ""] {
            assert_eq!(
                request_origin(&hm(&[("host", bad)]), false),
                None,
                "{bad:?}"
            );
        }
        assert_eq!(
            request_origin(&hm(&[("host", "127.0.0.1?x")]), false).as_deref(),
            Some("http://127.0.0.1")
        );
        assert_eq!(
            request_origin(&hm(&[("host", "LocalHost:3011")]), false).as_deref(),
            Some("http://localhost:3011")
        );
    }

    /// Every rejection here answered 403 from a running Node server, and
    /// the two acceptances reached the route behind the gate.
    #[test]
    fn same_origin_requires_the_canonical_serialisation() {
        let with = |origin: &str| hm(&[("host", "127.0.0.1:3011"), ("origin", origin)]);
        assert!(is_same_origin_request(
            &with("http://127.0.0.1:3011"),
            false
        ));
        assert!(!is_same_origin_request(
            &with("https://127.0.0.1:3011"),
            false
        ));
        assert!(!is_same_origin_request(
            &with("http://127.0.0.1:3011/"),
            false
        ));
        assert!(!is_same_origin_request(
            &with("HTTP://127.0.0.1:3011"),
            false
        ));
        assert!(!is_same_origin_request(
            &with("http://127.0.0.1:3011:"),
            false
        ));
        assert!(!is_same_origin_request(&with("null"), false));
        assert!(!is_same_origin_request(&with(""), false));
        assert!(!is_same_origin_request(
            &hm(&[("host", "127.0.0.1:3011")]),
            false
        ));
        // The expected side is normalised too.
        assert!(is_same_origin_request(
            &hm(&[
                ("host", "LOCALHOST:3011"),
                ("origin", "http://localhost:3011")
            ]),
            false
        ));
        // A forwarded host only moves the expectation when trusted — which
        // is exactly the bypass an unconditional read opened up.
        let forged = hm(&[
            ("host", "127.0.0.1:3011"),
            ("x-forwarded-host", "evil.example"),
            ("origin", "http://evil.example"),
        ]);
        assert!(!is_same_origin_request(&forged, false));
        assert!(is_same_origin_request(&forged, true));
    }
}

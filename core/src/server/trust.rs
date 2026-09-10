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

fn env_flag(name: &str) -> bool {
    matches!(
        env::var(name).ok().as_deref().map(str::trim),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("on")
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
fn allowed_host_patterns() -> Vec<String> {
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
}

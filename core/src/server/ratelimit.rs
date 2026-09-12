//! Port of the INBOUND request limiter in `lib/security.ts`
//! (`checkRateLimit` / `rateLimitKeyForRequest`).
//!
//! Not to be confused with `lib/rate-limit.ts`, which is a different thing
//! entirely: Apple's *outbound* search/scrape cooldowns, persisted in
//! `app_settings`. This one is a per-process, in-memory sliding window over
//! request timestamps, and it is what gates routes like `/api/manual-apps`.
//!
//! **The parity harness cannot verify this**, for the same structural reason
//! it cannot verify the auth gate: the limits are 120/min and the harness
//! sends one request per route, so neither backend is ever close to tripping.
//! A Rust server that simply omitted the limiter would pass every check. It
//! is therefore covered by unit tests here and by a direct probe in
//! `read-parity.mjs`, and "parity green" must not be read as evidence that it
//! exists.
//!
//! Being in-memory and per-process, the two backends have INDEPENDENT limiter
//! state by construction. That is correct — it matches Node, where a restart
//! forgets the window — but it does mean the state itself is not a parity
//! contract, only the behaviour of a fresh window is.

use super::trust::trust_proxy;
use std::collections::HashMap;
use std::sync::Mutex;

/// A sliding window of request timestamps for one key.
#[derive(Default)]
struct Bucket {
    timestamps: Vec<i64>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Verdict {
    pub allowed: bool,
    pub remaining: i64,
    pub retry_after_ms: i64,
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<String, Bucket>>,
}

/// Node opportunistically drops empty buckets once the map grows past this.
const GC_THRESHOLD: usize = 5000;

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Port of `checkRateLimit`. Prunes timestamps older than the window,
    /// denies when the remaining count is already at the limit, otherwise
    /// records this request.
    ///
    /// The deny path deliberately does NOT record a timestamp — Node returns
    /// before the push — so a client hammering a denied endpoint does not
    /// extend its own cooldown indefinitely.
    pub fn check(&self, key: &str, limit: i64, window_ms: i64, now: i64) -> Verdict {
        let cutoff = now - window_ms;
        let mut buckets = self.buckets.lock().expect("rate-limit mutex poisoned");
        let bucket = buckets.entry(key.to_string()).or_default();

        // Prune the oldest entries that have fallen out of the window.
        while !bucket.timestamps.is_empty() && bucket.timestamps[0] < cutoff {
            bucket.timestamps.remove(0);
        }

        if bucket.timestamps.len() as i64 >= limit {
            let retry_after_ms = bucket.timestamps[0] + window_ms - now;
            return Verdict {
                allowed: false,
                remaining: 0,
                retry_after_ms: retry_after_ms.max(0),
            };
        }

        bucket.timestamps.push(now);
        let remaining = limit - bucket.timestamps.len() as i64;

        if buckets.len() > GC_THRESHOLD {
            buckets.retain(|_, b| !b.timestamps.is_empty());
        }

        Verdict {
            allowed: true,
            remaining,
            retry_after_ms: 0,
        }
    }
}

/// Port of `clientIpFromHeaders`. Returns None unless a trusted proxy is
/// configured — forwarded headers are attacker-controlled otherwise, so
/// honouring them would let header rotation multiply buckets and defeat the
/// limiter entirely.
///
/// Note it takes the **last** `X-Forwarded-For` entry, not the first: with a
/// trusted proxy in front, the last hop is the one the proxy appended and
/// therefore the only one a client cannot forge.
fn client_ip(x_forwarded_for: Option<&str>, x_real_ip: Option<&str>) -> Option<String> {
    if !trust_proxy() {
        return None;
    }
    if let Some(xff) = x_forwarded_for {
        let parts: Vec<&str> = xff
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if let Some(last) = parts.last() {
            return Some(last.to_lowercase());
        }
    }
    x_real_ip.map(|r| r.trim().to_lowercase())
}

/// Port of `rateLimitKeyForRequest`: `"{prefix}:{ip}"`, collapsing to a shared
/// `"local"` suffix when no trusted proxy is configured. The prefix still
/// namespaces each route, so routes stay isolated from one another even while
/// sharing that suffix.
pub fn key_for_request(
    x_forwarded_for: Option<&str>,
    x_real_ip: Option<&str>,
    prefix: &str,
) -> String {
    let ip = client_ip(x_forwarded_for, x_real_ip).unwrap_or_else(|| "local".to_string());
    format!("{prefix}:{ip}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_the_limit_then_denies() {
        let rl = RateLimiter::new();
        let now = 1_000_000i64;
        // limit 3 in a 60s window.
        for i in 0..3 {
            let v = rl.check("k", 3, 60_000, now + i);
            assert!(v.allowed, "request {i} should be allowed");
            assert_eq!(v.remaining, 3 - (i + 1));
            assert_eq!(v.retry_after_ms, 0);
        }
        let denied = rl.check("k", 3, 60_000, now + 3);
        assert!(!denied.allowed);
        assert_eq!(denied.remaining, 0);
        // retryAfter is measured from the OLDEST timestamp in the window.
        assert_eq!(denied.retry_after_ms, now + 60_000 - (now + 3));
    }

    #[test]
    fn the_window_slides() {
        let rl = RateLimiter::new();
        let now = 1_000_000i64;
        for i in 0..3 {
            assert!(rl.check("k", 3, 60_000, now + i).allowed);
        }
        assert!(!rl.check("k", 3, 60_000, now + 3).allowed);
        // Once the whole window has elapsed the bucket drains and it allows again.
        assert!(rl.check("k", 3, 60_000, now + 60_001).allowed);
    }

    #[test]
    fn a_denied_request_does_not_extend_its_own_cooldown() {
        // Node returns BEFORE pushing on the deny path. If the deny recorded a
        // timestamp, a client polling a denied endpoint would never recover.
        let rl = RateLimiter::new();
        let now = 1_000_000i64;
        assert!(rl.check("k", 1, 1000, now).allowed);
        for t in 1..500 {
            assert!(!rl.check("k", 1, 1000, now + t).allowed);
        }
        // The original timestamp still governs, so it recovers on schedule.
        assert!(rl.check("k", 1, 1000, now + 1001).allowed);
    }

    #[test]
    fn keys_are_isolated_from_one_another() {
        let rl = RateLimiter::new();
        let now = 1_000_000i64;
        assert!(rl.check("a:local", 1, 1000, now).allowed);
        assert!(!rl.check("a:local", 1, 1000, now).allowed);
        // A different route prefix has its own budget.
        assert!(rl.check("b:local", 1, 1000, now).allowed);
    }

    #[test]
    fn forwarded_headers_are_ignored_without_a_trusted_proxy() {
        let _env = super::super::trust::env_lock();
        std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
        // Untrusted: the suffix collapses to "local" so header rotation
        // cannot multiply buckets.
        assert_eq!(
            key_for_request(Some("1.2.3.4"), Some("5.6.7.8"), "manual-apps.list"),
            "manual-apps.list:local"
        );

        std::env::set_var("PRIVACYTRACKER_TRUST_PROXY", "1");
        // Trusted: the LAST XFF entry wins, lowercased.
        assert_eq!(
            key_for_request(Some("1.2.3.4, 9.9.9.9"), None, "p"),
            "p:9.9.9.9"
        );
        // Falls back to X-Real-IP when XFF is absent.
        assert_eq!(key_for_request(None, Some(" 5.6.7.8 "), "p"), "p:5.6.7.8");
        // And to "local" when neither is present.
        assert_eq!(key_for_request(None, None, "p"), "p:local");
        std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
    }
}

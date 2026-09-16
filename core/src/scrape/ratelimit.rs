//! lib/rate-limit.ts: the settings-backed hard cooldown that Apple's 429 or
//! 403 starts — read before every scrape, written when the signal arrives —
//! and the in-memory soft pacer, a token bucket per category, that spaces
//! requests out. The cooldown is what the oracle sees; the pacer is process
//! state, ported with the same capacities and refill intervals.
use super::persist::{message, Writer};
use crate::{jsnum::js_parse_int, server::settings::get_setting_with};
use rusqlite::Connection;
use std::{
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// `APP_STORE_RATE_LIMIT_COOLDOWN_MS`: the cooldown when Apple sends no
/// usable Retry-After.
pub const APP_STORE_RATE_LIMIT_COOLDOWN_MS: i64 = 70_000;
/// `APP_STORE_RATE_LIMIT_MAX_MS`: the longest Retry-After honoured.
pub const APP_STORE_RATE_LIMIT_MAX_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Search,
    Scrape,
}

impl Category {
    fn keys(self) -> (&'static str, &'static str) {
        match self {
            Category::Search => ("rate_limit_search_until", "rate_limit_search_reason"),
            Category::Scrape => ("rate_limit_scrape_until", "rate_limit_scrape_reason"),
        }
    }
    fn index(self) -> usize {
        match self {
            Category::Search => 0,
            Category::Scrape => 1,
        }
    }
}

/// `getRemainingCooldownMs`: milliseconds left on a recorded cooldown, or
/// zero. The stored value goes through `Number.parseInt`, so garbage is no
/// cooldown at all.
pub fn remaining_cooldown_ms(
    conn: &Connection,
    category: Category,
    now: i64,
) -> Result<i64, String> {
    let (until, _) = category.keys();
    let raw = get_setting_with(conn, until, "0").map_err(message)?;
    let resume_at = js_parse_int(&raw).filter(|n| *n > 0).unwrap_or(0);
    Ok(if resume_at > now { resume_at - now } else { 0 })
}

/// `recordRateLimit`: keeps whichever of the new and the stored resume time
/// is later — a stored negative counts, a stored non-number is zero — and
/// writes both settings. Returns the resume time it settled on.
pub(super) fn record(
    w: &mut Writer,
    category: Category,
    retry_after_ms: i64,
    reason: &str,
    now: i64,
) -> Result<i64, String> {
    let (until, reason_key) = category.keys();
    let new_resume_at = now + retry_after_ms.max(0);
    let existing =
        js_parse_int(&get_setting_with(w.conn, until, "0").map_err(message)?).unwrap_or(0);
    let final_resume_at = new_resume_at.max(existing);
    w.set_setting(until, &final_resume_at.to_string())?;
    w.set_setting(reason_key, reason)?;
    Ok(final_resume_at)
}

/// `parseRetryAfterMs`: seconds first, then an HTTP date, both capped at ten
/// minutes; anything else is `None`. Note `Number.parseInt("0")` is zero and
/// not positive, so "0" falls through to `Date.parse("0")` — the year 2000,
/// long past — and yields nothing.
pub fn parse_retry_after_ms(header: Option<&str>, now: i64) -> Option<i64> {
    let header = header.filter(|h| !h.is_empty())?;
    if let Some(secs) = js_parse_int(header).filter(|s| *s > 0) {
        return Some(secs.saturating_mul(1000).min(APP_STORE_RATE_LIMIT_MAX_MS));
    }
    let as_date = crate::jsdate::parse(header)?;
    (as_date > now).then(|| (as_date - now).min(APP_STORE_RATE_LIMIT_MAX_MS))
}

// ── The soft pacer ───────────────────────────────────────────────────

struct Bucket {
    capacity: u64,
    tokens: u64,
    refill_interval_ms: u64,
    last_refill_at: u64,
}

static BUCKETS: Mutex<Option<[Bucket; 2]>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn with_bucket<R>(category: Category, f: impl FnOnce(&mut Bucket) -> R) -> R {
    let mut guard = BUCKETS.lock().unwrap_or_else(|e| e.into_inner());
    let buckets = guard.get_or_insert_with(|| {
        let now = now_ms();
        [
            Bucket {
                capacity: 4,
                tokens: 4,
                refill_interval_ms: 4200,
                last_refill_at: now,
            },
            Bucket {
                capacity: 6,
                tokens: 6,
                refill_interval_ms: 3300,
                last_refill_at: now,
            },
        ]
    });
    f(&mut buckets[category.index()])
}

fn refill(bucket: &mut Bucket) {
    let now = now_ms();
    let elapsed = now.saturating_sub(bucket.last_refill_at);
    if elapsed == 0 {
        return;
    }
    let new_tokens = elapsed / bucket.refill_interval_ms;
    if new_tokens == 0 {
        return;
    }
    bucket.tokens = (bucket.tokens + new_tokens).min(bucket.capacity);
    bucket.last_refill_at = now;
}

/// `acquireRateLimitToken`: take a token, or wait at most 800 ms and take
/// one anyway (the bucket floors at zero) — a pacer, not a gate.
pub async fn acquire_token(category: Category) {
    let wait = with_bucket(category, |bucket| {
        refill(bucket);
        if bucket.tokens >= 1 {
            bucket.tokens -= 1;
            None
        } else {
            Some(800u64.min(bucket.refill_interval_ms))
        }
    });
    if let Some(ms) = wait {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        with_bucket(category, |bucket| {
            refill(bucket);
            bucket.tokens = bucket.tokens.saturating_sub(1);
        });
    }
}

/// `_resetSoftBuckets`: every bucket back to full. Test-only in Node; here
/// for the replay, which runs dozens of scrapes on one process.
pub fn reset_soft_buckets() {
    for category in [Category::Search, Category::Scrape] {
        with_bucket(category, |bucket| {
            bucket.tokens = bucket.capacity;
            bucket.last_refill_at = now_ms();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::parse_retry_after_ms;

    #[test]
    fn retry_after_follows_node() {
        let now = 1_789_473_600_000; // 2026-09-15T12:00:00Z
                                     // Every pair is parseRetryAfterMs from node -e with the clock frozen.
        assert_eq!(parse_retry_after_ms(Some("120"), now), Some(120_000));
        assert_eq!(parse_retry_after_ms(Some("3600"), now), Some(600_000));
        assert_eq!(parse_retry_after_ms(Some("0"), now), None);
        assert_eq!(parse_retry_after_ms(Some("soon"), now), None);
        assert_eq!(parse_retry_after_ms(Some(""), now), None);
        assert_eq!(parse_retry_after_ms(None, now), None);
        assert_eq!(
            parse_retry_after_ms(Some("Tue, 15 Sep 2026 12:01:30 GMT"), now),
            Some(90_000)
        );
        assert_eq!(
            parse_retry_after_ms(Some("Tue, 15 Sep 2026 11:59:00 GMT"), now),
            None
        );
    }
}

//! Process-wide diagnostics state — the rings and histograms behind
//! `GET /api/diagnostics/runtime` and `GET /api/diagnostics/errors`.
//!
//! Module-level statics on purpose: Node keeps every one of these as a
//! module-scope variable (`lib/runtime-diagnostics.ts`, `lib/api-timing.ts`,
//! `lib/error-log-ring.ts`), one per process, wiped by a restart. Putting
//! them in `AppState` would also put them behind an axum extractor, which
//! CodeQL's Rust model treats as user input.
//!
//! Five readings, and where each comes from:
//!
//! - **Scheduler lag** — a tokio task sleeps 20 ms in a loop and records
//!   the INTERVAL it actually took, which is what Node's
//!   `monitorEventLoopDelay` records: measured on the installed Node, an
//!   idle loop at `resolution: 20` reports min 20.02 ms and p50 21.04 ms,
//!   i.e. the raw delta between timer fires, resolution included. Recording
//!   the overshoot instead would read ~20 ms "better" than Node for the
//!   same stall, and the shared severity thresholds (100 ms / 1000 ms)
//!   would fire ~20 ms late. The analogue of "is the event loop stalled?"
//!   for a work-stealing runtime is "is a ready task waiting for a worker?".
//! - **Lock wait** — the time a handler spends acquiring the single SQLite
//!   connection's mutex. Node has one synchronous connection and nothing to
//!   wait on; here it is the contention signal worth watching.
//! - **HTTP timings** — recorded by `timing.rs` for every routed request,
//!   with Node's sampling rule (all slow or erroring, one in five otherwise).
//! - **Slow queries** — SQLite's own profile callback (`sqlite3_profile`),
//!   installed on the connection at open: every statement's SQL and wall
//!   time, with no call-site instrumentation. Node wraps `db.prepare()`.
//! - **Error log** — a ring the server's warnings and errors go through on
//!   their way to stderr. Node intercepts `console.error`/`warn`.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::histogram::{LagHistogram, LagSnapshot};
use super::now_ms;
use crate::jsnum::js_number;

// ── Scheduler lag + lock wait ────────────────────────────────────────

/// `EVENT_LOOP_RESOLUTION_MS` — Node's default, and the sampler's period.
pub const SCHEDULER_SAMPLE_MS: u64 = 20;

fn scheduler_lag() -> &'static Mutex<LagHistogram> {
    static H: OnceLock<Mutex<LagHistogram>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(LagHistogram::new(now_ms())))
}

fn lock_wait() -> &'static Mutex<LagHistogram> {
    static H: OnceLock<Mutex<LagHistogram>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(LagHistogram::new(now_ms())))
}

/// Spawn the sampler. Idempotent per process; call once from `serve`.
///
/// Off a tokio runtime `tokio::spawn` panics, so the guard is claimed only
/// after the runtime is confirmed — otherwise a mistaken early call would
/// latch the flag and silently disable the sampler for the process.
pub fn start_scheduler_sampler() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if tokio::runtime::Handle::try_current().is_err() {
        log_warn("[diagnostics] scheduler sampler not started: no tokio runtime");
        return;
    }
    if STARTED.set(()).is_err() {
        return;
    }
    // Touch the histogram so `windowSeconds` starts now, not at first use.
    let _ = scheduler_lag();
    tokio::spawn(async {
        let period = Duration::from_millis(SCHEDULER_SAMPLE_MS);
        loop {
            let t = Instant::now();
            tokio::time::sleep(period).await;
            // The whole interval, not the overshoot — see the module docs.
            if let Ok(mut h) = scheduler_lag().lock() {
                h.record_micros(t.elapsed().as_micros() as u64);
            }
        }
    });
}

pub fn scheduler_lag_snapshot() -> Option<LagSnapshot> {
    let h = scheduler_lag().lock().ok()?;
    // `null` until the sampler has run, as Node reports null before the
    // histogram is enabled.
    if h.count() == 0 {
        return None;
    }
    Some(h.snapshot(now_ms()))
}

pub fn record_lock_wait(waited: Duration) {
    if let Ok(mut h) = lock_wait().lock() {
        h.record_micros(waited.as_micros() as u64);
    }
}

pub fn lock_wait_snapshot() -> Option<LagSnapshot> {
    let h = lock_wait().lock().ok()?;
    if h.count() == 0 {
        return None;
    }
    Some(h.snapshot(now_ms()))
}

/// `resetEventLoopMonitor` + the lock-wait equivalent. Called by the
/// `DELETE /api/diagnostics/runtime` port once the write routes land.
#[allow(dead_code)]
pub fn reset_histograms() {
    let now = now_ms();
    if let Ok(mut h) = scheduler_lag().lock() {
        h.reset(now);
    }
    if let Ok(mut h) = lock_wait().lock() {
        h.reset(now);
    }
}

// ── HTTP timings ─────────────────────────────────────────────────────

/// `RING_SIZE`, `SLOW_THRESHOLD_MS`, `SAMPLE_EVERY` in lib/api-timing.ts.
pub const HTTP_RING_SIZE: usize = 200;
pub const HTTP_SLOW_THRESHOLD_MS: i64 = 100;
const HTTP_SAMPLE_EVERY: u64 = 5;

/// `ApiTimingRecord`. Field order is the order Node's `record({ … })`
/// literal writes it — `at, route, method, durationMs, status[, error]`
/// (lib/api-timing.ts:112 and the throw path at :117) — NOT the alphabetised
/// order of the TypeScript `interface`, which Biome sorts and which the wire
/// never sees.
#[derive(Serialize, Clone, Debug)]
pub struct HttpRecord {
    pub at: i64,
    pub route: String,
    pub method: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: i64,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct HttpRing {
    ring: Vec<Option<HttpRecord>>,
    write_index: usize,
    total: u64,
    slow: u64,
    sample_counter: u64,
}

fn http_ring() -> &'static Mutex<HttpRing> {
    static R: OnceLock<Mutex<HttpRing>> = OnceLock::new();
    R.get_or_init(|| {
        Mutex::new(HttpRing {
            ring: vec![None; HTTP_RING_SIZE],
            write_index: 0,
            total: 0,
            slow: 0,
            sample_counter: 0,
        })
    })
}

static IN_FLIGHT: AtomicI64 = AtomicI64::new(0);

pub fn http_in_flight_enter() {
    IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
}

pub fn http_in_flight_exit() {
    IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
}

/// The sampling rule of `withApiTiming`: always record slow (≥ 100 ms) and
/// erroring (status ≥ 400) responses; record one in five of the rest, so a
/// 2-second poller cannot fill the ring. `totalSinceStart` and
/// `slowSinceStart` count RECORDED requests — that is what Node's counters
/// do too, its help text notwithstanding.
///
/// The counter advances ONLY on requests that are neither slow nor
/// erroring: Node writes `slow || erroring || ++sampleCounter % 5 === 0`,
/// and `||` short-circuits, so an always-recorded response never moves the
/// fast-request cadence. Incrementing unconditionally samples a different
/// subsequent request after every 4xx.
pub fn record_http(method: String, route: String, status: u16, elapsed: Duration) {
    let duration_ms = elapsed.as_secs_f64().mul_add(1000.0, 0.0).round() as i64;
    let slow = duration_ms >= HTTP_SLOW_THRESHOLD_MS;
    let erroring = status >= 400;
    let Ok(mut r) = http_ring().lock() else {
        return;
    };
    if !(slow || erroring) {
        r.sample_counter += 1;
        if r.sample_counter % HTTP_SAMPLE_EVERY != 0 {
            return;
        }
    }
    let rec = HttpRecord {
        at: now_ms(),
        route,
        method,
        duration_ms,
        status,
        error: None,
    };
    let idx = r.write_index % HTTP_RING_SIZE;
    r.ring[idx] = Some(rec);
    r.write_index += 1;
    r.total += 1;
    if slow {
        r.slow += 1;
    }
}

/// `HttpMetrics`, key order as in the envelope.
#[derive(Serialize, Clone, Debug)]
pub struct HttpSnapshot {
    #[serde(rename = "inFlight")]
    pub in_flight: i64,
    #[serde(rename = "thresholdMs")]
    pub threshold_ms: i64,
    #[serde(rename = "totalSinceStart")]
    pub total_since_start: u64,
    #[serde(rename = "slowSinceStart")]
    pub slow_since_start: u64,
    pub recent: Vec<HttpRecord>,
}

pub fn http_snapshot(limit: usize) -> HttpSnapshot {
    let (total, slow, recent) = match http_ring().lock() {
        Ok(r) => (
            r.total,
            r.slow,
            ring_oldest_first(&r.ring, r.write_index, limit),
        ),
        Err(_) => (0, 0, Vec::new()),
    };
    HttpSnapshot {
        in_flight: IN_FLIGHT.load(Ordering::Relaxed),
        threshold_ms: HTTP_SLOW_THRESHOLD_MS,
        total_since_start: total,
        slow_since_start: slow,
        recent,
    }
}

/// `clearApiTimings` — for the DELETE port, as above.
#[cfg_attr(not(test), allow(dead_code))]
pub fn clear_http() {
    if let Ok(mut r) = http_ring().lock() {
        r.ring.iter_mut().for_each(|s| *s = None);
        r.write_index = 0;
        r.total = 0;
        r.slow = 0;
        r.sample_counter = 0;
    }
}

/// `getRecentApiTimings` / `getRecentSlowQueries`: the last `limit` live
/// slots, OLDEST first, regardless of where the ring has wrapped.
fn ring_oldest_first<T: Clone>(ring: &[Option<T>], write_index: usize, limit: usize) -> Vec<T> {
    let size = ring.len();
    let wrapped = write_index >= size;
    let start = if wrapped { write_index % size } else { 0 };
    let live = if wrapped { size } else { write_index };
    let want = limit.min(live);
    let mut out = Vec::with_capacity(want);
    for i in (live - want)..live {
        if let Some(rec) = &ring[(start + i) % size] {
            out.push(rec.clone());
        }
    }
    out
}

// ── Slow queries ─────────────────────────────────────────────────────

/// `SLOW_QUERY_THRESHOLD_MS`, `SLOW_QUERY_RING_SIZE`, `SLOW_QUERY_SQL_MAX_LEN`.
pub const SLOW_QUERY_THRESHOLD_MS: f64 = 50.0;
pub const SLOW_QUERY_RING_SIZE: usize = 200;
const SLOW_QUERY_SQL_MAX_LEN: usize = 240;

/// `SlowQueryRecord`, in the key order Node's `recordSlowQuery({ … })`
/// literal writes — `sql, durationMs, method, paramCount, at`.
///
/// Three fields say something different here, and each is unavoidable:
/// `method` is what produced the timing — Node names the better-sqlite3
/// call (`all` / `get` / `run` / `iterate`), while SQLite's profile hook
/// sees statements, not calls, so every record says `"statement"`;
/// `paramCount` counts `?` placeholders in the SQL, where Node counts bound
/// arguments; and `durationMs` carries whole milliseconds, because
/// `sqlite3_profile`'s nanosecond argument is documented as having only
/// millisecond resolution ("the six least significant digits … are
/// meaningless"), where Node's `performance.now()` gives two decimals.
#[derive(Serialize, Clone, Debug)]
pub struct SlowQueryRecord {
    pub sql: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: Value,
    pub method: &'static str,
    #[serde(rename = "paramCount")]
    pub param_count: usize,
    pub at: i64,
}

struct SlowRing {
    ring: Vec<Option<SlowQueryRecord>>,
    write_index: usize,
    total: u64,
}

fn slow_ring() -> &'static Mutex<SlowRing> {
    static R: OnceLock<Mutex<SlowRing>> = OnceLock::new();
    R.get_or_init(|| {
        Mutex::new(SlowRing {
            ring: vec![None; SLOW_QUERY_RING_SIZE],
            write_index: 0,
            total: 0,
        })
    })
}

/// The `sqlite3_profile` callback. A plain `fn`, as rusqlite requires — no
/// captured state, hence the statics. Runs on whichever thread executed
/// the statement, inside SQLite's call, so it does the minimum.
pub fn on_statement_profiled(sql: &str, elapsed: Duration) {
    if !PROFILING_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let ms = elapsed.as_secs_f64() * 1000.0;
    if ms < SLOW_QUERY_THRESHOLD_MS {
        return;
    }
    let truncated = if crate::jsstr::js_length(sql) > SLOW_QUERY_SQL_MAX_LEN {
        format!(
            "{}…",
            crate::jsstr::js_slice_prefix(sql, SLOW_QUERY_SQL_MAX_LEN - 1)
        )
    } else {
        sql.to_string()
    };
    let rec = SlowQueryRecord {
        sql: truncated,
        duration_ms: js_number((ms * 100.0).round() / 100.0),
        method: "statement",
        param_count: sql.matches('?').count(),
        at: now_ms(),
    };
    if let Ok(mut r) = slow_ring().lock() {
        let idx = r.write_index % SLOW_QUERY_RING_SIZE;
        r.ring[idx] = Some(rec);
        r.write_index += 1;
        r.total += 1;
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct SlowQueriesSnapshot {
    #[serde(rename = "thresholdMs")]
    pub threshold_ms: i64,
    #[serde(rename = "totalSinceStart")]
    pub total_since_start: u64,
    #[serde(rename = "profilingEnabled")]
    pub profiling_enabled: bool,
    pub recent: Vec<SlowQueryRecord>,
}

/// `profilingEnabled` — on unless the runtime POST turned it off.
static PROFILING_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// `setProfilingEnabled`.
pub fn set_profiling_enabled(enabled: bool) {
    PROFILING_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn slow_queries_snapshot(limit: usize) -> SlowQueriesSnapshot {
    let (total, recent) = match slow_ring().lock() {
        Ok(r) => (r.total, ring_oldest_first(&r.ring, r.write_index, limit)),
        Err(_) => (0, Vec::new()),
    };
    SlowQueriesSnapshot {
        threshold_ms: SLOW_QUERY_THRESHOLD_MS as i64,
        total_since_start: total,
        profiling_enabled: PROFILING_ENABLED.load(Ordering::Relaxed),
        recent,
    }
}

/// `clearSlowQueryRing` — for the DELETE port, as above.
#[cfg_attr(not(test), allow(dead_code))]
pub fn clear_slow_queries() {
    if let Ok(mut r) = slow_ring().lock() {
        r.ring.iter_mut().for_each(|s| *s = None);
        r.write_index = 0;
        r.total = 0;
    }
}

// ── Error log ────────────────────────────────────────────────────────

/// `MAX_ENTRIES`, `MAX_MESSAGE_LEN` in lib/error-log-ring.ts.
pub const ERROR_LOG_CAPACITY: usize = 200;
const ERROR_MESSAGE_MAX_LEN: usize = 4 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct ErrorLogEntry {
    pub at: i64,
    pub level: &'static str,
    pub message: String,
    pub truncated: bool,
}

fn error_ring() -> &'static Mutex<Vec<ErrorLogEntry>> {
    static R: OnceLock<Mutex<Vec<ErrorLogEntry>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Vec::with_capacity(ERROR_LOG_CAPACITY)))
}

fn push_entry(level: &'static str, raw: &str) {
    let truncated = crate::jsstr::js_length(raw) > ERROR_MESSAGE_MAX_LEN;
    let message = if truncated {
        format!(
            "{}… (truncated)",
            crate::jsstr::js_slice_prefix(raw, ERROR_MESSAGE_MAX_LEN)
        )
    } else {
        raw.to_string()
    };
    if let Ok(mut ring) = error_ring().lock() {
        ring.push(ErrorLogEntry {
            at: now_ms(),
            level,
            message,
            truncated,
        });
        if ring.len() > ERROR_LOG_CAPACITY {
            let excess = ring.len() - ERROR_LOG_CAPACITY;
            ring.drain(0..excess);
        }
    }
}

/// `console.warn` with the ring in front of it.
pub fn log_warn(message: impl AsRef<str>) {
    log::warn!("{}", message.as_ref());
    push_entry("warn", message.as_ref());
}

/// `console.error` with the ring in front of it.
pub fn log_error(message: impl AsRef<str>) {
    log::error!("{}", message.as_ref());
    push_entry("error", message.as_ref());
}

#[derive(Serialize, Clone, Debug)]
pub struct ErrorLogSnapshot {
    pub entries: Vec<ErrorLogEntry>,
    pub capacity: usize,
}

/// `snapshotErrorLog({ limit })`: newest first, `limit` clamped to
/// `1..=capacity`, `None` meaning the whole ring.
pub fn error_log_snapshot(limit: Option<i64>) -> ErrorLogSnapshot {
    let limit = limit
        .unwrap_or(ERROR_LOG_CAPACITY as i64)
        .clamp(1, ERROR_LOG_CAPACITY as i64) as usize;
    let entries = match error_ring().lock() {
        Ok(ring) => ring.iter().rev().take(limit).cloned().collect(),
        Err(_) => Vec::new(),
    };
    ErrorLogSnapshot {
        entries,
        capacity: ERROR_LOG_CAPACITY,
    }
}

/// `clearErrorLog` — the DELETE on `/api/diagnostics/errors`, a write route.
#[cfg_attr(not(test), allow(dead_code))]
pub fn clear_error_log() {
    if let Ok(mut ring) = error_ring().lock() {
        ring.clear();
    }
}

/// Requests refused by the inbound limiter since start — bumped by
/// `ratelimit.rs`, read by the envelope's `rateLimiter` section.
pub static RATE_LIMIT_DENIALS: AtomicU64 = AtomicU64::new(0);

// Tests that reset the process-global HTTP ring hold this for their
// entire scenario, including the timing middleware test.
#[cfg(test)]
pub(super) static HTTP_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_sampling_records_slow_errors_and_every_fifth_fast_request() {
        let _guard = HTTP_TEST_LOCK.lock().unwrap();
        clear_http();
        for _ in 0..4 {
            record_http(
                "GET".into(),
                "/api/health".into(),
                200,
                Duration::from_millis(1),
            );
        }
        assert_eq!(http_snapshot(200).total_since_start, 0);
        record_http(
            "GET".into(),
            "/api/health".into(),
            200,
            Duration::from_millis(1),
        ); // 5th
        assert_eq!(http_snapshot(200).total_since_start, 1);
        record_http(
            "GET".into(),
            "/api/apps".into(),
            404,
            Duration::from_millis(1),
        );
        record_http(
            "GET".into(),
            "/api/apps".into(),
            200,
            Duration::from_millis(150),
        );
        let s = http_snapshot(200);
        assert_eq!(s.total_since_start, 3);
        assert_eq!(s.slow_since_start, 1, "a 404 is recorded but is not slow");
        assert_eq!(s.threshold_ms, 100);
        assert_eq!(s.recent.len(), 3);
        assert_eq!(s.recent[0].status, 200);
        assert_eq!(s.recent[2].duration_ms, 150);
        assert_eq!(http_snapshot(1).recent.len(), 1);
        assert_eq!(
            http_snapshot(1).recent[0].duration_ms,
            150,
            "newest survives a limit"
        );

        // The divergence this function did not previously reach: an
        // always-recorded response must NOT advance the fast cadence, so
        // it still takes five more fast requests to sample one.
        for _ in 0..4 {
            record_http(
                "GET".into(),
                "/api/health".into(),
                200,
                Duration::from_millis(1),
            );
        }
        assert_eq!(
            http_snapshot(200).total_since_start,
            3,
            "four more fast requests, none sampled"
        );
        record_http(
            "GET".into(),
            "/api/health".into(),
            200,
            Duration::from_millis(1),
        );
        assert_eq!(
            http_snapshot(200).total_since_start,
            4,
            "the fifth fast one is"
        );
        clear_http();
    }

    #[test]
    fn http_record_serialises_in_nodes_literal_order() {
        let _guard = HTTP_TEST_LOCK.lock().unwrap();
        clear_http();
        record_http(
            "GET".into(),
            "/api/apps".into(),
            500,
            Duration::from_millis(7),
        );
        let s = http_snapshot(1);
        let at = s.recent[0].at;
        assert_eq!(
            serde_json::to_string(&s.recent[0]).unwrap(),
            format!(
                r#"{{"at":{at},"route":"/api/apps","method":"GET","durationMs":7,"status":500}}"#
            )
        );
        clear_http();
    }

    #[test]
    fn slow_queries_keep_only_statements_over_the_threshold() {
        clear_slow_queries();
        on_statement_profiled("SELECT 1", Duration::from_millis(3));
        assert_eq!(slow_queries_snapshot(10).total_since_start, 0);
        on_statement_profiled(
            "SELECT * FROM apps WHERE id = ? AND x = ?",
            Duration::from_micros(75_432),
        );
        let s = slow_queries_snapshot(10);
        assert_eq!(s.total_since_start, 1);
        assert_eq!(s.threshold_ms, 50);
        assert!(s.profiling_enabled);
        assert_eq!(s.recent[0].param_count, 2);
        assert_eq!(s.recent[0].method, "statement");
        assert_eq!(s.recent[0].duration_ms, js_number(75.43));
        // Truncation at 240 UTF-16 units with the ellipsis Node appends.
        let long = "x".repeat(300);
        on_statement_profiled(&long, Duration::from_millis(60));
        let s = slow_queries_snapshot(10);
        assert_eq!(s.recent[1].sql.chars().count(), 240);
        assert!(s.recent[1].sql.ends_with('…'));
        clear_slow_queries();
    }

    #[test]
    fn error_log_is_newest_first_capped_and_clamps_the_limit() {
        // The ring is process-wide and `db.rs::warn` now feeds it, so this
        // test tags its own entries rather than assuming it is the only
        // writer on the test binary's threads.
        const TAG: &str = "pt-diag-ring-test-";
        clear_error_log();
        for i in 0..205 {
            push_entry(
                if i % 2 == 0 { "warn" } else { "error" },
                &format!("{TAG}{i}"),
            );
        }
        let all = error_log_snapshot(None);
        assert_eq!(all.capacity, 200);
        assert_eq!(all.entries.len(), 200);
        let mine: Vec<&str> = all
            .entries
            .iter()
            .filter(|e| e.message.starts_with(TAG))
            .map(|e| e.message.as_str())
            .collect();
        assert_eq!(mine[0], format!("{TAG}204"), "newest first");
        assert_eq!(
            *mine.last().unwrap(),
            format!("{TAG}{}", 205 - mine.len()),
            "the oldest survivor is exactly what the cap left"
        );
        assert_eq!(
            error_log_snapshot(Some(0)).entries.len(),
            1,
            "Math.max(1, …)"
        );
        assert_eq!(error_log_snapshot(Some(-7)).entries.len(), 1);
        assert_eq!(error_log_snapshot(Some(3)).entries.len(), 3);
        assert_eq!(error_log_snapshot(Some(9_999)).entries.len(), 200);
        push_entry("error", &"y".repeat(5000));
        let top = &error_log_snapshot(Some(1)).entries[0];
        assert!(top.truncated);
        assert!(top.message.ends_with("… (truncated)"));
        clear_error_log();
    }

    #[test]
    fn lock_wait_histogram_records_and_resets() {
        reset_histograms();
        assert!(lock_wait_snapshot().is_none(), "empty after reset");
        record_lock_wait(Duration::from_micros(1500));
        record_lock_wait(Duration::from_millis(3));
        let s = lock_wait_snapshot().expect("two samples");
        assert_eq!(s.samples, 2);
        assert_eq!(s.min_ms, js_number(1.5));
        assert_eq!(s.severity, "ok");
        reset_histograms();
        assert!(lock_wait_snapshot().is_none());
    }

    #[test]
    fn ring_walk_handles_wrap() {
        let mut ring: Vec<Option<u32>> = vec![None; 4];
        let mut w = 0usize;
        for v in 1..=6u32 {
            ring[w % 4] = Some(v);
            w += 1;
        }
        assert_eq!(ring_oldest_first(&ring, w, 10), vec![3, 4, 5, 6]);
        assert_eq!(ring_oldest_first(&ring, w, 2), vec![5, 6]);
        assert_eq!(ring_oldest_first(&ring, 0, 2), Vec::<u32>::new());
    }
}

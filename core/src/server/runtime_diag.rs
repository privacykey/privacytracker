//! The runtime-diagnostics envelope, as this backend emits it — the
//! contract in `lib/runtime-diagnostics-envelope.ts`, validated on both
//! backends by `scripts/parity/diagnostics-envelope.mjs`.
//!
//! Sections shared with Node keep its names and units. Sections that name
//! the backend carry a `kind`: `heap.kind = "rust-allocator"` (the counting
//! global allocator in `crate::alloc`) and `scheduler.kind = "tokio"`
//! (worker/task counts from the runtime's stable metrics, lag from the
//! sampler in `diag.rs`). Sections this backend has no counterpart for —
//! Node's db-worker thread, the scraper until Phase 3 — are `null`, not
//! empty objects and not zeros. And the three `sqlite` sections Node leaves
//! null are filled here, from `sqlite3_memory_used`, `sqlite3_db_status`
//! and the connection-mutex wait — the numbers the shape exists to carry.

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use super::diag::{self, HttpSnapshot, SlowQueriesSnapshot, HTTP_RING_SIZE, SLOW_QUERY_RING_SIZE};
use super::histogram::LagSnapshot;
use super::sysproc::{mb, process_metrics, ProcessMetrics};
use super::AppState;
use crate::jsdate::js_iso_string;
use crate::jsnum::js_number;

pub const SCHEMA_VERSION: u32 = 2;

#[derive(Serialize, Clone, Debug)]
pub struct AllocatorHeap {
    pub kind: &'static str,
    #[serde(rename = "allocatedMb")]
    pub allocated_mb: Value,
    #[serde(rename = "peakMb")]
    pub peak_mb: Value,
    #[serde(rename = "liveAllocations")]
    pub live_allocations: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct SqliteMemory {
    #[serde(rename = "usedMb")]
    pub used_mb: Value,
    #[serde(rename = "highwaterMb")]
    pub highwater_mb: Value,
    #[serde(rename = "pageCacheMb")]
    pub page_cache_mb: Value,
    #[serde(rename = "schemaKb")]
    pub schema_kb: Value,
    #[serde(rename = "statementsKb")]
    pub statements_kb: Value,
}

#[derive(Serialize, Clone, Debug)]
pub struct SqliteCache {
    pub hits: i64,
    pub misses: i64,
    pub writes: i64,
    pub spills: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct SqliteMetrics {
    pub engine: &'static str,
    pub version: String,
    #[serde(rename = "connectionModel")]
    pub connection_model: &'static str,
    pub memory: Option<SqliteMemory>,
    pub cache: Option<SqliteCache>,
    #[serde(rename = "lockWait")]
    pub lock_wait: Option<LagSnapshot>,
}

/// `sqlite3_db_status(db, op, &cur, &hiwtr, 0)` → current value.
fn db_status(conn: &Connection, op: i32) -> Option<i64> {
    let mut cur: i32 = 0;
    let mut hi: i32 = 0;
    // SAFETY: `handle()` is the live connection; sqlite3_db_status only
    // reads counters and writes the two out-params.
    let rc = unsafe { rusqlite::ffi::sqlite3_db_status(conn.handle(), op, &mut cur, &mut hi, 0) };
    if rc == rusqlite::ffi::SQLITE_OK {
        Some(cur as i64)
    } else {
        None
    }
}

fn kb(bytes: i64) -> Value {
    js_number((bytes as f64 / 1024.0 * 100.0).round() / 100.0)
}

/// The `sqlite` section: engine identity plus the counters better-sqlite3
/// does not expose. `memory` is global to the process (one connection, so
/// it is this connection's); `cache` is per connection since open.
pub fn sqlite_metrics(conn: &Connection) -> SqliteMetrics {
    use rusqlite::ffi;
    // SAFETY: both read process-global counters; the reset flag is 0.
    let used = unsafe { ffi::sqlite3_memory_used() };
    let highwater = unsafe { ffi::sqlite3_memory_highwater(0) };
    // Whole section or nothing, as with `cache` below: the envelope's rule
    // is that what a backend cannot measure is null, never a zero a reader
    // would take for a reading.
    let memory = match (
        db_status(conn, ffi::SQLITE_DBSTATUS_CACHE_USED),
        db_status(conn, ffi::SQLITE_DBSTATUS_SCHEMA_USED),
        db_status(conn, ffi::SQLITE_DBSTATUS_STMT_USED),
    ) {
        (Some(page_cache), Some(schema), Some(statements)) => Some(SqliteMemory {
            used_mb: mb(used.max(0) as u64),
            highwater_mb: mb(highwater.max(0) as u64),
            page_cache_mb: mb(page_cache.max(0) as u64),
            schema_kb: kb(schema),
            statements_kb: kb(statements),
        }),
        _ => None,
    };
    let cache = match (
        db_status(conn, ffi::SQLITE_DBSTATUS_CACHE_HIT),
        db_status(conn, ffi::SQLITE_DBSTATUS_CACHE_MISS),
        db_status(conn, ffi::SQLITE_DBSTATUS_CACHE_WRITE),
        db_status(conn, ffi::SQLITE_DBSTATUS_CACHE_SPILL),
    ) {
        (Some(hits), Some(misses), Some(writes), Some(spills)) => Some(SqliteCache {
            hits,
            misses,
            writes,
            spills,
        }),
        _ => None,
    };
    SqliteMetrics {
        engine: "rusqlite",
        version: rusqlite::version().to_string(),
        connection_model: "single-mutex",
        memory,
        cache,
        lock_wait: diag::lock_wait_snapshot(),
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct TokioScheduler {
    pub kind: &'static str,
    pub workers: usize,
    #[serde(rename = "aliveTasks")]
    pub alive_tasks: usize,
    #[serde(rename = "globalQueueDepth")]
    pub global_queue_depth: usize,
    pub lag: Option<LagSnapshot>,
}

/// The `scheduler` section from tokio's stable runtime metrics. Every
/// handler runs on the runtime; `try_current` is used rather than
/// `current` so that calling this off one — from a plain `#[test]`, say —
/// reports zeros instead of panicking inside a diagnostics read.
pub fn scheduler_metrics() -> TokioScheduler {
    let (workers, alive_tasks, global_queue_depth) = match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            let m = h.metrics();
            (m.num_workers(), m.num_alive_tasks(), m.global_queue_depth())
        }
        Err(_) => (0, 0, 0),
    };
    TokioScheduler {
        kind: "tokio",
        workers,
        alive_tasks,
        global_queue_depth,
        lag: diag::scheduler_lag_snapshot(),
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct RateLimiterMetrics {
    #[serde(rename = "trackedKeys")]
    pub tracked_keys: usize,
    #[serde(rename = "denialsSinceStart")]
    pub denials_since_start: u64,
}

/// `RuntimeDiagnostics`, in the envelope's key order.
#[derive(Serialize, Clone, Debug)]
pub struct RuntimeDiagnostics {
    pub backend: &'static str,
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: u64,
    pub process: ProcessMetrics,
    pub heap: AllocatorHeap,
    pub sqlite: SqliteMetrics,
    pub scheduler: TokioScheduler,
    pub http: HttpSnapshot,
    #[serde(rename = "slowQueries")]
    pub slow_queries: SlowQueriesSnapshot,
    #[serde(rename = "dbWorker")]
    pub db_worker: Option<Value>,
    #[serde(rename = "scrapeActivity")]
    pub scrape_activity: Option<Value>,
    #[serde(rename = "rateLimiter")]
    pub rate_limiter: Option<RateLimiterMetrics>,
}

/// `snapshotRuntimeDiagnostics({ recentLimit })` for this process.
///
/// Takes the already-read `sqlite` section rather than the connection: it
/// is the only part that needs the database, and everything else here is
/// syscalls, atomics and histogram walks. With one connection behind one
/// mutex, holding the lock across those would serialise every other
/// handler behind a diagnostics poll — and inflate the very `lockWait`
/// number this section reports.
pub fn build(
    state: &AppState,
    sqlite: SqliteMetrics,
    recent_limit: Option<usize>,
) -> RuntimeDiagnostics {
    let (allocated, peak, live) = crate::alloc::snapshot();
    RuntimeDiagnostics {
        backend: "rust",
        schema_version: SCHEMA_VERSION,
        generated_at: js_iso_string(super::now_ms()),
        uptime_seconds: state.started_at.elapsed().as_secs_f64().round() as u64,
        process: process_metrics(),
        heap: AllocatorHeap {
            kind: "rust-allocator",
            allocated_mb: mb(allocated as u64),
            peak_mb: mb(peak as u64),
            live_allocations: live as u64,
        },
        sqlite,
        scheduler: scheduler_metrics(),
        http: diag::http_snapshot(recent_limit.unwrap_or(HTTP_RING_SIZE)),
        slow_queries: diag::slow_queries_snapshot(recent_limit.unwrap_or(SLOW_QUERY_RING_SIZE)),
        // No worker thread: one connection, one mutex.
        db_worker: None,
        // No scraper until Phase 3.
        scrape_activity: None,
        rate_limiter: Some(RateLimiterMetrics {
            tracked_keys: state.rate_limiter.tracked_keys(),
            denials_since_start: diag::RATE_LIMIT_DENIALS
                .load(std::sync::atomic::Ordering::Relaxed),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_counters_come_off_a_live_connection() {
        let conn = crate::db::open_and_migrate(std::path::Path::new(":memory:")).unwrap();
        // A few reads so the page cache has been hit.
        for _ in 0..3 {
            let _: i64 = conn
                .query_row("SELECT count(*) FROM apps", [], |r| r.get(0))
                .unwrap();
        }
        let s = sqlite_metrics(&conn);
        assert_eq!(s.engine, "rusqlite");
        assert!(s.version.starts_with("3."), "{}", s.version);
        assert_eq!(s.connection_model, "single-mutex");
        let m = s.memory.as_ref().expect("memory counters");
        assert!(m.used_mb.as_f64().unwrap() > 0.0);
        assert!(m.highwater_mb.as_f64().unwrap() >= m.used_mb.as_f64().unwrap());
        assert!(m.schema_kb.as_f64().unwrap() > 0.0, "the schema is loaded");
        let c = s.cache.as_ref().expect("cache counters");
        assert!(c.hits > 0, "reads hit the page cache: {c:?}");
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.starts_with("{\"engine\":\"rusqlite\",\"version\":"));
        assert!(json.contains("\"lockWait\":"));
    }

    /// The envelope's own shape: the top-level key ORDER the JS validator
    /// walks, the backend tag, and the two sections this backend reports as
    /// null rather than as empty objects.
    #[tokio::test]
    async fn the_envelope_has_the_contracted_shape() {
        use std::sync::{Arc, Mutex};
        let conn = crate::db::open_and_migrate(std::path::Path::new(":memory:")).unwrap();
        let sqlite = sqlite_metrics(&conn);
        let state = AppState {
            conn: Arc::new(Mutex::new(conn)),
            rate_limiter: Arc::new(super::super::ratelimit::RateLimiter::new()),
            started_at: std::time::Instant::now(),
            bound_port: 0,
        };
        let env = build(&state, sqlite, Some(0));
        assert_eq!(env.backend, "rust");
        assert_eq!(env.schema_version, SCHEMA_VERSION);
        assert_eq!(env.heap.kind, "rust-allocator");
        assert_eq!(env.scheduler.kind, "tokio");
        assert!(env.db_worker.is_none(), "no worker thread");
        assert!(env.scrape_activity.is_none(), "no scraper yet");
        assert!(env.rate_limiter.is_some());
        assert!(env.http.recent.is_empty(), "recentLimit 0 drops the rows");

        let keys: Vec<&str> = serde_json::to_value(&env)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .map(|k| Box::leak(k.clone().into_boxed_str()) as &str)
            .collect();
        assert_eq!(
            keys,
            [
                "backend",
                "schemaVersion",
                "generatedAt",
                "uptimeSeconds",
                "process",
                "heap",
                "sqlite",
                "scheduler",
                "http",
                "slowQueries",
                "dbWorker",
                "scrapeActivity",
                "rateLimiter",
            ]
        );
    }
}

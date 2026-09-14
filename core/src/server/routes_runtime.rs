//! The process-introspection reads: `GET /api/diagnostics/runtime`,
//! `GET /api/desktop/diagnostics` and `GET /api/diagnostics/errors`.
//!
//! These are the three routes that could not be PORTED — they describe the
//! serving process — and were re-specified instead (C1, PR #241): one
//! backend-tagged envelope both servers emit, validated on each side by the
//! parity harness rather than byte-compared across backends. The DELETE and
//! POST that clear rings and flip profiling on the Node route are write
//! routes and wait for the writers phase.

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    response::Response,
};
use serde::Serialize;
use serde_json::Value;

use super::deployment::redact_home_dir;
use super::diag::{error_log_snapshot, ErrorLogSnapshot};
use super::json::json_ok;
use super::osinfo::{node_arch, uname_parts};
use super::runtime_diag::{self, sqlite_metrics, RuntimeDiagnostics};
use super::settings::get_setting_with;
use super::sysproc::{cpu_count, host_memory};
use super::{data_layout, AppState};
use crate::jsdate::js_iso_string;
use crate::jsnum::js_parse_int;

pub async fn runtime(State(state): State<AppState>) -> Response {
    // The connection is held for the SQLite counters and nothing else —
    // see `runtime_diag::build`.
    let sqlite = {
        let conn = state.db();
        sqlite_metrics(&conn)
    };
    json_ok(&runtime_diag::build(&state, sqlite, None))
}

// ── /api/desktop/diagnostics ─────────────────────────────────────────
// Node's payload, key for key, in its snake_case: the embedded envelope is
// the same object the live route serves with every ring capped at 20 rows,
// because the whole blob is pasted into GitHub issues. Every read is
// best-effort — the Tauri report renders whatever arrives.

#[derive(Serialize)]
struct DesktopRuntime {
    node: String,
    platform: &'static str,
    arch: &'static str,
    pid: u32,
    uptime_seconds: u64,
}

#[derive(Serialize)]
struct DesktopHost {
    os_release: String,
    os_type: String,
    total_mem_mb: Value,
    free_mem_mb: Value,
    cpu_count: Value,
}

#[derive(Serialize)]
struct DesktopScheduler {
    #[serde(rename = "scheduleMode")]
    schedule_mode: String,
    #[serde(rename = "lastAutoSync")]
    last_auto_sync: Option<i64>,
    #[serde(rename = "syncRunning")]
    sync_running: bool,
}

#[derive(Serialize)]
struct RunnerState {
    running: bool,
    has_state: bool,
}

#[derive(Serialize)]
struct BulkRunners {
    wayback: RunnerState,
    sync: RunnerState,
    policy: RunnerState,
}

#[derive(Serialize)]
struct DesktopDiagnostics {
    generated_at: String,
    runtime: DesktopRuntime,
    host: DesktopHost,
    runtime_diagnostics: RuntimeDiagnostics,
    scheduler: DesktopScheduler,
    bulk_runners: BulkRunners,
    db: Value,
}

/// `readLastSync`: `parseInt(last_auto_sync)` finite and positive, else null.
fn read_last_sync(conn: &rusqlite::Connection) -> rusqlite::Result<DesktopScheduler> {
    let raw = get_setting_with(conn, "last_auto_sync", "0")?;
    Ok(DesktopScheduler {
        schedule_mode: get_setting_with(conn, "sync_schedule", "manual")?,
        last_auto_sync: js_parse_int(&raw).filter(|n| *n > 0),
        sync_running: get_setting_with(conn, "sync_running", "false")? == "true",
    })
}

/// `readBulkRunners`: the mutex flag and whether a state blob exists, for
/// each of the three crash-safe runners.
fn read_bulk_runners(conn: &rusqlite::Connection) -> rusqlite::Result<BulkRunners> {
    let runner = |mutex: &str, blob: &str| -> rusqlite::Result<RunnerState> {
        Ok(RunnerState {
            running: get_setting_with(conn, mutex, "false")? == "true",
            has_state: !get_setting_with(conn, blob, "")?.is_empty(),
        })
    };
    Ok(BulkRunners {
        wayback: runner("wayback_import_running", "wayback_bulk_state")?,
        sync: runner("sync_running", "sync_bulk_state")?,
        policy: runner("policy_sync_running", "policy_bulk_state")?,
    })
}

/// `readDbStats`: counts plus the (home-redacted) path and size of the
/// database file; on any failure `{ error: String(err) }`, as in Node.
fn read_db_stats(conn: &rusqlite::Connection) -> Value {
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0));
    let stats = (|| -> rusqlite::Result<Value> {
        let apps = count("SELECT COUNT(*) AS c FROM apps")?;
        let snapshots = count("SELECT COUNT(*) AS c FROM privacy_snapshots")?;
        let unread = count("SELECT COUNT(*) AS c FROM notifications WHERE read = 0")?;
        let layout = data_layout();
        let size = std::fs::metadata(&layout.db_path).ok().map(|m| m.len());
        Ok(serde_json::json!({
            "apps": apps,
            "snapshots": snapshots,
            "unread_notifications": unread,
            "db_path": redact_home_dir(&layout.db_path.display().to_string()),
            "db_size_bytes": size,
        }))
    })();
    match stats {
        Ok(v) => v,
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

pub async fn desktop_diagnostics(State(state): State<AppState>) -> Response {
    // Everything that needs the database, read under one lock; the host
    // syscalls and the envelope assembly then run without it.
    let (sqlite, scheduler, bulk_runners, db) = {
        let conn = state.db();
        let idle_runner = || RunnerState {
            running: false,
            has_state: false,
        };
        (
            sqlite_metrics(&conn),
            read_last_sync(&conn).unwrap_or(DesktopScheduler {
                schedule_mode: "manual".into(),
                last_auto_sync: None,
                sync_running: false,
            }),
            read_bulk_runners(&conn).unwrap_or(BulkRunners {
                wayback: idle_runner(),
                sync: idle_runner(),
                policy: idle_runner(),
            }),
            read_db_stats(&conn),
        )
    };
    let (sysname, release) = uname_parts();
    let mem = host_memory();
    let mb_of = |b: Option<u64>| {
        b.map(|b| Value::from((b as f64 / 1024.0 / 1024.0).round() as i64))
            .unwrap_or(Value::Null)
    };
    let body = DesktopDiagnostics {
        generated_at: js_iso_string(super::now_ms()),
        runtime: DesktopRuntime {
            // `process.version` — this server's identity stands in, as it
            // does for `app.node` in the deployment diagnostics.
            node: format!("pt-core {}", env!("CARGO_PKG_VERSION")),
            // `process.platform`: "darwin" / "linux" / "win32".
            platform: match std::env::consts::OS {
                "macos" => "darwin",
                "windows" => "win32",
                other => other,
            },
            arch: node_arch(),
            pid: std::process::id(),
            uptime_seconds: state.started_at.elapsed().as_secs_f64().round() as u64,
        },
        host: DesktopHost {
            os_release: release,
            os_type: sysname,
            total_mem_mb: mb_of(mem.total_bytes),
            free_mem_mb: mb_of(mem.free_bytes),
            cpu_count: cpu_count().map(Value::from).unwrap_or(Value::Null),
        },
        runtime_diagnostics: runtime_diag::build(&state, sqlite, Some(20)),
        scheduler,
        bulk_runners,
        db,
    };
    json_ok(&body)
}

// ── /api/diagnostics/errors ──────────────────────────────────────────

/// `limitRaw ? parseInt(limitRaw, 10) : undefined`, then
/// `Number.isFinite(limit) ? limit : undefined` — an empty or non-numeric
/// `limit` means "the whole ring"; the clamp to `1..=200` happens in the
/// snapshot.
///
/// A `HashMap` extractor, like every other query-reading route here: a
/// derived struct rejects a repeated `?limit=1&limit=5` with axum's 400,
/// where `searchParams.get` just takes one and answers 200.
pub async fn errors(Query(q): Query<HashMap<String, String>>) -> Response {
    let limit = q
        .get("limit")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .and_then(js_parse_int);
    let body: ErrorLogSnapshot = error_log_snapshot(limit);
    json_ok(&body)
}

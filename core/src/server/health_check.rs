//! Phase 4, batch 5a: `runHealthCheck` from lib/health-check.ts — the
//! periodic check and its non-destructive self-heal. Takes the
//! `health_check_running` lock (five-minute stale takeover), clears the
//! job locks that are provably dead, checkpoints a WAL past its cap,
//! resets stuck policy runs, reads the database and process figures,
//! derives the warnings and the status, persists the result and records
//! the one activity row. Every write goes through the writer so the
//! replay sees the stream Node's recorder saw.
//!
//! The database and process figures are this process's own (the WAL and
//! file sizes, RSS, the scheduler's lag); the oracle replay blanks them
//! on both sides and compares everything they feed — the heals, the
//! warnings that derive from rows, the status — exactly.
use super::{
    activity_log::record_activity,
    diagnostics::{run_integrity_check, snapshot_database_health},
    imports_writes::transaction,
    json::js_json_vec,
    sync_runner, sysproc, wayback_runner,
    writes::Cx,
};
use crate::{
    jsnum::{js_number, js_to_number},
    scrape::{persist::DbAccess, Ids},
};
use serde_json::{json, Value};
use std::path::Path;

const RESULT_VERSION: i64 = 1;
const HEALTH_RUNNING_KEY: &str = "health_check_running";
const HEALTH_RUNNING_SINCE_KEY: &str = "health_check_running_since";
const HEALTH_LAST_RESULT_KEY: &str = "health_check_last_result";
const HEALTH_LAST_RUN_AT_KEY: &str = "health_check_last_run_at";
/// Self-heal the health lock if a prior run wedged it.
const HEALTH_LOCK_STALE_MS: i64 = 5 * 60_000;
const BYTES_PER_MB: f64 = 1024.0 * 1024.0;
const HOUR_MS: f64 = 60.0 * 60_000.0;
const HEAP_FRACTION_WARN: f64 = 0.85;
const FRAGMENTATION_UTIL_WARN: i64 = 50;
const FREELIST_WARN: i64 = 1000;
const RESET_STUCK_POLICY_RUNS: &str = "UPDATE privacy_policy_analyses SET run_status = 'idle'\n              WHERE run_status = 'running'\n                AND run_started_at IS NOT NULL\n                AND run_started_at < ?";
const CLEAR_STATE: &str = "DELETE FROM app_settings WHERE key = ?";
const POLICY_STATE_KEY: &str = "policy_bulk_state";
const POLICY_MUTEX_KEY: &str = "policy_sync_running";

// ── Config ───────────────────────────────────────────────────────────

struct Config {
    wal_checkpoint_bytes: f64,
    stuck_run_ms: f64,
    stale_lock_ms: f64,
    integrity_enabled: bool,
    integrity_max_bytes: f64,
    rss_warn_mb: f64,
}

/// `readNum`: an absent or empty setting is the default, as is one
/// `Number` cannot make finite.
fn read_num(cx: &Cx, key: &str, default: f64) -> f64 {
    let raw = cx.get(key, "");
    if raw.is_empty() {
        return default;
    }
    let n = js_to_number(&Value::String(raw));
    if n.is_finite() {
        n
    } else {
        default
    }
}

fn read_config(cx: &Cx) -> Config {
    Config {
        wal_checkpoint_bytes: read_num(cx, "health_check_wal_checkpoint_mb", 64.0) * BYTES_PER_MB,
        stuck_run_ms: read_num(cx, "health_check_stuck_run_hours", 6.0) * HOUR_MS,
        stale_lock_ms: read_num(cx, "health_check_stale_lock_hours", 6.0) * HOUR_MS,
        integrity_enabled: cx.get("health_check_integrity_enabled", "false") == "true",
        integrity_max_bytes: read_num(cx, "health_check_integrity_max_mb", 256.0) * BYTES_PER_MB,
        rss_warn_mb: read_num(cx, "health_check_rss_warn_mb", 2048.0),
    }
}

// ── Lock ─────────────────────────────────────────────────────────────

fn acquire_health_lock(cx: &mut Cx) -> Result<bool, String> {
    if cx.get(HEALTH_RUNNING_KEY, "false") == "true" {
        let since = crate::jsnum::js_parse_int(&cx.get(HEALTH_RUNNING_SINCE_KEY, "0")).unwrap_or(0);
        let stale = since > 0 && cx.now - since > HEALTH_LOCK_STALE_MS;
        if !stale {
            return Ok(false);
        }
        super::diag::log_warn("[HealthCheck] Clearing stale health-check lock");
    }
    cx.set(HEALTH_RUNNING_KEY, "true")?;
    cx.set(HEALTH_RUNNING_SINCE_KEY, &cx.now.to_string())?;
    Ok(true)
}

// ── The bulk-lock probes ─────────────────────────────────────────────

fn policy_mutex_held(cx: &Cx) -> bool {
    cx.get(POLICY_MUTEX_KEY, "") == "true"
}

/// `readPolicyBulkState`: absent, unparseable, the wrong version or a
/// missing field all read as nothing.
fn read_policy_state(cx: &Cx) -> Option<Value> {
    let raw = cx.get(POLICY_STATE_KEY, "");
    if raw.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    if !parsed.is_object()
        || parsed["version"] != json!(1)
        || !parsed["runId"].is_string()
        || !parsed["queue"].is_array()
    {
        return None;
    }
    Some(parsed)
}

fn queue_has_pending(state: &Value) -> bool {
    state["queue"].as_array().is_some_and(|q| {
        q.iter().any(|e| {
            matches!(
                e["status"].as_str().unwrap_or(""),
                "pending" | "in_progress"
            )
        })
    })
}

/// `Date.now() - state.updatedAt > staleLockMs`, false when `updatedAt`
/// is not a number (`NaN > n`) or the clock ran backwards.
fn silent_too_long(now: i64, updated_at: Option<f64>, stale_lock_ms: f64) -> bool {
    updated_at.is_some_and(|u| (now as f64) - u > stale_lock_ms)
}

/// Which bulk lock a probe stands for, and how its state is read.
#[derive(Clone, Copy)]
enum Probe {
    Sync,
    Wayback,
    Policy,
}

impl Probe {
    fn kind(self) -> &'static str {
        match self {
            Probe::Sync => "stale_lock_sync",
            Probe::Wayback => "stale_lock_wayback",
            Probe::Policy => "stale_lock_policy",
        }
    }

    /// `bulkLockIsDead`: held, and provably without a live runner — no
    /// state, no pending work, or no progress in longer than the stale
    /// margin — and never a paused or cancel-requested queue.
    fn is_dead(self, cx: &Cx, stale_lock_ms: f64) -> bool {
        match self {
            Probe::Sync => {
                if !sync_runner::mutex_held(cx) {
                    return false;
                }
                match sync_runner::read_state(cx) {
                    None => true,
                    Some(state) => {
                        sync_runner::summarise(&state).remaining == 0
                            || silent_too_long(cx.now, Some(state.updated_at as f64), stale_lock_ms)
                    }
                }
            }
            Probe::Wayback => {
                if !wayback_runner::mutex_held(cx) {
                    return false;
                }
                let state = wayback_runner::read_bulk_state(cx);
                if wayback_runner::is_paused(state.as_ref())
                    || wayback_runner::is_cancel_requested(state.as_ref())
                {
                    return false;
                }
                match state {
                    None => true,
                    Some(state) => {
                        !wayback_runner::has_pending_work(Some(&state))
                            || silent_too_long(cx.now, state["updatedAt"].as_f64(), stale_lock_ms)
                    }
                }
            }
            Probe::Policy => {
                if !policy_mutex_held(cx) {
                    return false;
                }
                match read_policy_state(cx) {
                    None => true,
                    Some(state) => {
                        !queue_has_pending(&state)
                            || silent_too_long(cx.now, state["updatedAt"].as_f64(), stale_lock_ms)
                    }
                }
            }
        }
    }

    /// `release()` then `clear()`, in the one transaction the check
    /// wraps them in.
    fn release_and_clear(self, cx: &mut Cx) -> Result<(), String> {
        match self {
            Probe::Sync => {
                sync_runner::release_mutex(cx)?;
                sync_runner::clear_state(cx)
            }
            Probe::Wayback => {
                wayback_runner::release_mutex(cx)?;
                wayback_runner::clear_bulk_state(cx)
            }
            Probe::Policy => {
                cx.set(POLICY_MUTEX_KEY, "false")?;
                cx.w.run(CLEAR_STATE, vec![json!(POLICY_STATE_KEY)])
                    .map(drop)
            }
        }
    }
}

/// `healBulkLocks`: the three job locks, then the import-queue lock by
/// its own age rule.
fn heal_bulk_locks(cx: &mut Cx, stale_lock_ms: f64, heals: &mut Vec<Value>) {
    for probe in [Probe::Sync, Probe::Wayback, Probe::Policy] {
        if !probe.is_dead(cx, stale_lock_ms) {
            continue;
        }
        match transaction(cx, |cx| probe.release_and_clear(cx)) {
            Ok(()) => {
                heals.push(json!({ "kind": probe.kind(), "detail": "cleared dead job lock" }));
                super::diag::log_warn(format!("[HealthCheck] Cleared dead lock: {}", probe.kind()));
            }
            Err(e) => super::diag::log_error(format!(
                "[HealthCheck] Failed clearing {}: {e}",
                probe.kind()
            )),
        }
    }
    if cx.get("import_queue_running", "false") == "true" {
        let since =
            crate::jsnum::js_parse_int(&cx.get("import_queue_running_since", "0")).unwrap_or(0);
        let age = if since > 0 { cx.now - since } else { 0 };
        if since > 0 && age as f64 > stale_lock_ms {
            match cx.set("import_queue_running", "false") {
                Ok(()) => {
                    heals.push(json!({
                        "kind": "stale_lock_import_queue",
                        "detail": format!("lock {}h old", (age as f64 / HOUR_MS).round() as i64),
                    }));
                    super::diag::log_warn("[HealthCheck] Cleared dead import-queue lock");
                }
                Err(e) => super::diag::log_error(format!(
                    "[HealthCheck] Failed clearing import-queue lock: {e}"
                )),
            }
        }
    }
}

/// `anyBulkActive`: a writer this check must not contend with.
fn any_bulk_active(cx: &Cx) -> bool {
    sync_runner::mutex_held(cx)
        || wayback_runner::mutex_held(cx)
        || policy_mutex_held(cx)
        || cx.get("import_queue_running", "false") == "true"
}

// ── Read-only figures ────────────────────────────────────────────────

/// `countRows`: a failed count reads as zero.
fn count_rows(cx: &Cx, sql: &str) -> i64 {
    cx.w.conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0)
}

/// The file the connection opened — `db.name` in Node — so the WAL and
/// file sizes are the connection's own; a memory database has none.
fn opened_path(cx: &Cx) -> std::path::PathBuf {
    Path::new(cx.w.conn.path().unwrap_or("")).to_path_buf()
}

fn blank_checks() -> Value {
    json!({
        "database": {
            "utilisationPct": 0,
            "freelistCount": 0,
            "walBytes": 0,
            "fileBytes": 0,
            "foreignKeysEnabled": 1,
            "fragmented": false,
            "integrity": null,
        },
        "runtime": {
            "rssMb": 0,
            "heapFractionUsed": 0,
            "heapBreach": false,
            "eventLoopP99Ms": 0,
            "eventLoopSeverity": "ok",
        },
        "counts": {
            "notifications": 0,
            "privacySnapshots": 0,
            "activityLog": 0,
            "aiDebugLog": 0,
        },
        "orphans": { "manualAppEvents": 0, "manualAppPolicyVersions": 0 },
        "warnings": [],
    })
}

/// The `HealthCheckResult` literal, in its key order.
#[allow(clippy::too_many_arguments)]
fn result_json(
    trigger: &str,
    started_at: i64,
    finished_at: i64,
    healthy: bool,
    status: &str,
    error: Option<&str>,
    checks: &Value,
    heals: &[Value],
    skipped_heals: &[Value],
) -> Value {
    let mut out = json!({
        "version": RESULT_VERSION,
        "trigger": trigger,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "durationMs": finished_at - started_at,
        "healthy": healthy,
        "status": status,
    });
    if let Some(error) = error {
        out["error"] = json!(error);
    }
    out["checks"] = checks.clone();
    out["heals"] = json!(heals);
    out["skippedHeals"] = json!(skipped_heals);
    out
}

/// Everything between the lock and its release, with the checks filled
/// in as they complete so a failure keeps what was measured.
fn checks_and_heals(
    cx: &mut Cx,
    cfg: &Config,
    checks: &mut Value,
    heals: &mut Vec<Value>,
    skipped_heals: &mut Vec<Value>,
) -> Result<&'static str, String> {
    // 1. Dead job locks first, so the bulk-active probe reflects reality.
    heal_bulk_locks(cx, cfg.stale_lock_ms, heals);
    let bulk_active = any_bulk_active(cx);
    let path = opened_path(cx);

    // 2. PASSIVE WAL checkpoint, skipped while a bulk writer is active.
    let pre = snapshot_database_health(cx.w.conn, &path);
    if pre.wal_bytes as f64 > cfg.wal_checkpoint_bytes {
        if bulk_active {
            skipped_heals.push(json!({ "kind": "wal_checkpoint", "reason": "bulk-active" }));
        } else {
            // `db.pragma()` is native in better-sqlite3 and outside its
            // recorder, so this runs on the connection directly too.
            match cx
                .w
                .conn
                .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |r| {
                    r.get::<_, Option<i64>>(2)
                }) {
                Ok(checkpointed) => {
                    let mut heal = json!({ "kind": "wal_checkpoint" });
                    if let Some(n) = checkpointed {
                        heal["affected"] = json!(n);
                    }
                    heal["detail"] = json!(format!(
                        "wal was {}MB",
                        (pre.wal_bytes as f64 / BYTES_PER_MB).round() as i64
                    ));
                    heals.push(heal);
                }
                Err(e) => super::diag::log_warn(format!(
                    "[HealthCheck] WAL checkpoint failed (busy): {e}"
                )),
            }
        }
    }

    // 3. Stuck policy runs, age-gated and skipped while a bulk writer is
    //    active.
    if bulk_active {
        skipped_heals.push(json!({ "kind": "policy_run_status_reset", "reason": "bulk-active" }));
    } else {
        let cutoff = js_number(cx.now as f64 - cfg.stuck_run_ms);
        match cx.w.run(RESET_STUCK_POLICY_RUNS, vec![cutoff]) {
            Ok(changes) if changes > 0 => {
                heals.push(json!({ "kind": "policy_run_status_reset", "affected": changes }));
            }
            Ok(_) => {}
            Err(e) => {
                super::diag::log_error(format!("[HealthCheck] policy run_status reset failed: {e}"))
            }
        }
    }

    // ── Read-only checks ────────────────────────────────────────────
    let snap = snapshot_database_health(cx.w.conn, &path);
    let fragmented =
        snap.utilisation_pct < FRAGMENTATION_UTIL_WARN || snap.freelist_count > FREELIST_WARN;
    let integrity = if !cfg.integrity_enabled {
        json!({ "skipped": "disabled" })
    } else if bulk_active {
        json!({ "skipped": "bulk-active" })
    } else if snap.file_bytes as f64 >= cfg.integrity_max_bytes {
        json!({ "skipped": "too-large" })
    } else {
        let mut r = run_integrity_check(cx.w.conn, cx.now);
        r["fresh"] = json!(true);
        r
    };
    let integrity_failed = integrity["status"] == "error";
    checks["database"] = json!({
        "utilisationPct": snap.utilisation_pct,
        "freelistCount": snap.freelist_count,
        "walBytes": snap.wal_bytes,
        "fileBytes": snap.file_bytes,
        "foreignKeysEnabled": snap.foreign_keys_enabled,
        "fragmented": fragmented,
        "integrity": integrity,
    });

    // The process figures: RSS as the runtime envelope reports it, no V8
    // heap fraction for this allocator, and the scheduler's lag standing
    // in for the event loop's.
    let rss_mb = sysproc::process_metrics().rss_mb;
    let rss = rss_mb.as_f64().unwrap_or(0.0);
    let heap_fraction_used = 0.0;
    let heap_breach = heap_fraction_used > HEAP_FRACTION_WARN;
    let lag = super::diag::scheduler_lag_snapshot();
    let p99 = lag
        .as_ref()
        .map(|l| l.p99_ms.clone())
        .filter(|p| !p.is_null())
        .unwrap_or(json!(0));
    let severity = lag.as_ref().map_or("ok", |l| l.severity);
    checks["runtime"] = json!({
        "rssMb": rss_mb,
        "heapFractionUsed": 0,
        "heapBreach": heap_breach,
        "eventLoopP99Ms": p99,
        "eventLoopSeverity": severity,
    });

    let counts = json!({
        "notifications": count_rows(cx, "SELECT COUNT(*) AS n FROM notifications"),
        "privacySnapshots": count_rows(cx, "SELECT COUNT(*) AS n FROM privacy_snapshots"),
        "activityLog": count_rows(cx, "SELECT COUNT(*) AS n FROM activity_log"),
        "aiDebugLog": count_rows(cx, "SELECT COUNT(*) AS n FROM ai_debug_log"),
    });
    let orphans = json!({
        "manualAppEvents": count_rows(cx, "SELECT COUNT(*) AS n FROM manual_app_events WHERE manual_app_id NOT IN (SELECT id FROM manual_apps)"),
        "manualAppPolicyVersions": count_rows(cx, "SELECT COUNT(*) AS n FROM manual_app_policy_versions WHERE manual_app_id NOT IN (SELECT id FROM manual_apps)"),
    });
    checks["counts"] = counts.clone();
    checks["orphans"] = orphans.clone();

    // ── Warnings ────────────────────────────────────────────────────
    let mut warnings: Vec<String> = vec![];
    if snap.foreign_keys_enabled != 1 {
        warnings.push("foreign_keys disabled".into());
    }
    if integrity_failed {
        warnings.push(format!(
            "integrity check failed: {}",
            checks["database"]["integrity"]["detail"]
                .as_str()
                .unwrap_or("unknown")
        ));
    }
    if heap_breach {
        warnings.push(format!(
            "heap {}% of limit",
            (heap_fraction_used * 100.0).round() as i64
        ));
    }
    if rss > cfg.rss_warn_mb {
        warnings.push(format!("RSS {}MB", rss.round() as i64));
    }
    if severity != "ok" {
        warnings.push(format!(
            "event-loop p99 {}ms",
            p99.as_f64().unwrap_or(0.0).round() as i64
        ));
    }
    let orphan_total = orphans["manualAppEvents"].as_i64().unwrap_or(0)
        + orphans["manualAppPolicyVersions"].as_i64().unwrap_or(0);
    if orphan_total > 0 {
        warnings.push(format!(
            "{orphan_total} orphan manual-app rows (not auto-deleted)"
        ));
    }
    let activity = counts["activityLog"].as_i64().unwrap_or(0);
    if activity > 2000 {
        warnings.push(format!("activity_log over cap ({activity})"));
    }
    let ai = counts["aiDebugLog"].as_i64().unwrap_or(0);
    if ai > 50 {
        warnings.push(format!("ai_debug_log over cap ({ai})"));
    }
    let hard_error = snap.foreign_keys_enabled != 1 || integrity_failed;
    let status = if hard_error {
        "error"
    } else if !warnings.is_empty() || !heals.is_empty() {
        "partial"
    } else {
        "ok"
    };
    checks["warnings"] = json!(warnings);
    Ok(status)
}

/// `persistAndRecord`: the result blob and its timestamp, then the
/// activity row last so the count above never includes this run's own.
fn persist_and_record(cx: &mut Cx, result: &Value, started_at: i64) {
    let persisted = (|| -> Result<(), String> {
        let blob = js_json_vec(result).map_err(|e| e.to_string())?;
        cx.set(
            HEALTH_LAST_RESULT_KEY,
            &String::from_utf8(blob).map_err(|e| e.to_string())?,
        )?;
        cx.set(
            HEALTH_LAST_RUN_AT_KEY,
            &result["finishedAt"].as_i64().unwrap_or(0).to_string(),
        )
    })();
    if let Err(e) = persisted {
        super::diag::log_warn(format!("[HealthCheck] persist failed: {e}"));
    }
    let heals: Vec<&str> = result["heals"]
        .as_array()
        .map(|h| h.iter().filter_map(|x| x["kind"].as_str()).collect())
        .unwrap_or_default();
    let warnings: Vec<&str> = result["checks"]["warnings"]
        .as_array()
        .map(|w| w.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let status = result["status"].as_str().unwrap_or("error");
    let heal_summary = if heals.is_empty() {
        String::new()
    } else {
        format!(" — healed {}", heals.join(", "))
    };
    let warn_summary = if warnings.is_empty() {
        String::new()
    } else {
        format!(" — {}", warnings.join("; "))
    };
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "health_check",
        status,
        None,
        Some(&format!(
            "Health check {status}{heal_summary}{warn_summary}"
        )),
        Some(result),
        started_at,
    );
}

/// `runHealthCheck({ trigger })`. Never fails: a failure folds into the
/// result as `status: "error"`.
pub(super) fn run_health_check(cx: &mut Cx, trigger: &str) -> Value {
    let started_at = cx.now;
    let acquired = match acquire_health_lock(cx) {
        Ok(acquired) => acquired,
        Err(e) => {
            super::diag::log_error(format!("[HealthCheck] run failed: {e}"));
            false
        }
    };
    if !acquired {
        let mut busy = json!({
            "version": RESULT_VERSION,
            "trigger": trigger,
            "startedAt": started_at,
            "finishedAt": cx.now,
            "durationMs": 0,
            "healthy": true,
            "status": "ok",
            "skipped": "busy",
        });
        busy["checks"] = blank_checks();
        busy["heals"] = json!([]);
        busy["skippedHeals"] = json!([]);
        return busy;
    }
    let cfg = read_config(cx);
    let mut heals = vec![];
    let mut skipped_heals = vec![];
    let mut checks = blank_checks();
    let result = match checks_and_heals(cx, &cfg, &mut checks, &mut heals, &mut skipped_heals) {
        Ok(status) => result_json(
            trigger,
            started_at,
            cx.now,
            status == "ok",
            status,
            None,
            &checks,
            &heals,
            &skipped_heals,
        ),
        Err(e) => {
            super::diag::log_error(format!("[HealthCheck] run failed: {e}"));
            result_json(
                trigger,
                started_at,
                cx.now,
                false,
                "error",
                Some(&e),
                &checks,
                &heals,
                &skipped_heals,
            )
        }
    };
    persist_and_record(cx, &result, started_at);
    if let Err(e) = cx.set(HEALTH_RUNNING_KEY, "false") {
        super::diag::log_error(format!("[HealthCheck] lock release failed: {e}"));
    }
    result
}

/// The startup hook's `tickHealthCheck`: gated by `health_check_enabled`,
/// unlike the manual run.
pub(crate) fn tick_health_check(db: &mut dyn DbAccess, ids: &mut dyn Ids, now: i64) {
    db.with(|w| {
        let mut cx = Cx { w, ids, now };
        if cx.get("health_check_enabled", "true") == "false" {
            return;
        }
        let result = run_health_check(&mut cx, "scheduled");
        if result["healthy"] != json!(true) {
            println!(
                "[HealthCheck] {} — {} heal(s), {} warning(s)",
                result["status"].as_str().unwrap_or(""),
                result["heals"].as_array().map_or(0, Vec::len),
                result["checks"]["warnings"].as_array().map_or(0, Vec::len)
            );
        }
    });
}

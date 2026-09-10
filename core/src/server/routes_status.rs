//! Batch 3: `/api/sync/status`, `/api/verdicts`, `/api/imports/queue`.
//!
//! What these three add over batches 1–2: a query-parameter-scoped read with
//! a 400 branch (`verdicts`), a nested list-inside-an-envelope
//! (`imports/queue`), and interval arithmetic over stored epoch values
//! (`sync/status`).

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Response,
};
use serde::Serialize;

use super::json::{json_error, json_ok};
use super::settings::get_setting;
use super::AppState;
use crate::jsnum::js_parse_int;

// ── /api/sync/status ─────────────────────────────────────────────────
// Port of getSchedulerStatus. `nextRun` is null whenever the interval is 0
// (schedule "manual" or an unrecognised value), and `isDue` is false in that
// case too — it is guarded by `interval > 0`, so it never reports due for a
// manual schedule no matter how old lastRun is.

#[derive(Serialize)]
struct SyncStatus {
    schedule: String,
    #[serde(rename = "lastRun")]
    last_run: i64,
    // Explicit null, never absent.
    #[serde(rename = "nextRun")]
    next_run: Option<i64>,
    #[serde(rename = "isDue")]
    is_due: bool,
    #[serde(rename = "isRunning")]
    is_running: bool,
}

/// `INTERVALS_MS`. An unrecognised stored schedule yields 0 via the `?? 0`
/// fallback in Node, which is the same as "manual".
fn interval_ms(schedule: &str) -> i64 {
    match schedule {
        "daily" => 24 * 60 * 60 * 1000,
        "weekly" => 7 * 24 * 60 * 60 * 1000,
        // "manual" and anything unrecognised.
        _ => 0,
    }
}

/// The due rule, extracted so it can be asserted against a fixed clock.
/// `interval > 0` guards it, so a manual schedule is NEVER due however old
/// `lastRun` is — that guard is the whole of the manual-schedule behaviour.
fn compute_is_due(interval: i64, last_run: i64, now: i64) -> bool {
    interval > 0 && now >= last_run + interval
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub async fn sync_status(State(state): State<AppState>) -> Response {
    let get = |k: &str, d: &str| get_setting(&state, k, d).unwrap_or_default();

    // Node stores the schedule unvalidated and casts it, so an unrecognised
    // value is echoed verbatim while its interval falls back to 0.
    let schedule = get("sync_schedule", "manual");
    // `Number.parseInt(...) || 0` — NaN, "", and a literal 0 all become 0.
    let last_run = js_parse_int(&get("last_auto_sync", "0")).unwrap_or(0);
    let is_running = get("sync_running", "false") == "true";

    let interval = interval_ms(&schedule);
    let next_run = if interval > 0 {
        Some(last_run + interval)
    } else {
        None
    };
    let is_due = compute_is_due(interval, last_run, now_ms());

    json_ok(&SyncStatus {
        schedule,
        last_run,
        next_run,
        is_due,
        is_running,
    })
}

// ── /api/verdicts ────────────────────────────────────────────────────
// A query-scoped read. A missing or EMPTY appId is a 400 — Node's `if
// (!appId)` is a truthiness test, so `?appId=` (present but empty) is
// rejected exactly like an absent one.

#[derive(Serialize)]
struct Verdict {
    id: String,
    #[serde(rename = "appId")]
    app_id: String,
    verdict: String,
    rationale: Option<String>,
    source: String,
    #[serde(rename = "sourceName")]
    source_name: Option<String>,
    #[serde(rename = "setAt")]
    set_at: i64,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
}

#[derive(Serialize)]
struct VerdictsBody {
    verdicts: Vec<Verdict>,
}

pub async fn verdicts(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    // JS truthiness: empty string is falsy, so it 400s like a missing param.
    let Some(app_id) = q.get("appId").filter(|v| !v.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "appId is required");
    };

    let conn = state.conn.lock().expect("db mutex poisoned");
    let listed = (|| -> rusqlite::Result<Vec<Verdict>> {
        let mut stmt = conn.prepare(
            "SELECT id, app_id, verdict, rationale, source, source_name, set_at, updated_at \
             FROM app_verdicts WHERE app_id = ? ORDER BY set_at DESC",
        )?;
        let rows = stmt
            .query_map([app_id], |row| {
                Ok(Verdict {
                    id: row.get("id")?,
                    app_id: row.get("app_id")?,
                    verdict: row.get("verdict")?,
                    rationale: row.get("rationale")?,
                    source: row.get("source")?,
                    source_name: row.get("source_name")?,
                    set_at: row.get("set_at")?,
                    updated_at: row.get("updated_at")?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })();

    match listed {
        Ok(verdicts) => json_ok(&VerdictsBody { verdicts }),
        // Node logs and answers 500 with this exact body.
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to list verdicts"),
    }
}

// ── /api/imports/queue ───────────────────────────────────────────────
// Key order is the spread of getQueueStatus's literal followed by the three
// fields getImportQueueStatus adds: queued, soonestNextAttemptAt,
// oldestNextAttemptAt, items, pausedUntil, running, lastRunAt.
//
// `pausedUntil` is null unless the stored fence is still in the FUTURE — a
// stale pause reads as null rather than as a past timestamp.

#[derive(Serialize)]
struct QueueItem {
    id: String,
    #[serde(rename = "importId")]
    import_id: String,
    query: String,
    #[serde(rename = "editedQuery")]
    edited_query: Option<String>,
    status: String,
    #[serde(rename = "appId")]
    app_id: Option<String>,
    #[serde(rename = "appName")]
    app_name: Option<String>,
    developer: Option<String>,
    url: Option<String>,
    #[serde(rename = "iconUrl")]
    icon_url: Option<String>,
    country: Option<String>,
    #[serde(rename = "scrapeError")]
    scrape_error: Option<String>,
    #[serde(rename = "removedAppId")]
    removed_app_id: Option<String>,
    #[serde(rename = "nextAttemptAt")]
    next_attempt_at: Option<i64>,
    #[serde(rename = "attemptCount")]
    attempt_count: i64,
}

#[derive(Serialize)]
struct QueueStatus {
    queued: i64,
    #[serde(rename = "soonestNextAttemptAt")]
    soonest_next_attempt_at: Option<i64>,
    #[serde(rename = "oldestNextAttemptAt")]
    oldest_next_attempt_at: Option<i64>,
    items: Vec<QueueItem>,
    #[serde(rename = "pausedUntil")]
    paused_until: Option<i64>,
    running: bool,
    #[serde(rename = "lastRunAt")]
    last_run_at: Option<i64>,
}

pub async fn imports_queue(State(state): State<AppState>) -> Response {
    let paused_raw =
        js_parse_int(&get_setting(&state, "import_queue_paused_until", "0").unwrap_or_default())
            .unwrap_or(0);
    let last_run_raw =
        js_parse_int(&get_setting(&state, "import_queue_last_run", "0").unwrap_or_default())
            .unwrap_or(0);
    let running =
        get_setting(&state, "import_queue_running", "false").unwrap_or_default() == "true";

    let conn = state.conn.lock().expect("db mutex poisoned");
    let built = (|| -> rusqlite::Result<QueueStatus> {
        // MIN/MAX over an empty set are NULL, and COUNT is 0 — matching
        // Node's `counts.soonest ?? null` / `counts.queued ?? 0`.
        let (queued, soonest, oldest) = conn.query_row(
            "SELECT COUNT(*) AS queued, MIN(next_attempt_at) AS soonest, MAX(next_attempt_at) AS oldest \
             FROM import_items WHERE status = 'queued'",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>("queued")?,
                    row.get::<_, Option<i64>>("soonest")?,
                    row.get::<_, Option<i64>>("oldest")?,
                ))
            },
        )?;

        let mut stmt = conn.prepare(
            "SELECT * FROM import_items WHERE status = 'queued' \
             ORDER BY next_attempt_at ASC, rowid ASC LIMIT 25",
        )?;
        let items = stmt
            .query_map([], |row| {
                Ok(QueueItem {
                    id: row.get("id")?,
                    import_id: row.get("import_id")?,
                    query: row.get("query")?,
                    edited_query: row.get("edited_query")?,
                    status: row.get("status")?,
                    app_id: row.get("app_id")?,
                    app_name: row.get("app_name")?,
                    developer: row.get("developer")?,
                    url: row.get("url")?,
                    icon_url: row.get("icon_url")?,
                    country: row.get("country")?,
                    scrape_error: row.get("scrape_error")?,
                    removed_app_id: row.get("removed_app_id")?,
                    next_attempt_at: row.get("next_attempt_at")?,
                    attempt_count: row.get::<_, Option<i64>>("attempt_count")?.unwrap_or(0),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(QueueStatus {
            queued,
            soonest_next_attempt_at: soonest,
            oldest_next_attempt_at: oldest,
            items,
            // Only a FUTURE fence counts; a stale one reads as null.
            paused_until: if paused_raw > now_ms() {
                Some(paused_raw)
            } else {
                None
            },
            running,
            // `lastRunRaw || null` — a stored 0 becomes null, not 0.
            last_run_at: if last_run_raw != 0 {
                Some(last_run_raw)
            } else {
                None
            },
        })
    })();

    match built {
        Ok(status) => json_ok(&status),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_schedule_is_never_due_and_has_no_next_run() {
        // interval == 0 guards BOTH nextRun and isDue, so an ancient lastRun
        // still reports not-due on a manual schedule.
        let ancient = 0i64;
        let now = 1_789_000_000_000i64;
        for schedule in ["manual", "", "nonsense"] {
            let interval = interval_ms(schedule);
            assert_eq!(interval, 0, "{schedule} should have no interval");
            assert!(
                !compute_is_due(interval, ancient, now),
                "{schedule} must never be due"
            );
        }
        // A real interval with an ancient lastRun IS due — proving the
        // assertion above is about the guard, not about the clock.
        assert!(compute_is_due(interval_ms("daily"), ancient, now));
        // And a fresh run is not yet due.
        assert!(!compute_is_due(interval_ms("daily"), now, now));
    }

    #[test]
    fn known_schedules_have_the_documented_intervals() {
        assert_eq!(interval_ms("daily"), 86_400_000);
        assert_eq!(interval_ms("weekly"), 604_800_000);
    }

    #[test]
    fn zero_last_run_becomes_null_not_zero() {
        // `lastRunRaw || null` — the falsy 0 must serialise as null.
        let last_run_raw = 0i64;
        let v: Option<i64> = if last_run_raw != 0 {
            Some(last_run_raw)
        } else {
            None
        };
        assert_eq!(serde_json::to_string(&v).unwrap(), "null");
    }
}

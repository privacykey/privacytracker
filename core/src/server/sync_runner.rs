//! Phase 4, batch 4a: the bulk App Store sync and the scheduler around it.
//!
//! `lib/sync-bulk-runner.ts` and `lib/sync-bulk-state.ts` — the durable
//! state blob under `sync_bulk_state`, the `sync_running` mutex, the
//! per-app loop that re-scrapes the fleet and bails on Apple's first 429 —
//! plus the three callers Node gives it: `runScheduledSync` (the route and
//! the scheduler's 30-minute check), and the boot-time resume in
//! `instrumentation.ts` with the stale-lock heals and the boot writes
//! beside it. Gated by `core/tests/fixtures/runners-cases.json`, whose
//! callback cases are the real closures `register()` armed, invoked
//! directly; `runners_tests` replays them here.
//!
//! The lock is taken per section, as the batch-3 handlers take it: the
//! state seed and mutex before the first scrape, one section per app for
//! the in-flight mark and the app lookup, the scrape's preparing section,
//! the network with the lock released, then one section for the commit
//! and the state write that follows it — Node runs each of those between
//! two awaits. The state blob's key order is fixed by the code that
//! creates it, so it serialises from structs rather than from a mutable
//! map: every entry key is created, undefined or not, the moment the
//! entry goes in flight, and `JSON.stringify` then omits the undefined
//! ones — which is exactly a struct of `Option`s in that order.
use super::lifecycle::{isolate, sleep_or_stop};
use super::{
    activity_log::record_activity,
    flags::{context_from_db, resolve_flag},
    routes_status::{compute_is_due, interval_ms},
    writes::Cx,
    AppState,
};
use crate::{
    jsnum::js_parse_int,
    jsstr::js_slice_prefix,
    outbound::{Fetcher, PublicHttp},
    scrape::{
        complete,
        fetch::fire_change_webhook,
        notify, perform as perform_fetch,
        persist::{DbAccess, Ids},
        prepare, RandomIds,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

/// `Date.now()` as the runner sees it: live on the server, frozen in the
/// replay. Every stamp the runner writes comes from here.
pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> i64;
}
pub(crate) struct Live;
impl Clock for Live {
    fn now(&self) -> i64 {
        super::now_ms()
    }
}
pub(crate) struct Fixed(pub(crate) i64);
impl Clock for Fixed {
    fn now(&self) -> i64 {
        self.0
    }
}

/// The clock a route handler hands the runner: the request's frozen
/// instant in the replay, the wall clock on the server, where a run
/// outlives the request time by minutes.
pub(super) fn clock_for(now: i64) -> Arc<dyn Clock> {
    if cfg!(test) {
        Arc::new(Fixed(now))
    } else {
        Arc::new(Live)
    }
}

const STATE_KEY: &str = "sync_bulk_state";
const MUTEX_KEY: &str = "sync_running";
const STATE_SCHEMA_VERSION: i64 = 1;
const CLEAR_STATE: &str = "DELETE FROM app_settings WHERE key = ?";
const INSERT_NOTIFICATION: &str = "\n    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)\n    VALUES (?, ?, ?, ?, ?, 0)\n  ";
const SYNC_RESUME_NOTIFICATION_APP_ID: &str = "__sync_resume__";
const MAX_CONSECUTIVE_FAILURES: u32 = 3;
const BACKOFF_STEPS_MS: [i64; 3] = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
const IMPORT_QUEUE_INTERVAL: Duration = Duration::from_secs(60);
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

// ── lib/sync-bulk-state.ts ───────────────────────────────────────────

/// One queue entry, in the key order the runner creates its keys.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct QueueEntry {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "appName")]
    pub app_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
    pub status: String,
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none", default)]
    pub started_at: Option<i64>,
    #[serde(
        rename = "finishedAt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub finished_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub outcome: Option<String>,
    #[serde(
        rename = "changesDetected",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub changes_detected: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct Totals {
    pub attempted: i64,
    pub succeeded: i64,
    pub changes: i64,
    pub failed: i64,
    #[serde(rename = "rateLimited")]
    pub rate_limited: i64,
    pub skipped: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct SyncState {
    pub version: i64,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    pub initiator: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "currentAppId")]
    pub current_app_id: Option<String>,
    pub queue: Vec<QueueEntry>,
    pub totals: Totals,
}

pub(crate) struct Summary {
    pub total: usize,
    pub remaining: usize,
}

/// `readSyncBulkState`: absent, unparseable, the wrong version or missing
/// fields all read as nothing to resume.
pub(super) fn read_state(cx: &Cx) -> Option<SyncState> {
    let raw = cx.get(STATE_KEY, "");
    if raw.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    if !parsed.is_object()
        || parsed["version"] != json!(STATE_SCHEMA_VERSION)
        || !parsed["runId"].is_string()
        || !parsed["queue"].is_array()
    {
        return None;
    }
    serde_json::from_value(parsed).ok()
}

/// `writeSyncBulkState`: the version and `updatedAt` refreshed in place.
fn write_state(cx: &mut Cx, state: &mut SyncState) -> Result<(), String> {
    state.version = STATE_SCHEMA_VERSION;
    state.updated_at = cx.now;
    let payload = serde_json::to_string(state).map_err(|e| e.to_string())?;
    cx.set(STATE_KEY, &payload)
}

pub(super) fn clear_state(cx: &mut Cx) -> Result<(), String> {
    cx.w.run(CLEAR_STATE, vec![json!(STATE_KEY)]).map(drop)
}

pub(super) fn mutex_held(cx: &Cx) -> bool {
    cx.get(MUTEX_KEY, "") == "true"
}

/// `acquireSyncBulkMutex`: a redundant set is harmless and Node's runner
/// makes one defensively.
fn acquire_mutex(cx: &mut Cx) -> Result<bool, String> {
    if mutex_held(cx) {
        return Ok(false);
    }
    cx.set(MUTEX_KEY, "true")?;
    Ok(true)
}

pub(super) fn release_mutex(cx: &mut Cx) -> Result<(), String> {
    cx.set(MUTEX_KEY, "false")
}

pub(crate) fn summarise(state: &SyncState) -> Summary {
    let remaining = state
        .queue
        .iter()
        .filter(|e| e.status == "pending" || e.status == "in_progress")
        .count();
    Summary {
        total: state.queue.len(),
        remaining,
    }
}

fn has_pending_work(state: Option<&SyncState>) -> bool {
    state.is_some_and(|s| summarise(s).remaining > 0)
}

// ── lib/sync-bulk-runner.ts ──────────────────────────────────────────

/// `buildInitialSyncQueue`: every app with a URL, by name.
fn build_initial_queue(cx: &Cx) -> Result<Vec<QueueEntry>, String> {
    let rows = super::stats::query(
        cx.w.conn,
        "SELECT id, name, url
         FROM apps
        WHERE url IS NOT NULL
          AND TRIM(url) != ''
        ORDER BY name COLLATE NOCASE ASC",
        &[],
    )
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|r| super::stats::truthy(&r["url"]))
        .map(|r| QueueEntry {
            app_id: r["id"].as_str().unwrap_or("").to_string(),
            app_name: r["name"].as_str().unwrap_or("").to_string(),
            url: r["url"].as_str().map(String::from),
            status: "pending".to_string(),
            started_at: None,
            finished_at: None,
            error: None,
            outcome: None,
            changes_detected: None,
        })
        .collect())
}

struct AppRow {
    url: Option<String>,
}

/// `lookupSyncAppRow`: the row at dequeue time, not the queued copy.
fn lookup_app_row(cx: &Cx, app_id: &str) -> Result<Option<AppRow>, String> {
    let rows = super::stats::query(
        cx.w.conn,
        "SELECT id, name, url FROM apps WHERE id = ?",
        &[rusqlite::types::Value::Text(app_id.to_string())],
    )
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().next().map(|r| AppRow {
        url: r["url"].as_str().map(String::from),
    }))
}

fn bulk_summary_line(t: &Totals) -> String {
    let mut parts = vec![format!("{}/{} synced", t.succeeded, t.attempted)];
    parts.push(format!(
        "{} change{}",
        t.changes,
        if t.changes == 1 { "" } else { "s" }
    ));
    if t.failed != 0 {
        parts.push(format!(
            "{} error{}",
            t.failed,
            if t.failed == 1 { "" } else { "s" }
        ));
    }
    if t.rate_limited != 0 {
        parts.push(format!("{} rate-limited", t.rate_limited));
    }
    if t.skipped != 0 {
        parts.push(format!("{} skipped", t.skipped));
    }
    parts.join(", ")
}

fn activity_type_for(initiator: &str) -> &'static str {
    if initiator == "manual" {
        "manual_sync"
    } else {
        "scheduled_sync"
    }
}

pub(crate) struct RunResult {
    pub synced: i64,
    pub changes: i64,
}

/// `runBulkSync`. `resume` is the crash-left state the boot check found;
/// a fresh run seeds its own. Errors are what the outer catch rethrows,
/// with the state and mutex left in place for the next boot.
pub(crate) async fn run_bulk_sync(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    initiator: &str,
    resume: Option<SyncState>,
) -> Result<RunResult, String> {
    let mut state = match resume {
        Some(mut state) => {
            // The blob still names whoever started the run; record who runs
            // it now, before the first write, so a resume reads as one.
            state.initiator = initiator.to_string();
            for entry in &mut state.queue {
                if entry.status == "in_progress" {
                    entry.status = "pending".to_string();
                }
            }
            Some(state)
        }
        None => None,
    };
    // The seed, the mutex and the empty-queue exit: one section before the
    // first await.
    let now = clock.now();
    let opened = db.with(|w| -> Result<Option<RunResult>, String> {
        let cx = &mut Cx { w, ids, now };
        if state.is_none() {
            let queue = build_initial_queue(cx)?;
            state = Some(SyncState {
                version: 1,
                run_id: cx.ids.uuid(cx.w.conn)?,
                started_at: cx.now,
                initiator: initiator.to_string(),
                updated_at: cx.now,
                current_app_id: None,
                queue,
                totals: Totals::default(),
            });
        }
        let state = state.as_mut().expect("seeded");
        acquire_mutex(cx)?;
        write_state(cx, state)?;
        if state.queue.is_empty() {
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                activity_type_for(&state.initiator),
                "ok",
                None,
                Some("No apps to sync"),
                Some(&json!({ "appCount": 0 })),
                state.started_at,
            );
            clear_state(cx)?;
            release_mutex(cx)?;
            return Ok(Some(RunResult {
                synced: 0,
                changes: 0,
            }));
        }
        Ok(None)
    })?;
    if let Some(done) = opened {
        return Ok(done);
    }
    let mut state = state.expect("seeded");
    let run_started_at = clock.now();
    let trigger = if state.initiator == "manual" {
        "manual"
    } else {
        "scheduled"
    };
    let outcome = sync_loop(db, fetcher, ids, clock, &mut state, trigger).await;
    match outcome {
        Ok(rate_limited) => {
            let now = clock.now();
            db.with(|w| {
                let cx = &mut Cx { w, ids, now };
                let duration_ms = cx.now - run_started_at;
                let status = if state.totals.failed > 0 || rate_limited {
                    "partial"
                } else {
                    "ok"
                };
                let base = bulk_summary_line(&state.totals);
                let summary = if state.initiator == "resume" {
                    format!("{base} (resumed after restart)")
                } else {
                    base
                };
                if !rate_limited {
                    cx.set("last_auto_sync", &cx.now.to_string())?;
                }
                record_activity(
                    cx.w,
                    cx.ids,
                    cx.now,
                    activity_type_for(&state.initiator),
                    status,
                    None,
                    Some(&js_slice_prefix(&summary, 200)),
                    Some(&json!({
                        "mode": if state.initiator == "resume" { "bulk-resumed" } else { "bulk" },
                        "totals": state.totals,
                        "runId": state.run_id,
                        "rateLimited": rate_limited,
                    })),
                    state.started_at,
                );
                clear_state(cx)?;
                release_mutex(cx)?;
                let _ = duration_ms;
                Ok::<(), String>(())
            })?;
            if state.totals.succeeded > 0 {
                super::policy_triggers::schedule("sync");
            }
            Ok(RunResult {
                synced: state.totals.succeeded,
                changes: state.totals.changes,
            })
        }
        Err(message) => {
            // The outer catch: the row, then the rethrow with the state and
            // mutex left for the next boot.
            let now = clock.now();
            db.with(|w| {
                let cx = &mut Cx { w, ids, now };
                let label = if state.initiator == "manual" {
                    "Manual"
                } else {
                    "Scheduled"
                };
                record_activity(
                    cx.w,
                    cx.ids,
                    cx.now,
                    activity_type_for(&state.initiator),
                    "error",
                    None,
                    Some(&js_slice_prefix(
                        &format!("{label} sync failed: {message}"),
                        200,
                    )),
                    Some(&json!({
                        "mode": "bulk",
                        "totals": state.totals,
                        "errorMessage": message,
                        "runId": state.run_id,
                    })),
                    state.started_at,
                );
            });
            Err(message)
        }
    }
}

/// The per-app loop. `Ok(true)` when Apple rate-limited the run.
async fn sync_loop(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    state: &mut SyncState,
    trigger: &str,
) -> Result<bool, String> {
    for i in 0..state.queue.len() {
        if state.queue[i].status == "done" || state.queue[i].status == "failed" {
            continue;
        }
        // The in-flight mark, its persist, the fresh app row and the
        // scrape's preparing reads: no await between them in Node.
        let now = clock.now();
        let prepared = db.with(|w| {
            let cx = &mut Cx { w, ids, now };
            let entry = &mut state.queue[i];
            entry.status = "in_progress".to_string();
            entry.started_at = Some(cx.now);
            entry.finished_at = None;
            entry.error = None;
            entry.outcome = None;
            entry.changes_detected = None;
            state.current_app_id = Some(entry.app_id.clone());
            state.totals.attempted += 1;
            write_state(cx, state)?;
            let app = lookup_app_row(cx, &state.queue[i].app_id)?;
            let url = app
                .as_ref()
                .and_then(|a| a.url.clone())
                .filter(|u| !u.is_empty());
            let Some(url) = url else {
                let reason = if app.is_some() {
                    "App no longer has a URL."
                } else {
                    "App no longer exists."
                };
                let entry = &mut state.queue[i];
                entry.status = "done".to_string();
                entry.finished_at = Some(cx.now);
                entry.outcome = Some("skipped".to_string());
                entry.error = Some(reason.to_string());
                state.totals.skipped += 1;
                state.totals.attempted -= 1;
                state.current_app_id = None;
                write_state(cx, state)?;
                return Ok::<_, String>(None);
            };
            Ok(Some((url.clone(), prepare(cx.w.conn, &url, cx.now))))
        })?;
        let Some((url, prepared)) = prepared else {
            continue;
        };
        let fetched = match prepared {
            Ok(prepared) => Ok(perform_fetch(fetcher, &prepared, clock.now()).await),
            Err(error) => Err(error),
        };
        // The commit (or the error row), then the entry and the state:
        // Node runs them the moment `fetchAndParseApp` resolves. The
        // immediate webhook a label change owes follows the section.
        let now = clock.now();
        let mut owed = None;
        let stop = db.with(|w| {
            let cx = &mut Cx { w, ids, now };
            let result =
                fetched.and_then(|f| complete(cx.w, &url, true, trigger, cx.now, f, cx.ids));
            let entry = &mut state.queue[i];
            match result {
                Ok(outcome) => {
                    owed = outcome.immediate;
                    let changed = outcome.changes_detected;
                    entry.status = "done".to_string();
                    entry.finished_at = Some(cx.now);
                    entry.outcome = Some(if changed { "changed" } else { "succeeded" }.to_string());
                    entry.changes_detected = Some(changed);
                    state.totals.succeeded += 1;
                    if changed {
                        state.totals.changes += 1;
                    }
                    state.current_app_id = None;
                    write_state(cx, state)?;
                    Ok::<bool, String>(false)
                }
                Err(error) if error.is_rate_limited() => {
                    // Client-wide: this one and every pending peer count as
                    // rate-limited, and the run stops here.
                    entry.status = "failed".to_string();
                    entry.finished_at = Some(cx.now);
                    entry.outcome = Some("rate_limited".to_string());
                    entry.error = Some(js_slice_prefix(&error.message, 200));
                    state.totals.rate_limited += 1;
                    state.totals.attempted -= 1;
                    state.current_app_id = None;
                    write_state(cx, state)?;
                    let pending = state.queue[i + 1..]
                        .iter()
                        .filter(|peer| peer.status == "pending")
                        .count() as i64;
                    state.totals.rate_limited += pending;
                    Ok(true)
                }
                Err(error) => {
                    entry.status = "failed".to_string();
                    entry.finished_at = Some(cx.now);
                    entry.error = Some(js_slice_prefix(&error.message, 200));
                    entry.outcome = Some("failed".to_string());
                    state.totals.failed += 1;
                    state.current_app_id = None;
                    write_state(cx, state)?;
                    Ok(false)
                }
            }
        });
        fire_change_webhook(db, fetcher, now, owed).await;
        if stop? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) struct ScheduledResult {
    pub synced: i64,
    pub changes: i64,
    pub skipped: bool,
}

/// `runScheduledSync`: busy answers `skipped`, else the run.
pub(crate) async fn run_scheduled_sync(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    manual: bool,
) -> Result<ScheduledResult, String> {
    let now = clock.now();
    let busy = db.with(|w| {
        let cx = &Cx { w, ids, now };
        mutex_held(cx) || read_state(cx).is_some()
    });
    if busy {
        return Ok(ScheduledResult {
            synced: 0,
            changes: 0,
            skipped: true,
        });
    }
    let result = run_bulk_sync(
        db,
        fetcher,
        ids,
        clock,
        if manual { "manual" } else { "scheduled" },
        None,
    )
    .await?;
    Ok(ScheduledResult {
        synced: result.synced,
        changes: result.changes,
        skipped: false,
    })
}

// ── lib/notifications.ts: createSyncResumeNotification ───────────────

/// `isResumeEnabled`: the flag, or on when it cannot be read.
fn resume_enabled(cx: &Cx) -> bool {
    context_from_db(cx.w.conn)
        .ok()
        .and_then(|ctx| resolve_flag("flag.notifications.resume.enabled", &ctx).ok())
        .map_or(true, |v| v == "on")
}

fn sync_resume_notification(
    cx: &mut Cx,
    apps_remaining: i64,
    total_apps: i64,
    stale_healed: bool,
) -> Result<(), String> {
    if !resume_enabled(cx) {
        return Ok(());
    }
    let apps_remaining = apps_remaining.max(0);
    let total_apps = total_apps.max(0);
    let description = if stale_healed {
        "A previous App Store sync lock was stuck after a server restart and has been cleared. You can start a new sync now.".to_string()
    } else {
        format!(
            "App Store sync resumed — {apps_remaining} of {total_apps} app{} still to process. Running in the background.",
            if total_apps == 1 { "" } else { "s" }
        )
    };
    let id = cx.ids.uuid(cx.w.conn)?;
    let payload = json!([{
        "type": if stale_healed { "sync_stale_cleared" } else { "sync_resumed" },
        "description": description,
        "appsRemaining": apps_remaining,
        "totalApps": total_apps,
    }]);
    cx.w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!(SYNC_RESUME_NOTIFICATION_APP_ID),
            json!("App Store sync"),
            json!(payload.to_string()),
            json!(cx.now),
        ],
    )?;
    notify::prune_notifications(cx.w);
    Ok(())
}

// ── instrumentation.ts ───────────────────────────────────────────────

/// The boot writes `register()` makes before any ticker: the runtime
/// marker, then the stale import-queue and health-check locks cleared —
/// a fresh process owns no run.
pub(crate) fn boot(db: &mut dyn DbAccess, now: i64, desktop: bool) {
    let mut ids = RandomIds;
    let outcome = db.with(|w| {
        let cx = &mut Cx {
            w,
            ids: &mut ids,
            now,
        };
        cx.set("runtime_environment", if desktop { "desktop" } else { "" })?;
        if cx.get("import_queue_running", "false") == "true" {
            cx.set("import_queue_running", "false")?;
        }
        if cx.get("health_check_running", "false") == "true" {
            cx.set("health_check_running", "false")?;
        }
        Ok::<(), String>(())
    });
    if let Err(e) = outcome {
        super::diag::log_error(format!("[Runtime] boot writes failed: {e}"));
    }
}

/// The scheduler's `check`: the failure backoff it keeps in memory.
#[derive(Default)]
pub(crate) struct Scheduler {
    consecutive_failures: u32,
    pause_until: i64,
}

/// One scheduler tick: nothing unless the schedule says the sync is due.
pub(crate) async fn scheduled_check(
    sched: &mut Scheduler,
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
) {
    let now = clock.now();
    if now < sched.pause_until {
        return;
    }
    let due = db.with(|w| {
        let cx = &Cx { w, ids, now };
        let schedule = cx.get("sync_schedule", "manual");
        let last_run = js_parse_int(&cx.get("last_auto_sync", "0")).unwrap_or(0);
        compute_is_due(interval_ms(&schedule), last_run, now)
    });
    if !due {
        return;
    }
    match run_scheduled_sync(db, fetcher, ids, clock, false).await {
        Ok(_) => sched.consecutive_failures = 0,
        Err(e) => {
            sched.consecutive_failures += 1;
            super::diag::log_error(format!(
                "[AutoSync] Error during sync ({} in a row): {e}",
                sched.consecutive_failures
            ));
            if sched.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                let index = ((sched.consecutive_failures - MAX_CONSECUTIVE_FAILURES) as usize)
                    .min(BACKOFF_STEPS_MS.len() - 1);
                sched.pause_until = clock.now() + BACKOFF_STEPS_MS[index];
            }
        }
    }
}

/// `resumeAppStoreSync`: the boot check. A stale lock or a finished blob
/// is healed with a notification; pending work is resumed — here to
/// completion, on the server inside its own task.
pub(crate) async fn resume_app_store_sync(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
) -> Result<(), String> {
    let now = clock.now();
    let resume = db.with(|w| -> Result<Option<SyncState>, String> {
        let cx = &mut Cx { w, ids, now };
        let state = read_state(cx);
        let held = mutex_held(cx);
        if state.is_none() && !held {
            return Ok(None);
        }
        if !has_pending_work(state.as_ref()) {
            if held {
                release_mutex(cx)?;
            }
            if state.is_some() {
                clear_state(cx)?;
            }
            if let Err(e) = sync_resume_notification(cx, 0, 0, true) {
                super::diag::log_warn(format!(
                    "[SyncResume] Failed to raise stale-heal notification: {e}"
                ));
            }
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "scheduled_sync",
                "ok",
                None,
                Some("Cleared stuck App Store sync lock from a previous server run"),
                Some(&json!({ "mode": "bulk-stale-healed" })),
                cx.now,
            );
            return Ok(None);
        }
        let state = state.expect("pending work needs a blob");
        let summary = summarise(&state);
        if let Err(e) =
            sync_resume_notification(cx, summary.remaining as i64, summary.total as i64, false)
        {
            super::diag::log_warn(format!(
                "[SyncResume] Failed to raise resume notification: {e}"
            ));
        }
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "scheduled_sync",
            "ok",
            None,
            Some(&format!(
                "App Store sync resumed after server restart — {} of {} app{} left",
                summary.remaining,
                summary.total,
                if summary.total == 1 { "" } else { "s" }
            )),
            Some(&json!({
                "mode": "bulk-resume-start",
                "runId": state.run_id,
                "remaining": summary.remaining,
                "total": summary.total,
            })),
            cx.now,
        );
        Ok(Some(state))
    })?;
    if let Some(state) = resume {
        if let Err(e) = run_bulk_sync(db, fetcher, ids, clock, "resume", Some(state)).await {
            super::diag::log_error(format!("[SyncResume] Resumed run failed: {e}"));
        }
    }
    Ok(())
}

/// The boot writes now, then the tickers `register()` arms: the Wayback
/// resume once at 8 s, the sync resume once at 10 s, the policy-sync
/// resume once at 12 s, the scheduler check
/// at 15 s and every 30 minutes, the import-queue drain at 20 s and every
/// minute, the health check at 60 s and daily.
///
/// Every timer sleeps until its next tick OR until `stop` fires, and then
/// ends; a tick that panics is logged and its loop carries on (see
/// lifecycle.rs). A tick already running when `stop` fires finishes, or is
/// dropped with the runtime; either way its writes are whole transactions.
pub(crate) fn start_background(state: AppState, stop: CancellationToken) {
    let desktop = crate::host_env::var("PRIVACYTRACKER_RUNTIME").is_ok_and(|v| v == "desktop");
    boot(&mut state.db_access(), Live.now(), desktop);

    // What the deferred policy fetch's timer runs with, its stop included.
    let conn = state.conn.clone();
    let timer_stop = stop.clone();
    super::policy_triggers::install(Box::new(move || super::policy_triggers::Handles {
        db: Box::new(crate::scrape::persist::Shared {
            conn: conn.clone(),
            log: None,
            on_wait: Some(super::diag::record_lock_wait),
        }),
        fetcher: Arc::new(PublicHttp),
        ids: Box::new(RandomIds),
        clock: Arc::new(Live),
        stop: timer_stop.clone(),
    }));

    let (wayback_state, wayback_stop) = (state.clone(), stop.clone());
    tokio::spawn(async move {
        if sleep_or_stop(&wayback_stop, Duration::from_secs(8)).await {
            return;
        }
        isolate("WaybackResume", async {
            let mut ids = RandomIds;
            let mut db = wayback_state.db_access();
            if let Err(e) =
                super::wayback_runner::resume_wayback_import(&mut db, &PublicHttp, &mut ids, &Live)
                    .await
            {
                super::diag::log_error(format!("[WaybackResume] Startup check failed: {e}"));
            }
        })
        .await;
    });

    let (resume_state, resume_stop) = (state.clone(), stop.clone());
    tokio::spawn(async move {
        if sleep_or_stop(&resume_stop, Duration::from_secs(10)).await {
            return;
        }
        isolate("SyncResume", async {
            let mut ids = RandomIds;
            let mut db = resume_state.db_access();
            if let Err(e) = resume_app_store_sync(&mut db, &PublicHttp, &mut ids, &Live).await {
                super::diag::log_error(format!("[SyncResume] Startup check failed: {e}"));
            }
        })
        .await;
    });

    let (policy_state, policy_stop) = (state.clone(), stop.clone());
    tokio::spawn(async move {
        if sleep_or_stop(&policy_stop, Duration::from_secs(12)).await {
            return;
        }
        isolate("PolicyResume", async {
            let mut ids = RandomIds;
            let mut db = policy_state.db_access();
            let follow_ups =
                super::policy_runner::resume_policy_sync(&mut db, &PublicHttp, &mut ids, &Live)
                    .await;
            for follow_up in follow_ups {
                super::policy_store::run_follow_ups(&mut db, &PublicHttp, &Live, follow_up).await;
            }
        })
        .await;
    });

    let (scheduler_state, scheduler_stop) = (state.clone(), stop.clone());
    tokio::spawn(async move {
        let mut sched = Scheduler::default();
        if sleep_or_stop(&scheduler_stop, Duration::from_secs(15)).await {
            return;
        }
        loop {
            isolate("Scheduler", async {
                let mut ids = RandomIds;
                let mut db = scheduler_state.db_access();
                scheduled_check(&mut sched, &mut db, &PublicHttp, &mut ids, &Live).await;
            })
            .await;
            if sleep_or_stop(&scheduler_stop, CHECK_INTERVAL).await {
                return;
            }
        }
    });

    let (health_state, health_stop) = (state.clone(), stop.clone());
    tokio::spawn(async move {
        // After the resume healers, so a freshly-resumed run is never
        // mistaken for a dead lock.
        if sleep_or_stop(&health_stop, Duration::from_secs(60)).await {
            return;
        }
        loop {
            isolate("HealthCheck", async {
                let mut ids = RandomIds;
                let mut db = health_state.db_access();
                super::health_check::tick_health_check(&mut db, &mut ids, Live.now());
            })
            .await;
            if sleep_or_stop(&health_stop, HEALTH_CHECK_INTERVAL).await {
                return;
            }
        }
    });

    let (snapshot_state, snapshot_stop) = (state.clone(), stop.clone());
    tokio::spawn(async move {
        // The helper owns the interval and the retention; this only wakes
        // up on the scheduler's cadence and asks whether one is due.
        if sleep_or_stop(&snapshot_stop, Duration::from_secs(35)).await {
            return;
        }
        loop {
            isolate("BackupSnapshots", async {
                let mut ids = RandomIds;
                let mut db = snapshot_state.db_access();
                super::backup_snapshots::tick_backup_snapshots(&mut db, &mut ids, Live.now());
            })
            .await;
            if sleep_or_stop(&snapshot_stop, CHECK_INTERVAL).await {
                return;
            }
        }
    });

    let (webhook_state, webhook_stop) = (state.clone(), stop.clone());
    tokio::spawn(async move {
        // Offset from the snapshot tick so the two do not fight for the
        // boot window; after that both fire on the scheduler's cadence.
        // A no-op unless a webhook is configured for a daily or weekly
        // summary, and self-limited through its cursor after that.
        if sleep_or_stop(&webhook_stop, Duration::from_secs(45)).await {
            return;
        }
        loop {
            isolate("Webhook", async {
                let mut db = webhook_state.db_access();
                super::webhook_writes::tick_webhook_summary(&mut db, &PublicHttp, Live.now()).await;
            })
            .await;
            if sleep_or_stop(&webhook_stop, CHECK_INTERVAL).await {
                return;
            }
        }
    });

    let (update_state, update_stop) = (state.clone(), stop.clone());
    tokio::spawn(async move {
        // Every six hours it ASKS; the day's cache means GitHub is fetched
        // about once a day whatever the restart cadence.
        if sleep_or_stop(&update_stop, Duration::from_secs(25)).await {
            return;
        }
        loop {
            isolate("UpdateCheck", async {
                let mut db = update_state.db_access();
                super::update_check::tick_update_check(&mut db, &PublicHttp, Live.now()).await;
            })
            .await;
            if sleep_or_stop(&update_stop, UPDATE_CHECK_INTERVAL).await {
                return;
            }
        }
    });

    tokio::spawn(async move {
        if sleep_or_stop(&stop, Duration::from_secs(20)).await {
            return;
        }
        loop {
            isolate("ImportQueue", async {
                let mut ids = RandomIds;
                let mut db = state.db_access();
                if let Err(e) = super::imports_writes::run_import_queue_tick(
                    &mut db,
                    &mut ids,
                    Live.now(),
                    &PublicHttp,
                )
                .await
                {
                    super::diag::log_error(format!("[ImportQueue] Tick failed: {e}"));
                }
            })
            .await;
            if sleep_or_stop(&stop, IMPORT_QUEUE_INTERVAL).await {
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_entries_serialise_in_creation_order_without_undefined_keys() {
        let mut entry = QueueEntry {
            app_id: "1".into(),
            app_name: "One".into(),
            url: Some("u".into()),
            status: "in_progress".into(),
            started_at: Some(5),
            finished_at: None,
            error: None,
            outcome: None,
            changes_detected: None,
        };
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            r#"{"appId":"1","appName":"One","url":"u","status":"in_progress","startedAt":5}"#
        );
        // The rate-limit branch assigns outcome before error, but the keys
        // were created finishedAt, error, outcome when the entry went in
        // flight — and that is the order JSON.stringify emits.
        entry.status = "failed".into();
        entry.finished_at = Some(6);
        entry.outcome = Some("rate_limited".into());
        entry.error = Some("429".into());
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            r#"{"appId":"1","appName":"One","url":"u","status":"failed","startedAt":5,"finishedAt":6,"error":"429","outcome":"rate_limited"}"#
        );
    }

    #[test]
    fn summary_line_matches_node() {
        let t = Totals {
            attempted: 2,
            succeeded: 1,
            changes: 1,
            failed: 1,
            rate_limited: 0,
            skipped: 0,
        };
        assert_eq!(bulk_summary_line(&t), "1/2 synced, 1 change, 1 error");
        let t = Totals {
            attempted: 0,
            succeeded: 0,
            changes: 0,
            failed: 0,
            rate_limited: 3,
            skipped: 2,
        };
        assert_eq!(
            bulk_summary_line(&t),
            "0/0 synced, 0 changes, 3 rate-limited, 2 skipped"
        );
    }
}

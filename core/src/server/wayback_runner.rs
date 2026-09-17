//! Phase 4, batch 4b: the bulk Wayback import — `lib/wayback-bulk-runner.ts`
//! and `lib/wayback-bulk-state.ts`, plus the boot-time resume in
//! `instrumentation.ts`. The routes over it live in `runner_writes.rs`.
//!
//! The run outlives its request: `POST ?stream=1` and `PATCH resume`
//! spawn it, so it owns its accessor, fetcher, ids and clock (the
//! `detach`/`shared` hooks on those traits hand out owned copies), and
//! its frames go down an unbounded channel the response streams. Its
//! state blob is a JSON object that Node mutates key by key — `undefined`
//! assignments create keys that `JSON.stringify` then omits — so it is
//! kept as a `Value` with an undefined sentinel and stripped on write,
//! which reproduces the key order of every path, resumed blobs included.
//!
//! Cancellation is a token per run: the PATCH cancels it, and the runner
//! selects on it around the archive walk and the backoff sleep, dropping
//! the in-flight request the way Node's `AbortController` does. Gated by
//! `core/tests/fixtures/wayback-runner-cases.json`, replayed by
//! `wayback_runner_tests`.
use super::{
    activity_log::{record_activity, record_activity_named},
    flags::{context_from_db, resolve_flag},
    guard::{record_audit, Actor},
    imports_writes::summary_line,
    sync_runner::Clock,
    writes::Cx,
};
use crate::{
    jsstr::js_slice_prefix,
    outbound::Fetcher,
    scrape::{
        import_app_history, notify,
        persist::{DbAccess, Ids},
        AppRow, HistoryOptions,
    },
};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

pub(crate) const STATE_KEY: &str = "wayback_bulk_state";
pub(crate) const MUTEX_KEY: &str = "wayback_import_running";
const STATE_SCHEMA_VERSION: i64 = 2;
const CLEAR_STATE: &str = "DELETE FROM app_settings WHERE key = ?";
const INSERT_NOTIFICATION: &str = "\n    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)\n    VALUES (?, ?, ?, ?, ?, 0)\n  ";
const WAYBACK_RESUME_NOTIFICATION_APP_ID: &str = "__wayback_resume__";
const MAX_RATE_LIMIT_RETRIES: u32 = 1;
const RATE_LIMIT_MIN_BACKOFF_MS: i64 = 1_000;
const RATE_LIMIT_DEFAULT_BACKOFF_MS: i64 = 30_000;
const RATE_LIMIT_MAX_BACKOFF_MS: i64 = 120_000;

// ── The state blob as JavaScript sees it ─────────────────────────────

const UNDEFINED: &str = "\u{0}undefined\u{0}";

/// An `undefined` assignment: the key exists and serialises to nothing.
pub(crate) fn undefined() -> Value {
    Value::String(UNDEFINED.to_string())
}

fn is_undefined(v: &Value) -> bool {
    v.as_str() == Some(UNDEFINED)
}

fn strip_undefined(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(_, v)| !is_undefined(v))
                .map(|(k, v)| (k.clone(), strip_undefined(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(strip_undefined).collect()),
        other => other.clone(),
    }
}

/// `JSON.stringify`.
pub(crate) fn stringify(v: &Value) -> String {
    strip_undefined(v).to_string()
}

/// `obj.key = value`: in place when present, appended when new.
pub(crate) fn set(obj: &mut Value, key: &str, value: Value) {
    if let Some(m) = obj.as_object_mut() {
        m.insert(key.to_string(), value);
    }
}

/// `obj.key`, an undefined-valued key reading as absent.
pub(crate) fn get<'a>(obj: &'a Value, key: &str) -> Option<&'a Value> {
    obj.get(key).filter(|v| !is_undefined(v))
}

fn str_of<'a>(obj: &'a Value, key: &str) -> &'a str {
    get(obj, key).and_then(Value::as_str).unwrap_or("")
}

fn int_of(obj: &Value, key: &str) -> i64 {
    get(obj, key).and_then(Value::as_i64).unwrap_or(0)
}

fn normalise_run_status(raw: Option<&Value>) -> &'static str {
    match raw.and_then(Value::as_str) {
        Some("pause_requested") => "pause_requested",
        Some("paused") => "paused",
        Some("cancel_requested") => "cancel_requested",
        _ => "running",
    }
}

/// `readBulkState`: absent, unparseable, an unknown version or a missing
/// field all read as nothing; a v1 blob is upgraded on read.
pub(crate) fn read_bulk_state(cx: &Cx) -> Option<Value> {
    let raw = cx.get(STATE_KEY, "");
    if raw.is_empty() {
        return None;
    }
    let mut parsed: Value = serde_json::from_str(&raw).ok()?;
    if !parsed.is_object()
        || !(parsed["version"] == json!(1) || parsed["version"] == json!(STATE_SCHEMA_VERSION))
        || !parsed["runId"].is_string()
        || !parsed["queue"].is_array()
    {
        return None;
    }
    let status = normalise_run_status(parsed.get("status"));
    set(&mut parsed, "version", json!(STATE_SCHEMA_VERSION));
    set(&mut parsed, "status", json!(status));
    Some(parsed)
}

/// `writeBulkState`: the version, a normalised status and `updatedAt`,
/// each in place when the blob already has the key.
pub(crate) fn write_bulk_state(cx: &mut Cx, next: &Value) -> Result<(), String> {
    let mut payload = next.clone();
    let status = normalise_run_status(get(next, "status"));
    set(&mut payload, "version", json!(STATE_SCHEMA_VERSION));
    set(&mut payload, "status", json!(status));
    set(&mut payload, "updatedAt", json!(cx.now));
    cx.set(STATE_KEY, &stringify(&payload))
}

pub(crate) fn clear_bulk_state(cx: &mut Cx) -> Result<(), String> {
    cx.w.run(CLEAR_STATE, vec![json!(STATE_KEY)]).map(drop)
}

pub(crate) fn mutex_held(cx: &Cx) -> bool {
    cx.get(MUTEX_KEY, "") == "true"
}

fn acquire_mutex(cx: &mut Cx) -> Result<bool, String> {
    if mutex_held(cx) {
        return Ok(false);
    }
    cx.set(MUTEX_KEY, "true")?;
    Ok(true)
}

pub(crate) fn release_mutex(cx: &mut Cx) -> Result<(), String> {
    cx.set(MUTEX_KEY, "false")
}

/// `summariseState`.
pub(crate) fn summarise(state: &Value) -> Value {
    let (mut pending, mut in_progress, mut done, mut failed) = (0, 0, 0, 0);
    let queue = state["queue"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    for entry in queue {
        match str_of(entry, "status") {
            "pending" => pending += 1,
            "in_progress" => in_progress += 1,
            "done" => done += 1,
            "failed" => failed += 1,
            _ => {}
        }
    }
    json!({
        "total": queue.len(),
        "pending": pending,
        "inProgress": in_progress,
        "done": done,
        "failed": failed,
        "remaining": pending + in_progress,
    })
}

pub(crate) fn has_pending_work(state: Option<&Value>) -> bool {
    state.is_some_and(|s| {
        s["queue"].as_array().is_some_and(|q| {
            q.iter()
                .any(|e| matches!(str_of(e, "status"), "pending" | "in_progress"))
        })
    })
}

fn is_paused(state: Option<&Value>) -> bool {
    state.is_some_and(|s| matches!(str_of(s, "status"), "paused" | "pause_requested"))
}

fn is_cancel_requested(state: Option<&Value>) -> bool {
    state.is_some_and(|s| str_of(s, "status") == "cancel_requested")
}

pub(crate) fn zero_totals() -> Value {
    json!({
        "appsAttempted": 0,
        "appsWithImports": 0,
        "targetsAttempted": 0,
        "imported": 0,
        "unchanged": 0,
        "skipped": 0,
        "failed": 0,
        "snapshotsRequested": 0,
    })
}

// ── The cancellation registry ────────────────────────────────────────

struct Active {
    tag: u64,
    token: CancellationToken,
}

fn active_runs() -> &'static Mutex<HashMap<String, Active>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Active>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_TAG: AtomicU64 = AtomicU64::new(1);

/// `requestActiveBulkWaybackCancel`: the run with that id, or every run
/// when none is named. True when something was told to stop.
pub(crate) fn request_active_cancel(run_id: Option<&str>) -> bool {
    let runs = active_runs().lock().expect("run registry poisoned");
    match run_id.filter(|id| !id.is_empty()) {
        Some(id) => match runs.get(id) {
            Some(active) => {
                active.token.cancel();
                true
            }
            None => false,
        },
        None => {
            let mut aborted = false;
            for active in runs.values() {
                active.token.cancel();
                aborted = true;
            }
            aborted
        }
    }
}

// ── lib/wayback-bulk-runner.ts ───────────────────────────────────────

/// `buildInitialQueue`: every app with a URL, by name.
pub(crate) fn build_initial_queue(cx: &Cx) -> Result<Vec<Value>, String> {
    let rows = super::stats::query(
        cx.w.conn,
        "SELECT id, url, name
         FROM apps
        WHERE url IS NOT NULL AND TRIM(url) != ''
        ORDER BY name COLLATE NOCASE ASC",
        &[],
    )
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| json!({"appId": r["id"], "appName": r["name"], "status": "pending"}))
        .collect())
}

fn lookup_app_row(cx: &Cx, app_id: &str) -> Result<Option<AppRow>, String> {
    let rows = super::stats::query(
        cx.w.conn,
        "SELECT id, url, name FROM apps WHERE id = ?",
        &[rusqlite::types::Value::Text(app_id.to_string())],
    )
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().next().map(|r| AppRow {
        id: r["id"].as_str().unwrap_or("").to_string(),
        name: r["name"].as_str().unwrap_or("").to_string(),
        url: r["url"].as_str().unwrap_or("").to_string(),
    }))
}

pub(crate) fn rate_limit_backoff_ms(retry_after_ms: Option<i64>) -> i64 {
    retry_after_ms
        .unwrap_or(RATE_LIMIT_DEFAULT_BACKOFF_MS)
        .clamp(RATE_LIMIT_MIN_BACKOFF_MS, RATE_LIMIT_MAX_BACKOFF_MS)
}

fn accumulate_totals(totals: &mut Value, result: &Value) {
    let add = |totals: &mut Value, key: &str, by: i64| {
        let current = int_of(totals, key);
        set(totals, key, json!(current + by));
    };
    add(totals, "targetsAttempted", int_of(result, "attempted"));
    add(totals, "imported", int_of(result, "imported"));
    add(totals, "unchanged", int_of(result, "unchanged"));
    add(totals, "skipped", int_of(result, "skipped"));
    add(totals, "failed", int_of(result, "failed"));
    add(
        totals,
        "snapshotsRequested",
        int_of(result, "snapshotsRequested"),
    );
    if int_of(result, "imported") > 0 {
        add(totals, "appsWithImports", 1);
    }
}

fn build_bulk_summary(totals: &Value, initiator: &str, queue_length: usize) -> String {
    let mut parts = vec![format!("{} imported", int_of(totals, "imported"))];
    if int_of(totals, "unchanged") != 0 {
        parts.push(format!("{} no-op", int_of(totals, "unchanged")));
    }
    if int_of(totals, "skipped") != 0 {
        parts.push(format!("{} skipped", int_of(totals, "skipped")));
    }
    if int_of(totals, "failed") != 0 {
        parts.push(format!("{} failed", int_of(totals, "failed")));
    }
    let requested = int_of(totals, "snapshotsRequested");
    if requested != 0 {
        parts.push(format!(
            "{requested} snapshot{} requested",
            if requested == 1 { "" } else { "s" }
        ));
    }
    let prefix = if initiator == "resume" {
        "Wayback import (resumed)"
    } else {
        "Wayback import"
    };
    js_slice_prefix(
        &format!("{prefix} across {queue_length} apps: {}", parts.join(", ")),
        200,
    )
}

fn pick_app_activity_status(result: &Value) -> &'static str {
    if int_of(result, "failed") == 0 {
        "ok"
    } else if int_of(result, "imported") > 0 || int_of(result, "unchanged") > 0 {
        "partial"
    } else {
        "error"
    }
}

/// The NDJSON sink: frames are dropped when nobody is streaming.
pub(crate) type Writer = Option<UnboundedSender<Value>>;

fn emit(writer: &Writer, frame: Value) {
    if let Some(tx) = writer {
        let _ = tx.send(frame);
    }
}

fn frame(kind: &str, fields: Value) -> Value {
    let mut out = Map::new();
    out.insert("type".into(), json!(kind));
    if let Some(m) = fields.as_object() {
        for (k, v) in m {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

pub(crate) struct RunOptions {
    pub initiator: &'static str,
    pub resume_state: Option<Value>,
    pub stream_requested: bool,
    pub writer: Writer,
    pub actor_ip: Option<String>,
    pub user_agent: Option<String>,
}

pub(crate) struct RunResult {
    pub totals: Value,
    pub duration_ms: i64,
}

fn audit_actor(options: &RunOptions) -> Actor {
    Actor {
        ip: options.actor_ip.clone().unwrap_or_default(),
        user_agent: options.user_agent.clone(),
    }
}

/// What the archive walk of one app came back with.
enum Walked {
    Done(Value),
    Failed(String),
    Unavailable {
        message: String,
        retry_after_ms: Option<i64>,
    },
    Aborted,
}

/// `runBulkWaybackImport`. Errors are what the outer catch rethrows, with
/// the state and mutex left in place for the next boot.
pub(crate) async fn run_bulk_wayback_import(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    options: RunOptions,
) -> Result<RunResult, String> {
    let writer = options.writer.clone();
    let token = CancellationToken::new();
    let tag = NEXT_TAG.fetch_add(1, Ordering::SeqCst);

    // The seed, the mutex, the batch frame: one section before any await.
    let now = clock.now();
    let mut state: Value = match options.resume_state.clone() {
        Some(mut state) => {
            if let Some(queue) = state["queue"].as_array_mut() {
                for entry in queue {
                    if str_of(entry, "status") == "in_progress" {
                        set(entry, "status", json!("pending"));
                    }
                }
            }
            state
        }
        None => Value::Null,
    };
    let seeded = db.with(|w| -> Result<(), String> {
        let cx = &mut Cx { w, ids, now };
        if state.is_null() {
            let queue = build_initial_queue(cx)?;
            state = json!({
                "version": 1,
                "runId": cx.ids.uuid(cx.w.conn)?,
                "startedAt": cx.now,
                "initiator": options.initiator,
                "updatedAt": cx.now,
                "currentAppId": Value::Null,
                "status": "running",
                "queue": queue,
                "totals": zero_totals(),
                "streamRequested": options.stream_requested,
            });
        }
        set(&mut state, "status", json!("running"));
        set(&mut state, "pausedAt", undefined());
        set(&mut state, "pauseCause", undefined());
        set(&mut state, "pauseRequestedAt", undefined());
        set(&mut state, "cancelRequestedAt", undefined());
        acquire_mutex(cx)?;
        write_bulk_state(cx, &state)
    });
    seeded?;
    let run_id = str_of(&state, "runId").to_string();
    active_runs().lock().expect("run registry poisoned").insert(
        run_id.clone(),
        Active {
            tag,
            token: token.clone(),
        },
    );
    let run_started_at = clock.now();
    let queue_len = state["queue"].as_array().map_or(0, Vec::len);
    emit(
        &writer,
        frame(
            "batch-start",
            json!({
                "total": queue_len,
                "startedAt": state["startedAt"],
                "initiator": state["initiator"],
                "runId": run_id,
            }),
        ),
    );

    let outcome = walk(
        db,
        fetcher,
        ids,
        clock,
        &options,
        &writer,
        &token,
        &mut state,
        run_started_at,
    )
    .await;
    {
        let mut runs = active_runs().lock().expect("run registry poisoned");
        if runs.get(&run_id).is_some_and(|a| a.tag == tag) {
            runs.remove(&run_id);
        }
    }
    match outcome {
        Ok(result) => Ok(result),
        Err(message) => {
            // The outer catch: the frame and the rows, then the rethrow with
            // the state and mutex left for the next boot.
            emit(&writer, frame("error", json!({ "error": message })));
            let now = clock.now();
            db.with(|w| {
                let cx = &mut Cx { w, ids, now };
                record_activity(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback_import",
                    "error",
                    None,
                    Some(&js_slice_prefix(
                        &format!("Bulk Wayback import aborted: {message}"),
                        200,
                    )),
                    Some(&json!({
                        "mode": "bulk",
                        "errorMessage": message,
                        "totals": state["totals"],
                        "runId": state["runId"],
                    })),
                    int_of(&state, "startedAt"),
                );
                record_audit(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback.import.bulk.failed",
                    &audit_actor(&options),
                    Some(&js_slice_prefix(&message, 200)),
                    false,
                );
            });
            Err(message)
        }
    }
}

/// The per-app loop and the clean completion.
#[allow(clippy::too_many_arguments)]
async fn walk(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    options: &RunOptions,
    writer: &Writer,
    token: &CancellationToken,
    state: &mut Value,
    run_started_at: i64,
) -> Result<RunResult, String> {
    let queue_len = state["queue"].as_array().map_or(0, Vec::len);
    let mut rate_limit_retries = 0u32;
    let mut i = 0usize;
    while i < queue_len {
        let index = i;
        i += 1;
        let status = str_of(&state["queue"][index], "status").to_string();
        if status == "done" || status == "failed" {
            continue;
        }
        // The pre-app control check, the in-flight mark, its persist and
        // the app row: no await between them.
        let now = clock.now();
        let app = db.with(|w| -> Result<Result<Option<AppRow>, RunResult>, String> {
            let cx = &mut Cx { w, ids, now };
            if let Some(finished) =
                finish_if_control_requested(cx, state, writer, run_started_at, options)?
            {
                return Ok(Err(finished));
            }
            let entry = &mut state["queue"][index];
            set(entry, "status", json!("in_progress"));
            set(entry, "startedAt", json!(cx.now));
            set(entry, "finishedAt", undefined());
            set(entry, "error", undefined());
            let app_id = str_of(entry, "appId").to_string();
            let app_name = str_of(entry, "appName").to_string();
            set(state, "currentAppId", json!(app_id));
            let attempted = int_of(&state["totals"], "appsAttempted");
            set(&mut state["totals"], "appsAttempted", json!(attempted + 1));
            write_bulk_state(cx, state)?;
            emit(
                writer,
                frame(
                    "app-start",
                    json!({ "appId": app_id, "name": app_name, "index": index, "total": queue_len }),
                ),
            );
            let app = lookup_app_row(cx, &app_id)?;
            let Some(app) = app.filter(|a| !a.url.is_empty()) else {
                let missing = "App no longer has a URL — may have been deleted.";
                let entry = &mut state["queue"][index];
                set(entry, "status", json!("failed"));
                set(entry, "finishedAt", json!(cx.now));
                set(entry, "error", json!(missing));
                let failed = int_of(&state["totals"], "failed");
                set(&mut state["totals"], "failed", json!(failed + 1));
                set(state, "currentAppId", Value::Null);
                write_bulk_state(cx, state)?;
                emit(
                    writer,
                    frame(
                        "app-done",
                        json!({ "appId": app_id, "name": app_name, "index": index, "total": queue_len, "error": missing }),
                    ),
                );
                return Ok(Ok(None));
            };
            Ok(Ok(Some(app)))
        })?;
        let app = match app {
            Err(finished) => return Ok(finished),
            Ok(None) => continue,
            Ok(Some(app)) => app,
        };

        // The archive walk, with the lock taken per section inside and the
        // cancellation token watched throughout.
        let walked = {
            let mut sink = |event: Value| emit(writer, frame("target", event));
            let options_for_app = HistoryOptions::default();
            let import = import_app_history(
                db,
                fetcher,
                &app,
                &options_for_app,
                clock.now(),
                ids,
                Some(&mut sink),
            );
            tokio::select! {
                biased;
                _ = token.cancelled() => Walked::Aborted,
                result = import => match result {
                    Ok(result) => Walked::Done(result),
                    Err(error) => match error.unavailable {
                        Some(u) => Walked::Unavailable { message: u.message, retry_after_ms: u.retry_after_ms },
                        None => Walked::Failed(error.message),
                    },
                },
            }
        };

        let now = clock.now();
        let app_id = app.id.clone();
        let app_name = app.name.clone();
        let resumed = str_of(state, "initiator") == "resume";
        match walked {
            Walked::Aborted => {
                set(state, "currentAppId", Value::Null);
                let finished = db.with(|w| {
                    let cx = &mut Cx { w, ids, now };
                    finish_if_control_requested(cx, state, writer, run_started_at, options)
                })?;
                if let Some(finished) = finished {
                    return Ok(finished);
                }
                return Err("This operation was aborted".to_string());
            }
            Walked::Unavailable {
                message,
                retry_after_ms,
            } => {
                // Nothing is wrong with the app — the archive refused us.
                let delay_ms = db.with(|w| -> Result<Option<i64>, String> {
                    let cx = &mut Cx { w, ids, now };
                    let entry = &mut state["queue"][index];
                    set(entry, "status", json!("pending"));
                    set(entry, "finishedAt", undefined());
                    set(entry, "error", json!(js_slice_prefix(&message, 200)));
                    set(state, "currentAppId", Value::Null);
                    let attempted = int_of(&state["totals"], "appsAttempted");
                    set(&mut state["totals"], "appsAttempted", json!((attempted - 1).max(0)));
                    write_bulk_state(cx, state)?;
                    if rate_limit_retries < MAX_RATE_LIMIT_RETRIES {
                        rate_limit_retries += 1;
                        let delay_ms = rate_limit_backoff_ms(retry_after_ms);
                        emit(
                            writer,
                            frame(
                                "backoff",
                                json!({ "appId": app_id, "name": app_name, "delayMs": delay_ms, "reason": message }),
                            ),
                        );
                        let started_at = get(&state["queue"][index], "startedAt")
                            .and_then(Value::as_i64)
                            .unwrap_or(cx.now);
                        record_activity_named(
                            cx.w,
                            cx.ids,
                            cx.now,
                            "wayback_import",
                            "partial",
                            Some(&app_id),
                            Some(&app_name),
                            Some(&js_slice_prefix(
                                &format!(
                                    "archive.org throttled the Wayback import — waiting {}s before retrying {app_name}",
                                    (delay_ms + 999) / 1000
                                ),
                                200,
                            )),
                            Some(&json!({
                                "mode": "bulk-backoff",
                                "delayMs": delay_ms,
                                "errorMessage": message,
                                "resumedRun": resumed,
                            })),
                            started_at,
                        );
                        Ok(Some(delay_ms))
                    } else {
                        Ok(None)
                    }
                })?;
                match delay_ms {
                    Some(delay_ms) => {
                        let slept = tokio::select! {
                            biased;
                            _ = token.cancelled() => false,
                            _ = tokio::time::sleep(Duration::from_millis(delay_ms as u64)) => true,
                        };
                        if !slept {
                            let now = clock.now();
                            let finished = db.with(|w| {
                                let cx = &mut Cx { w, ids, now };
                                finish_if_control_requested(
                                    cx,
                                    state,
                                    writer,
                                    run_started_at,
                                    options,
                                )
                            })?;
                            if let Some(finished) = finished {
                                return Ok(finished);
                            }
                            return Err("Wayback import cancelled".to_string());
                        }
                        // Re-run this app; the pre-app check still fires.
                        i = index;
                        continue;
                    }
                    None => {
                        let now = clock.now();
                        return db.with(|w| {
                            let cx = &mut Cx { w, ids, now };
                            pause_run(
                                cx,
                                state,
                                writer,
                                run_started_at,
                                options,
                                "rate_limited",
                                Some(&message),
                            )
                        });
                    }
                }
            }
            Walked::Done(result) => {
                rate_limit_retries = 0;
                let finished = db.with(|w| -> Result<Option<RunResult>, String> {
                    let cx = &mut Cx { w, ids, now };
                    accumulate_totals(&mut state["totals"], &result);
                    let entry = &mut state["queue"][index];
                    set(entry, "status", json!("done"));
                    set(entry, "finishedAt", json!(cx.now));
                    set(entry, "imported", result["imported"].clone());
                    set(entry, "unchanged", result["unchanged"].clone());
                    set(entry, "skipped", result["skipped"].clone());
                    set(entry, "failed", result["failed"].clone());
                    set(
                        entry,
                        "snapshotsRequested",
                        json!(int_of(&result, "snapshotsRequested")),
                    );
                    let started_at = get(entry, "startedAt")
                        .and_then(Value::as_i64)
                        .unwrap_or(cx.now);
                    set(state, "currentAppId", Value::Null);
                    write_bulk_state(cx, state)?;
                    record_activity_named(
                        cx.w,
                        cx.ids,
                        cx.now,
                        "wayback_import",
                        pick_app_activity_status(&result),
                        Some(&app_id),
                        Some(&app_name),
                        Some(&summary_line(&app_name, &result, false)),
                        Some(&json!({ "mode": "bulk-app", "result": result, "resumedRun": resumed })),
                        started_at,
                    );
                    emit(
                        writer,
                        frame(
                            "app-done",
                            json!({ "appId": app_id, "name": app_name, "index": index, "total": queue_len, "result": result }),
                        ),
                    );
                    finish_if_control_requested(cx, state, writer, run_started_at, options)
                })?;
                if let Some(finished) = finished {
                    return Ok(finished);
                }
            }
            Walked::Failed(message) => {
                let finished = db.with(|w| -> Result<Option<RunResult>, String> {
                    let cx = &mut Cx { w, ids, now };
                    let entry = &mut state["queue"][index];
                    set(entry, "status", json!("failed"));
                    set(entry, "finishedAt", json!(cx.now));
                    set(entry, "error", json!(js_slice_prefix(&message, 200)));
                    let started_at = get(entry, "startedAt")
                        .and_then(Value::as_i64)
                        .unwrap_or(cx.now);
                    let failed = int_of(&state["totals"], "failed");
                    set(&mut state["totals"], "failed", json!(failed + 1));
                    set(state, "currentAppId", Value::Null);
                    write_bulk_state(cx, state)?;
                    record_activity_named(
                        cx.w,
                        cx.ids,
                        cx.now,
                        "wayback_import",
                        "error",
                        Some(&app_id),
                        Some(&app_name),
                        Some(&js_slice_prefix(
                            &format!("Wayback import failed for {app_name}: {message}"),
                            200,
                        )),
                        Some(&json!({ "mode": "bulk-app", "errorMessage": message, "resumedRun": resumed })),
                        started_at,
                    );
                    emit(
                        writer,
                        frame(
                            "app-done",
                            json!({ "appId": app_id, "name": app_name, "index": index, "total": queue_len, "error": message }),
                        ),
                    );
                    finish_if_control_requested(cx, state, writer, run_started_at, options)
                })?;
                if let Some(finished) = finished {
                    return Ok(finished);
                }
            }
        }
    }

    // Clean completion: the summary frame and rows, then the state and
    // mutex cleared.
    let now = clock.now();
    db.with(|w| {
        let cx = &mut Cx { w, ids, now };
        let duration_ms = cx.now - run_started_at;
        let totals = state["totals"].clone();
        emit(
            writer,
            frame(
                "summary",
                json!({ "totals": totals, "durationMs": duration_ms }),
            ),
        );
        let initiator = str_of(state, "initiator").to_string();
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "wayback_import",
            if int_of(&totals, "failed") > 0 {
                "partial"
            } else {
                "ok"
            },
            None,
            Some(&build_bulk_summary(&totals, &initiator, queue_len)),
            Some(&json!({
                "mode": if initiator == "resume" { "bulk-resumed" } else { "bulk" },
                "totals": totals,
                "runId": state["runId"],
            })),
            int_of(state, "startedAt"),
        );
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            if initiator == "resume" {
                "wayback.import.bulk.resumed.success"
            } else {
                "wayback.import.bulk.success"
            },
            &audit_actor(options),
            Some(&format!(
                "apps={queue_len} imported={} unchanged={} skipped={} failed={}",
                int_of(&totals, "imported"),
                int_of(&totals, "unchanged"),
                int_of(&totals, "skipped"),
                int_of(&totals, "failed")
            )),
            true,
        );
        clear_bulk_state(cx)?;
        release_mutex(cx)?;
        Ok(RunResult {
            totals,
            duration_ms,
        })
    })
}

/// `syncControlStatusFromDisk`: a pause or cancel the PATCH wrote for
/// this run is copied onto the in-memory state.
fn sync_control_status_from_disk(cx: &Cx, state: &mut Value) {
    let Some(persisted) = read_bulk_state(cx) else {
        return;
    };
    if persisted["runId"] != state["runId"] {
        return;
    }
    let status = str_of(&persisted, "status");
    if status == "pause_requested" || status == "cancel_requested" {
        set(state, "status", json!(status));
        set(
            state,
            "pauseRequestedAt",
            get(&persisted, "pauseRequestedAt")
                .cloned()
                .unwrap_or_else(undefined),
        );
        set(
            state,
            "cancelRequestedAt",
            get(&persisted, "cancelRequestedAt")
                .cloned()
                .unwrap_or_else(undefined),
        );
    }
}

/// `finishIfControlRequested`: the pause or the cancel at an app boundary.
fn finish_if_control_requested(
    cx: &mut Cx,
    state: &mut Value,
    writer: &Writer,
    run_started_at: i64,
    options: &RunOptions,
) -> Result<Option<RunResult>, String> {
    sync_control_status_from_disk(cx, state);
    match str_of(state, "status") {
        "pause_requested" => {
            pause_run(cx, state, writer, run_started_at, options, "user", None).map(Some)
        }
        "cancel_requested" => {
            let duration_ms = cx.now - run_started_at;
            let summary = summarise(state);
            let remaining = int_of(&summary, "remaining");
            let total = int_of(&summary, "total");
            let message = format!(
                "Wayback import cancelled — {remaining} of {total} app{} not processed",
                if total == 1 { "" } else { "s" }
            );
            let totals = state["totals"].clone();
            emit(
                writer,
                frame(
                    "cancelled",
                    json!({ "totals": totals, "durationMs": duration_ms, "summary": summary }),
                ),
            );
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "wayback_import",
                "cancelled",
                None,
                Some(&message),
                Some(&json!({
                    "mode": "bulk",
                    "cancelled": true,
                    "totals": totals,
                    "runId": state["runId"],
                    "remaining": remaining,
                    "total": total,
                })),
                int_of(state, "startedAt"),
            );
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "wayback.import.bulk.cancelled",
                &audit_actor(options),
                Some(&format!("remaining={remaining} total={total}")),
                true,
            );
            clear_bulk_state(cx)?;
            release_mutex(cx)?;
            Ok(Some(RunResult {
                totals,
                duration_ms,
            }))
        }
        _ => Ok(None),
    }
}

/// `pauseRun`: the queue parked at an app boundary, by the user or by a
/// throttling archive.
fn pause_run(
    cx: &mut Cx,
    state: &mut Value,
    writer: &Writer,
    run_started_at: i64,
    options: &RunOptions,
    cause: &str,
    message: Option<&str>,
) -> Result<RunResult, String> {
    let duration_ms = cx.now - run_started_at;
    set(state, "status", json!("paused"));
    set(state, "pausedAt", json!(cx.now));
    set(state, "pauseCause", json!(cause));
    set(state, "currentAppId", Value::Null);
    write_bulk_state(cx, state)?;
    release_mutex(cx)?;
    let summary = summarise(state);
    let remaining = int_of(&summary, "remaining");
    let total = int_of(&summary, "total");
    let apps = format!(
        "{remaining} of {total} app{}",
        if total == 1 { "" } else { "s" }
    );
    let text = if cause == "rate_limited" {
        format!("Wayback import paused — archive.org is rate-limiting requests; {apps} remaining. Resume from Settings once it clears.")
    } else {
        format!("Wayback import paused — {apps} remaining")
    };
    let totals = state["totals"].clone();
    emit(
        writer,
        frame(
            "paused",
            json!({ "cause": cause, "totals": totals, "durationMs": duration_ms, "summary": summary }),
        ),
    );
    let mut detail = Map::new();
    detail.insert("mode".into(), json!("bulk-paused"));
    detail.insert("cause".into(), json!(cause));
    if let Some(message) = message {
        detail.insert("errorMessage".into(), json!(message));
    }
    detail.insert("totals".into(), totals.clone());
    detail.insert("runId".into(), state["runId"].clone());
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "wayback_import",
        "cancelled",
        None,
        Some(&js_slice_prefix(&text, 200)),
        Some(&Value::Object(detail)),
        int_of(state, "startedAt"),
    );
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "wayback.import.bulk.paused",
        &audit_actor(options),
        Some(&format!(
            "cause={cause} remaining={remaining} total={total}"
        )),
        true,
    );
    Ok(RunResult {
        totals,
        duration_ms,
    })
}

// ── lib/notifications.ts: createWaybackResumeNotification ────────────

fn resume_enabled(cx: &Cx) -> bool {
    context_from_db(cx.w.conn)
        .ok()
        .and_then(|ctx| resolve_flag("flag.notifications.resume.enabled", &ctx).ok())
        .map_or(true, |v| v == "on")
}

fn wayback_resume_notification(
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
        "A previous Wayback import lock was stuck after a server restart and has been cleared. You can start a new import now.".to_string()
    } else {
        format!(
            "Wayback import resumed — {apps_remaining} of {total_apps} app{} still to process. Running in the background.",
            if total_apps == 1 { "" } else { "s" }
        )
    };
    let id = cx.ids.uuid(cx.w.conn)?;
    let payload = json!([{
        "type": if stale_healed { "wayback_stale_cleared" } else { "wayback_resumed" },
        "description": description,
        "appsRemaining": apps_remaining,
        "totalApps": total_apps,
    }]);
    cx.w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!(WAYBACK_RESUME_NOTIFICATION_APP_ID),
            json!("Wayback import"),
            json!(payload.to_string()),
            json!(cx.now),
        ],
    )?;
    notify::prune_notifications(cx.w);
    Ok(())
}

// ── instrumentation.ts: resumeWaybackImport ──────────────────────────

/// The boot check: a paused queue is left for the user, a cancelled or
/// finished one is cleared, a stale lock healed, pending work resumed —
/// here to completion, on the server inside its own task.
pub(crate) async fn resume_wayback_import(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
) -> Result<(), String> {
    let now = clock.now();
    let resume = db.with(|w| -> Result<Option<Value>, String> {
        let cx = &mut Cx { w, ids, now };
        let state = read_bulk_state(cx);
        let held = mutex_held(cx);
        if state.is_none() && !held {
            return Ok(None);
        }
        if is_paused(state.as_ref()) {
            if held {
                release_mutex(cx)?;
            }
            if let Some(state) = &state {
                if str_of(state, "status") == "pause_requested" {
                    let mut next = state.clone();
                    set(&mut next, "status", json!("paused"));
                    set(
                        &mut next,
                        "pausedAt",
                        get(state, "pausedAt").cloned().unwrap_or(json!(cx.now)),
                    );
                    set(&mut next, "currentAppId", Value::Null);
                    write_bulk_state(cx, &next)?;
                }
            }
            return Ok(None);
        }
        if is_cancel_requested(state.as_ref()) {
            if held {
                release_mutex(cx)?;
            }
            if state.is_some() {
                clear_bulk_state(cx)?;
            }
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "wayback_import",
                "cancelled",
                None,
                Some("Cleared cancelled Wayback import queue from a previous server run"),
                Some(&json!({ "mode": "bulk-cancelled-stale" })),
                cx.now,
            );
            return Ok(None);
        }
        if !has_pending_work(state.as_ref()) {
            if held {
                release_mutex(cx)?;
            }
            if state.is_some() {
                clear_bulk_state(cx)?;
            }
            if let Err(e) = wayback_resume_notification(cx, 0, 0, true) {
                super::diag::log_warn(format!(
                    "[WaybackResume] Failed to raise stale-heal notification: {e}"
                ));
            }
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "wayback_import",
                "ok",
                None,
                Some("Cleared stuck Wayback import lock from a previous server run"),
                Some(&json!({ "mode": "bulk-stale-healed" })),
                cx.now,
            );
            return Ok(None);
        }
        let state = state.expect("pending work needs a blob");
        let summary = summarise(&state);
        let remaining = int_of(&summary, "remaining");
        let total = int_of(&summary, "total");
        if let Err(e) = wayback_resume_notification(cx, remaining, total, false) {
            super::diag::log_warn(format!(
                "[WaybackResume] Failed to raise resume notification: {e}"
            ));
        }
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "wayback_import",
            "ok",
            None,
            Some(&format!(
                "Wayback import resumed after server restart — {remaining} of {total} app{} left",
                if total == 1 { "" } else { "s" }
            )),
            Some(&json!({
                "mode": "bulk-resume-start",
                "runId": state["runId"],
                "remaining": remaining,
                "total": total,
            })),
            cx.now,
        );
        Ok(Some(state))
    })?;
    if let Some(state) = resume {
        let stream_requested = get(&state, "streamRequested")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = RunOptions {
            initiator: "resume",
            resume_state: Some(state),
            stream_requested,
            writer: None,
            actor_ip: None,
            user_agent: None,
        };
        if let Err(e) = run_bulk_wayback_import(db, fetcher, ids, clock, options).await {
            super::diag::log_error(format!("[WaybackResume] Resumed run failed: {e}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undefined_keys_are_omitted_but_keep_their_place() {
        let mut state = json!({ "runId": "r", "status": "running" });
        set(&mut state, "pausedAt", undefined());
        set(&mut state, "pauseCause", undefined());
        set(&mut state, "extra", json!(1));
        assert_eq!(
            stringify(&state),
            r#"{"runId":"r","status":"running","extra":1}"#
        );
        // A later assignment lands where the undefined key was created.
        set(&mut state, "pauseCause", json!("user"));
        assert_eq!(
            stringify(&state),
            r#"{"runId":"r","status":"running","pauseCause":"user","extra":1}"#
        );
    }

    #[test]
    fn backoff_is_bounded() {
        assert_eq!(rate_limit_backoff_ms(None), 30_000);
        assert_eq!(rate_limit_backoff_ms(Some(1)), 1_000);
        assert_eq!(rate_limit_backoff_ms(Some(5_000)), 5_000);
        assert_eq!(rate_limit_backoff_ms(Some(900_000)), 120_000);
    }
}

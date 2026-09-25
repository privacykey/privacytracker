//! Phase 5, batch 4a: the bulk privacy-policy sync — `lib/policy-bulk-runner.ts`
//! and `lib/policy-bulk-state.ts` — and its boot-time resume in
//! `instrumentation.ts`. `POST /api/policy/sync-all` lives in
//! `runner_writes.rs`; `GET` was ported with the operations reads.
//!
//! Every app with a policy link goes through `syncPrivacyPolicyAnalysis`
//! in the run's phase, one at a time, the queue persisted before and after
//! each app so a process that dies mid-run resumes on its next boot. The
//! state blob is a JSON object Node mutates key by key, `undefined`
//! assignments included, so it is kept as a `Value` with the Wayback
//! runner's undefined sentinel and stripped on write.
//!
//! What each app's run fired and forgot (Save Page Now) is spawned on the
//! server; a replay, whose accessor cannot be detached, answers it in
//! place and hands the archive-link writes back to finish after the run,
//! where Node's held replies land. Gated by
//! `core/tests/fixtures/policy-runner-cases.json`, replayed by
//! `policy_runner_tests`.
use super::{
    activity_log::record_activity,
    flags::{context_from_db, resolve_flag},
    guard::{record_audit, Actor},
    live_runs::{self, Job},
    policy_store::{sync_policy_analysis_streamed, FollowUps, Phase, PolicyRequest, SyncOptions},
    stats::truthy,
    sync_runner::Clock,
    wayback_runner::{get, has_pending_work, set, stringify, summarise, undefined, Writer},
    writes::Cx,
};
use crate::{
    jsstr::js_slice_prefix,
    outbound::Fetcher,
    scrape::{
        notify,
        persist::{DbAccess, Ids},
    },
};
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

pub(crate) const STATE_KEY: &str = "policy_bulk_state";
pub(crate) const MUTEX_KEY: &str = "policy_sync_running";
const STATE_SCHEMA_VERSION: i64 = 1;
const CLEAR_STATE: &str = "DELETE FROM app_settings WHERE key = ?";
const INSERT_NOTIFICATION: &str = "\n    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)\n    VALUES (?, ?, ?, ?, ?, 0)\n  ";
const POLICY_RESUME_NOTIFICATION_APP_ID: &str = "__policy_resume__";
const QUEUE_SELECT: &str = "SELECT id, name, developer, privacyPolicyUrl\n         FROM apps\n        WHERE privacyPolicyUrl IS NOT NULL\n          AND TRIM(privacyPolicyUrl) != ''\n        ORDER BY name COLLATE NOCASE ASC";
const APP_SELECT: &str = "SELECT id, name, developer, privacyPolicyUrl FROM apps WHERE id = ?";

// ── The state blob ───────────────────────────────────────────────────

/// `readPolicyBulkState`: absent, unparseable, another version or a
/// missing field all read as nothing.
pub(crate) fn read_state(cx: &Cx) -> Option<Value> {
    let raw = cx.get(STATE_KEY, "");
    if raw.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let valid = parsed.is_object()
        && parsed["version"].as_f64() == Some(STATE_SCHEMA_VERSION as f64)
        && parsed["runId"].is_string()
        && parsed["queue"].is_array();
    valid.then_some(parsed)
}

/// `writePolicyBulkState`: the version and `updatedAt`, each in place when
/// the blob already has the key.
pub(crate) fn write_state(cx: &mut Cx, next: &Value) -> Result<(), String> {
    let mut payload = next.clone();
    set(&mut payload, "version", json!(STATE_SCHEMA_VERSION));
    set(&mut payload, "updatedAt", json!(cx.now));
    cx.set(STATE_KEY, &stringify(&payload))
}

pub(crate) fn clear_state(cx: &mut Cx) -> Result<(), String> {
    cx.w.run(CLEAR_STATE, vec![json!(STATE_KEY)]).map(drop)
}

pub(crate) fn mutex_held(cx: &Cx) -> bool {
    cx.get(MUTEX_KEY, "") == "true"
}

fn acquire_mutex(cx: &mut Cx) -> Result<(), String> {
    if !mutex_held(cx) {
        cx.set(MUTEX_KEY, "true")?;
    }
    Ok(())
}

pub(crate) fn release_mutex(cx: &mut Cx) -> Result<(), String> {
    cx.set(MUTEX_KEY, "false")
}

/// `zeroPolicyTotals`, in its literal's key order.
pub(crate) fn zero_totals() -> Value {
    json!({ "attempted": 0, "succeeded": 0, "failed": 0, "throttled": 0, "skipped": 0 })
}

/// `canStartPolicyManualRun`: neither the lock nor a readable blob.
pub(crate) fn can_start_manual_run(cx: &Cx) -> bool {
    !mutex_held(cx) && read_state(cx).is_none()
}

/// One `apps` row, as the queue and the dequeue read it.
struct AppRow {
    id: Value,
    name: Value,
    developer: Option<String>,
    policy_url: Option<String>,
}

fn app_row(row: &rusqlite::Row) -> rusqlite::Result<AppRow> {
    let text = |i: usize| -> rusqlite::Result<Value> {
        Ok(match row.get::<_, rusqlite::types::Value>(i)? {
            rusqlite::types::Value::Text(s) => json!(s),
            rusqlite::types::Value::Integer(n) => json!(n),
            rusqlite::types::Value::Real(f) => json!(f),
            _ => Value::Null,
        })
    };
    Ok(AppRow {
        id: text(0)?,
        name: text(1)?,
        developer: row.get(2)?,
        policy_url: row.get(3)?,
    })
}

/// `buildInitialPolicyQueue`: every app with a policy link, by name.
pub(crate) fn build_initial_queue(cx: &Cx) -> Result<Vec<Value>, String> {
    let mut stmt = cx.w.conn.prepare(QUEUE_SELECT).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], app_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter_map(|app| {
            let url = app.policy_url.filter(|u| !u.is_empty())?;
            Some(json!({
                "appId": app.id,
                "appName": app.name,
                "policyUrl": url,
                "status": "pending",
            }))
        })
        .collect())
}

/// `lookupPolicyAppRow`.
fn lookup_app_row(cx: &Cx, app_id: &Value) -> Result<Option<AppRow>, String> {
    let param = match app_id {
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        Value::Number(n) if n.is_i64() => rusqlite::types::Value::Integer(n.as_i64().unwrap_or(0)),
        Value::Number(n) => rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0)),
        _ => rusqlite::types::Value::Null,
    };
    cx.w.conn
        .query_row(APP_SELECT, [param], app_row)
        .optional()
        .map_err(|e| e.to_string())
}

// ── The run ──────────────────────────────────────────────────────────

pub(crate) struct RunOptions {
    /// `manual`, `automatic` or `resume`.
    pub initiator: &'static str,
    /// `fetch` or `all`; a resumed run takes its own from the blob.
    pub phase: &'static str,
    pub force: bool,
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

/// A run's outcome, `Err` being what Node rethrows, and the archive-link
/// writes each app left to finish (none on the server).
pub(crate) struct Ran {
    pub outcome: Result<RunResult, String>,
    pub follow_ups: Vec<FollowUps>,
}

fn emit(writer: &Writer, frame: Value) {
    if let Some(tx) = writer {
        let _ = tx.send(frame);
    }
}

/// A frame from `(key, value)` pairs, an undefined value leaving its key
/// out as `JSON.stringify` does.
fn frame(pairs: Vec<(&str, Option<Value>)>) -> Value {
    let mut out = Map::new();
    for (key, value) in pairs {
        if let Some(value) = value {
            out.insert(key.to_string(), value);
        }
    }
    Value::Object(out)
}

/// `state.key` as a frame field: absent when undefined.
fn field(state: &Value, key: &str) -> Option<Value> {
    get(state, key).cloned()
}

/// `obj.key++`: a number goes up by one; anything else is NaN, which the
/// blob serialises as null.
fn bump(obj: &mut Value, key: &str) {
    let next = match get(obj, key).and_then(Value::as_f64) {
        Some(n) => {
            let n = n + 1.0;
            if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
                json!(n as i64)
            } else {
                json!(n)
            }
        }
        None => Value::Null,
    };
    set(obj, key, next);
}

/// `obj.key = Math.max(0, obj.key - 1)`: a number goes down by one and
/// never below zero; anything else is NaN, which the blob serialises as
/// null, as in `bump`.
fn unbump(obj: &mut Value, key: &str) {
    let n = number(obj, key);
    // `Math.max(0, NaN)` is NaN, where `f64::max` would drop the NaN.
    let next = if n.is_nan() {
        f64::NAN
    } else {
        (n - 1.0).max(0.0)
    };
    set(obj, key, crate::jsnum::js_number(next));
}

/// A numeric field as JavaScript reads it in a template or comparison.
fn number(obj: &Value, key: &str) -> f64 {
    get(obj, key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn spell(n: f64) -> String {
    crate::jsnum::js_number_spelling(n)
}

/// `bulkSummaryLine`.
fn bulk_summary_line(phase: &Value, totals: &Value) -> String {
    let verb = if phase == &json!("all") {
        "summarise"
    } else {
        "scrape"
    };
    let mut parts = vec![format!("{} ok", spell(number(totals, "succeeded")))];
    for (key, label) in [
        ("failed", "failed"),
        ("throttled", "throttled"),
        ("skipped", "skipped"),
    ] {
        let n = number(totals, key);
        // `if (totals.failed)`: zero and NaN are falsy.
        if n != 0.0 && !n.is_nan() {
            parts.push(format!("{} {label}", spell(n)));
        }
    }
    format!("Bulk policy {verb}: {}", parts.join(", "))
}

/// `gateSkip`: the returned run log's last entry, when it is a gate's
/// skip: `throttled` for the per-app throttle, `disabled` for the
/// kill-switch switched on mid-run.
fn gate_skip(analysis: &Value) -> Option<&str> {
    analysis
        .get("lastRunLog")
        .and_then(Value::as_array)
        .and_then(|log| log.last())
        .and_then(|tail| tail.get("phase"))
        .and_then(Value::as_str)
        .filter(|phase| matches!(*phase, "throttled" | "disabled"))
}

/// `classifyOutcome`: a skip is counted by the gate that made it.
fn classify_outcome(status: &Value, skip: Option<&str>) -> &'static str {
    if skip == Some("throttled") {
        "throttled"
    } else if skip == Some("disabled") {
        "skipped"
    } else if status == "ready" || status == "source_ready" {
        "succeeded"
    } else {
        "failed"
    }
}

/// `state.phase` as `syncPrivacyPolicyAnalysis` reads `options.phase`.
fn sync_phase(state: &Value) -> Phase {
    match get(state, "phase").and_then(Value::as_str) {
        Some("fetch") => Phase::Fetch,
        Some("summarise") => Phase::Summarise,
        _ => Phase::All,
    }
}

/// `(state.force || state.phase === "all") === true`, as the sync reads
/// `forceResummarise`: a truthy non-boolean force is not `true`.
fn force_resummarise(state: &Value) -> bool {
    let force = get(state, "force").cloned().unwrap_or(Value::Null);
    if truthy(&force) {
        force == Value::Bool(true)
    } else {
        get(state, "phase") == Some(&json!("all"))
    }
}

fn audit_actor(options: &RunOptions) -> Actor {
    Actor {
        ip: options.actor_ip.clone().unwrap_or_default(),
        user_agent: options.user_agent.clone(),
    }
}

/// `runBulkPolicySync`.
pub(crate) async fn run_bulk_policy_sync(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    options: RunOptions,
) -> Ran {
    // Live on this server until the run ends, however it ends, so the boot
    // check never mistakes it for a run a previous process left behind.
    let _live = db.with(|w| live_runs::enter(w.conn, Job::Policy));
    let mut follow_ups = vec![];
    let mut state: Value = match options.resume_state.clone() {
        Some(mut state) => {
            // The blob still names whoever started the run; record who runs
            // it now, before the first write, so a resume reads as one.
            set(&mut state, "initiator", json!(options.initiator));
            // An app in flight when the process died is redone, and its
            // attempt, counted then, is counted again: un-count the first.
            let mut redone = 0;
            if let Some(queue) = state["queue"].as_array_mut() {
                for entry in queue {
                    if get(entry, "status") == Some(&json!("in_progress")) {
                        set(entry, "status", json!("pending"));
                        redone += 1;
                    }
                }
            }
            for _ in 0..redone {
                unbump(&mut state["totals"], "attempted");
            }
            state
        }
        None => Value::Null,
    };
    // The seed, the lock and the first write: before Node's `try`, so a
    // failure here is thrown with no frame and no rows.
    let now = clock.now();
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
                "phase": options.phase,
                "force": options.force,
                "currentAppId": Value::Null,
                "queue": queue,
                "totals": zero_totals(),
                "streamRequested": options.stream_requested,
            });
        }
        acquire_mutex(cx)?;
        write_state(cx, &state)
    });
    if let Err(message) = seeded {
        return Ran {
            outcome: Err(message),
            follow_ups,
        };
    }

    let writer = options.writer.clone();
    let forced = force_resummarise(&state);
    let bypass_throttle = get(&state, "force") == Some(&Value::Bool(true));
    let phase = sync_phase(&state);
    let run_started_at = clock.now();
    let queue_len = state["queue"].as_array().map_or(0, Vec::len);
    emit(
        &writer,
        frame(vec![
            ("type", Some(json!("batch-start"))),
            ("total", Some(json!(queue_len))),
            ("phase", field(&state, "phase")),
            ("force", field(&state, "force")),
            ("startedAt", field(&state, "startedAt")),
            ("initiator", field(&state, "initiator")),
            ("runId", field(&state, "runId")),
        ]),
    );

    let walked = walk(
        db,
        fetcher,
        ids,
        clock,
        &mut state,
        &writer,
        phase,
        forced,
        bypass_throttle,
        &mut follow_ups,
    )
    .await;
    let outcome = match walked {
        Ok(()) => finish(
            db,
            ids,
            clock,
            &mut state,
            &writer,
            &options,
            run_started_at,
        ),
        Err(message) => {
            // The outer catch: the frame and the rows, then the rethrow with
            // the state and the lock left for the next boot.
            emit(
                &writer,
                frame(vec![
                    ("type", Some(json!("error"))),
                    ("error", Some(json!(message))),
                ]),
            );
            let now = clock.now();
            db.with(|w| {
                let cx = &mut Cx { w, ids, now };
                record_activity(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "policy_summary",
                    "error",
                    None,
                    Some(&js_slice_prefix(
                        &format!("Bulk policy sync aborted: {message}"),
                        200,
                    )),
                    Some(&frame(vec![
                        ("mode", Some(json!("bulk"))),
                        ("phase", field(&state, "phase")),
                        ("force", field(&state, "force")),
                        ("totals", field(&state, "totals")),
                        ("errorMessage", Some(json!(message))),
                        ("runId", field(&state, "runId")),
                    ])),
                    number(&state, "startedAt") as i64,
                );
                let phase = get(&state, "phase")
                    .map(super::preview::string)
                    .unwrap_or_else(|| "undefined".into());
                record_audit(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "policy.sync-all.failed",
                    &audit_actor(&options),
                    Some(&format!("phase={phase} {}", js_slice_prefix(&message, 200))),
                    false,
                );
            });
            Err(message)
        }
    };
    Ran {
        outcome,
        follow_ups,
    }
}

/// One persisted write of the blob; its failure is the outer catch's.
fn persist(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    state: &Value,
) -> Result<(), String> {
    db.with(|w| write_state(&mut Cx { w, ids, now }, state))
}

/// The per-app loop.
#[allow(clippy::too_many_arguments)]
async fn walk(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    state: &mut Value,
    writer: &Writer,
    phase: Phase,
    forced: bool,
    bypass_throttle: bool,
    follow_ups: &mut Vec<FollowUps>,
) -> Result<(), String> {
    let total = state["queue"].as_array().map_or(0, Vec::len);
    for i in 0..total {
        let status = get(&state["queue"][i], "status").cloned();
        // Done and failed apps belong to an earlier life; a new run
        // retries the failures.
        if status == Some(json!("done")) || status == Some(json!("failed")) {
            continue;
        }
        let now = clock.now();
        {
            let entry = &mut state["queue"][i];
            set(entry, "status", json!("in_progress"));
            set(entry, "startedAt", json!(now));
            set(entry, "finishedAt", undefined());
            set(entry, "error", undefined());
            set(entry, "outcome", undefined());
            set(entry, "analysisStatus", undefined());
        }
        let app_id = field(&state["queue"][i], "appId");
        let app_name = field(&state["queue"][i], "appName");
        set(state, "currentAppId", app_id.clone().unwrap_or(Value::Null));
        bump(&mut state["totals"], "attempted");
        persist(db, ids, now, state)?;
        emit(
            writer,
            frame(vec![
                ("type", Some(json!("app-start"))),
                ("appId", app_id.clone()),
                ("name", app_name.clone()),
                ("index", Some(json!(i))),
                ("total", Some(json!(total))),
            ]),
        );

        // The row as it is now: the app may have been renamed, lost its
        // link or gone since the queue was built.
        let lookup_id = app_id.clone().unwrap_or(Value::Null);
        let app = db.with(|w| lookup_app_row(&Cx { w, ids, now }, &lookup_id))?;
        let exists = app.is_some();
        let Some(app) = app.filter(|a| a.policy_url.as_deref().is_some_and(|u| !u.is_empty()))
        else {
            let reason = if exists {
                "App no longer has a privacy policy URL."
            } else {
                "App no longer exists."
            };
            let now = clock.now();
            {
                let entry = &mut state["queue"][i];
                set(entry, "status", json!("done"));
                set(entry, "finishedAt", json!(now));
                set(entry, "outcome", json!("skipped"));
            }
            bump(&mut state["totals"], "skipped");
            set(state, "currentAppId", Value::Null);
            persist(db, ids, now, state)?;
            emit(
                writer,
                frame(vec![
                    ("type", Some(json!("app-done"))),
                    ("appId", app_id),
                    ("name", app_name),
                    ("status", Some(json!("skipped"))),
                    ("index", Some(json!(i))),
                    ("total", Some(json!(total))),
                    ("note", Some(json!(reason))),
                ]),
            );
            continue;
        };

        let request = PolicyRequest {
            app_id: super::preview::string(&app.id),
            app_name: super::preview::string(&app.name),
            developer: app.developer.clone(),
            policy_url: app.policy_url.clone(),
        };
        let phase_writer = writer.clone();
        let phase_app = app.id.clone();
        let mut sink = move |record: &Map<String, Value>| {
            emit(
                &phase_writer,
                json!({ "type": "phase", "appId": phase_app, "phase": record }),
            );
        };
        let synced = sync_policy_analysis_streamed(
            db,
            ids,
            fetcher,
            clock,
            &request,
            SyncOptions {
                phase,
                force_resummarise: forced,
                bypass_throttle,
            },
            Some(&mut sink),
        )
        .await;
        let now = clock.now();
        match synced {
            Ok(synced) => {
                follow_ups.push(synced.follow_ups);
                let analysis = synced.analysis;
                let analysis_status = analysis
                    .get("status")
                    .filter(|s| !s.is_null())
                    .cloned()
                    .unwrap_or_else(|| json!("unknown"));
                let skip = if truthy(&analysis) {
                    gate_skip(&analysis)
                } else {
                    None
                };
                let throttled = skip == Some("throttled");
                // No analysis for an app with a link: the kill-switch stopped
                // a first fetch, which is a skip, not a failure.
                let outcome = if truthy(&analysis) {
                    classify_outcome(&analysis_status, skip)
                } else {
                    "skipped"
                };
                {
                    let entry = &mut state["queue"][i];
                    set(entry, "status", json!("done"));
                    set(entry, "finishedAt", json!(now));
                    set(entry, "outcome", json!(outcome));
                    set(entry, "analysisStatus", analysis_status.clone());
                }
                bump(&mut state["totals"], outcome);
                set(state, "currentAppId", Value::Null);
                persist(db, ids, now, state)?;
                emit(
                    writer,
                    frame(vec![
                        ("type", Some(json!("app-done"))),
                        ("appId", Some(app.id.clone())),
                        ("name", Some(app.name.clone())),
                        ("status", Some(analysis_status)),
                        ("throttled", Some(json!(throttled))),
                        ("index", Some(json!(i))),
                        ("total", Some(json!(total))),
                    ]),
                );
            }
            Err(message) => {
                {
                    let entry = &mut state["queue"][i];
                    set(entry, "status", json!("failed"));
                    set(entry, "finishedAt", json!(now));
                    set(entry, "error", json!(js_slice_prefix(&message, 200)));
                    set(entry, "outcome", json!("failed"));
                }
                bump(&mut state["totals"], "failed");
                set(state, "currentAppId", Value::Null);
                persist(db, ids, now, state)?;
                emit(
                    writer,
                    frame(vec![
                        ("type", Some(json!("app-done"))),
                        ("appId", Some(app.id.clone())),
                        ("name", Some(app.name.clone())),
                        ("status", Some(json!("error"))),
                        ("error", Some(json!(message))),
                        ("index", Some(json!(i))),
                        ("total", Some(json!(total))),
                    ]),
                );
            }
        }
    }
    Ok(())
}

/// The clean completion: the summary frame, the activity and audit rows,
/// then the state and the lock cleared. Its own write failures are the
/// outer catch's too.
fn finish(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    state: &mut Value,
    writer: &Writer,
    options: &RunOptions,
    run_started_at: i64,
) -> Result<RunResult, String> {
    let now = clock.now();
    let duration_ms = now - run_started_at;
    emit(
        writer,
        frame(vec![
            ("type", Some(json!("summary"))),
            ("totals", field(state, "totals")),
            ("phase", field(state, "phase")),
            ("force", field(state, "force")),
            ("durationMs", Some(json!(duration_ms))),
        ]),
    );
    let phase = get(state, "phase").cloned().unwrap_or(Value::Null);
    let totals = get(state, "totals").cloned().unwrap_or(Value::Null);
    let resumed = get(state, "initiator") == Some(&json!("resume"));
    let line = bulk_summary_line(&phase, &totals);
    let summary = if resumed {
        js_slice_prefix(&format!("{line} (resumed after restart)"), 200)
    } else {
        js_slice_prefix(&line, 200)
    };
    let failed = number(&totals, "failed");
    let force_flag = truthy(&get(state, "force").cloned().unwrap_or(Value::Null));
    let detail = format!(
        "phase={} force={} attempted={} ok={} fail={} throttled={}",
        get(state, "phase")
            .map(super::preview::string)
            .unwrap_or_else(|| "undefined".into()),
        if force_flag { 1 } else { 0 },
        spell(number(&totals, "attempted")),
        spell(number(&totals, "succeeded")),
        spell(failed),
        spell(number(&totals, "throttled")),
    );
    db.with(|w| -> Result<(), String> {
        let cx = &mut Cx { w, ids, now };
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "policy_summary",
            if failed > 0.0 { "partial" } else { "ok" },
            None,
            Some(&summary),
            Some(&frame(vec![
                (
                    "mode",
                    Some(json!(if resumed { "bulk-resumed" } else { "bulk" })),
                ),
                ("phase", field(state, "phase")),
                ("force", field(state, "force")),
                ("totals", field(state, "totals")),
                ("runId", field(state, "runId")),
            ])),
            number(state, "startedAt") as i64,
        );
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            if resumed {
                "policy.sync-all.resumed.success"
            } else {
                "policy.sync-all.success"
            },
            &audit_actor(options),
            Some(&detail),
            true,
        );
        clear_state(cx)?;
        release_mutex(cx)
    })?;
    Ok(RunResult {
        totals,
        duration_ms,
    })
}

// ── lib/notifications.ts: createPolicyResumeNotification ─────────────

/// `isResumeEnabled`: the flag, or on when it cannot be read.
fn resume_enabled(cx: &Cx) -> bool {
    context_from_db(cx.w.conn)
        .ok()
        .and_then(|ctx| resolve_flag("flag.notifications.resume.enabled", &ctx).ok())
        .map_or(true, |v| v == "on")
}

fn policy_resume_notification(
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
        "A previous privacy-policy sync lock was stuck after a server restart and has been cleared. You can start a new policy sync now.".to_string()
    } else {
        format!(
            "Privacy-policy sync resumed — {apps_remaining} of {total_apps} app{} still to process. Running in the background.",
            if total_apps == 1 { "" } else { "s" }
        )
    };
    let id = cx.ids.uuid(cx.w.conn)?;
    let payload = json!([{
        "type": if stale_healed { "policy_stale_cleared" } else { "policy_resumed" },
        "description": description,
        "appsRemaining": apps_remaining,
        "totalApps": total_apps,
    }]);
    cx.w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!(POLICY_RESUME_NOTIFICATION_APP_ID),
            json!("Privacy-policy sync"),
            json!(payload.to_string()),
            json!(cx.now),
        ],
    )?;
    notify::prune_notifications(cx.w);
    Ok(())
}

// ── instrumentation.ts: resumePolicySync ─────────────────────────────

/// What the boot check decided before any run.
enum Resume {
    Nothing,
    Run(Value),
}

/// `resumePolicySync`, armed at 12 s: nothing when there is no state and
/// no lock; the queue dropped when scraping is off; a stale lock or a
/// finished queue healed with a notification; otherwise the notification,
/// the activity row and the run, finished here (on the server this runs
/// in its own task). The archive-link writes the run left to finish come
/// back to the caller.
pub(crate) async fn resume_policy_sync(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
) -> Vec<FollowUps> {
    let now = clock.now();
    let decided = db.with(|w| -> Result<Resume, String> {
        if live_runs::is_live(w.conn, Job::Policy) {
            return Ok(Resume::Nothing);
        }
        let cx = &mut Cx { w, ids, now };
        let state = read_state(cx);
        let held = mutex_held(cx);
        if state.is_none() && !held {
            return Ok(Resume::Nothing);
        }
        if cx.get("policy_scrape_disabled", "false") == "true" {
            if held {
                release_mutex(cx)?;
            }
            if state.is_some() {
                clear_state(cx)?;
            }
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "policy_summary",
                "cancelled",
                None,
                Some("Skipped resuming a privacy-policy sync — scraping is disabled in Settings"),
                Some(&json!({ "mode": "bulk-skipped-disabled" })),
                cx.now,
            );
            return Ok(Resume::Nothing);
        }
        if !has_pending_work(state.as_ref()) {
            if held {
                super::diag::log_warn("[PolicyResume] Clearing stale bulk-policy-sync mutex");
                release_mutex(cx)?;
            }
            if state.is_some() {
                clear_state(cx)?;
            }
            if let Err(e) = policy_resume_notification(cx, 0, 0, true) {
                super::diag::log_warn(format!(
                    "[PolicyResume] Failed to raise stale-heal notification: {e}"
                ));
            }
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "policy_summary",
                "ok",
                None,
                Some("Cleared stuck privacy-policy sync lock from a previous server run"),
                Some(&json!({ "mode": "bulk-stale-healed" })),
                cx.now,
            );
            return Ok(Resume::Nothing);
        }
        let state = state.expect("pending work needs a blob");
        let summary = summarise(&state);
        let remaining = summary["remaining"].as_i64().unwrap_or(0);
        let total = summary["total"].as_i64().unwrap_or(0);
        if let Err(e) = policy_resume_notification(cx, remaining, total, false) {
            super::diag::log_warn(format!(
                "[PolicyResume] Failed to raise resume notification: {e}"
            ));
        }
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "policy_summary",
            "ok",
            None,
            Some(&format!(
                "Privacy-policy sync resumed after server restart — {remaining} of {total} app{} left",
                if total == 1 { "" } else { "s" }
            )),
            Some(&frame(vec![
                ("mode", Some(json!("bulk-resume-start"))),
                ("runId", field(&state, "runId")),
                ("remaining", Some(json!(remaining))),
                ("total", Some(json!(total))),
                ("phase", field(&state, "phase")),
                ("force", field(&state, "force")),
            ])),
            cx.now,
        );
        Ok(Resume::Run(state))
    });
    let state = match decided {
        Ok(Resume::Run(state)) => state,
        Ok(Resume::Nothing) => return vec![],
        Err(e) => {
            super::diag::log_error(format!("[PolicyResume] Startup check failed: {e}"));
            return vec![];
        }
    };
    let stream_requested = get(&state, "streamRequested") == Some(&Value::Bool(true));
    let ran = run_bulk_policy_sync(
        db,
        fetcher,
        ids,
        clock,
        RunOptions {
            initiator: "resume",
            phase: "fetch",
            force: false,
            resume_state: Some(state),
            stream_requested,
            writer: None,
            actor_ip: None,
            user_agent: None,
        },
    )
    .await;
    if let Err(e) = &ran.outcome {
        super::diag::log_error(format!("[PolicyResume] Resumed run failed: {e}"));
    }
    ran.follow_ups
}

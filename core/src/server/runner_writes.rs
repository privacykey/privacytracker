//! Phase 4, batch 4a: the routes around the sync runner — `POST
//! /api/sync/trigger` and `POST /api/dev/sync-stop` — and the two small
//! writes that were left with them: `DELETE /api/rate-limit/status` (the
//! Apple cooldowns cleared) and `DELETE /api/apps` (one app, with the
//! import rows that brought it in tombstoned first). Each is the Node
//! route in order, gated by `core/tests/fixtures/runners-cases.json`.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use super::{
    activity_log::record_activity,
    body::{body_error_response, BodyOutcome},
    guard::{record_audit, Actor},
    imports_writes::{recompute_counters, transaction},
    json::{json_error, json_ok, json_response},
    operations::cooldowns,
    policy_runner,
    policy_store::FollowUps,
    sync_runner::{clock_for, run_scheduled_sync, Clock},
    wayback_runner::{
        self, build_initial_queue, clear_bulk_state, get, has_pending_work, mutex_held,
        read_bulk_state, release_mutex, request_active_cancel, run_bulk_wayback_import, set,
        summarise, undefined, write_bulk_state, zero_totals, RunOptions,
    },
    writes::{internal_error, prop, Cx, RouteSpec, WriteRequest},
};
use crate::{
    jsstr::js_trim,
    outbound::Fetcher,
    scrape::persist::{DbAccess, Ids},
};
use axum::{
    body::Body,
    http::{Method, StatusCode},
    response::Response,
};
use regex::Regex;
use rusqlite::types::Value as Sql;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

const DELETE_APP: &str = "DELETE FROM apps WHERE id = ?";
const TOMBSTONE_ITEMS: &str = "UPDATE import_items\n       SET status = 'removed',\n           removed_app_id = COALESCE(removed_app_id, app_id)\n     WHERE app_id = ? AND status != 'removed'";
const CLEAR_SYNC_STATE: &str = "DELETE FROM app_settings WHERE key = ?";
const RATE_LIMIT_CATEGORIES: [&str; 3] = ["search", "scrape", "all"];

pub(super) fn handles(spec: &RouteSpec) -> bool {
    matches!(
        spec.path,
        "/api/sync/trigger"
            | "/api/dev/sync-stop"
            | "/api/rate-limit/status"
            | "/api/apps"
            | "/api/wayback/import-all"
            | "/api/policy/sync-all"
    )
}

pub(super) async fn perform(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    fetcher: &dyn Fetcher,
    req: WriteRequest<'_>,
    actor: &Actor,
) -> Response {
    let spec = req.spec;
    match (spec.path, &spec.method) {
        ("/api/sync/trigger", &Method::POST) => sync_trigger(db, ids, now, fetcher, actor).await,
        ("/api/dev/sync-stop", &Method::POST) => {
            db.with(|w| sync_stop(&mut Cx { w, ids, now }, actor))
        }
        ("/api/rate-limit/status", &Method::DELETE) => {
            db.with(|w| rate_limit_clear(&mut Cx { w, ids, now }, req.body))
        }
        ("/api/apps", &Method::DELETE) => {
            db.with(|w| app_delete(&mut Cx { w, ids, now }, req.query, actor))
        }
        ("/api/wayback/import-all", &Method::POST) => {
            wayback_import_all(db, ids, now, fetcher, req.query, actor).await
        }
        ("/api/wayback/import-all", &Method::PATCH) => {
            wayback_control(db, ids, now, fetcher, req.body, actor).await
        }
        ("/api/wayback/import-all", &Method::DELETE) => {
            db.with(|w| wayback_remove_all(&mut Cx { w, ids, now }, actor))
        }
        ("/api/policy/sync-all", &Method::POST) => {
            let clock: Arc<dyn Clock> = clock_for(now);
            let (response, follow_ups) =
                policy_sync_all(db, ids, fetcher, clock.clone(), req.body, actor).await;
            for follow_up in follow_ups {
                super::policy_store::run_follow_ups(db, fetcher, &*clock, follow_up).await;
            }
            response
        }
        _ => json_error(StatusCode::NOT_FOUND, "Not Found"),
    }
}

// ── POST /api/sync/trigger ───────────────────────────────────────────

async fn sync_trigger(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    fetcher: &dyn Fetcher,
    actor: &Actor,
) -> Response {
    let clock = clock_for(now);
    match run_scheduled_sync(db, fetcher, ids, clock.as_ref(), true).await {
        Ok(result) => {
            db.with(|w| {
                record_audit(
                    w,
                    ids,
                    now,
                    "sync.trigger.success",
                    actor,
                    Some(&format!(
                        "synced={} changes={} skipped={}",
                        result.synced,
                        result.changes,
                        if result.skipped { "true" } else { "false" }
                    )),
                    true,
                );
            });
            let mut body = json!({ "synced": result.synced, "changes": result.changes });
            if result.skipped {
                body["skipped"] = json!(true);
            }
            json_ok(&body)
        }
        Err(message) => {
            db.with(|w| {
                record_audit(
                    w,
                    ids,
                    now,
                    "sync.trigger.failed",
                    actor,
                    Some(&message),
                    false,
                );
            });
            json_error(StatusCode::INTERNAL_SERVER_ERROR, &message)
        }
    }
}

// ── POST /api/dev/sync-stop ──────────────────────────────────────────

fn sync_stop(cx: &mut Cx, actor: &Actor) -> Response {
    let released = (|| -> Result<(), String> {
        cx.w.run(CLEAR_SYNC_STATE, vec![json!("sync_bulk_state")])?;
        cx.set("sync_running", "false")
    })();
    if let Err(message) = released {
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "dev.sync_stop.failed",
            actor,
            Some(&message),
            false,
        );
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to release sync mutex",
        );
    }
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "dev.sync_stop.success",
        actor,
        None,
        true,
    );
    json_ok(&json!({ "ok": true }))
}

// ── DELETE /api/rate-limit/status ────────────────────────────────────

fn rate_limit_clear(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body {
        BodyOutcome::Json(v) => v,
        BodyOutcome::Empty | BodyOutcome::Invalid | BodyOutcome::Whitespace => {
            return json_error(StatusCode::BAD_REQUEST, "invalid json")
        }
        other => return body_error_response(&other).unwrap_or_else(internal_error),
    };
    // `!body || typeof body !== "object"`: an array passes, then has no
    // category.
    if !(body.is_object() || body.is_array()) {
        return json_error(StatusCode::BAD_REQUEST, "expected object body");
    }
    let Some(category) = prop(&body, "category")
        .and_then(Value::as_str)
        .filter(|c| RATE_LIMIT_CATEGORIES.contains(c))
    else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "expected { category: \"search\" | \"scrape\" | \"all\" }",
        );
    };
    let categories: &[&str] = if category == "all" {
        &["search", "scrape"]
    } else {
        &RATE_LIMIT_CATEGORIES[..0]
    };
    let cleared = (|| -> Result<(), String> {
        let list: Vec<&str> = if category == "all" {
            categories.to_vec()
        } else {
            vec![category]
        };
        for c in list {
            cx.set(&format!("rate_limit_{c}_until"), "0")?;
            cx.set(&format!("rate_limit_{c}_reason"), "")?;
        }
        Ok(())
    })();
    if cleared.is_err() {
        return internal_error();
    }
    match cooldowns(cx.w.conn, cx.now) {
        Ok(status) => json_ok(&status),
        Err(_) => internal_error(),
    }
}

// ── DELETE /api/apps ─────────────────────────────────────────────────

fn app_delete(cx: &mut Cx, query: &[(String, String)], actor: &Actor) -> Response {
    let id = query
        .iter()
        .find(|(k, _)| k == "id")
        .map(|(_, v)| v.as_str())
        .filter(|s| !s.is_empty());
    let Some(id) = id else {
        return json_error(StatusCode::BAD_REQUEST, "Missing id");
    };
    static TRACK_ID: OnceLock<Regex> = OnceLock::new();
    if !TRACK_ID
        .get_or_init(|| Regex::new(r"^[0-9]{1,20}$").unwrap())
        .is_match(id)
    {
        return json_error(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let deleted = transaction(cx, |cx| {
        mark_import_items_removed_for_app(cx, id)?;
        cx.w.run(DELETE_APP, vec![json!(id)]).map(drop)
    });
    if let Err(message) = deleted {
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "app.delete.failed",
            actor,
            Some(&format!("id={id} error={message}")),
            false,
        );
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Delete failed");
    }
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "app.delete.success",
        actor,
        Some(&format!("id={id}")),
        true,
    );
    json_ok(&json!({ "success": true }))
}

/// `markImportItemsRemovedForApp`: every live import row for the app
/// becomes a tombstone that remembers it, then its imports recount.
fn mark_import_items_removed_for_app(cx: &mut Cx, app_id: &str) -> Result<Vec<String>, String> {
    let affected = super::stats::query(
        cx.w.conn,
        "SELECT DISTINCT import_id FROM import_items
       WHERE app_id = ? AND status != 'removed'",
        &[Sql::Text(app_id.to_string())],
    )
    .map_err(|e| e.to_string())?;
    if affected.is_empty() {
        return Ok(vec![]);
    }
    cx.w.run(TOMBSTONE_ITEMS, vec![json!(app_id)])?;
    let import_ids: Vec<String> = affected
        .iter()
        .filter_map(|r| r["import_id"].as_str().map(String::from))
        .collect();
    for import_id in &import_ids {
        recompute_counters(cx, import_id)?;
    }
    Ok(import_ids)
}

// ── POST /api/policy/sync-all ────────────────────────────────────────

/// `readBoundedJson`'s failures, which this route answers with a 400
/// carrying the message, the reader's own 413 and 408 included.
fn policy_body(outcome: BodyOutcome) -> Result<Value, String> {
    match outcome {
        BodyOutcome::Json(v) => Ok(v),
        BodyOutcome::Empty => Err("Request body is empty".into()),
        BodyOutcome::TooLarge(max) => Err(format!("Request body too large (limit {max} bytes)")),
        BodyOutcome::Timeout => Err("Request body timed out".into()),
        BodyOutcome::Invalid | BodyOutcome::Whitespace | BodyOutcome::Raw(_) => {
            Err("Invalid JSON body".into())
        }
    }
}

fn ndjson(body: Body) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson; charset=utf-8")
        .header("cache-control", "no-store, no-transform")
        .body(body)
        .unwrap_or_else(|_| internal_error())
}

/// `JSON.stringify(frame) + "\n"`.
fn ndjson_line(frame: &Value) -> Vec<u8> {
    let mut line = super::json::js_json_vec(frame).unwrap_or_default();
    line.push(b'\n');
    line
}

/// `POST /api/policy/sync-all`, after its limit: the body, the phase, the
/// kill-switch, a run already under way, no apps to sync, the start audit,
/// then the run, streamed or buffered. What the run left to finish comes
/// back with the response; on the server it is nothing.
pub(super) async fn policy_sync_all(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: Arc<dyn Clock>,
    body: BodyOutcome,
    actor: &Actor,
) -> (Response, Vec<FollowUps>) {
    let body = match policy_body(body) {
        Ok(v) => v,
        Err(message) => {
            return (
                json_response(StatusCode::BAD_REQUEST, &json!({ "error": message })),
                vec![],
            )
        }
    };
    // `body?.phase`: a null body is no object, not a throw.
    let phase = match prop(&body, "phase").and_then(Value::as_str).map(js_trim) {
        Some("all") => "all",
        _ => "fetch",
    };
    let force = prop(&body, "force") == Some(&Value::Bool(true));
    let want_stream = prop(&body, "stream") == Some(&Value::Bool(true));
    let now = clock.now();
    let opened = db.with(|w| -> Result<Result<(), Response>, String> {
        let cx = &mut Cx { w, ids, now };
        if cx.get("policy_scrape_disabled", "false") == "true" {
            return Ok(Err(json_response(
                StatusCode::CONFLICT,
                &json!({
                    "error": "Policy scraping is disabled in Settings. Re-enable to run a bulk sync.",
                    "code": "policy_scrape_disabled",
                }),
            )));
        }
        if !policy_runner::can_start_manual_run(cx) {
            return Ok(Err(json_error(
                StatusCode::CONFLICT,
                "A bulk policy sync is already running. Wait for it to finish before starting another.",
            )));
        }
        let app_count = policy_runner::build_initial_queue(cx)?.len();
        if app_count == 0 {
            return Ok(Err(json_ok(&json!({
                "error": "No apps have a developer privacy-policy link to sync.",
                "totals": policy_runner::zero_totals(),
                "phase": phase,
                "force": force,
            }))));
        }
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "policy.sync-all.start",
            actor,
            Some(&format!(
                "phase={phase} force={} apps={app_count} stream={}",
                u8::from(force),
                u8::from(want_stream)
            )),
            true,
        );
        Ok(Ok(()))
    });
    match opened {
        // A read or write the route does outside any `try`: Next's 500.
        Err(_) => return (internal_error(), vec![]),
        Ok(Err(response)) => return (response, vec![]),
        Ok(Ok(())) => {}
    }
    let options = |writer| policy_runner::RunOptions {
        initiator: "manual",
        phase,
        force,
        resume_state: None,
        stream_requested: want_stream,
        writer,
        actor_ip: Some(actor.ip.clone()),
        user_agent: actor.user_agent.clone(),
    };
    if want_stream {
        // On the server the run is spawned and its frames stream as they
        // come; a replay's accessor cannot be detached, so its run goes in
        // place and the frames are the body.
        if let Some(Detached {
            mut db,
            fetcher,
            mut ids,
            clock,
        }) = detach(db, fetcher, ids, now)
        {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
            let options = options(Some(tx));
            tokio::spawn(async move {
                let ran = policy_runner::run_bulk_policy_sync(
                    &mut *db, &*fetcher, &mut *ids, &*clock, options,
                )
                .await;
                for follow_up in ran.follow_ups {
                    super::policy_store::run_follow_ups(&mut *db, &*fetcher, &*clock, follow_up)
                        .await;
                }
            });
            let stream = futures_util::stream::unfold(rx, |mut rx| async move {
                rx.recv()
                    .await
                    .map(|frame| (Ok::<_, std::convert::Infallible>(ndjson_line(&frame)), rx))
            });
            return (ndjson(Body::from_stream(stream)), vec![]);
        }
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let ran =
            policy_runner::run_bulk_policy_sync(db, fetcher, ids, &*clock, options(Some(tx))).await;
        let mut lines = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            lines.extend(ndjson_line(&frame));
        }
        return (ndjson(Body::from(lines)), ran.follow_ups);
    }
    let ran = policy_runner::run_bulk_policy_sync(db, fetcher, ids, &*clock, options(None)).await;
    let response = match ran.outcome {
        Ok(result) => json_ok(&json!({
            "totals": result.totals,
            "phase": phase,
            "force": force,
            "durationMs": result.duration_ms,
        })),
        Err(message) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &json!({
                "error": message,
                "totals": policy_runner::zero_totals(),
                "phase": phase,
                "force": force,
            }),
        ),
    };
    (response, ran.follow_ups)
}

// ── POST /api/wayback/import-all ─────────────────────────────────────

const REMOVE_ALL_IMPORTED_HISTORY: &str = "DELETE FROM privacy_snapshots WHERE (source = 'wayback' OR (source = 'live' AND triggered_by = 'wayback'))";

fn flag(query: &[(String, String)], name: &str) -> bool {
    query
        .iter()
        .find(|(k, _)| k == name)
        .is_some_and(|(_, v)| v == "1" || v == "true")
}

/// The run spawned off the request: an owned accessor, fetcher, id source
/// and clock, or nothing when one of them cannot be detached.
struct Detached {
    db: Box<dyn DbAccess>,
    fetcher: std::sync::Arc<dyn Fetcher>,
    ids: Box<dyn Ids>,
    clock: std::sync::Arc<dyn super::sync_runner::Clock>,
}

fn detach(db: &dyn DbAccess, fetcher: &dyn Fetcher, ids: &dyn Ids, now: i64) -> Option<Detached> {
    Some(Detached {
        db: db.detach()?,
        fetcher: fetcher.shared()?,
        ids: ids.detach()?,
        clock: clock_for(now),
    })
}

/// A spawned run, as Node starts it synchronously inside the request: one
/// yield so the run reaches its first fetch before the handler carries on.
async fn spawn_run(detached: Detached, options: RunOptions) {
    let Detached {
        mut db,
        fetcher,
        mut ids,
        clock,
    } = detached;
    tokio::spawn(async move {
        let _ = run_bulk_wayback_import(&mut *db, &*fetcher, &mut *ids, &*clock, options).await;
    });
    tokio::task::yield_now().await;
}

async fn wayback_import_all(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    fetcher: &dyn Fetcher,
    query: &[(String, String)],
    actor: &Actor,
) -> Response {
    let want_stream = flag(query, "stream");
    let force = flag(query, "force");
    // The force restart, the pre-flight and the audit: no await in Node.
    let opened = db.with(|w| -> Result<Result<usize, Response>, String> {
        let cx = &mut Cx { w, ids, now };
        if force {
            let state = read_bulk_state(cx);
            let held = mutex_held(cx);
            let stale = held && !has_pending_work(state.as_ref());
            if held && !stale {
                return Ok(Err(json_error(
                    StatusCode::CONFLICT,
                    "A Wayback import is already running. Pause or cancel it before forcing a fresh import.",
                )));
            }
            if state.is_some() || held {
                clear_bulk_state(cx)?;
                release_mutex(cx)?;
                let run_id = state
                    .as_ref()
                    .and_then(|s| get(s, "runId"))
                    .cloned()
                    .unwrap_or(Value::Null);
                record_audit(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback.import.bulk.force_restart",
                    actor,
                    Some(&match run_id.as_str() {
                        Some(id) => format!("discardedRunId={id}"),
                        None => "discarded stale mutex".to_string(),
                    }),
                    true,
                );
                record_activity(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback_import",
                    "cancelled",
                    None,
                    Some("Discarded paused Wayback import queue before starting a fresh import"),
                    Some(&json!({ "mode": "bulk-force-restart", "discardedRunId": run_id })),
                    cx.now,
                );
            }
        }
        if mutex_held(cx) || read_bulk_state(cx).is_some() {
            return Ok(Err(json_error(
                StatusCode::CONFLICT,
                "A Wayback import is already running. Wait for it to finish before starting another.",
            )));
        }
        let app_count = build_initial_queue(cx)?.len();
        if app_count == 0 {
            return Ok(Err(json_ok(&json!({
                "error": "No apps to import history for.",
                "totals": zero_totals(),
            }))));
        }
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "wayback.import.bulk.start",
            actor,
            Some(&format!(
                "apps={app_count} stream={}",
                if want_stream { 1 } else { 0 }
            )),
            true,
        );
        Ok(Ok(app_count))
    });
    match opened {
        Err(_) => return internal_error(),
        Ok(Err(response)) => return response,
        Ok(Ok(_)) => {}
    }
    let options = |writer| RunOptions {
        initiator: "manual",
        resume_state: None,
        stream_requested: want_stream,
        writer,
        actor_ip: Some(actor.ip.clone()),
        user_agent: actor.user_agent.clone(),
    };
    if want_stream {
        let Some(detached) = detach(db, fetcher, ids, now) else {
            return internal_error();
        };
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        spawn_run(detached, options(Some(tx))).await;
        let stream = futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|frame| (Ok::<_, std::convert::Infallible>(format!("{frame}\n")), rx))
        });
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/x-ndjson; charset=utf-8")
            .header("cache-control", "no-store, no-transform")
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| internal_error());
    }
    let clock = clock_for(now);
    match run_bulk_wayback_import(db, fetcher, ids, &*clock, options(None)).await {
        Ok(result) => {
            json_ok(&json!({ "totals": result.totals, "durationMs": result.duration_ms }))
        }
        Err(message) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &json!({ "error": message, "totals": zero_totals() }),
        ),
    }
}

// ── PATCH /api/wayback/import-all ────────────────────────────────────

async fn wayback_control(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    fetcher: &dyn Fetcher,
    body: BodyOutcome,
    actor: &Actor,
) -> Response {
    // `readOptionalBoundedJson(request, 4096, null)`: unparseable is null.
    let body = match body {
        BodyOutcome::Json(v) => v,
        BodyOutcome::Empty | BodyOutcome::Whitespace | BodyOutcome::Invalid => Value::Null,
        other => return body_error_response(&other).unwrap_or_else(internal_error),
    };
    let action = prop(&body, "action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // Everything but the resumed run is synchronous in Node.
    let outcome = db.with(|w| -> Result<Result<Response, Value>, String> {
        let cx = &mut Cx { w, ids, now };
        match action.as_str() {
            "pause" => {
                let Some(state) = read_bulk_state(cx) else {
                    return Ok(Ok(json_error(
                        StatusCode::NOT_FOUND,
                        "No Wayback import queue is available to pause.",
                    )));
                };
                if get(&state, "status").and_then(Value::as_str) == Some("paused") {
                    return Ok(Ok(json_ok(&json!({
                        "ok": true,
                        "status": "paused",
                        "summary": summarise(&state),
                    }))));
                }
                let held = mutex_held(cx);
                let mut next = state.clone();
                set(
                    &mut next,
                    "status",
                    json!(if held { "pause_requested" } else { "paused" }),
                );
                set(&mut next, "pauseRequestedAt", json!(cx.now));
                set(
                    &mut next,
                    "pausedAt",
                    if held {
                        get(&state, "pausedAt").cloned().unwrap_or_else(undefined)
                    } else {
                        json!(cx.now)
                    },
                );
                set(
                    &mut next,
                    "currentAppId",
                    if held {
                        get(&state, "currentAppId")
                            .cloned()
                            .unwrap_or_else(undefined)
                    } else {
                        Value::Null
                    },
                );
                write_bulk_state(cx, &next)?;
                if !held {
                    release_mutex(cx)?;
                }
                record_audit(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback.import.bulk.pause_requested",
                    actor,
                    Some(&format!(
                        "runId={}",
                        get(&state, "runId").and_then(Value::as_str).unwrap_or("")
                    )),
                    true,
                );
                Ok(Ok(json_ok(&json!({
                    "ok": true,
                    "status": next["status"],
                    "summary": summarise(&next),
                }))))
            }
            "cancel" => {
                let state = read_bulk_state(cx);
                let held = mutex_held(cx);
                if state.is_none() && !held {
                    return Ok(Ok(json_ok(&json!({ "ok": true, "status": "idle" }))));
                }
                if let (Some(state), true) = (&state, held) {
                    let mut next = state.clone();
                    set(&mut next, "status", json!("cancel_requested"));
                    set(&mut next, "cancelRequestedAt", json!(cx.now));
                    write_bulk_state(cx, &next)?;
                    let run_id = get(state, "runId").and_then(Value::as_str).unwrap_or("");
                    let aborted = request_active_cancel(Some(run_id));
                    record_audit(
                        cx.w,
                        cx.ids,
                        cx.now,
                        "wayback.import.bulk.cancel_requested",
                        actor,
                        Some(&format!("runId={run_id} aborted={}", i32::from(aborted))),
                        true,
                    );
                    return Ok(Ok(json_ok(&json!({
                        "ok": true,
                        "status": "cancel_requested",
                        "aborted": aborted,
                        "summary": summarise(&next),
                    }))));
                }
                let summary = state.as_ref().map(summarise).unwrap_or(Value::Null);
                let started_at = cx.now;
                clear_bulk_state(cx)?;
                release_mutex(cx)?;
                let run_id = state.as_ref().and_then(|s| get(s, "runId")).cloned();
                record_audit(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback.import.bulk.cancelled",
                    actor,
                    Some(&match run_id.as_ref().and_then(Value::as_str) {
                        Some(id) => format!("runId={id}"),
                        None => "stale mutex".to_string(),
                    }),
                    true,
                );
                let remaining = summary["remaining"].as_i64().unwrap_or(0);
                let total = summary["total"].as_i64().unwrap_or(0);
                record_activity(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback_import",
                    "cancelled",
                    None,
                    Some(&if state.is_some() {
                        format!(
                            "Cancelled Wayback import queue — {remaining} app{} not processed",
                            if remaining == 1 { "" } else { "s" }
                        )
                    } else {
                        "Cleared stale Wayback import lock".to_string()
                    }),
                    Some(&json!({
                        "mode": "bulk",
                        "cancelled": true,
                        "runId": run_id.unwrap_or(Value::Null),
                        "remaining": remaining,
                        "total": total,
                    })),
                    started_at,
                );
                Ok(Ok(json_ok(&json!({
                    "ok": true,
                    "status": "cancelled",
                    "summary": summary,
                }))))
            }
            "resume" => {
                let state = read_bulk_state(cx);
                if !has_pending_work(state.as_ref()) {
                    return Ok(Ok(json_error(
                        StatusCode::NOT_FOUND,
                        "No paused Wayback import queue is available to resume.",
                    )));
                }
                let state = state.expect("pending work needs a blob");
                if get(&state, "status").and_then(Value::as_str) == Some("cancel_requested") {
                    return Ok(Ok(json_error(
                        StatusCode::CONFLICT,
                        "This Wayback import is already cancelling.",
                    )));
                }
                if mutex_held(cx) {
                    return Ok(Ok(json_error(
                        StatusCode::CONFLICT,
                        "A Wayback import is already running.",
                    )));
                }
                let mut resume_state = state.clone();
                set(&mut resume_state, "status", json!("running"));
                set(&mut resume_state, "pausedAt", undefined());
                set(&mut resume_state, "pauseCause", undefined());
                set(&mut resume_state, "pauseRequestedAt", undefined());
                set(&mut resume_state, "cancelRequestedAt", undefined());
                write_bulk_state(cx, &resume_state)?;
                Ok(Err(resume_state))
            }
            _ => Ok(Ok(json_error(
                StatusCode::BAD_REQUEST,
                "Unknown Wayback control action.",
            ))),
        }
    });
    let resume_state = match outcome {
        Err(_) => return internal_error(),
        Ok(Ok(response)) => return response,
        Ok(Err(resume_state)) => resume_state,
    };
    // The resumed run starts here, synchronously up to its first fetch in
    // Node, then the audit row and the response.
    let Some(detached) = detach(db, fetcher, ids, now) else {
        return internal_error();
    };
    let run_id = get(&resume_state, "runId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    spawn_run(
        detached,
        RunOptions {
            initiator: "manual",
            resume_state: Some(resume_state),
            stream_requested: false,
            writer: None,
            actor_ip: Some(actor.ip.clone()),
            user_agent: actor.user_agent.clone(),
        },
    )
    .await;
    // Node summarises the very object the runner has started mutating, so
    // the summary already shows the first app in flight: the persisted
    // blob is that object, written before the run's first await.
    let summary = db.with(|w| {
        let cx = &mut Cx { w, ids, now };
        let summary = summarise(&read_bulk_state(cx).unwrap_or_else(|| json!({ "queue": [] })));
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "wayback.import.bulk.resume_requested",
            actor,
            Some(&format!("runId={run_id}")),
            true,
        );
        summary
    });
    json_ok(&json!({ "ok": true, "status": "running", "summary": summary }))
}

// ── DELETE /api/wayback/import-all ───────────────────────────────────

fn wayback_remove_all(cx: &mut Cx, actor: &Actor) -> Response {
    let started_at = cx.now;
    let deleted = match cx.w.run(REMOVE_ALL_IMPORTED_HISTORY, vec![]) {
        Ok(deleted) => deleted,
        Err(_) => return internal_error(),
    };
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "wayback.import.bulk.remove",
        actor,
        Some(&format!("deleted={deleted}")),
        true,
    );
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "wayback_import",
        "ok",
        None,
        Some(&format!(
            "Removed {deleted} imported history row{}",
            if deleted == 1 { "" } else { "s" }
        )),
        Some(&json!({ "mode": "bulk", "removed": true, "deleted": deleted })),
        started_at,
    );
    let _ = wayback_runner::STATE_KEY;
    json_ok(&json!({ "deleted": deleted }))
}

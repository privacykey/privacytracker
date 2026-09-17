//! Phase 4, batch 2: the twenty-three library writes — annotations,
//! verdicts, the shortlist, review actions and their undo, notification
//! marks, user tasks and visits, queue sessions, devices, the device scope
//! and manual apps. Each handler is the Node route in order, over the lib
//! module it calls, with Node's SQL byte for byte and Node's response
//! literals. Gated by `core/tests/fixtures/library-cases.json`.
//!
//! What this batch adds to the semantics of batch 1: rows that are read
//! back after the write (the annotation, the device, the shortlist entry
//! with its badge), the activity rows the lib modules write for user
//! actions, transactions that answer `false` without rolling back (the
//! undo), foreign-key refusals surfacing as each route's own 500 (or, for
//! the review action, Next's generic one), and the routes whose `catch`
//! turns a `TypeError` on a `null` body into a 400 carrying V8's message.
#![allow(clippy::result_large_err)]
use super::{
    activity_log::record_activity,
    body::{body_error_response, BodyOutcome},
    guard::{record_audit, Actor},
    json::{json_error, json_ok, json_response},
    review, routes_detail, routes_devices, stats,
    user_content::metadata,
    user_tasks,
    writes::{
        body_json, internal_error, is_object_like, js_entries, prop, string_or, Cx, WriteRequest,
    },
};
use crate::{
    jsnum::{js_normalise_value, js_number, js_number_spelling, js_to_number},
    jsstr::{js_length, js_trim},
    outbound,
};
use axum::{
    body::Body,
    http::{Method, StatusCode},
    response::Response,
};
use rusqlite::types::Value as Sql;
use serde_json::{json, Map, Value};

// ── SQL, from the recorded stream ────────────────────────────────────
const INSERT_SHORTLIST: &str = "INSERT INTO shortlist_entries (\n           id, source_app_id, candidate_apple_id, candidate_name,\n           candidate_developer, candidate_icon_url, candidate_store_url,\n           candidate_bundle_id, note, added_at, mode\n         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE_SHORTLIST: &str = "UPDATE shortlist_entries SET\n           candidate_name      = ?,\n           candidate_developer = ?,\n           candidate_icon_url  = ?,\n           candidate_store_url = ?,\n           candidate_bundle_id = ?,\n           note                = ?,\n           mode                = ?\n         WHERE id = ?";
const DELETE_SHORTLIST_ALL: &str = "DELETE FROM shortlist_entries";
const DELETE_SHORTLIST_ID: &str = "DELETE FROM shortlist_entries WHERE id = ?";
const DELETE_SHORTLIST_PAIR: &str =
    "DELETE FROM shortlist_entries WHERE source_app_id = ? AND candidate_apple_id = ?";
const INSERT_VERDICT: &str = "INSERT INTO app_verdicts\n         (id, app_id, verdict, rationale, source, source_name, set_at, updated_at)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE_VERDICT: &str =
    "UPDATE app_verdicts\n       SET verdict = ?, rationale = ?, updated_at = ?\n       WHERE id = ?";
const DELETE_VERDICT: &str = "DELETE FROM app_verdicts\n     WHERE app_id = ? AND source = ?\n       AND ((source_name IS NULL AND ? IS NULL) OR source_name = ?)";
const INSERT_VERDICT_BULK: &str = "INSERT INTO app_verdicts\n       (id, app_id, verdict, rationale, source, source_name, set_at, updated_at)\n     VALUES (?, ?, ?, ?, 'user', NULL, ?, ?)";
const UPDATE_VERDICT_BULK: &str =
    "UPDATE app_verdicts\n     SET verdict = ?, rationale = ?, updated_at = ?\n     WHERE id = ?";
const MARK_ALL_READ: &str = "UPDATE notifications SET read = 1";
const INSERT_ANNOTATION: &str = "INSERT INTO annotations\n       (id, app_id, content, source, source_name, visibility, tag,\n        created_at, updated_at, deleted_at)\n     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)";
const SOFT_DELETE_ANNOTATION: &str =
    "UPDATE annotations SET deleted_at = ?, updated_at = ? WHERE id = ?";
const RESTORE_ANNOTATION: &str =
    "UPDATE annotations SET deleted_at = NULL, updated_at = ? WHERE id = ?";
const INSERT_REVIEW_ACTION: &str = "INSERT INTO change_review_actions\n         (id, app_id, action, acted_at, covered_count, covered_snapshot_ids,\n          snooze_until, note)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const ACK_APP: &str = "UPDATE apps\n            SET changeCount = 0,\n                changes_acknowledged_at = ?,\n                changes_snoozed_until = 0\n          WHERE id = ?";
const ACK_NOTIFICATIONS: &str = "UPDATE notifications SET read = 1 WHERE app_id = ? AND read = 0";
const SNOOZE_APP: &str = "UPDATE apps SET changes_snoozed_until = ? WHERE id = ?";
const UNSNOOZE_APP: &str = "UPDATE apps SET changes_snoozed_until = 0 WHERE id = ?";
const DELETE_REVIEW_ACTION: &str = "DELETE FROM change_review_actions WHERE id = ? AND app_id = ?";
const RESTORE_APP_STATE: &str = "UPDATE apps\n          SET changeCount = ?,\n              changes_acknowledged_at = ?,\n              changes_snoozed_until = ?\n        WHERE id = ?";
const SET_SETTING: &str = "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)";
const INSERT_DEVICE: &str = "\n    INSERT INTO devices (id, name, ecid, model, ios_version, device_class,\n                         created_at, last_synced_at, is_unknown_placeholder,\n                         owner_label, owner_audience, permission_acknowledged_at)\n    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)\n  ";
const RENAME_DEVICE: &str = "UPDATE devices SET name = ? WHERE id = ?";
const DELETE_APP_DEVICE: &str = "DELETE FROM app_devices WHERE app_id = ? AND device_id = ?";
const REPOINT_APP_DEVICES: &str = "UPDATE app_devices SET device_id = ? WHERE device_id = ?";
const REPOINT_IMPORTS: &str = "UPDATE imports SET device_id = ? WHERE device_id = ?";
const DELETE_DEVICE: &str = "DELETE FROM devices WHERE id = ?";
const DELETE_APP: &str = "DELETE FROM apps WHERE id = ?";
const INSERT_MANUAL_APP: &str = "INSERT INTO manual_apps\n       (id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at)\n     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE_MANUAL_APP: &str = "UPDATE manual_apps\n         SET name = ?, source = ?, developer = ?, privacy_policy_url = ?, source_url = ?,\n             notes = ?, updated_at = ?\n       WHERE id = ?";
const INSERT_MANUAL_EVENT: &str = "INSERT INTO manual_app_events (id, manual_app_id, event_type, occurred_at, detail)\n     VALUES (?, ?, ?, ?, ?)";
const DELETE_MANUAL_EVENTS: &str = "DELETE FROM manual_app_events WHERE manual_app_id = ?";
const DELETE_MANUAL_VERSIONS: &str =
    "DELETE FROM manual_app_policy_versions WHERE manual_app_id = ?";
const DELETE_MANUAL_APP: &str = "DELETE FROM manual_apps WHERE id = ?";

const SHORTLIST_MODES: [&str; 2] = ["privacy", "accessibility"];
const VERDICTS: [&str; 3] = ["safe", "replace", "uninstall"];
const ANNOTATION_TAGS: [&str; 4] = ["concern", "positive", "follow_up", "other"];
const ANNOTATION_VISIBILITIES: [&str; 2] = ["export", "private"];
const REVIEW_ACTIONS: [&str; 4] = ["reviewed", "dismissed", "snoozed", "unsnoozed"];
const SNOOZE_DAYS: [f64; 3] = [1.0, 7.0, 30.0];
const TASK_ACTIONS: [&str; 5] = ["start", "dismiss", "reset", "clear_all", "opt_in"];
const VISIT_SURFACES: [&str; 3] = ["privacy_map", "compare", "app_detail"];
const QUEUE_SCOPES: [&str; 4] = ["undecided", "all", "mismatch", "changed"];
const QUEUE_SORTS: [&str; 4] = ["mismatch_severity", "risk", "alphabetical", "random"];
const OWNER_AUDIENCES: [&str; 3] = ["self", "loved_one", "guardian"];
const MANUAL_SOURCES: [&str; 4] = ["web_clip", "testflight", "own_build", "sideloaded"];
const MANUAL_SOURCE_ERROR: &str =
    "source must be one of: web_clip, testflight, own_build, sideloaded";
const SOFT_DELETE_WINDOW_MS: i64 = 30_000;

/// The dispatch for every batch-2 route; `None` when the path is not one.
pub(super) fn perform(cx: &mut Cx, req: WriteRequest, actor: &Actor) -> Option<Response> {
    let spec = req.spec;
    let param = req.param.unwrap_or("");
    Some(match (spec.path, &spec.method) {
        ("/api/shortlist", &Method::POST) => shortlist_post(cx, req.body, actor),
        ("/api/shortlist", &Method::DELETE) => shortlist_delete(cx, req.query, actor),
        ("/api/verdicts", &Method::POST) => verdict_post(cx, req.body),
        ("/api/verdicts", &Method::DELETE) => verdict_delete(cx, req.query),
        ("/api/verdicts/bulk", &Method::POST) => verdicts_bulk(cx, req.body),
        ("/api/notifications", &Method::POST) => notifications_post(cx, req.body),
        ("/api/annotations", &Method::POST) => annotation_post(cx, req.body),
        ("/api/annotations/[id]", &Method::PATCH) => annotation_patch(cx, param, req.body),
        ("/api/annotations/[id]", &Method::DELETE) => annotation_delete(cx, param),
        ("/api/annotations/[id]", &Method::PUT) => annotation_restore(cx, param),
        ("/api/apps/[id]/acknowledge", &Method::POST) => acknowledge(cx, param, req.body),
        ("/api/apps/[id]/acknowledge/undo", &Method::POST) => acknowledge_undo(cx, param, req.body),
        ("/api/user-tasks", &Method::POST) => user_tasks_post(cx, req.body, actor),
        ("/api/user-tasks/visit", &Method::POST) => user_tasks_visit(cx, req.body),
        ("/api/activity/queue-session", &Method::POST) => queue_session(cx, req.body),
        ("/api/devices", &Method::POST) => device_post(cx, req.body, actor),
        ("/api/devices/[id]", &Method::PATCH) => device_patch(cx, param, req.body, actor),
        ("/api/devices/[id]", &Method::DELETE) => device_delete(cx, param, actor),
        ("/api/device-scope", &Method::PUT) => device_scope_put(cx, req.body),
        ("/api/device-scope", &Method::DELETE) => device_scope_reset(cx),
        ("/api/manual-apps", &Method::POST) => manual_post(cx, req.body, actor),
        ("/api/manual-apps/[id]", &Method::PUT) => manual_put(cx, param, req.body, actor),
        ("/api/manual-apps/[id]", &Method::DELETE) => manual_delete(cx, param, actor),
        ("/api/manual-apps/bulk", &Method::POST) => manual_bulk(cx, req.body, actor),
        ("/api/manual-apps/[id]/restore", &Method::POST) => {
            manual_restore(cx, param, req.body, actor)
        }
        _ => return None,
    })
}

// ── Shared helpers ───────────────────────────────────────────────────

fn bad(message: &str) -> Response {
    json_error(StatusCode::BAD_REQUEST, message)
}

fn created(value: &Value) -> Response {
    json_response(StatusCode::CREATED, value)
}

fn first<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

/// The body for the routes whose reader is `readBoundedJson` with the
/// settings phrasing: an empty body and an unparseable one are distinct.
pub(super) fn body_strict(body: BodyOutcome) -> Result<Value, Response> {
    match body {
        BodyOutcome::Json(v) => Ok(v),
        BodyOutcome::Empty => Err(bad("Request body is empty")),
        BodyOutcome::Invalid | BodyOutcome::Whitespace => Err(bad("Invalid JSON body")),
        other => Err(body_error_response(&other).unwrap_or_else(internal_error)),
    }
}

/// `readOptionalBoundedJson(request, cap, {})`: blank is the fallback,
/// unparseable is the route's to phrase (`Err(None)`).
fn body_optional(body: BodyOutcome) -> Result<Value, Option<Response>> {
    match body {
        BodyOutcome::Json(v) => Ok(v),
        BodyOutcome::Empty | BodyOutcome::Whitespace => Ok(json!({})),
        BodyOutcome::Invalid => Err(None),
        other => Err(Some(
            body_error_response(&other).unwrap_or_else(internal_error),
        )),
    }
}

/// `typeof v === "string" ? v : fallback`.
fn str_or<'a>(v: Option<&'a Value>, fallback: &'a str) -> &'a str {
    v.and_then(Value::as_str).unwrap_or(fallback)
}

fn str_or_null(v: Option<&Value>) -> Value {
    v.and_then(Value::as_str).map_or(Value::Null, |s| json!(s))
}

fn read_rows(cx: &Cx, sql: &str, params: &[Sql]) -> Result<Vec<Value>, String> {
    stats::query(cx.w.conn, sql, params).map_err(|e| e.to_string())
}

fn read_one(cx: &Cx, sql: &str, params: &[Sql]) -> Result<Option<Value>, String> {
    Ok(read_rows(cx, sql, params)?.into_iter().next())
}

fn text(s: &str) -> Sql {
    Sql::Text(s.to_string())
}

/// `JSON.stringify` of a value with JavaScript's number spelling.
fn stringify(v: &Value) -> String {
    js_normalise_value(v.clone()).to_string()
}

/// `JSON.stringify` of an object literal whose values may be `undefined`
/// (absent keys are dropped, present keys keep their raw values).
fn stringify_present(pairs: &[(&str, Option<&Value>)]) -> String {
    let mut m = Map::new();
    for (k, v) in pairs {
        if let Some(v) = v {
            m.insert(k.to_string(), (*v).clone());
        }
    }
    stringify(&Value::Object(m))
}

// ── /api/shortlist ───────────────────────────────────────────────────

/// `parseModes(raw)`: unknown tokens dropped, canonical order, `privacy`
/// when nothing survives.
fn parse_modes(raw: Option<&str>) -> Vec<&'static str> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return vec!["privacy"];
    };
    let tokens: Vec<String> = raw.split(',').map(|t| js_trim(t).to_lowercase()).collect();
    let out: Vec<&'static str> = SHORTLIST_MODES
        .into_iter()
        .filter(|m| tokens.iter().any(|t| t == m))
        .collect();
    if out.is_empty() {
        vec!["privacy"]
    } else {
        out
    }
}

fn serialise_modes(modes: &[&str]) -> String {
    if modes.is_empty() {
        return "privacy".to_string();
    }
    SHORTLIST_MODES
        .into_iter()
        .filter(|m| modes.contains(m))
        .collect::<Vec<_>>()
        .join(",")
}

/// The route's `parseModesField`: a string splits on commas, an array
/// keeps its strings, anything else is nothing.
fn parse_modes_field(raw: Option<&Value>) -> Option<Vec<&'static str>> {
    let raw = raw.filter(|v| !v.is_null())?;
    let tokens: Vec<String> = match raw {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        Value::String(s) => s.split(',').map(str::to_string).collect(),
        _ => vec![],
    };
    let out: Vec<&'static str> = tokens
        .iter()
        .map(|t| js_trim(t).to_lowercase())
        .filter_map(|t| SHORTLIST_MODES.into_iter().find(|m| *m == t))
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

struct ShortlistInput {
    source_app_id: String,
    candidate_apple_id: String,
    candidate_name: String,
    candidate_developer: Option<String>,
    candidate_icon_url: Option<String>,
    candidate_store_url: String,
    candidate_bundle_id: Option<String>,
    note: Option<String>,
    modes: Option<Vec<&'static str>>,
}

/// `addShortlistEntry`.
fn add_shortlist_entry(cx: &mut Cx, input: ShortlistInput) -> Result<Value, String> {
    let source_app_id = js_trim(&input.source_app_id).to_string();
    let candidate_apple_id = js_trim(&input.candidate_apple_id).to_string();
    let candidate_name = js_trim(&input.candidate_name).to_string();
    let candidate_store_url = js_trim(&input.candidate_store_url).to_string();
    if source_app_id.is_empty() {
        return Err("sourceAppId is required".into());
    }
    if candidate_apple_id.is_empty() {
        return Err("candidateAppleId is required".into());
    }
    if candidate_name.is_empty() {
        return Err("candidateName is required".into());
    }
    if candidate_store_url.is_empty() {
        return Err("candidateStoreUrl is required".into());
    }
    if read_one(
        cx,
        "SELECT 1 FROM apps WHERE id = ? LIMIT 1",
        &[text(&source_app_id)],
    )?
    .is_none()
    {
        return Err(format!("Source app not found: {source_app_id}"));
    }
    if source_app_id == candidate_apple_id {
        return Err("Candidate cannot be the same app as the source".into());
    }
    let now = cx.now;
    let id = cx.ids.uuid(cx.w.conn)?;
    let developer = js_trim(input.candidate_developer.as_deref().unwrap_or("")).to_string();
    let icon_url = js_trim(input.candidate_icon_url.as_deref().unwrap_or("")).to_string();
    let bundle_id = js_trim(input.candidate_bundle_id.as_deref().unwrap_or("")).to_string();
    let note = js_trim(input.note.as_deref().unwrap_or("")).to_string();
    let incoming = match &input.modes {
        Some(m) if !m.is_empty() => parse_modes(Some(&m.join(","))),
        _ => parse_modes(Some("privacy")),
    };
    let or_null = |s: &str| if s.is_empty() { Value::Null } else { json!(s) };

    let tx =
        cx.w.conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
    cx.w.mark("BEGIN");
    let written = (|| -> Result<(), String> {
        let existing = read_one(
            cx,
            "SELECT id, mode FROM shortlist_entries WHERE source_app_id = ? AND candidate_apple_id = ?",
            &[text(&source_app_id), text(&candidate_apple_id)],
        )?;
        match existing {
            Some(row) => {
                let stored = parse_modes(row["mode"].as_str());
                let mut merged: Vec<&str> = stored.clone();
                merged.extend(incoming.iter().copied());
                cx.w.run(
                    UPDATE_SHORTLIST,
                    vec![
                        json!(candidate_name),
                        or_null(&developer),
                        or_null(&icon_url),
                        json!(candidate_store_url),
                        or_null(&bundle_id),
                        or_null(&note),
                        json!(serialise_modes(&merged)),
                        row["id"].clone(),
                    ],
                )?;
            }
            None => {
                cx.w.run(
                    INSERT_SHORTLIST,
                    vec![
                        json!(id),
                        json!(source_app_id),
                        json!(candidate_apple_id),
                        json!(candidate_name),
                        or_null(&developer),
                        or_null(&icon_url),
                        json!(candidate_store_url),
                        or_null(&bundle_id),
                        or_null(&note),
                        json!(now),
                        json!(serialise_modes(&incoming)),
                    ],
                )?;
            }
        }
        Ok(())
    })();
    match written {
        Ok(()) => {
            cx.w.mark("COMMIT");
            tx.commit().map_err(|e| e.to_string())?;
        }
        Err(e) => {
            cx.w.mark("ROLLBACK");
            drop(tx);
            return Err(e);
        }
    }
    let row = read_one(
        cx,
        "SELECT s.*,\n              CASE WHEN t.id IS NULL THEN 0 ELSE 1 END AS candidate_is_tracked,\n              t.priceFormatted AS candidate_price_formatted,\n              t.priceCurrency  AS candidate_price_currency,\n              t.hasIap         AS candidate_has_iap\n         FROM shortlist_entries s\n         LEFT JOIN apps t ON t.id = s.candidate_apple_id\n        WHERE s.source_app_id = ? AND s.candidate_apple_id = ?",
        &[text(&source_app_id), text(&candidate_apple_id)],
    )?
    .ok_or_else(|| "shortlist row vanished".to_string())?;
    // The one candidate's badge: `getProfileBadgesByApp([id])` is the
    // single-footprint path the insert uses, where a tracked candidate
    // with no privacy rows still gets a badge.
    let badges = if row["candidate_is_tracked"] == 1 {
        super::grid_meta::get_profile_badges_by_app(
            cx.w.conn,
            std::slice::from_ref(&candidate_apple_id),
        )
        .map_err(|e| e.to_string())?
    } else {
        json!({})
    };
    Ok(review::shortlist_entry(&row, &badges))
}

fn shortlist_post(cx: &mut Cx, body: BodyOutcome, actor: &Actor) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let outcome = (|| -> Result<Value, String> {
        // `body.sourceAppId` on a null body throws inside the try.
        if body.is_null() {
            return Err("Cannot read properties of null (reading 'sourceAppId')".into());
        }
        let field = |k: &str| string_or(prop(&body, k).unwrap_or(&Value::Null), "");
        let optional = |k: &str| prop(&body, k).and_then(Value::as_str).map(str::to_string);
        add_shortlist_entry(
            cx,
            ShortlistInput {
                source_app_id: field("sourceAppId"),
                candidate_apple_id: field("candidateAppleId"),
                candidate_name: field("candidateName"),
                candidate_developer: optional("candidateDeveloper"),
                candidate_icon_url: optional("candidateIconUrl"),
                candidate_store_url: field("candidateStoreUrl"),
                candidate_bundle_id: optional("candidateBundleId"),
                note: optional("note"),
                modes: parse_modes_field(prop(&body, "modes")),
            },
        )
    })();
    match outcome {
        Ok(entry) => {
            let detail = format!(
                "{}→{}",
                stats::text(&entry["sourceAppId"]),
                stats::text(&entry["candidateAppleId"])
            );
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "shortlist.create",
                actor,
                Some(&detail),
                true,
            );
            json_ok(&json!({ "entry": entry }))
        }
        Err(message) => bad(&message),
    }
}

fn shortlist_delete(cx: &mut Cx, query: &[(String, String)], actor: &Actor) -> Response {
    let id = first(query, "id");
    let source = first(query, "sourceAppId");
    let candidate = first(query, "candidateAppleId");
    let all = first(query, "all");
    if matches!(all, Some("1") | Some("true")) {
        let removed = match cx.w.run(DELETE_SHORTLIST_ALL, vec![]) {
            Ok(n) => n,
            Err(_) => return internal_error(),
        };
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "shortlist.delete.all",
            actor,
            Some(&removed.to_string()),
            true,
        );
        return json_ok(&json!({ "deleted": removed > 0, "removed": removed }));
    }
    let deleted = match (id, source, candidate) {
        (Some(id), _, _) if !id.is_empty() => cx.w.run(DELETE_SHORTLIST_ID, vec![json!(id)]),
        (_, Some(s), Some(c)) if !s.is_empty() && !c.is_empty() => {
            cx.w.run(DELETE_SHORTLIST_PAIR, vec![json!(s), json!(c)])
        }
        _ => return bad("Provide `id`, both `sourceAppId` and `candidateAppleId`, or `all=1`"),
    };
    let deleted = match deleted {
        Ok(n) => n > 0,
        Err(_) => return internal_error(),
    };
    let detail = match id {
        Some(id) => id.to_string(),
        None => format!("{}→{}", source.unwrap_or(""), candidate.unwrap_or("")),
    };
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "shortlist.delete",
        actor,
        Some(&detail),
        deleted,
    );
    json_ok(&json!({ "deleted": deleted }))
}

// ── /api/verdicts ────────────────────────────────────────────────────

fn verdict_json(
    id: &str,
    app_id: &str,
    verdict: &str,
    rationale: Option<&str>,
    set_at: Value,
    updated_at: i64,
) -> Value {
    json!({
        "id": id,
        "appId": app_id,
        "verdict": verdict,
        "rationale": rationale,
        "source": "user",
        "sourceName": Value::Null,
        "setAt": set_at,
        "updatedAt": updated_at,
    })
}

/// `input.rationale?.trim() || null`.
fn trimmed_or_null(s: Option<&str>) -> Option<String> {
    s.map(js_trim).filter(|t| !t.is_empty()).map(str::to_string)
}

fn verdict_post(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let Some(app_id) = prop(&body, "appId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return bad("appId is required");
    };
    let Some(verdict) = prop(&body, "verdict")
        .and_then(Value::as_str)
        .filter(|v| VERDICTS.contains(v))
    else {
        return bad("verdict must be one of: safe, replace, uninstall");
    };
    let rationale = match prop(&body, "rationale") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return bad("rationale must be a string or null"),
    };
    let now = cx.now;
    let outcome = (|| -> Result<Value, String> {
        let existing = read_one(
            cx,
            "SELECT id, set_at FROM app_verdicts\n     WHERE app_id = ? AND source = ?\n       AND ((source_name IS NULL AND ? IS NULL) OR source_name = ?)",
            &[text(app_id), text("user"), Sql::Null, Sql::Null],
        )?;
        let rationale = trimmed_or_null(rationale);
        let (id, first_set) = match existing {
            Some(row) => {
                let id = stats::text(&row["id"]).to_string();
                cx.w.run(
                    UPDATE_VERDICT,
                    vec![json!(verdict), json!(rationale), json!(now), json!(id)],
                )?;
                (id, row["set_at"].clone())
            }
            None => {
                let id = cx.ids.uuid(cx.w.conn)?;
                cx.w.run(
                    INSERT_VERDICT,
                    vec![
                        json!(id),
                        json!(app_id),
                        json!(verdict),
                        json!(rationale),
                        json!("user"),
                        Value::Null,
                        json!(now),
                        json!(now),
                    ],
                )?;
                (id, json!(now))
            }
        };
        record_activity(
            cx.w,
            cx.ids,
            now,
            "verdict_set",
            "ok",
            Some(app_id),
            Some(&format!("Marked {verdict}")),
            Some(
                &json!({ "verdictId": id, "verdict": verdict, "hasRationale": rationale.is_some() }),
            ),
            now,
        );
        Ok(verdict_json(
            &id,
            app_id,
            verdict,
            rationale.as_deref(),
            first_set,
            now,
        ))
    })();
    match outcome {
        Ok(v) => created(&json!({ "verdict": v })),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to set verdict"),
    }
}

fn verdict_delete(cx: &mut Cx, query: &[(String, String)]) -> Response {
    let Some(app_id) = first(query, "appId").filter(|s| !s.is_empty()) else {
        return bad("appId is required");
    };
    let imported = first(query, "source") == Some("imported");
    let source = if imported { "imported" } else { "user" };
    let source_name = if imported {
        first(query, "sourceName")
    } else {
        None
    };
    if imported && source_name.is_none_or_empty() {
        return bad("sourceName is required when source=imported");
    }
    let name_value = source_name.map_or(Value::Null, |s| json!(s));
    let removed = match cx.w.run(
        DELETE_VERDICT,
        vec![json!(app_id), json!(source), name_value.clone(), name_value],
    ) {
        Ok(n) => n > 0,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to clear verdict"),
    };
    if removed && !imported {
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "verdict_cleared",
            "ok",
            Some(app_id),
            Some("Verdict cleared"),
            Some(&json!({})),
            cx.now,
        );
    }
    json_ok(&json!({ "removed": removed }))
}

trait NoneOrEmpty {
    fn is_none_or_empty(&self) -> bool;
}
impl NoneOrEmpty for Option<&str> {
    fn is_none_or_empty(&self) -> bool {
        self.map_or(true, str::is_empty)
    }
}

fn verdicts_bulk(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let Some(Value::Array(ids)) =
        prop(&body, "appIds").filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
    else {
        return bad("appIds must be a non-empty array");
    };
    if ids.len() > 500 {
        return bad("appIds exceeds bulk cap of 500");
    }
    let app_ids: Vec<&str> = ids
        .iter()
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty())
        .collect();
    if app_ids.len() != ids.len() {
        return bad("every appId must be a non-empty string");
    }
    let Some(verdict) = prop(&body, "verdict")
        .and_then(Value::as_str)
        .filter(|v| VERDICTS.contains(v))
    else {
        return bad("verdict must be one of: safe, replace, uninstall");
    };
    let rationale = match prop(&body, "rationale") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return bad("rationale must be a string or null"),
    };
    let rationale = trimmed_or_null(rationale);
    let now = cx.now;
    let outcome = (|| -> Result<Vec<Value>, String> {
        let mut out = vec![];
        let tx =
            cx.w.conn
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
        cx.w.mark("BEGIN");
        let written = (|| -> Result<(), String> {
            for app_id in &app_ids {
                let existing = read_one(
                    cx,
                    "SELECT id, set_at FROM app_verdicts\n     WHERE app_id = ? AND source = 'user' AND source_name IS NULL",
                    &[text(app_id)],
                )?;
                let (id, first_set) = match existing {
                    Some(row) => {
                        let id = stats::text(&row["id"]).to_string();
                        cx.w.run(
                            UPDATE_VERDICT_BULK,
                            vec![json!(verdict), json!(rationale), json!(now), json!(id)],
                        )?;
                        (id, row["set_at"].clone())
                    }
                    None => {
                        let id = cx.ids.uuid(cx.w.conn)?;
                        cx.w.run(
                            INSERT_VERDICT_BULK,
                            vec![
                                json!(id),
                                json!(app_id),
                                json!(verdict),
                                json!(rationale),
                                json!(now),
                                json!(now),
                            ],
                        )?;
                        (id, json!(now))
                    }
                };
                out.push(verdict_json(
                    &id,
                    app_id,
                    verdict,
                    rationale.as_deref(),
                    first_set,
                    now,
                ));
            }
            Ok(())
        })();
        match written {
            Ok(()) => {
                cx.w.mark("COMMIT");
                tx.commit().map_err(|e| e.to_string())?;
            }
            Err(e) => {
                cx.w.mark("ROLLBACK");
                drop(tx);
                return Err(e);
            }
        }
        let n = app_ids.len();
        record_activity(
            cx.w,
            cx.ids,
            now,
            "bulk_verdict_set",
            "ok",
            None,
            Some(&format!(
                "Marked {n} {} {verdict}",
                if n == 1 { "app" } else { "apps" }
            )),
            Some(
                &json!({ "verdict": verdict, "count": n, "appIds": app_ids, "hasRationale": rationale.is_some() }),
            ),
            now,
        );
        Ok(out)
    })();
    match outcome {
        Ok(verdicts) => created(&json!({ "count": verdicts.len(), "verdicts": verdicts })),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to bulk-set verdicts",
        ),
    }
}

// ── /api/notifications ───────────────────────────────────────────────

fn notifications_post(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_optional(body) {
        Ok(v) => v,
        Err(Some(r)) => return r,
        Err(None) => json!({}),
    };
    if body.is_null() {
        return internal_error();
    }
    let action = prop(&body, "action").and_then(Value::as_str);
    if action == Some("mark_read") {
        if cx.w.run(MARK_ALL_READ, vec![]).is_err() {
            return internal_error();
        }
        return json_ok(&json!({ "success": true }));
    }
    if action == Some("mark_unread") {
        let Some(Value::Array(raw)) = prop(&body, "ids") else {
            return bad("mark_unread requires `ids: string[]`");
        };
        let ids: Vec<&str> = raw
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.is_empty())
            .collect();
        if ids.is_empty() {
            return json_ok(&json!({ "success": true, "flipped": 0 }));
        }
        let capped = &ids[..ids.len().min(200)];
        let sql = format!(
            "UPDATE notifications SET read = 0 WHERE id IN ({})",
            vec!["?"; capped.len()].join(",")
        );
        match cx.w.run(&sql, capped.iter().map(|s| json!(s)).collect()) {
            Ok(flipped) => return json_ok(&json!({ "success": true, "flipped": flipped })),
            Err(_) => return internal_error(),
        }
    }
    bad("Unknown action")
}

// ── /api/annotations ─────────────────────────────────────────────────

fn get_annotation(cx: &Cx, id: &str) -> Result<Option<Value>, String> {
    Ok(read_one(
        cx,
        "SELECT id, app_id, content, source, source_name, visibility, tag,\n            created_at, updated_at, deleted_at\n     FROM annotations WHERE id = ?",
        &[text(id)],
    )?
    .map(|r| {
        json!({
            "id": r["id"],
            "appId": r["app_id"],
            "content": r["content"],
            "source": r["source"],
            "sourceName": r["source_name"],
            "visibility": r["visibility"],
            "tag": r["tag"],
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
            "deletedAt": r["deleted_at"],
        })
    }))
}

fn annotation_activity(
    cx: &mut Cx,
    kind: &str,
    app_id: &Value,
    summary: &str,
    detail: Value,
    now: i64,
) {
    record_activity(
        cx.w,
        cx.ids,
        now,
        kind,
        "ok",
        app_id.as_str(),
        Some(summary),
        Some(&detail),
        now,
    );
}

fn annotation_post(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let Some(app_id) = prop(&body, "appId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return bad("appId is required");
    };
    let Some(content) = prop(&body, "content")
        .and_then(Value::as_str)
        .filter(|c| !js_trim(c).is_empty())
    else {
        return bad("content is required");
    };
    if js_length(content) > 8000 {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "content must be 8000 characters or fewer",
        );
    }
    let tag = match prop(&body, "tag") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_str().filter(|t| ANNOTATION_TAGS.contains(t)) {
            Some(t) => Some(t),
            None => return bad("tag must be one of: concern, positive, follow_up, other"),
        },
    };
    let visibility = match prop(&body, "visibility") {
        None => "export",
        Some(v) => match v.as_str().filter(|t| ANNOTATION_VISIBILITIES.contains(t)) {
            Some(t) => t,
            None => return bad("visibility must be one of: export, private"),
        },
    };
    let source = match prop(&body, "source") {
        None => "user",
        Some(v) => match v.as_str().filter(|s| *s == "user" || *s == "imported") {
            Some(s) => s,
            None => return bad("source must be user or imported"),
        },
    };
    let source_name = prop(&body, "sourceName").cloned().unwrap_or(Value::Null);
    let now = cx.now;
    let outcome = (|| -> Result<Value, String> {
        let id = cx.ids.uuid(cx.w.conn)?;
        cx.w.run(
            INSERT_ANNOTATION,
            vec![
                json!(id),
                json!(app_id),
                json!(content),
                json!(source),
                source_name,
                json!(visibility),
                json!(tag),
                json!(now),
                json!(now),
            ],
        )?;
        if source == "user" {
            annotation_activity(
                cx,
                "annotation_created",
                &json!(app_id),
                "Note created",
                json!({ "annotationId": id, "tag": tag, "visibility": visibility }),
                now,
            );
        }
        get_annotation(cx, &id)?.ok_or_else(|| "annotation vanished".to_string())
    })();
    match outcome {
        Ok(a) => created(&json!({ "annotation": a })),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create annotation",
        ),
    }
}

fn annotation_patch(cx: &mut Cx, id: &str, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let tag = prop(&body, "tag");
    if let Some(t) = tag.filter(|t| !t.is_null()) {
        if !t.as_str().is_some_and(|t| ANNOTATION_TAGS.contains(&t)) {
            return bad("tag must be one of: concern, positive, follow_up, other");
        }
    }
    let content = prop(&body, "content");
    if let Some(c) = content {
        let Some(c) = c.as_str() else {
            return bad("content must be a string");
        };
        if js_length(c) > 8000 {
            return json_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "content must be 8000 characters or fewer",
            );
        }
    }
    let visibility = prop(&body, "visibility");
    if let Some(v) = visibility {
        if !v
            .as_str()
            .is_some_and(|v| ANNOTATION_VISIBILITIES.contains(&v))
        {
            return bad("visibility must be one of: export, private");
        }
    }
    let now = cx.now;
    let outcome = (|| -> Result<Option<Value>, String> {
        let Some(existing) = get_annotation(cx, id)? else {
            return Ok(None);
        };
        if !existing["deletedAt"].is_null() {
            return Ok(None);
        }
        let mut sets = vec!["updated_at = ?"];
        let mut params = vec![json!(now)];
        if let Some(c) = content {
            sets.push("content = ?");
            params.push(c.clone());
        }
        if let Some(v) = visibility {
            sets.push("visibility = ?");
            params.push(v.clone());
        }
        if let Some(t) = tag {
            sets.push("tag = ?");
            params.push(
                if t.as_str().is_some_and(|t| ANNOTATION_TAGS.contains(&t)) {
                    t.clone()
                } else {
                    Value::Null
                },
            );
        }
        params.push(json!(id));
        cx.w.run(
            &format!("UPDATE annotations SET {} WHERE id = ?", sets.join(", ")),
            params,
        )?;
        annotation_activity(
            cx,
            "annotation_edited",
            &existing["appId"],
            "Note edited",
            json!({ "annotationId": id }),
            now,
        );
        get_annotation(cx, id)
    })();
    match outcome {
        Ok(Some(a)) => json_ok(&json!({ "annotation": a })),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            "Annotation not found or already deleted",
        ),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to update annotation",
        ),
    }
}

fn annotation_delete(cx: &mut Cx, id: &str) -> Response {
    let now = cx.now;
    let outcome = (|| -> Result<Option<Value>, String> {
        let Some(existing) = get_annotation(cx, id)? else {
            return Ok(None);
        };
        if !existing["deletedAt"].is_null() {
            return Ok(Some(existing));
        }
        cx.w.run(
            SOFT_DELETE_ANNOTATION,
            vec![json!(now), json!(now), json!(id)],
        )?;
        annotation_activity(
            cx,
            "annotation_deleted",
            &existing["appId"],
            "Note deleted",
            json!({ "annotationId": id }),
            now,
        );
        get_annotation(cx, id)
    })();
    match outcome {
        Ok(Some(a)) => json_ok(&json!({ "annotation": a })),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Annotation not found"),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to delete annotation",
        ),
    }
}

fn annotation_restore(cx: &mut Cx, id: &str) -> Response {
    let now = cx.now;
    let outcome = (|| -> Result<Response, String> {
        let Some(existing) = get_annotation(cx, id)? else {
            return Ok(json_error(
                StatusCode::NOT_FOUND,
                "Annotation not found or already purged",
            ));
        };
        let Some(deleted_at) = existing["deletedAt"].as_f64() else {
            return Ok(json_ok(&json!({ "annotation": existing })));
        };
        if now as f64 - deleted_at > SOFT_DELETE_WINDOW_MS as f64 {
            return Ok(json_error(StatusCode::GONE, "Undo window has elapsed"));
        }
        cx.w.run(RESTORE_ANNOTATION, vec![json!(now), json!(id)])?;
        Ok(json_ok(&json!({ "annotation": get_annotation(cx, id)? })))
    })();
    outcome.unwrap_or_else(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to restore annotation",
        )
    })
}

// ── /api/apps/[id]/acknowledge and undo ──────────────────────────────

fn acknowledge(cx: &mut Cx, app_id: &str, body: BodyOutcome) -> Response {
    let body = match body_optional(body) {
        Ok(v) => v,
        Err(Some(r)) => return r,
        Err(None) => return bad("Invalid JSON body"),
    };
    // `body?.action`: a null body reads as undefined throughout.
    let raw_action = prop(&body, "action")
        .and_then(Value::as_str)
        .map_or("reviewed", js_trim);
    if !REVIEW_ACTIONS.contains(&raw_action) {
        return bad("Invalid action. Must be one of: reviewed, dismissed, snoozed, unsnoozed");
    }
    let action = raw_action;
    let snooze_days = if action == "snoozed" {
        let raw = prop(&body, "snoozeDays").map_or(f64::NAN, js_to_number);
        Some(if SNOOZE_DAYS.contains(&raw) { raw } else { 7.0 })
    } else {
        None
    };
    let now = cx.now;
    let outcome = (|| -> Result<Value, String> {
        let id = cx.ids.uuid(cx.w.conn)?;
        let pending = routes_detail::get_unacknowledged_changes(cx.w.conn, app_id)
            .map_err(|e| e.to_string())?;
        let covered_ids: Vec<Value> = pending.events.iter().map(|e| e.id.clone()).collect();
        let covered_json = if covered_ids.is_empty() {
            Value::Null
        } else {
            json!(stringify(&Value::Array(covered_ids.clone())))
        };
        let pre_state = read_one(
            cx,
            "SELECT changeCount, changes_acknowledged_at, changes_snoozed_until\n         FROM apps WHERE id = ?",
            &[text(app_id)],
        )?
        .map(|r| json!({
            "changeCount": r["changeCount"],
            "changesAcknowledgedAt": r["changes_acknowledged_at"],
            "changesSnoozedUntil": r["changes_snoozed_until"],
        }));
        let snooze_until =
            snooze_days.map(|days| now + (days * 24.0 * 60.0 * 60.0 * 1000.0) as i64);
        let tx =
            cx.w.conn
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
        cx.w.mark("BEGIN");
        let written = (|| -> Result<(), String> {
            cx.w.run(
                INSERT_REVIEW_ACTION,
                vec![
                    json!(id),
                    json!(app_id),
                    json!(action),
                    json!(now),
                    json!(pending.total_count),
                    covered_json,
                    json!(snooze_until),
                    Value::Null,
                ],
            )?;
            match action {
                "reviewed" | "dismissed" => {
                    cx.w.run(ACK_APP, vec![json!(now), json!(app_id)])?;
                    cx.w.run(ACK_NOTIFICATIONS, vec![json!(app_id)])?;
                }
                "snoozed" => {
                    cx.w.run(SNOOZE_APP, vec![json!(snooze_until), json!(app_id)])?;
                }
                _ => {
                    cx.w.run(UNSNOOZE_APP, vec![json!(app_id)])?;
                }
            }
            Ok(())
        })();
        match written {
            Ok(()) => {
                cx.w.mark("COMMIT");
                tx.commit().map_err(|e| e.to_string())?;
            }
            Err(e) => {
                cx.w.mark("ROLLBACK");
                drop(tx);
                return Err(e);
            }
        }
        let mut record = json!({
            "id": id,
            "app_id": app_id,
            "action": action,
            "acted_at": now,
            "covered_count": pending.total_count,
            "covered_snapshot_ids": covered_ids,
            "snooze_until": snooze_until,
            "note": Value::Null,
        });
        if let Some(pre) = pre_state {
            record["pre_state"] = pre;
        }
        Ok(json!({ "ok": true, "record": record }))
    })();
    match outcome {
        Ok(v) => json_ok(&v),
        // The transaction's throw is uncaught in Node: the generic 500.
        Err(_) => internal_error(),
    }
}

fn acknowledge_undo(cx: &mut Cx, app_id: &str, body: BodyOutcome) -> Response {
    let body = match body_optional(body) {
        Ok(v) => v,
        Err(Some(r)) => return r,
        Err(None) => return bad("Invalid JSON body"),
    };
    let action_id = prop(&body, "actionId")
        .and_then(Value::as_str)
        .map_or("", js_trim);
    if action_id.is_empty() {
        return bad("Missing actionId");
    }
    let raw = prop(&body, "preState")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!({}));
    // `Number(raw.x)`: an absent property is `undefined`, which is NaN.
    let number = |k: &str| prop(&raw, k).map_or(f64::NAN, js_to_number);
    let values = [
        number("changeCount"),
        number("changesAcknowledgedAt"),
        number("changesSnoozedUntil"),
    ];
    if !values.iter().all(|n| n.is_finite() && *n >= 0.0) {
        return bad("preState fields must be finite, non-negative numbers");
    }
    let floored: Vec<Value> = values.iter().map(|n| js_number(n.floor())).collect();
    let outcome = (|| -> Result<bool, String> {
        let tx =
            cx.w.conn
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
        cx.w.mark("BEGIN");
        let result = (|| -> Result<bool, String> {
            let deleted =
                cx.w.run(DELETE_REVIEW_ACTION, vec![json!(action_id), json!(app_id)])?;
            if deleted == 0 {
                return Ok(false);
            }
            cx.w.run(
                RESTORE_APP_STATE,
                vec![
                    floored[0].clone(),
                    floored[1].clone(),
                    floored[2].clone(),
                    json!(app_id),
                ],
            )?;
            Ok(true)
        })();
        match result {
            Ok(ok) => {
                cx.w.mark("COMMIT");
                tx.commit().map_err(|e| e.to_string())?;
                Ok(ok)
            }
            Err(e) => {
                cx.w.mark("ROLLBACK");
                drop(tx);
                Err(e)
            }
        }
    })();
    match outcome {
        Ok(true) => json_ok(&json!({ "ok": true })),
        Ok(false) => json_error(
            StatusCode::GONE,
            "Review action no longer exists or does not belong to this app",
        ),
        Err(_) => internal_error(),
    }
}

// ── /api/user-tasks and /api/user-tasks/visit ────────────────────────

fn task_ids() -> Vec<&'static str> {
    metadata()["tasks"]
        .as_array()
        .map(|defs| defs.iter().filter_map(|d| d["id"].as_str()).collect())
        .unwrap_or_default()
}

fn task_is_opt_in(id: &str) -> bool {
    metadata()["tasks"]
        .as_array()
        .and_then(|defs| defs.iter().find(|d| d["id"] == id))
        .is_some_and(|d| d["optInOnly"] == true)
}

/// `getUserTasksState`: the blob sanitised — known ids, finite numbers,
/// and each entry rebuilt in the fixed `started_at, dismissed_at,
/// opted_in_at` order.
fn user_tasks_state(cx: &Cx) -> Map<String, Value> {
    let empty = || Map::new();
    let raw = cx.get("user_tasks_state", "");
    if raw.is_empty() {
        return empty();
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return empty();
    };
    let Value::Object(obj) = parsed else {
        return empty();
    };
    if obj.get("version") != Some(&json!(1)) {
        return empty();
    }
    let Some(Value::Object(tasks)) = obj.get("tasks") else {
        return empty();
    };
    let known = task_ids();
    let mut out = Map::new();
    for (id, entry) in js_entries(tasks) {
        if !known.contains(&id.as_str()) || !is_object_like(entry) {
            continue;
        }
        let mut cleaned = Map::new();
        for key in ["started_at", "dismissed_at", "opted_in_at"] {
            if let Some(n) = entry
                .as_object()
                .and_then(|o| o.get(key))
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
            {
                cleaned.insert(key.to_string(), js_number(n));
            }
        }
        out.insert(id.clone(), Value::Object(cleaned));
    }
    out
}

fn write_tasks_state(cx: &mut Cx, tasks: Map<String, Value>) -> Result<(), String> {
    let blob = stringify(&json!({ "version": 1, "tasks": tasks }));
    cx.w.run(SET_SETTING, vec![json!("user_tasks_state"), json!(blob)])
        .map(drop)
}

fn tasks_response(cx: &Cx) -> Response {
    match user_tasks::read(cx.w.conn, cx.now) {
        Ok(v) => json_ok(&v),
        Err(e) => {
            super::diag::log_error(format!("[user-tasks] {e}"));
            json_ok(&json!({ "tasks": [], "candidates": [] }))
        }
    }
}

fn user_tasks_post(cx: &mut Cx, body: BodyOutcome, actor: &Actor) -> Response {
    let body = match body_json(body, "invalid json") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return bad("expected object body");
    }
    let Some(action) = prop(&body, "action")
        .and_then(Value::as_str)
        .filter(|a| TASK_ACTIONS.contains(a))
    else {
        return bad("action must be one of 'start', 'dismiss', 'reset', 'opt_in', 'clear_all'");
    };
    if action == "clear_all" {
        if write_tasks_state(cx, Map::new()).is_err() {
            return internal_error();
        }
        return tasks_response(cx);
    }
    let Some(id) = prop(&body, "id")
        .and_then(Value::as_str)
        .filter(|id| task_ids().contains(id))
    else {
        return bad("unknown task id");
    };
    let now = cx.now;
    let stamp = |cx: &mut Cx, key: &str| -> Result<(), String> {
        let mut tasks = user_tasks_state(cx);
        let mut entry = tasks
            .get(id)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        entry.insert(key.to_string(), json!(now));
        tasks.insert(id.to_string(), Value::Object(entry));
        write_tasks_state(cx, tasks)
    };
    let written = match action {
        "start" => {
            let result = stamp(cx, "started_at");
            if let Some(missing) = prop(&body, "missingPrerequisite")
                .and_then(Value::as_str)
                .filter(|m| task_ids().contains(m))
            {
                let detail = stringify(&json!({ "taskId": id, "missingPrerequisite": missing }));
                record_audit(
                    cx.w,
                    cx.ids,
                    now,
                    "task_gate_bypassed",
                    actor,
                    Some(&detail),
                    true,
                );
            }
            result
        }
        "dismiss" => stamp(cx, "dismissed_at"),
        "opt_in" => {
            if !task_is_opt_in(id) {
                Ok(())
            } else {
                let mut tasks = user_tasks_state(cx);
                let mut entry = tasks
                    .get(id)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if !entry.get("opted_in_at").is_some_and(stats::truthy) {
                    entry.insert("opted_in_at".to_string(), json!(now));
                    tasks.insert(id.to_string(), Value::Object(entry));
                }
                write_tasks_state(cx, tasks)
            }
        }
        _ => {
            let mut tasks = user_tasks_state(cx);
            tasks.shift_remove(id);
            write_tasks_state(cx, tasks)
        }
    };
    if written.is_err() {
        return internal_error();
    }
    tasks_response(cx)
}

fn user_tasks_visit(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "invalid json") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(surface) = prop(&body, "surface")
        .and_then(Value::as_str)
        .filter(|s| VISIT_SURFACES.contains(s))
    else {
        return bad("surface must be one of: privacy_map, compare, app_detail");
    };
    let key = format!("task_visit.{surface}_at");
    // `setSettingIfUnset`, its failure logged rather than raised.
    let existing = cx.get(&key, "");
    if existing.is_empty() {
        if let Err(e) =
            cx.w.run(SET_SETTING, vec![json!(key), json!(cx.now.to_string())])
        {
            super::diag::log_warn(format!("[user-tasks/visit] marker write failed: {e}"));
        }
    }
    json_ok(&json!({ "ok": true, "surface": surface }))
}

// ── /api/activity/queue-session ──────────────────────────────────────

fn queue_session(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let totals = prop(&body, "totals")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!({}));
    // `Number(totals.x ?? 0)`.
    let total = |k: &str| {
        js_to_number(
            prop(&totals, k)
                .filter(|v| !v.is_null())
                .unwrap_or(&json!(0)),
        )
    };
    let decided = total("decided");
    let safe = total("safe");
    let replace = total("replace");
    let uninstall = total("uninstall");
    let notes_added = total("notesAdded");
    let preflight = prop(&body, "preflight")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!({}));
    let scope = prop(&preflight, "scope")
        .and_then(Value::as_str)
        .filter(|s| QUEUE_SCOPES.contains(s))
        .unwrap_or("unknown");
    let sort = prop(&preflight, "sort")
        .and_then(Value::as_str)
        .filter(|s| QUEUE_SORTS.contains(s))
        .unwrap_or("unknown");
    let split = match prop(&preflight, "split") {
        Some(Value::Null) => Value::Null,
        Some(v) if v.as_f64().is_some_and(|n| [10.0, 25.0, 50.0].contains(&n)) => v.clone(),
        _ => json!("unknown"),
    };
    if decided == 0.0 {
        return no_content();
    }
    let spell = |n: f64| js_number_spelling(n);
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "queue_session_completed",
        "ok",
        None,
        Some(&format!(
            "Queue session: {} decided · {} safe · {} replace · {} uninstall",
            spell(decided),
            spell(safe),
            spell(replace),
            spell(uninstall)
        )),
        Some(&json!({
            "decided": js_number(decided),
            "safe": js_number(safe),
            "replace": js_number(replace),
            "uninstall": js_number(uninstall),
            "notesAdded": js_number(notes_added),
            "preflight": { "scope": scope, "sort": sort, "split": split },
        })),
        cx.now,
    );
    no_content()
}

fn no_content() -> Response {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .expect("empty response")
}

// ── /api/devices ─────────────────────────────────────────────────────

fn device_by_id(cx: &Cx, id: &str) -> Result<Option<Value>, String> {
    routes_devices::by_id(cx.w.conn, id).map_err(|e| e.to_string())
}

/// `createDevice` as the routes call it: no ownership at creation.
fn create_device(
    cx: &mut Cx,
    name: &str,
    ecid: Option<&str>,
    model: Option<&str>,
    ios_version: Option<&str>,
    device_class: Option<&str>,
) -> Result<Value, String> {
    let name = js_trim(name);
    if name.is_empty() {
        return Err("device name must not be empty".into());
    }
    let id = cx.ids.uuid(cx.w.conn)?;
    let now = cx.now;
    cx.w.run(
        INSERT_DEVICE,
        vec![
            json!(id),
            json!(name),
            json!(ecid),
            json!(model),
            json!(ios_version),
            json!(device_class),
            json!(now),
            json!(now),
            Value::Null,
            Value::Null,
            Value::Null,
        ],
    )?;
    device_by_id(cx, &id)?.ok_or_else(|| "device vanished".to_string())
}

/// `findOrCreateDeviceByEcid`.
fn find_or_create_by_ecid(
    cx: &mut Cx,
    ecid: &str,
    name: &str,
    model: Option<&str>,
    ios_version: Option<&str>,
    device_class: Option<&str>,
) -> Result<Value, String> {
    let trimmed = js_trim(ecid);
    if trimmed.is_empty() {
        return Err("ecid must not be empty".into());
    }
    let existing = read_one(cx, "SELECT * FROM devices WHERE ecid = ?", &[text(trimmed)])?;
    let Some(existing) = existing else {
        return create_device(cx, name, Some(trimmed), model, ios_version, device_class);
    };
    let mut updates = vec![];
    let mut values = vec![];
    for (meta, column, current) in [
        (model, "model", &existing["model"]),
        (ios_version, "ios_version", &existing["ios_version"]),
        (device_class, "device_class", &existing["device_class"]),
    ] {
        if let Some(m) = meta.filter(|m| !m.is_empty()) {
            if current.as_str() != Some(m) {
                updates.push(format!("{column} = ?"));
                values.push(json!(m));
            }
        }
    }
    if !updates.is_empty() {
        values.push(existing["id"].clone());
        cx.w.run(
            &format!("UPDATE devices SET {} WHERE id = ?", updates.join(", ")),
            values,
        )?;
    }
    device_by_id(cx, stats::text(&existing["id"]))?.ok_or_else(|| "device vanished".to_string())
}

struct OwnerPatch<'a> {
    label: Option<Option<&'a str>>,
    audience: Option<Option<&'a str>>,
    permission_acknowledged: Option<bool>,
}

/// `setDeviceOwner`.
fn set_device_owner(cx: &mut Cx, id: &str, owner: OwnerPatch) -> Result<(), String> {
    let mut updates = vec![];
    let mut values = vec![];
    if let Some(label) = owner.label {
        updates.push("owner_label = ?");
        values.push(
            label
                .map(js_trim)
                .filter(|l| !l.is_empty())
                .map_or(Value::Null, |l| json!(l)),
        );
    }
    let next_audience: Option<Option<&str>> = owner
        .audience
        .map(|a| a.filter(|a| OWNER_AUDIENCES.contains(a)));
    if let Some(a) = next_audience {
        updates.push("owner_audience = ?");
        values.push(a.map_or(Value::Null, |a| json!(a)));
    }
    let resolved: Option<String> = match next_audience {
        Some(a) => a.map(str::to_string),
        None => device_by_id(cx, id)?.and_then(|d| d["ownerAudience"].as_str().map(str::to_string)),
    };
    let became_self_or_none = matches!(next_audience, Some(None) | Some(Some("self")));
    if owner.permission_acknowledged.is_some() || became_self_or_none {
        let stamp = if owner.permission_acknowledged == Some(true)
            && resolved.as_deref().is_some_and(|a| a != "self")
        {
            json!(cx.now)
        } else {
            Value::Null
        };
        updates.push("permission_acknowledged_at = ?");
        values.push(stamp);
    }
    if updates.is_empty() {
        return Ok(());
    }
    values.push(json!(id));
    cx.w.run(
        &format!("UPDATE devices SET {} WHERE id = ?", updates.join(", ")),
        values,
    )
    .map(drop)
}

/// The three ownership validations the create and patch routes share.
fn validate_ownership(body: &Map<String, Value>) -> Option<Response> {
    if let Some(label) = body.get("ownerLabel") {
        if !(label.is_null() || label.is_string()) {
            return Some(bad("ownerLabel must be a string or null"));
        }
    }
    if let Some(audience) = body.get("ownerAudience") {
        if !(audience.is_null()
            || audience
                .as_str()
                .is_some_and(|a| OWNER_AUDIENCES.contains(&a)))
        {
            return Some(bad(
                "ownerAudience must be self, loved_one, guardian, or null",
            ));
        }
    }
    if let Some(ack) = body.get("permissionAcknowledged") {
        if !ack.is_boolean() {
            return Some(bad("permissionAcknowledged must be a boolean"));
        }
    }
    None
}

fn owner_patch(body: &Map<String, Value>) -> OwnerPatch<'_> {
    OwnerPatch {
        label: body.get("ownerLabel").map(Value::as_str),
        audience: body.get("ownerAudience").map(Value::as_str),
        permission_acknowledged: body.get("permissionAcknowledged").and_then(Value::as_bool),
    }
}

fn owner_audit(cx: &mut Cx, actor: &Actor, id: &str, body: &Map<String, Value>) {
    let ack = body.get("permissionAcknowledged");
    let action = if ack == Some(&Value::Bool(true)) {
        "devices.permission_acknowledged"
    } else {
        "devices.set_owner"
    };
    let detail = stringify_present(&[
        ("id", Some(&json!(id))),
        ("ownerLabel", body.get("ownerLabel")),
        ("ownerAudience", body.get("ownerAudience")),
        ("permissionAcknowledged", ack),
    ]);
    record_audit(cx.w, cx.ids, cx.now, action, actor, Some(&detail), true);
}

fn trimmed_field(body: &Map<String, Value>, key: &str) -> Option<String> {
    body.get(key)
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn device_post(cx: &mut Cx, body: BodyOutcome, actor: &Actor) -> Response {
    let body = match body_json(body, "invalid json") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return bad("expected object body");
    }
    let obj = body.as_object().cloned().unwrap_or_default();
    // Order: the two ownership shapes, the acknowledgement, then the name.
    if let Some(refused) = validate_ownership(&obj) {
        return refused;
    }
    let Some(name) = trimmed_field(&obj, "name") else {
        return bad("name required");
    };
    let ecid = trimmed_field(&obj, "ecid");
    let model = trimmed_field(&obj, "model");
    let ios_version = trimmed_field(&obj, "iosVersion");
    let device_class = trimmed_field(&obj, "deviceClass");
    let has_ownership = obj.contains_key("ownerAudience") || obj.contains_key("ownerLabel");
    let outcome = (|| -> Result<Value, String> {
        let device = match &ecid {
            Some(ecid) => find_or_create_by_ecid(
                cx,
                ecid,
                &name,
                model.as_deref(),
                ios_version.as_deref(),
                device_class.as_deref(),
            )?,
            None => create_device(
                cx,
                &name,
                None,
                model.as_deref(),
                ios_version.as_deref(),
                device_class.as_deref(),
            )?,
        };
        let id = stats::text(&device["id"]).to_string();
        let detail = stringify(&json!({ "id": id, "ecid": device["ecid"] }));
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "devices.create",
            actor,
            Some(&detail),
            true,
        );
        if has_ownership || obj.contains_key("permissionAcknowledged") {
            set_device_owner(cx, &id, owner_patch(&obj))?;
            owner_audit(cx, actor, &id, &obj);
        }
        Ok(json!({ "device": device_by_id(cx, &id)? }))
    })();
    match outcome {
        Ok(v) => json_ok(&v),
        Err(message) => bad(&message),
    }
}

/// `deleteDevice(id, { reassignToDeviceId })`.
fn merge_device(cx: &mut Cx, id: &str, target: &str) -> Result<(), String> {
    if target == id {
        return Err("cannot reassign a device to itself".into());
    }
    if device_by_id(cx, target)?.is_none() {
        return Err(format!("reassign target device not found: {target}"));
    }
    let tx =
        cx.w.conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
    cx.w.mark("BEGIN");
    let written = (|| -> Result<(), String> {
        let conflicts = read_rows(
            cx,
            "\n          SELECT s.app_id AS app_id\n          FROM app_devices s\n          WHERE s.device_id = ?\n            AND EXISTS (\n              SELECT 1 FROM app_devices t\n              WHERE t.app_id = s.app_id AND t.device_id = ?\n            )\n        ",
            &[text(id), text(target)],
        )?;
        for c in conflicts {
            cx.w.run(DELETE_APP_DEVICE, vec![c["app_id"].clone(), json!(id)])?;
        }
        cx.w.run(REPOINT_APP_DEVICES, vec![json!(target), json!(id)])?;
        cx.w.run(REPOINT_IMPORTS, vec![json!(target), json!(id)])?;
        cx.w.run(DELETE_DEVICE, vec![json!(id)])?;
        Ok(())
    })();
    match written {
        Ok(()) => {
            cx.w.mark("COMMIT");
            tx.commit().map_err(|e| e.to_string())
        }
        Err(e) => {
            cx.w.mark("ROLLBACK");
            drop(tx);
            Err(e)
        }
    }
}

/// `hasAttachedUserData`: three probes, each swallowing its own failure —
/// the shortlist one always fails (the table has no `app_id` column), so
/// a shortlist entry never keeps an app alive.
fn has_attached_user_data(cx: &Cx, app_id: &str) -> bool {
    for sql in [
        "SELECT 1 FROM app_verdicts WHERE app_id = ? AND source = 'user' LIMIT 1",
        "SELECT 1 FROM annotations WHERE app_id = ? LIMIT 1",
        "SELECT 1 FROM shortlist_entries WHERE app_id = ? LIMIT 1",
    ] {
        if let Ok(Some(_)) = read_one(cx, sql, &[text(app_id)]) {
            return true;
        }
    }
    false
}

fn orphan_sweep_app(cx: &mut Cx, app_id: &str) -> Result<bool, String> {
    let links: i64 =
        cx.w.conn
            .query_row(
                "SELECT COUNT(*) AS n FROM app_devices WHERE app_id = ?",
                [app_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
    if links > 0 || has_attached_user_data(cx, app_id) {
        return Ok(false);
    }
    cx.w.run(DELETE_APP, vec![json!(app_id)])?;
    Ok(true)
}

fn device_patch(cx: &mut Cx, id: &str, body: BodyOutcome, actor: &Actor) -> Response {
    let body = match body_json(body, "invalid json") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return bad("expected object body");
    }
    let obj = body.as_object().cloned().unwrap_or_default();
    // Order here: the acknowledgement first, then label, then audience.
    if let Some(ack) = obj.get("permissionAcknowledged") {
        if !ack.is_boolean() {
            return bad("permissionAcknowledged must be a boolean");
        }
    }
    if let Some(refused) = validate_ownership(&obj) {
        return refused;
    }
    let outcome = (|| -> Result<Response, String> {
        if let Some(target) = obj
            .get("mergeIntoDeviceId")
            .and_then(Value::as_str)
            .filter(|t| !js_trim(t).is_empty())
        {
            merge_device(cx, id, js_trim(target))?;
            let detail = stringify(&json!({ "sourceId": id, "targetId": target }));
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "devices.merge",
                actor,
                Some(&detail),
                true,
            );
            return Ok(json_ok(&json!({ "merged": true, "orphanedAndDeleted": 0 })));
        }
        let mut updated = false;
        if let Some(name) = trimmed_field(&obj, "name") {
            cx.w.run(RENAME_DEVICE, vec![json!(name), json!(id)])?;
            let detail = stringify(&json!({ "id": id, "name": name }));
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "devices.rename",
                actor,
                Some(&detail),
                true,
            );
            updated = true;
        }
        if obj.contains_key("ownerLabel")
            || obj.contains_key("ownerAudience")
            || obj.contains_key("permissionAcknowledged")
        {
            set_device_owner(cx, id, owner_patch(&obj))?;
            owner_audit(cx, actor, id, &obj);
            updated = true;
        }
        if updated {
            return Ok(json_ok(&json!({ "device": device_by_id(cx, id)? })));
        }
        Ok(bad("nothing to update"))
    })();
    match outcome {
        Ok(r) => r,
        Err(message) => bad(&message),
    }
}

fn device_delete(cx: &mut Cx, id: &str, actor: &Actor) -> Response {
    let outcome = (|| -> Result<i64, String> {
        let affected = read_rows(
            cx,
            "SELECT app_id FROM app_devices WHERE device_id = ?",
            &[text(id)],
        )?;
        cx.w.run(DELETE_DEVICE, vec![json!(id)])?;
        let mut orphaned = 0;
        for row in affected {
            if orphan_sweep_app(cx, stats::text(&row["app_id"]))? {
                orphaned += 1;
            }
        }
        Ok(orphaned)
    })();
    match outcome {
        Ok(orphaned) => {
            let detail = stringify(&json!({ "id": id, "orphanedAndDeleted": orphaned }));
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "devices.delete",
                actor,
                Some(&detail),
                true,
            );
            json_ok(&json!({ "orphanedAndDeleted": orphaned }))
        }
        Err(message) => bad(&message),
    }
}

fn scope_response(cx: &Cx, scope: &Value) -> Response {
    json_ok(&json!({ "scope": scope, "devices": routes_devices::picker_devices(cx.w.conn) }))
}

fn device_scope_put(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON body") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return bad("Body must be an object");
    }
    let Some(raw) = prop(&body, "scope").filter(|s| is_object_like(s)) else {
        return bad("Missing or invalid `scope` field");
    };
    let known: Vec<String> = read_rows(cx, "SELECT id FROM devices", &[])
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| r["id"].as_str().map(str::to_string))
        .collect();
    let scope = routes_devices::reconcile_scope(raw, &known);
    if cx
        .w
        .run(
            SET_SETTING,
            vec![json!("device.scope"), json!(stringify(&scope))],
        )
        .is_err()
    {
        return internal_error();
    }
    scope_response(cx, &scope)
}

fn device_scope_reset(cx: &mut Cx) -> Response {
    let scope = routes_devices::scope_all();
    if cx
        .w
        .run(
            SET_SETTING,
            vec![json!("device.scope"), json!(stringify(&scope))],
        )
        .is_err()
    {
        return internal_error();
    }
    scope_response(cx, &scope)
}

// ── /api/manual-apps ─────────────────────────────────────────────────

fn manual_source_ok(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
        .filter(|s| MANUAL_SOURCES.contains(s))
}

/// `hydrate`: an unknown stored source reads as `sideloaded`.
fn manual_app_json(r: &Value) -> Value {
    let source = r["source"]
        .as_str()
        .filter(|s| MANUAL_SOURCES.contains(s))
        .unwrap_or("sideloaded");
    json!({
        "id": r["id"],
        "name": r["name"],
        "source": source,
        "developer": r["developer"],
        "privacyPolicyUrl": r["privacy_policy_url"],
        "sourceUrl": r["source_url"],
        "notes": r["notes"],
        "firstSeen": r["first_seen"],
        "updatedAt": r["updated_at"],
    })
}

fn get_manual_app(cx: &Cx, id: &str) -> Result<Option<Value>, String> {
    Ok(read_one(
        cx,
        "SELECT id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at\n       FROM manual_apps WHERE id = ?",
        &[text(id)],
    )?
    .as_ref()
    .map(manual_app_json))
}

/// `normaliseString`: a trimmed non-empty string, else null.
fn normalise_string(v: Option<&str>) -> Option<String> {
    v.map(js_trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// `normaliseUrl`: the trimmed string through `validateExternalUrl`.
fn normalise_url(v: Option<&str>, field: &str) -> Result<Option<String>, String> {
    let Some(s) = normalise_string(v) else {
        return Ok(None);
    };
    outbound::validate(&s, &[], 2048)
        .map(|u| Some(u.to_string()))
        .map_err(|_| format!("{field} is not a valid URL"))
}

struct ManualInput<'a> {
    name: &'a str,
    source: &'a str,
    developer: Option<&'a str>,
    privacy_policy_url: Option<&'a str>,
    source_url: Option<&'a str>,
    notes: Option<&'a str>,
}

/// `createManualApp`.
fn create_manual_app(cx: &mut Cx, input: ManualInput) -> Result<Value, String> {
    let Some(name) = normalise_string(Some(input.name)) else {
        return Err("Name is required".into());
    };
    if !MANUAL_SOURCES.contains(&input.source) {
        return Err(MANUAL_SOURCE_ERROR.into());
    }
    let id = cx.ids.uuid(cx.w.conn)?;
    let now = cx.now;
    let developer = normalise_string(input.developer);
    let privacy_policy_url = normalise_url(input.privacy_policy_url, "privacyPolicyUrl")?;
    let source_url = normalise_url(input.source_url, "sourceUrl")?;
    let notes = normalise_string(input.notes);
    cx.w.run(
        INSERT_MANUAL_APP,
        vec![
            json!(id),
            json!(name),
            json!(input.source),
            json!(developer),
            json!(privacy_policy_url),
            json!(source_url),
            json!(notes),
            json!(now),
            json!(now),
        ],
    )?;
    Ok(json!({
        "id": id,
        "name": name,
        "source": input.source,
        "developer": developer,
        "privacyPolicyUrl": privacy_policy_url,
        "sourceUrl": source_url,
        "notes": notes,
        "firstSeen": now,
        "updatedAt": now,
    }))
}

fn manual_input<'a>(body: &'a Value, source: &'a str) -> ManualInput<'a> {
    let s = |k: &str| prop(body, k).and_then(Value::as_str);
    ManualInput {
        name: s("name").unwrap_or(""),
        source: MANUAL_SOURCES
            .into_iter()
            .find(|m| *m == source)
            .unwrap_or("sideloaded"),
        developer: s("developer"),
        privacy_policy_url: s("privacyPolicyUrl"),
        source_url: s("sourceUrl"),
        notes: s("notes"),
    }
}

fn manual_post(cx: &mut Cx, body: BodyOutcome, actor: &Actor) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let Some(source) = manual_source_ok(prop(&body, "source")) else {
        return bad(MANUAL_SOURCE_ERROR);
    };
    match create_manual_app(cx, manual_input(&body, source)) {
        Ok(app) => {
            let detail = format!(
                "id={} source={}",
                stats::text(&app["id"]),
                stats::text(&app["source"])
            );
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "manual-apps.create.success",
                actor,
                Some(&detail),
                true,
            );
            created(&json!({ "app": app }))
        }
        Err(message) => {
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "manual-apps.create.failed",
                actor,
                Some(&message),
                false,
            );
            bad(&message)
        }
    }
}

fn manual_id_ok(id: &str) -> bool {
    !id.is_empty() && js_length(id) <= 128
}

fn manual_put(cx: &mut Cx, id: &str, body: BodyOutcome, actor: &Actor) -> Response {
    if !manual_id_ok(id) {
        return bad("Invalid id");
    }
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    // `Object.hasOwn(null, …)` throws.
    if body.is_null() {
        return internal_error();
    }
    let obj = body.as_object().cloned().unwrap_or_default();
    // The patch, in the route's key order; the source is refused first.
    let mut fields: Vec<&str> = vec![];
    let mut patch: Map<String, Value> = Map::new();
    for key in [
        "name",
        "source",
        "developer",
        "privacyPolicyUrl",
        "sourceUrl",
        "notes",
    ] {
        let Some(v) = obj.get(key) else { continue };
        if key == "source" {
            if manual_source_ok(Some(v)).is_none() {
                return bad(MANUAL_SOURCE_ERROR);
            }
            patch.insert(key.into(), v.clone());
        } else if key == "name" {
            patch.insert(key.into(), json!(v.as_str().unwrap_or("")));
        } else {
            patch.insert(key.into(), str_or_null(Some(v)));
        }
        fields.push(key);
    }
    let now = cx.now;
    let outcome = (|| -> Result<Option<Value>, String> {
        let Some(existing) = get_manual_app(cx, id)? else {
            return Ok(None);
        };
        let mut next = existing.clone();
        next["updatedAt"] = json!(now);
        if let Some(v) = patch.get("name") {
            let Some(name) = normalise_string(v.as_str()) else {
                return Err("Name is required".into());
            };
            next["name"] = json!(name);
        }
        if let Some(v) = patch.get("source") {
            next["source"] = v.clone();
        }
        if let Some(v) = patch.get("developer") {
            next["developer"] = json!(normalise_string(v.as_str()));
        }
        if let Some(v) = patch.get("privacyPolicyUrl") {
            next["privacyPolicyUrl"] = json!(normalise_url(v.as_str(), "privacyPolicyUrl")?);
        }
        if let Some(v) = patch.get("sourceUrl") {
            next["sourceUrl"] = json!(normalise_url(v.as_str(), "sourceUrl")?);
        }
        if let Some(v) = patch.get("notes") {
            next["notes"] = json!(normalise_string(v.as_str()));
        }
        let mut diffs = vec![];
        for field in [
            "name",
            "source",
            "developer",
            "privacyPolicyUrl",
            "sourceUrl",
            "notes",
        ] {
            let (from, to) = (&existing[field], &next[field]);
            if from != to {
                diffs.push(
                    json!({ "kind": "field_change", "field": field, "from": from, "to": to }),
                );
            }
        }
        let tx =
            cx.w.conn
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
        cx.w.mark("BEGIN");
        let written = (|| -> Result<(), String> {
            cx.w.run(
                UPDATE_MANUAL_APP,
                vec![
                    next["name"].clone(),
                    next["source"].clone(),
                    next["developer"].clone(),
                    next["privacyPolicyUrl"].clone(),
                    next["sourceUrl"].clone(),
                    next["notes"].clone(),
                    json!(now),
                    json!(id),
                ],
            )?;
            for diff in &diffs {
                let event_id = cx.ids.uuid(cx.w.conn)?;
                cx.w.run(
                    INSERT_MANUAL_EVENT,
                    vec![
                        json!(event_id),
                        json!(id),
                        json!("field_change"),
                        json!(now),
                        json!(stringify(diff)),
                    ],
                )?;
            }
            Ok(())
        })();
        match written {
            Ok(()) => {
                cx.w.mark("COMMIT");
                tx.commit().map_err(|e| e.to_string())?;
            }
            Err(e) => {
                cx.w.mark("ROLLBACK");
                drop(tx);
                return Err(e);
            }
        }
        Ok(Some(next))
    })();
    match outcome {
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Not found"),
        Ok(Some(app)) => {
            let detail = format!("id={id} fields={}", fields.join(","));
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "manual-apps.update.success",
                actor,
                Some(&detail),
                true,
            );
            json_ok(&json!({ "app": app }))
        }
        Err(message) => {
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "manual-apps.update.failed",
                actor,
                Some(&message),
                false,
            );
            bad(&message)
        }
    }
}

/// `deleteManualAppHistory`: its own transaction.
fn delete_manual_history(cx: &mut Cx, id: &str) -> Result<(), String> {
    let tx =
        cx.w.conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
    cx.w.mark("BEGIN");
    let written =
        cx.w.run(DELETE_MANUAL_EVENTS, vec![json!(id)])
            .and_then(|_| cx.w.run(DELETE_MANUAL_VERSIONS, vec![json!(id)]));
    match written {
        Ok(_) => {
            cx.w.mark("COMMIT");
            tx.commit().map_err(|e| e.to_string())
        }
        Err(e) => {
            cx.w.mark("ROLLBACK");
            drop(tx);
            Err(e)
        }
    }
}

fn manual_delete(cx: &mut Cx, id: &str, actor: &Actor) -> Response {
    if !manual_id_ok(id) {
        return bad("Invalid id");
    }
    let removed =
        delete_manual_history(cx, id).and_then(|()| cx.w.run(DELETE_MANUAL_APP, vec![json!(id)]));
    match removed {
        Ok(0) => json_error(StatusCode::NOT_FOUND, "Not found"),
        Ok(_) => {
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "manual-apps.delete.success",
                actor,
                Some(&format!("id={id}")),
                true,
            );
            json_ok(&json!({ "success": true }))
        }
        Err(_) => internal_error(),
    }
}

fn manual_bulk(cx: &mut Cx, body: BodyOutcome, actor: &Actor) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let Some(Value::Array(rows)) =
        prop(&body, "apps").filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
    else {
        return bad("Expected { apps: [{ name, source, ... }, ...] }");
    };
    if rows.len() > 1000 {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!("Too many rows ({} > 1000). Split the batch.", rows.len()),
        );
    }
    let mut results = vec![];
    let mut created_count = 0;
    let mut failed = 0;
    for (index, row) in rows.iter().enumerate() {
        if !is_object_like(row) {
            results.push(json!({ "index": index, "ok": false, "error": "Row must be an object" }));
            failed += 1;
            continue;
        }
        let Some(source) = manual_source_ok(prop(row, "source")) else {
            results.push(json!({ "index": index, "ok": false, "error": MANUAL_SOURCE_ERROR }));
            failed += 1;
            continue;
        };
        let input = ManualInput {
            name: prop(row, "name").and_then(Value::as_str).unwrap_or(""),
            source,
            developer: prop(row, "developer").and_then(Value::as_str),
            privacy_policy_url: None,
            source_url: None,
            notes: None,
        };
        match create_manual_app(cx, input) {
            Ok(app) => {
                results.push(json!({ "index": index, "ok": true, "app": app }));
                created_count += 1;
            }
            Err(message) => {
                results.push(json!({ "index": index, "ok": false, "error": message }));
                failed += 1;
            }
        }
    }
    let detail = format!(
        "created={created_count} failed={failed} total={}",
        rows.len()
    );
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "manual-apps.bulk",
        actor,
        Some(&detail),
        created_count > 0,
    );
    json_response(
        if created_count > 0 {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        &json!({ "created": created_count, "failed": failed, "results": results }),
    )
}

fn manual_restore(cx: &mut Cx, url_id: &str, body: BodyOutcome, actor: &Actor) -> Response {
    if !manual_id_ok(url_id) {
        return bad("Invalid id");
    }
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let body_id = str_or(prop(&body, "id"), "");
    if body_id != url_id {
        return bad("Body id must match the URL id");
    }
    let Some(source) = manual_source_ok(prop(&body, "source")) else {
        return bad(MANUAL_SOURCE_ERROR);
    };
    let name = str_or(prop(&body, "name"), "");
    let field = |k: &str| str_or_null(prop(&body, k));
    let first_seen = prop(&body, "firstSeen").map_or(f64::NAN, js_to_number);
    let updated_at = prop(&body, "updatedAt").map_or(f64::NAN, js_to_number);
    let outcome = (|| -> Result<Option<Value>, String> {
        // `restoreManualApp`'s own checks, then the idempotent existence test.
        if js_trim(name).is_empty() {
            return Ok(None);
        }
        if get_manual_app(cx, body_id)?.is_some() {
            return Ok(None);
        }
        let first_seen = if first_seen.is_finite() && first_seen > 0.0 {
            first_seen.floor()
        } else {
            cx.now as f64
        };
        let updated_at = if updated_at.is_finite() && updated_at >= first_seen {
            updated_at.floor()
        } else {
            first_seen
        };
        let trimmed = js_trim(name);
        cx.w.run(
            INSERT_MANUAL_APP,
            vec![
                json!(body_id),
                json!(trimmed),
                json!(source),
                field("developer"),
                field("privacyPolicyUrl"),
                field("sourceUrl"),
                field("notes"),
                js_number(first_seen),
                js_number(updated_at),
            ],
        )?;
        Ok(Some(json!({
            "id": body_id,
            "name": trimmed,
            "source": source,
            "developer": field("developer"),
            "privacyPolicyUrl": field("privacyPolicyUrl"),
            "sourceUrl": field("sourceUrl"),
            "notes": field("notes"),
            "firstSeen": js_number(first_seen),
            "updatedAt": js_number(updated_at),
        })))
    })();
    match outcome {
        Ok(None) => {
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "manual-apps.restore.skipped",
                actor,
                Some(&format!("id={url_id}")),
                true,
            );
            json_error(
                StatusCode::CONFLICT,
                "Already exists or could not be restored",
            )
        }
        Ok(Some(app)) => {
            let detail = format!(
                "id={} source={}",
                stats::text(&app["id"]),
                stats::text(&app["source"])
            );
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "manual-apps.restore.success",
                actor,
                Some(&detail),
                true,
            );
            created(&json!({ "app": app }))
        }
        Err(_) => internal_error(),
    }
}

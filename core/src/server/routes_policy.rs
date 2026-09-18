//! Phase 5, batch 2: the policy reads and the manual-app policy scrape.
//!
//! - `GET /api/policy/status/[appId]` — the AI Policy tab's polling subset
//!   of the analysis: run status, start, log and status.
//! - `GET /api/policy/version/[id]` — one captured text (120 a minute).
//! - `GET /api/policy/version/[id]/diff` — that text against the latest
//!   earlier different one, through `crate::policy::diff` (60 a minute).
//! - `GET /api/manual-apps/[id]/policy-version/[versionId]` — one captured
//!   text of a manual app, refused across apps; it shares the manual-app
//!   read bucket with the app detail.
//! - `POST /api/manual-apps/[id]/scrape` — fetch the manual app's policy
//!   through `crate::policy::source`, fold identical text into one version
//!   row (`lib/manual-app-history.ts`), append a `scrape` event and an
//!   audit row. Its guard is the write framework's rate guard, with no
//!   `Retry-After`, as the route answers.
//!
//! The scrape takes a clock rather than the dispatcher's `now`: Node reads
//! the time before the fetch for the event and the version, and again after
//! it for the audit row.
use super::{
    guard::{record_audit, Actor},
    json::{json_error, json_ok},
    policy::get_policy_analysis,
    ratelimit::RateLimiter,
    routes_manual::rate_gate_with,
    row::row_to_json,
    sync_runner::{clock_for, Clock},
    writes::{RouteSpec, WriteRequest},
    AppState,
};
use crate::{
    jsstr::{js_length, js_slice_prefix, js_trim},
    outbound::Fetcher,
    policy::{
        diff::diff_policy_texts,
        source::{fetch_privacy_policy_source, SourceStatus, Trace},
    },
    scrape::persist::{DbAccess, Ids, Writer},
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

const VERSION_COLUMNS: &str = "id, app_id, content_hash, first_fetched_at, last_fetched_at,\n              policy_url, source_final_url, source_title, source_content_type,\n              source_origin, source_word_count, source_text,\n              archive_url, archive_submitted_at";
const INSERT_MANUAL_EVENT: &str = "INSERT INTO manual_app_events (id, manual_app_id, event_type, occurred_at, detail)\n     VALUES (?, ?, ?, ?, ?)";
const TOUCH_MANUAL_VERSION: &str =
    "UPDATE manual_app_policy_versions SET last_fetched_at = ? WHERE id = ?";
const INSERT_MANUAL_VERSION: &str = "INSERT INTO manual_app_policy_versions (\n       id, manual_app_id, content_hash, first_fetched_at, last_fetched_at,\n       policy_url, source_final_url, source_title, source_content_type,\n       source_origin, source_word_count, source_text\n     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const MANUAL_VERSION_SELECT: &str = "SELECT id, manual_app_id AS manualAppId, content_hash AS contentHash, first_fetched_at AS firstFetchedAt, last_fetched_at AS lastFetchedAt, policy_url AS policyUrl, source_final_url AS sourceFinalUrl, source_title AS sourceTitle, source_content_type AS sourceContentType, source_origin AS sourceOrigin, source_word_count AS sourceWordCount, source_text AS sourceText FROM manual_app_policy_versions";

/// A thrown handler: Next answers 500 with no body.
fn uncaught(e: impl std::fmt::Display) -> Response {
    super::diag::log_error(format!("[policy] {e}"));
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(Body::empty())
        .unwrap()
}

fn one(conn: &Connection, sql: &str, param: &str) -> rusqlite::Result<Option<Value>> {
    conn.query_row(sql, [param], row_to_json).optional()
}

/// `getPolicyVersion`.
fn policy_version(conn: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    one(
        conn,
        &format!(
            "SELECT {VERSION_COLUMNS}\n         FROM privacy_policy_versions\n        WHERE id = ?"
        ),
        id,
    )
}

/// `getPreviousPolicyVersion`: the latest earlier row of the same app with
/// different text.
fn previous_policy_version(conn: &Connection, current: &Value) -> rusqlite::Result<Option<Value>> {
    conn.query_row(
        &format!(
            "SELECT {VERSION_COLUMNS}\n         FROM privacy_policy_versions\n        WHERE app_id = ?\n          AND content_hash != ?\n          AND first_fetched_at < ?\n        ORDER BY first_fetched_at DESC\n        LIMIT 1"
        ),
        rusqlite::params![
            current["app_id"].as_str(),
            current["content_hash"].as_str(),
            current["first_fetched_at"].as_i64(),
        ],
        row_to_json,
    )
    .optional()
}

/// The id guard of the two version reads and the scrape.
fn bad_id(id: &str) -> bool {
    id.is_empty() || js_length(id) > 128
}

/// `GET /api/policy/status/[appId]`.
pub(super) fn status_with(conn: &Connection, app_id: &str) -> Response {
    let app_id = js_trim(app_id);
    if !(1..=20).contains(&app_id.len()) || !app_id.bytes().all(|b| b.is_ascii_digit()) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid appId");
    }
    let analysis = match get_policy_analysis(conn, app_id) {
        Ok(a) => a,
        Err(e) => return uncaught(e),
    };
    if analysis.is_null() {
        return json_ok(&json!({
            "runStatus": "idle",
            "runStartedAt": null,
            "lastRunLog": [],
            "status": null,
        }));
    }
    let or = |key: &str, default: Value| match analysis.get(key) {
        None | Some(Value::Null) => default,
        Some(v) => v.clone(),
    };
    json_ok(&json!({
        "runStatus": or("runStatus", json!("idle")),
        "runStartedAt": or("runStartedAt", Value::Null),
        "lastRunLog": or("lastRunLog", json!([])),
        "status": or("status", Value::Null),
    }))
}

/// `GET /api/policy/version/[id]`.
pub(super) fn version_with(
    conn: &Connection,
    limiter: &RateLimiter,
    headers: &HeaderMap,
    id: &str,
    now: i64,
) -> Response {
    if let Some(r) = rate_gate_with(limiter, headers, "policy.version.read", 120, 60_000, now) {
        return r;
    }
    if bad_id(id) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid id");
    }
    match policy_version(conn, id) {
        Ok(Some(row)) => json_ok(&row),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Version not found"),
        Err(e) => uncaught(e),
    }
}

/// `GET /api/policy/version/[id]/diff`.
pub(super) fn diff_with(
    conn: &Connection,
    limiter: &RateLimiter,
    headers: &HeaderMap,
    id: &str,
    now: i64,
) -> Response {
    if let Some(r) = rate_gate_with(limiter, headers, "policy.version.diff", 60, 60_000, now) {
        return r;
    }
    if bad_id(id) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let current = match policy_version(conn, id) {
        Ok(Some(row)) => row,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Version not found"),
        Err(e) => return uncaught(e),
    };
    let previous = match previous_policy_version(conn, &current) {
        Ok(Some(row)) => row,
        Ok(None) => {
            return json_error(StatusCode::NOT_FOUND, "No previous version to diff against")
        }
        Err(e) => return uncaught(e),
    };
    let diff = diff_policy_texts(
        previous["source_text"].as_str().unwrap_or(""),
        current["source_text"].as_str().unwrap_or(""),
    );
    let summary = |row: &Value| {
        json!({
            "id": row["id"],
            "first_fetched_at": row["first_fetched_at"],
            "last_fetched_at": row["last_fetched_at"],
            "source_word_count": row["source_word_count"],
        })
    };
    json_ok(&json!({
        "previous": summary(&previous),
        "current": summary(&current),
        "stats": diff["stats"],
        "lines": diff["lines"],
    }))
}

/// `getManualApp(id)?.privacyPolicyUrl`: `None` for an unknown app.
fn manual_app_policy_url(conn: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    conn.query_row(
        "SELECT privacy_policy_url FROM manual_apps WHERE id = ?",
        [id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|found| found.map(|url| url.map_or(Value::Null, Value::String)))
}

/// `GET /api/manual-apps/[id]/policy-version/[versionId]`.
pub(super) fn manual_version_with(
    conn: &Connection,
    limiter: &RateLimiter,
    headers: &HeaderMap,
    id: &str,
    version_id: &str,
    now: i64,
) -> Response {
    if let Some(r) = rate_gate_with(limiter, headers, "manual-apps.read", 120, 60_000, now) {
        return r;
    }
    if id.is_empty() || version_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Invalid id");
    }
    match manual_app_policy_url(conn, id) {
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Not found"),
        Ok(Some(_)) => {}
        Err(e) => return uncaught(e),
    }
    match one(
        conn,
        &format!("{MANUAL_VERSION_SELECT} WHERE id = ?"),
        version_id,
    ) {
        Ok(Some(version)) if version["manualAppId"] == id => {
            json_ok(&json!({ "version": version }))
        }
        Ok(_) => json_error(StatusCode::NOT_FOUND, "Not found"),
        Err(e) => uncaught(e),
    }
}

// ── The manual-app scrape ────────────────────────────────────────────

pub(super) fn handles(spec: &RouteSpec) -> bool {
    spec.path == "/api/manual-apps/[id]/scrape"
}

/// The write framework's entry: the runner clock, live on the server.
pub(super) async fn perform(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    fetcher: &dyn Fetcher,
    req: WriteRequest<'_>,
    actor: &Actor,
) -> Response {
    let clock = clock_for(now);
    scrape_manual_app(
        db,
        ids,
        fetcher,
        clock.as_ref(),
        req.param.unwrap_or(""),
        actor,
    )
    .await
}

/// `appendManualAppEvent`: the row, and the event as the route returns it.
fn append_manual_event(
    w: &mut Writer,
    ids: &mut dyn Ids,
    manual_app_id: &str,
    occurred_at: i64,
    detail: Value,
) -> Result<Value, String> {
    let id = ids.uuid(w.conn)?;
    w.run(
        INSERT_MANUAL_EVENT,
        vec![
            json!(id),
            json!(manual_app_id),
            json!("scrape"),
            json!(occurred_at),
            json!(detail.to_string()),
        ],
    )?;
    Ok(json!({
        "id": id,
        "manualAppId": manual_app_id,
        "type": "scrape",
        "occurredAt": occurred_at,
        "detail": detail,
    }))
}

fn sha256_hex(text: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `POST /api/manual-apps/[id]/scrape`, after its rate guard.
pub(super) async fn scrape_manual_app(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: &dyn Clock,
    id: &str,
    actor: &Actor,
) -> Response {
    if bad_id(id) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let policy_url = match db.with(|w| manual_app_policy_url(w.conn, id)) {
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Not found"),
        Ok(Some(Value::String(url))) if !url.is_empty() => url,
        Ok(Some(_)) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "No privacy policy URL set for this manual app",
            )
        }
        Err(e) => return uncaught(e),
    };
    let now = clock.now();
    let previous = match db.with(|w| {
        one(
            w.conn,
            &format!("{MANUAL_VERSION_SELECT} WHERE manual_app_id = ? ORDER BY last_fetched_at DESC LIMIT 1"),
            id,
        )
    }) {
        Ok(v) => v,
        Err(e) => return uncaught(e),
    };

    // The route passes no logger: the trace only reaches the console.
    let mut trace = Trace::default();
    let fetched = fetch_privacy_policy_source(fetcher, &policy_url, &mut trace).await;
    let attempt: Result<Response, String> = match fetched {
        Err(err) => Err(err.message),
        Ok(source) => db.with(|w| -> Result<Response, String> {
            if source.status != SourceStatus::Ready {
                let mut detail = Map::new();
                detail.insert("kind".into(), json!("scrape"));
                detail.insert("policy_event".into(), json!("error"));
                detail.insert("policyUrl".into(), json!(policy_url));
                detail.insert("finalUrl".into(), json!(source.final_url));
                detail.insert("title".into(), json!(source.title));
                if let Some(error) = &source.error {
                    detail.insert("error".into(), json!(error));
                }
                let event = append_manual_event(w, ids, id, now, Value::Object(detail))?;
                record_audit(
                    w,
                    ids,
                    clock.now(),
                    "manual-apps.scrape.rejected",
                    actor,
                    Some(&format!("id={id} reason={}", source.status.as_str())),
                    false,
                );
                return Ok(json_ok(&json!({ "event": event, "version": null })));
            }
            let content_hash = sha256_hex(&source.text);
            let existing: Option<String> = w
                .conn
                .query_row(
                    "SELECT id FROM manual_app_policy_versions WHERE manual_app_id = ? AND content_hash = ?",
                    [id, content_hash.as_str()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let (version_id, is_new) = match existing.filter(|v| !v.is_empty()) {
                Some(version_id) => {
                    w.run(TOUCH_MANUAL_VERSION, vec![json!(now), json!(version_id)])?;
                    (version_id, false)
                }
                None => {
                    let version_id = ids.uuid(w.conn)?;
                    w.run(
                        INSERT_MANUAL_VERSION,
                        vec![
                            json!(version_id),
                            json!(id),
                            json!(content_hash),
                            json!(now),
                            json!(now),
                            json!(policy_url),
                            json!(source.final_url),
                            json!(source.title),
                            json!(source.content_type),
                            json!(source.origin.as_str()),
                            json!(source.word_count),
                            json!(source.text),
                        ],
                    )?;
                    (version_id, true)
                }
            };
            let policy_event = match (&previous, is_new) {
                (None, _) => "first",
                (Some(_), true) => "changed",
                (Some(_), false) => "same",
            };
            let event = append_manual_event(
                w,
                ids,
                id,
                now,
                json!({
                    "kind": "scrape",
                    "policy_event": policy_event,
                    "versionId": version_id,
                    "wordCount": source.word_count,
                    "contentHash": content_hash,
                    "policyUrl": policy_url,
                    "finalUrl": source.final_url,
                    "title": source.title,
                }),
            )?;
            record_audit(
                w,
                ids,
                clock.now(),
                "manual-apps.scrape.success",
                actor,
                Some(&format!(
                    "id={id} event={policy_event} words={}",
                    source.word_count
                )),
                true,
            );
            Ok(json_ok(&json!({
                "event": event,
                "version": {
                    "id": version_id,
                    "contentHash": content_hash,
                    "wordCount": source.word_count,
                    "policyUrl": policy_url,
                    "sourceFinalUrl": source.final_url,
                    "sourceTitle": source.title,
                    "fetchedAt": now,
                    "isNew": is_new,
                },
            })))
        }),
    };
    match attempt {
        Ok(response) => response,
        Err(message) => db.with(|w| {
            let detail = json!({
                "kind": "scrape",
                "policy_event": "error",
                "policyUrl": policy_url,
                "error": message,
            });
            let event = match append_manual_event(w, ids, id, now, detail) {
                Ok(event) => event,
                Err(e) => return uncaught(e),
            };
            record_audit(
                w,
                ids,
                clock.now(),
                "manual-apps.scrape.failed",
                actor,
                Some(&format!("id={id} err={}", js_slice_prefix(&message, 120))),
                false,
            );
            json_ok(&json!({ "event": event, "version": null, "error": message }))
        }),
    }
}

// ── The axum handlers ────────────────────────────────────────────────

pub async fn status(State(state): State<AppState>, Path(app_id): Path<String>) -> Response {
    status_with(&state.db(), &app_id)
}

pub async fn version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    version_with(
        &state.db(),
        &state.rate_limiter,
        &headers,
        &id,
        super::now_ms(),
    )
}

pub async fn version_diff(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    diff_with(
        &state.db(),
        &state.rate_limiter,
        &headers,
        &id,
        super::now_ms(),
    )
}

pub async fn manual_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, version_id)): Path<(String, String)>,
) -> Response {
    manual_version_with(
        &state.db(),
        &state.rate_limiter,
        &headers,
        &id,
        &version_id,
        super::now_ms(),
    )
}

//! Phase 4, batch 4a: the routes around the sync runner — `POST
//! /api/sync/trigger` and `POST /api/dev/sync-stop` — and the two small
//! writes that were left with them: `DELETE /api/rate-limit/status` (the
//! Apple cooldowns cleared) and `DELETE /api/apps` (one app, with the
//! import rows that brought it in tombstoned first). Each is the Node
//! route in order, gated by `core/tests/fixtures/runners-cases.json`.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use super::{
    body::{body_error_response, BodyOutcome},
    guard::{record_audit, Actor},
    imports_writes::{recompute_counters, transaction},
    json::{json_error, json_ok},
    operations::cooldowns,
    sync_runner::{clock_for, run_scheduled_sync},
    writes::{internal_error, prop, Cx, RouteSpec, WriteRequest},
};
use crate::{
    outbound::Fetcher,
    scrape::persist::{DbAccess, Ids},
};
use axum::{
    http::{Method, StatusCode},
    response::Response,
};
use regex::Regex;
use rusqlite::types::Value as Sql;
use serde_json::{json, Value};
use std::sync::OnceLock;

const DELETE_APP: &str = "DELETE FROM apps WHERE id = ?";
const TOMBSTONE_ITEMS: &str = "UPDATE import_items\n       SET status = 'removed',\n           removed_app_id = COALESCE(removed_app_id, app_id)\n     WHERE app_id = ? AND status != 'removed'";
const CLEAR_SYNC_STATE: &str = "DELETE FROM app_settings WHERE key = ?";
const RATE_LIMIT_CATEGORIES: [&str; 3] = ["search", "scrape", "all"];

pub(super) fn handles(spec: &RouteSpec) -> bool {
    matches!(
        spec.path,
        "/api/sync/trigger" | "/api/dev/sync-stop" | "/api/rate-limit/status" | "/api/apps"
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

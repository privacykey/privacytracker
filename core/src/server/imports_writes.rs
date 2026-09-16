//! Phase 4, batch 3: the import pipeline — the `POST`/`DELETE` exports of
//! ten route files: the import session (`/api/imports`) and its items, the
//! item update, the queue drain, the completion, the per-item retry and
//! match change, the iTunes search, the App Store scrape and the per-app
//! Wayback import. Under the routes sits lib/imports.ts (the session and
//! item writers, counters, queue claims and the outcome recorders),
//! lib/import-queue.ts (the drain and its mutex), the two import
//! notifications and lib/app-import.ts's name sanitisers. The network
//! callers hand the Phase 3 entry points a `Fetcher`. Gated by
//! `core/tests/fixtures/imports-cases.json`, replayed by `imports_tests`.
//!
//! Three things the port keeps that a tidier one would lose:
//!
//!   * **The item upsert plans its writes before it runs any.** Every
//!     existence check happens first, so two rows with one query in one
//!     batch both INSERT — Node's worker-backed variant does the same.
//!   * **`total` is whatever number the creator sent**, stored as-is and
//!     read back as-is (`2.5` stays `2.5`), so counters are JS numbers,
//!     not integers, wherever Node arithmetic touches them.
//!   * **The deferred policy fetch is a no-op.** Node arms a two-second
//!     timer that starts a policy-source run when nothing else holds the
//!     mutex; that run is Phase 5, and the oracle holds the mutex so the
//!     timer never fires. The hook stays so the call sites match.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use super::{
    activity_log::{record_activity, record_activity_named},
    body::{body_error_response, BodyOutcome},
    guard::{record_audit, Actor},
    json::{json_error, json_ok, json_response},
    library_writes::body_strict,
    preview::string as js_string,
    routes_imports::{import_items, import_row, item_row, IMPORT_ITEM_STATUSES, IMPORT_SOURCES},
    routes_status::queue_status,
    stats::{self, truthy},
    writes::{internal_error, prop, Cx, RouteSpec, WriteRequest},
};
use crate::{
    jsnum::{js_number_spelling, js_parse_int, js_to_number},
    jsstr::{js_length, js_slice_prefix, js_trim},
    outbound::{self, Fetcher},
    scrape::{
        fetch_and_parse_app, import_app_history, lookup_apps_by_bundle_id, notify,
        persist::Outcome, region::normalize_country, scrape_initial_urls, search_apps_by_name,
        AppRow, HistoryOptions, ScrapeError,
    },
};
use axum::{
    http::{header, HeaderValue, Method, StatusCode},
    response::Response,
};
use regex::Regex;
use rusqlite::types::Value as Sql;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

// ── The SQL, verbatim from lib/imports.ts and lib/import-queue.ts ────
const INSERT_IMPORT: &str = "INSERT INTO imports (id, created_at, source, source_label, total, device_id)\n     VALUES (?, ?, ?, ?, ?, ?)";
const INSERT_ITEM: &str = "INSERT INTO import_items (\n    id, import_id, query, edited_query, status, app_id, app_name, developer, url,\n    icon_url, country, scrape_error, removed_app_id, next_attempt_at, attempt_count\n  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE_COUNTERS: &str =
    "UPDATE imports\n     SET total = ?, matched = ?, unmatched = ?, imported = ?\n     WHERE id = ?";
const CLAIM_BUMP: &str = "UPDATE import_items\n         SET attempt_count = attempt_count + 1,\n             next_attempt_at = ?\n       WHERE id = ? AND status = 'queued'";
const COMPLETE_IMPORT: &str = "UPDATE imports SET completed_at = ? WHERE id = ?";
const UPSERT_APP_DEVICE: &str = "\n        INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at)\n        VALUES (?, ?, ?, ?)\n        ON CONFLICT(app_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at\n      ";
const TOUCH_DEVICE: &str = "UPDATE devices SET last_synced_at = ? WHERE id = ?";
const REPLACE_MATCH: &str = "UPDATE import_items\n         SET status = 'imported',\n             app_id = ?,\n             app_name = ?,\n             developer = ?,\n             url = ?,\n             icon_url = ?,\n             scrape_error = NULL,\n             removed_app_id = NULL\n       WHERE id = ?";
const DELETE_APP: &str = "DELETE FROM apps WHERE id = ?";
const DELETE_IMPORT: &str = "DELETE FROM imports WHERE id = ?";
const STALE_NOTIFICATIONS: &str =
    "UPDATE notifications SET stale = 1 WHERE app_id = ? AND stale = 0";
const SET_EDITED_QUERY: &str = "UPDATE import_items SET edited_query = ? WHERE id = ?";
const RESET_QUEUE_BACKOFF: &str =
    "UPDATE import_items SET next_attempt_at = 0 WHERE status = 'queued'";
const INSERT_NOTIFICATION: &str = "\n    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)\n    VALUES (?, ?, ?, ?, ?, 0)\n  ";
const REMOVE_IMPORTED_HISTORY: &str = "DELETE FROM privacy_snapshots WHERE (source = 'wayback' OR (source = 'live' AND triggered_by = 'wayback')) AND app_id = ?";

const MAX_ITEMS_PER_REQUEST: usize = 5000;
const MAX_URLS_PER_BATCH: usize = 100;
const MAX_IMPORT_ROWS: usize = 500;
const MAX_NAME_LENGTH: usize = 120;
const BULK_CHUNK: usize = 200;
const QUEUE_BATCH_SIZE: i64 = 10;
const RUNNING_LOCK_STALE_MS: i64 = 90 * 1000;
const IN_FLIGHT_FENCE_MS: i64 = 10 * 60 * 1000;
const DEFAULT_QUEUE_BACKOFF_MS: f64 = 60_000.0;
const MAX_QUEUE_BACKOFF_MS: f64 = 30.0 * 60_000.0;
const MANUAL_APPS_NOTIFY_WINDOW_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const SCRAPE_TRIGGERS: [&str; 4] = ["scheduled", "manual", "import", "wayback"];
const HEADER_CELL_LABELS: [&str; 8] = [
    "name",
    "app",
    "app name",
    "application",
    "application name",
    "title",
    "app title",
    "display name",
];

pub(super) fn handles(spec: &RouteSpec) -> bool {
    matches!(
        spec.path,
        "/api/imports"
            | "/api/imports/items"
            | "/api/imports/items/update"
            | "/api/imports/queue"
            | "/api/imports/complete"
            | "/api/imports/items/retry"
            | "/api/imports/items/change-match"
            | "/api/search"
            | "/api/scrape"
            | "/api/apps/[id]/import-history"
    )
}

pub(super) async fn perform(
    cx: &mut Cx<'_, '_>,
    fetcher: &dyn Fetcher,
    req: WriteRequest<'_>,
    actor: &Actor,
) -> Response {
    let spec = req.spec;
    let param = req.param.unwrap_or("");
    match (spec.path, &spec.method) {
        ("/api/imports", &Method::POST) => create_import(cx, req.body),
        ("/api/imports", &Method::DELETE) => delete_import_route(cx, req.query),
        ("/api/imports/items", &Method::POST) => add_items(cx, req.body),
        ("/api/imports/items/update", &Method::POST) => update_item_route(cx, req.body),
        ("/api/imports/queue", &Method::POST) => queue_run(cx, fetcher).await,
        ("/api/imports/complete", &Method::POST) => complete_route(cx, req.body),
        ("/api/imports/items/retry", &Method::POST) => retry_item(cx, fetcher, req.body).await,
        ("/api/imports/items/change-match", &Method::POST) => {
            change_match(cx, fetcher, req.body).await
        }
        ("/api/search", &Method::POST) => search(cx, fetcher, req.body).await,
        ("/api/scrape", &Method::POST) => scrape(cx, fetcher, req.body).await,
        ("/api/apps/[id]/import-history", &Method::POST) => {
            import_history(cx, fetcher, param, req.body, actor).await
        }
        ("/api/apps/[id]/import-history", &Method::DELETE) => remove_history(cx, param, actor),
        _ => json_error(StatusCode::NOT_FOUND, "Not Found"),
    }
}

// ── Small helpers ────────────────────────────────────────────────────

fn db<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

fn text(s: &str) -> Sql {
    Sql::Text(s.to_string())
}

fn sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .map(Sql::Integer)
            .or_else(|| n.as_f64().map(Sql::Real))
            .unwrap_or(Sql::Null),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn read_rows(cx: &Cx, sql: &str, params: &[Sql]) -> Result<Vec<Value>, String> {
    stats::query(cx.w.conn, sql, params).map_err(|e| e.to_string())
}

fn read_one(cx: &Cx, sql: &str, params: &[Sql]) -> Result<Option<Value>, String> {
    Ok(read_rows(cx, sql, params)?.into_iter().next())
}

/// A JavaScript number as a JSON value: integral values bind as INTEGER,
/// exactly as better-sqlite3 binds them.
fn num(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

/// `${n}` for a JSON number.
fn spell(v: &Value) -> String {
    match v.as_i64() {
        Some(i) => i.to_string(),
        None => js_number_spelling(js_to_number(v)),
    }
}

/// `ToInt32`.
fn to_int32(v: f64) -> i64 {
    if !v.is_finite() {
        return 0;
    }
    let m = v.trunc() % 4_294_967_296.0;
    let m = if m < 0.0 { m + 4_294_967_296.0 } else { m };
    (if m >= 2_147_483_648.0 {
        m - 4_294_967_296.0
    } else {
        m
    }) as i64
}

/// `typeof body?.key === "string" ? body.key : undefined`.
fn str_prop<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    prop(v, key).and_then(Value::as_str)
}

/// `typeof body?.key === "string" ? body.key.trim() : ""`.
fn trimmed(v: &Value, key: &str) -> String {
    str_prop(v, key).map(js_trim).unwrap_or("").to_string()
}

/// `typeof v === "string" ? v : null`.
fn string_or_null(v: Option<&Value>) -> Value {
    v.and_then(Value::as_str).map_or(Value::Null, |s| json!(s))
}

fn i64_of(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}

fn transaction<'a, 'b, T>(
    cx: &mut Cx<'a, 'b>,
    body: impl FnOnce(&mut Cx<'a, 'b>) -> Result<T, String>,
) -> Result<T, String> {
    let tx =
        cx.w.conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
    cx.w.mark("BEGIN");
    match body(cx) {
        Ok(v) => {
            cx.w.mark("COMMIT");
            tx.commit().map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            cx.w.mark("ROLLBACK");
            drop(tx);
            Err(e)
        }
    }
}

/// `schedulePostAppUpdatePolicyFetch`: the deferred policy-source run is
/// Phase 5; nothing is armed here.
fn schedule_post_app_update_policy_fetch(_reason: &str) {}

// ── lib/imports.ts ───────────────────────────────────────────────────

/// `resolveSafeAppId`: an app id that is not in `apps` becomes NULL so the
/// foreign key holds; a later success re-sets it.
fn resolve_safe_app_id(cx: &Cx, v: &Value) -> Result<Value, String> {
    let Some(id) = v.as_str().filter(|s| !s.is_empty()) else {
        return Ok(Value::Null);
    };
    let exists = !read_rows(cx, "SELECT 1 FROM apps WHERE id = ?", &[text(id)])?.is_empty();
    Ok(if exists { json!(id) } else { Value::Null })
}

/// `recomputeImportCounters`.
fn recompute_counters(cx: &mut Cx, import_id: &str) -> Result<(), String> {
    let counts = read_one(
        cx,
        "SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('matched', 'imported', 'queued') THEN 1 ELSE 0 END) AS matched,
         SUM(CASE WHEN status IN ('unmatched', 'skipped', 'error', 'removed') THEN 1 ELSE 0 END) AS unmatched,
         SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END) AS imported
       FROM import_items WHERE import_id = ?",
        &[text(import_id)],
    )?
    .unwrap_or(Value::Null);
    let current = read_one(
        cx,
        "SELECT total FROM imports WHERE id = ?",
        &[text(import_id)],
    )?;
    // `current?.total ?? 0`, then `Math.max` over JS numbers.
    let existing_total = current
        .as_ref()
        .map(|r| r["total"].clone())
        .filter(|v| !v.is_null())
        .unwrap_or(json!(0));
    let total = js_to_number(&existing_total).max(i64_of(&counts["total"]) as f64);
    cx.w.run(
        UPDATE_COUNTERS,
        vec![
            num(total),
            json!(i64_of(&counts["matched"])),
            json!(i64_of(&counts["unmatched"])),
            json!(i64_of(&counts["imported"])),
            json!(import_id),
        ],
    )?;
    Ok(())
}

/// The fields `updateImportItem` accepts, in its column order. `None` is an
/// absent key; `Some(Null)` is an explicit null.
#[derive(Default, Clone)]
struct Patch {
    query: Option<Value>,
    edited_query: Option<Value>,
    status: Option<Value>,
    app_id: Option<Value>,
    app_name: Option<Value>,
    developer: Option<Value>,
    url: Option<Value>,
    icon_url: Option<Value>,
    country: Option<Value>,
    scrape_error: Option<Value>,
    removed_app_id: Option<Value>,
    next_attempt_at: Option<Value>,
    attempt_count: Option<Value>,
}

impl Patch {
    fn assignments(&self, cx: &Cx) -> Result<(Vec<String>, Vec<Value>), String> {
        let mut fields = vec![];
        let mut values = vec![];
        let mut push = |column: &str, value: Value| {
            fields.push(format!("{column} = ?"));
            values.push(value);
        };
        if let Some(v) = &self.query {
            push("query", v.clone());
        }
        if let Some(v) = &self.edited_query {
            push("edited_query", v.clone());
        }
        if let Some(v) = &self.status {
            push("status", v.clone());
        }
        if let Some(v) = &self.app_id {
            push("app_id", resolve_safe_app_id(cx, v)?);
        }
        if let Some(v) = &self.app_name {
            push("app_name", v.clone());
        }
        if let Some(v) = &self.developer {
            push("developer", v.clone());
        }
        if let Some(v) = &self.url {
            push("url", v.clone());
        }
        if let Some(v) = &self.icon_url {
            push("icon_url", v.clone());
        }
        if let Some(v) = &self.country {
            push("country", v.clone());
        }
        if let Some(v) = &self.scrape_error {
            push("scrape_error", v.clone());
        }
        if let Some(v) = &self.removed_app_id {
            push("removed_app_id", v.clone());
        }
        if let Some(v) = &self.next_attempt_at {
            push("next_attempt_at", v.clone());
        }
        if let Some(v) = &self.attempt_count {
            push("attempt_count", v.clone());
        }
        Ok((fields, values))
    }
}

/// `updateImportItem`: `None` when the row does not exist.
fn update_import_item(cx: &mut Cx, item_id: &str, patch: &Patch) -> Result<Option<Value>, String> {
    let Some(existing) = read_one(
        cx,
        "SELECT import_id FROM import_items WHERE id = ?",
        &[text(item_id)],
    )?
    else {
        return Ok(None);
    };
    let (fields, mut values) = patch.assignments(cx)?;
    if fields.is_empty() {
        return db(item_row(cx.w.conn, item_id));
    }
    values.push(json!(item_id));
    let import_id = existing["import_id"].as_str().unwrap_or("").to_string();
    transaction(cx, |cx| {
        cx.w.run(
            &format!("UPDATE import_items SET {} WHERE id = ?", fields.join(", ")),
            values,
        )?;
        recompute_counters(cx, &import_id)
    })?;
    db(item_row(cx.w.conn, item_id))
}

/// One cleaned row of `POST /api/imports/items`. Every key the route
/// builds is present (null is a value), which is what makes the upsert's
/// UPDATE a fixed shape; `removedAppId` and `attemptCount` never are.
struct CleanItem {
    query: String,
    edited_query: Value,
    status: String,
    app_id: Value,
    app_name: Value,
    developer: Value,
    url: Value,
    icon_url: Value,
    country: Value,
    scrape_error: Value,
    next_attempt_at: Value,
}

/// `addImportItemsAsync`: plan every write from the reads first, then run
/// the plan in chunked transactions, then recompute the counters.
fn add_import_items(
    cx: &mut Cx,
    import_id: &str,
    items: &[CleanItem],
) -> Result<Vec<Value>, String> {
    if db(import_row(cx.w.conn, import_id))?.is_none() {
        return Err(format!("Unknown import {import_id}"));
    }
    if items.is_empty() {
        return Ok(vec![]);
    }
    let mut statements: Vec<(String, Vec<Value>)> = vec![];
    let mut results = vec![];
    for item in items {
        let existing = read_one(
            cx,
            "SELECT * FROM import_items\n       WHERE import_id = ? AND query = ?\n       ORDER BY rowid LIMIT 1",
            &[text(import_id), text(&item.query)],
        )?;
        if let Some(existing) = existing {
            let existing_id = existing["id"].as_str().unwrap_or("").to_string();
            if existing["status"] == "removed" {
                // Tombstone — the row stays as it is, and is what the caller gets.
                if let Some(row) = db(item_row(cx.w.conn, &existing_id))? {
                    results.push(row);
                }
                continue;
            }
            let safe_app_id = resolve_safe_app_id(cx, &item.app_id)?;
            let sql = "UPDATE import_items SET status = ?, edited_query = ?, app_id = ?, app_name = ?, developer = ?, url = ?, icon_url = ?, country = ?, scrape_error = ?, next_attempt_at = ? WHERE id = ?";
            statements.push((
                sql.to_string(),
                vec![
                    json!(item.status),
                    item.edited_query.clone(),
                    safe_app_id.clone(),
                    item.app_name.clone(),
                    item.developer.clone(),
                    item.url.clone(),
                    item.icon_url.clone(),
                    item.country.clone(),
                    item.scrape_error.clone(),
                    item.next_attempt_at.clone(),
                    json!(existing_id),
                ],
            ));
            // Built optimistically from the patch, not re-read.
            results.push(json!({
                "id": existing_id,
                "importId": import_id,
                "query": existing["query"],
                "editedQuery": item.edited_query,
                "status": item.status,
                "appId": safe_app_id,
                "appName": item.app_name,
                "developer": item.developer,
                "url": item.url,
                "iconUrl": item.icon_url,
                "country": item.country,
                "scrapeError": item.scrape_error,
                "removedAppId": existing["removed_app_id"],
                "nextAttemptAt": item.next_attempt_at,
                "attemptCount": if existing["attempt_count"].is_null() { json!(0) } else { existing["attempt_count"].clone() },
            }));
            continue;
        }
        let id = cx.ids.short_id(cx.w.conn, "iti")?;
        let safe_app_id = resolve_safe_app_id(cx, &item.app_id)?;
        statements.push((
            INSERT_ITEM.to_string(),
            vec![
                json!(id),
                json!(import_id),
                json!(item.query),
                item.edited_query.clone(),
                json!(item.status),
                safe_app_id.clone(),
                item.app_name.clone(),
                item.developer.clone(),
                item.url.clone(),
                item.icon_url.clone(),
                item.country.clone(),
                item.scrape_error.clone(),
                Value::Null,
                item.next_attempt_at.clone(),
                json!(0),
            ],
        ));
        results.push(json!({
            "id": id,
            "importId": import_id,
            "query": item.query,
            "editedQuery": item.edited_query,
            "status": item.status,
            "appId": safe_app_id,
            "appName": item.app_name,
            "developer": item.developer,
            "url": item.url,
            "iconUrl": item.icon_url,
            "country": item.country,
            "scrapeError": item.scrape_error,
            "removedAppId": Value::Null,
            "nextAttemptAt": item.next_attempt_at,
            "attemptCount": 0,
        }));
    }
    // The inline executor: chunks of 200, each its own transaction.
    for chunk in statements.chunks(BULK_CHUNK) {
        transaction(cx, |cx| {
            for (sql, params) in chunk {
                cx.w.run(sql, params.clone())?;
            }
            Ok(())
        })?;
    }
    recompute_counters(cx, import_id)?;
    Ok(results)
}

/// `claimQueuedBatch`: untracked rows first, each bumped and fenced.
fn claim_queued_batch(cx: &mut Cx, limit: i64) -> Result<Vec<Value>, String> {
    let now = cx.now;
    let fence = now + IN_FLIGHT_FENCE_MS;
    let mut claimed = vec![];
    transaction(cx, |cx| {
        let rows = read_rows(
            cx,
            "SELECT * FROM import_items
         WHERE status = 'queued'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY
           CASE WHEN app_id IS NULL THEN 0 ELSE 1 END,
           next_attempt_at ASC,
           rowid ASC
         LIMIT ?",
            &[Sql::Integer(now), Sql::Integer(limit)],
        )?;
        for row in rows {
            let id = row["id"].as_str().unwrap_or("").to_string();
            let changes = cx.w.run(CLAIM_BUMP, vec![json!(fence), json!(id)])?;
            if changes == 1 {
                if let Some(refreshed) = db(item_row(cx.w.conn, &id))? {
                    claimed.push(refreshed);
                }
            }
        }
        Ok(())
    })?;
    Ok(claimed)
}

struct SuccessApp {
    id: String,
    name: String,
    developer: Value,
    url: Value,
    icon_url: Value,
}

/// `recordItemSuccess`.
fn record_item_success(
    cx: &mut Cx,
    item_id: &str,
    app: &SuccessApp,
) -> Result<Option<Value>, String> {
    update_import_item(
        cx,
        item_id,
        &Patch {
            status: Some(json!("imported")),
            app_id: Some(json!(app.id)),
            app_name: Some(json!(app.name)),
            developer: Some(app.developer.clone()),
            url: Some(app.url.clone()),
            icon_url: Some(app.icon_url.clone()),
            scrape_error: Some(Value::Null),
            next_attempt_at: Some(Value::Null),
            ..Default::default()
        },
    )
}

/// `recordItemError`.
fn record_item_error(cx: &mut Cx, item_id: &str, error: &str) -> Result<Option<Value>, String> {
    update_import_item(
        cx,
        item_id,
        &Patch {
            status: Some(json!("error")),
            scrape_error: Some(json!(error)),
            next_attempt_at: Some(Value::Null),
            ..Default::default()
        },
    )
}

/// `recordItemRetry`: the Retry-After wins, else doubling minutes capped
/// at thirty.
fn record_item_retry(
    cx: &mut Cx,
    item_id: &str,
    retry_after_ms: Option<i64>,
    scrape_error: Option<&str>,
) -> Result<Option<Value>, String> {
    let Some(existing) = db(item_row(cx.w.conn, item_id))? else {
        return Ok(None);
    };
    let attempts = i64_of(&existing["attemptCount"]);
    let fallback = (DEFAULT_QUEUE_BACKOFF_MS * 2f64.powi((attempts - 1).max(0) as i32))
        .min(MAX_QUEUE_BACKOFF_MS);
    let wait = match retry_after_ms {
        Some(ms) if ms > 0 => ms as f64,
        _ => fallback,
    };
    update_import_item(
        cx,
        item_id,
        &Patch {
            status: Some(json!("queued")),
            next_attempt_at: Some(num(cx.now as f64 + wait)),
            scrape_error: Some(
                scrape_error.map_or_else(|| existing["scrapeError"].clone(), |s| json!(s)),
            ),
            ..Default::default()
        },
    )
}

/// `completeImport`: counters, the completion stamp, the device links,
/// then the activity row and the bell notification.
fn complete_import(cx: &mut Cx, import_id: &str) -> Result<Option<Value>, String> {
    let Some(before) = db(import_row(cx.w.conn, import_id))? else {
        return Ok(None);
    };
    let device_id = before["deviceId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from);
    transaction(cx, |cx| {
        recompute_counters(cx, import_id)?;
        cx.w.run(COMPLETE_IMPORT, vec![json!(cx.now), json!(import_id)])?;
        if let Some(device) = &device_id {
            let rows = read_rows(
                cx,
                "SELECT DISTINCT app_id FROM import_items WHERE import_id = ? AND status = 'imported' AND app_id IS NOT NULL",
                &[text(import_id)],
            )?;
            for row in rows {
                cx.w.run(
                    UPSERT_APP_DEVICE,
                    vec![
                        row["app_id"].clone(),
                        json!(device),
                        json!(cx.now),
                        json!(cx.now),
                    ],
                )?;
            }
            cx.w.run(TOUCH_DEVICE, vec![json!(cx.now), json!(device)])?;
        }
        Ok(())
    })?;
    let after = db(import_row(cx.w.conn, import_id))?;
    if let Some(after) = &after {
        let imported = i64_of(&after["imported"]);
        let errored = i64_of(&after["errored"]);
        let queued = i64_of(&after["queued"]);
        let unmatched = i64_of(&after["unmatched"]);
        let item_count = i64_of(&after["itemCount"]);
        // `after.total ?? itemCount` — a JS number, kept as one.
        let total = if after["total"].is_null() {
            json!(item_count)
        } else {
            after["total"].clone()
        };
        let total_n = js_to_number(&total);
        // Node's derivation, worst to best: items never persisted, then
        // nothing imported (both "error"), then anything short of clean.
        let status = if total_n > 0.0 && (item_count == 0 || imported == 0) {
            "error"
        } else if errored > 0 || queued > 0 || unmatched > 0 || (imported as f64) < total_n {
            "partial"
        } else {
            "ok"
        };
        let source_hint = match after["sourceLabel"].as_str().filter(|s| !s.is_empty()) {
            Some(label) => format!(" ({label})"),
            None => match after["source"].as_str().filter(|s| !s.is_empty()) {
                Some(source) => format!(" ({source})"),
                None => String::new(),
            },
        };
        let mut parts = vec![format!(
            "Imported {imported}/{}{source_hint}",
            spell(&total)
        )];
        if errored > 0 {
            parts.push(format!("{errored} failed"));
        }
        if queued > 0 {
            parts.push(format!("{queued} queued"));
        }
        if unmatched > 0 {
            parts.push(format!("{unmatched} unmatched"));
        }
        if item_count == 0 && total_n > 0.0 {
            parts.push("no item rows persisted (search likely failed)".to_string());
        } else if item_count > 0 && (item_count as f64) < total_n {
            parts.push(format!(
                "{} rows missing from history",
                js_number_spelling(total_n - item_count as f64)
            ));
        }
        let detail = json!({
            "importId": after["id"],
            "source": after["source"],
            "sourceLabel": after["sourceLabel"],
            "total": total,
            "imported": imported,
            "matched": if after["matched"].is_null() { json!(0) } else { after["matched"].clone() },
            "unmatched": unmatched,
            "errored": errored,
            "queued": queued,
            "itemCount": item_count,
        });
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "import",
            status,
            None,
            Some(&js_slice_prefix(&parts.join(" · "), 200)),
            Some(&detail),
            i64_of(&after["createdAt"]),
        );
        if let Err(e) = completion_notification(
            cx,
            &Completion {
                import_id: after["id"].as_str().unwrap_or("").to_string(),
                source_label: after["sourceLabel"].as_str().map(String::from),
                total: total_n,
                imported,
                errored,
                queued,
                unmatched,
                item_count,
                status,
            },
        ) {
            super::diag::log_warn(format!("[imports] completion notification failed: {e}"));
        }
        if imported > 0 {
            schedule_post_app_update_policy_fetch("import");
        }
    }
    Ok(after)
}

/// `completeImportIfSettled`.
fn complete_import_if_settled(cx: &mut Cx, import_id: &str) -> Result<Option<Value>, String> {
    let Some(row) = db(import_row(cx.w.conn, import_id))? else {
        return Ok(None);
    };
    if truthy(&row["completedAt"]) {
        return Ok(Some(row));
    }
    let pending = read_one(
        cx,
        "SELECT COUNT(*) AS count\n         FROM import_items\n        WHERE import_id = ?\n          AND status IN ('matched', 'queued')",
        &[text(import_id)],
    )?;
    if pending.map_or(0, |p| i64_of(&p["count"])) > 0 {
        return Ok(Some(row));
    }
    complete_import(cx, import_id)
}

struct NewApp {
    id: String,
    name: String,
    developer: Value,
    url: String,
    icon_url: Value,
}

/// `replaceImportItemMatch`: the row is rewired, the previous app is
/// garbage-collected when nothing else references it, and its
/// notifications go stale. Returns the row and the removed app id.
fn replace_import_item_match(
    cx: &mut Cx,
    item_id: &str,
    new_app: &NewApp,
) -> Result<(Option<Value>, Value), String> {
    let Some(existing) = read_one(
        cx,
        "SELECT * FROM import_items WHERE id = ?",
        &[text(item_id)],
    )?
    else {
        return Ok((None, Value::Null));
    };
    let previous = if !existing["app_id"].is_null() {
        existing["app_id"].clone()
    } else if !existing["removed_app_id"].is_null() {
        existing["removed_app_id"].clone()
    } else {
        Value::Null
    };
    let import_id = existing["import_id"].as_str().unwrap_or("").to_string();
    let replaces = truthy(&previous) && previous != json!(new_app.id);
    let mut removed = Value::Null;
    transaction(cx, |cx| {
        cx.w.run(
            REPLACE_MATCH,
            vec![
                json!(new_app.id),
                json!(new_app.name),
                new_app.developer.clone(),
                json!(new_app.url),
                new_app.icon_url.clone(),
                json!(item_id),
            ],
        )?;
        if replaces {
            let still_referenced = read_one(
                cx,
                "SELECT 1 FROM import_items\n           WHERE id != ?\n             AND (app_id = ? OR removed_app_id = ?)\n           LIMIT 1",
                &[text(item_id), sql(&previous), sql(&previous)],
            )?;
            if still_referenced.is_none() {
                cx.w.run(DELETE_APP, vec![previous.clone()])?;
                removed = previous.clone();
            }
        }
        recompute_counters(cx, &import_id)
    })?;
    if replaces {
        if let Err(e) = mark_notifications_stale_for_app(cx, previous.as_str().unwrap_or("")) {
            super::diag::log_warn(format!(
                "[imports] markNotificationsStaleForApp failed: {e}"
            ));
        }
    }
    Ok((db(item_row(cx.w.conn, item_id))?, removed))
}

/// `deleteImport`: the referenced apps when asked, then the session (the
/// items cascade).
fn delete_import(cx: &mut Cx, import_id: &str, remove_apps: bool) -> Result<usize, String> {
    if db(import_row(cx.w.conn, import_id))?.is_none() {
        return Ok(0);
    }
    let items = db(import_items(cx.w.conn, import_id))?;
    let app_ids: Vec<String> = if remove_apps {
        items
            .iter()
            .filter_map(|item| item["appId"].as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect()
    } else {
        vec![]
    };
    transaction(cx, |cx| {
        for app_id in &app_ids {
            cx.w.run(DELETE_APP, vec![json!(app_id)])?;
        }
        cx.w.run(DELETE_IMPORT, vec![json!(import_id)])?;
        Ok(())
    })?;
    Ok(app_ids.len())
}

// ── lib/notifications.ts ─────────────────────────────────────────────

struct Completion {
    import_id: String,
    source_label: Option<String>,
    total: f64,
    imported: i64,
    errored: i64,
    queued: i64,
    unmatched: i64,
    item_count: i64,
    status: &'static str,
}

/// `createImportCompletionNotification`: every count is `| 0` clamped at
/// zero; the trimmed label is echoed even when blank.
fn completion_notification(cx: &mut Cx, input: &Completion) -> Result<(), String> {
    let imported = to_int32(input.imported as f64).max(0);
    let total = to_int32(input.total).max(0);
    let queued = to_int32(input.queued as f64).max(0);
    let errored = to_int32(input.errored as f64).max(0);
    let unmatched = to_int32(input.unmatched as f64).max(0);
    let item_count = to_int32(input.item_count as f64).max(0);
    let source = input
        .source_label
        .as_deref()
        .map(|s| js_trim(s).to_string());
    let suffix = match source.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => format!(" from {s}"),
        None => String::new(),
    };
    let mut headline = vec![];
    if input.status == "ok" {
        headline.push(format!("Imported {imported} of {total}{suffix}"));
    } else if input.status == "partial" {
        headline.push(format!("{imported} of {total} imported{suffix}"));
        let mut tail = vec![];
        if queued > 0 {
            tail.push(format!("{queued} queued"));
        }
        if errored > 0 {
            tail.push(format!("{errored} failed"));
        }
        if unmatched > 0 {
            tail.push(format!("{unmatched} unmatched"));
        }
        if !tail.is_empty() {
            headline.push(tail.join(", "));
        }
    } else if total > 0 && item_count == 0 {
        headline.push(format!(
            "Import failed before any apps were recorded{suffix} — Apple search likely rate-limited us. Use \"Resume matching\" in Import History."
        ));
    } else {
        headline.push(format!(
            "Import of {total} app{}{suffix} failed · {errored} error{}, {queued} still queued",
            if total == 1 { "" } else { "s" },
            if errored == 1 { "" } else { "s" }
        ));
    }
    let description = js_slice_prefix(&headline.join(" · "), 500);
    let id = cx.ids.uuid(cx.w.conn)?;
    let payload = json!([{
        "type": "import_completed",
        "description": description,
        "importId": input.import_id,
        "status": input.status,
        "total": total,
        "imported": imported,
        "errored": errored,
        "queued": queued,
        "unmatched": unmatched,
        "itemCount": item_count,
        "sourceLabel": source,
    }]);
    cx.w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!("__import__"),
            json!("Import finished"),
            json!(payload.to_string()),
            json!(cx.now),
        ],
    )?;
    notify::prune_notifications(cx.w);
    Ok(())
}

/// `createManualAppsPromptNotification`: once a day at most.
fn manual_apps_prompt_notification(
    cx: &mut Cx,
    unmatched_count: i64,
    source_label: Option<&str>,
) -> Result<bool, String> {
    if unmatched_count <= 0 {
        return Ok(false);
    }
    let key = "manual_apps_prompt_notified_at";
    // `Number(getSetting(key, "0")) || 0`.
    let last_fired = js_to_number(&json!(cx.get(key, "0")));
    let last_fired = if last_fired.is_nan() { 0.0 } else { last_fired };
    if (cx.now as f64) - last_fired < MANUAL_APPS_NOTIFY_WINDOW_MS {
        return Ok(false);
    }
    let source = source_label.map(|s| js_trim(s).to_string());
    let suffix = match source.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => format!(" from {s}"),
        None => String::new(),
    };
    let description = format!(
        "{unmatched_count} row{}{suffix} didn\u{2019}t match an App Store listing. If any are Safari web apps, TestFlight betas, or sideloaded apps, track them under Manual apps so you still have a privacy record.",
        if unmatched_count == 1 { "" } else { "s" }
    );
    let id = cx.ids.uuid(cx.w.conn)?;
    let payload = json!([{
        "type": "manual_apps_prompt",
        "description": description,
        "unmatchedCount": unmatched_count,
        "sourceLabel": source,
    }]);
    cx.w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!("__manual_apps__"),
            json!("Manual apps"),
            json!(payload.to_string()),
            json!(cx.now),
        ],
    )?;
    notify::prune_notifications(cx.w);
    cx.set(key, &cx.now.to_string())?;
    Ok(true)
}

/// `markNotificationsStaleForApp`.
fn mark_notifications_stale_for_app(cx: &mut Cx, app_id: &str) -> Result<usize, String> {
    if app_id.is_empty() || ["__ai_timeout__", "__manual_apps__", "__import__"].contains(&app_id) {
        return Ok(0);
    }
    cx.w.run(STALE_NOTIFICATIONS, vec![json!(app_id)])
}

// ── The scrape call every import path shares ─────────────────────────

async fn scrape_for_import(
    cx: &mut Cx<'_, '_>,
    fetcher: &dyn Fetcher,
    url: &str,
) -> Result<Outcome, ScrapeError> {
    let conn = cx.w.conn;
    let now = cx.now;
    fetch_and_parse_app(
        conn,
        fetcher,
        url,
        false,
        Some("import"),
        now,
        &mut *cx.ids,
        cx.w.log(),
    )
    .await
}

// ── POST / DELETE /api/imports ───────────────────────────────────────

fn create_import(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let source = str_prop(&body, "source").unwrap_or("");
    if !IMPORT_SOURCES.contains(&source) {
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!("source must be one of {}", IMPORT_SOURCES.join(", ")),
        );
    }
    let source_label = string_or_null(prop(&body, "sourceLabel"));
    let total = prop(&body, "total")
        .filter(|v| v.is_number())
        .cloned()
        .unwrap_or(json!(0));
    let device_id = str_prop(&body, "deviceId")
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, |s| json!(s));
    let created = (|| -> Result<Option<Value>, String> {
        let id = cx.ids.short_id(cx.w.conn, "imp")?;
        cx.w.run(
            INSERT_IMPORT,
            vec![
                json!(id),
                json!(cx.now),
                json!(source),
                source_label,
                total,
                device_id,
            ],
        )?;
        db(import_row(cx.w.conn, &id))
    })();
    match created {
        Ok(Some(row)) => json_ok(&row),
        _ => internal_error(),
    }
}

fn delete_import_route(cx: &mut Cx, query: &[(String, String)]) -> Response {
    let first = |name: &str| {
        query
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    let Some(id) = first("id").filter(|s| !s.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "id is required");
    };
    let remove_apps = first("removeApps") == Some("true");
    match delete_import(cx, id, remove_apps) {
        Ok(deleted) => json_ok(&json!({"success": true, "deletedApps": deleted})),
        Err(_) => internal_error(),
    }
}

// ── POST /api/imports/items ──────────────────────────────────────────

fn add_items(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let import_id = trimmed(&body, "importId");
    if import_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "importId is required");
    }
    let raw_items: &[Value] = prop(&body, "items")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    if raw_items.len() > MAX_ITEMS_PER_REQUEST {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!(
                "Too many items in one request ({} > {MAX_ITEMS_PER_REQUEST}). Split into multiple batches.",
                raw_items.len()
            ),
        );
    }
    let mut cleaned = vec![];
    for item in raw_items {
        let query = trimmed(item, "query");
        let status = str_prop(item, "status").unwrap_or("");
        if query.is_empty() || !IMPORT_ITEM_STATUSES.contains(&status) {
            continue;
        }
        // Only the two retry-bearing statuses carry a deadline.
        let mut next_attempt_at = Value::Null;
        if status == "queued" || status == "pending_search" {
            let positive = |key: &str| {
                prop(item, key)
                    .filter(|v| v.is_number())
                    .filter(|v| js_to_number(v) > 0.0)
                    .cloned()
            };
            if let Some(at) = positive("nextAttemptAt") {
                next_attempt_at = at;
            } else if let Some(ms) = positive("retryAfterMs") {
                next_attempt_at = num(cx.now as f64 + js_to_number(&ms));
            }
        }
        cleaned.push(CleanItem {
            query,
            edited_query: str_prop(item, "editedQuery")
                .map(js_trim)
                .filter(|s| !s.is_empty())
                .map_or(Value::Null, |s| json!(s)),
            status: status.to_string(),
            app_id: string_or_null(prop(item, "appId")),
            app_name: string_or_null(prop(item, "appName")),
            developer: string_or_null(prop(item, "developer")),
            url: string_or_null(prop(item, "url")),
            icon_url: string_or_null(prop(item, "iconUrl")),
            country: string_or_null(prop(item, "country")),
            scrape_error: string_or_null(prop(item, "scrapeError")),
            next_attempt_at,
        });
    }
    if cleaned.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "items must be a non-empty array");
    }
    match add_import_items(cx, &import_id, &cleaned) {
        Ok(items) => json_ok(&json!({"items": items})),
        Err(_) => internal_error(),
    }
}

// ── POST /api/imports/items/update ───────────────────────────────────

fn update_item_route(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let item_id = trimmed(&body, "itemId");
    if item_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "itemId is required");
    }
    let mut patch = Patch::default();
    if let Some(query) = str_prop(&body, "query")
        .map(js_trim)
        .filter(|s| !s.is_empty())
    {
        patch.query = Some(json!(query));
    }
    if let Some(edited) = str_prop(&body, "editedQuery") {
        // `trim() || null`.
        let edited = js_trim(edited);
        patch.edited_query = Some(if edited.is_empty() {
            Value::Null
        } else {
            json!(edited)
        });
    }
    if let Some(status) = str_prop(&body, "status") {
        if !IMPORT_ITEM_STATUSES.contains(&status) {
            return json_error(
                StatusCode::BAD_REQUEST,
                &format!("invalid status: {status}"),
            );
        }
        patch.status = Some(json!(status));
    }
    // `"key" in body`: present, whatever its value.
    let present = |key: &str| prop(&body, key).map(|v| string_or_null(Some(v)));
    patch.app_id = present("appId");
    patch.app_name = present("appName");
    patch.developer = present("developer");
    patch.url = present("url");
    patch.icon_url = present("iconUrl");
    patch.country = present("country");
    patch.scrape_error = present("scrapeError");
    if let Some(ms) = prop(&body, "retryAfterMs")
        .filter(|v| v.is_number())
        .filter(|v| js_to_number(v) > 0.0)
    {
        if patch.status == Some(json!("queued")) {
            patch.next_attempt_at = Some(num(cx.now as f64 + js_to_number(ms)));
        }
    }
    match update_import_item(cx, &item_id, &patch) {
        Ok(Some(item)) => json_ok(&json!({"item": item})),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Item not found"),
        Err(_) => internal_error(),
    }
}

// ── POST /api/imports/queue ──────────────────────────────────────────

struct TickResult {
    skipped: Option<&'static str>,
    processed: i64,
    succeeded: i64,
    failed: i64,
    rate_limited: i64,
    paused_until: Option<i64>,
}

impl TickResult {
    fn skipped(reason: &'static str, paused_until: Option<i64>) -> Self {
        Self {
            skipped: Some(reason),
            processed: 0,
            succeeded: 0,
            failed: 0,
            rate_limited: 0,
            paused_until,
        }
    }
}

/// `runImportQueueTick`: the pause fence, the running mutex with its stale
/// override, then up to ten claimed rows until Apple says stop.
async fn run_import_queue_tick(
    cx: &mut Cx<'_, '_>,
    fetcher: &dyn Fetcher,
) -> Result<TickResult, String> {
    let paused_until = js_parse_int(&cx.get("import_queue_paused_until", "0")).unwrap_or(0);
    if paused_until > cx.now {
        return Ok(TickResult::skipped("paused", Some(paused_until)));
    }
    if cx.get("import_queue_running", "") == "true" {
        let running_since = js_parse_int(&cx.get("import_queue_running_since", "0")).unwrap_or(0);
        if running_since > 0 && cx.now - running_since > RUNNING_LOCK_STALE_MS {
            cx.set("import_queue_running", "false")?;
        } else {
            return Ok(TickResult::skipped("busy", None));
        }
    }
    cx.set("import_queue_running", "true")?;
    cx.set("import_queue_running_since", &cx.now.to_string())?;

    let outcome = drain(cx, fetcher).await;

    // `finally`.
    cx.set("import_queue_running", "false")?;
    cx.set("import_queue_last_run", &cx.now.to_string())?;
    outcome
}

async fn drain(cx: &mut Cx<'_, '_>, fetcher: &dyn Fetcher) -> Result<TickResult, String> {
    let claimed = claim_queued_batch(cx, QUEUE_BATCH_SIZE)?;
    if claimed.is_empty() {
        return Ok(TickResult::skipped("empty", None));
    }
    let mut result = TickResult {
        skipped: None,
        processed: 0,
        succeeded: 0,
        failed: 0,
        rate_limited: 0,
        paused_until: None,
    };
    for item in claimed {
        result.processed += 1;
        let item_id = item["id"].as_str().unwrap_or("").to_string();
        let import_id = item["importId"].as_str().unwrap_or("").to_string();
        let Some(url) = item["url"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from)
        else {
            record_item_error(cx, &item_id, "Queued item has no URL to scrape")?;
            complete_import_if_settled(cx, &import_id)?;
            result.failed += 1;
            continue;
        };
        match scrape_for_import(cx, fetcher, &url).await {
            Ok(scraped) => {
                record_item_success(
                    cx,
                    &item_id,
                    &SuccessApp {
                        id: scraped.id,
                        name: scraped.name,
                        developer: item["developer"].clone(),
                        url: json!(url),
                        icon_url: item["iconUrl"].clone(),
                    },
                )?;
                complete_import_if_settled(cx, &import_id)?;
                result.succeeded += 1;
            }
            Err(error) if error.is_rate_limited() => {
                let retry_after_ms = error.retry_after_ms.unwrap_or(0);
                result.rate_limited += 1;
                record_item_retry(
                    cx,
                    &item_id,
                    Some(retry_after_ms),
                    Some("Apple rate-limited the queue; will retry later"),
                )?;
                let paused = cx.now + retry_after_ms;
                cx.set("import_queue_paused_until", &paused.to_string())?;
                result.paused_until = Some(paused);
                break;
            }
            Err(error) => {
                record_item_error(cx, &item_id, &error.message)?;
                complete_import_if_settled(cx, &import_id)?;
                result.failed += 1;
            }
        }
    }
    Ok(result)
}

/// `forceImportQueueRun`, then the status the GET reports.
async fn queue_run(cx: &mut Cx<'_, '_>, fetcher: &dyn Fetcher) -> Response {
    let ran = async {
        cx.set("import_queue_paused_until", "0")?;
        cx.w.run(RESET_QUEUE_BACKOFF, vec![])?;
        let tick = run_import_queue_tick(cx, fetcher).await?;
        let status = db(queue_status(cx.w.conn, cx.now))?;
        let mut out = Map::new();
        if let Some(skipped) = tick.skipped {
            out.insert("skipped".into(), json!(skipped));
        }
        out.insert("processed".into(), json!(tick.processed));
        out.insert("succeeded".into(), json!(tick.succeeded));
        out.insert("failed".into(), json!(tick.failed));
        out.insert("rateLimited".into(), json!(tick.rate_limited));
        if let Some(paused) = tick.paused_until {
            out.insert("pausedUntil".into(), json!(paused));
        }
        out.insert(
            "status".into(),
            serde_json::to_value(status).map_err(|e| e.to_string())?,
        );
        Ok::<Value, String>(Value::Object(out))
    }
    .await;
    match ran {
        Ok(body) => json_ok(&body),
        Err(_) => internal_error(),
    }
}

// ── POST /api/imports/complete ───────────────────────────────────────

fn complete_route(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let import_id = trimmed(&body, "importId");
    if import_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "importId is required");
    }
    let row = match complete_import(cx, &import_id) {
        Ok(Some(row)) => row,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Import not found"),
        Err(_) => return internal_error(),
    };
    // The nudge never fails the completion.
    if let Err(e) =
        manual_apps_prompt_notification(cx, i64_of(&row["unmatched"]), row["sourceLabel"].as_str())
    {
        super::diag::log_warn(format!(
            "[complete-import] manual-apps notification failed: {e}"
        ));
    }
    json_ok(&row)
}

// ── POST /api/imports/items/retry ────────────────────────────────────

async fn retry_item(cx: &mut Cx<'_, '_>, fetcher: &dyn Fetcher, body: BodyOutcome) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let item_id = trimmed(&body, "itemId");
    if item_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "itemId is required");
    }
    let item = match item_row(cx.w.conn, &item_id) {
        Ok(Some(item)) => item,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                &format!("Unknown import item {item_id}"),
            )
        }
        Err(_) => return internal_error(),
    };
    let import_id = item["importId"].as_str().unwrap_or("").to_string();
    match retry_outcome(cx, fetcher, &item, &item_id, &import_id).await {
        Ok(body) => json_ok(&body),
        Err(_) => internal_error(),
    }
}

async fn retry_outcome(
    cx: &mut Cx<'_, '_>,
    fetcher: &dyn Fetcher,
    item: &Value,
    item_id: &str,
    import_id: &str,
) -> Result<Value, String> {
    if item["status"] == "pending_search" {
        let edited = item["editedQuery"]
            .as_str()
            .filter(|s| !js_trim(s).is_empty());
        let query_name =
            js_trim(edited.unwrap_or(item["query"].as_str().unwrap_or(""))).to_string();
        let mut query = Map::new();
        query.insert("name".into(), json!(query_name));
        if !item["developer"].is_null() {
            query.insert("developer".into(), item["developer"].clone());
        }
        let country = item["country"].as_str().map(String::from);
        let batch = {
            let conn = cx.w.conn;
            let now = cx.now;
            search_apps_by_name(
                conn,
                fetcher,
                std::slice::from_ref(&Value::Object(query)),
                country.as_deref(),
                now,
                cx.w.log(),
            )
            .await?
        };
        let queued = batch["rateLimited"]["queued"]
            .as_array()
            .map_or(0, Vec::len);
        if truthy(&batch["rateLimited"]) && queued > 0 {
            let retry_after_ms = batch["rateLimited"]["retryAfterMs"].clone();
            let updated = update_import_item(
                cx,
                item_id,
                &Patch {
                    status: Some(json!("pending_search")),
                    next_attempt_at: Some(num(cx.now as f64 + js_to_number(&retry_after_ms))),
                    scrape_error: Some(json!("iTunes Search rate-limited; will retry later")),
                    ..Default::default()
                },
            )?;
            return Ok(json!({
                "item": updated,
                "status": "pending_search",
                "rateLimited": { "retryAfterMs": retry_after_ms },
            }));
        }
        let top = batch["results"][0]["candidates"][0].clone();
        if top.is_null() {
            let updated = update_import_item(
                cx,
                item_id,
                &Patch {
                    status: Some(json!("unmatched")),
                    scrape_error: Some(json!("No match found in iTunes Search")),
                    next_attempt_at: Some(Value::Null),
                    ..Default::default()
                },
            )?;
            complete_import_if_settled(cx, import_id)?;
            return Ok(json!({ "item": updated, "status": "unmatched" }));
        }
        let updated = update_import_item(
            cx,
            item_id,
            &Patch {
                status: Some(json!("matched")),
                app_id: Some(top["appleId"].clone()),
                app_name: Some(top["name"].clone()),
                developer: Some(top["developer"].clone()),
                url: Some(top["url"].clone()),
                icon_url: Some(top["iconUrl"].clone()),
                scrape_error: Some(Value::Null),
                next_attempt_at: Some(Value::Null),
                ..Default::default()
            },
        )?;
        return Ok(json!({ "item": updated, "status": "matched" }));
    }

    let Some(url) = item["url"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
    else {
        let errored = record_item_error(cx, item_id, "Queued item has no URL to scrape")?;
        complete_import_if_settled(cx, import_id)?;
        return Ok(json!({ "item": errored, "status": "error" }));
    };
    match scrape_for_import(cx, fetcher, &url).await {
        Ok(scraped) => {
            let updated = record_item_success(
                cx,
                item_id,
                &SuccessApp {
                    id: scraped.id,
                    name: scraped.name,
                    developer: item["developer"].clone(),
                    url: json!(url),
                    icon_url: item["iconUrl"].clone(),
                },
            )?;
            complete_import_if_settled(cx, import_id)?;
            Ok(json!({ "item": updated, "status": "imported" }))
        }
        Err(error) if error.is_rate_limited() => {
            let retry_after_ms = error.retry_after_ms.unwrap_or(0);
            let updated = record_item_retry(
                cx,
                item_id,
                Some(retry_after_ms),
                Some("Apple rate-limited the queue; will retry later"),
            )?;
            Ok(json!({
                "item": updated,
                "status": "queued",
                "rateLimited": { "retryAfterMs": retry_after_ms },
            }))
        }
        Err(error) => {
            let errored = record_item_error(cx, item_id, &error.message)?;
            complete_import_if_settled(cx, import_id)?;
            Ok(json!({ "item": errored, "status": "error" }))
        }
    }
}

// ── POST /api/imports/items/change-match ─────────────────────────────

async fn change_match(cx: &mut Cx<'_, '_>, fetcher: &dyn Fetcher, body: BodyOutcome) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let item_id = trimmed(&body, "itemId");
    let url = trimmed(&body, "url");
    let edited_query = str_prop(&body, "editedQuery")
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if item_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "itemId is required");
    }
    if outbound::app_store_url(&url).is_err() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "url must be a canonical apps.apple.com URL with an /id<digits> segment",
        );
    }
    match item_row(cx.w.conn, &item_id) {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Item not found"),
        Err(_) => return internal_error(),
    }
    let scraped = match scrape_for_import(cx, fetcher, &url).await {
        Ok(scraped) => scraped,
        Err(error) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to scrape replacement app: {}", error.message),
            )
        }
    };
    let replaced = (|| -> Result<Value, String> {
        let app_row = read_one(
            cx,
            "SELECT developer, url, iconUrl FROM apps WHERE id = ?",
            &[text(&scraped.id)],
        )?;
        let column = |name: &str| app_row.as_ref().map_or(Value::Null, |r| r[name].clone());
        let new_app = NewApp {
            id: scraped.id.clone(),
            name: scraped.name.clone(),
            developer: column("developer"),
            url: column("url")
                .as_str()
                .map_or_else(|| url.clone(), String::from),
            icon_url: column("iconUrl"),
        };
        let (item, previous_app_removed) = replace_import_item_match(cx, &item_id, &new_app)?;
        // The row label follows the new match unless the caller named it.
        let next_edited_query = edited_query.clone().unwrap_or_else(|| scraped.name.clone());
        if item.is_some() && !next_edited_query.is_empty() {
            cx.w.run(
                SET_EDITED_QUERY,
                vec![json!(next_edited_query), json!(item_id)],
            )?;
        }
        let refreshed = db(item_row(cx.w.conn, &item_id))?;
        Ok(json!({
            "item": refreshed.or(item),
            "previousAppRemoved": previous_app_removed,
        }))
    })();
    match replaced {
        Ok(body) => json_ok(&body),
        Err(_) => internal_error(),
    }
}

// ── POST /api/search ─────────────────────────────────────────────────

async fn search(cx: &mut Cx<'_, '_>, fetcher: &dyn Fetcher, body: BodyOutcome) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    // `body ?? {}`; a non-object body has none of the four keys.
    let country: Option<String> = prop(&body, "country").map(|c| normalize_country(c.as_str()));
    if let Some(raw_ids) = prop(&body, "bundleIds")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
    {
        let ids: Vec<Value> = raw_ids
            .iter()
            .filter_map(Value::as_str)
            .map(js_trim)
            .filter(|s| !s.is_empty())
            .map(|s| json!(s))
            .take(1000)
            .collect();
        if ids.is_empty() {
            return json_ok(&json!({ "results": [] }));
        }
        let batch = {
            let conn = cx.w.conn;
            let now = cx.now;
            lookup_apps_by_bundle_id(conn, fetcher, &ids, country.as_deref(), now, cx.w.log()).await
        };
        if truthy(&batch["rateLimited"]) {
            return json_ok(&json!({
                "results": batch["results"],
                "rateLimited": {
                    "retryAfterMs": batch["rateLimited"]["retryAfterMs"],
                    "queuedBundleIds": batch["rateLimited"]["queued"],
                },
            }));
        }
        return json_ok(&json!({ "results": batch["results"] }));
    }
    let rows = prop(&body, "rows")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty());
    let names = prop(&body, "names")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty());
    let queries: Vec<Value> = if rows.is_some() {
        sanitize_rows_list(prop(&body, "rows").unwrap_or(&Value::Null))
    } else if names.is_some() {
        sanitize_names_list(prop(&body, "names").unwrap_or(&Value::Null))
            .into_iter()
            .map(|name| json!({ "name": name }))
            .collect()
    } else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Invalid payload: expected `names`, `rows`, or `bundleIds` array",
        );
    };
    if queries.is_empty() {
        return json_ok(&json!({ "results": [] }));
    }
    let batch = {
        let conn = cx.w.conn;
        let now = cx.now;
        search_apps_by_name(conn, fetcher, &queries, country.as_deref(), now, cx.w.log()).await
    };
    let batch = match batch {
        Ok(batch) => batch,
        Err(_) => return internal_error(),
    };
    if truthy(&batch["rateLimited"]) {
        return json_ok(&json!({
            "results": batch["results"],
            "rateLimited": {
                "retryAfterMs": batch["rateLimited"]["retryAfterMs"],
                "queued": batch["rateLimited"]["queued"],
            },
        }));
    }
    json_ok(&json!({ "results": batch["results"] }))
}

// ── POST /api/scrape ─────────────────────────────────────────────────

async fn scrape(cx: &mut Cx<'_, '_>, fetcher: &dyn Fetcher, body: BodyOutcome) -> Response {
    let body = match body_strict(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    // `const { urls, … } = body` throws on null.
    if body.is_null() {
        return internal_error();
    }
    let Some(urls) = prop(&body, "urls")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
    else {
        return json_error(StatusCode::BAD_REQUEST, "urls must be a non-empty array");
    };
    if urls.len() > MAX_URLS_PER_BATCH {
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!("urls exceeds cap of {MAX_URLS_PER_BATCH}"),
        );
    }
    let mut cleaned = vec![];
    for candidate in urls {
        let verdict = match candidate.as_str() {
            Some(raw) => outbound::app_store_url(raw).map_err(|e| e.error),
            None => Err("invalid_url"),
        };
        match verdict {
            Ok(url) => cleaned.push(url.to_string()),
            Err(error) => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    &format!(
                        "Rejected URL ({error}): {}",
                        js_slice_prefix(&js_string(candidate), 200)
                    ),
                )
            }
        }
    }
    let resync = prop(&body, "resync") == Some(&json!(true));
    let summarize_policies = prop(&body, "summarizePolicies") == Some(&json!(true));
    let trigger = str_prop(&body, "trigger").filter(|t| SCRAPE_TRIGGERS.contains(t));
    let results = {
        let conn = cx.w.conn;
        let now = cx.now;
        scrape_initial_urls(
            conn,
            fetcher,
            &cleaned,
            resync,
            trigger,
            true,
            now,
            &mut *cx.ids,
            cx.w.log(),
        )
        .await
    };
    // `summarizePolicies` is the Phase 5 policy fetch; ignored here.
    if !summarize_policies && results.iter().any(|r| r["status"] == "success") {
        schedule_post_app_update_policy_fetch(if resync { "sync" } else { "import" });
    }
    json_ok(&json!({ "results": results }))
}

// ── POST / DELETE /api/apps/[id]/import-history ──────────────────────

async fn import_history(
    cx: &mut Cx<'_, '_>,
    fetcher: &dyn Fetcher,
    id: &str,
    body: BodyOutcome,
    actor: &Actor,
) -> Response {
    // The throttle and the app checks ran in `precheck`; the row is re-read.
    let app = match read_one(
        cx,
        "SELECT id, url, name FROM apps WHERE id = ?",
        &[text(id)],
    ) {
        Ok(Some(app)) => app,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "App not found"),
        Err(_) => return internal_error(),
    };
    let name = app["name"].as_str().unwrap_or("").to_string();
    let url = app["url"].as_str().unwrap_or("").to_string();
    // `readOptionalBoundedJson(request, 4096, null)`: only a too-large
    // body refuses; unparseable is null.
    let body = match body {
        BodyOutcome::Json(v) => v,
        BodyOutcome::Empty | BodyOutcome::Whitespace | BodyOutcome::Invalid => Value::Null,
        other => return body_error_response(&other).unwrap_or_else(internal_error),
    };
    let interval_months = prop(&body, "intervalMonths")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 1.0 && *n <= 6.0)
        .map(f64::floor);
    let force = prop(&body, "force") == Some(&json!(true));
    let force_flag = u8::from(force);
    let started_at = cx.now;

    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "wayback.import.app.start",
        actor,
        Some(&format!("app={id} force={force_flag}")),
        true,
    );

    let run = {
        let conn = cx.w.conn;
        let now = cx.now;
        let app_row = AppRow {
            id: id.to_string(),
            name: name.clone(),
            url,
        };
        let options = HistoryOptions {
            force,
            interval_months,
            ..Default::default()
        };
        import_app_history(
            conn,
            fetcher,
            &app_row,
            &options,
            now,
            &mut *cx.ids,
            cx.w.log(),
        )
        .await
    };
    let result = match run {
        Ok(result) => result,
        Err(error) => {
            let message = error.message;
            if let Some(unavailable) = error.unavailable {
                record_audit(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback.import.app.rate_limited",
                    actor,
                    Some(&format!("app={id} {}", js_slice_prefix(&message, 200))),
                    false,
                );
                record_activity_named(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback_import",
                    "partial",
                    Some(id),
                    Some(&name),
                    Some(&js_slice_prefix(
                        &format!("Wayback import for {name} stopped — archive.org is rate-limiting requests"),
                        200,
                    )),
                    Some(&json!({
                        "mode": "app",
                        "force": force,
                        "archiveUnavailable": true,
                        "errorMessage": message,
                    })),
                    started_at,
                );
                let retry_after_ms = unavailable.retry_after_ms;
                let mut response = json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &json!({
                        "error": message,
                        "code": "archive_unavailable",
                        "retryAfterMs": retry_after_ms,
                    }),
                );
                if let Some(ms) = retry_after_ms.filter(|ms| *ms != 0) {
                    let seconds = (ms.max(0) + 999) / 1000;
                    if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                        response.headers_mut().insert(header::RETRY_AFTER, value);
                    }
                }
                return response;
            }
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "wayback.import.app.failed",
                actor,
                Some(&format!("app={id} {}", js_slice_prefix(&message, 200))),
                false,
            );
            record_activity_named(
                cx.w,
                cx.ids,
                cx.now,
                "wayback_import",
                "error",
                Some(id),
                Some(&name),
                Some(&js_slice_prefix(
                    &format!("Wayback import failed: {message}"),
                    200,
                )),
                Some(&json!({ "mode": "app", "errorMessage": message })),
                started_at,
            );
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &message);
        }
    };

    let count = |key: &str| i64_of(&result[key]);
    let status = if count("failed") == 0 {
        "ok"
    } else if count("imported") > 0 || count("unchanged") > 0 {
        "partial"
    } else {
        "error"
    };
    record_activity_named(
        cx.w,
        cx.ids,
        cx.now,
        "wayback_import",
        status,
        Some(id),
        Some(&name),
        Some(&summary_line(&name, &result, force)),
        Some(&json!({ "mode": "app", "result": result, "force": force })),
        started_at,
    );
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "wayback.import.app.success",
        actor,
        Some(&format!(
            "app={id} force={force_flag} imported={} unchanged={} skipped={} failed={}",
            count("imported"),
            count("unchanged"),
            count("skipped"),
            count("failed")
        )),
        true,
    );
    json_ok(&json!({ "result": result }))
}

/// `buildSummaryLine`.
fn summary_line(app_name: &str, result: &Value, force: bool) -> String {
    let count = |key: &str| i64_of(&result[key]);
    let mut parts = vec![];
    if count("imported") != 0 {
        parts.push(format!("{} imported", count("imported")));
    }
    if count("unchanged") != 0 {
        parts.push(format!("{} no-op", count("unchanged")));
    }
    if count("skipped") != 0 {
        parts.push(format!("{} skipped", count("skipped")));
    }
    if count("failed") != 0 {
        parts.push(format!("{} failed", count("failed")));
    }
    let requested = count("snapshotsRequested");
    if requested != 0 {
        parts.push(format!(
            "{requested} snapshot{} requested",
            if requested == 1 { "" } else { "s" }
        ));
    }
    let tail = if parts.is_empty() {
        "nothing to do".to_string()
    } else {
        parts.join(", ")
    };
    let label = if force {
        "Forced Wayback import"
    } else {
        "Wayback import"
    };
    js_slice_prefix(&format!("{label} for {app_name}: {tail}"), 200)
}

fn remove_history(cx: &mut Cx, id: &str, actor: &Actor) -> Response {
    let app = match read_one(cx, "SELECT id, name FROM apps WHERE id = ?", &[text(id)]) {
        Ok(Some(app)) => app,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "App not found"),
        Err(_) => return internal_error(),
    };
    let name = app["name"].as_str().unwrap_or("").to_string();
    let started_at = cx.now;
    let deleted = match cx.w.run(REMOVE_IMPORTED_HISTORY, vec![json!(id)]) {
        Ok(deleted) => deleted,
        Err(_) => return internal_error(),
    };
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "wayback.import.app.remove",
        actor,
        Some(&format!("app={id} deleted={deleted}")),
        true,
    );
    record_activity_named(
        cx.w,
        cx.ids,
        cx.now,
        "wayback_import",
        "ok",
        Some(id),
        Some(&name),
        Some(&format!(
            "Removed {deleted} imported history row{}",
            if deleted == 1 { "" } else { "s" }
        )),
        Some(&json!({ "mode": "app", "removed": true, "deleted": deleted })),
        started_at,
    );
    json_ok(&json!({ "deleted": deleted }))
}

// ── lib/app-import.ts: the name sanitisers ───────────────────────────

/// JavaScript's `\s`, which is not the regex crate's `\s`.
const WS: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

struct NameRegexes {
    control: Regex,
    zero_width: Regex,
    whitespace: Regex,
    bars: Regex,
    trailing_punctuation: Regex,
    version_suffixes: Vec<Regex>,
    letter_or_number: Regex,
    hex_or_dash: Regex,
    bundle_id: Regex,
    version_token: Regex,
    size: Regex,
    price: Regex,
    boolish: Regex,
    ascii_letter: Regex,
}

fn regexes() -> &'static NameRegexes {
    static RE: OnceLock<NameRegexes> = OnceLock::new();
    RE.get_or_init(|| {
        let re = |pattern: String| Regex::new(&pattern).unwrap();
        NameRegexes {
            control: re(r"[\x00-\x1F\x7F-\x9F]".into()),
            zero_width: re(r"[\u{200B}-\u{200F}\u{2028}-\u{202F}\u{2060}-\u{206F}\u{FEFF}]".into()),
            whitespace: re(format!("{WS}+")),
            bars: re(r"\|+".into()),
            trailing_punctuation: re(format!("{WS}+[|:;.,]+$")),
            version_suffixes: vec![
                // Trailing bracketed/parenthesised version chunk.
                re(format!(
                    r"{WS}*[(\[][^()\[\]]*[0-9]+(?:\.[0-9]+)+[^()\[\]]*[)\]]{WS}*$"
                )),
                // Dash-prefixed version, before the bare numeric form.
                re(format!(
                    r"(?i){WS}*[—–-]{WS}*(?:build{WS}+|version{WS}+|ver\.?{WS}*|v\.?{WS}*)?[0-9]+(?:\.[0-9]+)+{WS}*$"
                )),
                re(format!(r"(?i){WS}*[—–-]{WS}*v[0-9]+{WS}*$")),
                // "App version 1.2.3" / "App ver. 1.2.3" / "App v1.2.3" / "App 1.2.3".
                re(format!(
                    r"(?i){WS}+(?:version{WS}+|ver\.?{WS}*|v\.?{WS}*)?[0-9]+(?:\.[0-9]+)+{WS}*$"
                )),
                // Trailing "v<digits>" with no dot.
                re(format!(r"(?i){WS}+v[0-9]+{WS}*$")),
                // An orphaned trailing separator.
                re(format!(r"{WS}*[—–\-|:;,]+{WS}*$")),
            ],
            letter_or_number: re(r"[\p{L}\p{N}]".into()),
            hex_or_dash: re(r"(?i)^[0-9a-f-]+$".into()),
            bundle_id: re(r"^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+){2,}$".into()),
            version_token: re(r"(?i)^v?[0-9]+(?:\.[0-9]+){1,5}$".into()),
            size: re(format!(r"(?i)^[0-9]+(?:[.,][0-9]+)?{WS}?(?:KB|MB|GB|TB)$")),
            price: re(format!(r"^[$€£¥]{WS}?[0-9]+(?:[.,][0-9]{{1,2}})?$")),
            boolish: re(r"(?i)^(yes|no|true|false|y|n)$".into()),
            ascii_letter: re(r"[A-Za-z]".into()),
        }
    })
}

/// `stripVersionSuffix`: up to four passes from the right.
fn strip_version_suffix(value: &str) -> String {
    let re = regexes();
    let mut next = js_trim(value).to_string();
    for _ in 0..4 {
        let before = next.clone();
        let mut current = next;
        for pattern in &re.version_suffixes {
            current = pattern.replacen(&current, 1, "").into_owned();
        }
        next = js_trim(&current).to_string();
        if next == before {
            break;
        }
    }
    next
}

/// `normalizeAppName`: `""` means "not a usable name".
fn normalize_app_name(value: &str) -> String {
    let re = regexes();
    let mut next = re.control.replace_all(value, " ").into_owned();
    next = re.zero_width.replace_all(&next, "").into_owned();
    next = re.whitespace.replace_all(&next, " ").into_owned();
    next = re.bars.replace_all(&next, " ").into_owned();
    next = re.trailing_punctuation.replacen(&next, 1, "").into_owned();
    next = js_trim(&next).to_string();
    next = strip_version_suffix(&next);
    if js_length(&next) > MAX_NAME_LENGTH {
        next = js_trim(&js_slice_prefix(&next, MAX_NAME_LENGTH)).to_string();
    }
    if js_length(&next) < 2 {
        return String::new();
    }
    if !re.letter_or_number.is_match(&next) {
        return String::new();
    }
    next
}

fn looks_like_udid(value: &str) -> bool {
    let s = js_trim(value);
    if !regexes().hex_or_dash.is_match(s) {
        return false;
    }
    let stripped: String = s.chars().filter(|c| *c != '-').collect();
    if stripped.len() < 8 {
        return false;
    }
    if s.contains('-') {
        return true;
    }
    stripped.len() >= 16
}

/// `looksLikeNonName`: UDIDs, bundle ids, versions, sizes, prices and
/// flags are cells, not names.
fn looks_like_non_name(value: &str) -> bool {
    let re = regexes();
    let trimmed = js_trim(value);
    if trimmed.is_empty() {
        return true;
    }
    if looks_like_udid(trimmed) || re.bundle_id.is_match(trimmed) {
        return true;
    }
    if re.version_token.is_match(trimmed) || re.size.is_match(trimmed) {
        return true;
    }
    let lower = trimmed.to_lowercase();
    if lower == "free" || re.price.is_match(&lower) {
        return true;
    }
    if re.boolish.is_match(trimmed) {
        return true;
    }
    !re.ascii_letter.is_match(trimmed)
}

/// `sanitizeDeveloperCell`.
fn sanitize_developer_cell(value: &str) -> Option<String> {
    let re = regexes();
    let mut next = re.control.replace_all(value, " ").into_owned();
    next = re.whitespace.replace_all(&next, " ").into_owned();
    next = js_trim(&next).to_string();
    if next.is_empty() || looks_like_non_name(&next) {
        return None;
    }
    if HEADER_CELL_LABELS.contains(&next.to_lowercase().as_str()) {
        return None;
    }
    if js_length(&next) > MAX_NAME_LENGTH {
        next = js_trim(&js_slice_prefix(&next, MAX_NAME_LENGTH)).to_string();
    }
    Some(next)
}

/// `sanitizeNamesList`: canonical names, deduped case-insensitively,
/// capped at 500.
fn sanitize_names_list(values: &Value) -> Vec<String> {
    let Some(values) = values.as_array() else {
        return vec![];
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for raw in values.iter().filter_map(Value::as_str) {
        let clean = normalize_app_name(raw);
        if clean.is_empty() || !seen.insert(clean.to_lowercase()) {
            continue;
        }
        out.push(clean);
    }
    out.truncate(MAX_IMPORT_ROWS);
    out
}

/// `sanitizeRowsList`: `{ name, developer? , likelyWebClip? }` entries,
/// merged case-insensitively so a developer hint or a web-clip signal on
/// any duplicate survives.
fn sanitize_rows_list(values: &Value) -> Vec<Value> {
    let Some(values) = values.as_array() else {
        return vec![];
    };
    let mut rows: Vec<(String, Map<String, Value>)> = vec![];
    for raw in values {
        let Some(raw) = raw.as_object() else {
            continue;
        };
        let Some(name) = raw.get("name").and_then(Value::as_str) else {
            continue;
        };
        let name = normalize_app_name(name);
        if name.is_empty() {
            continue;
        }
        let developer = raw
            .get("developer")
            .and_then(Value::as_str)
            .and_then(sanitize_developer_cell);
        let mut entry = Map::new();
        entry.insert("name".into(), json!(name));
        if let Some(developer) = developer {
            entry.insert("developer".into(), json!(developer));
        }
        if raw.get("likelyWebClip") == Some(&json!(true)) {
            entry.insert("likelyWebClip".into(), json!(true));
        }
        let key = name.to_lowercase();
        match rows.iter_mut().find(|(k, _)| *k == key) {
            None => rows.push((key, entry)),
            Some((_, existing)) => {
                let existing_developer = existing.get("developer").is_some_and(truthy);
                let mut merged =
                    if !existing_developer && entry.get("developer").is_some_and(truthy) {
                        entry.clone()
                    } else {
                        existing.clone()
                    };
                if existing.get("likelyWebClip") == Some(&json!(true))
                    || entry.get("likelyWebClip") == Some(&json!(true))
                {
                    merged.insert("likelyWebClip".into(), json!(true));
                }
                *existing = merged;
            }
        }
    }
    rows.truncate(MAX_IMPORT_ROWS);
    rows.into_iter()
        .map(|(_, row)| Value::Object(row))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_suffixes_are_stripped_but_years_are_not() {
        assert_eq!(normalize_app_name("Facebook 500.0.0.46.78"), "Facebook");
        assert_eq!(normalize_app_name("Gmail v1.2.3"), "Gmail");
        assert_eq!(normalize_app_name("Settings version 17.4.1"), "Settings");
        assert_eq!(normalize_app_name("Outlook — 1.2.3"), "Outlook");
        assert_eq!(normalize_app_name("App (1.2.3)"), "App");
        assert_eq!(normalize_app_name("App [v2.0]"), "App");
        assert_eq!(normalize_app_name("Facebook 1.2.3 (build 4.5)"), "Facebook");
        assert_eq!(normalize_app_name("My App v2"), "My App");
        assert_eq!(normalize_app_name("Word 2024"), "Word 2024");
        assert_eq!(normalize_app_name("|"), "");
        assert_eq!(normalize_app_name("a"), "");
        // The bar becomes a space AFTER whitespace collapses, and the
        // trailing-punctuation strip needs whitespace before the mark.
        assert_eq!(normalize_app_name("  Two  |  Words. "), "Two   Words.");
        assert_eq!(normalize_app_name("Two | Words ."), "Two   Words");
    }

    #[test]
    fn developer_cells_drop_non_names() {
        assert_eq!(
            sanitize_developer_cell("Acme, Inc."),
            Some("Acme, Inc.".into())
        );
        assert_eq!(sanitize_developer_cell("v1.2.3"), None);
        assert_eq!(sanitize_developer_cell("com.example.app"), None);
        assert_eq!(sanitize_developer_cell("12.5 MB"), None);
        assert_eq!(sanitize_developer_cell("$0.99"), None);
        assert_eq!(sanitize_developer_cell("Free"), None);
        assert_eq!(sanitize_developer_cell("App Name"), None);
        assert_eq!(sanitize_developer_cell("00008030-001A2B3C4D5E"), None);
        assert_eq!(sanitize_developer_cell("2024"), None);
    }

    #[test]
    fn int32_wraps_like_javascript() {
        assert_eq!(to_int32(2.5), 2);
        assert_eq!(to_int32(-1.5), -1);
        assert_eq!(to_int32(4_294_967_297.0), 1);
        assert_eq!(to_int32(2_147_483_648.0), -2_147_483_648);
        assert_eq!(to_int32(f64::NAN), 0);
    }

    #[test]
    fn short_ids_round_trip_the_counter() {
        assert_eq!(
            crate::scrape::persist::base64url(&[0, 0, 0, 0, 0, 0, 0, 0, 1]),
            "AAAAAAAAAAAB"
        );
        assert_eq!(crate::scrape::persist::base64url(b"\xff\xff\xff"), "____");
    }
}

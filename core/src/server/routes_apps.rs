//! `GET /api/apps` — one path, five responses, dispatched on the query string
//! in a FIXED order that the Node handler encodes as a chain of early
//! returns. The order is the contract: `?id=X&view=grouped` is the `?id`
//! branch, `?view=grouped&limit=10` is the grouped branch, and neither is
//! an error.
//!
//! axum routes by path, so this handler has to serve every branch from the
//! commit it is registered in — there is no shipping the bare array first
//! and the rest later. That is why the route lands after the changelog
//! kernel (`?id&changelog=true` is `getChangelog(id, 50)`) and only once the
//! `?id` policy-analysis hydration and the `meta=grid` profile engine exist.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Response,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

use super::apps::{
    count_apps, get_all_apps, get_app_with_privacy, get_apps_page, get_grouped_privacy_view,
};
use super::changelog::get_changelog;
use super::grid_meta::build_app_grid_meta;
use super::json::{json_error, json_ok};
use super::AppState;
use crate::jsnum::js_parse_int;

/// Upper bound for `?limit=` — one grid hydration chunk, not a bulk export.
const MAX_PAGE_LIMIT: i64 = 500;

/// `{ apps, total, limit, offset }`, with `meta` assigned afterwards so it is
/// always LAST when present.
#[derive(Serialize)]
struct PageBody {
    apps: Vec<Value>,
    total: i64,
    limit: i64,
    offset: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<Value>,
}

pub async fn apps(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    // Node reads each param once via searchParams.get and then tests it
    // with JS truthiness, so `?id=` (present, empty) is FALSY and falls
    // through to the branches below — an Option<String> presence check
    // would send it to the 404 instead.
    let id = q.get("id").filter(|v| !v.is_empty());
    let view = q.get("view").map(String::as_str);
    let changelog = q.get("changelog").map(String::as_str);

    let conn = state.conn.lock().expect("db mutex poisoned");

    // 1. `?id=X&changelog=true` — strict string equality on "true"; `TRUE`,
    //    `1` and a bare `?changelog` all miss and land on branch 2. NOTE: no
    //    existence check here, so an unknown id is `[]`, not a 404.
    if let (Some(id), Some("true")) = (id, changelog) {
        return match get_changelog(&conn, id, 50, None) {
            Ok(rows) => json_ok(&rows),
            Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
        };
    }

    // 2. `?id=X` — checked BEFORE view/limit, so both of those are ignored
    //    when an id is present.
    if let Some(id) = id {
        return match get_app_with_privacy(&conn, id) {
            Ok(Some(app)) => json_ok(&app),
            Ok(None) => json_error(StatusCode::NOT_FOUND, "Not found"),
            Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
        };
    }

    // 3. `?view=grouped` — strict equality; checked before `limit`.
    if view == Some("grouped") {
        return match get_grouped_privacy_view(&conn) {
            Ok(groups) => json_ok(&groups),
            Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
        };
    }

    // 4. `?limit=` — PRESENCE (`!== null`), not truthiness, so `?limit=`
    //    empty enters this branch and then 400s on parseInt("") → NaN.
    if let Some(limit_raw) = q.get("limit") {
        let limit = js_parse_int(limit_raw);
        // `searchParams.get("offset") ?? "0"` — nullish, so an EMPTY
        // `?offset=` is NOT replaced by "0"; it reaches parseInt and 400s.
        let offset = match q.get("offset") {
            Some(raw) => js_parse_int(raw),
            None => Some(0),
        };
        let (limit, offset) = match (limit, offset) {
            (Some(l), Some(o)) if (1..=MAX_PAGE_LIMIT).contains(&l) && o >= 0 => (l, o),
            _ => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    // The dash is U+2013 EN DASH in the Node source.
                    &format!("Invalid pagination: limit must be 1–{MAX_PAGE_LIMIT}, offset >= 0"),
                );
            }
        };

        let (apps, total) = match (get_apps_page(&conn, limit, offset), count_apps(&conn)) {
            (Ok(apps), Ok(total)) => (apps, total),
            _ => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
        };

        // `meta=grid` bundles the four side-band maps scoped to this page's
        // ids. Strict equality again.
        let meta = if q.get("meta").map(String::as_str) == Some("grid") {
            let ids: Vec<String> = apps
                .iter()
                .map(|a| match &a["id"] {
                    // `String(a.id)` — a numeric id stringifies without
                    // quotes, a string id passes through.
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect();
            match build_app_grid_meta(&conn, &ids) {
                Ok(meta) => Some(meta),
                Err(_) => {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
                }
            }
        } else {
            None
        };

        return json_ok(&PageBody {
            apps,
            total,
            limit,
            offset,
            meta,
        });
    }

    // 5. Bare — the documented public contract: the whole fleet as an array.
    match get_all_apps(&conn) {
        Ok(apps) => json_ok(&apps),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

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
//!
//! Every branch after the two `?id` ones runs under the request's device
//! scope (`?devices=`). The scope is opt-in: without the param a request
//! gets the whole fleet, whatever the user last picked in the nav.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Response,
};
use serde::Serialize;
use serde_json::Value;

use super::apps::{
    count_apps, get_all_apps_scoped, get_app_with_privacy, get_apps_page, get_grouped_privacy_view,
};
use super::changelog::get_changelog;
use super::grid_meta::build_app_grid_meta;
use super::json::{json_error, json_ok};
use super::routes_stats::{get, Params};
use super::scope::Scope;
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

pub async fn apps(State(state): State<AppState>, Query(q): Query<Params>) -> Response {
    // Node reads each param once via searchParams.get, which returns the
    // FIRST of a repeated key, and then tests it with JS truthiness, so
    // `?id=` (present, empty) is FALSY and falls through to the branches
    // below — an Option<String> presence check would send it to the 404
    // instead.
    let id = get(&q, "id").filter(|v| !v.is_empty());
    let view = get(&q, "view");
    let changelog = get(&q, "changelog");

    let conn = state.db();

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

    // `?devices=` narrows every read below to the apps on those devices. An
    // absent, empty or unresolvable param is the unrestricted scope; the
    // scope the user saved in the nav is never consulted.
    let scope = Scope::from_request(&conn, get(&q, "devices"));

    // 3. `?view=grouped` — strict equality; checked before `limit`.
    if view == Some("grouped") {
        return match get_grouped_privacy_view(&conn, &scope) {
            Ok(groups) => json_ok(&groups),
            Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
        };
    }

    // 4. `?limit=` — PRESENCE (`!== null`), not truthiness, so `?limit=`
    //    empty enters this branch and then 400s on parseInt("") → NaN.
    if let Some(limit_raw) = get(&q, "limit") {
        let limit = js_parse_int(limit_raw);
        // `searchParams.get("offset") ?? "0"` — nullish, so an EMPTY
        // `?offset=` is NOT replaced by "0"; it reaches parseInt and 400s.
        let offset = match get(&q, "offset") {
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

        // The total is the SCOPE's, so the grid's "loaded N of TOTAL" counts
        // the same set the pages are drawn from.
        let (apps, total) = match (
            get_apps_page(&conn, limit, offset, &scope),
            count_apps(&conn, &scope),
        ) {
            (Ok(apps), Ok(total)) => (apps, total),
            _ => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
        };

        // `meta=grid` bundles the four side-band maps scoped to this page's
        // ids. Strict equality again.
        let meta = if get(&q, "meta") == Some("grid") {
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

    // 5. Bare — the documented public contract: the whole fleet as an array,
    //    or the part of it on the devices `?devices=` names.
    match get_all_apps_scoped(&conn, &scope) {
        Ok(apps) => json_ok(&apps),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Alpha on the phone, Beta on no device, nothing on the empty tablet.
    fn state() -> AppState {
        let conn = crate::db::open_and_migrate(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO apps (id, name, url, lastSynced) VALUES
               ('1', 'Alpha', 'https://e/1', 0),
               ('2', 'Beta', 'https://e/2', 0);
             INSERT INTO devices (id, name, created_at, last_synced_at) VALUES
               ('phone', 'Phone', 0, 0),
               ('tablet', 'Empty tablet', 0, 0);
             INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at)
               VALUES ('1', 'phone', 0, 0);",
        )
        .unwrap();
        AppState {
            conn: Arc::new(Mutex::new(conn)),
            rate_limiter: Arc::new(super::super::ratelimit::RateLimiter::new()),
            started_at: std::time::Instant::now(),
            bound_port: 0,
        }
    }

    async fn read(query: &[(&str, &str)]) -> Value {
        let q = query
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let res = apps(State(state()), Query(q)).await;
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn ids(apps: &Value) -> Vec<&str> {
        apps.as_array()
            .unwrap()
            .iter()
            .filter_map(|a| a["id"].as_str())
            .collect()
    }

    #[tokio::test]
    async fn a_device_with_no_apps_scopes_the_list_and_the_page_to_nothing() {
        assert!(ids(&read(&[("devices", "tablet")]).await).is_empty());
        let page = read(&[("limit", "250"), ("meta", "grid"), ("devices", "tablet")]).await;
        assert!(ids(&page["apps"]).is_empty());
        assert_eq!(page["total"], 0);
    }

    #[tokio::test]
    async fn every_list_branch_takes_the_scope_and_a_bare_request_does_not() {
        assert_eq!(ids(&read(&[]).await), ["1", "2"]);
        assert_eq!(ids(&read(&[("devices", "phone")]).await), ["1"]);
        assert_eq!(ids(&read(&[("devices", "unattached")]).await), ["2"]);
        // A device that no longer exists fails open to the whole fleet.
        assert_eq!(ids(&read(&[("devices", "gone")]).await), ["1", "2"]);

        let page = read(&[("limit", "1"), ("devices", "unattached")]).await;
        assert_eq!(ids(&page["apps"]), ["2"], "the scope applies before LIMIT");
        assert_eq!(page["total"], 1);

        let grouped = read(&[("view", "grouped"), ("devices", "tablet")]).await;
        assert_eq!(grouped, serde_json::json!([]));
    }

    #[tokio::test]
    async fn a_repeated_param_keeps_its_first_value() {
        // `searchParams.get` returns the first: an empty first `devices` is
        // the unrestricted scope, whatever follows it.
        let all = read(&[("devices", ""), ("devices", "tablet")]).await;
        assert_eq!(ids(&all), ["1", "2"]);
        let page = read(&[("limit", "1"), ("limit", "2")]).await;
        assert_eq!(page["limit"], 1);
        assert_eq!(ids(&page["apps"]), ["1"]);
    }
}

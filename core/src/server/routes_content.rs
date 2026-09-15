//! HTTP contracts for seven user-content reads. Uncaught Next handler
//! failures are an empty 500; explicitly caught fallbacks stay route-specific.
use super::{
    json::{json_error, json_ok},
    review,
    routes_manual::rate_gate,
    routes_stats::{get, Params},
    scope::Scope,
    shortlist,
    stats::{query, Result},
    user_content, user_tasks, AppState,
};
use axum::{
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use rusqlite::Connection;
use serde_json::{json, Value};
fn uncaught(result: Result<Value>) -> Response {
    match result {
        Ok(v) => json_ok(&v),
        Err(e) => {
            super::diag::log_error(format!("[user-content] {e}"));
            Response::builder().status(500).body(Body::empty()).unwrap()
        }
    }
}
/// Also used by the fixed-clock Node route oracle, including status and headers.
pub(super) fn read(conn: &Connection, path: &str, q: &Params, now: i64) -> Response {
    match path {
        "/api/activity" => uncaught(user_content::activity(conn, q)),
        "/api/notifications" => uncaught(user_content::notifications(conn, now)),
        "/api/notification-prefs" => uncaught(user_content::notification_prefs(conn)),
        "/api/user-tasks" => match user_tasks::read(conn, now) {
            Ok(v) => json_ok(&v),
            Err(e) => {
                super::diag::log_error(format!("[user-tasks] {e}"));
                json_ok(&json!({"tasks":[],"candidates":[]}))
            }
        },
        "/api/annotations" => {
            if get(q, "countApps") == Some("1") {
                let count = query(
                    conn,
                    "SELECT COUNT(DISTINCT app_id) AS n FROM annotations WHERE deleted_at IS NULL",
                    &[],
                )
                .ok()
                .and_then(|r| r.into_iter().next())
                .map(|r| r["n"].clone())
                .unwrap_or(json!(0));
                return json_ok(&json!({"appsWithNotes":count}));
            }
            let Some(id) = get(q, "appId").filter(|s| !s.is_empty()) else {
                return json_error(StatusCode::BAD_REQUEST, "appId is required");
            };
            match review::annotations(conn, id, now) {
                Ok(a) => json_ok(&json!({"annotations":a})),
                Err(e) => {
                    super::diag::log_error(format!("[annotations] {e}"));
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Failed to list annotations",
                    )
                }
            }
        }
        "/api/shortlist" => uncaught(shortlist::list(
            conn,
            &Scope::from_request(conn, get(q, "devices")),
        )),
        "/api/shortlist/export" => {
            let groups = match shortlist::groups(conn, &Scope::default()) {
                Ok(g) => g,
                Err(e) => return uncaught(Err(e)),
            };
            let iso = crate::jsdate::js_iso_string(now);
            if get(q, "format").unwrap_or("md").to_lowercase() == "json" {
                return json_ok(&json!({"exported_at":iso,"groups":groups}));
            }
            let date = iso.split('T').next().unwrap();
            Response::builder()
                .header("content-type", "text/markdown; charset=utf-8")
                .header(
                    "content-disposition",
                    format!("attachment; filename=\"app-shortlist-{date}.md\""),
                )
                .body(Body::from(shortlist::markdown(&groups, date)))
                .unwrap()
        }
        _ => unreachable!("registered content route"),
    }
}
macro_rules! route {
    ($name:ident,$path:literal,$rate:expr) => {
        pub async fn $name(
            State(state): State<AppState>,
            headers: HeaderMap,
            Query(q): Query<Params>,
        ) -> Response {
            if let Some((prefix, limit)) = $rate {
                if let Some(r) = rate_gate(&state, &headers, prefix, limit, 60_000) {
                    return r;
                }
            }
            read(&state.db(), $path, &q, super::now_ms())
        }
    };
}
route!(activity, "/api/activity", None);
route!(notifications, "/api/notifications", None);
route!(notification_prefs, "/api/notification-prefs", None);
route!(user_tasks, "/api/user-tasks", None);
route!(annotations, "/api/annotations", None);
route!(shortlist, "/api/shortlist", Some(("shortlist.list", 120)));
route!(
    shortlist_export,
    "/api/shortlist/export",
    Some(("shortlist.export", 30))
);

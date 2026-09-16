//! Nine operational reads. The shared HTTP gate enforces the AI log's
//! admin requirement before the route's independent 60/minute read bucket.
use super::{
    backup_snapshots, csp_reports, export,
    json::{json_error, json_ok},
    operations::{self, Job},
    routes_manual::rate_gate,
    routes_stats::{get, Params},
    stats::Result,
    AppState,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use rusqlite::Connection;
use serde_json::Value;

pub(super) fn uncaught(result: Result<Value>) -> Response {
    match result {
        Ok(v) => json_ok(&v),
        Err(e) => {
            super::diag::log_error(format!("[operations] {e}"));
            Response::builder().status(500).body(Body::empty()).unwrap()
        }
    }
}

pub(super) fn read(conn: &Connection, route: &str, q: &Params, id: &str, now: i64) -> Response {
    match route {
        "/api/tasks/active" => uncaught(operations::active_tasks(conn)),
        "/api/wayback/import-all" => uncaught(operations::job_status(conn, Job::Wayback)),
        "/api/policy/sync-all" => uncaught(operations::job_status(conn, Job::Policy)),
        "/api/rate-limit/status" => uncaught(operations::cooldowns(conn, now)),
        "/api/ai/debug-log" => uncaught(operations::ai_debug_log(conn)),
        "/api/csp-report" => json_ok(&csp_reports::read()),
        "/api/manual-apps/[id]" => {
            if id.is_empty() || crate::jsstr::js_length(id) > 128 {
                return json_error(StatusCode::BAD_REQUEST, "Invalid id");
            }
            match operations::manual_detail(conn, id) {
                Ok(Some(v)) => json_ok(&v),
                Ok(None) => json_error(StatusCode::NOT_FOUND, "Not found"),
                Err(e) => uncaught(Err(e)),
            }
        }
        "/api/export" => {
            if get(q, "format").unwrap_or("csv") == "json" {
                return uncaught(export::full_json(conn, now));
            }
            match export::csv(conn) {
                Ok(csv) => {
                    let iso = crate::jsdate::js_iso_string(now);
                    let date = iso.split('T').next().unwrap();
                    Response::builder()
                        .header("content-type", "text/csv; charset=utf-8")
                        .header(
                            "content-disposition",
                            format!("attachment; filename=\"privacytracker-{date}.csv\""),
                        )
                        .body(Body::from(csv))
                        .unwrap()
                }
                Err(e) => uncaught(Err(e)),
            }
        }
        _ => unreachable!("registered operational route"),
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
            read(&state.db(), $path, &q, "", super::now_ms())
        }
    };
}
route!(tasks, "/api/tasks/active", None);
route!(wayback, "/api/wayback/import-all", None);
route!(policy, "/api/policy/sync-all", None);
route!(cooldowns, "/api/rate-limit/status", None);
pub async fn backups(State(state): State<AppState>) -> Response {
    let settings = backup_snapshots::settings(&state.db());
    // Release the database lock before doing filesystem work.
    uncaught(settings.and_then(backup_snapshots::payload))
}
route!(
    ai_debug,
    "/api/ai/debug-log",
    Some(("ai_debug_log.read", 60))
);
route!(csp, "/api/csp-report", None);
route!(export, "/api/export", None);
pub async fn manual(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(r) = rate_gate(&state, &headers, "manual-apps.read", 120, 60_000) {
        return r;
    }
    read(
        &state.db(),
        "/api/manual-apps/[id]",
        &Vec::new(),
        &id,
        super::now_ms(),
    )
}

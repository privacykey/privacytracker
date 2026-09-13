//! The deployment-facing reads: `GET /api/ready`,
//! `GET /api/deployment/diagnostics`, `GET /api/diagnostics/database`,
//! `GET /api/diagnostics/disk` and `GET /api/diagnostics/health`.
//!
//! All five describe the deployment — the database file, its directory, the
//! request's forwarded headers, the process env — rather than the serving
//! process's internals, which is what makes them portable exactly. The
//! parity manifest compares the first two byte for byte (paths and
//! durations masked) and the three `/api/diagnostics/*` shape-first
//! (`blankNumbers`), since file and page counts differ between a live
//! database and a checkpointed copy of it.
//!
//! None of them is rate-limited or admin-gated on GET in Node; `/api/ready`
//! is on the public-read list. `/api/ready` is also the container
//! HEALTHCHECK's readiness contract: 503, not 500, when not ready.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde::Serialize;
use serde_json::Value;

use super::deployment::{build_deployment_diagnostics, is_ready, DeploymentCheck};
use super::diagnostics::{read_last_health_check, snapshot_database_health, snapshot_disk};
use super::json::{json_error, json_ok, json_response};
use super::{data_layout, AppState};

fn internal_error() -> Response {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

#[derive(Serialize)]
struct ReadyBody {
    status: &'static str,
    checks: Vec<DeploymentCheck>,
}

pub async fn ready(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let conn = state.conn.lock().expect("db mutex poisoned");
    match build_deployment_diagnostics(&state, &conn, &headers) {
        Ok(d) => {
            let ready = is_ready(&d);
            json_response(
                if ready {
                    StatusCode::OK
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                },
                &ReadyBody {
                    status: if ready { "ready" } else { "not_ready" },
                    checks: d.checks,
                },
            )
        }
        Err(_) => internal_error(),
    }
}

pub async fn deployment_diagnostics(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let conn = state.conn.lock().expect("db mutex poisoned");
    match build_deployment_diagnostics(&state, &conn, &headers) {
        Ok(d) => json_ok(&d),
        Err(_) => internal_error(),
    }
}

pub async fn diagnostics_database(State(state): State<AppState>) -> Response {
    let conn = state.conn.lock().expect("db mutex poisoned");
    json_ok(&snapshot_database_health(&conn, &data_layout().db_path))
}

pub async fn diagnostics_disk(State(state): State<AppState>) -> Response {
    let conn = state.conn.lock().expect("db mutex poisoned");
    match snapshot_disk(&conn, &data_layout().data_dir) {
        Ok(s) => json_ok(&s),
        Err(_) => internal_error(),
    }
}

#[derive(Serialize)]
struct NeverRun {
    #[serde(rename = "neverRun")]
    never_run: bool,
}

pub async fn diagnostics_health(State(state): State<AppState>) -> Response {
    let conn = state.conn.lock().expect("db mutex poisoned");
    match read_last_health_check(&conn) {
        Ok(Some(blob)) => json_ok::<Value>(&blob),
        Ok(None) => json_ok(&NeverRun { never_run: true }),
        Err(_) => internal_error(),
    }
}

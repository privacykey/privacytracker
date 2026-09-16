//! The axum wrappers over `writes.rs`: guard under the lock, read the body
//! with the route's cap while the lock is released, then the handler
//! under the lock again. One wrapper per route so the router reads like
//! `mod.rs`'s other registrations.
use super::{
    body::{read_json, BodyOutcome},
    json::json_error,
    writes::{self, WriteRequest},
    AppState,
};
use crate::scrape::{persist::Writer, RandomIds};
use axum::{
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
};

async fn run(
    state: AppState,
    path: &'static str,
    method: Method,
    param: Option<String>,
    req: Request,
) -> Response {
    let Some(spec) = writes::lookup(path, &method) else {
        return json_error(StatusCode::NOT_FOUND, "Not Found");
    };
    let (parts, body) = req.into_parts();
    let query: Vec<(String, String)> =
        url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let now = super::now_ms();
    let mut ids = RandomIds;
    let actor = {
        let conn = state.db();
        let mut w = Writer::new(&conn, None);
        match writes::precheck(
            &mut w,
            &mut ids,
            &state.rate_limiter,
            &parts.headers,
            spec,
            now,
        ) {
            Ok(actor) => actor,
            Err(response) => return response,
        }
    };
    let outcome = match spec.body_limit {
        Some(limit) => read_json(&parts.headers, body, limit).await,
        None => BodyOutcome::Empty,
    };
    let conn = state.db();
    let mut w = Writer::new(&conn, None);
    writes::perform(
        &mut w,
        &mut ids,
        WriteRequest {
            spec,
            param: param.as_deref(),
            query: &query,
            body: outcome,
        },
        &actor,
        now,
    )
}

macro_rules! wrapper {
    ($name:ident, $path:literal, $method:ident) => {
        pub async fn $name(State(state): State<AppState>, req: Request) -> Response {
            run(state, $path, Method::$method, None, req).await
        }
    };
}

wrapper!(date_format_post, "/api/date-format", POST);
wrapper!(locale_post, "/api/locale", POST);
wrapper!(preferences_put, "/api/preferences", PUT);
wrapper!(settings_post, "/api/settings", POST);
wrapper!(desktop_settings_post, "/api/settings/desktop", POST);
wrapper!(notification_prefs_put, "/api/notification-prefs", PUT);
wrapper!(focus_post, "/api/focus", POST);
wrapper!(privacy_profile_put, "/api/privacy-profile", PUT);
wrapper!(accessibility_profile_put, "/api/accessibility-profile", PUT);
wrapper!(overrides_post, "/api/feature-flags/overrides", POST);
wrapper!(overrides_delete, "/api/feature-flags/overrides", DELETE);
wrapper!(dashboard_layout_put, "/api/dashboard/layout", PUT);
wrapper!(dashboard_layout_delete, "/api/dashboard/layout", DELETE);
wrapper!(
    dashboard_layout_preset_post,
    "/api/dashboard/layout/preset",
    POST
);
wrapper!(coachmark_state_post, "/api/coachmark-state", POST);
wrapper!(dev_menu_state_post, "/api/dev-menu-state", POST);
wrapper!(welcomed_at_post, "/api/welcomed-at", POST);
wrapper!(
    migration_flow_consume_post,
    "/api/migration-flow/consume",
    POST
);

pub async fn override_delete_one(
    State(state): State<AppState>,
    Path(key): Path<String>,
    req: Request,
) -> Response {
    run(
        state,
        "/api/feature-flags/overrides/[key]",
        Method::DELETE,
        Some(key),
        req,
    )
    .await
}

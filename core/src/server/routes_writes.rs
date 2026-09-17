//! The axum wrappers over `writes.rs`: guard under the lock, read the body
//! with the route's cap while the lock is released, then the handler
//! through the accessor — one section under the lock for a handler that
//! never fetches, and for the batch-3 handlers a section either side of
//! each network call, with the lock released in between. One wrapper per
//! route so the router reads like `mod.rs`'s other registrations.
use super::{
    body::{read_json, BodyOutcome},
    json::json_error,
    writes::{self, WriteRequest},
    AppState,
};
use crate::{
    outbound::PublicHttp,
    scrape::{persist::Writer, RandomIds},
};
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
            param.as_deref(),
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
    // The handler takes the lock per section and never across an await, so
    // its future is `Send` and runs here like any other; a scrape, a
    // search or a Wayback run holds the connection only for the reads and
    // writes either side of each fetch.
    let mut db = state.db_access();
    writes::perform_async(
        &mut db,
        &mut ids,
        &PublicHttp,
        WriteRequest {
            spec,
            param: param.as_deref(),
            query: &query,
            body: outcome,
        },
        &actor,
        now,
    )
    .await
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

// ── Phase 4, batch 2 ─────────────────────────────────────────────────

macro_rules! wrapper_with_id {
    ($name:ident, $path:literal, $method:ident) => {
        pub async fn $name(
            State(state): State<AppState>,
            Path(id): Path<String>,
            req: Request,
        ) -> Response {
            run(state, $path, Method::$method, Some(id), req).await
        }
    };
}

wrapper!(shortlist_post, "/api/shortlist", POST);
wrapper!(shortlist_delete, "/api/shortlist", DELETE);
wrapper!(verdicts_post, "/api/verdicts", POST);
wrapper!(verdicts_delete, "/api/verdicts", DELETE);
wrapper!(verdicts_bulk_post, "/api/verdicts/bulk", POST);
wrapper!(notifications_post, "/api/notifications", POST);
wrapper!(annotations_post, "/api/annotations", POST);
wrapper_with_id!(annotation_patch, "/api/annotations/[id]", PATCH);
wrapper_with_id!(annotation_delete, "/api/annotations/[id]", DELETE);
wrapper_with_id!(annotation_put, "/api/annotations/[id]", PUT);
wrapper_with_id!(acknowledge_post, "/api/apps/[id]/acknowledge", POST);
wrapper_with_id!(
    acknowledge_undo_post,
    "/api/apps/[id]/acknowledge/undo",
    POST
);
wrapper!(user_tasks_post, "/api/user-tasks", POST);
wrapper!(user_tasks_visit_post, "/api/user-tasks/visit", POST);
wrapper!(queue_session_post, "/api/activity/queue-session", POST);
wrapper!(devices_post, "/api/devices", POST);
wrapper_with_id!(device_patch, "/api/devices/[id]", PATCH);
wrapper_with_id!(device_delete, "/api/devices/[id]", DELETE);
wrapper!(device_scope_put, "/api/device-scope", PUT);
wrapper!(device_scope_delete, "/api/device-scope", DELETE);
wrapper!(manual_apps_post, "/api/manual-apps", POST);
wrapper_with_id!(manual_put, "/api/manual-apps/[id]", PUT);
wrapper_with_id!(manual_delete, "/api/manual-apps/[id]", DELETE);
wrapper!(manual_bulk_post, "/api/manual-apps/bulk", POST);
wrapper_with_id!(manual_restore_post, "/api/manual-apps/[id]/restore", POST);

// ── Phase 4, batch 3 ─────────────────────────────────────────────────

wrapper!(imports_post, "/api/imports", POST);
wrapper!(imports_delete, "/api/imports", DELETE);
wrapper!(import_items_post, "/api/imports/items", POST);
wrapper!(import_item_update_post, "/api/imports/items/update", POST);
wrapper!(import_queue_post, "/api/imports/queue", POST);
wrapper!(import_complete_post, "/api/imports/complete", POST);
wrapper!(import_item_retry_post, "/api/imports/items/retry", POST);
wrapper!(
    import_item_change_match_post,
    "/api/imports/items/change-match",
    POST
);
wrapper!(search_post, "/api/search", POST);
wrapper!(scrape_post, "/api/scrape", POST);
wrapper_with_id!(import_history_post, "/api/apps/[id]/import-history", POST);
wrapper_with_id!(
    import_history_delete,
    "/api/apps/[id]/import-history",
    DELETE
);

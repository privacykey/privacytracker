//! The axum wrappers over `writes.rs`: guard under the lock, read the body
//! with the route's cap while the lock is released, then the handler
//! through the accessor — one section under the lock for a handler that
//! never fetches, and for the batch-3 handlers a section either side of
//! each network call, with the lock released in between. One wrapper per
//! route so the router reads like `mod.rs`'s other registrations.
use super::{
    body::{read_json, read_raw, BodyOutcome},
    json::json_error,
    writes::{self, WriteRequest},
    AppState,
};
use crate::{
    outbound::PublicHttp,
    scrape::{
        persist::{Shared, Writer},
        RandomIds,
    },
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
        // The audit-bundle import takes a multipart upload and parses it
        // itself; everything else is JSON.
        Some(limit) if super::bundle_writes::takes_raw_body(spec, &parts.headers) => {
            read_raw(&parts.headers, body, limit).await
        }
        Some(limit) => read_json(&parts.headers, body, limit).await,
        None => BodyOutcome::Empty,
    };
    // The handler takes the lock per section and never across an await, so
    // its future is `Send` and runs here like any other; a scrape, a
    // search or a Wayback run holds the connection only for the reads and
    // writes either side of each fetch.
    // `Shared` rather than `Locked`: the runs that outlive the request
    // (batch 4b's streaming and resumed Wayback imports) detach an owned
    // copy of it.
    let mut db = Shared {
        conn: state.conn.clone(),
        log: None,
        on_wait: Some(super::diag::record_lock_wait),
    };
    writes::perform_async(
        &mut db,
        &mut ids,
        &PublicHttp,
        WriteRequest {
            spec,
            param: param.as_deref(),
            query: &query,
            body: outcome,
            headers: &parts.headers,
            state: Some(&state),
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
wrapper_with_id!(manual_scrape_post, "/api/manual-apps/[id]/scrape", POST);
// Phase 5, batch 3b: the AI routes.
wrapper!(policy_regenerate_post, "/api/policy/regenerate", POST);
wrapper!(ai_policy_sample_post, "/api/ai/policy-sample", POST);
wrapper!(ai_test_post, "/api/ai/test", POST);
wrapper!(ai_models_post, "/api/ai/models", POST);

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

// ── Phase 4, batch 4a ────────────────────────────────────────────────

wrapper!(sync_trigger_post, "/api/sync/trigger", POST);
wrapper!(dev_sync_stop_post, "/api/dev/sync-stop", POST);
wrapper!(rate_limit_status_delete, "/api/rate-limit/status", DELETE);
wrapper!(apps_delete, "/api/apps", DELETE);

// ── Phase 4, batch 4b ────────────────────────────────────────────────

wrapper!(wayback_import_all_post, "/api/wayback/import-all", POST);
wrapper!(wayback_import_all_patch, "/api/wayback/import-all", PATCH);
wrapper!(wayback_import_all_delete, "/api/wayback/import-all", DELETE);

// ── Phase 4, batch 5a ────────────────────────────────────────────────

wrapper!(diagnostics_health_post, "/api/diagnostics/health", POST);
wrapper!(diagnostics_database_post, "/api/diagnostics/database", POST);
wrapper!(diagnostics_errors_delete, "/api/diagnostics/errors", DELETE);
wrapper!(
    diagnostics_runtime_delete,
    "/api/diagnostics/runtime",
    DELETE
);
wrapper!(diagnostics_runtime_post, "/api/diagnostics/runtime", POST);
wrapper!(ai_debug_log_delete, "/api/ai/debug-log", DELETE);
wrapper!(admin_token_login_post, "/api/auth/admin-token/login", POST);
wrapper!(
    admin_token_logout_post,
    "/api/auth/admin-token/logout",
    POST
);
wrapper!(csp_report_post, "/api/csp-report", POST);
wrapper!(dev_reset_changelog_post, "/api/dev/reset-changelog", POST);
wrapper!(
    dev_seed_notification_post,
    "/api/dev/seed-notification",
    POST
);
wrapper!(dev_wipe_apps_post, "/api/dev/wipe-apps", POST);
wrapper!(reset_post, "/api/reset", POST);
wrapper!(admin_start_over_post, "/api/admin/start-over", POST);

// ── Phase 4, batch 5b ────────────────────────────────────────────────

wrapper!(backup_snapshots_put, "/api/backup/snapshots", PUT);
wrapper!(backup_snapshots_post, "/api/backup/snapshots", POST);
wrapper!(backup_export_get, "/api/backup/export", GET);
wrapper!(backup_preview_post, "/api/backup/preview", POST);
wrapper!(backup_restore_post, "/api/backup/restore", POST);

// ── Phase 4, batch 5c ────────────────────────────────────────────────

wrapper!(export_audit_bundle_post, "/api/export/audit-bundle", POST);
wrapper!(import_audit_bundle_post, "/api/import/audit-bundle", POST);

// ── Phase 4, batch 5d ────────────────────────────────────────────────

wrapper!(seed_sample_data_post, "/api/dev/seed-sample-data", POST);

// ── Phase 4, batch 6 ─────────────────────────────────────────────────

wrapper!(
    notifications_webhook_test_post,
    "/api/notifications/webhook-test",
    POST
);

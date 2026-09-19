//! Phase 4, batch 5a: the maintenance writes — the manual health check,
//! the diagnostics writes (`POST /api/diagnostics/database`, `DELETE
//! /api/diagnostics/errors`, `DELETE` and `POST /api/diagnostics/runtime`,
//! `DELETE /api/ai/debug-log`), the admin-token login and logout, the CSP
//! report ingest, the dev helpers (`reset-changelog`, `seed-notification`,
//! `wipe-apps`) and the two teardowns (`/api/reset`, `/api/admin/start-
//! over`). Each is the Node route in order, gated by
//! `core/tests/fixtures/maintenance-cases.json`.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use super::{
    activity_log::record_activity,
    auth::{
        admin_token_configured, login_brute_force_tripped, record_login_failure,
        request_has_valid_admin_token, ADMIN_TOKEN_COOKIE,
    },
    body::{body_error_response, BodyOutcome},
    csp_reports, diag,
    diagnostics::{last_integrity_check, run_integrity_check, snapshot_database_health},
    guard::{record_audit, Actor},
    health_check::run_health_check,
    imports_writes::transaction,
    json::{json_error, json_ok},
    ratelimit::{self, RateLimiter},
    runtime_diag::{self, sqlite_metrics},
    stats::truthy,
    trust::{is_same_origin_request, request_origin, trust_proxy},
    writes::{internal_error, prop, Cx, RouteSpec, WriteRequest},
};
use crate::{
    jsdate::js_utc_string,
    jsstr::{js_encode_uri_component, js_slice_prefix, js_trim},
    scrape::Ids,
};
use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::Response,
};
use serde_json::{json, Value};

const ADMIN_TOKEN_MAX_AGE_SECONDS: i64 = 8 * 60 * 60;
const CLEAR_AI_DEBUG_LOG: &str = "DELETE FROM ai_debug_log";
pub(super) const INSERT_NOTIFICATION: &str = "\n    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read, not_before)\n    VALUES (?, ?, ?, ?, ?, 0, ?)\n  ";
const RESET_APPS_CHANGE_STATE: &str = "UPDATE apps\n             SET changeCount = 0,\n                 changes_acknowledged_at = 0,\n                 changes_snoozed_until = 0";
/// lib/reset-tables.ts, children before parents.
const APP_DATA_TABLES_TO_TRUNCATE: [&str; 22] = [
    "annotations",
    "app_verdicts",
    "privacy_data_types",
    "privacy_categories",
    "privacy_purposes",
    "privacy_types",
    "privacy_snapshots",
    "privacy_policy_versions",
    "privacy_policy_analyses",
    "change_review_actions",
    "accessibility_features",
    "related_apps_observed",
    "manual_app_events",
    "manual_app_policy_versions",
    "manual_apps",
    "apps",
    "import_items",
    "imports",
    "audit_bundle_imports",
    "notifications",
    "activity_log",
    "shortlist_entries",
];
const START_OVER_EXTRA_TABLES: [&str; 3] = ["feature_flag_overrides", "audit_log", "ai_debug_log"];
/// `/api/reset`'s own list, in its order.
const RESET_TABLES: [&str; 11] = [
    "notifications",
    "import_items",
    "imports",
    "manual_apps",
    "privacy_data_types",
    "privacy_categories",
    "privacy_purposes",
    "privacy_snapshots",
    "privacy_types",
    "apps",
    "app_settings",
];

pub(super) fn handles(spec: &RouteSpec) -> bool {
    matches!(
        spec.path,
        "/api/diagnostics/health"
            | "/api/diagnostics/database"
            | "/api/diagnostics/errors"
            | "/api/diagnostics/runtime"
            | "/api/ai/debug-log"
            | "/api/auth/admin-token/login"
            | "/api/auth/admin-token/logout"
            | "/api/csp-report"
            | "/api/dev/reset-changelog"
            | "/api/dev/seed-notification"
            | "/api/dev/wipe-apps"
            | "/api/reset"
            | "/api/admin/start-over"
    )
}

pub(super) fn perform(cx: &mut Cx, req: WriteRequest, actor: &Actor) -> Response {
    let spec = req.spec;
    match (spec.path, &spec.method) {
        ("/api/diagnostics/health", &Method::POST) => health_run(cx, actor),
        ("/api/diagnostics/database", &Method::POST) => database_check(cx, req.body, actor),
        ("/api/diagnostics/errors", &Method::DELETE) => errors_clear(cx, actor),
        ("/api/diagnostics/runtime", &Method::DELETE) => runtime_clear(cx, req.state, actor),
        ("/api/diagnostics/runtime", &Method::POST) => {
            runtime_config(cx, req.body, req.state, actor)
        }
        ("/api/ai/debug-log", &Method::DELETE) => ai_debug_log_clear(cx, actor),
        ("/api/auth/admin-token/login", &Method::POST) => login(cx, req.body, req.headers, actor),
        ("/api/auth/admin-token/logout", &Method::POST) => logout(cx, actor),
        ("/api/csp-report", &Method::POST) => csp_report(req.body, cx.now),
        ("/api/dev/reset-changelog", &Method::POST) => reset_changelog(cx, actor),
        ("/api/dev/seed-notification", &Method::POST) => seed_notification(cx, req.body, actor).0,
        ("/api/dev/wipe-apps", &Method::POST) => wipe_apps(cx, actor),
        ("/api/reset", &Method::POST) => reset(cx, actor),
        ("/api/admin/start-over", &Method::POST) => start_over(cx, actor),
        _ => json_error(StatusCode::NOT_FOUND, "Not Found"),
    }
}

/// `readBoundedJson`'s two parse failures, after the size and timeout
/// responses.
fn bounded_json(body: BodyOutcome) -> Result<Value, Response> {
    if let Some(response) = body_error_response(&body) {
        return Err(response);
    }
    match body {
        BodyOutcome::Json(v) => Ok(v),
        BodyOutcome::Empty => Err(json_error(StatusCode::BAD_REQUEST, "Request body is empty")),
        _ => Err(json_error(StatusCode::BAD_REQUEST, "Invalid JSON body")),
    }
}

fn empty(status: StatusCode) -> Response {
    Response::builder()
        .status(status)
        .body(Body::empty())
        .expect("static response")
}

fn head<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// `String(Math.ceil(retryAfterMs / 1000))` on a 429.
fn with_retry_after(mut response: Response, retry_after_ms: i64) -> Response {
    let seconds = (retry_after_ms.max(0) + 999) / 1000;
    if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

// ── POST /api/diagnostics/health ─────────────────────────────────────

fn health_run(cx: &mut Cx, actor: &Actor) -> Response {
    let result = run_health_check(cx, "manual");
    let status = result["status"].as_str().unwrap_or("error");
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "diagnostics.health.run.complete",
        actor,
        Some(&format!(
            "status={status} heals={} warnings={}",
            result["heals"].as_array().map_or(0, Vec::len),
            result["checks"]["warnings"].as_array().map_or(0, Vec::len)
        )),
        status != "error",
    );
    json_ok(&result)
}

// ── POST /api/diagnostics/database ───────────────────────────────────

/// The snapshot with the in-process integrity cache folded in, as the
/// GET serves it.
fn database_snapshot(cx: &Cx) -> Value {
    let path = std::path::Path::new(cx.w.conn.path().unwrap_or(""));
    let mut snapshot = snapshot_database_health(cx.w.conn, path);
    snapshot.integrity_check = last_integrity_check();
    json!(snapshot)
}

fn database_check(cx: &mut Cx, body: BodyOutcome, actor: &Actor) -> Response {
    let body = match bounded_json(body) {
        Ok(v) => v,
        Err(response) => return response,
    };
    if prop(&body, "runIntegrityCheck") != Some(&json!(true)) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "pass `{ \"runIntegrityCheck\": true }` to run the check",
        );
    }
    let result = run_integrity_check(cx.w.conn, cx.now);
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "diagnostics.database.check.complete",
        actor,
        Some(&format!(
            "status={} duration={}ms",
            result["status"].as_str().unwrap_or(""),
            result["durationMs"]
        )),
        result["status"] == "ok",
    );
    let mut payload = database_snapshot(cx);
    payload["justRan"] = result;
    json_ok(&payload)
}

// ── DELETE /api/diagnostics/errors ───────────────────────────────────

fn errors_clear(cx: &mut Cx, actor: &Actor) -> Response {
    diag::clear_error_log();
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "diagnostics.errors.clear.success",
        actor,
        None,
        true,
    );
    json_ok(&diag::error_log_snapshot(None))
}

// ── DELETE / POST /api/diagnostics/runtime ───────────────────────────

/// This server's own envelope, which needs the process behind it.
fn runtime_payload(cx: &Cx, state: Option<&super::AppState>) -> Response {
    match state {
        Some(state) => json_ok(&runtime_diag::build(state, sqlite_metrics(cx.w.conn), None)),
        None => internal_error(),
    }
}

fn runtime_clear(cx: &mut Cx, state: Option<&super::AppState>, actor: &Actor) -> Response {
    // The slow-query ring, the lag histograms and the HTTP timings; the
    // db-worker and scrape-activity rings have no counterpart here.
    diag::clear_slow_queries();
    diag::reset_histograms();
    diag::clear_http();
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "diagnostics.runtime.clear.success",
        actor,
        None,
        true,
    );
    runtime_payload(cx, state)
}

fn runtime_config(
    cx: &mut Cx,
    body: BodyOutcome,
    state: Option<&super::AppState>,
    actor: &Actor,
) -> Response {
    let body = match bounded_json(body) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let Some(enabled) = prop(&body, "profilingEnabled").and_then(Value::as_bool) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "`profilingEnabled` must be a boolean.",
        );
    };
    diag::set_profiling_enabled(enabled);
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "diagnostics.runtime.config.success",
        actor,
        Some(&format!("profilingEnabled={enabled}")),
        true,
    );
    runtime_payload(cx, state)
}

// ── DELETE /api/ai/debug-log ─────────────────────────────────────────

fn ai_debug_log_clear(cx: &mut Cx, actor: &Actor) -> Response {
    if cx.w.run(CLEAR_AI_DEBUG_LOG, vec![]).is_err() {
        return internal_error();
    }
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "ai_debug_log.cleared",
        actor,
        None,
        true,
    );
    json_ok(&json!({ "success": true }))
}

// ── POST /api/auth/admin-token/login ─────────────────────────────────

/// The login's checks ahead of the body: same-origin, the global
/// brute-force backstop (skipped for a caller already holding a valid
/// token), then the per-address limit — each 429 audited and carrying a
/// `Retry-After`.
pub(super) fn login_precheck(
    w: &mut crate::scrape::persist::Writer,
    ids: &mut dyn Ids,
    limiter: &RateLimiter,
    headers: &HeaderMap,
    actor: &Actor,
    now: i64,
) -> Result<(), Response> {
    if !is_same_origin_request(headers, trust_proxy()) {
        return Err(json_error(StatusCode::FORBIDDEN, "Same-origin required"));
    }
    let already_authed = request_has_valid_admin_token(
        head(headers, "x-auditor-admin-token"),
        head(headers, header::COOKIE.as_str()),
    );
    if !already_authed {
        if let Some(retry_after_ms) = login_brute_force_tripped(now) {
            record_audit(
                w,
                ids,
                now,
                "admin_token.login.global_throttled",
                actor,
                Some(&format!("retryAfterMs={retry_after_ms}")),
                false,
            );
            return Err(with_retry_after(
                json_error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many failed attempts. Try again later.",
                ),
                retry_after_ms,
            ));
        }
    }
    let key = ratelimit::key_for_request(
        head(headers, "x-forwarded-for"),
        head(headers, "x-real-ip"),
        "admin-token-login",
    );
    let rate = limiter.check(&key, 5, 60_000, now);
    if !rate.allowed {
        record_audit(
            w,
            ids,
            now,
            "admin_token.login.rate_limited",
            actor,
            Some(&format!("retryAfterMs={}", rate.retry_after_ms)),
            false,
        );
        return Err(with_retry_after(
            json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many attempts. Try again shortly.",
            ),
            rate.retry_after_ms,
        ));
    }
    Ok(())
}

/// `timingSafeEqual` after the length check.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn set_cookie(mut response: Response, cookie: String) -> Response {
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

fn login(cx: &mut Cx, body: BodyOutcome, headers: &HeaderMap, actor: &Actor) -> Response {
    if !admin_token_configured() {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "AUDITOR_ADMIN_TOKEN is not configured on the server.",
        );
    }
    let body = match body_error_response(&body) {
        Some(response) => return response,
        None => match body {
            BodyOutcome::Json(v) => v,
            _ => return json_error(StatusCode::BAD_REQUEST, "Invalid JSON"),
        },
    };
    let provided = prop(&body, "token")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or("");
    if provided.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Token is required");
    }
    let expected = crate::host_env::var("AUDITOR_ADMIN_TOKEN").unwrap_or_default();
    if !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        record_login_failure(cx.now);
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "admin_token.login.invalid",
            actor,
            None,
            false,
        );
        return json_error(StatusCode::UNAUTHORIZED, "Invalid token");
    }
    record_audit(cx.w, cx.ids, cx.now, "admin_token.login", actor, None, true);
    // `Secure` only over HTTPS, read off the request's perceived scheme;
    // Next serialises the eight-hour cookie with both Expires and Max-Age.
    let https = request_origin(headers, trust_proxy()).is_some_and(|o| o.starts_with("https:"));
    let cookie = format!(
        "{ADMIN_TOKEN_COOKIE}={}; Path=/; Expires={}; Max-Age={ADMIN_TOKEN_MAX_AGE_SECONDS}; {}HttpOnly; SameSite=strict",
        js_encode_uri_component(provided),
        js_utc_string(cx.now + ADMIN_TOKEN_MAX_AGE_SECONDS * 1000),
        if https { "Secure; " } else { "" }
    );
    set_cookie(json_ok(&json!({ "ok": true })), cookie)
}

// ── POST /api/auth/admin-token/logout ────────────────────────────────

pub(super) fn logout_precheck(headers: &HeaderMap) -> Result<(), Response> {
    if !is_same_origin_request(headers, trust_proxy()) {
        return Err(json_error(StatusCode::FORBIDDEN, "Same-origin required"));
    }
    Ok(())
}

fn logout(cx: &mut Cx, actor: &Actor) -> Response {
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "admin_token.logout",
        actor,
        None,
        true,
    );
    set_cookie(
        json_ok(&json!({ "ok": true })),
        format!("{ADMIN_TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=strict"),
    )
}

// ── POST /api/csp-report ─────────────────────────────────────────────

/// Public by design: an anonymous browser POST, so only the per-address
/// limit stands in front of it — a bare 429.
pub(super) fn csp_report_precheck(
    limiter: &RateLimiter,
    headers: &HeaderMap,
    now: i64,
) -> Result<(), Response> {
    let key = ratelimit::key_for_request(
        head(headers, "x-forwarded-for"),
        head(headers, "x-real-ip"),
        "csp-report",
    );
    if !limiter.check(&key, 30, 60_000, now).allowed {
        return Err(empty(StatusCode::TOO_MANY_REQUESTS));
    }
    Ok(())
}

/// `summarise`: the legacy `report-uri` shape (`{ "csp-report": … }`, or
/// the bare body) and the Reporting API's array of `{ body }`, the first
/// body taken, each field the first non-nullish spelling cut to length.
fn summarise(raw: &Value, now: i64) -> Option<Value> {
    let bodies: Vec<&Value> = match raw {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| prop(item, "body"))
            .filter(|b| truthy(b))
            .collect(),
        Value::Object(_) => vec![match prop(raw, "csp-report") {
            Some(v) if !v.is_null() => v,
            _ => raw,
        }],
        _ => vec![],
    };
    let b = *bodies.first()?;
    if !truthy(b) || !(b.is_object() || b.is_array()) {
        return None;
    }
    let field = |keys: &[&str], max: usize| -> String {
        keys.iter()
            .filter_map(|k| prop(b, k))
            .find(|v| !v.is_null())
            .and_then(Value::as_str)
            .map(|s| js_slice_prefix(s, max))
            .unwrap_or_default()
    };
    Some(json!({
        "receivedAt": now,
        "directive": field(&["effective-directive", "effectiveDirective", "violated-directive"], 64),
        "blockedUri": field(&["blocked-uri", "blockedURL", "blockedURI"], 200),
        "documentUri": field(&["document-uri", "documentURL"], 200),
        "sample": field(&["script-sample", "sample"], 120),
    }))
}

fn csp_report(body: BodyOutcome, now: i64) -> Response {
    // `readBoundedBody` + `JSON.parse` in one try: too large, timed out,
    // empty and unparseable all answer the same bare 400.
    let BodyOutcome::Json(raw) = body else {
        return empty(StatusCode::BAD_REQUEST);
    };
    if let Some(report) = summarise(&raw, now) {
        let blocked = report["blockedUri"].as_str().unwrap_or("");
        diag::log_warn(format!(
            "[csp] violation: {} blocked {} on {}",
            report["directive"].as_str().unwrap_or(""),
            if blocked.is_empty() {
                "(inline)"
            } else {
                blocked
            },
            report["documentUri"].as_str().unwrap_or("")
        ));
        csp_reports::push(report);
    }
    empty(StatusCode::NO_CONTENT)
}

// ── POST /api/dev/reset-changelog ────────────────────────────────────

fn reset_changelog(cx: &mut Cx, actor: &Actor) -> Response {
    let started_at = cx.now;
    let wiped = transaction(cx, |cx| {
        let snapshots = cx.w.run("DELETE FROM privacy_snapshots", vec![])?;
        // Older installs may not have this table — non-fatal.
        let review_actions = match cx.w.run("DELETE FROM change_review_actions", vec![]) {
            Ok(n) => n,
            Err(e) => {
                diag::log_warn(format!(
                    "[dev/reset-changelog] change_review_actions skipped: {e}"
                ));
                0
            }
        };
        let apps = cx.w.run(RESET_APPS_CHANGE_STATE, vec![])?;
        Ok((snapshots, review_actions, apps))
    });
    let (snapshots_removed, review_actions_removed, apps_touched) = match wiped {
        Ok(counts) => counts,
        Err(e) => {
            diag::log_error(format!("[/api/dev/reset-changelog] failed: {e}"));
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "dev.reset_changelog.failed",
                actor,
                Some(&e),
                false,
            );
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "reset-changelog failed; database left untouched",
            );
        }
    };
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "reset",
        "ok",
        None,
        Some(&format!(
            "Dev reset-changelog — cleared {snapshots_removed} snapshots"
        )),
        Some(&json!({
            "mode": "dev-reset-changelog",
            "snapshotsRemoved": snapshots_removed,
            "reviewActionsRemoved": review_actions_removed,
            "appsTouched": apps_touched,
        })),
        started_at,
    );
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "dev.reset_changelog.success",
        actor,
        Some(&format!(
            "snapshotsRemoved={snapshots_removed} appsTouched={apps_touched}"
        )),
        true,
    );
    json_ok(&json!({
        "ok": true,
        "snapshotsRemoved": snapshots_removed,
        "reviewActionsRemoved": review_actions_removed,
        "appsTouched": apps_touched,
        "durationMs": cx.now - started_at,
    }))
}

// ── POST /api/dev/seed-notification ──────────────────────────────────

/// `isChangeEntry`: an object with string `type` and `description`.
fn is_change_entry(value: &Value) -> bool {
    value.is_object()
        && prop(value, "type").is_some_and(Value::is_string)
        && prop(value, "description").is_some_and(Value::is_string)
}

/// The response, and — once the row is written — what `createNotification`
/// hands its webhook fan-out: the app's name and the first change's
/// description, or a count when that is blank. The fan-out itself is the
/// caller's, because it is a network call and this is a section.
pub(super) fn seed_notification(
    cx: &mut Cx,
    body: BodyOutcome,
    actor: &Actor,
) -> (Response, Option<super::webhook_writes::Immediate>) {
    let body = match bounded_json(body) {
        Ok(v) => v,
        Err(response) => return (response, None),
    };
    let app_id = prop(&body, "appId")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or("");
    let app_name = prop(&body, "appName")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or("");
    if app_id.is_empty() || app_name.is_empty() {
        return (
            json_error(
                StatusCode::BAD_REQUEST,
                "Body must include non-empty `appId` and `appName` strings.",
            ),
            None,
        );
    }
    let changes: Vec<Value> = prop(&body, "changes")
        .and_then(Value::as_array)
        .map(|raw| raw.iter().filter(|c| is_change_entry(c)).cloned().collect())
        .unwrap_or_default();
    if changes.is_empty() {
        return (
            json_error(
                StatusCode::BAD_REQUEST,
                "Body must include at least one ChangeEntry in `changes`.",
            ),
            None,
        );
    }
    // `createNotification`: the row with its quiet-hours deferral, then
    // the retention prune. The webhook fan-out is the caller's, once this
    // section has released the connection.
    let inserted = (|| -> Result<(), String> {
        let not_before = crate::scrape::notify::compute_not_before(cx.w.conn, cx.now);
        let id = cx.ids.uuid(cx.w.conn)?;
        cx.w.run(
            INSERT_NOTIFICATION,
            vec![
                json!(id),
                json!(app_id),
                json!(app_name),
                json!(Value::Array(changes.clone()).to_string()),
                json!(cx.now),
                not_before.map_or(Value::Null, |n| json!(n)),
            ],
        )?;
        crate::scrape::notify::prune_notifications(cx.w);
        Ok(())
    })();
    if let Err(e) = inserted {
        diag::log_error(format!(
            "[/api/dev/seed-notification] createNotification failed: {e}"
        ));
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "dev.seed_notification.failed",
            actor,
            Some(&e),
            false,
        );
        return (
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to write notification",
            ),
            None,
        );
    }
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "dev.seed_notification.success",
        actor,
        Some(&format!("appId={app_id} changes={}", changes.len())),
        true,
    );
    // `changes[0]?.description || "<n> change(s)"`: the first description
    // is the headline, a blank one falls back to the count.
    let headline = match changes[0]["description"].as_str() {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => format!(
            "{} change{}",
            changes.len(),
            if changes.len() == 1 { "" } else { "s" }
        ),
    };
    (
        json_ok(&json!({ "ok": true, "appId": app_id, "appName": app_name, "changes": changes })),
        Some(super::webhook_writes::Immediate {
            app_name: app_name.to_string(),
            headline,
        }),
    )
}

// ── POST /api/dev/wipe-apps ──────────────────────────────────────────

/// One `DELETE FROM` per table, a missing table skipped with a warning.
fn truncate(cx: &mut Cx, label: &str, table: &str) -> usize {
    match cx.w.run(&format!("DELETE FROM {table}"), vec![]) {
        Ok(n) => n,
        Err(e) if e.to_lowercase().contains("no such table") => {
            diag::log_warn(format!(
                "[{label}] table not present in this DB, skipped: {table}"
            ));
            0
        }
        Err(e) => {
            diag::log_warn(format!("[{label}] DELETE FROM {table} skipped: {e}"));
            0
        }
    }
}

fn wipe_apps(cx: &mut Cx, actor: &Actor) -> Response {
    let started_at = cx.now;
    let wiped = transaction(cx, |cx| {
        Ok(APP_DATA_TABLES_TO_TRUNCATE
            .iter()
            .map(|table| truncate(cx, "dev/wipe-apps", table))
            .sum::<usize>())
    });
    let rows_removed = match wiped {
        Ok(n) => n,
        Err(e) => {
            diag::log_error(format!("[/api/dev/wipe-apps] failed: {e}"));
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "dev.wipe_apps.failed",
                actor,
                Some(&e),
                false,
            );
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "wipe-apps failed; database left untouched",
            );
        }
    };
    // Logged AFTER the wipe so the row isn't itself truncated.
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "reset",
        "ok",
        None,
        Some(&format!(
            "Dev wipe-apps — cleared {rows_removed} rows, preserved flags + settings"
        )),
        Some(&json!({ "mode": "dev-wipe-apps", "rowsRemoved": rows_removed })),
        started_at,
    );
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "dev.wipe_apps.success",
        actor,
        Some(&format!("rowsRemoved={rows_removed}")),
        true,
    );
    json_ok(&json!({ "ok": true, "rowsRemoved": rows_removed, "durationMs": cx.now - started_at }))
}

// ── POST /api/reset ──────────────────────────────────────────────────

fn reset(cx: &mut Cx, actor: &Actor) -> Response {
    if cx.get("sync_running", "false") == "true" {
        return json_error(
            StatusCode::CONFLICT,
            "A sync is currently running. Please wait until it finishes.",
        );
    }
    let wiped = transaction(cx, |cx| {
        for table in RESET_TABLES {
            cx.w.run(&format!("DELETE FROM {table}"), vec![])?;
        }
        Ok(())
    });
    match wiped {
        Ok(()) => {
            record_audit(cx.w, cx.ids, cx.now, "reset.success", actor, None, true);
            json_ok(&json!({ "success": true }))
        }
        Err(e) => {
            diag::log_error(format!("Reset API error {e}"));
            record_audit(cx.w, cx.ids, cx.now, "reset.failed", actor, Some(&e), false);
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to reset app data",
            )
        }
    }
}

// ── POST /api/admin/start-over ───────────────────────────────────────

fn start_over(cx: &mut Cx, actor: &Actor) -> Response {
    let started_at = cx.now;
    let wiped = transaction(cx, |cx| {
        for table in APP_DATA_TABLES_TO_TRUNCATE
            .iter()
            .chain(START_OVER_EXTRA_TABLES.iter())
        {
            truncate(cx, "start-over", table);
        }
        // Nothing survives: the preserve list is empty.
        cx.w.run("DELETE FROM app_settings", vec![]).map(drop)
    });
    if let Err(e) = wiped {
        diag::log_error(format!("[/api/admin/start-over] failed: {e}"));
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "admin.start_over.failed",
            actor,
            Some(&e),
            false,
        );
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Start Over failed; database left untouched",
        );
    }
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "reset",
        "ok",
        None,
        Some("Started over — all user data wiped, schema preserved"),
        Some(&json!({ "mode": "start-over" })),
        started_at,
    );
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "admin.start_over.success",
        actor,
        None,
        true,
    );
    json_ok(&json!({ "ok": true, "durationMs": cx.now - started_at }))
}

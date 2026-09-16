//! `requireMutationGuard` from lib/api-guards.ts and `recordAudit` from
//! lib/security.ts: the inbound rate limit first, then the admin token,
//! each refusal leaving an audit row. The actor is the forwarded client
//! address only behind a trusted proxy, else the literal `local`.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use super::{
    auth::{admin_token_configured, request_has_valid_admin_token},
    json::{json_error, json_response},
    ratelimit::{self, RateLimiter},
    trust::is_network_exposed,
};
use crate::{jsstr::js_slice_prefix, scrape::persist::Writer, scrape::Ids};
use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
};
use serde_json::json;

pub const INSERT_AUDIT: &str = "\n      INSERT INTO audit_log (id, created_at, action, actor_ip, user_agent, detail, success)\n      VALUES (?, ?, ?, ?, ?, ?, ?)\n    ";

/// `MutationGuardContext`.
pub struct Actor {
    pub ip: String,
    pub user_agent: Option<String>,
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// `requestActorIp` and the User-Agent read every guard makes.
pub fn actor_from(headers: &HeaderMap) -> Actor {
    Actor {
        ip: ratelimit::actor_ip(
            header(headers, "x-forwarded-for"),
            header(headers, "x-real-ip"),
        ),
        user_agent: header(headers, header::USER_AGENT.as_str()).map(str::to_string),
    }
}

/// `requireAdminToken`: `true` (the default), `false`, or `"configured"`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AdminRule {
    Required,
    NotRequired,
    /// The destructive admin routes of a later batch use this arm.
    #[allow(dead_code)]
    Configured,
}

pub struct GuardOptions {
    pub action: &'static str,
    pub key_prefix: &'static str,
    pub limit: i64,
    pub window_ms: i64,
    pub message: Option<&'static str>,
    pub admin: AdminRule,
}

/// `recordAudit`: the columns are truncated the way the JavaScript
/// `slice` truncates, and a failure is logged rather than raised.
pub fn record_audit(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    action: &str,
    actor: &Actor,
    detail: Option<&str>,
    success: bool,
) {
    let id = match ids.uuid(w.conn) {
        Ok(id) => id,
        Err(e) => {
            super::diag::log_error(format!("[audit] failed to record event {action} {e}"));
            return;
        }
    };
    let params = vec![
        json!(id),
        json!(now),
        json!(js_slice_prefix(action, 120)),
        json!(js_slice_prefix(&actor.ip, 64)),
        json!(js_slice_prefix(
            actor.user_agent.as_deref().unwrap_or(""),
            256
        )),
        json!(js_slice_prefix(detail.unwrap_or(""), 1024)),
        json!(i64::from(success)),
    ];
    if let Err(e) = w.run(INSERT_AUDIT, params) {
        super::diag::log_error(format!("[audit] failed to record event {action} {e}"));
    }
}

/// `requireMutationGuard`. `Err` carries the response the route returns.
pub fn require_mutation_guard(
    w: &mut Writer,
    ids: &mut dyn Ids,
    limiter: &RateLimiter,
    headers: &HeaderMap,
    opts: &GuardOptions,
    now: i64,
) -> Result<Actor, Response> {
    let actor = actor_from(headers);
    let key = ratelimit::key_for_request(
        header(headers, "x-forwarded-for"),
        header(headers, "x-real-ip"),
        opts.key_prefix,
    );
    let rate = limiter.check(&key, opts.limit, opts.window_ms, now);
    if !rate.allowed {
        record_audit(
            w,
            ids,
            now,
            &format!("{}.rate_limited", opts.action),
            &actor,
            Some(&format!("retryAfterMs={}", rate.retry_after_ms)),
            false,
        );
        let mut response = json_response(
            StatusCode::TOO_MANY_REQUESTS,
            &json!({
                "error": opts
                    .message
                    .unwrap_or("Rate limit exceeded. Try again shortly."),
            }),
        );
        // `String(Math.ceil(rate.retryAfterMs / 1000))`.
        let seconds = (rate.retry_after_ms.max(0) + 999) / 1000;
        if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        return Err(response);
    }
    let valid = || {
        request_has_valid_admin_token(
            header(headers, "x-auditor-admin-token"),
            header(headers, header::COOKIE.as_str()),
        )
    };
    match opts.admin {
        AdminRule::Configured => {
            if !admin_token_configured() {
                record_audit(
                    w,
                    ids,
                    now,
                    &format!("{}.admin_token_not_configured", opts.action),
                    &actor,
                    Some("admin token must be configured for this route"),
                    false,
                );
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "Admin token must be configured for this route",
                ));
            }
            if !valid() {
                return Err(unauthorised(w, ids, now, opts.action, &actor));
            }
        }
        AdminRule::Required => {
            if (admin_token_configured() || is_network_exposed()) && !valid() {
                return Err(unauthorised(w, ids, now, opts.action, &actor));
            }
        }
        AdminRule::NotRequired => {}
    }
    Ok(actor)
}

fn unauthorised(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    action: &str,
    actor: &Actor,
) -> Response {
    record_audit(
        w,
        ids,
        now,
        &format!("{action}.unauthorised"),
        actor,
        Some("admin token required but missing or invalid"),
        false,
    );
    json_error(StatusCode::UNAUTHORIZED, "Admin token required")
}

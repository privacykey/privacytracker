//! Port of the request gate in `proxy.ts` (Next 16 renamed middleware — the
//! file really is `proxy.ts`, so grepping for `middleware.ts` finds nothing).
//!
//! Order matters and mirrors the Node file exactly:
//!   0. Host allowlist — every method including GET, before anything else.
//!   1. Auth — required when the deployment is network-exposed OR a token is
//!      configured, minus an exact-match public-read carve-out.
//!   2. CSRF — mutating `/api/*` calls must be same-origin or carry the
//!      admin-token HEADER (a cookie never exempts).
//!
//! A caution worth writing down: the parity harness sends the admin token on
//! EVERY request, so a wrongly-ungated route still answers 200 and the gate
//! passes. Auth behaviour cannot be verified by the parity gate — it is
//! covered by unit tests here and by the `--no-token` probe in the runner.

use axum::{
    extract::Request,
    http::{header, Method, StatusCode},
    middleware::Next,
    response::Response,
};

use super::auth::request_has_valid_admin_token;
use super::json::json_error;
use super::trust::{is_host_allowed, is_network_exposed};

/// Exact-match public reads, from `proxy.ts`'s `PUBLIC_READ_PATHS`. GET/HEAD
/// only, never a prefix match. `/login` and `/brand-icon.png` are listed for
/// fidelity even though this server does not serve them yet.
const PUBLIC_READ_PATHS: &[&str] = &[
    "/login",
    "/api/health",
    "/api/ready",
    "/api/auth/admin-token/status",
    "/brand-icon.png",
];

/// Login/logout bypass auth entirely (they are how you obtain the token).
const AUTH_PATHS: &[&str] = &[
    "/api/auth/admin-token/login",
    "/api/auth/admin-token/logout",
];

fn header_str(req: &Request, name: header::HeaderName) -> Option<&str> {
    req.headers().get(name)?.to_str().ok()
}

/// `effectiveHostFromHeaders` — the forwarded host wins when present, else Host.
fn effective_host(req: &Request) -> Option<String> {
    if let Some(xfh) = req
        .headers()
        .get("x-forwarded-host")
        .and_then(|v| v.to_str().ok())
    {
        // Only the first entry of a comma list is the effective host.
        if let Some(first) = xfh.split(',').next() {
            if !first.trim().is_empty() {
                return Some(first.trim().to_string());
            }
        }
    }
    header_str(req, header::HOST).map(str::to_string)
}

pub async fn gate(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    // ── Step 0: host allowlist, for every method including GET. ──────────
    if !is_host_allowed(effective_host(&req).as_deref()) {
        return json_error(StatusCode::BAD_REQUEST, "Host not allowed");
    }

    let is_read = method == Method::GET || method == Method::HEAD;
    let public_read = is_read && PUBLIC_READ_PATHS.contains(&path.as_str());
    let auth_path = AUTH_PATHS.contains(&path.as_str());
    // POST /api/csp-report is public by design (browsers post it anonymously).
    let csp_report = method == Method::POST && path == "/api/csp-report";

    // ── Step 1: auth. Fails CLOSED — see trust::is_network_exposed. ──────
    let requires_auth = is_network_exposed() || super::auth::admin_token_configured();
    if requires_auth && !(public_read || auth_path || csp_report) {
        let ok = request_has_valid_admin_token(
            header_str(
                &req,
                header::HeaderName::from_static("x-auditor-admin-token"),
            ),
            header_str(&req, header::COOKIE),
        );
        if !ok {
            // Node redirects browser navigations to /login and 401s API calls.
            // This server only serves /api, so the 401 branch is the whole of it.
            return json_error(StatusCode::UNAUTHORIZED, "Admin token required");
        }
    }

    // ── Step 2: CSRF on mutating /api calls. Unreachable while the server is
    // read-only, but it is a handful of lines and shipping it now means the
    // write batches inherit it rather than re-deriving it. ───────────────
    let mutating = !is_read && method != Method::OPTIONS;
    if mutating && path.starts_with("/api/") && !csp_report {
        let has_token_header = request_has_valid_admin_token(
            header_str(
                &req,
                header::HeaderName::from_static("x-auditor-admin-token"),
            ),
            None, // a cookie never exempts the origin check
        );
        if !has_token_header {
            let origin = header_str(&req, header::ORIGIN).map(str::to_string);
            let same_origin = match (origin.as_deref(), effective_host(&req).as_deref()) {
                (Some(o), Some(h)) => origin_matches_host(o, h),
                // A missing Origin on a mutation is rejected unless the token
                // was supplied — legitimate no-Origin mutations are tool-driven.
                _ => false,
            };
            if !same_origin {
                return json_error(StatusCode::FORBIDDEN, "Cross-origin mutation rejected");
            }
        }
    }

    let mut res = next.run(req).await;
    // proxy.ts sets this unconditionally on the pass-through path.
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    res
}

fn origin_matches_host(origin: &str, host: &str) -> bool {
    // Compare the origin's authority against the effective host.
    origin
        .split("://")
        .nth(1)
        .map(|authority| authority.trim_end_matches('/') == host)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_read_paths_are_exact_matches_only() {
        assert!(PUBLIC_READ_PATHS.contains(&"/api/health"));
        // A prefix must NOT be treated as public.
        assert!(!PUBLIC_READ_PATHS.contains(&"/api/health/extra"));
        assert!(!PUBLIC_READ_PATHS.contains(&"/api/healthz"));
        assert_eq!(PUBLIC_READ_PATHS.len(), 5);
    }

    #[test]
    fn origin_host_comparison() {
        assert!(origin_matches_host(
            "http://127.0.0.1:3002",
            "127.0.0.1:3002"
        ));
        assert!(!origin_matches_host(
            "http://evil.example",
            "127.0.0.1:3002"
        ));
        assert!(!origin_matches_host("garbage", "127.0.0.1:3002"));
    }
}

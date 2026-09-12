//! Port of the request gate in `proxy.ts` (Next 16 renamed middleware — the
//! file really is `proxy.ts`, so grepping for `middleware.ts` finds nothing).
//!
//! Order matters and mirrors the Node file exactly:
//!   0.   Host allowlist — every method including GET, before anything else.
//!   0.5. Canonical trailing-slash redirect — a 308 to the slash-free path.
//!   1.   Auth — required when the deployment is network-exposed OR a token is
//!        configured, minus an exact-match public-read carve-out.
//!   2.   CSRF — mutating `/api/*` calls must be same-origin or carry the
//!        admin-token HEADER (a cookie never exempts).
//!
//! Step 0.5 was missing from the first cut of this port, which made
//! `GET /api/health/` a 308 in Node and, here, a 401 — the un-routed path
//! fell through to step 1, so only a deployment with auth off ever saw the
//! 404. Either way it was wrong for every path, the per-app routes included.
//! The parity differ cannot catch it: it only ever requests the canonical
//! paths in its manifest, so `scripts/parity/read-parity.mjs` probes this
//! directly alongside the auth and rate-limiter probes.
//!
//! A caution worth writing down: the parity harness sends the admin token on
//! EVERY request, so a wrongly-ungated route still answers 200 and the gate
//! passes. Auth behaviour cannot be verified by the parity gate — it is
//! covered by unit tests here and by the `--no-token` probe in the runner.

use axum::{
    body::Body,
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
        // proxy.ts does NOT set Cache-Control on this branch — see `no_store`.
        return json_error(StatusCode::BAD_REQUEST, "Host not allowed");
    }

    // ── Step 0.5: canonical trailing-slash redirect. AFTER the host check
    // and BEFORE auth, exactly as in proxy.ts: `/api/health/` from a
    // disallowed Host is still a 400, and `/api/date-format/` with no token
    // is a 308 rather than a 401. ────────────────────────────────────────
    if let Some(res) = canonical_trailing_slash_target(&path, req.uri().query())
        .as_deref()
        .and_then(trailing_slash_redirect)
    {
        return res;
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
            // Unlike the 400 and 403 branches, proxy.ts DOES set no-store here.
            return no_store(json_error(StatusCode::UNAUTHORIZED, "Admin token required"));
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
                // No Cache-Control here either — see `no_store`.
                return json_error(StatusCode::FORBIDDEN, "Cross-origin mutation rejected");
            }
        }
    }

    // proxy.ts sets no-store unconditionally on the pass-through path.
    no_store(next.run(req).await)
}

/// `Cache-Control: no-store`.
///
/// Applied deliberately per branch rather than to every response, because
/// proxy.ts is not uniform: it sets no-store on the 308, the 401 and the
/// pass-through, and leaves the 400 "Host not allowed" and 403 "Cross-origin
/// mutation rejected" branches without it. That asymmetry reads like an
/// oversight, but it is observable on the wire — verified against a running
/// Node server — so the port reproduces it rather than tidying it up.
fn no_store(mut res: Response) -> Response {
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    res
}

/// Step 0.5 of `proxy.ts`: the canonical target for a trailing-slash path, or
/// `None` when the path is already canonical.
///
/// Node's guard is `pathname.length > 1 && pathname.endsWith("/")` and its
/// target is `pathname.replace(/\/+$/, "")` written back through a plain
/// `URL`, so three details fall out of the URL serialiser rather than the
/// regex, and all three are reproduced here:
///
///   - the query rides along (`/a/?x=1` → `/a?x=1`),
///   - an EMPTY query is dropped (`/a/?` → `/a`, no trailing `?`),
///   - an all-slash path collapses to `/`, because assigning an empty
///     pathname to an http `URL` reports `/` back.
fn canonical_trailing_slash_target(path: &str, query: Option<&str>) -> Option<String> {
    if path.len() <= 1 || !path.ends_with('/') {
        return None;
    }
    let stripped = path.trim_end_matches('/');
    let mut target = String::with_capacity(path.len());
    target.push_str(if stripped.is_empty() { "/" } else { stripped });
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        target.push('?');
        target.push_str(q);
    }
    Some(target)
}

/// The 308 itself.
///
/// The Location is RELATIVE (path + query). proxy.ts builds an absolute `URL`,
/// but Next serialises a same-origin middleware redirect back to a path, so
/// `GET /api/health/?x=1` answers `location: /api/health?x=1` on the wire — an
/// absolute Location here would be a visible difference.
///
/// Two Next artefacts on that response are NOT reproduced: it also emits
/// `Refresh: 0;url=<loc>` and echoes the location in the body. Both are
/// Next redirect-serialisation trivia rather than contract, and this server
/// does not emit Next's security-header block either (not yet ported).
///
/// `None` when the target cannot be a header value. Hyper rejects control
/// bytes in the request target long before this, so it is unreachable in
/// practice; falling through to the router beats panicking on a request.
fn trailing_slash_redirect(target: &str) -> Option<Response> {
    let location = header::HeaderValue::from_str(target).ok()?;
    Response::builder()
        .status(StatusCode::PERMANENT_REDIRECT)
        .header(header::LOCATION, location)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .ok()
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
    use axum::{routing::get, Router};
    use tower::ServiceExt;

    /// The gate wired the way `server::app` wires it — as a layer over the
    /// routes, so it runs for the 404 fallback too. Two real routes are
    /// enough: one on the public-read list and one that is auth-gated.
    fn gate_app() -> Router {
        Router::new()
            .route("/api/health", get(|| async { "ok" }))
            .route("/api/date-format", get(|| async { "ok" }))
            .route(
                "/api/auth/admin-token/login",
                axum::routing::post(|| async {}),
            )
            .layer(axum::middleware::from_fn(gate))
    }

    /// A request with no admin token. The gate's env inputs are left alone:
    /// `PRIVACYTRACKER_BIND_HOST` is unset in the test binary, so
    /// `is_network_exposed()` fails closed to true and auth is required
    /// regardless of what the `auth` module's tests do to
    /// `AUDITOR_ADMIN_TOKEN` on another thread.
    async fn send(method: Method, uri: &str, host: &str, origin: Option<&str>) -> Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, host);
        if let Some(o) = origin {
            builder = builder.header(header::ORIGIN, o);
        }
        gate_app()
            .oneshot(builder.body(Body::empty()).expect("request"))
            .await
            .expect("router is infallible")
    }

    async fn get_(uri: &str) -> Response {
        send(Method::GET, uri, "127.0.0.1:3000", None).await
    }

    fn header_of(res: &Response, name: header::HeaderName) -> Option<&str> {
        res.headers().get(name)?.to_str().ok()
    }

    fn location(res: &Response) -> Option<&str> {
        header_of(res, header::LOCATION)
    }

    fn cache_control(res: &Response) -> Option<&str> {
        header_of(res, header::CACHE_CONTROL)
    }

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

    #[test]
    fn canonical_target_mirrors_the_node_url_serialiser() {
        // The `pathname.length > 1` guard: `/` is already canonical.
        assert_eq!(canonical_trailing_slash_target("/", None), None);
        assert_eq!(canonical_trailing_slash_target("/api/health", None), None);
        // The ordinary case.
        assert_eq!(
            canonical_trailing_slash_target("/api/health/", None).as_deref(),
            Some("/api/health")
        );
        // `replace(/\/+$/, "")` strips the whole run, not one slash.
        assert_eq!(
            canonical_trailing_slash_target("/api/health///", None).as_deref(),
            Some("/api/health")
        );
        // An all-slash path: an emptied pathname reports back as `/`.
        assert_eq!(
            canonical_trailing_slash_target("//", None).as_deref(),
            Some("/")
        );
        // The query rides along…
        assert_eq!(
            canonical_trailing_slash_target("/a/", Some("x=1&y=2")).as_deref(),
            Some("/a?x=1&y=2")
        );
        // …but an empty one is dropped, exactly as `URL` serialises it.
        assert_eq!(
            canonical_trailing_slash_target("/a/", Some("")).as_deref(),
            Some("/a")
        );
        // Percent-encoding is carried through untouched.
        assert_eq!(
            canonical_trailing_slash_target("/%20foo/", None).as_deref(),
            Some("/%20foo")
        );
    }

    #[tokio::test]
    async fn trailing_slash_is_a_308_with_a_relative_location() {
        let res = get_("/api/health/").await;
        assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
        // Relative, not absolute: Next serialises the middleware redirect back
        // to a path, so `http://127.0.0.1:3000/api/health` would diverge.
        assert_eq!(location(&res), Some("/api/health"));
        assert_eq!(cache_control(&res), Some("no-store"));
    }

    #[tokio::test]
    async fn trailing_slash_redirect_keeps_the_query() {
        let res = get_("/api/health/?x=1&y=2").await;
        assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(location(&res), Some("/api/health?x=1&y=2"));
    }

    #[tokio::test]
    async fn canonical_paths_are_not_redirected() {
        assert_eq!(get_("/api/health").await.status(), StatusCode::OK);
        // `/` is below the length guard, so it is never redirected. It falls
        // through to step 1 and 401s — Node answers a 307 to /login there,
        // the page branch this API-only server deliberately does not port.
        let root = get_("/").await;
        assert_eq!(root.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(location(&root), None);
    }

    #[tokio::test]
    async fn trailing_slash_redirect_runs_before_the_auth_gate() {
        // The canonical path is gated…
        let gated = get_("/api/date-format").await;
        assert_eq!(gated.status(), StatusCode::UNAUTHORIZED);
        // …but its trailing-slash form still redirects rather than 401ing,
        // because step 0.5 sits above step 1 in proxy.ts.
        let redirected = get_("/api/date-format/").await;
        assert_eq!(redirected.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(location(&redirected), Some("/api/date-format"));
    }

    #[tokio::test]
    async fn trailing_slash_redirect_runs_before_the_csrf_gate() {
        // Auth paths bypass step 1 for any method, so this reaches step 2.
        let blocked = send(
            Method::POST,
            "/api/auth/admin-token/login",
            "127.0.0.1:3000",
            Some("http://evil.example"),
        )
        .await;
        assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
        let redirected = send(
            Method::POST,
            "/api/auth/admin-token/login/",
            "127.0.0.1:3000",
            Some("http://evil.example"),
        )
        .await;
        assert_eq!(redirected.status(), StatusCode::PERMANENT_REDIRECT);
    }

    #[tokio::test]
    async fn host_allowlist_runs_before_the_trailing_slash_redirect() {
        let res = send(Method::GET, "/api/health/", "evil.example", None).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(location(&res), None);
    }

    /// proxy.ts is not uniform about `Cache-Control`, and the differences are
    /// observable. Verified against a running Node server: 400 and 403 carry
    /// no Cache-Control at all, 401 and the pass-through carry `no-store`.
    #[tokio::test]
    async fn cache_control_matches_node_branch_for_branch() {
        let host_rejected = send(Method::GET, "/api/health", "evil.example", None).await;
        assert_eq!(host_rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(cache_control(&host_rejected), None);

        let unauthorised = get_("/api/date-format").await;
        assert_eq!(unauthorised.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(cache_control(&unauthorised), Some("no-store"));

        let cross_origin = send(
            Method::POST,
            "/api/auth/admin-token/login",
            "127.0.0.1:3000",
            Some("http://evil.example"),
        )
        .await;
        assert_eq!(cross_origin.status(), StatusCode::FORBIDDEN);
        assert_eq!(cache_control(&cross_origin), None);

        let passed = get_("/api/health").await;
        assert_eq!(passed.status(), StatusCode::OK);
        assert_eq!(cache_control(&passed), Some("no-store"));
    }
}

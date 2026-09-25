//! Port of the request gate in `proxy.ts` (Next 16 renamed middleware — the
//! file really is `proxy.ts`, so grepping for `middleware.ts` finds nothing).
//!
//! Order matters and mirrors the Node file exactly:
//!   0.   Host allowlist — every method including GET, before anything else.
//!   0.5. Canonical trailing-slash redirect — a 308 to the slash-free path.
//!   1.   Auth — required when the deployment is network-exposed OR a token is
//!        configured, minus an exact-match public-read carve-out. A client
//!        past its budget of wrong tokens gets a 429 before its token is
//!        checked (`token_guard.rs`).
//!   2.   CSRF — mutating `/api/*` calls must be same-origin or carry the
//!        admin-token HEADER (a cookie never exempts).
//!
//! One step has no Node counterpart: 0.75, the desktop app's launch
//! credential (`desktop_auth.rs`). It runs only when the desktop shell
//! passed one, which web and Docker never do, so on those every response
//! is exactly the Node one.
//!
//! Step 0.5 was missing from the first cut of this port, which made
//! `GET /api/health/` a 308 in Node and, here, a 401 — the un-routed path
//! fell through to step 1, so only a deployment with auth off ever saw the
//! 404. Either way it was wrong for every path, the per-app routes included.
//! The parity differ cannot catch it: it only ever requests the canonical
//! paths in its manifest, so `scripts/parity/read-parity.mjs` probes this
//! directly alongside the auth and rate-limiter probes.
//!
//! Steps 0 and 2 share `trust::effective_host`, and the first cut read
//! `X-Forwarded-Host` there unconditionally. Node only believes it behind
//! `PRIVACYTRACKER_TRUST_PROXY`; without that, the header is attacker-
//! controlled and could satisfy the host allowlist or — paired with a
//! matching `Origin` — the CSRF check. The port of `lib/request-origin.cjs`
//! in `trust.rs` now owns both helpers; see its tests for the contract.
//!
//! A caution worth writing down: the parity harness sends the admin token on
//! EVERY request, so a wrongly-ungated route still answers 200 and the gate
//! passes. Auth behaviour cannot be verified by the parity gate — it is
//! covered by unit tests here and by the `--no-token` probe in the runner.
//!
//! Phase 6, batch 3a, when the server started serving the pages: the
//! matcher (`matcher_covers`: static assets skip every step), the page
//! branch of step 1 (a 307 to `/login` rather than a 401), the CSP on every
//! response the proxy handles, and Next's own `Cache-Control` winning over
//! `no-store` where Next sets one after the proxy (`KeepCacheControl`).

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderMap, Method, StatusCode},
    middleware::Next,
    response::Response,
};

use super::auth::request_has_valid_admin_token;
use super::json::json_error;
use super::token_guard;
use super::trust::{
    effective_host, is_host_allowed, is_network_exposed, is_same_origin_request, request_origin,
    trust_proxy,
};

/// Exact-match public reads, from `proxy.ts`'s `PUBLIC_READ_PATHS`. GET/HEAD
/// only, never a prefix match.
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

/// `proxy.ts`'s matcher, `/((?!_next/static|_next/image|favicon.ico|fonts/|preview-icon-).*)`:
/// every path except the static assets, which Next serves without ever
/// running the proxy (no host check, no auth, no CSP, no `no-store`).
/// Case-sensitive, and the `.` in `favicon.ico` is the regex's any-char.
pub(crate) fn matcher_covers(path: &str) -> bool {
    let rest = path.strip_prefix('/').unwrap_or(path);
    let favicon = rest.starts_with("favicon") && rest.get(8..11) == Some("ico");
    !(rest.starts_with("_next/static")
        || rest.starts_with("_next/image")
        || favicon
        || rest.starts_with("fonts/")
        || rest.starts_with("preview-icon-"))
}

/// `attachSecurityHeaders`' Content-Security-Policy (the five static
/// headers are the outer layer's, as next.config's `headers()` sets them on
/// every response).
fn with_csp(mut res: Response, pathname: &str) -> Response {
    if let Some((name, value)) = super::csp_policy::header(pathname) {
        res.headers_mut().insert(name, value);
    }
    res
}

/// Where a page navigation without the token goes:
/// `new URL("/login", requestOrigin(request) ?? request.url)`, which Next
/// writes back as a path when it names the request's own origin.
fn login_location(headers: &HeaderMap, trust: bool) -> String {
    match request_origin(headers, trust) {
        Some(origin) if Some(&origin) != request_origin(headers, false).as_ref() => {
            format!("{origin}/login")
        }
        _ => "/login".into(),
    }
}

/// A middleware redirect as Next serialises it: the location, echoed as
/// the body, and for a 308 a `Refresh` header too.
fn redirect(status: StatusCode, location: &str) -> Option<Response> {
    let value = header::HeaderValue::from_str(location).ok()?;
    let mut builder = Response::builder()
        .status(status)
        .header(header::LOCATION, value.clone())
        .header(header::CACHE_CONTROL, "no-store");
    if status == StatusCode::PERMANENT_REDIRECT {
        builder = builder.header("refresh", format!("0;url={location}"));
    }
    builder.body(Body::from(location.to_string())).ok()
}

/// `request.nextUrl.pathname`: a `/_next/data/<build id>/<page>.json` URL
/// reads as the page it asks for (`getNextPathnameInfo` with `parseData`).
fn next_url_pathname(path: &str) -> String {
    if let Some(data) = path
        .strip_prefix("/_next/data/")
        .and_then(|rest| rest.strip_suffix(".json"))
    {
        let parts: Vec<&str> = data.split('/').collect();
        return if parts.get(1) == Some(&"index") {
            "/".into()
        } else {
            format!("/{}", parts[1..].join("/"))
        };
    }
    path.to_string()
}

pub async fn gate(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    if !matcher_covers(req.uri().path()) {
        return next.run(req).await;
    }
    let path = next_url_pathname(req.uri().path());
    // Read once and threaded through: Node calls `trustProxy()` inside each
    // helper, but the env cannot change within a request.
    let trust = trust_proxy();

    // ── Step 0: host allowlist, for every method including GET. ──────────
    if !is_host_allowed(effective_host(req.headers(), trust).as_deref()) {
        // proxy.ts does NOT set Cache-Control on this branch — see `no_store`.
        return with_csp(
            json_error(StatusCode::BAD_REQUEST, "Host not allowed"),
            &path,
        );
    }

    // ── Step 0.5: canonical trailing-slash redirect. AFTER the host check
    // and BEFORE auth, exactly as in proxy.ts: `/api/health/` from a
    // disallowed Host is still a 400, and `/api/date-format/` with no token
    // is a 308 rather than a 401. The CSP is the canonical page's. ───────
    if let Some(target) = canonical_trailing_slash_target(&path, req.uri().query()) {
        if let Some(res) = trailing_slash_redirect(&target) {
            let canonical = target.split('?').next().unwrap_or("/");
            return with_csp(res, canonical);
        }
    }

    // ── Step 0.75 (desktop app only): the launch credential. Every /api
    // call needs it, the public reads and the login routes included; the
    // one-time link that hands the webview its cookie is answered here. ──
    let desktop_credential = super::desktop_auth::configured();
    if let Some(credential) = desktop_credential.as_deref() {
        if let Some(res) =
            desktop_step(&method, &path, req.uri().query(), req.headers(), credential)
        {
            return with_csp(res, &path);
        }
    }

    let is_read = method == Method::GET || method == Method::HEAD;
    let public_read = is_read && PUBLIC_READ_PATHS.contains(&path.as_str());
    let auth_path = AUTH_PATHS.contains(&path.as_str());
    // POST /api/csp-report is public by design (browsers post it anonymously).
    let csp_report = method == Method::POST && path == "/api/csp-report";

    // ── Step 1: auth. Fails CLOSED — see trust::is_network_exposed. ──────
    let requires_auth = is_network_exposed() || super::auth::admin_token_configured();
    if requires_auth && !(public_read || auth_path || csp_report) {
        // A client past its budget of wrong tokens is refused before its
        // token is looked at (token_guard.rs); every other check counts.
        let check = token_guard::check_attempt(req.headers(), super::now_ms());
        if let token_guard::Check::Throttled(retry_after_ms) = check {
            let mut res = no_store(json_error(
                StatusCode::TOO_MANY_REQUESTS,
                token_guard::TOO_MANY_FAILURES,
            ));
            let seconds = (retry_after_ms.max(0) + 999) / 1000;
            if let Ok(value) = header::HeaderValue::from_str(&seconds.to_string()) {
                res.headers_mut().insert(header::RETRY_AFTER, value);
            }
            return with_csp(res, &path);
        }
        if check != token_guard::Check::Valid {
            // Node 401s API calls and sends page navigations to /login.
            // Unlike the 400 and 403 branches, proxy.ts DOES set no-store here.
            let res = if path.starts_with("/api/") {
                no_store(json_error(StatusCode::UNAUTHORIZED, "Admin token required"))
            } else {
                let location = login_location(req.headers(), trust);
                match redirect(StatusCode::TEMPORARY_REDIRECT, &location) {
                    Some(res) => res,
                    None => no_store(json_error(StatusCode::UNAUTHORIZED, "Admin token required")),
                }
            };
            return with_csp(res, &path);
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
        ) || desktop_credential.as_deref().is_some_and(|credential| {
            // Nor does the desktop session cookie: only its header form.
            super::desktop_auth::header_presented(req.headers(), credential)
        });
        // A missing Origin on a mutation is rejected unless the token was
        // supplied — legitimate no-Origin mutations are tool-driven.
        if !(has_token_header || is_same_origin_request(req.headers(), trust)) {
            // No Cache-Control here either — see `no_store`.
            return with_csp(
                json_error(StatusCode::FORBIDDEN, "Cross-origin mutation rejected"),
                &path,
            );
        }
    }

    // proxy.ts sets no-store on the pass-through path; Next's own
    // Cache-Control (a 404's, a failed static send's) replaces it after.
    let res = next.run(req).await;
    let res = if res
        .extensions()
        .get::<super::site::KeepCacheControl>()
        .is_some()
    {
        res
    } else {
        no_store(res)
    };
    with_csp(res, &path)
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

/// Step 0.75, for a server the desktop shell gave a launch credential:
/// `None` to carry on through the gate, or the response that ends it.
fn desktop_step(
    method: &Method,
    path: &str,
    query: Option<&str>,
    headers: &HeaderMap,
    credential: &str,
) -> Option<Response> {
    use super::desktop_auth::{decide, nonces, Decision};
    match decide(
        method,
        path,
        query,
        headers,
        credential,
        nonces(),
        std::time::Instant::now(),
    ) {
        Decision::Pass => None,
        Decision::Refused => Some(no_store(json_error(
            StatusCode::UNAUTHORIZED,
            "Desktop credential required",
        ))),
        Decision::LinkRefused => Some(no_store(json_error(
            StatusCode::FORBIDDEN,
            "Desktop sign-in link expired or already used",
        ))),
        Decision::SignedIn { set_cookie } => {
            // Both values are ASCII this module wrote (the credential is
            // hex), so neither can fail; if one ever did, the link ends in
            // a refusal rather than falling through to the router.
            let signed_in = redirect(StatusCode::SEE_OTHER, "/").and_then(|mut res| {
                if let Some(cookie) = set_cookie {
                    let value = header::HeaderValue::from_str(&cookie).ok()?;
                    res.headers_mut().insert(header::SET_COOKIE, value);
                }
                Some(res)
            });
            Some(signed_in.unwrap_or_else(|| {
                no_store(json_error(
                    StatusCode::FORBIDDEN,
                    "Desktop sign-in link expired or already used",
                ))
            }))
        }
    }
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
/// Next serialises it the way it serialises every middleware redirect:
/// `Refresh: 0;url=<loc>` beside the Location and the location echoed as
/// the body (see `redirect`). Since Phase 6, batch 3a both are reproduced,
/// with the security headers and the canonical page's CSP.
///
/// `None` when the target cannot be a header value. Hyper rejects control
/// bytes in the request target long before this, so it is unreachable in
/// practice; falling through to the router beats panicking on a request.
fn trailing_slash_redirect(target: &str) -> Option<Response> {
    redirect(StatusCode::PERMANENT_REDIRECT, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use tower::ServiceExt;

    /// The gate wired the way `server::app` wires it — as a layer over the
    /// routes, so it runs for the 404 fallback too. Three real routes: one
    /// on the public-read list, one auth-gated, and the login path (which
    /// bypasses auth for any method, so a POST to it reaches the CSRF step).
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

    /// Run one gate scenario under the env lock. The gate reads the process
    /// environment on every request, and these tests rely on
    /// `PRIVACYTRACKER_BIND_HOST` being UNSET — `is_network_exposed()` then
    /// fails closed to true, so auth is required whatever the `auth`
    /// module's tests do to `AUDITOR_ADMIN_TOKEN`. That held only while
    /// nothing else set the bind host. The write-route replays do, to
    /// loopback, with the admin token cleared, for as long as they run —
    /// under this same lock — and a gate test that overlapped one saw a
    /// loopback server needing no token and got a 200 where it expected a
    /// 401. Every replay removes what it set before releasing the lock, so
    /// holding it here is what makes "unset" true. A plain `#[test]` driving
    /// a current-thread runtime, rather than `#[tokio::test]`, so the lock is
    /// held by the synchronous frame and never across an `.await`.
    fn scenario(f: impl std::future::Future<Output = ()>) {
        let _env = super::super::trust::env_lock();
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
            .block_on(f);
    }

    /// A request with no admin token. Call it inside [`scenario`].
    async fn send(method: Method, uri: &str, headers: &[(&str, &str)]) -> Response {
        let mut builder = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        gate_app()
            .oneshot(builder.body(Body::empty()).expect("request"))
            .await
            .expect("router is infallible")
    }

    const LOOPBACK: &str = "127.0.0.1:3000";

    async fn get_(uri: &str) -> Response {
        send(Method::GET, uri, &[("host", LOOPBACK)]).await
    }

    async fn post_login(headers: &[(&str, &str)]) -> Response {
        send(Method::POST, "/api/auth/admin-token/login", headers).await
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

    #[test]
    fn trailing_slash_is_a_308_with_a_relative_location() {
        scenario(async {
            let res = get_("/api/health/").await;
            assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
            // Relative, not absolute: Next serialises the middleware redirect back
            // to a path, so `http://127.0.0.1:3000/api/health` would diverge.
            assert_eq!(location(&res), Some("/api/health"));
            assert_eq!(cache_control(&res), Some("no-store"));
        });
    }

    #[test]
    fn trailing_slash_redirect_keeps_the_query() {
        scenario(async {
            let res = get_("/api/health/?x=1&y=2").await;
            assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
            assert_eq!(location(&res), Some("/api/health?x=1&y=2"));
        });
    }

    #[test]
    fn canonical_paths_are_not_redirected() {
        scenario(async {
            assert_eq!(get_("/api/health").await.status(), StatusCode::OK);
            // `/` is below the length guard, so it is never redirected. It falls
            // through to step 1, and a page navigation without the token goes
            // to /login (Phase 6, batch 3a), as in Node.
            let root = get_("/").await;
            assert_eq!(root.status(), StatusCode::TEMPORARY_REDIRECT);
            assert_eq!(location(&root), Some("/login"));
            assert_eq!(cache_control(&root), Some("no-store"));
        });
    }

    #[test]
    fn trailing_slash_redirect_runs_before_the_auth_gate() {
        scenario(async {
            // The canonical path is gated…
            let gated = get_("/api/date-format").await;
            assert_eq!(gated.status(), StatusCode::UNAUTHORIZED);
            // …but its trailing-slash form still redirects rather than 401ing,
            // because step 0.5 sits above step 1 in proxy.ts.
            let redirected = get_("/api/date-format/").await;
            assert_eq!(redirected.status(), StatusCode::PERMANENT_REDIRECT);
            assert_eq!(location(&redirected), Some("/api/date-format"));
        });
    }

    #[test]
    fn trailing_slash_redirect_runs_before_the_csrf_gate() {
        scenario(async {
            let cross = [("host", LOOPBACK), ("origin", "http://evil.example")];
            let blocked = post_login(&cross).await;
            assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
            let redirected = send(Method::POST, "/api/auth/admin-token/login/", &cross).await;
            assert_eq!(redirected.status(), StatusCode::PERMANENT_REDIRECT);
        });
    }

    #[test]
    fn host_allowlist_runs_before_the_trailing_slash_redirect() {
        scenario(async {
            let res = send(Method::GET, "/api/health/", &[("host", "evil.example")]).await;
            assert_eq!(res.status(), StatusCode::BAD_REQUEST);
            assert_eq!(location(&res), None);
        });
    }

    /// proxy.ts is not uniform about `Cache-Control`, and the differences are
    /// observable. Verified against a running Node server: 400 and 403 carry
    /// no Cache-Control at all, 401 and the pass-through carry `no-store`.
    #[test]
    fn cache_control_matches_node_branch_for_branch() {
        scenario(async {
            let host_rejected = send(Method::GET, "/api/health", &[("host", "evil.example")]).await;
            assert_eq!(host_rejected.status(), StatusCode::BAD_REQUEST);
            assert_eq!(cache_control(&host_rejected), None);

            let unauthorised = get_("/api/date-format").await;
            assert_eq!(unauthorised.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(cache_control(&unauthorised), Some("no-store"));

            let cross_origin =
                post_login(&[("host", LOOPBACK), ("origin", "http://evil.example")]).await;
            assert_eq!(cross_origin.status(), StatusCode::FORBIDDEN);
            assert_eq!(cache_control(&cross_origin), None);

            let passed = get_("/api/health").await;
            assert_eq!(passed.status(), StatusCode::OK);
            assert_eq!(cache_control(&passed), Some("no-store"));
        });
    }

    /// Every outcome here was verified against a running Node server: the
    /// exact origin reaches the route, and each of the others is a 403.
    #[test]
    fn csrf_origin_comparison_is_scheme_and_serialisation_exact() {
        scenario(async {
            let exact =
                post_login(&[("host", LOOPBACK), ("origin", "http://127.0.0.1:3000")]).await;
            assert_eq!(exact.status(), StatusCode::OK);
            for origin in [
                "https://127.0.0.1:3000", // scheme
                "http://127.0.0.1:3000/", // not the canonical serialisation
                "HTTP://127.0.0.1:3000",
                "http://127.0.0.1", // a different port
                "null",
            ] {
                let res = post_login(&[("host", LOOPBACK), ("origin", origin)]).await;
                assert_eq!(res.status(), StatusCode::FORBIDDEN, "{origin}");
            }
            // The expected side is normalised: an uppercase Host still matches.
            let upper = post_login(&[
                ("host", "LOCALHOST:3000"),
                ("origin", "http://localhost:3000"),
            ])
            .await;
            assert_eq!(upper.status(), StatusCode::OK);
        });
    }

    /// The guess budget (token_guard.rs) as the gate applies it: past ten
    /// distinct wrong tokens a client's token-bearing request is a 429
    /// before its token is checked, a token-less one is still a 401, and
    /// another client is untouched.
    #[test]
    fn a_client_past_its_guess_budget_gets_a_429_before_its_token_is_checked() {
        scenario(async {
            std::env::set_var("AUDITOR_ADMIN_TOKEN", "gate-token");
            token_guard::reset();
            let from = |peer: &'static str, token: String| async move {
                send(
                    Method::GET,
                    "/api/date-format",
                    &[
                        ("host", LOOPBACK),
                        (token_guard::PEER_HEADER, peer),
                        ("x-auditor-admin-token", &token),
                    ],
                )
                .await
            };
            for i in 0..token_guard::PER_CLIENT_FAILURE_LIMIT {
                let res = from("10.9.9.9", format!("guess-{i}")).await;
                assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
            }
            let refused = from("10.9.9.9", "gate-token".into()).await;
            assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(header_of(&refused, header::RETRY_AFTER), Some("900"));
            assert_eq!(cache_control(&refused), Some("no-store"));
            let bare = send(
                Method::GET,
                "/api/date-format",
                &[("host", LOOPBACK), (token_guard::PEER_HEADER, "10.9.9.9")],
            )
            .await;
            assert_eq!(bare.status(), StatusCode::UNAUTHORIZED);
            let other = from("10.9.9.8", "gate-token".into()).await;
            assert_eq!(other.status(), StatusCode::OK);
            token_guard::reset();
            std::env::remove_var("AUDITOR_ADMIN_TOKEN");
        });
    }

    /// The bypass the first cut had. It needs `PRIVACYTRACKER_TRUST_PROXY`
    /// unset for its whole duration, which the env lock guarantees.
    #[test]
    fn forwarded_host_is_untrusted_by_default() {
        scenario(async {
            // A forged forwarded host cannot rescue a disallowed real Host…
            let spoofed = send(
                Method::GET,
                "/api/health",
                &[("host", "evil.example"), ("x-forwarded-host", LOOPBACK)],
            )
            .await;
            assert_eq!(spoofed.status(), StatusCode::BAD_REQUEST);
            // …and cannot poison an allowed one.
            let real = send(
                Method::GET,
                "/api/health",
                &[("host", LOOPBACK), ("x-forwarded-host", "evil.example")],
            )
            .await;
            assert_eq!(real.status(), StatusCode::OK);
            // Step 2 reads the same helper: a forged forwarded host paired
            // with a matching Origin must not pass as same-origin.
            let csrf = post_login(&[
                ("host", LOOPBACK),
                ("x-forwarded-host", "evil.example"),
                ("origin", "http://evil.example"),
            ])
            .await;
            assert_eq!(csrf.status(), StatusCode::FORBIDDEN);
        });
    }

    // ── Step 0.75: the desktop launch credential ─────────────────────

    use super::super::desktop_auth::{
        bootstrap_path, issue_bootstrap_nonce, set_test_credential, CREDENTIAL_HEADER,
        SESSION_COOKIE,
    };

    const DESKTOP: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    /// Puts this thread's gate in desktop mode for as long as it lives, and
    /// takes it out again even when an assertion fails.
    struct DesktopMode;

    impl DesktopMode {
        fn on() -> Self {
            set_test_credential(Some(DESKTOP));
            Self
        }
    }

    impl Drop for DesktopMode {
        fn drop(&mut self) {
            set_test_credential(None);
        }
    }

    async fn body_of(res: Response) -> String {
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .expect("body");
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn session(value: &str) -> String {
        format!("{SESSION_COOKIE}={value}")
    }

    /// These scenarios leave `PRIVACYTRACKER_BIND_HOST` unset, as every
    /// test here does, so step 1 still demands the admin token where it
    /// would. That keeps them independent of what other tests do to the
    /// admin token, and shows the desktop step adding to step 1, never
    /// replacing it: `/api/health` is a public read there, so anything
    /// refusing it below is the desktop step.
    #[test]
    fn desktop_mode_refuses_the_api_without_the_credential() {
        scenario(async {
            let _desktop = DesktopMode::on();
            let anonymous = get_("/api/health").await;
            assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(cache_control(&anonymous), Some("no-store"));
            assert!(body_of(anonymous)
                .await
                .contains("Desktop credential required"));

            let wrong = "0".repeat(DESKTOP.len());
            let short = &DESKTOP[..DESKTOP.len() - 1];
            let wrong_cookie = session(&wrong);
            let admin_cookie = format!("pt_admin_token={DESKTOP}");
            for headers in [
                [("host", LOOPBACK), (CREDENTIAL_HEADER, wrong.as_str())],
                [("host", LOOPBACK), (CREDENTIAL_HEADER, short)],
                [("host", LOOPBACK), ("x-auditor-admin-token", DESKTOP)],
                [("host", LOOPBACK), ("cookie", wrong_cookie.as_str())],
                [("host", LOOPBACK), ("cookie", admin_cookie.as_str())],
            ] {
                let res = send(Method::GET, "/api/health", &headers).await;
                assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{headers:?}");
            }
        });
    }

    #[test]
    fn desktop_mode_accepts_the_header_or_the_cookie() {
        scenario(async {
            let _desktop = DesktopMode::on();
            let by_header = send(
                Method::GET,
                "/api/health",
                &[("host", LOOPBACK), (CREDENTIAL_HEADER, DESKTOP)],
            )
            .await;
            assert_eq!(by_header.status(), StatusCode::OK);
            let by_cookie = send(
                Method::GET,
                "/api/health",
                &[("host", LOOPBACK), ("cookie", &session(DESKTOP))],
            )
            .await;
            assert_eq!(by_cookie.status(), StatusCode::OK);
        });
    }

    #[test]
    fn desktop_mode_leaves_the_pages_to_the_rest_of_the_gate() {
        scenario(async {
            let _desktop = DesktopMode::on();
            // Exactly what the same request gets without desktop mode (see
            // `canonical_paths_are_not_redirected`): step 1's redirect, not
            // the desktop step's 401.
            let root = get_("/").await;
            assert_eq!(root.status(), StatusCode::TEMPORARY_REDIRECT);
            assert_eq!(location(&root), Some("/login"));
        });
    }

    /// A matching Origin no longer admits a mutation on its own, and the
    /// cookie still never stands in for one.
    #[test]
    fn desktop_mode_mutations_need_the_credential_and_the_origin_rule_still_holds() {
        scenario(async {
            let _desktop = DesktopMode::on();
            let same_origin = ("origin", "http://127.0.0.1:3000");
            let cookie = session(DESKTOP);

            let forged = post_login(&[("host", LOOPBACK), same_origin]).await;
            assert_eq!(forged.status(), StatusCode::UNAUTHORIZED);

            let tool = post_login(&[("host", LOOPBACK), (CREDENTIAL_HEADER, DESKTOP)]).await;
            assert_eq!(
                tool.status(),
                StatusCode::OK,
                "the header stands in for the Origin"
            );

            let cookie_only = post_login(&[("host", LOOPBACK), ("cookie", &cookie)]).await;
            assert_eq!(cookie_only.status(), StatusCode::FORBIDDEN);

            let cross = post_login(&[
                ("host", LOOPBACK),
                ("cookie", &cookie),
                ("origin", "http://evil.example"),
            ])
            .await;
            assert_eq!(cross.status(), StatusCode::FORBIDDEN);

            let webview = post_login(&[("host", LOOPBACK), ("cookie", &cookie), same_origin]).await;
            assert_eq!(webview.status(), StatusCode::OK);
        });
    }

    #[test]
    fn the_one_time_link_signs_the_window_in_once() {
        scenario(async {
            let _desktop = DesktopMode::on();
            let link = bootstrap_path(&issue_bootstrap_nonce().expect("nonce"));

            let signed_in = get_(&link).await;
            assert_eq!(signed_in.status(), StatusCode::SEE_OTHER);
            assert_eq!(location(&signed_in), Some("/"));
            assert_eq!(cache_control(&signed_in), Some("no-store"));
            let set_cookie = header_of(&signed_in, header::SET_COOKIE)
                .expect("the link sets the session cookie")
                .to_string();
            assert!(set_cookie.starts_with(&session(DESKTOP)), "{set_cookie}");
            assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Strict"));

            // The cookie the link set is what the window's API calls carry.
            let cookie = set_cookie.split(';').next().expect("name=value");
            let read = send(
                Method::GET,
                "/api/health",
                &[("host", LOOPBACK), ("cookie", cookie)],
            )
            .await;
            assert_eq!(read.status(), StatusCode::OK);

            let again = get_(&link).await;
            assert_eq!(again.status(), StatusCode::FORBIDDEN, "single use");
            assert_eq!(header_of(&again, header::SET_COOKIE), None);

            // A window that already holds the cookie is simply sent on.
            let reload = send(
                Method::GET,
                &link,
                &[("host", LOOPBACK), ("cookie", cookie)],
            )
            .await;
            assert_eq!(reload.status(), StatusCode::SEE_OTHER);
            assert_eq!(header_of(&reload, header::SET_COOKIE), None);

            // The host allowlist still runs first.
            let fresh = bootstrap_path(&issue_bootstrap_nonce().expect("nonce"));
            let rebound = send(Method::GET, &fresh, &[("host", "evil.example")]).await;
            assert_eq!(rebound.status(), StatusCode::BAD_REQUEST);
        });
    }

    /// Web and Docker never pass a credential: the link is then just an
    /// unknown API path, answered by the rest of the gate as any other.
    #[test]
    fn without_a_credential_the_link_is_not_answered() {
        scenario(async {
            let link = bootstrap_path(&issue_bootstrap_nonce().expect("nonce"));
            let res = get_(&link).await;
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(header_of(&res, header::SET_COOKIE), None);
            assert!(body_of(res).await.contains("Admin token required"));
            assert_eq!(get_("/api/health").await.status(), StatusCode::OK);
        });
    }
}

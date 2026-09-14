//! Request timing — the `http` section of the runtime envelope.
//!
//! Node's `withApiTiming` is opt-in per route: six handlers wrap it
//! (`/api/apps`, `/api/scrape`, four under `/api/imports`), so its ring
//! only ever holds those. Here one layer covers every routed request,
//! added INSIDE the gate so that — as in Node — a request the gate refuses
//! (401/403/400/308) never reaches the ring.
//!
//! **An unmatched path is not recorded**, which is both what Node does
//! (its 404s come from Next, not from a wrapped handler) and the safe
//! choice: without a `MatchedPath` the only available label is the raw
//! request path, a client-chosen string that would then be echoed by
//! `/api/diagnostics/runtime` and embedded in the `/api/desktop/diagnostics`
//! blob whose own docs say it gets pasted into GitHub issues. Recorded
//! labels are therefore always route PATTERNS (`/api/apps/{id}/detail`).

use std::time::Instant;

use axum::{
    extract::{MatchedPath, Request},
    middleware::Next,
    response::Response,
};

use super::diag;

/// Decrements the in-flight gauge however the future ends — returned,
/// panicked, or dropped mid-poll on a client disconnect.
struct InFlightGuard;

impl InFlightGuard {
    fn enter() -> Self {
        diag::http_in_flight_enter();
        InFlightGuard
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        diag::http_in_flight_exit();
    }
}

pub async fn http_timing(req: Request, next: Next) -> Response {
    let Some(route) = req
        .extensions()
        .get::<MatchedPath>()
        .map(|m| m.as_str().to_string())
    else {
        // The 404 fallback — see the module docs.
        return next.run(req).await;
    };
    let method = req.method().to_string();
    let _in_flight = InFlightGuard::enter();
    let started = Instant::now();
    let res = next.run(req).await;
    diag::record_http(method, route, res.status().as_u16(), started.elapsed());
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::StatusCode, routing::get, Router};
    use tower::ServiceExt;

    /// The layer as `server::app` wires it: over the routes, so the matched
    /// path is available, and under the gate, which is not in this test.
    fn timed_app() -> Router {
        Router::new()
            .route("/api/apps/{id}/detail", get(|| async { "ok" }))
            .route(
                "/api/boom",
                get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
            )
            .layer(axum::middleware::from_fn(http_timing))
    }

    async fn send(uri: &str) -> StatusCode {
        timed_app()
            .oneshot(
                axum::http::Request::builder()
                    .uri(uri)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("router is infallible")
            .status()
    }

    #[tokio::test]
    async fn records_the_matched_pattern_and_skips_the_404_fallback() {
        diag::clear_http();

        // A 500 is always recorded, and the label is the PATTERN — not
        // `/api/apps/94961186/detail`.
        assert_eq!(send("/api/boom").await, StatusCode::INTERNAL_SERVER_ERROR);
        let s = diag::http_snapshot(200);
        assert_eq!(s.total_since_start, 1);
        assert_eq!(s.recent[0].route, "/api/boom");
        assert_eq!(s.recent[0].status, 500);

        assert_eq!(send("/api/apps/94961186/detail").await, StatusCode::OK);
        assert!(
            !diag::http_snapshot(200)
                .recent
                .iter()
                .any(|r| r.route.contains("94961186")),
            "a concrete id must never reach the ring"
        );

        // An unmatched path: answered, never recorded, and its raw text
        // never stored.
        assert_eq!(
            send("/api/../secret-token-in-a-path").await,
            StatusCode::NOT_FOUND
        );
        let s = diag::http_snapshot(200);
        assert!(
            !s.recent.iter().any(|r| r.route.contains("secret-token")),
            "unmatched paths are not recorded: {:?}",
            s.recent
        );
        assert_eq!(s.total_since_start, 1, "only the 500 was recorded");

        // The gauge returns to where it started.
        assert_eq!(s.in_flight, 0);
        diag::clear_http();
    }
}

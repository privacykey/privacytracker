//! What `next start` does to a request before any route handler sees it —
//! and therefore part of what this server replaces.
//!
//! Next's `base-server.js` fills four headers when they are absent:
//!
//! ```text
//! req.headers['x-forwarded-host']  ??= req.headers['host'] ?? this.hostname
//! req.headers['x-forwarded-port']  ??= this.port.toString()
//! req.headers['x-forwarded-proto'] ??= isHttps ? 'https' : 'http'
//! req.headers['x-forwarded-for']   ??= socket.remoteAddress
//! ```
//!
//! `x-real-ip` is NOT among them. The consequence, verified against the
//! running Node server: `inferDeploymentNetwork` in
//! `lib/deployment-diagnostics.ts` reports `proxyDetected: true`,
//! `forwardedHost` equal to the Host header and `protocol: "http"` on every
//! direct request — its "Proxy detection" check can never say "no proxy
//! headers seen" under `next start`. A Rust server that left the headers
//! alone would answer `/api/ready` and `/api/deployment/diagnostics`
//! differently on every request, for reasons that are Next's, not the
//! app's. So the synthesis is reproduced here, as an outermost layer.
//!
//! It is safe to run BEFORE the gate: every synthesised value equals what
//! the gate would otherwise derive (the Host header, the real scheme, the
//! peer address), and the gate reads `X-Forwarded-Host` only under
//! `PRIVACYTRACKER_TRUST_PROXY` — where it then equals Host anyway. A
//! caller-supplied header is kept untouched, exactly as `??=` keeps it.
//!
//! One header is this server's own: `x-privacytracker-peer`, the socket
//! peer the admin-token guess limits count failures against. A copy the
//! client sent is always removed before it is written.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderValue},
    middleware::Next,
    response::Response,
};

use super::AppState;

pub async fn inject(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("127.0.0.1"));
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string());

    let headers = req.headers_mut();
    // The socket peer, for the admin-token guess limits (token_guard.rs),
    // as Node's request preloader stamps it: any copy the client sent is
    // removed first, so only this layer ever writes it.
    headers.remove(super::token_guard::PEER_HEADER);
    if let Some(v) = peer.as_deref().and_then(|p| HeaderValue::from_str(p).ok()) {
        headers.insert(super::token_guard::PEER_HEADER, v);
    }
    if !headers.contains_key("x-forwarded-host") {
        headers.insert("x-forwarded-host", host);
    }
    if !headers.contains_key("x-forwarded-port") {
        if let Ok(v) = HeaderValue::from_str(&state.bound_port.to_string()) {
            headers.insert("x-forwarded-port", v);
        }
    }
    if !headers.contains_key("x-forwarded-proto") {
        // This server never terminates TLS itself.
        headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));
    }
    if !headers.contains_key("x-forwarded-for") {
        if let Some(v) = peer.and_then(|p| HeaderValue::from_str(&p).ok()) {
            headers.insert("x-forwarded-for", v);
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::HeaderMap, routing::get, Router};
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    /// What a handler behind `inject` sees as the peer header.
    async fn peer_seen(connect: Option<SocketAddr>, sent: Option<&str>) -> Option<String> {
        let state = AppState {
            conn: Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap())),
            rate_limiter: Arc::new(super::super::ratelimit::RateLimiter::new()),
            started_at: std::time::Instant::now(),
            bound_port: 3000,
        };
        let app = Router::new()
            .route(
                "/",
                get(|headers: HeaderMap| async move {
                    headers
                        .get(super::super::token_guard::PEER_HEADER)
                        .map(|v| v.to_str().unwrap().to_string())
                        .unwrap_or_default()
                }),
            )
            .layer(axum::middleware::from_fn_with_state(state.clone(), inject))
            .with_state(state);
        let mut builder = axum::http::Request::builder().uri("/");
        if let Some(value) = sent {
            builder = builder.header(super::super::token_guard::PEER_HEADER, value);
        }
        let mut req = builder.body(Body::empty()).unwrap();
        if let Some(addr) = connect {
            req.extensions_mut().insert(ConnectInfo(addr));
        }
        let res = app.oneshot(req).await.unwrap();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        (!text.is_empty()).then_some(text)
    }

    #[tokio::test]
    async fn the_peer_header_is_the_socket_peer_and_never_the_clients() {
        let peer: SocketAddr = "192.0.2.7:51000".parse().unwrap();
        assert_eq!(
            peer_seen(Some(peer), Some("203.0.113.9")).await.as_deref(),
            Some("192.0.2.7")
        );
        assert_eq!(
            peer_seen(Some(peer), None).await.as_deref(),
            Some("192.0.2.7")
        );
        // No socket peer (never so on the server): a client's copy is still
        // removed, so nothing is believed.
        assert_eq!(peer_seen(None, Some("203.0.113.9")).await, None);
    }
}

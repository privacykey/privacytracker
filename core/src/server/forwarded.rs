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

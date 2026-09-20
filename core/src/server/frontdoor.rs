//! Phase 6, batch 3a: what `next start` does around its router, now that
//! this server answers for the pages too. Outermost first:
//!
//! - the router's first step (`normalize`): a path with `//` or a
//!   backslash is a 308 to its normalised form, answered before anything
//!   else so it carries no other header; a path with dot segments is
//!   resolved as the WHATWG URL parser resolves it and routed as that;
//! - next.config.js `headers()` (`security_headers`): five static headers
//!   on every other response, static assets and the API included;
//! - the `compression` middleware (`compress`): `Vary: Accept-Encoding` on
//!   a compressible response, and gzip or deflate when the client accepts
//!   one and the body is 1 KiB or more. Route handlers (the API, the
//!   metadata icons) bypass it in `next start`, and here too: `app_route`
//!   marks their responses, and also gives them the router `Vary` Next
//!   puts on every route handler's response.
use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    middleware::Next,
    response::Response,
};
use tokio::io::AsyncReadExt;

use super::nexthttp::{compressible, negotiate_encoding, repeated_slash_target};
use super::site::{AppRoute, ROUTER_VARY};

/// next.config.js `headers()`, on every path.
const SECURITY_HEADERS: [(&str, &str); 5] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "strict-origin-when-cross-origin"),
    (
        "permissions-policy",
        "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
    ),
    ("cross-origin-opener-policy", "same-origin"),
];
/// The `compression` middleware's default threshold.
const COMPRESSION_THRESHOLD: usize = 1024;

/// A WHATWG dot segment: `.` or `..`, either dot possibly `%2e`.
fn is_dot_segment(segment: &str) -> bool {
    let s = segment.to_ascii_lowercase();
    matches!(s.as_str(), "." | "%2e" | ".." | ".%2e" | "%2e." | "%2e%2e")
}

pub(super) async fn normalize(mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    if let Some(target) = repeated_slash_target(&path, req.uri().query()) {
        let mut response = Response::new(Body::from(target.clone()));
        *response.status_mut() = StatusCode::PERMANENT_REDIRECT;
        if let Ok(location) = HeaderValue::from_str(&target) {
            response.headers_mut().insert(header::LOCATION, location);
        }
        if let Ok(refresh) = HeaderValue::from_str(&format!("0;url={target}")) {
            response.headers_mut().insert("refresh", refresh);
        }
        return response;
    }
    if path.split('/').any(is_dot_segment) {
        let raw = req
            .uri()
            .path_and_query()
            .map_or_else(|| path.clone(), |pq| pq.as_str().to_string());
        if let Ok(url) = url::Url::parse(&format!("http://localhost{raw}")) {
            let resolved = match url.query() {
                Some(q) => format!("{}?{q}", url.path()),
                None => url.path().to_string(),
            };
            if let Ok(uri) = resolved.parse::<Uri>() {
                *req.uri_mut() = uri;
            }
        }
    }
    next.run(req).await
}

pub(super) async fn security_headers(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    // A method an API route has no handler for is Next's bare 405, which
    // names no `Allow`; axum adds one after the route layer has run.
    if response.status() == StatusCode::METHOD_NOT_ALLOWED
        && response.extensions().get::<AppRoute>().is_some()
    {
        response.headers_mut().remove(header::ALLOW);
    }
    for (name, value) in SECURITY_HEADERS {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}

/// Every route handler's response: out of the compression middleware's
/// reach, with the router `Vary`.
pub(super) async fn app_route(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    response.extensions_mut().insert(AppRoute);
    if !response.headers().contains_key(header::VARY) {
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static(ROUTER_VARY));
    }
    response
}

/// The `vary` module's `append`: `field` added unless the header already
/// names it or is `*`.
fn append_vary(headers: &mut HeaderMap, field: &str) {
    let existing: Vec<String> = headers
        .get_all(header::VARY)
        .iter()
        .filter_map(|v| v.to_str().ok().map(str::to_string))
        .collect();
    let current = existing.join(", ");
    if current.trim() == "*" {
        return;
    }
    let names: Vec<String> = current
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .collect();
    if names
        .iter()
        .any(|n| n == "*" || *n == field.to_ascii_lowercase())
    {
        return;
    }
    let value = if current.is_empty() {
        field.to_string()
    } else {
        format!("{current}, {field}")
    };
    if let Ok(value) = HeaderValue::from_str(&value) {
        headers.insert(header::VARY, value);
    }
}

async fn encode(method: &str, bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut out = vec![];
    if method == "gzip" {
        async_compression::tokio::bufread::GzipEncoder::new(bytes)
            .read_to_end(&mut out)
            .await?;
    } else {
        // `zlib.createDeflate()`: the zlib wrapping, as `deflate` means in
        // HTTP.
        async_compression::tokio::bufread::ZlibEncoder::new(bytes)
            .read_to_end(&mut out)
            .await?;
    }
    Ok(out)
}

pub(super) async fn compress(req: Request, next: Next) -> Response {
    let accept = req
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let head = req.method() == Method::HEAD;
    let mut response = next.run(req).await;
    if response.extensions().get::<AppRoute>().is_some() {
        return response;
    }
    let compressible_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(compressible);
    if !compressible_type {
        return response;
    }
    append_vary(response.headers_mut(), "Accept-Encoding");
    let no_transform = response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("no-transform"));
    if head || no_transform || response.headers().contains_key(header::CONTENT_ENCODING) {
        return response;
    }
    let Some(method) = negotiate_encoding(accept.as_deref()) else {
        return response;
    };
    let declared = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|len| len < COMPRESSION_THRESHOLD) {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        let mut failed = Response::new(Body::empty());
        *failed.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        return failed;
    };
    if bytes.len() < COMPRESSION_THRESHOLD {
        return Response::from_parts(parts, Body::from(bytes));
    }
    match encode(method, &bytes).await {
        Ok(compressed) => {
            parts
                .headers
                .insert(header::CONTENT_ENCODING, HeaderValue::from_static(method));
            parts.headers.remove(header::CONTENT_LENGTH);
            Response::from_parts(parts, Body::from(compressed))
        }
        Err(e) => {
            super::diag::log_error(format!("[compression] {e}"));
            Response::from_parts(parts, Body::from(bytes))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vary_appends_like_the_vary_module() {
        let mut h = HeaderMap::new();
        append_vary(&mut h, "Accept-Encoding");
        assert_eq!(h[header::VARY], "Accept-Encoding");
        let mut h = HeaderMap::new();
        h.insert(header::VARY, HeaderValue::from_static(ROUTER_VARY));
        append_vary(&mut h, "Accept-Encoding");
        assert_eq!(
            h[header::VARY],
            "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding"
        );
        append_vary(&mut h, "accept-encoding");
        assert_eq!(h.get_all(header::VARY).iter().count(), 1);
        let mut h = HeaderMap::new();
        h.insert(header::VARY, HeaderValue::from_static("*"));
        append_vary(&mut h, "Accept-Encoding");
        assert_eq!(h[header::VARY], "*");
    }

    #[test]
    fn dot_segments_are_recognised() {
        assert!(is_dot_segment(".."));
        assert!(is_dot_segment("%2E%2e"));
        assert!(is_dot_segment(".%2E"));
        assert!(is_dot_segment("."));
        assert!(!is_dot_segment("..."));
        assert!(!is_dot_segment(".well-known"));
    }
}

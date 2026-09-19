//! Phase 6, batch 3a: `proxy.ts`'s Content-Security-Policy, which it puts
//! on every response it handles (the API's included), and
//! `lib/csp-route-key.ts`, which picks the page whose inline-script hashes
//! go in `script-src`.
//!
//! The hashes come from the build's `csp-hashes.json`
//! (`scripts/generate-csp-hashes.mjs`), read with the site. With no site,
//! `script-src` is `'self'` alone: Node fails closed the same way when the
//! file is missing, and this server then serves no page for an inline
//! script to run in anyway. Unlike Node, the policy is always the
//! production one: this server has no development mode.
use std::collections::HashMap;

use axum::http::{HeaderName, HeaderValue};

const APPLE_IMG_HOSTS: &str = "https://is1-ssl.mzstatic.com https://is2-ssl.mzstatic.com https://is3-ssl.mzstatic.com https://is4-ssl.mzstatic.com https://is5-ssl.mzstatic.com";
/// The IPC origins Tauri's `invoke()` uses; see `proxy.ts`.
const TAURI_IPC_SOURCES: &str = "ipc: http://ipc.localhost";
const NOT_FOUND_KEY: &str = "/_not-found";

/// `cspRouteKey`: the page a path's HTML actually comes from.
pub(crate) fn route_key<'a>(pathname: &'a str, routes: &HashMap<String, Vec<String>>) -> &'a str {
    let clean = if pathname.len() > 1 && pathname.ends_with('/') {
        &pathname[..pathname.len() - 1]
    } else {
        pathname
    };
    let one_segment = |rest: &str| !rest.is_empty() && !rest.contains('/');
    if clean.strip_prefix("/apps/").is_some_and(one_segment) {
        return "/apps/view";
    }
    if clean.strip_prefix("/manual-apps/").is_some_and(one_segment) {
        return "/manual-apps/view";
    }
    if routes.contains_key(clean) {
        clean
    } else {
        NOT_FOUND_KEY
    }
}

fn script_src(pathname: &str) -> String {
    let Some(hashes) = super::site::installed().and_then(|s| s.csp.as_ref()) else {
        return "'self'".into();
    };
    let list = hashes
        .routes
        .get(route_key(pathname, &hashes.routes))
        .unwrap_or(&hashes.all);
    std::iter::once("'self'".to_string())
        .chain(list.iter().map(|h| format!("'{h}'")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `buildCsp(pathname)`.
fn build(pathname: &str) -> String {
    let desktop = crate::host_env::var("PRIVACYTRACKER_RUNTIME").is_ok_and(|v| v == "desktop");
    let connect = if desktop {
        format!("'self' {TAURI_IPC_SOURCES}")
    } else {
        "'self'".into()
    };
    [
        "default-src 'self'".to_string(),
        "base-uri 'self'".into(),
        "frame-ancestors 'none'".into(),
        "form-action 'self'".into(),
        format!("img-src 'self' data: blob: {APPLE_IMG_HOSTS}"),
        "font-src 'self' data:".into(),
        format!("script-src {}", script_src(pathname)),
        "style-src 'self' 'unsafe-inline'".into(),
        format!("connect-src {connect}"),
        "object-src 'none'".into(),
        "report-uri /api/csp-report".into(),
    ]
    .join("; ")
}

/// The header `attachSecurityHeaders` sets for `pathname`, by
/// `PRIVACYTRACKER_CSP`: enforced by default, report-only, or none.
pub(crate) fn header(pathname: &str) -> Option<(HeaderName, HeaderValue)> {
    let mode = crate::host_env::var("PRIVACYTRACKER_CSP")
        .map(|v| v.to_lowercase())
        .unwrap_or_else(|_| "enforce".into());
    let name = match mode.as_str() {
        "off" => return None,
        "report-only" => HeaderName::from_static("content-security-policy-report-only"),
        _ => HeaderName::from_static("content-security-policy"),
    };
    HeaderValue::from_str(&build(pathname))
        .ok()
        .map(|value| (name, value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_keys_follow_the_rewrites() {
        let routes: HashMap<String, Vec<String>> = ["/dashboard", "/apps/view", "/_not-found", "/"]
            .iter()
            .map(|k| (k.to_string(), vec![]))
            .collect();
        assert_eq!(route_key("/dashboard", &routes), "/dashboard");
        assert_eq!(route_key("/dashboard/", &routes), "/dashboard");
        assert_eq!(route_key("/", &routes), "/");
        assert_eq!(route_key("/apps/123", &routes), "/apps/view");
        assert_eq!(route_key("/apps/123/", &routes), "/apps/view");
        assert_eq!(route_key("/manual-apps/x", &routes), "/manual-apps/view");
        assert_eq!(route_key("/apps/1/2", &routes), "/_not-found");
        assert_eq!(route_key("/api/stats", &routes), "/_not-found");
    }
}

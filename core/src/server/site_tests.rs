//! The site handler over a small synthetic build, pinning the rules the
//! page-parity probe verified against `next start` (the probe compares the
//! real build live; this runs in CI without one).
use super::nexthttp::{cache_busting_param, generate_etag, RouterHeaders};
use super::site::{AppRoute, Ask, KeepCacheControl, Site, PRIVATE_NO_CACHE, ROUTER_VARY};
use axum::{
    body::to_bytes,
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::Response,
};
use std::path::{Path, PathBuf};

const PAGE_META: &str = r#"{"headers":{"x-nextjs-stale-time":"300","x-nextjs-prerender":"1","x-next-cache-tags":"_N_T_/layout"},"segmentPaths":["/_tree","/_full"]}"#;

fn write(root: &Path, rel: &str, contents: &[u8]) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// A build with a home page, a dashboard, the not-found page, a view shell,
/// an icon, a static chunk, a public file and the CSP hashes.
fn build() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("pt-site-test-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let app = ".next/server/app";
    for (stem, html) in [
        ("index", "<html>home λ</html>"),
        ("dashboard", "<html>dashboard</html>"),
        ("apps/view", "<html>view</html>"),
    ] {
        write(&root, &format!("{app}/{stem}.html"), html.as_bytes());
        write(&root, &format!("{app}/{stem}.meta"), PAGE_META.as_bytes());
        write(
            &root,
            &format!("{app}/{stem}.rsc"),
            format!("RSC {stem}").as_bytes(),
        );
        write(
            &root,
            &format!("{app}/{stem}.segments/_tree.segment.rsc"),
            format!("TREE {stem}").as_bytes(),
        );
    }
    write(
        &root,
        &format!("{app}/_not-found.html"),
        b"<html>404</html>",
    );
    write(
        &root,
        &format!("{app}/_not-found.meta"),
        br#"{"status":404,"headers":{"x-nextjs-stale-time":"300","x-nextjs-prerender":"1"}}"#,
    );
    write(&root, &format!("{app}/_not-found.rsc"), b"RSC not found");
    write(
        &root,
        &format!("{app}/_not-found.segments/_tree.segment.rsc"),
        b"TREE not found",
    );
    write(&root, &format!("{app}/icon.png.body"), b"PNG");
    write(
        &root,
        &format!("{app}/icon.png.meta"),
        br#"{"status":200,"headers":{"cache-control":"public, max-age=0, must-revalidate","content-type":"image/png","x-next-cache-tags":"x"}}"#,
    );
    write(&root, ".next/static/chunks/app.js", &[b'x'; 2000]);
    write(&root, "public/brand-icon.png", b"0123456789abcdefghij");
    write(
        &root,
        ".next/csp-hashes.json",
        br#"{"all":["sha256-a"],"routes":{"/":["sha256-a"],"/_not-found":["sha256-b"]}}"#,
    );
    root
}

struct Answer {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
    keep: bool,
    app_route: bool,
}

impl Answer {
    fn all(&self, name: &str) -> Vec<&str> {
        self.headers
            .get_all(name)
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect()
    }
    fn one(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|v| v.to_str().unwrap())
    }
}

fn ask(site: &Site, method: Method, path_and_query: &str, headers: &[(&str, &str)]) -> Answer {
    let (path, query) = match path_and_query.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path_and_query, None),
    };
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        map.append(
            axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            HeaderValue::from_str(v).unwrap(),
        );
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let response: Response = rt.block_on(site.respond(&Ask {
        method: &method,
        path,
        query,
        headers: &map,
    }));
    let keep = response.extensions().get::<KeepCacheControl>().is_some();
    let app_route = response.extensions().get::<AppRoute>().is_some();
    let status = response.status();
    let headers = response.headers().clone();
    let body = rt
        .block_on(to_bytes(response.into_body(), usize::MAX))
        .unwrap()
        .to_vec();
    Answer {
        status,
        headers,
        body,
        keep,
        app_route,
    }
}

fn rsc_query(h: RouterHeaders<'_>) -> String {
    let hash = cache_busting_param(h);
    if hash.is_empty() {
        "_rsc".into()
    } else {
        format!("_rsc={hash}")
    }
}

#[test]
fn documents_carry_the_headers_next_sends() {
    let root = build();
    let site = Site::load(&root).unwrap();
    let a = ask(&site, Method::GET, "/", &[]);
    assert_eq!(a.status, StatusCode::OK);
    assert_eq!(a.body, "<html>home λ</html>".as_bytes());
    assert_eq!(a.one("vary"), Some(ROUTER_VARY));
    assert_eq!(a.one("x-nextjs-cache"), Some("HIT"));
    assert_eq!(a.all("x-nextjs-prerender"), vec!["1", "1"]);
    assert_eq!(a.one("x-nextjs-stale-time"), Some("300"));
    assert_eq!(a.one("x-next-cache-tags"), None);
    assert_eq!(a.one("x-powered-by"), Some("Next.js"));
    // Node's `generateETag` of this page: over the UTF-16 string, where
    // `λ` is one unit and two bytes. A literal, not `generate_etag`, so
    // the test cannot agree with a broken port of it.
    assert_eq!(a.one("etag"), Some("\"3xdgpnl4hej\""));
    assert_eq!(a.one("content-type"), Some("text/html; charset=utf-8"));
    assert_eq!(a.one("content-length"), Some("20"));

    let head = ask(&site, Method::HEAD, "/", &[]);
    assert!(head.body.is_empty());
    assert_eq!(head.one("content-length"), Some("20"));

    let etag = a.one("etag").unwrap().to_string();
    let cached = ask(&site, Method::GET, "/", &[("if-none-match", &etag)]);
    assert_eq!(cached.status, StatusCode::NOT_MODIFIED);
    assert_eq!(cached.one("content-type"), None);
    // A page ignores the request's no-cache, and an If-Modified-Since with
    // no Last-Modified makes it stale.
    let no_cache = ask(
        &site,
        Method::GET,
        "/",
        &[("if-none-match", &etag), ("cache-control", "no-cache")],
    );
    assert_eq!(no_cache.status, StatusCode::NOT_MODIFIED);
    let ims = ask(
        &site,
        Method::GET,
        "/",
        &[
            ("if-none-match", &etag),
            ("if-modified-since", "Thu, 17 Sep 2099 08:28:48 GMT"),
        ],
    );
    assert_eq!(ims.status, StatusCode::OK);

    let post = ask(&site, Method::POST, "/dashboard", &[]);
    assert_eq!(post.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(post.all("allow"), vec!["GET", "HEAD"]);
    assert_eq!(post.body, b"Method Not Allowed");
    assert_eq!(post.one("content-type"), None);
}

#[test]
fn rsc_requests_check_the_cache_busting_parameter() {
    let root = build();
    let site = Site::load(&root).unwrap();
    let rsc = [("rsc", "1")];
    let missing = ask(&site, Method::GET, "/dashboard?tab=x", &rsc);
    assert_eq!(missing.status, StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(missing.one("location"), Some("/dashboard?tab=x&_rsc"));
    assert!(missing.body.is_empty());

    let full = ask(&site, Method::GET, "/dashboard?_rsc", &rsc);
    assert_eq!(full.status, StatusCode::OK);
    assert_eq!(full.body, b"RSC dashboard");
    assert_eq!(full.one("content-type"), Some("text/x-component"));
    assert_eq!(full.all("x-nextjs-prerender"), vec!["1", "1"]);
    assert_eq!(full.one("etag"), None);

    let prefetch = [("rsc", "1"), ("next-router-prefetch", "1")];
    let query = rsc_query(RouterHeaders {
        prefetch: Some("1"),
        ..Default::default()
    });
    let hit = ask(
        &site,
        Method::GET,
        &format!("/dashboard?{query}"),
        &prefetch,
    );
    assert_eq!(hit.body, b"RSC dashboard");

    let segment = [
        ("rsc", "1"),
        ("next-router-prefetch", "1"),
        ("next-router-segment-prefetch", "/_tree"),
    ];
    let query = rsc_query(RouterHeaders {
        prefetch: Some("1"),
        segment_prefetch: Some("/_tree"),
        ..Default::default()
    });
    let tree = ask(&site, Method::GET, &format!("/dashboard?{query}"), &segment);
    assert_eq!(tree.status, StatusCode::OK);
    assert_eq!(tree.body, b"TREE dashboard");
    assert_eq!(tree.one("x-nextjs-postponed"), Some("2"));
    assert_eq!(tree.one("x-nextjs-stale-time"), None);

    let head_segment = [
        ("rsc", "1"),
        ("next-router-prefetch", "1"),
        ("next-router-segment-prefetch", "/_head"),
    ];
    let query = rsc_query(RouterHeaders {
        prefetch: Some("1"),
        segment_prefetch: Some("/_head"),
        ..Default::default()
    });
    let none = ask(
        &site,
        Method::GET,
        &format!("/dashboard?{query}"),
        &head_segment,
    );
    assert_eq!(none.status, StatusCode::NOT_FOUND);
    assert!(none.body.is_empty());
    assert_eq!(none.one("content-type"), None);

    let rewritten = ask(&site, Method::GET, "/apps/42?_rsc", &rsc);
    assert_eq!(rewritten.body, b"RSC apps/view");
    assert_eq!(rewritten.one("x-nextjs-rewritten-path"), Some("/apps/view"));
    assert_eq!(rewritten.one("x-nextjs-rewritten-query"), Some(""));
}

#[test]
fn unknown_paths_are_the_not_found_page() {
    let root = build();
    let site = Site::load(&root).unwrap();
    let a = ask(&site, Method::POST, "/no-such-page", &[]);
    assert_eq!(a.status, StatusCode::NOT_FOUND);
    assert_eq!(a.body, b"<html>404</html>");
    assert_eq!(a.one("cache-control"), Some(PRIVATE_NO_CACHE));
    assert!(a.keep);
    // Its RSC payload skips the `_rsc` check, and its segments are 404s.
    let rsc = ask(&site, Method::GET, "/no-such-page", &[("rsc", "1")]);
    assert_eq!(rsc.status, StatusCode::NOT_FOUND);
    assert_eq!(rsc.body, b"RSC not found");
    // Asked for by name, the page keeps the proxy's Cache-Control.
    let direct = ask(&site, Method::GET, "/_not-found", &[]);
    assert_eq!(direct.status, StatusCode::NOT_FOUND);
    assert!(!direct.keep);
    // A page name spelled with escapes is matched, then not found, without
    // the 404's own Cache-Control.
    let encoded = ask(&site, Method::GET, "/%64ashboard", &[]);
    assert_eq!(encoded.status, StatusCode::NOT_FOUND);
    assert!(!encoded.keep);
    assert_eq!(
        ask(&site, Method::GET, "/index", &[]).status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        ask(&site, Method::GET, "/apps/1/2", &[]).status,
        StatusCode::NOT_FOUND
    );
}

#[test]
fn files_are_sent_as_send_sends_them() {
    let root = build();
    let site = Site::load(&root).unwrap();
    let js = "/_next/static/chunks/app.js";
    let a = ask(&site, Method::GET, js, &[]);
    assert_eq!(a.status, StatusCode::OK);
    assert_eq!(
        a.one("cache-control"),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(a.one("accept-ranges"), Some("bytes"));
    assert_eq!(
        a.one("content-type"),
        Some("application/javascript; charset=UTF-8")
    );
    let etag = a.one("etag").unwrap().to_string();
    assert!(etag.starts_with("W/\"7d0-"), "{etag}");
    assert!(a.one("last-modified").unwrap().ends_with(" GMT"));

    let range = ask(&site, Method::GET, js, &[("range", "bytes=0-9")]);
    assert_eq!(range.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(range.one("content-range"), Some("bytes 0-9/2000"));
    assert_eq!(range.body.len(), 10);
    let two = ask(&site, Method::GET, js, &[("range", "bytes=0-1,10-11")]);
    assert_eq!(two.status, StatusCode::OK);
    let bad = ask(&site, Method::GET, js, &[("range", "bytes=5000-")]);
    assert_eq!(bad.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(bad.one("content-range"), Some("bytes */2000"));
    assert_eq!(
        bad.one("etag"),
        Some(generate_etag("Internal Server Error").as_str())
    );
    assert!(bad.keep);
    let cached = ask(&site, Method::GET, js, &[("if-none-match", &etag)]);
    assert_eq!(cached.status, StatusCode::NOT_MODIFIED);
    assert_eq!(cached.one("content-type"), None);
    let post = ask(&site, Method::POST, js, &[]);
    assert_eq!(post.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(post.all("allow"), vec!["GET", "HEAD"]);
    assert_eq!(post.one("content-type"), Some("text/plain"));
    let missing = ask(&site, Method::GET, "/_next/static/chunks/nope.js", &[]);
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.body, b"Not Found");

    let public = ask(&site, Method::GET, "/brand%2Dicon.png", &[]);
    assert_eq!(public.status, StatusCode::OK);
    assert_eq!(public.one("cache-control"), Some("public, max-age=0"));
    assert_eq!(public.one("content-type"), Some("image/png"));

    let icon = ask(&site, Method::GET, "/icon.png", &[]);
    assert_eq!(icon.body, b"PNG");
    assert_eq!(icon.one("vary"), Some(ROUTER_VARY));
    assert_eq!(icon.one("x-nextjs-cache"), Some("HIT"));
    assert_eq!(
        icon.one("cache-control"),
        Some("public, max-age=0, must-revalidate")
    );
    assert_eq!(icon.one("x-next-cache-tags"), None);
    assert_eq!(icon.one("etag"), None);
    assert!(icon.app_route);
    let _ = std::fs::remove_dir_all(&root);
}

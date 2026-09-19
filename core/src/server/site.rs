//! Phase 6, batch 3a: the frontend, served from a `next build` output the
//! way `next start` serves it, so the Rust server can stand in for Node in
//! the desktop app and in Docker.
//!
//! Every page is prerendered (Phase 0 made every route static), so serving
//! the build is a matter of answering from its files exactly as Next does:
//! the document, the RSC payload a client navigation fetches (after the
//! `_rsc` cache-busting check), the segment files a prefetch asks for,
//! `/_next/static` and `public/` through Next's bundled `send`, the three
//! metadata icons, the two rewrites to the view shells, the not-found page
//! for everything else, and the 405 for a page asked to do anything but
//! GET or HEAD. Each response carries the headers Next's do; the layers in
//! `mod.rs` add what Next adds around it (the security headers, `proxy.ts`,
//! compression). What each branch answers was recorded from `next start`
//! and is held by the page-parity probe (`scripts/parity/page-probes.mjs`).
//!
//! The build is indexed once, at startup, as Next indexes its public and
//! static folders: a request only ever looks a file up by name in that
//! index, so a path a client sends never reaches the filesystem.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::Response,
};
use serde_json::Value;

use super::nexthttp::{
    cache_busting_param, content_type_for, file_etag, fresh, generate_etag,
    legacy_cache_busting_param, parse_http_date, parse_ranges, parse_token_list, tag_matches,
    with_cache_busting_param, Conditional, Ranges, RouterHeaders,
};

/// The `Vary` Next sets on every page and route-handler response.
pub(super) const ROUTER_VARY: &str =
    "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch";
/// What Next answers a 404 or an error with, over `proxy.ts`'s `no-store`.
pub(super) const PRIVATE_NO_CACHE: &str = "private, no-cache, no-store, max-age=0, must-revalidate";
const STATIC_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const PUBLIC_CACHE_CONTROL: &str = "public, max-age=0";
const NOT_FOUND_ROUTE: &str = "/_not-found";
const INTERNAL_ERROR: &str = "Internal Server Error";
const RSC_CONTENT_TYPE: &str = "text/x-component";
const HTML_CONTENT_TYPE: &str = "text/html; charset=utf-8";

/// Set on a response whose `Cache-Control` Next set itself, after
/// `proxy.ts`: the gate leaves it instead of writing `no-store`.
#[derive(Clone, Copy)]
pub(crate) struct KeepCacheControl;

/// Set on a route handler's response (the API, the metadata icons): the
/// `compression` middleware never sees those in `next start`, so they get
/// neither a compressed body nor `Vary: Accept-Encoding`.
#[derive(Clone, Copy)]
pub(crate) struct AppRoute;

/// A file the server may send, found at startup.
struct FileEntry {
    path: PathBuf,
    size: u64,
    mtime_ms: i64,
}

/// One prerendered route: the document and what its `.meta` says, the full
/// RSC payload and the segment files.
struct Page {
    html: String,
    etag: String,
    status: StatusCode,
    /// The `.meta` headers in order, `x-next-cache-tags` dropped (Next never
    /// sends it).
    meta_headers: Vec<(String, String)>,
    rsc: Option<PathBuf>,
    segments: HashMap<String, PathBuf>,
}

/// A metadata route (`favicon.ico`, `icon.png`, `apple-icon.png`): its body
/// and its `.meta` headers.
struct MetaRoute {
    body: PathBuf,
    status: StatusCode,
    headers: Vec<(String, String)>,
}

/// `csp-hashes.json`: every page's inline-script hashes, and their union.
pub(crate) struct CspHashes {
    pub all: Vec<String>,
    pub routes: HashMap<String, Vec<String>>,
}

/// A loaded build.
pub struct Site {
    pages: HashMap<String, Page>,
    metadata: HashMap<String, MetaRoute>,
    statics: HashMap<String, FileEntry>,
    public: HashMap<String, FileEntry>,
    pub(crate) csp: Option<CspHashes>,
}

static SITE: OnceLock<Site> = OnceLock::new();

/// Make `site` the one this process serves. Once per process, like the
/// data layout.
pub(crate) fn install(site: Site) -> Result<(), String> {
    SITE.set(site)
        .map_err(|_| "a site is already being served".to_string())
}

pub(crate) fn installed() -> Option<&'static Site> {
    SITE.get()
}

/// `stats.mtime.getTime()`: Node builds the Date from the fractional
/// `mtimeMs` with `Math.round`, so the nearest millisecond, not the floor.
fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from((d.as_nanos() + 500_000) / 1_000_000).ok())
        .unwrap_or(0)
}

/// Every regular file under `dir`, keyed `/<relative path>`.
fn index_files(dir: &Path, prefix: &str, out: &mut HashMap<String, FileEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if meta.is_dir() {
            index_files(&path, &format!("{prefix}/{name}"), out);
        } else if meta.is_file() {
            out.insert(
                format!("{prefix}/{name}"),
                FileEntry {
                    size: meta.len(),
                    mtime_ms: mtime_ms(&meta),
                    path,
                },
            );
        }
    }
}

/// A `.meta` file's status and headers, `x-next-cache-tags` dropped.
fn read_meta(path: &Path) -> (StatusCode, Vec<(String, String)>) {
    let meta: Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let status = meta["status"]
        .as_u64()
        .and_then(|s| u16::try_from(s).ok())
        .and_then(|s| StatusCode::from_u16(s).ok())
        .unwrap_or(StatusCode::OK);
    let headers = meta["headers"]
        .as_object()
        .map(|h| {
            h.iter()
                .filter(|(k, _)| k.as_str() != "x-next-cache-tags")
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    (status, headers)
}

impl Site {
    /// Index the build under `root`, the directory `next start` runs in:
    /// `.next/server/app` for the pages and icons, `.next/static`,
    /// `public/`, and `.next/csp-hashes.json`.
    pub fn load(root: &Path) -> Result<Site, String> {
        let dist = root.join(".next");
        let app = dist.join("server").join("app");
        if !app.is_dir() {
            return Err(format!(
                "{} holds no build: run `next build` first",
                root.display()
            ));
        }
        let mut files: HashMap<String, FileEntry> = HashMap::new();
        index_files(&app, "", &mut files);
        let mut pages = HashMap::new();
        let mut metadata = HashMap::new();
        for (name, entry) in &files {
            if let Some(stem) = name.strip_suffix(".html") {
                let route = if stem == "/index" { "/" } else { stem };
                let html = std::fs::read_to_string(&entry.path)
                    .map_err(|e| format!("{}: {e}", entry.path.display()))?;
                let (status, meta_headers) = read_meta(&app.join(format!(".{stem}.meta")));
                let segment_prefix = format!("{stem}.segments");
                let segments = files
                    .iter()
                    .filter_map(|(other, file)| {
                        let rest = other.strip_prefix(&segment_prefix)?;
                        let segment = rest.strip_suffix(".segment.rsc")?;
                        Some((segment.to_string(), file.path.clone()))
                    })
                    .collect();
                pages.insert(
                    route.to_string(),
                    Page {
                        etag: generate_etag(&html),
                        html,
                        status,
                        meta_headers,
                        rsc: files.get(&format!("{stem}.rsc")).map(|f| f.path.clone()),
                        segments,
                    },
                );
            } else if let Some(route) = name.strip_suffix(".body") {
                let (status, headers) = read_meta(&app.join(format!(".{route}.meta")));
                metadata.insert(
                    route.to_string(),
                    MetaRoute {
                        body: entry.path.clone(),
                        status,
                        headers,
                    },
                );
            }
        }
        if !pages.contains_key(NOT_FOUND_ROUTE) {
            return Err(format!("{} has no not-found page", app.display()));
        }
        let mut statics = HashMap::new();
        index_files(&dist.join("static"), "/_next/static", &mut statics);
        let mut public = HashMap::new();
        index_files(&root.join("public"), "", &mut public);
        let csp = std::fs::read_to_string(dist.join("csp-hashes.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .map(|v| CspHashes {
                all: strings(&v["all"]),
                routes: v["routes"]
                    .as_object()
                    .map(|r| r.iter().map(|(k, v)| (k.clone(), strings(v))).collect())
                    .unwrap_or_default(),
            });
        Ok(Site {
            pages,
            metadata,
            statics,
            public,
            csp,
        })
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ── the request ──────────────────────────────────────────────────────

/// What the handlers read from a request.
pub(crate) struct Ask<'a> {
    pub method: &'a Method,
    pub path: &'a str,
    pub query: Option<&'a str>,
    pub headers: &'a HeaderMap,
}

impl Ask<'_> {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    fn is_read(&self) -> bool {
        *self.method == Method::GET || *self.method == Method::HEAD
    }

    fn is_head(&self) -> bool {
        *self.method == Method::HEAD
    }
}

/// `decodeURIComponent` for a file lookup; `None` when it would throw.
fn percent_decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The two `afterFiles` rewrites: one non-empty raw segment under `/apps`
/// or `/manual-apps` lands on that section's view shell.
fn rewrite_target(path: &str) -> Option<&'static str> {
    let one_segment = |rest: &str| !rest.is_empty() && !rest.contains('/');
    if path.strip_prefix("/apps/").is_some_and(one_segment) {
        Some("/apps/view")
    } else if path.strip_prefix("/manual-apps/").is_some_and(one_segment) {
        Some("/manual-apps/view")
    } else {
        None
    }
}

fn value(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static(""))
}

fn with_headers(status: StatusCode, headers: &[(&str, String)], body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let map = response.headers_mut();
    for (name, v) in headers {
        if let Ok(name) = HeaderName::from_bytes(name.as_bytes()) {
            map.append(name, value(v));
        }
    }
    response
}

/// A page or icon asked to do anything but GET or HEAD.
fn method_not_allowed() -> Response {
    with_headers(
        StatusCode::METHOD_NOT_ALLOWED,
        &[
            ("vary", ROUTER_VARY.into()),
            ("allow", "GET".into()),
            ("allow", "HEAD".into()),
        ],
        Body::from("Method Not Allowed"),
    )
}

fn keep_cache_control(mut response: Response) -> Response {
    response.extensions_mut().insert(KeepCacheControl);
    response
}

impl Site {
    /// Answer a request the API routes did not claim.
    pub(crate) async fn respond(&self, ask: &Ask<'_>) -> Response {
        if ask.path.starts_with("/_next/static/") {
            let decoded = percent_decode(ask.path);
            return match decoded.as_deref().and_then(|p| self.statics.get(p)) {
                Some(file) => send_file(ask, file, STATIC_CACHE_CONTROL).await,
                None => keep_cache_control(with_headers(
                    StatusCode::NOT_FOUND,
                    &[
                        ("cache-control", PRIVATE_NO_CACHE.into()),
                        ("content-type", "text/plain; charset=utf-8".into()),
                    ],
                    Body::from("Not Found"),
                )),
            };
        }
        if !ask.path.starts_with("/_next/") {
            if let Some(file) = percent_decode(ask.path)
                .as_deref()
                .and_then(|p| self.public.get(p))
            {
                return send_file(ask, file, PUBLIC_CACHE_CONTROL).await;
            }
            if let Some(route) = self.metadata.get(ask.path) {
                return metadata_route(ask, route).await;
            }
            if let Some(page) = self.pages.get(ask.path) {
                return self.page(ask, page, None, false).await;
            }
            if let Some(target) = rewrite_target(ask.path) {
                if let Some(page) = self.pages.get(target) {
                    return self.page(ask, page, Some(target), false).await;
                }
            }
            // A path that names a page only once decoded (`/%64ashboard`)
            // is matched by Next's router and then finds no prerendered
            // entry under its raw spelling: the not-found page again, but
            // without the 404's own Cache-Control.
            if percent_decode(ask.path)
                .as_deref()
                .is_some_and(|p| p != ask.path && self.pages.contains_key(p))
            {
                return self.not_found(ask, false).await;
            }
        }
        self.not_found(ask, true).await
    }

    /// The not-found page, for a route nothing matched. `own_cache_control`
    /// is Next's 404 `Cache-Control`, which replaces `proxy.ts`'s.
    async fn not_found(&self, ask: &Ask<'_>, own_cache_control: bool) -> Response {
        let page = &self.pages[NOT_FOUND_ROUTE];
        let read = Ask {
            method: if ask.is_head() {
                &Method::HEAD
            } else {
                &Method::GET
            },
            ..*ask
        };
        let mut response = self.page(&read, page, None, true).await;
        if own_cache_control {
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(PRIVATE_NO_CACHE),
            );
            response = keep_cache_control(response);
        }
        response
    }

    /// A prerendered page: the 405 for a method it does not answer, the RSC
    /// payload for a client navigation, else the document.
    async fn page(
        &self,
        ask: &Ask<'_>,
        page: &Page,
        rewrite: Option<&str>,
        fallback: bool,
    ) -> Response {
        if !ask.is_read() {
            return method_not_allowed();
        }
        if ask.header("rsc") == Some("1") {
            return rsc(ask, page, rewrite, fallback).await;
        }
        let mut headers: Vec<(&str, String)> = vec![
            ("vary", ROUTER_VARY.into()),
            ("x-nextjs-cache", "HIT".into()),
        ];
        let meta: Vec<(&str, String)> = page
            .meta_headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        headers.extend(meta);
        headers.push(("x-nextjs-prerender", "1".into()));
        headers.push(("x-powered-by", "Next.js".into()));
        headers.push(("etag", page.etag.clone()));
        let conditional = Conditional {
            if_none_match: ask.header("if-none-match"),
            if_modified_since: ask.header("if-modified-since"),
            cache_control: ask.header("cache-control"),
        };
        if fresh(conditional, Some(&page.etag), None, false) {
            return with_headers(StatusCode::NOT_MODIFIED, &headers, Body::empty());
        }
        headers.push(("content-type", HTML_CONTENT_TYPE.into()));
        headers.push(("content-length", page.html.len().to_string()));
        let body = if ask.is_head() {
            Body::empty()
        } else {
            Body::from(page.html.clone())
        };
        with_headers(page.status, &headers, body)
    }
}

/// The RSC branch: the `_rsc` check, then the segment a prefetch names or
/// the full payload.
async fn rsc(ask: &Ask<'_>, page: &Page, rewrite: Option<&str>, fallback: bool) -> Response {
    let not_found_page = page.status == StatusCode::NOT_FOUND;
    let prefetch = ask
        .header("next-router-prefetch")
        .filter(|v| matches!(*v, "1" | "2" | "3"));
    let segment = ask
        .header("next-router-segment-prefetch")
        .filter(|v| !v.is_empty());
    let router = RouterHeaders {
        prefetch,
        segment_prefetch: segment,
        state_tree: ask.header("next-router-state-tree"),
        next_url: ask.header("next-url"),
    };
    if !not_found_page {
        let expected = cache_busting_param(router);
        let actual = ask.query.and_then(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .find(|(k, _)| k == "_rsc")
                .map(|(_, v)| v.into_owned())
        });
        let matches = actual.as_deref() == Some(expected.as_str())
            || actual
                .as_deref()
                .is_some_and(|a| a == legacy_cache_busting_param(router));
        if !matches {
            let query = with_cache_busting_param(ask.query, &expected);
            let mut url = url::Url::parse(&format!("http://localhost{}", ask.path))
                .unwrap_or_else(|_| url::Url::parse("http://localhost/").expect("a valid URL"));
            url.set_query(Some(&query));
            let location = format!(
                "{}{}",
                url.path(),
                url.query().map(|q| format!("?{q}")).unwrap_or_default()
            );
            let mut headers: Vec<(&str, String)> = vec![];
            if let Some(target) = rewrite {
                headers.push(("x-nextjs-rewritten-path", target.into()));
            }
            headers.push(("location", location));
            return with_headers(StatusCode::TEMPORARY_REDIRECT, &headers, Body::empty());
        }
    }
    let mut headers: Vec<(&str, String)> = vec![];
    if let Some(target) = rewrite {
        headers.push(("x-nextjs-rewritten-path", target.into()));
        headers.push(("x-nextjs-rewritten-query", String::new()));
    }
    headers.push(("vary", ROUTER_VARY.into()));
    headers.push(("x-nextjs-cache", "HIT".into()));
    if let Some(segment) = segment {
        headers.push(("x-nextjs-prerender", "1".into()));
        headers.push(("x-nextjs-postponed", "2".into()));
        let Some(file) = page.segments.get(segment) else {
            return with_headers(StatusCode::NOT_FOUND, &headers, Body::empty());
        };
        headers.push(("content-type", RSC_CONTENT_TYPE.into()));
        // A segment is 200 even from the error pages asked for by name; only
        // the not-found page standing in for an unmatched route is a 404.
        let status = if fallback {
            page.status
        } else {
            StatusCode::OK
        };
        return file_body(ask, status, &headers, file).await;
    }
    let meta: Vec<(&str, String)> = page
        .meta_headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.clone()))
        .collect();
    headers.extend(meta);
    headers.push(("x-nextjs-prerender", "1".into()));
    headers.push(("content-type", RSC_CONTENT_TYPE.into()));
    match &page.rsc {
        Some(file) => file_body(ask, page.status, &headers, file).await,
        None => with_headers(page.status, &headers, Body::empty()),
    }
}

/// A body read from a build file, left out for HEAD.
async fn file_body(
    ask: &Ask<'_>,
    status: StatusCode,
    headers: &[(&str, String)],
    file: &Path,
) -> Response {
    if ask.is_head() {
        return with_headers(status, headers, Body::empty());
    }
    match tokio::fs::read(file).await {
        Ok(bytes) => with_headers(status, headers, Body::from(bytes)),
        Err(e) => {
            super::diag::log_error(format!("[site] {}: {e}", file.display()));
            internal_error(vec![])
        }
    }
}

/// A metadata route: its `.meta` headers and no validators, out of the
/// compression middleware's reach; any method but GET or HEAD is the
/// page's 405.
async fn metadata_route(ask: &Ask<'_>, route: &MetaRoute) -> Response {
    if !ask.is_read() {
        return method_not_allowed();
    }
    let mut headers: Vec<(&str, String)> = vec![
        ("vary", ROUTER_VARY.into()),
        ("x-nextjs-cache", "HIT".into()),
    ];
    headers.extend(route.headers.iter().map(|(k, v)| (k.as_str(), v.clone())));
    let mut response = file_body(ask, route.status, &headers, &route.body).await;
    response.extensions_mut().insert(AppRoute);
    response
}

/// Next's answer when `send` fails (a method it refuses, a precondition,
/// an unsatisfiable range): a 500 over whatever `send` had set, with the
/// ETag of its own text body.
fn internal_error(mut headers: Vec<(&str, String)>) -> Response {
    headers.retain(|(k, _)| !k.eq_ignore_ascii_case("etag"));
    headers.insert(0, ("cache-control", PRIVATE_NO_CACHE.into()));
    headers.push(("etag", generate_etag(INTERNAL_ERROR)));
    if !headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("content-type"))
    {
        headers.push(("content-type", "text/plain".into()));
    }
    headers.push(("content-length", INTERNAL_ERROR.len().to_string()));
    keep_cache_control(with_headers(
        StatusCode::INTERNAL_SERVER_ERROR,
        &headers,
        Body::from(INTERNAL_ERROR),
    ))
}

/// `send`, as Next's static handler drives it.
async fn send_file(ask: &Ask<'_>, file: &FileEntry, cache_control: &str) -> Response {
    if !ask.is_read() {
        return internal_error(vec![("allow", "GET".into()), ("allow", "HEAD".into())]);
    }
    let etag = file_etag(file.size, file.mtime_ms);
    let last_modified = crate::jsdate::js_utc_string(file.mtime_ms);
    let content_type = content_type_for(&file.path.to_string_lossy());
    let mut headers: Vec<(&str, String)> = vec![
        ("accept-ranges", "bytes".into()),
        ("cache-control", cache_control.into()),
        ("last-modified", last_modified.clone()),
        ("etag", etag.clone()),
        ("content-type", content_type.into()),
    ];
    let conditional = [
        "if-match",
        "if-unmodified-since",
        "if-none-match",
        "if-modified-since",
    ]
    .iter()
    .any(|h| ask.header(h).is_some_and(|v| !v.is_empty()));
    if conditional {
        if precondition_failure(ask, &etag, &last_modified) {
            headers.retain(|(k, _)| *k != "cache-control");
            return internal_error(headers);
        }
        let req = Conditional {
            if_none_match: ask.header("if-none-match"),
            if_modified_since: ask.header("if-modified-since"),
            cache_control: ask.header("cache-control"),
        };
        if fresh(req, Some(&etag), Some(&last_modified), true) {
            headers.retain(|(k, _)| *k != "content-type");
            return with_headers(StatusCode::NOT_MODIFIED, &headers, Body::empty());
        }
    }
    let mut range: Option<(u64, u64)> = None;
    if let Some(header) = ask
        .header("range")
        .filter(|h| h.trim_start_matches(' ').starts_with("bytes="))
    {
        let ranges = if range_fresh(ask, &etag, &last_modified) {
            parse_ranges(file.size, header)
        } else {
            Ranges::Malformed
        };
        match ranges {
            Ranges::Unsatisfiable => {
                headers.retain(|(k, _)| *k != "cache-control");
                headers.push(("content-range", format!("bytes */{}", file.size)));
                return internal_error(headers);
            }
            Ranges::Satisfiable(list) if list.len() == 1 => range = Some(list[0]),
            _ => {}
        }
    }
    let status = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let (start, end) = range.unwrap_or((0, file.size.saturating_sub(1)));
    let len = if file.size == 0 { 0 } else { end - start + 1 };
    if let Some((start, end)) = range {
        headers.push((
            "content-range",
            format!("bytes {start}-{end}/{}", file.size),
        ));
    }
    headers.push(("content-length", len.to_string()));
    if ask.is_head() {
        return with_headers(status, &headers, Body::empty());
    }
    match tokio::fs::read(&file.path).await {
        Ok(bytes) => {
            let slice = if range.is_some() {
                bytes
                    .get(start as usize..=end as usize)
                    .map(<[u8]>::to_vec)
                    .unwrap_or_default()
            } else {
                bytes
            };
            with_headers(status, &headers, Body::from(slice))
        }
        Err(e) => {
            super::diag::log_error(format!("[site] {}: {e}", file.path.display()));
            internal_error(vec![])
        }
    }
}

/// `send`'s `isPreconditionFailure`.
fn precondition_failure(ask: &Ask<'_>, etag: &str, last_modified: &str) -> bool {
    if let Some(matches) = ask.header("if-match").filter(|v| !v.is_empty()) {
        return matches != "*"
            && parse_token_list(matches)
                .iter()
                .all(|token| !tag_matches(token, etag));
    }
    if let Some(since) = ask.header("if-unmodified-since").and_then(parse_http_date) {
        // `isNaN(lastModified) || lastModified > unmodifiedSince`.
        return parse_http_date(last_modified).map_or(true, |modified| modified > since);
    }
    false
}

/// `send`'s `isRangeFresh`: an `If-Range` validator must still hold.
fn range_fresh(ask: &Ask<'_>, etag: &str, last_modified: &str) -> bool {
    let Some(if_range) = ask.header("if-range").filter(|v| !v.is_empty()) else {
        return true;
    };
    if if_range.contains('"') {
        return if_range.contains(etag);
    }
    match (parse_http_date(last_modified), parse_http_date(if_range)) {
        (Some(modified), Some(since)) => modified <= since,
        _ => false,
    }
}

/// The router's fallback: the site when one is installed, else the empty
/// 404 this server has always answered an unknown path with.
pub(super) async fn fallback(req: Request) -> Response {
    let Some(site) = installed() else {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_FOUND;
        return response;
    };
    let (parts, _) = req.into_parts();
    let ask = Ask {
        method: &parts.method,
        path: parts.uri.path(),
        query: parts.uri.query(),
        headers: &parts.headers,
    };
    site.respond(&ask).await
}

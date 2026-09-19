//! Phase 4, batch 6: `GET /api/favicon?host=` (app/api/favicon/route.ts),
//! the server-side favicon proxy the Manual Apps page uses so the browser
//! never pings a source-URL host itself. `https://HOST/favicon.ico` first
//! — most sites have one, and a healthy site is answered in one round
//! trip — else the site root is read for a `<link rel="icon">`. Both go
//! through the transport, so the host is public and the bytes are capped.
//! Hits are remembered for a day and misses for an hour in a per-process
//! cache of five hundred hosts, halved when full; a restart forgets it,
//! as Node's does. Gated by `core/tests/fixtures/leftovers-cases.json`.
use super::routes_stats::{get, Params};
use crate::{
    jsstr::js_trim,
    outbound::{self, Fetcher, PublicHttp, Request},
};
use axum::{body::Body, extract::Query, http::StatusCode, response::Response};
use regex::Regex;
use std::sync::{Mutex, OnceLock};
use url::Url;

const HIT_TTL_MS: i64 = 24 * 60 * 60_000;
const MISS_TTL_MS: i64 = 60 * 60_000;
/// Most favicons are under 10 KiB; anything bigger is the wrong asset.
const MAX_FAVICON_BYTES: usize = 256 * 1024;
const MAX_HTML_BYTES: usize = 512 * 1024;
/// A slow host gets a fallback glyph, not a blocked page.
const FETCH_TIMEOUT_MS: u64 = 4000;
const CACHE_CAP: usize = 512;
const USER_AGENT: &str = "Mozilla/5.0 privacytracker-favicon/1.0";

#[derive(Clone)]
struct CacheEntry {
    body: Vec<u8>,
    content_type: String,
    expires_at: i64,
    hit: bool,
}

/// Insertion-ordered, as a JavaScript `Map` is: an entry set again keeps
/// its place, and halving drops the oldest half.
fn cache() -> &'static Mutex<Vec<(String, CacheEntry)>> {
    static CACHE: OnceLock<Mutex<Vec<(String, CacheEntry)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn remember(host: &str, entry: CacheEntry) -> CacheEntry {
    let mut cache = super::lifecycle::lock_state(cache());
    match cache.iter_mut().find(|(h, _)| h == host) {
        Some((_, slot)) => *slot = entry.clone(),
        None => cache.push((host.to_string(), entry.clone())),
    }
    if cache.len() > CACHE_CAP {
        let drop = cache.len().div_ceil(2);
        cache.drain(..drop);
    }
    entry
}

fn lookup(host: &str, now: i64) -> Option<CacheEntry> {
    let mut cache = super::lifecycle::lock_state(cache());
    let index = cache.iter().position(|(h, _)| h == host)?;
    if now > cache[index].1.expires_at {
        cache.remove(index);
        return None;
    }
    Some(cache[index].1.clone())
}

/// `resolveHost`: a bare hostname, a full URL or a `//host` — lowercased,
/// wrapped in `https://` where needed, and only kept when the validator
/// would let a fetch reach it. The `host` includes a non-default port.
fn resolve_host(raw: Option<&str>) -> Option<String> {
    let trimmed = js_trim(raw?).to_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    let probe = if trimmed.contains("://") {
        trimmed
    } else if let Some(rest) = trimmed.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        format!("https://{trimmed}")
    };
    let url = outbound::validate(&probe, &[], 2048).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn link_tags() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<link(?-u:\b)[^>]*>").unwrap())
}
fn rel_attr() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?-u:\b)rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
    })
}
fn href_attr() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?-u:\b)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
    })
}

/// `relMatch[1] ?? relMatch[2] ?? relMatch[3] ?? ""`: whichever quoting
/// matched.
fn attr_value<'a>(re: &Regex, tag: &'a str) -> Option<&'a str> {
    let caps = re.captures(tag)?;
    Some(
        caps.get(1)
            .or_else(|| caps.get(2))
            .or_else(|| caps.get(3))
            .map_or("", |m| m.as_str()),
    )
}

/// `extractIconFromHtml`: the best `<link rel>` — `icon` over `shortcut
/// icon` over the Apple touch icons, the first of equals — resolved
/// against the page's final URL. A regex scan, not a parser: only link
/// tags matter.
pub(super) fn extract_icon_from_html(html: &str, base_url: &str) -> Option<String> {
    let mut best: Option<(u8, String)> = None;
    for tag in link_tags().find_iter(html) {
        let tag = tag.as_str();
        let (Some(rel), Some(href)) = (attr_value(rel_attr(), tag), attr_value(href_attr(), tag))
        else {
            continue;
        };
        let rel = js_trim(rel).to_lowercase();
        let href = js_trim(href);
        if rel.is_empty() || href.is_empty() {
            continue;
        }
        let score = match rel.as_str() {
            "icon" => 3,
            "shortcut icon" => 2,
            "apple-touch-icon" | "apple-touch-icon-precomposed" => 1,
            _ => continue,
        };
        if best.as_ref().map_or(true, |(s, _)| score > *s) {
            best = Some((score, href.to_string()));
        }
    }
    let (_, href) = best?;
    Url::parse(base_url)
        .ok()?
        .join(&href)
        .ok()
        .map(|u| u.to_string())
}

fn request(url: String, max_bytes: usize) -> Request {
    let mut request = Request::public(url, max_bytes, FETCH_TIMEOUT_MS);
    request.headers = vec![("user-agent".to_string(), USER_AGENT.to_string())];
    request
}

/// `discoverIconUrl`: the site root, parsed for an icon. Nothing on any
/// failure; the caller falls back.
async fn discover_icon_url(fetcher: &dyn Fetcher, host: &str) -> Option<String> {
    let reply = fetcher
        .fetch(request(format!("https://{host}/"), MAX_HTML_BYTES))
        .await
        .ok()?;
    if !reply.ok() {
        return None;
    }
    extract_icon_from_html(&String::from_utf8_lossy(&reply.body), &reply.final_url)
}

/// `fetchIconBytes`: the bytes and a content type, or nothing. A body
/// that claims to be an image is taken at its word; one with a bogus or
/// missing type is taken if it looks binary, as `image/x-icon`; a 200
/// HTML "not found" page is not an image.
async fn fetch_icon_bytes(fetcher: &dyn Fetcher, icon_url: String) -> Option<(Vec<u8>, String)> {
    let reply = fetcher
        .fetch(request(icon_url, MAX_FAVICON_BYTES))
        .await
        .ok()?;
    if !reply.ok() || reply.body.is_empty() {
        return None;
    }
    let content_type = reply
        .header("content-type")
        .unwrap_or("")
        .split(';')
        .next()
        .map(js_trim)
        .unwrap_or("")
        .to_lowercase();
    let is_image = content_type.starts_with("image/")
        || content_type == "application/ico"
        || content_type == "application/x-ico";
    let looks_binary = reply.body.first().is_some_and(|b| *b > 0x7f);
    if !(is_image || looks_binary) {
        return None;
    }
    let safe = if !content_type.is_empty() && is_image {
        content_type
    } else {
        "image/x-icon".to_string()
    };
    Some((reply.body, safe))
}

fn hit_response(entry: &CacheEntry) -> Response {
    let content_type = if entry.content_type.is_empty() {
        "image/x-icon"
    } else {
        &entry.content_type
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type)
        .header("cache-control", "public, max-age=86400, immutable")
        .header("x-favicon-cache", "HIT")
        .body(Body::from(entry.body.clone()))
        .unwrap()
}

fn miss_response() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("cache-control", "public, max-age=3600")
        .header("x-favicon-cache", "MISS")
        .body(Body::empty())
        .unwrap()
}

pub(super) async fn favicon_with(q: &Params, fetcher: &dyn Fetcher, now: i64) -> Response {
    let Some(host) = resolve_host(get(q, "host")) else {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("cache-control", "no-store")
            .body(Body::empty())
            .unwrap();
    };
    if let Some(cached) = lookup(&host, now) {
        return if cached.hit {
            hit_response(&cached)
        } else {
            miss_response()
        };
    }
    let mut icon = fetch_icon_bytes(fetcher, format!("https://{host}/favicon.ico")).await;
    if icon.is_none() {
        if let Some(discovered) = discover_icon_url(fetcher, &host).await {
            icon = fetch_icon_bytes(fetcher, discovered).await;
        }
    }
    let Some((body, content_type)) = icon else {
        remember(
            &host,
            CacheEntry {
                body: Vec::new(),
                content_type: String::new(),
                expires_at: now + MISS_TTL_MS,
                hit: false,
            },
        );
        return miss_response();
    };
    let entry = remember(
        &host,
        CacheEntry {
            body,
            content_type,
            expires_at: now + HIT_TTL_MS,
            hit: true,
        },
    );
    hit_response(&entry)
}

pub async fn favicon(Query(q): Query<Params>) -> Response {
    favicon_with(&q, &PublicHttp, super::now_ms()).await
}

/// The cache is one per process, and so one per test binary: every test
/// that touches it holds this, so the replay's cache cases and the unit
/// test below cannot interleave.
#[cfg(test)]
pub(super) fn test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_resolve_as_node_resolves_them() {
        assert_eq!(
            resolve_host(Some(" Example.COM ")).as_deref(),
            Some("example.com")
        );
        assert_eq!(
            resolve_host(Some("https://example.com:8443/path?q=1")).as_deref(),
            Some("example.com:8443")
        );
        assert_eq!(
            resolve_host(Some("//cdn.example.com")).as_deref(),
            Some("cdn.example.com")
        );
        assert_eq!(
            resolve_host(Some("http://example.com:443/")).as_deref(),
            Some("example.com:443")
        );
        assert_eq!(
            resolve_host(Some("https://example.com:443/")).as_deref(),
            Some("example.com")
        );
        assert_eq!(resolve_host(Some("127.0.0.1")), None);
        assert_eq!(resolve_host(Some("ftp://example.com")), None);
        assert_eq!(resolve_host(Some("   ")), None);
        assert_eq!(resolve_host(None), None);
    }

    #[test]
    fn the_best_link_wins_and_resolves_against_the_final_url() {
        let html = r#"<html><head>
            <link rel="apple-touch-icon" href="/apple.png">
            <LINK REL='shortcut icon' HREF='old.ico'>
            <link rel=icon href=icons/fav.svg type="image/svg+xml">
            <link rel="stylesheet" href="/s.css">
            <link rel="icon" href="/second-icon.png">
        </head></html>"#;
        assert_eq!(
            extract_icon_from_html(html, "https://www.example.com/dir/page").as_deref(),
            Some("https://www.example.com/dir/icons/fav.svg")
        );
        assert_eq!(
            extract_icon_from_html(
                "<link rel=\"shortcut icon\" href=\"//c.example.com/i.ico\">",
                "https://example.com/"
            ),
            Some("https://c.example.com/i.ico".to_string())
        );
        assert_eq!(
            extract_icon_from_html("<link rel=\"icon\">", "https://example.com/"),
            None
        );
        assert_eq!(
            extract_icon_from_html("<p>no links</p>", "https://example.com/"),
            None
        );
    }

    #[test]
    fn the_cache_keeps_insertion_order_and_halves_when_full() {
        let _cache = test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let entry = |t: i64| CacheEntry {
            body: vec![1],
            content_type: "image/png".into(),
            expires_at: t,
            hit: true,
        };
        {
            cache().lock().unwrap().clear();
        }
        for i in 0..CACHE_CAP {
            remember(&format!("h{i}.test"), entry(10));
        }
        assert_eq!(cache().lock().unwrap().len(), CACHE_CAP);
        // Re-setting an old host keeps its place at the front.
        remember("h0.test", entry(20));
        assert_eq!(cache().lock().unwrap()[0].0, "h0.test");
        remember("overflow.test", entry(10));
        let kept = cache().lock().unwrap().len();
        assert_eq!(kept, CACHE_CAP + 1 - (CACHE_CAP + 1).div_ceil(2));
        assert!(lookup("h0.test", 0).is_none());
        assert!(lookup("overflow.test", 5).is_some());
        assert!(
            lookup("overflow.test", 11).is_none(),
            "expired entries are dropped"
        );
        cache().lock().unwrap().clear();
    }
}

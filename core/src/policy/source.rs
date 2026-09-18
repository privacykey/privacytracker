//! `fetchPrivacyPolicySource` from `lib/privacy-policy.ts`: a policy URL to
//! a validated text, through the locale rewrite, the three-tier fetch
//! ladder, the HTML-level redirects and the Google consent bypass, the
//! policy-link second hop, extraction and validation. Stateless: no
//! database, no clock. Every trace event Node logs is emitted here in the
//! same order with the same wording, because batch 2 persists them as the
//! run log the AI Policy tab renders.
//!
//! Two things Node does by accident are done here on purpose. A reply
//! without a Content-Type is read as `text/plain;charset=utf-8`, because
//! Node re-wraps the fetched bytes in a `Response` whose string body undici
//! stamps with that type — so the "empty content type looks like HTML"
//! branch never runs there either. And a body is decoded as
//! `Response.text()` decodes it, UTF-8 with a leading byte order mark
//! removed, except on the policy-link hop, which reads the buffer directly
//! and keeps one.
use super::{
    diag::{
        classify_network_error, diagnostics, hints_for_http_status, is_retryable_fetch_error,
        SourceError,
    },
    locale_int,
    text::{
        count_policy_topic_hits, count_words, extract_policy_text_from_html, js,
        normalize_extracted_text, POLICY_MIN_CHARS, POLICY_MIN_TOPIC_HITS, POLICY_MIN_WORDS,
        WS_CHARS,
    },
    url::{normalize_policy_url_language, pin_google_locale, safe_url_label, search_param_get},
};
use crate::{
    jsstr::{js_encode_uri_component, js_length, js_slice_prefix},
    outbound::{self, Fetcher, Reply, Request},
    scrape::js::truthy,
};
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::OnceLock};
use url::Url;

pub const POLICY_FETCH_MAX_BYTES: usize = 6 * 1024 * 1024;
pub const WAYBACK_FETCH_MAX_BYTES: usize = 8 * 1024 * 1024;
const WAYBACK_AVAILABILITY_MAX_BYTES: usize = 512 * 1024;
/// The policy layer's own allowlist for archive fetches (two hosts, not the
/// importer's three).
pub const WAYBACK_HOSTS: &[&str] = &["archive.org", "web.archive.org"];
const HTTP_BLOCK_CODES: [u16; 7] = [401, 403, 405, 406, 429, 451, 503];
const MAX_META_HOPS: usize = 3;

pub const POLICY_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";
const DIRECT_HEADERS: [(&str, &str); 3] = [
    ("User-Agent", POLICY_USER_AGENT),
    ("Accept-Language", "en-US,en;q=0.9"),
    (
        "Accept",
        "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    ),
];
/// `POLICY_BROWSER_HEADERS`, in Node's order.
pub const POLICY_BROWSER_HEADERS: [(&str, &str); 10] = [
    (
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ),
    (
        "Accept",
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    ),
    ("Accept-Language", "en-US,en;q=0.9"),
    ("Accept-Encoding", "gzip, deflate, br"),
    ("Sec-Fetch-Dest", "document"),
    ("Sec-Fetch-Mode", "navigate"),
    ("Sec-Fetch-Site", "cross-site"),
    ("Sec-Fetch-User", "?1"),
    ("Upgrade-Insecure-Requests", "1"),
    ("Referer", "https://apps.apple.com/"),
];

/// `PolicySourceOrigin`: which tier of the ladder produced the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Direct,
    BrowserRetry,
    Wayback,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Direct => "direct",
            Origin::BrowserRetry => "browser_retry",
            Origin::Wayback => "wayback",
        }
    }
    fn rank(self) -> u8 {
        match self {
            Origin::Direct => 0,
            Origin::BrowserRetry => 1,
            Origin::Wayback => 2,
        }
    }
    /// `mergeSourceOrigin`: the strictest of a chain wins.
    pub fn merge(current: Origin, next: Origin) -> Origin {
        if next.rank() >= current.rank() {
            next
        } else {
            current
        }
    }
}

/// One `logger.event(phase, { note } | { error } | {})`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub phase: String,
    pub note: Option<String>,
    pub error: Option<String>,
}

impl Event {
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("phase".into(), json!(self.phase));
        if let Some(n) = &self.note {
            out.insert("note".into(), json!(n));
        }
        if let Some(e) = &self.error {
            out.insert("error".into(), json!(e));
        }
        Value::Object(out)
    }
}

/// `PolicyFetchLogger`: what the fetch stack traces into. [`Trace`] keeps
/// the events (the manual-app scrape passes no logger, and the source
/// replay reads them back); the policy store's run logger stamps each with
/// the time and persists the log as it grows, as Node's does.
pub trait PolicyLog: Send {
    fn event(&mut self, phase: &str, note: Option<String>, error: Option<String>);
}

impl dyn PolicyLog + '_ {
    pub(crate) fn note(&mut self, phase: &str, note: impl Into<String>) {
        self.event(phase, Some(note.into()), None);
    }
    pub(crate) fn error(&mut self, phase: &str, error: impl Into<String>) {
        self.event(phase, None, Some(error.into()));
    }
}

/// The events in order, and nothing else.
#[derive(Debug, Default)]
pub struct Trace {
    pub events: Vec<Event>,
}

impl PolicyLog for Trace {
    fn event(&mut self, phase: &str, note: Option<String>, error: Option<String>) {
        self.events.push(Event {
            phase: phase.to_string(),
            note,
            error,
        });
    }
}

impl Trace {
    pub fn to_json(&self) -> Value {
        Value::Array(self.events.iter().map(Event::to_json).collect())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceStatus {
    Ready,
    UnsupportedContentType,
    TooShort,
}

impl SourceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceStatus::Ready => "ready",
            SourceStatus::UnsupportedContentType => "unsupported_content_type",
            SourceStatus::TooShort => "too_short",
        }
    }
}

/// `PolicySourceResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub status: SourceStatus,
    pub title: String,
    pub content_type: String,
    pub text: String,
    pub word_count: usize,
    pub origin: Origin,
    pub final_url: String,
    /// Present on the two failure statuses.
    pub error: Option<String>,
}

impl Source {
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("status".into(), json!(self.status.as_str()));
        out.insert("title".into(), json!(self.title));
        out.insert("contentType".into(), json!(self.content_type));
        out.insert("text".into(), json!(self.text));
        out.insert("wordCount".into(), json!(self.word_count));
        out.insert("origin".into(), json!(self.origin.as_str()));
        out.insert("finalUrl".into(), json!(self.final_url));
        if let Some(e) = &self.error {
            out.insert("error".into(), json!(e));
        }
        Value::Object(out)
    }
}

struct Raw {
    reply: Reply,
    origin: Origin,
    fetched_url: String,
}

fn request(
    url: &str,
    hosts: &[&str],
    headers: &[(&str, &str)],
    timeout_ms: u64,
    max_bytes: usize,
) -> Request {
    let mut req = Request::apple(url.to_string(), hosts, max_bytes, timeout_ms);
    req.headers = headers
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    req
}

/// `Response.text()`: UTF-8, lossy, a leading byte order mark removed.
fn response_text(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    text.strip_prefix('\u{feff}')
        .map_or_else(|| text.to_string(), str::to_string)
}

/// `res.headers.get("content-type") ?? ""` lowercased, on the re-wrapped
/// response — see the module note on the stamped default.
fn wrapped_content_type(reply: &Reply) -> String {
    reply
        .header("content-type")
        .map_or_else(|| "text/plain;charset=utf-8".to_string(), str::to_lowercase)
}

fn looks_like_html(content_type: &str) -> bool {
    content_type.contains("text/html")
        || content_type.contains("application/xhtml+xml")
        || content_type.is_empty()
}

fn maybe_pin_google_locale(url: &str, log: &mut dyn PolicyLog) -> String {
    let Some(pinned) = pin_google_locale(url) else {
        return url.to_string();
    };
    log.note(
        "fetch:pin-google-locale",
        format!(
            "Pinning hl=en&gl=us to bypass EU consent / geo redirect: {} → {}",
            safe_url_label(url),
            safe_url_label(&pinned)
        ),
    );
    pinned
}

/// `fetchPolicyRaw`: the English-normalised URL first, the original on any
/// failure of it.
async fn fetch_policy_raw(
    fetcher: &dyn Fetcher,
    policy_url: &str,
    log: &mut dyn PolicyLog,
) -> Result<Raw, SourceError> {
    let normalized = normalize_policy_url_language(policy_url);
    if normalized == policy_url {
        log.note(
            "fetch:normalize",
            "URL already in preferred language; no rewrite needed.",
        );
    } else {
        log.note(
            "fetch:normalize",
            format!(
                "Rewrote locale → en: {} → {}",
                safe_url_label(policy_url),
                safe_url_label(&normalized)
            ),
        );
        let pinned = maybe_pin_google_locale(&normalized, log);
        match fetch_policy_raw_attempt(fetcher, &pinned, log).await {
            Ok(raw) => return Ok(raw),
            Err(err) => log.note(
                "fetch:normalize-fallback",
                format!(
                    "Normalised URL failed; retrying original. ({})",
                    err.message
                ),
            ),
        }
    }
    let pinned = maybe_pin_google_locale(policy_url, log);
    fetch_policy_raw_attempt(fetcher, &pinned, log).await
}

/// The `catch` around a ladder tier: a retryable failure is noted and the
/// ladder continues, anything else is logged and thrown — a
/// `PolicyFetchError` as it is, a transport error wrapped with the network
/// classification.
fn tier_failure(
    err: SourceError,
    policy_url: &str,
    origin: Origin,
    log: &mut dyn PolicyLog,
    error_phase: &str,
    retryable_phase: &str,
) -> Result<(), SourceError> {
    if is_retryable_fetch_error(&err.message) {
        log.note(retryable_phase, err.message);
        return Ok(());
    }
    log.error(error_phase, err.message.clone());
    if err.is_fetch() {
        return Err(err);
    }
    let (hint, troubleshoot) = classify_network_error(&err.message);
    Err(SourceError::fetch(
        err.message,
        diagnostics(vec![
            ("requestedUrl", Some(json!(policy_url))),
            ("origin", Some(json!(origin.as_str()))),
            ("networkHint", hint.map(|h| json!(h))),
            ("troubleshoot", Some(json!(troubleshoot))),
        ]),
    ))
}

/// `fetchPolicyRawAttempt`: direct with the Safari UA, then Chrome-desktop
/// headers, then the newest Wayback snapshot.
async fn fetch_policy_raw_attempt(
    fetcher: &dyn Fetcher,
    policy_url: &str,
    log: &mut dyn PolicyLog,
) -> Result<Raw, SourceError> {
    if let Err(e) = outbound::validate(policy_url, &[], 2048) {
        return Err(SourceError::plain(format!(
            "Refusing to fetch policy URL: {} ({})",
            e.error, e.detail
        )));
    }

    // Tier 1.
    log.note(
        "fetch:direct",
        format!("GET {}", safe_url_label(policy_url)),
    );
    let direct = fetcher
        .fetch(request(
            policy_url,
            &[],
            &DIRECT_HEADERS,
            20_000,
            POLICY_FETCH_MAX_BYTES,
        ))
        .await;
    let attempt: Result<Option<Raw>, SourceError> = match direct {
        Ok(reply) => {
            let final_url = reply.final_url.clone();
            let redirected = final_url != policy_url;
            log.note(
                "fetch:direct-result",
                format!(
                    "HTTP {}{}",
                    reply.status,
                    if redirected {
                        format!(" · redirected → {}", safe_url_label(&final_url))
                    } else {
                        String::new()
                    }
                ),
            );
            if reply.ok() {
                Ok(Some(Raw {
                    origin: Origin::Direct,
                    fetched_url: final_url,
                    reply,
                }))
            } else if !HTTP_BLOCK_CODES.contains(&reply.status) {
                Err(SourceError::fetch(
                    format!("HTTP {} fetching privacy policy", reply.status),
                    diagnostics(vec![
                        ("httpStatus", Some(json!(reply.status))),
                        ("requestedUrl", Some(json!(policy_url))),
                        ("finalUrl", Some(json!(final_url))),
                        ("origin", Some(json!("direct"))),
                        (
                            "contentType",
                            reply.header("content-type").map(|c| json!(c)),
                        ),
                        (
                            "troubleshoot",
                            Some(json!(hints_for_http_status(reply.status, Some(&final_url)))),
                        ),
                    ]),
                ))
            } else {
                Ok(None)
            }
        }
        Err(message) => Err(SourceError::plain(message)),
    };
    match attempt {
        Ok(Some(raw)) => return Ok(raw),
        Ok(None) => {}
        Err(err) => tier_failure(
            err,
            policy_url,
            Origin::Direct,
            log,
            "fetch:direct-error",
            "fetch:direct-retryable",
        )?,
    }

    // Tier 2.
    log.note(
        "fetch:browser-retry",
        "Retrying with Chrome-desktop headers.",
    );
    let retried = fetcher
        .fetch(request(
            policy_url,
            &[],
            &POLICY_BROWSER_HEADERS,
            20_000,
            POLICY_FETCH_MAX_BYTES,
        ))
        .await;
    match retried {
        Ok(reply) => {
            let final_url = reply.final_url.clone();
            log.note(
                "fetch:browser-retry-result",
                format!(
                    "HTTP {}{}",
                    reply.status,
                    if final_url == policy_url {
                        String::new()
                    } else {
                        format!(" · redirected → {}", safe_url_label(&final_url))
                    }
                ),
            );
            if reply.ok() {
                return Ok(Raw {
                    origin: Origin::BrowserRetry,
                    fetched_url: final_url,
                    reply,
                });
            }
        }
        Err(message) => tier_failure(
            SourceError::plain(message),
            policy_url,
            Origin::BrowserRetry,
            log,
            "fetch:browser-retry-error",
            "fetch:browser-retryable",
        )?,
    }

    // Tier 3.
    log.note(
        "fetch:wayback",
        "Direct + browser retry both blocked; resolving Wayback snapshot.",
    );
    let Some(wayback_url) = resolve_wayback_url(fetcher, policy_url).await else {
        log.error("fetch:wayback-miss", "No Wayback snapshot available.");
        return Err(SourceError::fetch(
            "Privacy policy blocked by the site and no Wayback snapshot is available",
            diagnostics(vec![
                ("requestedUrl", Some(json!(policy_url))),
                ("origin", Some(json!("wayback"))),
                (
                    "troubleshoot",
                    Some(json!([
                        "The developer's site returned a block code (commonly 403) to both our direct and Chrome-headers retry.",
                        "No Internet Archive snapshot was available as a fallback.",
                        "Try opening the URL in a real browser to confirm it still loads — the site may have rate-limited server-side traffic.",
                        "If the site is important, you can submit it to the Wayback Machine manually at web.archive.org/save then re-try.",
                    ])),
                ),
            ]),
        ));
    };
    log.note("fetch:wayback-snapshot", safe_url_label(&wayback_url));
    let reply = fetcher
        .fetch(request(
            &wayback_url,
            WAYBACK_HOSTS,
            &POLICY_BROWSER_HEADERS,
            25_000,
            WAYBACK_FETCH_MAX_BYTES,
        ))
        .await
        .map_err(SourceError::plain)?;
    if !reply.ok() {
        log.error("fetch:wayback-error", format!("HTTP {}", reply.status));
        return Err(SourceError::fetch(
            format!(
                "Wayback fetch failed (HTTP {}) for {}",
                reply.status, policy_url
            ),
            diagnostics(vec![
                ("httpStatus", Some(json!(reply.status))),
                ("requestedUrl", Some(json!(policy_url))),
                ("finalUrl", Some(json!(wayback_url))),
                ("origin", Some(json!("wayback"))),
                (
                    "contentType",
                    reply.header("content-type").map(|c| json!(c)),
                ),
                (
                    "troubleshoot",
                    Some(json!([
                        "The Wayback Machine snapshot itself was unavailable.",
                        "This is usually transient — try again in a few minutes.",
                    ])),
                ),
            ]),
        ));
    }
    Ok(Raw {
        fetched_url: reply.final_url.clone(),
        origin: Origin::Wayback,
        reply,
    })
}

/// `resolveWaybackUrl`: the availability API's closest snapshot, in its
/// raw `id_` view, or nothing for any failure at all.
async fn resolve_wayback_url(fetcher: &dyn Fetcher, original_url: &str) -> Option<String> {
    let api_url = format!(
        "https://archive.org/wayback/available?url={}",
        js_encode_uri_component(original_url)
    );
    let reply = fetcher
        .fetch(request(
            &api_url,
            WAYBACK_HOSTS,
            &[("Accept", "application/json")],
            15_000,
            WAYBACK_AVAILABILITY_MAX_BYTES,
        ))
        .await
        .ok()?;
    if !reply.ok() {
        return None;
    }
    let data: Value = serde_json::from_str(&String::from_utf8_lossy(&reply.body)).ok()?;
    let snapshot = &data["archived_snapshots"]["closest"];
    if truthy(&snapshot["available"]) {
        if let Value::String(url) = &snapshot["url"] {
            static VIEW: OnceLock<Regex> = OnceLock::new();
            let view = VIEW.get_or_init(|| Regex::new(r"/web/([0-9]+)/").unwrap());
            return Some(view.replace(url, "/web/${1}id_/").into_owned());
        }
    }
    None
}

fn resolve(base: &str, relative: &str) -> Option<String> {
    Url::parse(base)
        .ok()?
        .join(relative)
        .ok()
        .map(|u| u.to_string())
}

fn is_http(target: &str) -> bool {
    static HTTP: OnceLock<Regex> = OnceLock::new();
    HTTP.get_or_init(|| Regex::new("(?i)^https?://").unwrap())
        .is_match(target)
}

/// `extractMetaRefreshTarget`.
fn extract_meta_refresh_target(html: &str, base_url: &str) -> Option<String> {
    static META: OnceLock<Regex> = OnceLock::new();
    let meta = META.get_or_init(|| {
        js(&format!(
            r#"(?i)<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']\s*[0-9]+\s*;\s*url\s*=\s*["']?([^"'>{WS_CHARS}]+)["']?"#
        ))
    });
    let m = meta.captures(html)?;
    let target = resolve(base_url, &m[1])?;
    if target == base_url || !is_http(&target) {
        return None;
    }
    Some(target)
}

/// `extractScriptLocationTarget`: the first `<script>` block with a literal
/// location assignment or `replace` / `assign` call.
fn extract_script_location_target(html: &str, base_url: &str) -> Option<String> {
    static BLOCKS: OnceLock<Regex> = OnceLock::new();
    static ASSIGN: OnceLock<Regex> = OnceLock::new();
    static CALL: OnceLock<Regex> = OnceLock::new();
    let blocks =
        BLOCKS.get_or_init(|| js(r"(?i)<script(?-u:\b)[^>]*>[\s\S]*?</script(?-u:\b)[^>]*>"));
    let assign = ASSIGN.get_or_init(|| {
        js(r#"(?i)(?:window\.|document\.|top\.|self\.|parent\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']"#)
    });
    let call = CALL.get_or_init(|| {
        js(r#"(?i)(?:window\.|document\.|top\.|self\.|parent\.)?location\.(?:replace|assign)\s*\(\s*["']([^"']+)["']\s*\)"#)
    });
    for block in blocks.find_iter(html) {
        let block = block.as_str();
        let Some(m) = assign.captures(block).or_else(|| call.captures(block)) else {
            continue;
        };
        let Some(target) = resolve(base_url, &m[1]) else {
            continue;
        };
        if target == base_url || !is_http(&target) {
            continue;
        }
        return Some(target);
    }
    None
}

/// `extractHtmlRedirectTarget`: meta refresh first, then a script redirect.
fn extract_html_redirect_target(html: &str, base_url: &str) -> Option<(&'static str, String)> {
    if let Some(meta) = extract_meta_refresh_target(html, base_url) {
        return Some(("meta-refresh", meta));
    }
    extract_script_location_target(html, base_url).map(|t| ("js-redirect", t))
}

/// `detectGoogleConsentHandoff`: the bypass URL for a consent wall, or
/// nothing when the page is not one, or the wall's `continue` is not a
/// Google property.
fn detect_google_consent_handoff(html: &str, fetched_url: &str) -> Option<String> {
    let parsed = Url::parse(fetched_url).ok()?;
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let is_consent_host = host == "consent.google.com" || host.ends_with(".consent.google.com");
    static MARKUP: OnceLock<[Regex; 3]> = OnceLock::new();
    let markup = MARKUP.get_or_init(|| {
        [
            Regex::new("(?i)Before you continue to Google").unwrap(),
            Regex::new(r"(?i)consent\.google\.com/save").unwrap(),
            Regex::new(r#"(?i)id="consent-bump""#).unwrap(),
        ]
    });
    let looks_like_consent_markup = markup.iter().any(|m| m.is_match(html));
    if !(is_consent_host || looks_like_consent_markup) {
        return None;
    }
    let continue_url = search_param_get(&parsed, "continue");
    let target = match continue_url {
        Some(c) if !c.is_empty() && is_http(&c) => {
            let target_host = Url::parse(&c).ok()?.host_str().unwrap_or("").to_lowercase();
            if !(target_host == "google.com" || target_host.ends_with(".google.com")) {
                return None;
            }
            c
        }
        _ if host == "google.com" || host.ends_with(".google.com") => format!(
            "{}://{}{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or(""),
            parsed.path()
        ),
        _ => return None,
    };
    let mut out = Url::parse(&target).ok()?;
    super::url::search_param_set(&mut out, "hl", "en");
    super::url::search_param_set(&mut out, "gl", "us");
    Some(out.to_string())
}

/// `validateSource`.
fn validate_source(
    title: String,
    content_type: String,
    text: String,
    origin: Origin,
    final_url: String,
) -> Source {
    let word_count = count_words(&text);
    let failure = |error: &str| Source {
        status: SourceStatus::TooShort,
        title: title.clone(),
        content_type: content_type.clone(),
        text: text.clone(),
        word_count,
        origin,
        final_url: final_url.clone(),
        error: Some(error.to_string()),
    };
    if word_count < POLICY_MIN_WORDS || js_length(&text) < POLICY_MIN_CHARS {
        return failure("The fetched privacy-policy text was too short to summarize reliably.");
    }
    if count_policy_topic_hits(&text) < POLICY_MIN_TOPIC_HITS {
        return failure("Source page does not look like a privacy policy (no privacy clauses found in the extracted text).");
    }
    Source {
        status: SourceStatus::Ready,
        title,
        content_type,
        text,
        word_count,
        origin,
        final_url,
        error: None,
    }
}

/// `maybeFollowPolicyLink`: when the page is short and links to a policy
/// on the same host, one more fetch; the longer text if it is longer.
async fn maybe_follow_policy_link(
    fetcher: &dyn Fetcher,
    html: &str,
    base_url: &str,
    current_text: &str,
    log: &mut dyn PolicyLog,
) -> Option<String> {
    let current_len = js_length(current_text);
    if current_len >= POLICY_MIN_CHARS {
        return None;
    }
    static LINK: OnceLock<Regex> = OnceLock::new();
    let link = LINK.get_or_init(|| {
        js(r##"(?i)<a\s+[^>]*href="([^"#?]+(?:\?[^"#]*)?)"[^>]*>\s*(?:(?:read|view|see|open)[^<]*)?(?:full|complete|detailed)?\s*(?:privacy\s*(?:policy|notice|statement))[^<]*</a>"##)
    });
    let Some(m) = link.captures(html) else {
        log.note(
            "fetch:follow-link-skip",
            format!(
                "Page only has {} chars but no \"Privacy Policy\" link to follow.",
                locale_int(current_len)
            ),
        );
        return None;
    };
    let original_href = resolve(base_url, &m[1])?;
    let href = normalize_policy_url_language(&original_href);
    if href != original_href {
        log.note(
            "fetch:follow-link-normalize",
            format!(
                "Rewrote link locale → en: {} → {}",
                safe_url_label(&original_href),
                safe_url_label(&href)
            ),
        );
    }
    let current = Url::parse(&normalize_policy_url_language(base_url)).ok()?;
    let target = Url::parse(&href).ok()?;
    if target.host_str() != current.host_str() {
        log.note(
            "fetch:follow-link-skip",
            format!(
                "Cross-host link not followed: {} (base {}).",
                safe_url_label(&href),
                current.host_str().unwrap_or("")
            ),
        );
        return None;
    }
    if target.as_str() == current.as_str() {
        return None;
    }
    log.note("fetch:follow-link-attempt", safe_url_label(&href));

    if let Err(e) = outbound::validate(&href, &[], 2048) {
        log.error("fetch:follow-link-rejected", e.error);
        return None;
    }
    match fetcher
        .fetch(request(
            &href,
            &[],
            &POLICY_BROWSER_HEADERS,
            15_000,
            POLICY_FETCH_MAX_BYTES,
        ))
        .await
    {
        Ok(reply) => {
            if !reply.ok() {
                log.error("fetch:follow-link-http", format!("HTTP {}", reply.status));
                return None;
            }
            // `bodyBuf.toString("utf8")`: no Response wrapper, no BOM strip.
            let next_html = String::from_utf8_lossy(&reply.body);
            match extract_policy_text_from_html(&next_html, &safe_url_label(&href)) {
                Ok((_, text)) => {
                    if js_length(&text) > current_len {
                        return Some(text);
                    }
                    log.note(
                        "fetch:follow-link-shorter",
                        format!(
                            "Followed link but extracted {} chars ≤ current {}.",
                            locale_int(js_length(&text)),
                            locale_int(current_len)
                        ),
                    );
                }
                Err(message) => {
                    log.error("fetch:follow-link-error", message);
                    return None;
                }
            }
        }
        Err(message) => {
            log.error("fetch:follow-link-error", message);
            return None;
        }
    }
    None
}

/// `fetchPrivacyPolicySource`.
pub async fn fetch_privacy_policy_source(
    fetcher: &dyn Fetcher,
    policy_url: &str,
    log: &mut dyn PolicyLog,
) -> Result<Source, SourceError> {
    let raw = fetch_policy_raw(fetcher, policy_url, log).await?;
    let mut origin = raw.origin;
    let mut fetched_url = raw.fetched_url;
    let mut content_type = wrapped_content_type(&raw.reply);
    let title_from_url = safe_url_label(policy_url);

    if content_type.contains("text/plain") {
        let text = normalize_extracted_text(&response_text(&raw.reply.body));
        log.note(
            "fetch:plain-text",
            format!("{} chars, no HTML follow-up.", locale_int(js_length(&text))),
        );
        return Ok(validate_source(
            title_from_url,
            content_type,
            text,
            origin,
            fetched_url,
        ));
    }

    if !looks_like_html(&content_type) {
        let shown = if content_type.is_empty() {
            "unknown"
        } else {
            content_type.as_str()
        };
        log.error(
            "fetch:unsupported-type",
            format!("Unsupported content type: {shown}"),
        );
        return Ok(Source {
            status: SourceStatus::UnsupportedContentType,
            title: title_from_url,
            content_type: content_type.clone(),
            text: String::new(),
            word_count: 0,
            origin,
            final_url: fetched_url,
            error: Some(format!("Unsupported privacy-policy content type: {shown}")),
        });
    }

    let mut html = response_text(&raw.reply.body);
    log.note(
        "fetch:html",
        format!(
            "Received {} bytes at {}.",
            locale_int(js_length(&html)),
            safe_url_label(&fetched_url)
        ),
    );

    if let Some(consent_rewrite) = detect_google_consent_handoff(&html, &fetched_url) {
        log.note(
            "fetch:consent-wall",
            format!(
                "Google consent wall detected; bypassing → {}",
                safe_url_label(&consent_rewrite)
            ),
        );
        match fetch_policy_raw(fetcher, &consent_rewrite, log).await {
            Ok(bypass) => {
                let bypass_type = wrapped_content_type(&bypass.reply);
                if looks_like_html(&bypass_type) {
                    origin = Origin::merge(origin, bypass.origin);
                    fetched_url = bypass.fetched_url;
                    content_type = bypass_type;
                    html = response_text(&bypass.reply.body);
                    log.note(
                        "fetch:consent-bypass",
                        format!(
                            "Bypass succeeded at {} ({} bytes).",
                            safe_url_label(&fetched_url),
                            locale_int(js_length(&html))
                        ),
                    );
                } else {
                    log.error(
                        "fetch:consent-bypass",
                        format!("Bypass returned non-HTML content type: {bypass_type}"),
                    );
                }
            }
            Err(err) => log.error("fetch:consent-bypass", err.message),
        }
    }

    let mut visited: HashSet<String> = HashSet::from([fetched_url.clone()]);
    for hop in 0..MAX_META_HOPS {
        let Some((kind, target)) = extract_html_redirect_target(&html, &fetched_url) else {
            break;
        };
        if visited.contains(&target) {
            break;
        }
        visited.insert(target.clone());
        log.note(
            &format!("fetch:{kind}-hop"),
            format!("Hop {}: {}", hop + 1, safe_url_label(&target)),
        );
        match fetch_policy_raw(fetcher, &target, log).await {
            Ok(next) => {
                let next_type = wrapped_content_type(&next.reply);
                if !looks_like_html(&next_type) {
                    log.note(
                        "fetch:redirect-non-html",
                        format!("Stopping hop chain — next content type is {next_type}."),
                    );
                    break;
                }
                origin = Origin::merge(origin, next.origin);
                fetched_url = next.fetched_url;
                content_type = next_type;
                html = response_text(&next.reply.body);
            }
            Err(err) => {
                log.error("fetch:redirect-failed", err.message);
                break;
            }
        }
    }

    let (title, text) =
        extract_policy_text_from_html(&html, &title_from_url).map_err(SourceError::range)?;
    log.note(
        "fetch:extracted",
        format!(
            "Title \"{}\" · {} chars after chrome strip.",
            js_slice_prefix(&title, 80),
            locale_int(js_length(&text))
        ),
    );

    let enriched = maybe_follow_policy_link(fetcher, &html, &fetched_url, &text, log).await;
    if let Some(e) = &enriched {
        log.note(
            "fetch:follow-link",
            format!(
                "Second-hop enrichment yielded {} chars (was {}).",
                locale_int(js_length(e)),
                locale_int(js_length(&text))
            ),
        );
    }

    Ok(validate_source(
        title,
        if content_type.is_empty() {
            "text/html".to_string()
        } else {
            content_type
        },
        enriched.unwrap_or(text),
        origin,
        fetched_url,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_targets_and_consent_detection() {
        assert_eq!(
            extract_meta_refresh_target(
                r#"<meta http-equiv=refresh content="5;URL=/legal/privacy">"#,
                "https://example.com/privacy"
            )
            .as_deref(),
            Some("https://example.com/legal/privacy")
        );
        assert_eq!(
            extract_meta_refresh_target(
                r#"<meta http-equiv="refresh" content="0; url=javascript:alert(1)">"#,
                "https://example.com/privacy"
            ),
            None
        );
        assert_eq!(
            extract_script_location_target(
                r#"<script>document.location = '/p3';</script>"#,
                "https://example.com/privacy"
            )
            .as_deref(),
            Some("https://example.com/p3")
        );
        assert_eq!(
            detect_google_consent_handoff(
                "<h1>Before you continue to Google</h1>",
                "https://consent.google.com/m?continue=https%3A%2F%2Fpolicies.google.com%2Fprivacy"
            )
            .as_deref(),
            Some("https://policies.google.com/privacy?hl=en&gl=us")
        );
        assert_eq!(
            detect_google_consent_handoff(
                "<h1>Before you continue to Google</h1>",
                "https://consent.google.com/m?continue=https%3A%2F%2Fevil.example%2F"
            ),
            None
        );
        assert_eq!(
            detect_google_consent_handoff("<p>plain</p>", "https://example.com/"),
            None
        );
    }

    #[test]
    fn text_decoding_strips_a_leading_bom() {
        assert_eq!(response_text("\u{feff}abc".as_bytes()), "abc");
        assert_eq!(response_text(b"abc"), "abc");
        assert_eq!(
            Origin::merge(Origin::Wayback, Origin::Direct),
            Origin::Wayback
        );
        assert_eq!(
            Origin::merge(Origin::Direct, Origin::BrowserRetry),
            Origin::BrowserRetry
        );
    }
}

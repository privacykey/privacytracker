//! What the source layer throws: `PolicyFetchError` with its structured
//! `PolicyFetchDiagnostics`, the plain `Error`s around it, and the
//! classifiers that fill the diagnostics in (`hintsForHttpStatus`,
//! `classifyNetworkError`, `isRetryableFetchError`).
//!
//! The diagnostics object is built literally at each throw site, in that
//! site's key order and without its absent keys, because batch 2 persists
//! it as `detail.fetchDiagnostics` on the activity row, where order shows.
use super::url::safe_url_label;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

/// An error out of `fetchPrivacyPolicySource`: its constructor name, its
/// message and, for a `PolicyFetchError`, its diagnostics.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceError {
    pub name: &'static str,
    pub message: String,
    pub diagnostics: Option<Value>,
}

impl SourceError {
    /// A plain `Error`.
    pub fn plain(message: impl Into<String>) -> Self {
        Self {
            name: "Error",
            message: message.into(),
            diagnostics: None,
        }
    }
    /// A `RangeError` (`String.fromCodePoint` on an entity past U+10FFFF).
    pub fn range(message: impl Into<String>) -> Self {
        Self {
            name: "RangeError",
            message: message.into(),
            diagnostics: None,
        }
    }
    /// A `PolicyFetchError`.
    pub fn fetch(message: impl Into<String>, diagnostics: Value) -> Self {
        Self {
            name: "PolicyFetchError",
            message: message.into(),
            diagnostics: Some(diagnostics),
        }
    }
    pub fn is_fetch(&self) -> bool {
        self.name == "PolicyFetchError"
    }
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("name".into(), json!(self.name));
        out.insert("message".into(), json!(self.message));
        if let Some(d) = &self.diagnostics {
            out.insert("diagnostics".into(), d.clone());
        }
        Value::Object(out)
    }
}

/// A diagnostics object in the given key order, skipping absent values.
pub(crate) fn diagnostics(pairs: Vec<(&str, Option<Value>)>) -> Value {
    let mut out = Map::new();
    for (key, value) in pairs {
        if let Some(v) = value {
            out.insert(key.to_string(), v);
        }
    }
    Value::Object(out)
}

/// `hintsForHttpStatus`.
pub fn hints_for_http_status(status: u16, final_url: Option<&str>) -> Vec<String> {
    let url_label = final_url.map_or_else(|| "the developer's site".to_string(), safe_url_label);
    let mut hints: Vec<String> = Vec::new();
    match status {
        401 => {
            hints.push("The site requires authentication before serving the policy page — likely an intranet link that shouldn't be public.".into());
            hints.push("Ask the developer to host the policy at a public URL.".into());
        }
        403 => {
            hints.push(format!(
                "{url_label} is rejecting automated requests. The Chrome-header retry and Wayback fallback both failed."
            ));
            hints.push("Open the URL in a real browser — if it loads there, the site is specifically blocking server traffic (CloudFlare bot-fight, Akamai, etc.).".into());
            hints.push("If the URL is still correct, submit it to the Wayback Machine (web.archive.org/save) and re-try the scrape in an hour.".into());
        }
        404 => {
            hints.push("The policy URL returned Not Found. The developer may have moved or renamed the page.".into());
            hints.push(
                "Verify the developer's current privacy-policy link on the App Store listing."
                    .into(),
            );
        }
        405 | 406 => {
            hints.push("The site rejected our request method or Accept header. Usually a CDN quirk — try again after a minute.".into());
        }
        410 => {
            hints.push("The policy URL is explicitly marked Gone by the server. The developer has retired this page — App Store listing may be out of date.".into());
        }
        429 => {
            hints.push("Rate-limited. Wait a few minutes and re-sync, or stagger bulk syncs with a longer delay.".into());
        }
        451 => {
            hints.push("Content blocked for legal reasons in this jurisdiction. Try fetching from a different region.".into());
        }
        500 | 502 | 503 | 504 => {
            hints.push(
                "Upstream server is unhealthy. Usually transient — retry in 5–10 minutes.".into(),
            );
        }
        s if s >= 500 => {
            hints.push("Upstream server error. Usually transient.".into());
        }
        s if s >= 400 => {
            hints.push(format!(
                "Server returned HTTP {s}. Verify the URL still works in a real browser."
            ));
        }
        _ => {}
    }
    hints
}

fn re(source: &str) -> Regex {
    Regex::new(source).expect("static regex")
}

/// `classifyNetworkError`: a `networkHint` and the remediation lines for a
/// message shaped as `safeFetch` / undici shape them.
pub fn classify_network_error(message: &str) -> (Option<&'static str>, Vec<String>) {
    static TIMEOUT: OnceLock<Regex> = OnceLock::new();
    static DNS: OnceLock<Regex> = OnceLock::new();
    static RESET: OnceLock<Regex> = OnceLock::new();
    static NETWORK: OnceLock<Regex> = OnceLock::new();
    if TIMEOUT
        .get_or_init(|| re("(?i)timeout|ETIMEDOUT|aborted"))
        .is_match(message)
    {
        return (
            Some("timeout"),
            vec!["Server took too long to respond — retry later, or the site may block server traffic entirely.".into()],
        );
    }
    if DNS
        .get_or_init(|| re("(?i)ENOTFOUND|EAI_AGAIN"))
        .is_match(message)
    {
        return (
            Some("dns"),
            vec!["Hostname did not resolve. Verify the policy URL is still live on the developer's site.".into()],
        );
    }
    if RESET
        .get_or_init(|| re("(?i)ECONNRESET|ECONNREFUSED|socket hang up"))
        .is_match(message)
    {
        return (
            Some("connection_reset"),
            vec!["Connection was reset mid-request. The site may be rate-limiting or require a proxy.".into()],
        );
    }
    if NETWORK
        .get_or_init(|| re("(?i)fetch failed|network"))
        .is_match(message)
    {
        return (
            Some("network"),
            vec![
                "Generic network failure. Check the container has outbound internet access.".into(),
            ],
        );
    }
    (None, vec![])
}

/// `isRetryableFetchError`.
pub fn is_retryable_fetch_error(message: &str) -> bool {
    static RETRYABLE: OnceLock<Regex> = OnceLock::new();
    RETRYABLE
        .get_or_init(|| {
            re("(?i)HTTP (401|403|405|406|429|451|503)|timeout|aborted|network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT")
        })
        .is_match(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifiers_follow_node() {
        assert!(is_retryable_fetch_error("HTTP 403 fetching privacy policy"));
        assert!(!is_retryable_fetch_error(
            "HTTP 404 fetching privacy policy"
        ));
        assert!(is_retryable_fetch_error(
            "The operation was aborted due to timeout"
        ));
        assert_eq!(
            classify_network_error("ECONNRESET").0,
            Some("connection_reset")
        );
        assert_eq!(classify_network_error("unexpected TLS handshake").0, None);
        assert_eq!(hints_for_http_status(404, None).len(), 2);
        assert_eq!(
            hints_for_http_status(418, None)[0],
            "Server returned HTTP 418. Verify the URL still works in a real browser."
        );
        assert!(hints_for_http_status(200, None).is_empty());
    }
}

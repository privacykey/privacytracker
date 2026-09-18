//! Replays `core/tests/fixtures/policy-source-cases.json`: the recorded
//! raw replies are served to the REAL transport loop (`outbound::fetch_via`
//! over a canned hop), so safeFetch's redirects and caps run here as they
//! ran on Node. Compared per case: every raw fetch made (URL and the
//! headers the policy layer set, one entry per hop), every trace event in
//! order, and the validated source or the error with its diagnostics.
use super::source::{fetch_privacy_policy_source, Trace, WAYBACK_HOSTS};
use crate::{
    outbound::{fetch_via, FetchFuture, Fetcher, Hop, HopFuture, Outgoing, Request},
    scrape::fetch_tests::raw_reply,
};
use reqwest::header::HeaderMap;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};
use url::Url;

struct Canned {
    replies: Vec<Value>,
    cursor: AtomicUsize,
    calls: Mutex<Vec<Value>>,
    /// Whether the request in flight set its own Accept-Encoding: Node's
    /// stub recorded exactly the headers safeFetch was handed, so the
    /// browser bundle's explicit one is recorded while the transport's
    /// default (undici's, mimicked) is not.
    explicit_encoding: AtomicBool,
}

impl Canned {
    fn new(replies: Vec<Value>) -> Self {
        Self {
            replies,
            cursor: AtomicUsize::new(0),
            calls: Mutex::new(vec![]),
            explicit_encoding: AtomicBool::new(false),
        }
    }
}

/// The limits each request must carry, by what it is for.
fn policy_limits(request: &Request) {
    assert_eq!(request.max_redirects, 5);
    assert_eq!(request.max_url_length, 2048);
    assert!(request.follow_redirects);
    if request
        .url
        .starts_with("https://archive.org/wayback/available?")
    {
        assert_eq!(
            (request.max_bytes, request.timeout_ms),
            (512 * 1024, 15_000)
        );
        assert_eq!(request.allowed_hosts, WAYBACK_HOSTS);
    } else if request.url.contains("web.archive.org/") {
        assert_eq!(
            (request.max_bytes, request.timeout_ms),
            (8 * 1024 * 1024, 25_000)
        );
        assert_eq!(request.allowed_hosts, WAYBACK_HOSTS);
    } else {
        assert_eq!(request.max_bytes, 6 * 1024 * 1024);
        assert!([15_000, 20_000].contains(&request.timeout_ms));
        assert!(request.allowed_hosts.is_empty());
    }
}

impl Hop for Canned {
    fn hop(&self, url: Url, headers: HeaderMap, _outgoing: Outgoing) -> HopFuture<'_> {
        Box::pin(async move {
            let explicit = self.explicit_encoding.load(Ordering::SeqCst);
            let mut sent: Vec<(String, String)> = headers
                .iter()
                .filter(|(k, v)| {
                    !((k.as_str() == "accept-encoding" && !explicit)
                        || (k.as_str() == "accept" && v.as_bytes() == b"*/*"))
                })
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            sent.sort();
            self.calls
                .lock()
                .unwrap()
                .push(json!({"url": url.as_str(), "headers": sent}));
            let index = self.cursor.fetch_add(1, Ordering::SeqCst);
            let Some(reply) = self.replies.get(index) else {
                return Err(format!("Missing fixture reply for {url}"));
            };
            raw_reply(reply)
        })
    }
}

impl Fetcher for Canned {
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        policy_limits(&request);
        self.explicit_encoding.store(
            request
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("accept-encoding")),
            Ordering::SeqCst,
        );
        Box::pin(async move { fetch_via(self, request).await })
    }
}

#[test]
fn policy_source_matches_node_calls_events_and_result() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/policy-source-cases.json"
    ))
    .unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 60, "fixture has {} cases", cases.len());
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut failures: Vec<String> = vec![];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let url = case["url"].as_str().unwrap();
        let fetcher = Canned::new(case["replies"].as_array().unwrap().clone());
        let mut trace = Trace::default();
        let outcome = rt.block_on(fetch_privacy_policy_source(&fetcher, url, &mut trace));
        let expected = match outcome {
            Ok(source) => json!({"ok": true, "result": source.to_json()}),
            Err(error) => json!({"ok": false, "error": error.to_json()}),
        };
        let calls = Value::Array(fetcher.calls.lock().unwrap().clone());
        let unused = fetcher.replies.len()
            - fetcher
                .cursor
                .load(Ordering::SeqCst)
                .min(fetcher.replies.len());
        let mut wrong: Vec<String> = vec![];
        if calls != case["calls"] {
            wrong.push(format!(
                "calls\n  expected {}\n  actual   {calls}",
                case["calls"]
            ));
        }
        if unused != 0 {
            wrong.push(format!("{unused} replies unused"));
        }
        let events = trace.to_json();
        if events != case["events"] {
            wrong.push(format!(
                "events\n  expected {}\n  actual   {events}",
                case["events"]
            ));
        }
        if expected != case["expected"] {
            wrong.push(format!(
                "result\n  expected {}\n  actual   {expected}",
                case["expected"]
            ));
        }
        if !wrong.is_empty() {
            failures.push(format!("{name}\n{}", wrong.join("\n")));
        }
    }
    assert!(
        failures.is_empty(),
        "{} policy-source parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

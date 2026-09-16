//! Replays `core/tests/fixtures/fetch-cases.json`: the recorded raw replies
//! are served to the REAL transport loop (`outbound::fetch_via` over a
//! canned hop), so redirects, caps and the rate-limit signal are exercised
//! here as they were in Node's `safeFetch`. Compared per case: every raw
//! fetch made (URL and the headers the scraper set), the ordered write
//! stream, every touched table, and the return value or error.
use super::{
    fetch::{fetch_and_parse_app, scrape_initial_urls},
    persist::Statement,
    persist_tests::{dump, to_sql, CountingIds},
    ratelimit,
};
use crate::outbound::{self, fetch_via, FetchFuture, Fetcher, Hop, HopFuture, RawReply, Request};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use tokio::io::BufReader;
use url::Url;

pub(crate) struct Canned {
    pub(crate) replies: Vec<Value>,
    pub(crate) cursor: AtomicUsize,
    pub(crate) calls: Mutex<Vec<Value>>,
    /// Asserts the limits each scraper call must carry.
    check: fn(&Request),
}

impl Canned {
    pub(crate) fn new(replies: Vec<Value>, check: fn(&Request)) -> Self {
        Self {
            replies,
            cursor: AtomicUsize::new(0),
            calls: Mutex::new(vec![]),
            check,
        }
    }
}

fn scrape_limits(request: &Request) {
    assert_eq!(request.max_redirects, 5);
    assert_eq!(request.allowed_hosts, outbound::APPLE_HOSTS);
    if request.url.contains("/lookup?") {
        assert_eq!((request.max_bytes, request.timeout_ms), (1024 * 1024, 8000));
    } else {
        assert_eq!(
            (request.max_bytes, request.timeout_ms),
            (4 * 1024 * 1024, 15_000)
        );
    }
}

/// Records one raw fetch the way Node's stub saw it: the headers safeFetch
/// set, not undici's own defaults (the transport adds two of those).
pub(super) fn record_call(calls: &Mutex<Vec<Value>>, url: &Url, headers: &HeaderMap) {
    let mut sent: Vec<(String, String)> = headers
        .iter()
        .filter(|(k, v)| {
            !(k.as_str() == "accept-encoding" || (k.as_str() == "accept" && v.as_bytes() == b"*/*"))
        })
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    sent.sort();
    calls
        .lock()
        .unwrap()
        .push(json!({"url": url.as_str(), "headers": sent}));
}

/// A recorded stub reply as the raw hop result the transport reads.
pub(super) fn raw_reply(reply: &Value) -> Result<RawReply, String> {
    if let Some(error) = reply["error"].as_str() {
        return Err(error.to_string());
    }
    let mut out = HeaderMap::new();
    if let Some(map) = reply["headers"].as_object() {
        for (name, value) in map {
            out.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value.as_str().unwrap()).unwrap(),
            );
        }
    }
    let body = reply["body"].as_str().unwrap_or("").as_bytes().to_vec();
    Ok(RawReply {
        status: reply["status"].as_u64().unwrap() as u16,
        headers: out,
        body: Box::pin(BufReader::new(std::io::Cursor::new(body))),
    })
}

impl Hop for Canned {
    fn hop(&self, url: Url, headers: HeaderMap) -> HopFuture<'_> {
        Box::pin(async move {
            record_call(&self.calls, &url, &headers);
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
        Box::pin(async move {
            (self.check)(&request);
            fetch_via(self, request).await
        })
    }
}

const DUMPED: [&str; 9] = [
    "apps",
    "privacy_types",
    "privacy_categories",
    "accessibility_features",
    "related_apps_observed",
    "privacy_snapshots",
    "notifications",
    "activity_log",
    "app_settings",
];

#[test]
fn fetch_layer_matches_node_calls_stream_rows_and_result() {
    let _env = crate::server::trust::env_lock();
    let previous_tz = std::env::var("TZ").ok();
    extern "C" {
        fn tzset();
    }
    std::env::set_var("TZ", "UTC");
    // SAFETY: tzset takes no pointers; the env lock serializes the edit.
    unsafe { tzset() };

    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/fetch-cases.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut failures = vec![];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        let tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for table in &tables {
            conn.execute(&format!("DELETE FROM \"{table}\""), [])
                .unwrap();
        }
        for step in case["setup"].as_array().unwrap() {
            let params = step["params"].as_array().unwrap();
            conn.execute(
                step["sql"].as_str().unwrap(),
                params_from_iter(params.iter().map(to_sql)),
            )
            .unwrap_or_else(|e| panic!("{name}: setup failed: {e}"));
        }
        ratelimit::reset_soft_buckets();
        let canned = Canned::new(case["replies"].as_array().unwrap().clone(), scrape_limits);
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut log: Vec<Statement> = vec![];
        let now = case["now"].as_i64().unwrap();

        let actual = rt.block_on(async {
            if case["batch"].is_object() {
                let batch = &case["batch"];
                let urls: Vec<String> = batch["urls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|u| u.as_str().unwrap().to_string())
                    .collect();
                let results = scrape_initial_urls(
                    &conn,
                    &canned,
                    &urls,
                    batch["resync"].as_bool().unwrap_or(false),
                    batch["options"]["trigger"].as_str(),
                    batch["options"]["stopOnRateLimit"]
                        .as_bool()
                        .unwrap_or(true),
                    now,
                    &mut ids,
                    Some(&mut log),
                )
                .await;
                json!({"ok": true, "results": results})
            } else {
                match fetch_and_parse_app(
                    &conn,
                    &canned,
                    case["url"].as_str().unwrap(),
                    case["resync"].as_bool().unwrap(),
                    case["trigger"].as_str(),
                    now,
                    &mut ids,
                    Some(&mut log),
                )
                .await
                {
                    Ok(outcome) => json!({"ok": true, "result": outcome.to_json()}),
                    Err(error) => json!({"ok": false, "error": error.message}),
                }
            }
        });

        let used = canned.cursor.load(Ordering::SeqCst);
        if used != canned.replies.len() {
            failures.push(format!(
                "{name}: unused replies {used}/{}",
                canned.replies.len()
            ));
        }
        let calls = canned.calls.lock().unwrap().clone();
        if calls != *case["calls"].as_array().unwrap() {
            failures.push(format!(
                "{name}: raw fetches differ\nrust: {}\nnode: {}",
                Value::Array(calls),
                case["calls"]
            ));
        }
        let stream: Vec<Value> = log
            .iter()
            .map(|s| json!({"sql": s.sql, "params": s.params}))
            .collect();
        let expected_stream = case["stream"].as_array().unwrap();
        if stream != *expected_stream {
            let first = stream
                .iter()
                .zip(expected_stream)
                .position(|(a, b)| a != b)
                .unwrap_or(stream.len().min(expected_stream.len()));
            failures.push(format!(
                "{name}: write stream differs at statement {first} (rust {} vs node {} statements)\nrust: {}\nnode: {}",
                stream.len(),
                expected_stream.len(),
                stream.get(first).map_or("<none>".to_string(), Value::to_string),
                expected_stream.get(first).map_or("<none>".to_string(), Value::to_string),
            ));
        }
        let rows = dump(&conn, &DUMPED);
        if rows != case["rows"] {
            for table in DUMPED {
                if rows[table] != case["rows"][table] {
                    failures.push(format!(
                        "{name}: table {table} differs\nrust: {}\nnode: {}",
                        rows[table], case["rows"][table]
                    ));
                }
            }
        }
        if actual != case["expected"] {
            failures.push(format!(
                "{name}: result differs\nrust: {actual}\nnode: {}",
                case["expected"]
            ));
        }
    }

    match previous_tz {
        Some(v) => std::env::set_var("TZ", v),
        None => std::env::remove_var("TZ"),
    }
    // SAFETY: restore the original timezone before releasing the env lock.
    unsafe { tzset() };
    assert!(
        failures.is_empty(),
        "{} differences across {} cases:\n\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
}

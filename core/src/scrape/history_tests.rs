//! Replays `core/tests/fixtures/history-cases.json`: the recorded
//! archive.org replies are routed by URL — CDX, availability by probe
//! date, replay by timestamp, Save Page Now — through the REAL transport,
//! so the manual-redirect and body-skipping paths of Save Page Now run as
//! they did in Node. Compared per case: every raw fetch (URL and headers),
//! the ordered write stream with its transaction markers, the
//! privacy_snapshots and apps tables, and the result or the thrown error.
use super::{
    fetch_tests::{raw_reply, record_call},
    history::{import_app_history, AppRow, HistoryOptions, REPLAY_HOSTS},
    persist::{Locked, Statement},
    persist_tests::{dump, to_sql, CountingIds},
    wayback::WAYBACK_HOSTS,
};
use crate::outbound::{fetch_via, FetchFuture, Fetcher, Hop, HopFuture, Request};
use regex::Regex;
use reqwest::header::HeaderMap;
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};
use url::Url;

struct Routed {
    replies: Value,
    calls: Mutex<Vec<Value>>,
}

impl Routed {
    /// The oracle's `route()`, unchanged.
    fn reply_for(&self, url: &str) -> Result<Value, String> {
        let replies = &self.replies;
        if url.starts_with("https://web.archive.org/cdx/search/cdx?") {
            return Ok(replies["cdx"].clone());
        }
        if url.starts_with("https://archive.org/wayback/available?") {
            let ts = Regex::new(r"[?&]timestamp=(\d+)")
                .unwrap()
                .captures(url)
                .map(|c| c[1].to_string())
                .unwrap_or_default();
            let by_date = &replies["availability"][&ts];
            return Ok(if by_date.is_null() {
                replies["availability"]["default"].clone()
            } else {
                by_date.clone()
            });
        }
        if let Some(c) = Regex::new(r"^https://web\.archive\.org/web/(\d{4,14})id_/")
            .unwrap()
            .captures(url)
        {
            return Ok(replies["replay"][&c[1]].clone());
        }
        if url.starts_with("https://web.archive.org/save/") {
            return Ok(replies["save"].clone());
        }
        Err(format!("Unexpected fetch: {url}"))
    }
}

impl Hop for Routed {
    fn hop(&self, url: Url, headers: HeaderMap) -> HopFuture<'_> {
        Box::pin(async move {
            record_call(&self.calls, &url, &headers);
            let reply = self.reply_for(url.as_str())?;
            if reply.is_null() {
                return Err(format!("Missing fixture reply for {url}"));
            }
            raw_reply(&reply)
        })
    }
}

/// The limits each archive.org call must carry.
fn history_limits(request: &Request) {
    assert_eq!(request.max_redirects, 5);
    let url = &request.url;
    if url.starts_with("https://web.archive.org/cdx/") {
        assert_eq!(request.allowed_hosts, WAYBACK_HOSTS);
        assert_eq!(
            (request.max_bytes, request.timeout_ms),
            (1024 * 1024, 20_000)
        );
        assert!(request.follow_redirects && request.read_body);
    } else if url.starts_with("https://archive.org/wayback/available?") {
        assert_eq!(request.allowed_hosts, WAYBACK_HOSTS);
        assert_eq!((request.max_bytes, request.timeout_ms), (64 * 1024, 8000));
        assert!(request.follow_redirects && request.read_body);
    } else if url.starts_with("https://web.archive.org/save/") {
        assert_eq!(request.allowed_hosts, WAYBACK_HOSTS);
        assert_eq!(request.timeout_ms, 25_000);
        assert!(!request.follow_redirects && !request.read_body);
    } else {
        assert_eq!(request.allowed_hosts, REPLAY_HOSTS);
        assert_eq!(
            (request.max_bytes, request.timeout_ms),
            (4 * 1024 * 1024, 30_000)
        );
        assert!(request.follow_redirects && request.read_body);
    }
}

impl Fetcher for Routed {
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        Box::pin(async move {
            history_limits(&request);
            fetch_via(self, request).await
        })
    }
}

#[test]
fn historical_import_matches_node_calls_stream_rows_and_result() {
    let _env = crate::server::trust::env_lock();
    let previous_tz = std::env::var("TZ").ok();
    extern "C" {
        fn tzset();
    }
    std::env::set_var("TZ", "UTC");
    // SAFETY: tzset takes no pointers; the env lock serializes the edit.
    unsafe { tzset() };

    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/history-cases.json")).unwrap();
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
            .collect::<Result<_, _>>()
            .unwrap();
        for table in &tables {
            conn.execute(&format!("DELETE FROM \"{table}\""), [])
                .unwrap();
        }
        for s in case["setup"].as_array().unwrap() {
            conn.execute(
                s["sql"].as_str().unwrap(),
                params_from_iter(s["params"].as_array().unwrap().iter().map(to_sql)),
            )
            .unwrap();
        }
        let app = AppRow {
            id: case["app"]["id"].as_str().unwrap().to_string(),
            name: case["app"]["name"].as_str().unwrap().to_string(),
            url: case["app"]["url"].as_str().unwrap().to_string(),
        };
        let options = HistoryOptions {
            dedupe_window_ms: case["options"]["dedupeWindowMs"].as_f64(),
            force: case["options"]["force"].as_bool().unwrap_or(false),
            interval_months: case["options"]["intervalMonths"].as_f64(),
            today: case["options"]["today"].as_i64(),
        };
        let now = case["now"].as_i64().unwrap();
        let routed = Routed {
            replies: case["replies"].clone(),
            calls: Mutex::new(vec![]),
        };
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut stream: Vec<Statement> = vec![];
        // Through the accessor the routes use, so the replay locks and
        // releases exactly as they do.
        let conn = Mutex::new(conn);
        let mut db = Locked {
            conn: &conn,
            log: Some(&mut stream),
            on_wait: None,
        };
        let outcome = rt.block_on(import_app_history(
            &mut db, &routed, &app, &options, now, &mut ids,
        ));
        let conn = conn.into_inner().unwrap();
        let actual = match outcome {
            Ok(result) => json!({"ok": true, "result": result}),
            Err(error) => json!({"ok": false, "error": error.message}),
        };
        let stream_json = Value::Array(
            stream
                .iter()
                .map(|s| json!({"sql": s.sql, "params": s.params}))
                .collect(),
        );
        let rows = dump(&conn, &["privacy_snapshots", "apps"]);
        let calls = routed.calls.lock().unwrap();
        let mut diffs = vec![];
        if json!(*calls) != case["calls"] {
            diffs.push(format!(
                "calls\n  expected {}\n  actual   {}",
                case["calls"],
                json!(*calls)
            ));
        }
        if stream_json != case["stream"] {
            diffs.push(format!(
                "stream\n  expected {}\n  actual   {}",
                case["stream"], stream_json
            ));
        }
        if rows != case["rows"] {
            diffs.push(format!(
                "rows\n  expected {}\n  actual   {}",
                case["rows"], rows
            ));
        }
        if actual != case["expected"] {
            diffs.push(format!(
                "result\n  expected {}\n  actual   {}",
                case["expected"], actual
            ));
        }
        if !diffs.is_empty() {
            failures.push(format!("{name}\n{}", diffs.join("\n")));
        }
    }
    match previous_tz {
        Some(tz) => std::env::set_var("TZ", tz),
        None => std::env::remove_var("TZ"),
    }
    // SAFETY: as above.
    unsafe { tzset() };
    assert!(
        failures.is_empty(),
        "{} historical-import parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

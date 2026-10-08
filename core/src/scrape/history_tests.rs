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
use crate::outbound::{fetch_via, FetchFuture, Fetcher, Hop, HopFuture, Outgoing, Request};
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
    fn hop(&self, url: Url, headers: HeaderMap, outgoing: Outgoing) -> HopFuture<'_> {
        Box::pin(async move {
            record_call(&self.calls, &url, &headers, &outgoing);
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
            ..HistoryOptions::default()
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
            &mut db, &routed, &app, &options, now, &mut ids, None,
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

/// The oracle compares only the thrown message. A refused connection must
/// also come back flagged as throttling, which is what the bulk runner backs
/// off from and the per-app route answers 503 for; a plain error would mark
/// the app failed instead.
#[test]
fn refused_connections_are_throttling_not_failures() {
    let app = AppRow {
        id: "555000111".to_string(),
        name: "Fixture".to_string(),
        url: "https://apps.apple.com/us/app/fixture/id555000111".to_string(),
    };
    let cdx = json!({
        "status": 200,
        "headers": {"content-type": "application/json"},
        "body": r#"[["timestamp","statuscode"],["20210215120000","200"]]"#,
    });
    let cases = [
        (
            json!({"cdx": {"error": "fetch failed"}}),
            "archive.org refused the connection for CDX index",
            1,
        ),
        (
            json!({"cdx": cdx, "replay": {"20210215120000": {"error": "fetch failed"}}}),
            "archive.org refused the connection for replay",
            2,
        ),
    ];
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for (replies, message, fetches) in cases {
        let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
        conn.execute(
            "INSERT INTO apps (id, name, url, firstSeen, lastSynced) VALUES (?, ?, ?, 0, 0)",
            [&app.id, &app.name, &app.url],
        )
        .unwrap();
        let routed = Routed {
            replies,
            calls: Mutex::new(vec![]),
        };
        let conn = Mutex::new(conn);
        let mut db = Locked {
            conn: &conn,
            log: None,
            on_wait: None,
        };
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let error = rt
            .block_on(import_app_history(
                &mut db,
                &routed,
                &app,
                &HistoryOptions::default(),
                1_635_768_000_000,
                &mut ids,
                None,
            ))
            .expect_err("a refused connection is the import's error");
        assert_eq!(error.message, message);
        let unavailable = error.unavailable.expect("flagged as throttling");
        assert_eq!(
            (unavailable.status, unavailable.retry_after_ms),
            (0, None),
            "no response, so no status and no Retry-After"
        );
        assert_eq!(
            routed.calls.lock().unwrap().len(),
            fetches,
            "no availability probes and no Save Page Now after the refusal"
        );
    }
}

/// The bulk runner's options: a held capture list stands in for the CDX
/// index, Save Page Now is never asked, and an unusable index fails the
/// app instead of fanning out into availability probes.
#[test]
fn bulk_options_hold_the_index_and_skip_save_now_and_probes() {
    use super::{history::INDEX_UNAVAILABLE, wayback::Capture};
    let app = AppRow {
        id: "555000111".to_string(),
        name: "Fixture".to_string(),
        url: "https://apps.apple.com/us/app/fixture/id555000111".to_string(),
    };
    let held = vec![Capture {
        ms: 1_613_390_400_000,
        timestamp: "20210215120000".to_string(),
        url: format!("https://web.archive.org/web/20210215120000/{}", app.url),
    }];
    let not_found = json!({"status": 404, "headers": {}, "body": ""});
    let cases = [
        (
            // No "cdx" or "save" reply: asking either fails the test.
            json!({"replay": {"20210215120000": not_found}}),
            HistoryOptions {
                captures: Some(held),
                skip_save_now: true,
                ..HistoryOptions::default()
            },
            Ok(()),
            vec!["https://web.archive.org/web/20210215120000id_/https://apps.apple.com/us/app/fixture/id555000111"],
        ),
        (
            // A 404 index is unusable but not throttling.
            json!({"cdx": not_found}),
            HistoryOptions {
                skip_availability_fallback: true,
                ..HistoryOptions::default()
            },
            Err(INDEX_UNAVAILABLE),
            vec!["https://web.archive.org/cdx/search/cdx?"],
        ),
    ];
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for (replies, options, expected, urls) in cases {
        let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
        conn.execute(
            "INSERT INTO apps (id, name, url, firstSeen, lastSynced) VALUES (?, ?, ?, 0, 0)",
            [&app.id, &app.name, &app.url],
        )
        .unwrap();
        let routed = Routed {
            replies,
            calls: Mutex::new(vec![]),
        };
        let conn = Mutex::new(conn);
        let mut db = Locked {
            conn: &conn,
            log: None,
            on_wait: None,
        };
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let outcome = rt.block_on(import_app_history(
            &mut db,
            &routed,
            &app,
            &options,
            1_635_768_000_000,
            &mut ids,
            None,
        ));
        match (expected, outcome) {
            (Ok(()), Ok(result)) => assert_eq!(result["snapshotsRequested"], 0),
            (Err(message), Err(error)) => {
                assert_eq!(error.message, message);
                assert!(error.unavailable.is_none(), "not throttling");
            }
            (expected, outcome) => panic!("expected {expected:?}, got {outcome:?}"),
        }
        let calls = routed.calls.lock().unwrap();
        let sent: Vec<&str> = calls.iter().map(|c| c["url"].as_str().unwrap()).collect();
        assert_eq!(sent.len(), urls.len(), "requests sent: {sent:?}");
        for (url, prefix) in sent.iter().zip(&urls) {
            assert!(
                url.starts_with(prefix),
                "{url} does not start with {prefix}"
            );
        }
    }
}

/// The change-finding walk end to end, through the stub archive and the
/// real transport: what it reads, the rows it stores, and the result.
mod change_finding {
    use super::Routed;
    use crate::scrape::{
        history::{import_app_history, AppRow, HistoryError, HistoryOptions},
        persist::Locked,
        persist_tests::CountingIds,
        wayback::{extract_timestamp, format_timestamp, parse_timestamp_ms},
    };
    use rusqlite::Connection;
    use serde_json::{json, Value};
    use std::{path::Path, sync::Mutex};

    const DAY: i64 = 24 * 60 * 60 * 1000;
    /// 2021-03-01T12:00:00Z.
    const MARCH_2021: i64 = 1_614_600_000_000;
    /// 2026-03-01T12:00:00Z: five years of noon captures end the day
    /// before, so the yearly skeleton is days 0, 365, 730, 1096, 1461, 1825.
    const TODAY: i64 = MARCH_2021 + 1826 * DAY;
    const APP_URL: &str = "https://apps.apple.com/us/app/fixture/id555000111";

    fn day(n: i64) -> i64 {
        MARCH_2021 + n * DAY
    }

    fn day_of(ms: i64) -> i64 {
        (ms - MARCH_2021) / DAY
    }

    fn stamp(n: i64) -> String {
        format!("{}120000", format_timestamp(day(n)))
    }

    fn html(status: u16, body: String) -> Value {
        json!({"status": status, "headers": {"content-type": "text/html"}, "body": body})
    }

    /// A product page with label set `v`: one type collecting `v + 1`
    /// categories, so every `v` is a version of its own.
    fn labelled(v: usize) -> Value {
        let categories: Vec<Value> = (0..=v)
            .map(|c| json!({"identifier": format!("C{c}"), "title": format!("C{c}")}))
            .collect();
        let data = json!({"data": [{"data": {"shelfMapping": {"privacyTypes": {"items": [{
            "identifier": "DATA_LINKED_TO_YOU",
            "title": "Data Linked to You",
            "categories": categories,
        }]}}}}]});
        html(
            200,
            format!(
                r#"<html><head><script id="serialized-server-data">{data}</script></head><body></body></html>"#
            ),
        )
    }

    /// The label set in force on day `d`, given the days labels changed.
    fn version(changes: &[i64], d: i64) -> usize {
        changes.iter().filter(|&&c| c <= d).count()
    }

    /// A CDX index of these days and, for each, the replay `page` gives.
    fn archive(days: impl IntoIterator<Item = i64>, page: impl Fn(i64) -> Value) -> Value {
        let mut rows = vec![json!(["timestamp", "statuscode"])];
        let mut replay = serde_json::Map::new();
        for d in days {
            rows.push(json!([stamp(d), "200"]));
            replay.insert(stamp(d), page(d));
        }
        json!({
            "cdx": {
                "status": 200,
                "headers": {"content-type": "application/json"},
                "body": Value::Array(rows).to_string(),
            },
            "replay": replay,
        })
    }

    fn database() -> Mutex<Connection> {
        let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
        conn.execute(
            "INSERT INTO apps (id, name, url, firstSeen, lastSynced) VALUES (?, ?, ?, 0, 0)",
            ["555000111", "Fixture", APP_URL],
        )
        .unwrap();
        Mutex::new(conn)
    }

    struct Run {
        outcome: Result<Value, HistoryError>,
        urls: Vec<String>,
    }

    impl Run {
        fn result(&self) -> &Value {
            self.outcome.as_ref().expect("the import succeeds")
        }

        /// The days of the archived pages read, in order.
        fn read_days(&self) -> Vec<i64> {
            self.urls
                .iter()
                .filter_map(|url| extract_timestamp(url))
                .filter_map(|ts| parse_timestamp_ms(Some(&ts)))
                .map(day_of)
                .collect()
        }
    }

    fn import(
        conn: &Mutex<Connection>,
        replies: &Value,
        options: &HistoryOptions,
        now: i64,
        ids: &mut CountingIds,
    ) -> Run {
        let app = AppRow {
            id: "555000111".to_string(),
            name: "Fixture".to_string(),
            url: APP_URL.to_string(),
        };
        let routed = Routed {
            replies: replies.clone(),
            calls: Mutex::new(vec![]),
        };
        let mut db = Locked {
            conn,
            log: None,
            on_wait: None,
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = rt.block_on(import_app_history(
            &mut db, &routed, &app, options, now, ids, None,
        ));
        let urls = routed
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c["url"].as_str().unwrap().to_string())
            .collect();
        Run { outcome, urls }
    }

    fn ids() -> CountingIds {
        CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        }
    }

    /// The wayback rows as (day, changes_detected), oldest first.
    fn rows(conn: &Mutex<Connection>) -> Vec<(i64, i64)> {
        conn.lock()
            .unwrap()
            .prepare(
                "SELECT scraped_at, changes_detected FROM privacy_snapshots
                  WHERE source = 'wayback' ORDER BY scraped_at",
            )
            .unwrap()
            .query_map([], |r| Ok((day_of(r.get(0)?), r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn windows(result: &Value) -> Vec<(i64, i64)> {
        result["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| {
                (
                    day_of(w["fromMs"].as_i64().unwrap()),
                    day_of(w["toMs"].as_i64().unwrap()),
                )
            })
            .collect()
    }

    fn counts(result: &Value) -> [i64; 6] {
        [
            "attempted",
            "imported",
            "unchanged",
            "skipped",
            "failed",
            "snapshotsRequested",
        ]
        .map(|k| result[k].as_i64().unwrap())
    }

    const CHANGES: [i64; 2] = [400, 1300];

    fn five_years() -> Value {
        archive(0..=1825, |d| labelled(version(&CHANGES, d)))
    }

    #[test]
    fn change_rows_land_on_the_captures_that_bracket_each_change() {
        let conn = database();
        let run = import(
            &conn,
            &five_years(),
            &HistoryOptions::default(),
            TODAY,
            &mut ids(),
        );
        let result = run.result();
        // The index, the six skeleton pages, then six reads per change.
        assert_eq!(run.urls.len(), 19);
        assert!(run.urls[0].starts_with("https://web.archive.org/cdx/search/cdx?"));
        assert_eq!(
            run.read_days(),
            [0, 365, 730, 1096, 1461, 1825, 547, 456, 410, 387, 398, 404]
                .into_iter()
                .chain([1278, 1369, 1323, 1300, 1289, 1294])
                .collect::<Vec<_>>()
        );
        // The baseline, both sides of each change, the newest.
        assert_eq!(
            rows(&conn),
            vec![(0, 0), (398, 0), (404, 1), (1294, 0), (1300, 1), (1825, 0)]
        );
        assert_eq!(windows(result), vec![(398, 404), (1294, 1300)]);
        assert_eq!(
            (
                &result["reads"],
                &result["changes"],
                &result["labelVersions"]
            ),
            (&json!(18), &json!(2), &json!(3))
        );
        assert_eq!(
            (&result["firstCaptureMs"], &result["lastCaptureMs"]),
            (&json!(day(0)), &json!(day(1825)))
        );
        // Every read is a target; the six stored are imported or unchanged.
        assert_eq!(counts(result), [18, 3, 3, 0, 0, 0]);
        let targets = result["targets"].as_array().unwrap();
        let phases: Vec<&str> = targets
            .iter()
            .map(|t| t["phase"].as_str().unwrap())
            .collect();
        assert_eq!(phases[..6], ["skeleton"; 6]);
        assert_eq!(phases[6..], ["bisect"; 12]);
        let change = targets
            .iter()
            .find(|t| t["captureDate"] == json!(day(404)))
            .unwrap();
        assert_eq!(
            change,
            &json!({
                "targetDate": day(404),
                "outcome": "imported",
                "captureDate": day(404),
                "waybackUrl": format!("https://web.archive.org/web/{}/{APP_URL}", stamp(404)),
                "changeCount": 1,
                "phase": "bisect",
            })
        );
        assert_eq!(
            targets.iter().filter(|t| t["outcome"] == "sampled").count(),
            12
        );
    }

    #[test]
    fn a_stable_app_costs_the_skeleton() {
        let conn = database();
        let replies = archive(0..=1825, |_| labelled(0));
        let run = import(
            &conn,
            &replies,
            &HistoryOptions::default(),
            TODAY,
            &mut ids(),
        );
        assert_eq!(run.read_days(), vec![0, 365, 730, 1096, 1461, 1825]);
        assert_eq!(rows(&conn), vec![(0, 0), (1825, 0)]);
        let result = run.result();
        assert_eq!(counts(result), [6, 1, 1, 0, 0, 0]);
        assert_eq!(
            (
                &result["reads"],
                &result["changes"],
                &result["labelVersions"]
            ),
            (&json!(6), &json!(0), &json!(1))
        );
        assert_eq!(result["windows"], json!([]));
    }

    #[test]
    fn a_change_that_reverts_between_skeleton_reads_is_missed() {
        // Days 500 to 600 carry other labels. Days 365 and 730 agree, so the
        // yearly skeleton never looks between them: the contract accepts
        // this, as the quarterly sweep missed one inside a quarter.
        let replies = archive(0..=1825, |d| {
            labelled(usize::from((500..=600).contains(&d)))
        });
        let conn = database();
        let yearly = import(
            &conn,
            &replies,
            &HistoryOptions::default(),
            TODAY,
            &mut ids(),
        );
        assert_eq!(yearly.result()["changes"], 0);
        assert_eq!(rows(&conn), vec![(0, 0), (1825, 0)]);

        // A denser cadence buys the density: a quarterly date lands inside.
        let conn = database();
        let quarterly = HistoryOptions {
            interval_months: Some(3.0),
            ..HistoryOptions::default()
        };
        let dense = import(&conn, &replies, &quarterly, TODAY, &mut ids());
        let found = windows(dense.result());
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found[0].0 < 500 && 500 <= found[0].1 && found[0].1 - found[0].0 <= 7);
        assert!(found[1].0 <= 600 && 600 < found[1].1 && found[1].1 - found[1].0 <= 7);
    }

    #[test]
    fn unusable_captures_hand_over_to_the_next_nearest() {
        // Day 0's replay is a 404, so the baseline is day 1. The first
        // midpoint is no product page and the next nearest has no labels,
        // which after day 0 makes it unusable too: that change stays as
        // wide as the skeleton left it.
        let replies = archive(0..=1825, |d| {
            match d {
            0 => html(404, String::new()),
            547 => html(200, "<html><body>Not archived.</body></html>".to_string()),
            548 => html(
                200,
                r#"<html><head><script id="serialized-server-data">{"data":[]}</script></head></html>"#
                    .to_string(),
            ),
            _ => labelled(version(&[400], d)),
        }
        });
        let conn = database();
        let run = import(
            &conn,
            &replies,
            &HistoryOptions::default(),
            TODAY,
            &mut ids(),
        );
        assert_eq!(
            run.read_days(),
            vec![0, 1, 365, 730, 1096, 1461, 1825, 547, 548]
        );
        assert_eq!(rows(&conn), vec![(1, 0), (365, 0), (730, 1), (1825, 0)]);
        let result = run.result();
        assert_eq!(windows(result), vec![(365, 730)]);
        // The 404 and the stray page failed; the page without labels is
        // skipped, as it always was.
        assert_eq!(counts(result), [9, 2, 2, 1, 2, 0]);
        let outcomes: Vec<(&str, Option<&str>)> = result["targets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| {
                !matches!(
                    t["outcome"].as_str(),
                    Some("imported" | "unchanged" | "sampled")
                )
            })
            .map(|t| (t["outcome"].as_str().unwrap(), t["errorMessage"].as_str()))
            .collect();
        assert_eq!(
            outcomes,
            vec![
                (
                    "skipped_fetch_failure",
                    Some("archive replay returned HTTP 404")
                ),
                ("skipped_parse_failure", None),
                ("skipped_no_labels", None),
            ]
        );
    }

    #[test]
    fn stored_rows_are_the_next_runs_samples() {
        let conn = database();
        let mut ids = ids();
        let first = import(
            &conn,
            &five_years(),
            &HistoryOptions::default(),
            TODAY,
            &mut ids,
        );
        assert_eq!(first.read_days().len(), 18);
        let stored = rows(&conn);

        // Every skeleton date is near a stored row or between two that
        // agree, and both changes are settled: only the index is asked.
        let again = import(
            &conn,
            &five_years(),
            &HistoryOptions::default(),
            TODAY,
            &mut ids,
        );
        assert_eq!(again.urls.len(), 1);
        let result = again.result();
        assert_eq!(counts(result), [6, 0, 0, 6, 0, 0]);
        assert_eq!(windows(result), vec![(398, 404), (1294, 1300)]);
        assert_eq!(
            (&result["reads"], &result["changes"]),
            (&json!(0), &json!(2))
        );
        assert_eq!(rows(&conn), stored);

        // Two and a half months on, with newer captures: the newest is the
        // one page read, and it is stored.
        let later = archive(0..=1900, |d| labelled(version(&CHANGES, d)));
        let run = import(
            &conn,
            &later,
            &HistoryOptions::default(),
            day(1901),
            &mut ids,
        );
        assert_eq!(run.read_days(), vec![1900]);
        assert_eq!(rows(&conn).last(), Some(&(1900, 0)));
        assert_eq!(run.result()["changes"], 2);
    }

    #[test]
    fn force_reads_again_but_never_stores_a_capture_twice() {
        let conn = database();
        let mut ids = ids();
        import(
            &conn,
            &five_years(),
            &HistoryOptions::default(),
            TODAY,
            &mut ids,
        );
        let stored = rows(&conn);
        let forced = HistoryOptions {
            force: true,
            ..HistoryOptions::default()
        };
        let run = import(&conn, &five_years(), &forced, TODAY, &mut ids);
        assert_eq!(run.read_days().len(), 18);
        assert_eq!(rows(&conn), stored);
        let result = run.result();
        // The six reads that would be rows are already rows.
        assert_eq!(counts(result), [18, 0, 0, 6, 0, 0]);
        assert_eq!(windows(result), vec![(398, 404), (1294, 1300)]);
    }

    #[test]
    fn a_throttle_mid_bisection_keeps_what_it_learned() {
        let throttled = archive(0..=1825, |d| match d {
            410 => json!({"status": 429, "headers": {"retry-after": "120"}, "body": ""}),
            _ => labelled(version(&CHANGES, d)),
        });
        let conn = database();
        let mut ids = ids();
        let run = import(
            &conn,
            &throttled,
            &HistoryOptions::default(),
            TODAY,
            &mut ids,
        );
        assert_eq!(
            run.read_days(),
            vec![0, 365, 730, 1096, 1461, 1825, 547, 456, 410]
        );
        let error = run.outcome.expect_err("throttling is the import's error");
        assert_eq!(
            error.message,
            "archive.org rate-limited for replay — retry after 120s"
        );
        assert_eq!(
            error.unavailable.map(|u| u.retry_after_ms),
            Some(Some(120_000))
        );
        // Both sides of each change as narrowed so far, and the ends.
        assert_eq!(
            rows(&conn),
            vec![(0, 0), (365, 0), (456, 1), (1096, 0), (1461, 1), (1825, 0)]
        );

        // The next run starts from those rows: no skeleton page again, only
        // the rest of each bisection.
        let run = import(
            &conn,
            &five_years(),
            &HistoryOptions::default(),
            TODAY,
            &mut ids,
        );
        assert_eq!(
            run.read_days(),
            vec![410, 387, 398, 404, 1278, 1369, 1323, 1300, 1289, 1294]
        );
        let result = run.result();
        assert_eq!(windows(result), vec![(398, 404), (1294, 1300)]);
        // The successor repair re-diffs 456 and 1461 against the new rows
        // before them, so each change shows once.
        assert_eq!(
            rows(&conn),
            vec![
                (0, 0),
                (365, 0),
                (398, 0),
                (404, 1),
                (456, 0),
                (1096, 0),
                (1294, 0),
                (1300, 1),
                (1461, 0),
                (1825, 0)
            ]
        );
    }

    #[test]
    fn without_an_index_one_probe_per_skeleton_date() {
        let capture = |ts: &str| {
            json!({"status": 200, "headers": {"content-type": "application/json"}, "body": json!({
                "archived_snapshots": {"closest": {
                    "available": true,
                    "url": format!("http://web.archive.org/web/{ts}/{APP_URL}"),
                    "timestamp": ts,
                    "status": "200",
                }}
            }).to_string()})
        };
        // Each probe date and the capture it answers with; today has none.
        let answers = [
            ("20210201", "20210210120000"),
            ("20210301", "20210305120000"),
            ("20220301", "20220302120000"),
            ("20230301", "20230301120000"),
            ("20240301", "20240301120000"),
            ("20250301", "20250228120000"),
        ];
        let mut availability = serde_json::Map::new();
        let mut replay = serde_json::Map::new();
        for (date, ts) in answers {
            availability.insert(date.to_string(), capture(ts));
            replay.insert(ts.to_string(), labelled(usize::from(ts >= "2023")));
        }
        availability.insert(
            "default".to_string(),
            json!({"status": 200, "headers": {}, "body": r#"{"archived_snapshots":{}}"#}),
        );
        let replies = json!({
            "cdx": {"status": 404, "headers": {}, "body": ""},
            "availability": availability,
            "replay": replay,
            "save": {"status": 302, "headers": {"location": format!("https://web.archive.org/web/20260301120000/{APP_URL}")}, "body": ""},
        });
        let conn = database();
        let run = import(
            &conn,
            &replies,
            &HistoryOptions::default(),
            TODAY,
            &mut ids(),
        );
        // One probe per date, at that date, never the old ±14/28/42 days.
        let probes: Vec<&str> = run
            .urls
            .iter()
            .filter_map(|u| u.split("&timestamp=").nth(1))
            .collect();
        assert_eq!(
            probes,
            ["20210201", "20210301", "20220301", "20230301", "20240301", "20250301", "20260301"]
        );
        // No bisection between the two that differ.
        assert_eq!(run.urls.len(), 1 + 7 + 6 + 1);
        let result = run.result();
        assert_eq!(windows(result), vec![(day_of(day(366)), day_of(day(730)))]);
        assert_eq!(rows(&conn).len(), 4);
        assert_eq!(
            (&result["firstCaptureMs"], &result["lastCaptureMs"]),
            (&Value::Null, &Value::Null)
        );
        let targets = result["targets"].as_array().unwrap();
        assert!(targets[..7].iter().all(|t| t["phase"] == "skeleton"));
        assert_eq!(targets[6]["outcome"], "skipped_no_capture");
        assert_eq!(targets[7]["outcome"], "requested_snapshot");
        assert_eq!(result["snapshotsRequested"], 1);
    }
}

//! Actual Node response bytes plus outbound call records. Each case uses a
//! fresh migrated database, and every read must leave total_changes unchanged.
use super::{routes_discovery, row::to_sql_value, stats::text, AppState};
use crate::outbound::{FetchFuture, Fetcher, Reply, Request};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};

struct Replay {
    state: AppState,
    replies: Vec<Value>,
    calls: Mutex<Vec<Value>>,
}
impl Fetcher for Replay {
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        assert!(
            self.state.conn.try_lock().is_ok(),
            "database held across network work"
        );
        let mut headers = request
            .headers
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
            .collect::<Vec<_>>();
        headers.sort();
        assert_eq!(request.max_redirects, 5);
        if request.url.contains("/lookup?") {
            assert_eq!((request.max_bytes, request.timeout_ms), (1024 * 1024, 8000));
        } else if request.url.contains("/rss/") {
            assert_eq!(
                (request.max_bytes, request.timeout_ms),
                (2 * 1024 * 1024, 8000)
            );
        } else {
            assert_eq!(
                (request.max_bytes, request.timeout_ms),
                (4 * 1024 * 1024, 15000)
            );
        }
        let is_preview = request.url.contains("/app/");
        assert_eq!(
            request.allowed_hosts,
            if is_preview {
                crate::outbound::APPLE_HOSTS
            } else {
                crate::outbound::RELATED_HOSTS
            }
        );
        let mut calls = self.calls.lock().unwrap();
        let reply = self
            .replies
            .get(calls.len())
            .expect("unexpected network request")
            .clone();
        calls.push(json!({"url":request.url,"headers":headers}));
        Box::pin(async move {
            tokio::task::yield_now().await;
            if let Some(error) = reply["error"].as_str() {
                return Err(error.to_owned());
            }
            Ok(Reply {
                status: reply["status"].as_u64().unwrap() as u16,
                body: text(&reply["body"]).as_bytes().to_vec(),
            })
        })
    }
}
#[test]
fn discovery_handlers_match_node_bytes_calls_and_no_writes() {
    let _env = super::trust::env_lock();
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/discovery-cases.json")).unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let mut failures = vec![];
        for case in fixture["cases"].as_array().unwrap() {
            let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
            conn.pragma_update(None, "foreign_keys", false).unwrap();
            for r in super::stats::query(
                &conn,
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                &[],
            )
            .unwrap()
            {
                conn.execute(&format!("DELETE FROM \"{}\"", text(&r["name"])), [])
                    .unwrap();
            }
            for s in fixture["base"]
                .as_array()
                .unwrap()
                .iter()
                .chain(case["changes"].as_array().unwrap())
            {
                conn.execute(
                    text(&s["sql"]),
                    rusqlite::params_from_iter(
                        s["params"].as_array().unwrap().iter().map(to_sql_value),
                    ),
                )
                .unwrap();
            }
            let before = conn.total_changes();
            let state = AppState {
                conn: Arc::new(Mutex::new(conn)),
                rate_limiter: Arc::new(super::ratelimit::RateLimiter::new()),
                started_at: Instant::now(),
                bound_port: 0,
            };
            let replay = Replay {
                state: state.clone(),
                replies: case["replies"].as_array().unwrap().clone(),
                calls: Mutex::new(vec![]),
            };
            let params = serde_json::from_value(case["query"].clone()).unwrap();
            let mut actual = Value::Null;
            for _ in 0..case["repeat"].as_u64().unwrap() {
                let response = if case["route"] == "compare" {
                    routes_discovery::compare_with(&state, &Default::default(), &params, &replay)
                        .await
                } else {
                    routes_discovery::related_with(&state, &params, &replay).await
                };
                let status = response.status().as_u16();
                let typ = response
                    .headers()
                    .get("content-type")
                    .map(|h| h.to_str().unwrap().to_owned());
                let retry = response
                    .headers()
                    .get("retry-after")
                    .map(|h| h.to_str().unwrap().to_owned());
                let body = String::from_utf8(
                    axum::body::to_bytes(response.into_body(), usize::MAX)
                        .await
                        .unwrap()
                        .to_vec(),
                )
                .unwrap();
                actual = json!({"status":status,"body":body,"type":typ,"retry":retry});
            }
            assert_eq!(
                before,
                state.db().total_changes(),
                "GET wrote: {}",
                case["name"]
            );
            let calls = replay.calls.lock().unwrap();
            if actual != case["expected"] || json!(*calls) != case["calls"] {
                failures.push(format!(
                    "{}\nexpected {}\nactual {}\nexpected calls {}\nactual calls {}",
                    case["name"],
                    case["expected"],
                    actual,
                    case["calls"],
                    json!(*calls)
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} discovery parity failures:\n{}",
            failures.len(),
            failures.join("\n\n")
        );
    });
}

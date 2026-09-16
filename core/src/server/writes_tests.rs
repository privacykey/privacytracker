//! Replays `core/tests/fixtures/writes-cases.json`: every recorded request
//! through the same body reader, guard and handler the axum wrappers use,
//! against a fresh migrated database, a fresh rate limiter and counted
//! ids. Compared per case: status, and unless the status is Node's generic
//! 500, the body, content-type, Retry-After and Set-Cookie; the ordered
//! write stream with its transaction markers; and the four tables a
//! settings write can touch.
use super::{
    body::{read_json, BodyOutcome},
    ratelimit::RateLimiter,
    writes::{self, WriteRequest},
};
use crate::scrape::{
    persist::{Statement, Writer},
    persist_tests::{dump, to_sql, CountingIds},
};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Method},
};
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::path::Path;

const TABLES: [&str; 4] = [
    "app_settings",
    "feature_flag_overrides",
    "activity_log",
    "audit_log",
];

#[test]
fn settings_writes_match_node_wire_stream_and_rows() {
    let _env = crate::server::trust::env_lock();
    std::env::set_var("PRIVACYTRACKER_TRUST_PROXY", "1");
    std::env::set_var("PRIVACYTRACKER_BIND_HOST", "127.0.0.1");
    for var in [
        "PRIVACYTRACKER_NETWORK_EXPOSED",
        "PRIVACYTRACKER_RUNTIME",
        "PRIVACYTRACKER_ALLOWED_HOSTS",
    ] {
        std::env::remove_var(var);
    }

    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/writes-cases.json")).unwrap();
    let now = fixture["now"].as_i64().unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut failures = vec![];
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        match case["adminToken"].as_str() {
            Some(token) => std::env::set_var("AUDITOR_ADMIN_TOKEN", token),
            None => std::env::remove_var("AUDITOR_ADMIN_TOKEN"),
        }
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
        let method: Method = case["method"].as_str().unwrap().parse().unwrap();
        let spec = writes::lookup(case["route"].as_str().unwrap(), &method)
            .unwrap_or_else(|| panic!("{name}: no route"));
        let mut headers = HeaderMap::new();
        for (k, v) in case["headers"].as_object().unwrap() {
            headers.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
            );
        }
        let query: Vec<(String, String)> = case["query"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| {
                (
                    pair[0].as_str().unwrap().to_string(),
                    pair[1].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let raw_body = case["body"].as_str().map(str::to_string);
        let limiter = RateLimiter::new();
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut stream: Vec<Statement> = vec![];
        let mut response = None;
        for _ in 0..case["repeat"].as_u64().unwrap_or(1) {
            let mut w = Writer::new(&conn, Some(&mut stream));
            let actor = match writes::precheck(&mut w, &mut ids, &limiter, &headers, spec, now) {
                Ok(actor) => actor,
                Err(refused) => {
                    response = Some(refused);
                    continue;
                }
            };
            let body = match spec.body_limit {
                Some(limit) => {
                    let body = raw_body
                        .as_ref()
                        .map_or_else(Body::empty, |b| Body::from(b.clone()));
                    rt.block_on(read_json(&headers, body, limit))
                }
                None => BodyOutcome::Empty,
            };
            response = Some(writes::perform(
                &mut w,
                &mut ids,
                WriteRequest {
                    spec,
                    param: case["param"].as_str(),
                    query: &query,
                    body,
                },
                &actor,
                now,
            ));
        }
        let response = response.expect("at least one request");
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .map(|v| v.to_str().unwrap().to_string())
        };
        let content_type = header("content-type");
        let retry_after = header("retry-after");
        let set_cookie = header("set-cookie");
        let body = rt.block_on(async {
            String::from_utf8(
                axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .to_vec(),
            )
            .unwrap()
        });
        let expected = &case["expected"];
        // Node's generic 500 for a thrown handler is contractual only by
        // status; the oracle records it with an empty body.
        let actual = if status == 500 && expected["status"] == 500 {
            json!({"status": 500, "body": "", "type": null, "retryAfter": null, "setCookie": null})
        } else {
            json!({"status": status, "body": body, "type": content_type, "retryAfter": retry_after, "setCookie": set_cookie})
        };
        let expected_wire = json!({
            "status": expected["status"], "body": expected["body"], "type": expected["type"],
            "retryAfter": expected["retryAfter"], "setCookie": expected["setCookie"],
        });
        let stream_json = Value::Array(
            stream
                .iter()
                .map(|s| json!({"sql": s.sql, "params": s.params}))
                .collect(),
        );
        let rows = dump(&conn, &TABLES);
        let mut diffs = vec![];
        if actual != expected_wire {
            diffs.push(format!(
                "wire\n  expected {expected_wire}\n  actual   {actual}"
            ));
        }
        if stream_json != case["stream"] {
            diffs.push(format!(
                "stream\n  expected {}\n  actual   {stream_json}",
                case["stream"]
            ));
        }
        if rows != case["rows"] {
            diffs.push(format!(
                "rows\n  expected {}\n  actual   {rows}",
                case["rows"]
            ));
        }
        if !diffs.is_empty() {
            failures.push(format!("{name}\n{}", diffs.join("\n")));
        }
    }
    std::env::remove_var("AUDITOR_ADMIN_TOKEN");
    std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
    std::env::remove_var("PRIVACYTRACKER_BIND_HOST");
    assert!(
        failures.is_empty(),
        "{} write-route parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

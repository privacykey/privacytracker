//! Replays `core/tests/fixtures/imports-cases.json` the way `library_tests`
//! replays the library writes, with the network canned: each case's replies
//! are served in order by the Phase 3 test fetcher, and the raw calls it
//! saw are compared with the ones Node's stub recorded. Foreign keys stay
//! ON — the match change relies on the apps cascade, the import delete on
//! the items cascade.
use super::{
    body::{read_json, BodyOutcome},
    ratelimit::RateLimiter,
    writes::{self, WriteRequest},
};
use crate::scrape::{
    fetch_tests::Canned,
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

#[test]
fn import_writes_match_node_wire_calls_stream_and_rows() {
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
        serde_json::from_str(include_str!("../../tests/fixtures/imports-cases.json")).unwrap();
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
        let tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        for table in &tables {
            conn.execute(&format!("DELETE FROM \"{table}\""), [])
                .unwrap();
        }
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        for s in case["setup"].as_array().unwrap() {
            conn.execute(
                s["sql"].as_str().unwrap(),
                params_from_iter(s["params"].as_array().unwrap().iter().map(to_sql)),
            )
            .unwrap();
        }
        crate::scrape::ratelimit::reset_soft_buckets();
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
        let param = case["param"].as_str();
        let limiter = RateLimiter::new();
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let fetcher = Canned::new(case["replies"].as_array().unwrap().clone(), |_| {});
        let mut stream: Vec<Statement> = vec![];
        let mut response = None;
        for _ in 0..case["repeat"].as_u64().unwrap_or(1) {
            let mut w = Writer::new(&conn, Some(&mut stream));
            let actor =
                match writes::precheck(&mut w, &mut ids, &limiter, &headers, spec, param, now) {
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
            response = Some(rt.block_on(writes::perform_async(
                &mut w,
                &mut ids,
                &fetcher,
                WriteRequest {
                    spec,
                    param,
                    query: &query,
                    body,
                },
                &actor,
                now,
            )));
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
        let actual = if status == 500 && expected["status"] == 500 && expected["thrown"].is_string()
        {
            json!({"status": 500, "body": "", "type": null, "retryAfter": null})
        } else {
            json!({"status": status, "body": body, "type": content_type, "retryAfter": retry_after})
        };
        let expected_wire = json!({
            "status": expected["status"], "body": expected["body"], "type": expected["type"],
            "retryAfter": expected["retryAfter"],
        });
        let stream_json = Value::Array(
            stream
                .iter()
                .map(|s| json!({"sql": s.sql, "params": s.params}))
                .collect(),
        );
        let calls = Value::Array(fetcher.calls.lock().unwrap().clone());
        let table_names: Vec<&str> = case["rows"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let rows = dump(&conn, &table_names);
        let mut diffs = vec![];
        if actual != expected_wire {
            diffs.push(format!(
                "wire\n  expected {expected_wire}\n  actual   {actual}"
            ));
        }
        if calls != case["calls"] {
            diffs.push(format!(
                "calls\n  expected {}\n  actual   {calls}",
                case["calls"]
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
        "{} import-write parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

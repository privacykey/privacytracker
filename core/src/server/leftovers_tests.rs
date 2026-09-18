//! Replays `core/tests/fixtures/leftovers-cases.json`: the webhook test
//! and the seed notification through the write framework, the update
//! status, the favicon and the preview through their read handlers, and
//! the two ticks called as the server's tickers call them. The network is
//! canned, and a POST's method and body are compared with what Node's
//! stub saw. `<APP_VERSION>` in the fixture is this crate's package
//! version, substituted before the parse.
use super::{
    audit_bundle::app_version,
    body::{read_json, BodyOutcome},
    favicon,
    ratelimit::RateLimiter,
    routes_discovery, update_check, webhook_writes,
    writes::{self, WriteRequest},
    AppState,
};
use crate::scrape::{
    fetch_tests::Canned,
    persist::{Locked, Statement, Writer},
    persist_tests::{dump, to_sql, CountingIds},
};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Method},
    response::Response,
};
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};

const ENV_KEYS: [&str; 3] = ["DEPLOYMENT", "HOMEBREW_PREFIX", "HOMEBREW_FORMULA_PATH"];

/// The wire as the oracle recorded it: the status, the body (base64 for
/// the favicon, whose bytes are not text), the type and the three headers
/// these routes set.
async fn wire_of(response: Response, favicon: bool) -> Value {
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_string())
    };
    let content_type = header("content-type");
    let headers = json!({
        "cache-control": header("cache-control"),
        "x-favicon-cache": header("x-favicon-cache"),
        "retry-after": header("retry-after"),
    });
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    if favicon {
        json!({
            "status": status,
            "bodyBase64": super::backup::base64_encode(&bytes),
            "type": content_type,
            "headers": headers,
        })
    } else {
        json!({
            "status": status,
            "body": String::from_utf8(bytes).unwrap(),
            "type": content_type,
            "headers": headers,
        })
    }
}

#[test]
fn leftovers_match_node_wire_calls_stream_and_rows() {
    let _env = super::trust::env_lock();
    let _cache = favicon::test_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    std::env::set_var("PRIVACYTRACKER_TRUST_PROXY", "1");
    std::env::set_var("PRIVACYTRACKER_BIND_HOST", "127.0.0.1");
    for var in [
        "PRIVACYTRACKER_NETWORK_EXPOSED",
        "PRIVACYTRACKER_RUNTIME",
        "PRIVACYTRACKER_ALLOWED_HOSTS",
    ] {
        std::env::remove_var(var);
    }

    let text = include_str!("../../tests/fixtures/leftovers-cases.json")
        .replace("<APP_VERSION>", &app_version());
    let fixture: Value = serde_json::from_str(&text).unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut failures = vec![];
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let now = case["now"].as_i64().unwrap();
        match case["adminToken"].as_str() {
            Some(token) => std::env::set_var("AUDITOR_ADMIN_TOKEN", token),
            None => std::env::remove_var("AUDITOR_ADMIN_TOKEN"),
        }
        // The runtime detection reads the environment: `DEPLOYMENT=node`
        // unless the case says otherwise, and nothing of Homebrew's.
        std::env::set_var("DEPLOYMENT", "node");
        for key in &ENV_KEYS[1..] {
            std::env::remove_var(key);
        }
        if let Some(env) = case["env"].as_object() {
            for (key, value) in env {
                match value.as_str() {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
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
        let conn = Arc::new(Mutex::new(conn));
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
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let fetcher = Canned::new(case["replies"].as_array().unwrap().clone(), |_| {});
        let mut stream: Vec<Statement> = vec![];
        let route = case["route"].as_str().unwrap_or("");
        let repeat = case["repeat"].as_u64().unwrap_or(1);
        let mut diffs = vec![];
        let actual = match (case["kind"].as_str().unwrap(), route) {
            ("callback", _) => {
                let mut db = Locked {
                    conn: &conn,
                    log: Some(&mut stream),
                    on_wait: None,
                };
                let returned = match case["callback"].as_str().unwrap() {
                    "webhook-summary" => json!(rt.block_on(webhook_writes::maybe_post_summary(
                        &mut db, &mut ids, &fetcher, now,
                    ))),
                    "update-check" => {
                        let result = rt.block_on(update_check::check_for_update(
                            &mut db, &mut ids, &fetcher, now, false,
                        ));
                        json!({
                            "performed": result.performed,
                            "skipReason": result.skip_reason,
                            "error": result.error,
                            "status": result.status,
                        })
                    }
                    other => panic!("{name}: no callback {other}"),
                };
                let expected = &case["expected"]["returned"];
                if &returned != expected {
                    diffs.push(format!(
                        "returned\n  expected {expected}\n  actual   {returned}"
                    ));
                }
                None
            }
            (_, "/api/update-status") => {
                let mut db = Locked {
                    conn: &conn,
                    log: Some(&mut stream),
                    on_wait: None,
                };
                let response = rt.block_on(update_check::update_status_with(
                    &mut db, &mut ids, &fetcher, &query, now,
                ));
                Some(rt.block_on(wire_of(response, false)))
            }
            (_, "/api/favicon") => {
                let response = rt.block_on(favicon::favicon_with(&query, &fetcher, now));
                Some(rt.block_on(wire_of(response, true)))
            }
            (_, "/api/preview") => {
                let state = AppState {
                    conn: conn.clone(),
                    rate_limiter: Arc::new(RateLimiter::new()),
                    started_at: Instant::now(),
                    bound_port: 0,
                };
                let mut last = None;
                for _ in 0..repeat {
                    let response = rt.block_on(routes_discovery::preview_with(
                        &state, &headers, &query, &fetcher, now,
                    ));
                    last = Some(rt.block_on(wire_of(response, false)));
                }
                last
            }
            (_, route) => {
                let method: Method = case["method"].as_str().unwrap().parse().unwrap();
                let spec = writes::lookup(route, &method)
                    .unwrap_or_else(|| panic!("{name}: no route {route}"));
                let limiter = RateLimiter::new();
                let raw_body = case["body"].as_str().map(str::to_string);
                let mut last = None;
                for _ in 0..repeat {
                    let actor = {
                        let guard = conn.lock().unwrap();
                        let mut w = Writer::new(&guard, Some(&mut stream));
                        match writes::precheck(
                            &mut w, &mut ids, &limiter, &headers, spec, None, now,
                        ) {
                            Ok(actor) => actor,
                            Err(refused) => {
                                last = Some(rt.block_on(wire_of(refused, false)));
                                continue;
                            }
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
                    let mut db = Locked {
                        conn: &conn,
                        log: Some(&mut stream),
                        on_wait: None,
                    };
                    let response = rt.block_on(writes::perform_async(
                        &mut db,
                        &mut ids,
                        &fetcher,
                        WriteRequest {
                            spec,
                            param: None,
                            query: &query,
                            body,
                            headers: &headers,
                            state: None,
                        },
                        &actor,
                        now,
                    ));
                    last = Some(rt.block_on(wire_of(response, false)));
                }
                last
            }
        };
        if let Some(actual) = actual {
            let expected = &case["expected"];
            let expected_wire = if expected["thrown"].is_string() {
                json!({"status": 500, "body": "", "type": null, "headers": expected["headers"]})
            } else if expected["bodyBase64"].is_string() {
                json!({
                    "status": expected["status"], "bodyBase64": expected["bodyBase64"],
                    "type": expected["type"], "headers": expected["headers"],
                })
            } else {
                json!({
                    "status": expected["status"], "body": expected["body"],
                    "type": expected["type"], "headers": expected["headers"],
                })
            };
            if actual != expected_wire {
                diffs.push(format!(
                    "wire\n  expected {expected_wire}\n  actual   {actual}"
                ));
            }
        }
        let calls = Value::Array(fetcher.calls.lock().unwrap().clone());
        if calls != case["calls"] {
            diffs.push(format!(
                "calls\n  expected {}\n  actual   {calls}",
                case["calls"]
            ));
        }
        let stream_json = Value::Array(
            stream
                .iter()
                .map(|s| json!({"sql": s.sql, "params": s.params}))
                .collect(),
        );
        if stream_json != case["stream"] {
            diffs.push(format!(
                "stream\n  expected {}\n  actual   {stream_json}",
                case["stream"]
            ));
        }
        let table_names: Vec<&str> = case["rows"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let rows = dump(&conn.lock().unwrap(), &table_names);
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
    for key in ENV_KEYS {
        std::env::remove_var(key);
    }
    std::env::remove_var("AUDITOR_ADMIN_TOKEN");
    std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
    std::env::remove_var("PRIVACYTRACKER_BIND_HOST");
    assert!(
        failures.is_empty(),
        "{} leftovers parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

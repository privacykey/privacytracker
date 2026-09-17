//! Replays `core/tests/fixtures/bundles-cases.json`: the audit bundle's
//! export and import through the same reader, guard and handler the axum
//! wrappers use — a multipart upload included, as the bytes the oracle
//! sent — and the two support bundles called directly.
//!
//! Compared per case: the wire (status, body, the download headers), the
//! write stream with its transaction markers, and the eleven tables an
//! import can touch. The two support bundles are mostly this machine's
//! state, so both sides are PROJECTED the same way first — the key sets,
//! and the sections that are pure functions of the database.
//!
//! The import binds bundle-supplied numbers as doubles, as better-sqlite3
//! binds every JavaScript number, so its stream is normalised to JSON's
//! one number type before it is compared. The oracle ran under TZ=UTC; the
//! export's filename and the duplicate message are in the process zone.
use super::{
    body::{read_json, read_raw, BodyOutcome},
    bundle_writes,
    ratelimit::RateLimiter,
    routes_operations,
    writes::{self, WriteRequest},
    AppState,
};
use crate::{
    jsnum::js_normalise_value,
    scrape::{
        fetch_tests::Canned,
        persist::{Shared, Statement, Writer},
        persist_tests::{dump, to_sql, CountingIds},
    },
};
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, Method},
};
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};

fn keys_of(v: &Value) -> Value {
    v.as_object()
        .map_or(Value::Null, |m| json!(m.keys().collect::<Vec<_>>()))
}

/// `PROJECT` in the oracle, for the same two routes.
fn project(route: &str, b: &Value) -> Value {
    match route {
        "/api/diagnostics/bundle" => json!({
            "keys": keys_of(b),
            "schemaVersion": b["schemaVersion"],
            "generatedAt": b["generatedAt"],
            "appKeys": keys_of(&b["app"]),
            "hostKeys": keys_of(&b["host"]),
            "runtimeIsObject": b["runtime"].is_object(),
            "databaseIsObject": b["database"].is_object(),
            "diskIsObject": b["disk"].is_object(),
            "errorLogKeys": keys_of(&b["errorLog"]),
            "backgroundJobs": b["backgroundJobs"],
            "rateLimits": b["rateLimits"],
            "featureFlagOverrides": b["featureFlagOverrides"],
            "deploymentKeys": keys_of(&b["deployment"]),
        }),
        _ => json!({
            "keys": keys_of(b),
            "generatedAt": b["generatedAt"],
            "diagnosticsKeys": keys_of(&b["diagnostics"]),
            "recentErrors": b["recentErrors"],
        }),
    }
}

#[test]
fn bundle_paths_match_node_wire_stream_and_rows() {
    let _env = crate::server::trust::env_lock();
    let previous_tz = std::env::var_os("TZ");
    extern "C" {
        fn tzset();
    }
    std::env::set_var("TZ", "UTC");
    // SAFETY: tzset takes no pointers; the env lock serialises the edit.
    unsafe { tzset() };
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
        serde_json::from_str(include_str!("../../tests/fixtures/bundles-cases.json")).unwrap();
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
        let conn = Arc::new(Mutex::new(conn));
        let state = AppState {
            conn: conn.clone(),
            rate_limiter: Arc::new(RateLimiter::new()),
            started_at: Instant::now(),
            bound_port: 0,
        };
        let log: Arc<Mutex<Vec<Statement>>> = Arc::new(Mutex::new(vec![]));
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let fetcher = Canned::new(vec![], |_| {});
        let mut db = Shared {
            conn: conn.clone(),
            log: Some(log.clone()),
            on_wait: None,
        };
        let route = case["route"].as_str().unwrap();
        let method: Method = case["method"].as_str().unwrap().parse().unwrap();
        let mut headers = HeaderMap::new();
        for (k, v) in case["headers"].as_object().unwrap() {
            headers.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
            );
        }

        let wire = if case["projected"] == json!(true) {
            let bundle = match route {
                "/api/diagnostics/bundle" => {
                    bundle_writes::diagnostics_bundle(&state, &headers, now)
                }
                _ => bundle_writes::support_bundle(&state, &headers, now).unwrap(),
            };
            json!({
                "status": 200,
                "body": project(route, &bundle),
                "disposition": Value::Null,
            })
        } else {
            let spec = writes::lookup(route, &method).unwrap_or_else(|| panic!("{name}: no route"));
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
            let mut response = None;
            for _ in 0..case["repeat"].as_u64().unwrap_or(1) {
                let actor = {
                    let guard = conn.lock().unwrap();
                    let mut stream = log.lock().unwrap();
                    let mut w = Writer::new(&guard, Some(&mut stream));
                    match writes::precheck(
                        &mut w,
                        &mut ids,
                        &state.rate_limiter,
                        &headers,
                        spec,
                        None,
                        now,
                    ) {
                        Ok(actor) => actor,
                        Err(refused) => {
                            response = Some(refused);
                            continue;
                        }
                    }
                };
                let body = match spec.body_limit {
                    Some(limit) => {
                        let body = raw_body
                            .as_ref()
                            .map_or_else(Body::empty, |b| Body::from(b.clone()));
                        if bundle_writes::takes_raw_body(spec, &headers) {
                            rt.block_on(read_raw(&headers, body, limit))
                        } else {
                            rt.block_on(read_json(&headers, body, limit))
                        }
                    }
                    None => BodyOutcome::Empty,
                };
                response = Some(rt.block_on(writes::perform_async(
                    &mut db,
                    &mut ids,
                    &fetcher,
                    WriteRequest {
                        spec,
                        param: None,
                        query: &query,
                        body,
                        headers: &headers,
                        state: Some(&state),
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
            let (content_type, retry_after, disposition, cache_control) = (
                header("content-type"),
                header("retry-after"),
                header("content-disposition"),
                header("cache-control"),
            );
            let body = rt.block_on(async {
                String::from_utf8(
                    axum::body::to_bytes(response.into_body(), usize::MAX)
                        .await
                        .unwrap()
                        .to_vec(),
                )
                .unwrap()
            });
            json!({
                "status": status, "body": body, "type": content_type,
                "retryAfter": retry_after, "disposition": disposition,
                "cacheControl": cache_control,
            })
        };
        drop(db);
        drop(state);
        let conn = Arc::try_unwrap(conn).unwrap().into_inner().unwrap();
        let stream = Arc::try_unwrap(log).unwrap().into_inner().unwrap();

        let expected = &case["expected"];
        let expected_wire = if case["projected"] == json!(true) {
            json!({
                "status": expected["status"],
                "body": serde_json::from_str::<Value>(expected["body"].as_str().unwrap()).unwrap(),
                "disposition": expected["disposition"],
            })
        } else {
            json!({
                "status": expected["status"], "body": expected["body"], "type": expected["type"],
                "retryAfter": expected["retryAfter"], "disposition": expected["disposition"],
                "cacheControl": expected["cacheControl"],
            })
        };
        // JSON has one number type: the import binds `42` as the double
        // Node binds it as, and the recorded stream spells it `42`.
        let stream_json = js_normalise_value(Value::Array(
            stream
                .iter()
                .map(|s| json!({"sql": s.sql, "params": s.params}))
                .collect(),
        ));
        let table_names: Vec<&str> = case["rows"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let rows = dump(&conn, &table_names);

        let mut diffs = vec![];
        if wire != expected_wire {
            diffs.push(format!(
                "wire\n  expected {expected_wire}\n  actual   {wire}"
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

    // The support bundle's one header, which the projection does not carry.
    {
        let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
        let state = AppState {
            conn: Arc::new(Mutex::new(conn)),
            rate_limiter: Arc::new(RateLimiter::new()),
            started_at: Instant::now(),
            bound_port: 0,
        };
        let response = rt.block_on(routes_operations::support_bundle(
            State(state),
            HeaderMap::new(),
        ));
        if response
            .headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok())
            != Some("no-store")
        {
            failures.push("support bundle is not marked no-store".to_string());
        }
    }

    std::env::remove_var("AUDITOR_ADMIN_TOKEN");
    std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
    std::env::remove_var("PRIVACYTRACKER_BIND_HOST");
    match previous_tz {
        Some(v) => std::env::set_var("TZ", v),
        None => std::env::remove_var("TZ"),
    }
    // SAFETY: restore the original timezone before releasing the env lock.
    unsafe { tzset() };
    assert!(
        failures.is_empty(),
        "{} bundle parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

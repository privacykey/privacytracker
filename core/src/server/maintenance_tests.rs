//! Replays `core/tests/fixtures/maintenance-cases.json`: the thirteen
//! routes the way `runners_tests` replays the runner routes, and the
//! startup hook's 60 s health-check closure called directly, each with
//! the in-process rings, the login counter, the histograms and the
//! integrity cache reset first, as the oracle reset Node's.
//!
//! The health check and the database check report figures that belong
//! to the process and the file — RSS, heap, lag, page and byte counts,
//! the path — so those keys are blanked on both sides wherever they
//! appear (the wire, the persisted blob, the activity detail) before the
//! comparison; the counts, heals, warnings and status stay exact.
use super::{
    auth,
    body::{read_json, BodyOutcome},
    csp_reports, diag, diagnostics, health_check,
    ratelimit::RateLimiter,
    writes::{self, WriteRequest},
    AppState,
};
use crate::scrape::{
    fetch_tests::Canned,
    persist::{Shared, Statement, Writer},
    persist_tests::{dump, to_sql, CountingIds},
};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Method},
};
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};

/// The figures that are the process's and the file's own.
const VOLATILE: [&str; 12] = [
    "rssMb",
    "heapFractionUsed",
    "eventLoopP99Ms",
    "walBytes",
    "fileBytes",
    "shmBytes",
    "pageCount",
    "freelistCount",
    "utilisationPct",
    "fragmented",
    "path",
    "journalMode",
];

/// Blank the volatile keys in place, following JSON embedded in strings
/// (the persisted result, the activity detail) and re-serialising it so
/// both sides come out of the same printer.
fn blank(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if VOLATILE.contains(&k.as_str()) {
                    *val = json!(0);
                } else {
                    blank(val);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(blank),
        Value::String(s) if s.starts_with('{') => {
            if let Ok(mut inner) = serde_json::from_str::<Value>(s) {
                if inner.is_object() {
                    blank(&mut inner);
                    *s = inner.to_string();
                }
            }
        }
        _ => {}
    }
}

#[test]
fn maintenance_paths_match_node_wire_stream_rows_and_ring() {
    let _env = crate::server::trust::env_lock();
    // The oracle ran under TZ=UTC; the quiet-hours deferral the seed
    // route computes is in the process timezone.
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
        serde_json::from_str(include_str!("../../tests/fixtures/maintenance-cases.json")).unwrap();
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
        // The process state the routes read or write, reset so each case
        // stands alone — as the oracle reset Node's.
        crate::scrape::ratelimit::reset_soft_buckets();
        auth::reset_login_failures();
        diag::clear_error_log();
        csp_reports::replace_for_test(vec![]);
        diag::reset_histograms();
        diagnostics::reset_integrity_cache_for_test();
        for i in 0..case["seedErrors"].as_u64().unwrap_or(0) {
            diag::log_error(format!("seeded error {}", i + 1));
        }
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
        let mut wire = None;
        match case["kind"].as_str().unwrap() {
            "callback" => match case["delay"].as_i64().unwrap() {
                60_000 => health_check::tick_health_check(&mut db, &mut ids, now),
                other => panic!("{name}: no callback for a {other} ms timer"),
            },
            _ => {
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
                            rt.block_on(read_json(&headers, body, limit))
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
                wire = Some(json!({
                    "status": status, "body": body, "type": content_type,
                    "retryAfter": retry_after, "setCookie": set_cookie,
                }));
            }
        }
        drop(db);
        drop(state);
        let conn = Arc::try_unwrap(conn).unwrap().into_inner().unwrap();
        let stream = Arc::try_unwrap(log).unwrap().into_inner().unwrap();
        let expected = &case["expected"];
        let compare = case["compare"].as_str().unwrap_or("exact");
        let mut expected_wire = if expected.is_null() {
            None
        } else if compare == "status" {
            Some(json!({ "status": expected["status"], "type": expected["type"] }))
        } else {
            Some(json!({
                "status": expected["status"], "body": expected["body"], "type": expected["type"],
                "retryAfter": expected["retryAfter"], "setCookie": expected["setCookie"],
            }))
        };
        if compare == "status" {
            wire = wire.map(|w| json!({ "status": w["status"], "type": w["type"] }));
        }
        let mut stream_json = Value::Array(
            stream
                .iter()
                .map(|s| json!({"sql": s.sql, "params": s.params}))
                .collect(),
        );
        let mut expected_stream = case["stream"].clone();
        let table_names: Vec<&str> = case["rows"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut rows = dump(&conn, &table_names);
        let mut expected_rows = case["rows"].clone();
        if matches!(compare, "health" | "database") {
            for v in [
                &mut stream_json,
                &mut expected_stream,
                &mut rows,
                &mut expected_rows,
            ] {
                blank(v);
            }
            if let Some(w) = wire.as_mut() {
                blank(w);
            }
            if let Some(w) = expected_wire.as_mut() {
                blank(w);
            }
        }
        let ring = csp_reports::read()["reports"].clone();
        let mut diffs = vec![];
        if wire != expected_wire {
            diffs.push(format!(
                "wire\n  expected {expected_wire:?}\n  actual   {wire:?}"
            ));
        }
        if stream_json != expected_stream {
            diffs.push(format!(
                "stream\n  expected {expected_stream}\n  actual   {stream_json}"
            ));
        }
        if rows != expected_rows {
            diffs.push(format!(
                "rows\n  expected {expected_rows}\n  actual   {rows}"
            ));
        }
        if ring != case["csp"] {
            diffs.push(format!(
                "csp ring\n  expected {}\n  actual   {ring}",
                case["csp"]
            ));
        }
        if !diffs.is_empty() {
            failures.push(format!("{name}\n{}", diffs.join("\n")));
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
        "{} maintenance parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

//! Replays `core/tests/fixtures/imports-cases.json` the way `library_tests`
//! replays the library writes, with the network canned: each case's replies
//! are served in order by the Phase 3 test fetcher, and the raw calls it
//! saw are compared with the ones Node's stub recorded. Foreign keys stay
//! ON — the match change relies on the apps cascade, the import delete on
//! the items cascade.
//!
//! The per-app Wayback import route, `POST`/`DELETE
//! /api/apps/[id]/import-history`, is replayed the same way from
//! `import-history-route-cases.json`. Its import is Rust-only since the
//! change-finding redesign (docs/WAYBACK_IMPORT.md), so that fixture is
//! the core's own: `PT_BLESS=1` rewrites its outputs (`crate::bless`), and
//! Node no longer records it.
use super::{
    body::{read_json, BodyOutcome},
    ratelimit::RateLimiter,
    writes::{self, WriteRequest},
};
use crate::scrape::{
    fetch_tests::Canned,
    persist::{Locked, Statement, Writer},
    persist_tests::{dump, to_sql, CountingIds},
};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Method},
};
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};

/// The tables the oracle dumps; a case written by hand without `rows`
/// gets these.
const TABLES: [&str; 14] = [
    "apps",
    "privacy_types",
    "privacy_categories",
    "accessibility_features",
    "related_apps_observed",
    "privacy_snapshots",
    "imports",
    "import_items",
    "devices",
    "app_devices",
    "notifications",
    "activity_log",
    "audit_log",
    "app_settings",
];

/// What one case did: the response as sent, every raw fetch, the ordered
/// write stream and the tables afterwards.
struct Replayed {
    wire: Value,
    calls: Value,
    stream: Value,
    rows: Value,
}

/// The environment both replays run in, restored when dropped.
struct ImportEnv {
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl ImportEnv {
    fn enter() -> Self {
        let lock = crate::server::trust::env_lock();
        std::env::set_var("PRIVACYTRACKER_TRUST_PROXY", "1");
        std::env::set_var("PRIVACYTRACKER_BIND_HOST", "127.0.0.1");
        for var in [
            "PRIVACYTRACKER_NETWORK_EXPOSED",
            "PRIVACYTRACKER_RUNTIME",
            "PRIVACYTRACKER_ALLOWED_HOSTS",
        ] {
            std::env::remove_var(var);
        }
        Self { _lock: lock }
    }
}

impl Drop for ImportEnv {
    fn drop(&mut self) {
        std::env::remove_var("AUDITOR_ADMIN_TOKEN");
        std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
        std::env::remove_var("PRIVACYTRACKER_BIND_HOST");
    }
}

fn replay(case: &Value, now: i64, rt: &tokio::runtime::Runtime) -> Replayed {
    let name = case["name"].as_str().unwrap();
    match case["adminToken"].as_str() {
        Some(token) => std::env::set_var("AUDITOR_ADMIN_TOKEN", token),
        None => std::env::remove_var("AUDITOR_ADMIN_TOKEN"),
    }
    let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
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
    // Behind a mutex, as the server keeps it: the guard takes the lock
    // for its check and the handler for each of its sections.
    let conn = Mutex::new(conn);
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
        let actor = {
            let guard = conn.lock().unwrap();
            let mut w = Writer::new(&guard, Some(&mut stream));
            match writes::precheck(&mut w, &mut ids, &limiter, &headers, spec, param, now) {
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
        let mut db = Locked {
            conn: &conn,
            log: Some(&mut stream),
            on_wait: None,
        };
        response = Some(rt.block_on(writes::perform_async(
            &mut db,
            &mut ids,
            &fetcher,
            WriteRequest {
                spec,
                param,
                query: &query,
                body,
                headers: &headers,
                state: None,
            },
            &actor,
            now,
        )));
    }
    let conn = conn.into_inner().unwrap();
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
    let table_names: Vec<&str> = match case["rows"].as_object() {
        Some(rows) => rows.keys().map(String::as_str).collect(),
        None => TABLES.to_vec(),
    };
    let calls = Value::Array(fetcher.calls.lock().unwrap().clone());
    Replayed {
        wire: json!({"status": status, "body": body, "type": content_type, "retryAfter": retry_after}),
        calls,
        stream: Value::Array(
            stream
                .iter()
                .map(|s| json!({"sql": s.sql, "params": s.params}))
                .collect(),
        ),
        rows: dump(&conn, &table_names),
    }
}

/// Each output that differs from the case's, against `wire` as the
/// response to compare.
fn diffs(case: &Value, replayed: &Replayed, wire: &Value) -> Vec<String> {
    let expected = &case["expected"];
    let expected_wire = json!({
        "status": expected["status"], "body": expected["body"], "type": expected["type"],
        "retryAfter": expected["retryAfter"],
    });
    let mut diffs = vec![];
    if *wire != expected_wire {
        diffs.push(format!(
            "wire\n  expected {expected_wire}\n  actual   {wire}"
        ));
    }
    for (key, actual) in [
        ("calls", &replayed.calls),
        ("stream", &replayed.stream),
        ("rows", &replayed.rows),
    ] {
        if *actual != case[key] {
            diffs.push(format!(
                "{key}\n  expected {}\n  actual   {actual}",
                case[key]
            ));
        }
    }
    diffs
}

#[test]
fn import_writes_match_node_wire_calls_stream_and_rows() {
    let _env = ImportEnv::enter();
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/imports-cases.json")).unwrap();
    let now = fixture["now"].as_i64().unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut failures = vec![];
    for case in fixture["cases"].as_array().unwrap() {
        let replayed = replay(case, now, &rt);
        // A handler that threw in Node answered a bare 500.
        let expected = &case["expected"];
        let wire = if replayed.wire["status"] == 500
            && expected["status"] == 500
            && expected["thrown"].is_string()
        {
            json!({"status": 500, "body": "", "type": null, "retryAfter": null})
        } else {
            replayed.wire.clone()
        };
        let diffs = diffs(case, &replayed, &wire);
        if !diffs.is_empty() {
            failures.push(format!(
                "{}\n{}",
                case["name"].as_str().unwrap(),
                diffs.join("\n")
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} import-write parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[test]
fn import_history_route_matches_its_blessed_fixture() {
    let _env = ImportEnv::enter();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/import-history-route-cases.json"
    ))
    .unwrap();
    let mut bless = crate::bless::Bless::new("import-history-route-cases.json", &fixture);
    let now = fixture["now"].as_i64().unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut failures = vec![];
    for case in fixture["cases"].as_array().unwrap() {
        let replayed = replay(case, now, &rt);
        bless.record(
            case,
            &[
                ("calls", &replayed.calls),
                ("stream", &replayed.stream),
                ("rows", &replayed.rows),
                ("expected", &replayed.wire),
            ],
        );
        let diffs = diffs(case, &replayed, &replayed.wire);
        if !diffs.is_empty() {
            failures.push(format!(
                "{}\n{}",
                case["name"].as_str().unwrap(),
                diffs.join("\n")
            ));
        }
    }
    if bless.finish() {
        return;
    }
    assert!(
        failures.is_empty(),
        "{} import-history route failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

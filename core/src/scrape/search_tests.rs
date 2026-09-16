//! Replays `core/tests/fixtures/search-cases.json` through the real
//! transport loop over recorded iTunes replies, comparing every raw fetch
//! made, every write, the app_settings rows and the batch object.
use super::{
    fetch_tests::Canned,
    persist::{json_of, Statement},
    persist_tests::to_sql,
    ratelimit,
    search::{lookup_apps_by_bundle_id, search_apps_by_name},
};
use crate::outbound::{self, Request};
use rusqlite::{params_from_iter, types::Value as Sql};
use serde_json::{json, Map, Value};
use std::{path::Path, sync::atomic::Ordering};

fn expect_limits(request: &Request) {
    assert_eq!(request.max_redirects, 5);
    assert_eq!(request.allowed_hosts, outbound::APPLE_HOSTS);
    if request.url.contains("/lookup?bundleId=") {
        assert_eq!(
            (
                request.max_bytes,
                request.timeout_ms,
                request.max_url_length
            ),
            (4 * 1024 * 1024, 12_000, 16 * 1024)
        );
    } else {
        assert_eq!(
            (
                request.max_bytes,
                request.timeout_ms,
                request.max_url_length
            ),
            (1024 * 1024, 8000, 2048)
        );
    }
}

#[test]
fn search_and_lookup_match_node_calls_writes_and_batches() {
    let _env = crate::server::trust::env_lock();
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/search-cases.json")).unwrap();
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
        let canned = Canned::new(case["replies"].as_array().unwrap().clone(), expect_limits);
        let mut log: Vec<Statement> = vec![];
        let now = case["now"].as_i64().unwrap();
        let input = case["input"].as_array().unwrap();
        let country = case["options"]["country"].as_str();
        let actual = rt.block_on(async {
            if case["kind"] == "search" {
                search_apps_by_name(&conn, &canned, input, country, now, Some(&mut log))
                    .await
                    .unwrap_or_else(|e| json!({ "error": e }))
            } else {
                lookup_apps_by_bundle_id(&conn, &canned, input, country, now, Some(&mut log)).await
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
        if stream != *case["stream"].as_array().unwrap() {
            failures.push(format!(
                "{name}: write stream differs\nrust: {}\nnode: {}",
                Value::Array(stream),
                case["stream"]
            ));
        }
        let mut stmt = conn
            .prepare("SELECT * FROM app_settings ORDER BY rowid")
            .unwrap();
        let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
        let settings: Vec<Value> = stmt
            .query_map([], |r| {
                let mut row = Map::new();
                for (i, column) in columns.iter().enumerate() {
                    row.insert(column.clone(), json_of(r.get::<_, Sql>(i)?));
                }
                Ok(Value::Object(row))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        if settings != *case["settings"].as_array().unwrap() {
            failures.push(format!(
                "{name}: app_settings differ\nrust: {}\nnode: {}",
                Value::Array(settings),
                case["settings"]
            ));
        }
        if actual != case["expected"] {
            failures.push(format!(
                "{name}: batch differs\nrust: {actual}\nnode: {}",
                case["expected"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} differences across {} cases:\n\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
}

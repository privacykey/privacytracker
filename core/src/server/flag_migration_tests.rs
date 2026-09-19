//! Replays `core/tests/fixtures/flag-migration-cases.json`: each case on a
//! wiped in-memory database with foreign keys ON, its setup rows (a case
//! may drop a table), then `flag_migration::run` under the fixture's frozen
//! clock. Compared: what the run returned or threw, the write stream and
//! the three tables, a dropped one reading as null.
use super::{
    flag_migration,
    sync_runner::{self, Fixed},
};
use crate::scrape::{
    persist::{Locked, Statement, Writer},
    persist_tests::{dump, to_sql, CountingIds},
};
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Mutex;

const TABLES: [&str; 3] = ["app_settings", "feature_flag_overrides", "activity_log"];

fn outcome(result: Result<Vec<flag_migration::StepResult>, flag_migration::Failure>) -> Value {
    match result {
        Ok(steps) => json!({
            "ok": true,
            "steps": steps
                .iter()
                .map(|s| json!({ "name": s.name, "durationMs": s.duration_ms }))
                .collect::<Vec<_>>(),
        }),
        Err(failure) => {
            let (name, step) = match &failure {
                flag_migration::Failure::Step { step, .. } => {
                    (json!("MigrationError"), json!(step))
                }
                flag_migration::Failure::Other(_) => (json!("Error"), Value::Null),
            };
            json!({
                "ok": false,
                "error": { "name": name, "step": step, "message": failure.message() },
            })
        }
    }
}

#[test]
fn flag_migration_matches_node_outcome_stream_and_rows() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/flag-migration-cases.json"
    ))
    .unwrap();
    let now = fixture["now"].as_i64().unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 43, "fixture has {} cases", cases.len());
    let mut failures = vec![];
    for case in cases {
        let name = case["name"].as_str().unwrap();
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
            .unwrap_or_else(|e| panic!("{name}: setup failed: {e}"));
        }

        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut stream: Vec<Statement> = vec![];
        let result = {
            let mut w = Writer::new(&conn, Some(&mut stream));
            flag_migration::run(&mut w, &mut ids, &Fixed(now))
        };
        let actual = outcome(result);
        let stream_json = Value::Array(
            stream
                .iter()
                .map(|s| json!({"sql": s.sql, "params": s.params}))
                .collect(),
        );
        let mut diffs = vec![];
        if actual != case["outcome"] {
            diffs.push(format!(
                "outcome\n  expected {}\n  actual   {actual}",
                case["outcome"]
            ));
        }
        if stream_json != case["stream"] {
            diffs.push(format!(
                "stream\n  expected {}\n  actual   {stream_json}",
                case["stream"]
            ));
        }
        for table in TABLES {
            let present = conn
                .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
                .and_then(|mut stmt| stmt.exists([table]))
                .unwrap();
            let rows = if present {
                dump(&conn, &[table])[table].clone()
            } else {
                Value::Null
            };
            if rows != case["rows"][table] {
                diffs.push(format!(
                    "{table}\n  expected {}\n  actual   {rows}",
                    case["rows"][table]
                ));
            }
        }
        if !diffs.is_empty() {
            failures.push(format!("{name}\n{}", diffs.join("\n")));
        }
    }
    assert!(
        failures.is_empty(),
        "{} flag-migration parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// At boot a failed run is logged, never raised: the server comes up
/// without the marker, and each boot tries again, adding its rows.
#[test]
fn a_failed_migration_at_boot_is_retried_on_the_next() {
    let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
    conn.execute("DROP TABLE annotations", []).unwrap();
    let conn = Mutex::new(conn);
    for _ in 0..2 {
        let mut db = Locked {
            conn: &conn,
            log: None,
            on_wait: None,
        };
        sync_runner::migrate_flags(&mut db, &Fixed(1_789_473_600_000));
    }
    let conn: &Connection = &conn.lock().unwrap();
    let marker: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'feature_flag_migration_version'",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(marker, None, "no marker after a failed run");
    let failed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM activity_log WHERE type = 'migration' AND status = 'error'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(failed, 2, "one failed row per boot");
}

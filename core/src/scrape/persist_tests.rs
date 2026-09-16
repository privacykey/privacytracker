//! Replays `core/tests/fixtures/persist-cases.json`: for each case, the
//! setup statements Node ran, then the recorded scrape, comparing the
//! ordered write stream (SQL and parameters, transaction markers included),
//! every touched table afterwards, and the return value or error.
use super::persist::{json_of, scrape_and_persist, Ids, ScrapeInput, Statement, VersionInfo};
use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use serde_json::{json, Map, Value};
use std::path::Path;

pub(crate) struct CountingIds {
    pub(crate) prefix: &'static str,
    pub(crate) next: u64,
}

impl Ids for CountingIds {
    fn uuid(&mut self, _conn: &Connection) -> Result<String, String> {
        self.next += 1;
        Ok(format!("{}{:012}", self.prefix, self.next))
    }
    // One counter for both shapes: the oracle's `randomBytes(9)` stub shares
    // its counter with `randomUUID`, so the interleaving is what is pinned.
    fn short_id(&mut self, _conn: &Connection, prefix: &str) -> Result<String, String> {
        self.next += 1;
        Ok(format!("{prefix}_{:012}", self.next))
    }
}

pub(crate) fn to_sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Number(n) => n
            .as_i64()
            .map(Sql::Integer)
            .or_else(|| n.as_f64().map(Sql::Real))
            .unwrap_or(Sql::Null),
        Value::String(s) => Sql::Text(s.clone()),
        other => panic!("unexpected setup parameter {other}"),
    }
}

const DUMPED: [&str; 10] = [
    "apps",
    "privacy_types",
    "privacy_categories",
    "accessibility_features",
    "related_apps_observed",
    "privacy_snapshots",
    "notifications",
    "activity_log",
    "app_settings",
    "feature_flag_overrides",
];

/// The oracle's dump: rows in rowid order, digested past 100 rows.
pub(crate) fn dump(conn: &Connection, tables: &[&str]) -> Value {
    let mut out = Map::new();
    for &table in tables {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
        let rows: Vec<Value> = stmt
            .query_map([], |r| {
                let mut row = Map::new();
                for (i, column) in columns.iter().enumerate() {
                    row.insert(column.clone(), json_of(r.get::<_, Sql>(i)?));
                }
                Ok(Value::Object(row))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let value = if rows.len() > 100 {
            json!({"count": rows.len(), "head": rows[..3], "tail": rows[rows.len() - 3..]})
        } else {
            Value::Array(rows)
        };
        out.insert(table.to_string(), value);
    }
    Value::Object(out)
}

fn version_info(v: &Value) -> VersionInfo {
    let text = |k: &str| v[k].as_str().map(str::to_string);
    VersionInfo {
        age_rating: text("ageRating"),
        current_version: text("currentVersion"),
        genre_id: v["genreId"].as_f64(),
        genre_name: text("genreName"),
        price_amount: v["priceAmount"].as_f64(),
        price_currency: text("priceCurrency"),
        price_formatted: text("priceFormatted"),
        version_updated_at: v["versionUpdatedAt"].as_i64(),
        whats_new: text("whatsNew"),
    }
}

#[test]
fn persist_matches_node_stream_rows_and_result() {
    let _env = crate::server::trust::env_lock();
    let previous_tz = std::env::var("TZ").ok();
    extern "C" {
        fn tzset();
    }
    std::env::set_var("TZ", "UTC");
    // SAFETY: tzset takes no pointers; the env lock serializes the edit.
    unsafe { tzset() };

    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/persist-cases.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
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

        let version = version_info(&case["version"]);
        let input = ScrapeInput {
            url: case["url"].as_str().unwrap(),
            resync: case["resync"].as_bool().unwrap(),
            trigger: case["trigger"].as_str().unwrap(),
            version: &version,
            now: case["now"].as_i64().unwrap(),
        };
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut log: Vec<Statement> = vec![];
        let outcome = scrape_and_persist(
            &conn,
            &input,
            case["html"].as_str().unwrap(),
            &mut ids,
            Some(&mut log),
        );

        let stream: Vec<Value> = log
            .iter()
            .map(|s| json!({"sql": s.sql, "params": s.params}))
            .collect();
        let expected_stream = case["stream"].as_array().unwrap();
        if stream != *expected_stream {
            let first = stream
                .iter()
                .zip(expected_stream)
                .position(|(a, b)| a != b)
                .unwrap_or(stream.len().min(expected_stream.len()));
            failures.push(format!(
                "{name}: write stream differs at statement {first} (rust {} vs node {} statements)\nrust: {}\nnode: {}",
                stream.len(),
                expected_stream.len(),
                stream.get(first).map_or("<none>".to_string(), Value::to_string),
                expected_stream.get(first).map_or("<none>".to_string(), Value::to_string),
            ));
        }
        let rows = dump(&conn, &DUMPED);
        if rows != case["rows"] {
            for table in DUMPED {
                if rows[table] != case["rows"][table] {
                    failures.push(format!(
                        "{name}: table {table} differs\nrust: {}\nnode: {}",
                        rows[table], case["rows"][table]
                    ));
                }
            }
        }
        let actual = match &outcome {
            Ok(o) => json!({"ok": true, "result": o.to_json()}),
            Err(e) => json!({"ok": false, "error": e}),
        };
        if actual != case["expected"] {
            failures.push(format!(
                "{name}: result differs\nrust: {actual}\nnode: {}",
                case["expected"]
            ));
        }
    }

    match previous_tz {
        Some(v) => std::env::set_var("TZ", v),
        None => std::env::remove_var("TZ"),
    }
    // SAFETY: restore the original timezone before releasing the env lock.
    unsafe { tzset() };
    assert!(
        failures.is_empty(),
        "{} differences across {} cases:\n\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
}

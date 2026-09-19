//! Replays `core/tests/fixtures/device-routes-cases.json` the way
//! `library_tests` replays the library writes — foreign keys ON, each case
//! on a wiped in-memory database, the guard through `precheck`, the body
//! under the route's cap, then `perform` (the GET through
//! `uninstall_get_response`) — over a MobileSync-shaped tree built from the
//! fixture's own description: the same entries, sizes, symlinks and
//! mtimes, under a scratch base spelled `<BASE>` in the fixture.
//! Compared: the wire response, the write stream (normalised to JSON's
//! number spelling, as better-sqlite3 binds a client's number as a double)
//! and the ten tables.
use super::{
    body::{read_json, BodyOutcome},
    device_writes,
    ratelimit::RateLimiter,
    writes::{self, WriteRequest},
};
use crate::jsnum::js_normalise_value;
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
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

/// The tree the oracle built, under `base`.
fn build_tree(base: &Path, tree: &[Value]) {
    for entry in tree {
        let full = base.join(entry["path"].as_str().unwrap());
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        match entry["kind"].as_str().unwrap() {
            "dir" => std::fs::create_dir_all(&full).unwrap(),
            "symlink" => {
                std::os::unix::fs::symlink(entry["target"].as_str().unwrap(), &full).unwrap()
            }
            _ => {
                let size = entry["size"].as_u64().unwrap() as usize;
                std::fs::write(&full, "x".repeat(size)).unwrap();
                let mtime = entry["mtime"].as_i64().unwrap();
                let at = UNIX_EPOCH + Duration::from_millis(u64::try_from(mtime).unwrap());
                std::fs::File::options()
                    .write(true)
                    .open(&full)
                    .unwrap()
                    .set_modified(at)
                    .unwrap();
            }
        }
    }
}

/// `<BASE>` ⇄ the replay's base, through a value's JSON text.
fn swap(v: &Value, from: &str, to: &str) -> Value {
    serde_json::from_str(&v.to_string().replace(from, to)).unwrap()
}

#[test]
fn device_routes_match_node_wire_stream_and_rows() {
    let _env = crate::server::trust::env_lock();
    std::env::set_var("PRIVACYTRACKER_TRUST_PROXY", "1");
    std::env::set_var("PRIVACYTRACKER_BIND_HOST", "127.0.0.1");
    std::env::set_var("NEXT_PHASE", "phase-test");
    for var in [
        "PRIVACYTRACKER_NETWORK_EXPOSED",
        "PRIVACYTRACKER_RUNTIME",
        "PRIVACYTRACKER_ALLOWED_HOSTS",
        "AUDITOR_ADMIN_TOKEN",
    ] {
        std::env::remove_var(var);
    }

    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/device-routes-cases.json"
    ))
    .unwrap();
    let now = fixture["now"].as_i64().unwrap();
    let scratch = std::env::temp_dir().join(format!("pt-device-replay-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).unwrap();
    let base: PathBuf = std::fs::canonicalize(&scratch).unwrap();
    build_tree(&base, fixture["tree"].as_array().unwrap());
    let base_text = base.to_str().unwrap().to_string();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 139, "fixture has {} cases", cases.len());
    let mut failures = vec![];
    for recorded in cases {
        let case = swap(recorded, "<BASE>", &base_text);
        let name = case["name"].as_str().unwrap();
        let root = match case["mobileSyncRoot"].as_str() {
            Some(relative) => base.join(relative),
            None => base.join("MobileSync").join("Backup"),
        };
        std::env::set_var("PRIVACYTRACKER_TEST_MOBILESYNC_ROOT", &root);

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

        let method: Method = case["method"].as_str().unwrap().parse().unwrap();
        let route = case["route"].as_str().unwrap();
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
            if method == Method::GET {
                response = Some(device_writes::uninstall_get_response(&conn, &query, now));
                continue;
            }
            let spec = writes::lookup(route, &method).unwrap_or_else(|| panic!("{name}: no route"));
            let mut w = Writer::new(&conn, Some(&mut stream));
            let actor =
                match writes::precheck(&mut w, &mut ids, &limiter, &headers, spec, None, now) {
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
                    param: None,
                    query: &query,
                    body,
                    headers: &headers,
                    state: None,
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
        let body = rt.block_on(async {
            String::from_utf8(
                axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .to_vec(),
            )
            .unwrap()
        });
        let expected = &recorded["expected"];
        let actual = if status == 500 && expected["status"] == 500 && expected["thrown"].is_string()
        {
            json!({"status": 500, "body": "", "type": null, "retryAfter": null})
        } else {
            json!({"status": status, "body": body, "type": content_type, "retryAfter": retry_after})
        };
        let actual = swap(&actual, &base_text, "<BASE>");
        let expected_wire = json!({
            "status": expected["status"], "body": expected["body"], "type": expected["type"],
            "retryAfter": expected["retryAfter"],
        });
        let stream_json = swap(
            &js_normalise_value(Value::Array(
                stream
                    .iter()
                    .map(|s| json!({"sql": s.sql, "params": s.params}))
                    .collect(),
            )),
            &base_text,
            "<BASE>",
        );
        let table_names: Vec<&str> = recorded["rows"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let rows = swap(&dump(&conn, &table_names), &base_text, "<BASE>");
        let mut diffs = vec![];
        if actual != expected_wire {
            diffs.push(format!(
                "wire\n  expected {expected_wire}\n  actual   {actual}"
            ));
        }
        if stream_json != recorded["stream"] {
            diffs.push(format!(
                "stream\n  expected {}\n  actual   {stream_json}",
                recorded["stream"]
            ));
        }
        for table in &table_names {
            if rows[*table] != recorded["rows"][*table] {
                diffs.push(format!(
                    "{table}\n  expected {}\n  actual   {}",
                    recorded["rows"][*table], rows[*table]
                ));
            }
        }
        if !diffs.is_empty() {
            failures.push(format!("{name}\n{}", diffs.join("\n")));
        }
    }
    std::env::remove_var("PRIVACYTRACKER_TEST_MOBILESYNC_ROOT");
    std::env::remove_var("NEXT_PHASE");
    std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
    std::env::remove_var("PRIVACYTRACKER_BIND_HOST");
    let _ = std::fs::remove_dir_all(&scratch);
    assert!(
        failures.is_empty(),
        "{} device-route parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

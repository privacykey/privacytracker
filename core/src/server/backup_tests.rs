//! Replays `core/tests/fixtures/backup-cases.json`: the five guarded
//! backup routes the way `maintenance_tests` replays its routes, the
//! snapshot download called directly, and the startup hook's 35 s
//! snapshot closure called directly — each against a data directory of
//! its own holding the signing key and the snapshot files the oracle
//! seeded, with the oracle's mtimes.
//!
//! Compared per case: the wire (status, body, and the download headers),
//! the write stream with its transaction markers, every table a backup
//! carries, the `backups/` directory afterwards (name, size and SHA-256
//! of each file — the snapshot bytes are Node's bytes), the key file
//! afterwards, and that foreign-key enforcement is back on.
//!
//! Three adjustments, each mirrored from the oracle: the data directory is
//! spelled `<DATA_DIR>` on both sides; a snapshot whose name carries a
//! collision suffix lists by its real mtime, so that figure is blanked
//! (`compare: "collision"`); and the restore binds numbers as doubles, as
//! better-sqlite3 does, so its stream is normalised to JSON's one number
//! type before it is compared.
use super::{
    backup, backup_snapshots, backup_writes,
    body::{read_json, BodyOutcome},
    ratelimit::RateLimiter,
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
    http::{HeaderMap, HeaderName, HeaderValue, Method},
    response::Response,
};
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A fresh, empty data directory for one case.
fn case_dir(root: &Path, index: usize) -> PathBuf {
    let dir = root.join(format!("case-{index}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The key file and the seeded snapshot files, as the oracle laid them.
fn seed_disk(dir: &Path, case: &Value) {
    if let Some(key) = case["key"].as_str() {
        std::fs::write(dir.join("backup-signing.key"), key).unwrap();
    }
    let files = case["files"].as_array().unwrap();
    if !files.is_empty() {
        std::fs::create_dir_all(dir.join("backups")).unwrap();
    }
    for file in files {
        let path = dir.join("backups").join(file["name"].as_str().unwrap());
        std::fs::write(&path, file["content"].as_str().unwrap()).unwrap();
        let mtime = UNIX_EPOCH + Duration::from_millis(file["mtimeMs"].as_u64().unwrap());
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
    }
}

/// `listDisk()`: null without a directory, else each file by name.
fn list_disk(dir: &Path) -> Value {
    let backups = dir.join("backups");
    if !backups.exists() {
        return Value::Null;
    }
    let mut names: Vec<String> = std::fs::read_dir(&backups)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    // `Array.prototype.sort`: UTF-16 code units.
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Value::Array(
        names
            .into_iter()
            .map(|name| {
                let content = std::fs::read(backups.join(&name)).unwrap();
                json!({
                    "name": name,
                    "size": content.len(),
                    "sha256": hex(ring::digest::digest(&ring::digest::SHA256, &content).as_ref()),
                })
            })
            .collect(),
    )
}

/// `blankCollisions`: a snapshot not named by a bare timestamp lists by
/// its real mtime.
fn blank_collisions(body: &str) -> String {
    let strict = |name: &str| {
        name.strip_prefix("privacytracker-snapshot-")
            .and_then(|rest| rest.strip_suffix(".json"))
            .is_some_and(|stamp| {
                stamp.len() == 24
                    && stamp.bytes().enumerate().all(|(i, b)| match i {
                        4 | 7 | 13 | 16 | 19 => b == b'-',
                        10 => b == b'T',
                        23 => b == b'Z',
                        _ => b.is_ascii_digit(),
                    })
            })
    };
    let mut parsed: Value = serde_json::from_str(body).unwrap();
    for list in ["snapshots", "pruned"] {
        for row in parsed[list].as_array_mut().into_iter().flatten() {
            if !strict(row["filename"].as_str().unwrap_or("")) {
                row["createdAt"] = json!(0);
            }
        }
    }
    parsed.to_string()
}

fn wire_of(rt: &tokio::runtime::Runtime, response: Response, dir: &Path) -> Value {
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_string())
    };
    let (content_type, retry_after, disposition, cache_control, backup_version) = (
        header("content-type"),
        header("retry-after"),
        header("content-disposition"),
        header("cache-control"),
        header("x-backup-version"),
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
        "status": status,
        "body": body.replace(dir.to_str().unwrap(), "<DATA_DIR>"),
        "type": content_type,
        "retryAfter": retry_after,
        "disposition": disposition,
        "cacheControl": cache_control,
        "backupVersion": backup_version,
    })
}

#[test]
fn backup_paths_match_node_wire_stream_rows_and_disk() {
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
        serde_json::from_str(include_str!("../../tests/fixtures/backup-cases.json")).unwrap();
    let now = fixture["now"].as_i64().unwrap();
    let fresh_key: [u8; 32] = backup::base64_decode_lenient(fixture["freshKey"].as_str().unwrap())
        .try_into()
        .unwrap();
    let root = std::env::temp_dir().join(format!("pt-backup-replay-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut failures = vec![];
    for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        match case["adminToken"].as_str() {
            Some(token) => std::env::set_var("AUDITOR_ADMIN_TOKEN", token),
            None => std::env::remove_var("AUDITOR_ADMIN_TOKEN"),
        }
        let dir = case_dir(&root, index);
        seed_disk(&dir, case);
        backup::set_test_env(Some((dir.clone(), fresh_key)));

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
        let mut wire = None;
        match (case["kind"].as_str().unwrap(), case["route"].as_str()) {
            ("callback", _) => match case["delay"].as_i64().unwrap() {
                35_000 => backup_snapshots::tick_backup_snapshots(&mut db, &mut ids, now),
                other => panic!("{name}: no callback for a {other} ms timer"),
            },
            (_, Some("/api/backup/snapshots/[filename]")) => {
                let response = backup_writes::download(case["param"].as_str().unwrap());
                wire = Some(wire_of(&rt, response, &dir));
            }
            (_, route) => {
                let method: Method = case["method"].as_str().unwrap().parse().unwrap();
                let spec = writes::lookup(route.unwrap(), &method)
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
                wire = Some(wire_of(&rt, response.expect("at least one request"), &dir));
            }
        }
        backup::set_test_env(None);
        drop(db);
        drop(state);
        let conn = Arc::try_unwrap(conn).unwrap().into_inner().unwrap();
        let stream = Arc::try_unwrap(log).unwrap().into_inner().unwrap();

        let expected = &case["expected"];
        let mut expected_wire = (!expected.is_null()).then(|| {
            json!({
                "status": expected["status"], "body": expected["body"], "type": expected["type"],
                "retryAfter": expected["retryAfter"], "disposition": expected["disposition"],
                "cacheControl": expected["cacheControl"],
                "backupVersion": expected["backupVersion"],
            })
        });
        if case["compare"] == json!("collision") {
            for w in [&mut wire, &mut expected_wire].into_iter().flatten() {
                w["body"] = json!(blank_collisions(w["body"].as_str().unwrap()));
            }
        }
        // JSON has one number type: the restore binds `34` as the double
        // Node binds it as, and the recorded stream spells it `34`.
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
        let disk = list_disk(&dir);
        let key_after = std::fs::read_to_string(dir.join("backup-signing.key"))
            .map_or(Value::Null, Value::String);
        let foreign_keys: i64 = conn
            .pragma_query_value(None, "foreign_keys", |r| r.get(0))
            .unwrap();

        let mut diffs = vec![];
        if wire != expected_wire {
            diffs.push(format!(
                "wire\n  expected {expected_wire:?}\n  actual   {wire:?}"
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
        if disk != case["disk"] {
            diffs.push(format!(
                "disk\n  expected {}\n  actual   {disk}",
                case["disk"]
            ));
        }
        if key_after != case["keyAfter"] {
            diffs.push(format!(
                "key file\n  expected {}\n  actual   {key_after}",
                case["keyAfter"]
            ));
        }
        if json!(foreign_keys) != case["foreignKeys"] {
            diffs.push(format!("foreign_keys left at {foreign_keys}"));
        }
        if !diffs.is_empty() {
            failures.push(format!("{name}\n{}", diffs.join("\n")));
        }
    }
    let _ = std::fs::remove_dir_all(&root);
    std::env::remove_var("AUDITOR_ADMIN_TOKEN");
    std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
    std::env::remove_var("PRIVACYTRACKER_BIND_HOST");
    assert!(
        failures.is_empty(),
        "{} backup parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

//! Node handler oracle, including raw headers, errors, SQL side effects and
//! filename parsing in three timezones. Files are disposable, never user data.
use super::{backup_snapshots, csp_reports, routes_operations, row::to_sql_value, stats::text};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

fn prepare_files(root: &Path, case: &Value, default_files: &Value) {
    let dir = root.join("backups");
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_file(&dir);
    match text(&case["fileMode"]) {
        "files" => {
            fs::create_dir_all(&dir).unwrap();
            for f in case["files"]
                .as_array()
                .unwrap_or_else(|| default_files.as_array().unwrap())
            {
                let target = dir.join(text(&f["name"]));
                fs::write(&target, text(&f["text"])).unwrap();
                let modified =
                    SystemTime::UNIX_EPOCH + Duration::from_secs_f64(f["mtime"].as_f64().unwrap());
                fs::File::options()
                    .write(true)
                    .open(target)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(modified))
                    .unwrap();
            }
        }
        "not-directory" => fs::write(dir, "not a directory").unwrap(),
        "broken-link" => {
            fs::create_dir_all(&dir).unwrap();
            std::os::unix::fs::symlink(
                root.join("absent"),
                dir.join("privacytracker-snapshot-broken.json"),
            )
            .unwrap();
        }
        _ => (),
    }
}
#[test]
fn nine_operational_handlers_match_node_wire_and_do_not_write() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/operations-cases.json")).unwrap();
    let _env = super::trust::env_lock();
    let previous = std::env::var_os("TZ");
    extern "C" {
        fn tzset();
    }
    std::env::set_var("TZ", "UTC");
    // SAFETY: tzset takes no pointers; this test serializes environment edits.
    unsafe {
        tzset();
    }
    let root = std::env::temp_dir().join(format!("pt-ops-rust-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let mut failures = Vec::new();
    rt.block_on(async {
        for case in fixture["cases"].as_array().unwrap() {
            let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
            conn.pragma_update(None, "foreign_keys", false).unwrap();
            let names = super::stats::query(
                &conn,
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                &[],
            )
            .unwrap();
            for row in names {
                conn.execute(&format!("DELETE FROM \"{}\"", text(&row["name"])), [])
                    .unwrap();
            }
            let base = if case["empty"] == true {
                Vec::new()
            } else {
                fixture["base"].as_array().unwrap().clone()
            };
            for s in base.iter().chain(case["changes"].as_array().unwrap()) {
                conn.execute(
                    text(&s["sql"]),
                    rusqlite::params_from_iter(
                        s["params"].as_array().unwrap().iter().map(to_sql_value),
                    ),
                )
                .unwrap();
            }
            prepare_files(&root, case, &fixture["files"]);
            csp_reports::replace_for_test(case["reports"].as_array().unwrap().clone());
            let before = conn.total_changes();
            let response = if case["route"] == "/api/backup/snapshots" {
                routes_operations::uncaught(
                    backup_snapshots::settings(&conn)
                        .and_then(|s| backup_snapshots::payload_at(s, &root.join("backups"))),
                )
            } else {
                routes_operations::read(
                    &conn,
                    text(&case["route"]),
                    &serde_json::from_value(case["query"].clone()).unwrap(),
                    text(&case["id"]),
                    fixture["now"].as_i64().unwrap(),
                )
            };
            assert_eq!(before, conn.total_changes(), "GET wrote: {}", case["name"]);
            let status = response.status().as_u16();
            let typ = response
                .headers()
                .get("content-type")
                .map(|h| h.to_str().unwrap().to_owned());
            let disposition = response
                .headers()
                .get("content-disposition")
                .map(|h| h.to_str().unwrap().to_owned());
            let body = String::from_utf8(
                axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .to_vec(),
            )
            .unwrap()
            .replace(root.to_str().unwrap(), "<DATA>");
            let actual = json!({"status":status,"body":body,"type":typ,"disposition":disposition});
            if actual != case["expected"] {
                failures.push(format!(
                    "{}\nexpected: {}\nactual: {}",
                    case["name"], case["expected"], actual
                ));
            }
        }
    });
    csp_reports::replace_for_test(Vec::new());
    fs::remove_dir_all(root).unwrap();
    for date in fixture["dates"].as_array().unwrap() {
        std::env::set_var("TZ", text(&date["timezone"]));
        // SAFETY: refresh libc after the serialized timezone environment edit.
        unsafe {
            tzset();
        }
        let actual = json!(crate::jsdate::parse(text(&date["input"])));
        if actual != date["expected"] {
            failures.push(format!(
                "date {} {} expected={} actual={}",
                date["timezone"], date["input"], date["expected"], actual
            ));
        }
    }
    match previous {
        Some(v) => std::env::set_var("TZ", v),
        None => std::env::remove_var("TZ"),
    };
    // SAFETY: restore the original timezone before releasing the env lock.
    unsafe {
        tzset();
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

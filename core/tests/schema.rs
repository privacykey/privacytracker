//! In-crate schema tests. These don't compare against the TypeScript side
//! (that's `scripts/parity/schema-parity.mjs`) — they pin the invariants the
//! Rust migrator owns on its own: it opens, it's idempotent, the expected
//! tables and columns exist, and the data backfills fire.

use std::path::PathBuf;

use privacytracker_core::open_and_migrate;
use rusqlite::Connection;

fn tmp_db(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "pt-core-test-{}-{}-{}.db",
        name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

fn table_names(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn columns(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>("name"))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn fresh_open_creates_full_schema() {
    let path = tmp_db("fresh");
    let conn = open_and_migrate(&path).expect("migrate");

    let tables = table_names(&conn);
    assert_eq!(tables.len(), 28, "expected 28 tables, got {}", tables.len());
    for expected in [
        "apps",
        "privacy_snapshots",
        "feature_flag_overrides",
        "app_verdicts",
        "devices",
        "app_devices",
        "privacy_policy_versions",
    ] {
        assert!(tables.iter().any(|t| t == expected), "missing {expected}");
    }

    // apps carries every ALTER-added column on the fresh path.
    let apps = columns(&conn, "apps");
    for c in [
        "firstSeen",
        "ageRating",
        "hasAccessibilityLabels",
        "genreId",
    ] {
        assert!(apps.iter().any(|x| x == c), "apps missing column {c}");
    }

    // Pragmas took.
    let jm: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(jm.to_lowercase(), "wal");
    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);

    drop(conn);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn reopen_is_idempotent() {
    let path = tmp_db("idem");
    {
        let conn = open_and_migrate(&path).expect("first open");
        // Seed an app so the second open would run the unknown-device backfill
        // exactly once (idempotent thereafter).
        conn.execute(
            "INSERT INTO apps (id, name, url, lastSynced) VALUES ('1','A','',0)",
            [],
        )
        .unwrap();
        drop(conn);
    }
    // Second open must not error and must leave exactly one placeholder device.
    let conn = open_and_migrate(&path).expect("second open");
    let devices: i64 = conn
        .query_row("SELECT COUNT(*) FROM devices", [], |r| r.get(0))
        .unwrap();
    assert_eq!(devices, 1, "one unknown-device placeholder after backfill");
    let links: i64 = conn
        .query_row("SELECT COUNT(*) FROM app_devices", [], |r| r.get(0))
        .unwrap();
    assert_eq!(links, 1, "the one app linked to the placeholder");

    // Third open: still exactly one device, one link (backfill no-ops).
    drop(conn);
    let conn = open_and_migrate(&path).expect("third open");
    let devices: i64 = conn
        .query_row("SELECT COUNT(*) FROM devices", [], |r| r.get(0))
        .unwrap();
    assert_eq!(devices, 1, "backfill must not re-run");

    drop(conn);
    let _ = std::fs::remove_file(&path);
}

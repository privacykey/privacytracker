//! Ports of the three diagnostics snapshots that are facts about the
//! database and its directory rather than about the serving process:
//! `snapshotDatabaseHealth` (`lib/db-health.ts`), `snapshotDisk`
//! (`lib/disk-usage.ts`) and `readLastHealthCheck` (`lib/health-check.ts`).
//!
//! The other diagnostics — the runtime metrics, the error ring, the desktop
//! report — describe the Node process (V8 heap, event-loop lag, console
//! interception) and are a separate question; see `core/README.md`.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use super::settings::get_setting_with;
use crate::jsnum::{js_normalise_value, js_number, js_to_number};

/// `safeStat` / `safeSize`: the file's size, or 0 when it is missing or
/// unreadable. Follows symlinks, as `existsSync` + `statSync` do.
fn safe_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// One PRAGMA's first column. Node reads the column named after the pragma
/// and falls back to the first column — `PRAGMA busy_timeout` answers in a
/// column called `timeout`, which is why the fallback exists. Reading
/// column 0 covers both.
fn pragma_i64(conn: &Connection, name: &str) -> i64 {
    conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get::<_, i64>(0))
        .optional()
        .ok()
        .flatten()
        .unwrap_or(0)
}

fn pragma_string(conn: &Connection, name: &str) -> String {
    conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".to_string())
}

/// `DatabaseHealthSnapshot`, fields in the literal's order.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DatabaseHealth {
    pub path: String,
    #[serde(rename = "fileBytes")]
    pub file_bytes: u64,
    #[serde(rename = "walBytes")]
    pub wal_bytes: u64,
    #[serde(rename = "shmBytes")]
    pub shm_bytes: u64,
    #[serde(rename = "pageCount")]
    pub page_count: i64,
    #[serde(rename = "pageSize")]
    pub page_size: i64,
    #[serde(rename = "freelistCount")]
    pub freelist_count: i64,
    #[serde(rename = "utilisationPct")]
    pub utilisation_pct: i64,
    #[serde(rename = "journalMode")]
    pub journal_mode: String,
    #[serde(rename = "busyTimeoutMs")]
    pub busy_timeout_ms: i64,
    #[serde(rename = "foreignKeysEnabled")]
    pub foreign_keys_enabled: i64,
    #[serde(rename = "walAutocheckpoint")]
    pub wal_autocheckpoint: i64,
    /// The in-process cache of the last manual integrity check. This
    /// server has no `POST` yet, so it is always the initial `null` —
    /// which is also what Node answers until the button is pressed.
    #[serde(rename = "integrityCheck")]
    pub integrity_check: Option<Value>,
}

/// `snapshotDatabaseHealth()`. `path` is the file the connection opened.
pub fn snapshot_database_health(conn: &Connection, db_path: &Path) -> DatabaseHealth {
    let page_count = pragma_i64(conn, "page_count");
    let freelist_count = pragma_i64(conn, "freelist_count");
    let utilisation_pct = if page_count > 0 {
        ((page_count - freelist_count) as f64 / page_count as f64 * 100.0).round() as i64
    } else {
        0
    };
    DatabaseHealth {
        path: db_path.display().to_string(),
        file_bytes: safe_size(db_path),
        wal_bytes: safe_size(&sidecar(db_path, "-wal")),
        shm_bytes: safe_size(&sidecar(db_path, "-shm")),
        page_count,
        page_size: pragma_i64(conn, "page_size"),
        freelist_count,
        utilisation_pct,
        journal_mode: pragma_string(conn, "journal_mode"),
        busy_timeout_ms: pragma_i64(conn, "busy_timeout"),
        foreign_keys_enabled: pragma_i64(conn, "foreign_keys"),
        wal_autocheckpoint: pragma_i64(conn, "wal_autocheckpoint"),
        integrity_check: None,
    }
}

/// `${dbPath}-wal` — string concatenation, not an extension swap.
fn sidecar(db_path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut s = db_path.as_os_str().to_os_string();
    s.push(suffix);
    std::path::PathBuf::from(s)
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DiskFiles {
    pub db: u64,
    pub wal: u64,
    pub shm: u64,
    pub backups: u64,
}

/// `DiskSnapshot`, fields in the literal's order.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DiskSnapshot {
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    #[serde(rename = "dataDirBytes")]
    pub data_dir_bytes: u64,
    #[serde(rename = "freeBytes")]
    pub free_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "freePct")]
    pub free_pct: i64,
    pub files: DiskFiles,
    #[serde(rename = "lastBackupSnapshotAt")]
    pub last_backup_snapshot_at: Value,
    #[serde(rename = "backupSnapshotCount")]
    pub backup_snapshot_count: u64,
}

struct DirSize {
    total: u64,
    backups_bytes: u64,
    backup_count: u64,
}

/// `dataDirSize`: regular files one level deep, plus the files inside a
/// `backups/` child, counting the `.json` ones. `isFile()` on a dirent does
/// NOT follow symlinks, so a symlinked file is skipped — as in Node.
fn data_dir_size(dir: &Path) -> DirSize {
    let mut out = DirSize {
        total: 0,
        backups_bytes: 0,
        backup_count: 0,
    };
    if !dir.exists() {
        return out;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let full = entry.path();
        if kind.is_file() {
            out.total += safe_size(&full);
        } else if kind.is_dir() && entry.file_name() == "backups" {
            let Ok(subs) = std::fs::read_dir(&full) else {
                continue;
            };
            for sub in subs.flatten() {
                if !sub.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let size = safe_size(&sub.path());
                out.total += size;
                out.backups_bytes += size;
                if sub.file_name().to_string_lossy().ends_with(".json") {
                    out.backup_count += 1;
                }
            }
        }
    }
    out
}

/// `snapshotDisk()`, with the connection lock held (one setting read).
pub fn snapshot_disk(conn: &Connection, data_dir: &Path) -> rusqlite::Result<DiskSnapshot> {
    let db_path = data_dir.join("privacy.db");
    let sizes = data_dir_size(data_dir);
    let (free_bytes, total_bytes) = super::osinfo::volume_bytes(data_dir).unwrap_or((0, 0));
    let free_pct = if total_bytes > 0 {
        (free_bytes as f64 / total_bytes as f64 * 100.0).round() as i64
    } else {
        0
    };
    // `getSetting(key)` with no default, then `raw ? Number(raw) || null :
    // null` — NaN and 0 both collapse to null.
    let raw = get_setting_with(conn, "backup_snapshot_last_run_at", "")?;
    let last_backup_snapshot_at = if raw.is_empty() {
        Value::Null
    } else {
        let n = js_to_number(&Value::String(raw));
        if n.is_nan() || n == 0.0 {
            Value::Null
        } else {
            js_number(n)
        }
    };
    Ok(DiskSnapshot {
        data_dir: data_dir.display().to_string(),
        data_dir_bytes: sizes.total,
        free_bytes,
        total_bytes,
        free_pct,
        files: DiskFiles {
            db: safe_size(&db_path),
            wal: safe_size(&sidecar(&db_path, "-wal")),
            shm: safe_size(&sidecar(&db_path, "-shm")),
            backups: sizes.backups_bytes,
        },
        last_backup_snapshot_at,
        backup_snapshot_count: sizes.backup_count,
    })
}

const HEALTH_LAST_RESULT_KEY: &str = "health_check_last_result";
/// `RESULT_VERSION` in lib/health-check.ts. A blob of any other version —
/// or one that is not an object — reads as never run.
const RESULT_VERSION: f64 = 1.0;

/// `readLastHealthCheck()`: the stored blob re-emitted as is, or `None`.
/// Numbers are re-rendered the JavaScript way so a `JSON.parse` →
/// `JSON.stringify` round trip is exact.
pub fn read_last_health_check(conn: &Connection) -> rusqlite::Result<Option<Value>> {
    let raw = get_setting_with(conn, HEALTH_LAST_RESULT_KEY, "")?;
    if raw.is_empty() {
        return Ok(None);
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    let is_current = parsed
        .as_object()
        .and_then(|o| o.get("version"))
        .and_then(Value::as_f64)
        == Some(RESULT_VERSION);
    if !is_current {
        return Ok(None);
    }
    Ok(Some(js_normalise_value(parsed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pt-core-diag-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn database_health_reads_the_pragmas_the_migrator_set() {
        let dir = temp_dir("dbhealth");
        let db = dir.join("privacy.db");
        let conn = crate::db::open_and_migrate(&db).unwrap();
        let h = snapshot_database_health(&conn, &db);
        assert_eq!(h.path, db.display().to_string());
        assert_eq!(h.journal_mode, "wal");
        assert_eq!(h.busy_timeout_ms, 5000);
        assert_eq!(h.foreign_keys_enabled, 1);
        assert_eq!(h.wal_autocheckpoint, 1000);
        assert!(h.page_count > 0 && h.page_size > 0);
        assert_eq!(h.utilisation_pct, 100);
        assert!(h.file_bytes > 0);
        assert_eq!(h.integrity_check, None);
        let json = serde_json::to_string(&h).unwrap();
        assert!(json.starts_with(r#"{"path":"#));
        assert!(json.ends_with(r#""integrityCheck":null}"#));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_snapshot_counts_backups_and_folds_the_last_run_setting() {
        let dir = temp_dir("disk");
        let db = dir.join("privacy.db");
        let conn = crate::db::open_and_migrate(&db).unwrap();
        std::fs::create_dir_all(dir.join("backups")).unwrap();
        std::fs::write(dir.join("backups/a.json"), b"{}").unwrap();
        std::fs::write(dir.join("backups/b.json"), b"{\"x\":1}").unwrap();
        std::fs::write(dir.join("backups/notes.txt"), b"not a snapshot").unwrap();
        std::fs::write(dir.join("stray.bin"), b"12345").unwrap();

        let s = snapshot_disk(&conn, &dir).unwrap();
        assert_eq!(s.data_dir, dir.display().to_string());
        assert_eq!(s.backup_snapshot_count, 2);
        assert_eq!(s.files.backups, 2 + 7 + 14);
        assert!(s.files.db > 0);
        assert!(s.data_dir_bytes >= s.files.db + s.files.backups + 5);
        assert!(s.total_bytes > 0, "statfs worked");
        assert!((0..=100).contains(&s.free_pct));
        assert_eq!(s.last_backup_snapshot_at, Value::Null);

        for (raw, expected) in [
            ("1700000000000", serde_json::json!(1_700_000_000_000i64)),
            ("0", Value::Null),
            ("abc", Value::Null),
            (" 12 ", serde_json::json!(12)),
            ("1.5", serde_json::json!(1.5)),
        ] {
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('backup_snapshot_last_run_at', ?)",
                [raw],
            )
            .unwrap();
            assert_eq!(
                snapshot_disk(&conn, &dir).unwrap().last_backup_snapshot_at,
                expected,
                "{raw:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn last_health_check_requires_a_current_object_blob() {
        let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
        let set = |v: &str| {
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('health_check_last_result', ?)",
                [v],
            )
            .unwrap();
        };
        assert_eq!(read_last_health_check(&conn).unwrap(), None);
        set("");
        assert_eq!(read_last_health_check(&conn).unwrap(), None);
        set("not json");
        assert_eq!(read_last_health_check(&conn).unwrap(), None);
        set(r#"{"version":2,"status":"ok"}"#);
        assert_eq!(read_last_health_check(&conn).unwrap(), None);
        set(r#"{"version":"1","status":"ok"}"#);
        assert_eq!(
            read_last_health_check(&conn).unwrap(),
            None,
            "strict equality: the string \"1\" is not 1"
        );
        set(r#"[1]"#);
        assert_eq!(read_last_health_check(&conn).unwrap(), None);
        set(r#"{"version":1,"durationMs":3.0,"checks":{"database":{"utilisationPct":100}}}"#);
        let got = read_last_health_check(&conn).unwrap().unwrap();
        assert_eq!(
            got.to_string(),
            r#"{"version":1,"durationMs":3,"checks":{"database":{"utilisationPct":100}}}"#
        );
        // JSON.parse("1.0") === 1, so a float-spelled version still matches.
        set(r#"{"version":1.0}"#);
        assert!(read_last_health_check(&conn).unwrap().is_some());
    }
}

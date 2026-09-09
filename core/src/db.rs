//! The SQLite schema + migration contract — a faithful port of `lib/db.ts`.
//!
//! `db.ts` opens the database, sets three pragmas, runs one big
//! `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` block, then
//! applies a sequence of guarded `ALTER TABLE ADD COLUMN` migrations and a
//! handful of idempotent data backfills. On a fresh database every column
//! already exists so the ALTERs no-op; on an existing install the
//! `CREATE … IF NOT EXISTS` statements no-op and the ALTERs fill in the
//! columns added since that install was created. Both paths converge on the
//! same final schema — that convergence is the contract this crate must
//! reproduce.
//!
//! The order below mirrors `db.ts` statement-for-statement. Do not reorder:
//! several backfills read state that an earlier ALTER establishes (e.g. the
//! `pending_search` heal needs `import_items` to exist with its current
//! columns; the `idx_import_items_queue` partial index needs
//! `next_attempt_at` present first). The parity harness fails loudly if this
//! drifts from `db.ts`.

use std::path::Path;

use rusqlite::Connection;

use crate::schema_sql::SCHEMA_SQL;

/// Open (creating if needed) the database at `path`, apply the full schema +
/// migration contract, and return the live connection. Mirrors the module
/// side effects of `lib/db.ts`.
pub fn open_and_migrate(path: &Path) -> rusqlite::Result<Connection> {
    ensure_data_dir(path);

    let conn = Connection::open(path)?;

    // db.ts tightens permissions immediately after open and BEFORE the WAL
    // pragma, so the -wal/-shm sidecars are born 0600 (SQLite copies the
    // main file's mode onto them at creation).
    tighten_permissions(path);

    // Pragma order and values mirror db.ts exactly.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    // 1. The full CREATE TABLE / CREATE INDEX block, verbatim from db.ts.
    conn.execute_batch(SCHEMA_SQL)?;

    // 2. apps column migrations (19 pairs).
    apply_col_migrations(
        &conn,
        "apps",
        &[
            (
                "firstSeen",
                "ALTER TABLE apps ADD COLUMN firstSeen INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "changeCount",
                "ALTER TABLE apps ADD COLUMN changeCount INTEGER NOT NULL DEFAULT 0",
            ),
            ("bundleId", "ALTER TABLE apps ADD COLUMN bundleId TEXT"),
            ("developer", "ALTER TABLE apps ADD COLUMN developer TEXT"),
            (
                "privacyPolicyUrl",
                "ALTER TABLE apps ADD COLUMN privacyPolicyUrl TEXT",
            ),
            (
                "changes_acknowledged_at",
                "ALTER TABLE apps ADD COLUMN changes_acknowledged_at INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "changes_snoozed_until",
                "ALTER TABLE apps ADD COLUMN changes_snoozed_until INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "currentVersion",
                "ALTER TABLE apps ADD COLUMN currentVersion TEXT",
            ),
            (
                "versionUpdatedAt",
                "ALTER TABLE apps ADD COLUMN versionUpdatedAt INTEGER",
            ),
            ("whatsNew", "ALTER TABLE apps ADD COLUMN whatsNew TEXT"),
            (
                "hasPrivacyDetails",
                "ALTER TABLE apps ADD COLUMN hasPrivacyDetails INTEGER",
            ),
            (
                "hasAccessibilityLabels",
                "ALTER TABLE apps ADD COLUMN hasAccessibilityLabels INTEGER",
            ),
            (
                "priceAmount",
                "ALTER TABLE apps ADD COLUMN priceAmount REAL",
            ),
            (
                "priceCurrency",
                "ALTER TABLE apps ADD COLUMN priceCurrency TEXT",
            ),
            (
                "priceFormatted",
                "ALTER TABLE apps ADD COLUMN priceFormatted TEXT",
            ),
            ("hasIap", "ALTER TABLE apps ADD COLUMN hasIap INTEGER"),
            ("genreId", "ALTER TABLE apps ADD COLUMN genreId INTEGER"),
            ("genreName", "ALTER TABLE apps ADD COLUMN genreName TEXT"),
            ("ageRating", "ALTER TABLE apps ADD COLUMN ageRating TEXT"),
        ],
    )?;

    // 3. privacy_categories.type_id (single).
    apply_col_migrations(
        &conn,
        "privacy_categories",
        &[(
            "type_id",
            "ALTER TABLE privacy_categories ADD COLUMN type_id TEXT REFERENCES privacy_types(id) ON DELETE CASCADE",
        )],
    )?;

    // 4. privacy_snapshots column migrations (5 pairs).
    apply_col_migrations(
        &conn,
        "privacy_snapshots",
        &[
            (
                "source",
                "ALTER TABLE privacy_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'live'",
            ),
            (
                "wayback_snapshot_url",
                "ALTER TABLE privacy_snapshots ADD COLUMN wayback_snapshot_url TEXT",
            ),
            (
                "triggered_by",
                "ALTER TABLE privacy_snapshots ADD COLUMN triggered_by TEXT",
            ),
            (
                "app_version",
                "ALTER TABLE privacy_snapshots ADD COLUMN app_version TEXT",
            ),
            (
                "app_version_updated_at",
                "ALTER TABLE privacy_snapshots ADD COLUMN app_version_updated_at INTEGER",
            ),
        ],
    )?;

    // 5. change_review_actions.covered_snapshot_ids (single).
    apply_col_migrations(
        &conn,
        "change_review_actions",
        &[(
            "covered_snapshot_ids",
            "ALTER TABLE change_review_actions ADD COLUMN covered_snapshot_ids TEXT",
        )],
    )?;

    // 6. import_items column migrations (5 pairs).
    apply_col_migrations(
        &conn,
        "import_items",
        &[
            (
                "removed_app_id",
                "ALTER TABLE import_items ADD COLUMN removed_app_id TEXT",
            ),
            (
                "icon_url",
                "ALTER TABLE import_items ADD COLUMN icon_url TEXT",
            ),
            (
                "country",
                "ALTER TABLE import_items ADD COLUMN country TEXT",
            ),
            (
                "next_attempt_at",
                "ALTER TABLE import_items ADD COLUMN next_attempt_at INTEGER",
            ),
            (
                "attempt_count",
                "ALTER TABLE import_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
            ),
        ],
    )?;

    // 7. Queue hot-path partial index — created AFTER the import_items ALTERs
    //    because it references next_attempt_at.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_import_items_queue ON import_items(status, next_attempt_at) WHERE status = 'queued'",
    )?;

    // 8. imports.device_id (single).
    apply_col_migrations(
        &conn,
        "imports",
        &[("device_id", "ALTER TABLE imports ADD COLUMN device_id TEXT")],
    )?;

    // 9. Unknown-device backfill (non-fatal). If any apps exist but no
    //    devices do, create one placeholder device and link every app to it.
    backfill_unknown_device(&conn);

    // 10. pending_search heal (non-fatal): URL-less 'queued' rows belong to
    //     the client-side search retry path, not the server queue worker.
    if let Err(e) = conn.execute_batch(
        "UPDATE import_items SET status = 'pending_search' WHERE status = 'queued' AND (url IS NULL OR url = '')",
    ) {
        warn("pending_search backfill", &e);
    }

    // 11. shortlist_entries.mode (single).
    apply_col_migrations(
        &conn,
        "shortlist_entries",
        &[(
            "mode",
            "ALTER TABLE shortlist_entries ADD COLUMN mode TEXT NOT NULL DEFAULT 'privacy'",
        )],
    )?;

    // 12. notifications column migrations (2 pairs).
    apply_col_migrations(
        &conn,
        "notifications",
        &[
            (
                "stale",
                "ALTER TABLE notifications ADD COLUMN stale INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "not_before",
                "ALTER TABLE notifications ADD COLUMN not_before INTEGER",
            ),
        ],
    )?;

    // 13. Bell unread-count index — references not_before, so after its ALTER.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read, not_before)",
    )?;

    // 14. privacy_policy_analyses column migrations (10 pairs).
    apply_col_migrations(
        &conn,
        "privacy_policy_analyses",
        &[
            (
                "source_origin",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN source_origin TEXT",
            ),
            (
                "source_final_url",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN source_final_url TEXT",
            ),
            (
                "previous_summary_json",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN previous_summary_json TEXT",
            ),
            (
                "previous_summary_at",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN previous_summary_at INTEGER",
            ),
            (
                "last_run_log",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN last_run_log TEXT",
            ),
            (
                "source_fetched_at",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN source_fetched_at INTEGER",
            ),
            (
                "chunk_notes_json",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN chunk_notes_json TEXT",
            ),
            (
                "chunk_notes_hash",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN chunk_notes_hash TEXT",
            ),
            (
                "run_status",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN run_status TEXT",
            ),
            (
                "run_started_at",
                "ALTER TABLE privacy_policy_analyses ADD COLUMN run_started_at INTEGER",
            ),
        ],
    )?;

    // 15. Crash recovery (non-fatal): a row stuck at run_status='running'
    //     from a killed process is flipped back to 'idle' on boot.
    if let Err(e) = conn.execute_batch(
        "UPDATE privacy_policy_analyses SET run_status = 'idle' WHERE run_status = 'running'",
    ) {
        warn("clearing stale policy run_status", &e);
    }

    // 16. privacy_policy_versions Internet-Archive column migrations (2 pairs).
    apply_col_migrations(
        &conn,
        "privacy_policy_versions",
        &[
            (
                "archive_url",
                "ALTER TABLE privacy_policy_versions ADD COLUMN archive_url TEXT",
            ),
            (
                "archive_submitted_at",
                "ALTER TABLE privacy_policy_versions ADD COLUMN archive_submitted_at INTEGER",
            ),
        ],
    )?;

    // 17. One-time seed (non-fatal): populate privacy_policy_versions from any
    //     existing privacy_policy_analyses rows whose (app_id, content_hash)
    //     pair isn't present yet. Idempotent via NOT EXISTS.
    if let Err(e) = conn.execute_batch(POLICY_VERSIONS_SEED_SQL) {
        warn("privacy_policy_versions backfill", &e);
    }

    Ok(conn)
}

/// Open, migrate, checkpoint, and close the database at `path`. The
/// checkpoint truncates the WAL so a subsequent reader (the parity dumper)
/// sees a settled main database file.
pub fn migrate_file(path: impl AsRef<Path>) -> rusqlite::Result<()> {
    let conn = open_and_migrate(path.as_ref())?;
    // Best-effort settle of the WAL; harmless if it can't run.
    let _ = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE");
    conn.close().map_err(|(_, e)| e)
}

// ── helpers ─────────────────────────────────────────────────────────────

/// The set of columns currently on `table`, via PRAGMA table_info. db.ts
/// snapshots this once before each migration group and checks membership, so
/// we do the same.
fn existing_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt
        .query_map([], |row| row.get::<_, String>("name"))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(cols)
}

/// Port of db.ts's `applyColumnMigrations` / `applySingleColumnMigration`:
/// add each column whose name is absent, swallowing only the
/// "duplicate column name" race error (parallel `next build` workers can
/// each try the same ALTER).
fn apply_col_migrations(
    conn: &Connection,
    table: &str,
    pairs: &[(&str, &str)],
) -> rusqlite::Result<()> {
    let cols = existing_columns(conn, table)?;
    for (col, sql) in pairs {
        if cols.iter().any(|c| c == col) {
            continue;
        }
        match conn.execute_batch(sql) {
            Ok(()) => {}
            Err(e) if is_duplicate_column(&e) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn is_duplicate_column(e: &rusqlite::Error) -> bool {
    e.to_string()
        .to_lowercase()
        .contains("duplicate column name")
}

/// db.ts's unknown-device backfill, non-fatal (wrapped in try/catch there).
/// The synthesised id uses SQLite's randomblob, exactly as db.ts does — the
/// value is non-deterministic and schema-irrelevant; the parity harness
/// compares device/link COUNTS, not ids.
fn backfill_unknown_device(conn: &Connection) {
    let result: rusqlite::Result<()> = (|| {
        let device_count: i64 = conn.query_row("SELECT COUNT(*) FROM devices", [], |r| r.get(0))?;
        let app_count: i64 = conn.query_row("SELECT COUNT(*) FROM apps", [], |r| r.get(0))?;
        if device_count == 0 && app_count > 0 {
            let placeholder_id: String =
                conn.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
            let now = now_ms();
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO devices (id, name, ecid, model, ios_version, device_class, \
                 created_at, last_synced_at, is_unknown_placeholder) \
                 VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, 1)",
                rusqlite::params![placeholder_id, "Unknown device", now, now],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO app_devices (app_id, device_id, first_seen_at, last_seen_at) \
                 SELECT id, ?, COALESCE(firstSeen, lastSynced, ?), ? FROM apps",
                rusqlite::params![placeholder_id, now, now],
            )?;
            tx.commit()?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        warn("unknown-device backfill", &e);
    }
}

/// Ensure the parent directory of the db file exists with 0700, mirroring
/// db.ts's `fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })`.
fn ensure_data_dir(path: &Path) {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            let _ = std::fs::create_dir_all(dir);
            set_mode(dir, 0o700);
        }
    }
}

/// Port of `tightenDataPermissions`: 0700 on the data dir, 0600 on the db and
/// its -wal/-shm sidecars. Best-effort; a permissions failure must never stop
/// the database opening. No-op on non-Unix (chmod modes are meaningless).
fn tighten_permissions(path: &Path) {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            set_mode(dir, 0o700);
        }
    }
    set_mode(path, 0o600);
    set_mode(&with_suffix(path, "-wal"), 0o600);
    set_mode(&with_suffix(path, "-shm"), 0o600);
}

fn with_suffix(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    std::path::PathBuf::from(s)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    // Missing target (WAL not created yet) or an FS without POSIX modes: skip.
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn warn(context: &str, e: &rusqlite::Error) {
    eprintln!("[db] {context} failed: {e}");
}

/// Verbatim from db.ts — the INSERT … SELECT that seeds
/// privacy_policy_versions from privacy_policy_analyses. Idempotent.
const POLICY_VERSIONS_SEED_SQL: &str = r#"
    INSERT INTO privacy_policy_versions (
      id, app_id, content_hash, first_fetched_at, last_fetched_at,
      policy_url, source_final_url, source_title, source_content_type,
      source_origin, source_word_count, source_text
    )
    SELECT
      substr(lower(hex(randomblob(16))), 1, 8) || '-'
        || substr(lower(hex(randomblob(16))), 1, 4) || '-'
        || substr(lower(hex(randomblob(16))), 1, 4) || '-'
        || substr(lower(hex(randomblob(16))), 1, 4) || '-'
        || substr(lower(hex(randomblob(16))), 1, 12),
      a.app_id,
      a.content_hash,
      COALESCE(a.source_fetched_at, a.updated_at),
      COALESCE(a.source_fetched_at, a.updated_at),
      a.policy_url,
      a.source_final_url,
      a.source_title,
      a.source_content_type,
      a.source_origin,
      a.source_word_count,
      a.source_text
    FROM privacy_policy_analyses a
    WHERE a.content_hash IS NOT NULL
      AND a.source_text IS NOT NULL
      AND length(a.source_text) > 0
      AND NOT EXISTS (
        SELECT 1 FROM privacy_policy_versions v
        WHERE v.app_id = a.app_id
          AND v.content_hash = a.content_hash
      );
"#;

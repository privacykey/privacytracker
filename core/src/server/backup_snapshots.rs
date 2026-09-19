//! lib/backup-snapshots.ts: the snapshot settings, the `backups/`
//! directory listing, and — since Phase 4, batch 5b — creating a snapshot,
//! pruning past the retention count, finding one to download, and the
//! startup hook's "is one due yet?" tick.
use super::{
    activity_log::record_activity,
    backup::{self, Env},
    json::js_json_pretty_vec,
    settings::get_setting_with,
    stats::{truthy, Result},
    user_content::integer,
    writes::{prop, Cx},
};
use crate::{
    jsdate::js_iso_string,
    jsnum::{js_number, js_parse_int},
    jsstr::js_string,
    scrape::persist::{DbAccess, Ids},
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const SNAPSHOT_PREFIX: &str = "privacytracker-snapshot-";
const SNAPSHOT_SUFFIX: &str = ".json";
const ENABLED: &str = "backup_snapshot_enabled";
const INTERVAL_HOURS: &str = "backup_snapshot_interval_hours";
const RETENTION_COUNT: &str = "backup_snapshot_retention_count";
const LAST_RUN_AT: &str = "backup_snapshot_last_run_at";

pub(super) fn settings(conn: &Connection) -> Result<Value> {
    let enabled = get_setting_with(conn, ENABLED, "false")? == "true";
    let interval = integer(&get_setting_with(conn, INTERVAL_HOURS, "24")?)
        .unwrap_or(24.0)
        .clamp(1.0, 720.0);
    let retention = integer(&get_setting_with(conn, RETENTION_COUNT, "10")?)
        .unwrap_or(10.0)
        .clamp(1.0, 100.0);
    let last = integer(&get_setting_with(conn, LAST_RUN_AT, "0")?).filter(|n| *n > 0.0);
    let next = if enabled {
        last.map(|n| n + interval * 3_600_000.0)
    } else {
        None
    };
    Ok(
        json!({"enabled":enabled,"intervalHours":js_number(interval),"retentionCount":js_number(retention),"lastRunAt":last.map(js_number),"nextRunAt":next.map(js_number)}),
    )
}

/// `sanitizeIntervalHours` / `sanitizeRetentionCount`: a number as it is,
/// anything else through `parseInt(String(raw ?? ""))`, the default when
/// that is not finite, then rounded the way `Math.round` rounds and
/// clamped.
fn sanitize(raw: &Value, default: f64, max: f64) -> f64 {
    let value = match raw {
        Value::Number(n) => n.as_f64(),
        Value::Null => None,
        other => js_parse_int(&js_string(other)).map(|n| n as f64),
    };
    match value {
        Some(v) if v.is_finite() => (v + 0.5).floor().clamp(1.0, max),
        _ => default,
    }
}

/// `saveBackupSnapshotSettings`: each key the body carries — `null`
/// included, only `undefined` is skipped — coerced and stored.
pub(super) fn save_settings(cx: &mut Cx, body: &Value) -> std::result::Result<(), String> {
    if let Some(enabled) = prop(body, "enabled") {
        cx.set(ENABLED, if truthy(enabled) { "true" } else { "false" })?;
    }
    if let Some(hours) = prop(body, "intervalHours") {
        let hours = sanitize(hours, 24.0, 720.0);
        cx.set(INTERVAL_HOURS, &(hours as i64).to_string())?;
    }
    if let Some(count) = prop(body, "retentionCount") {
        let count = sanitize(count, 10.0, 100.0);
        cx.set(RETENTION_COUNT, &(count as i64).to_string())?;
    }
    Ok(())
}

pub(super) fn directory(env: &Env) -> PathBuf {
    env.data_dir.join("backups")
}

pub(super) fn payload(settings: Value) -> Result<Value> {
    payload_at(settings, &directory(&backup::env()))
}

fn is_snapshot_filename(filename: &str) -> bool {
    // `path.basename(filename) === filename`, then the affixes.
    !filename.contains('/')
        && filename.starts_with(SNAPSHOT_PREFIX)
        && filename.ends_with(SNAPSHOT_SUFFIX)
}

fn timestamp(filename: &str) -> Option<i64> {
    let raw = filename
        .strip_prefix(SNAPSHOT_PREFIX)?
        .strip_suffix(SNAPSHOT_SUFFIX)?;
    let mut bytes = raw.as_bytes().to_vec();
    if bytes.len() == 24
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 | 13 | 16 | 19 => *b == b'-',
            10 => *b == b'T',
            23 => *b == b'Z',
            _ => b.is_ascii_digit(),
        })
    {
        bytes[13] = b':';
        bytes[16] = b':';
        bytes[19] = b'.';
    }
    crate::jsdate::parse(std::str::from_utf8(&bytes).ok()?)
}

/// `listBackupSnapshots`: newest first by the timestamp in the name, or by
/// mtime where the name carries none.
fn list(directory: &Path) -> Result<Vec<Value>> {
    let mut snapshots = Vec::new();
    if directory.exists() {
        let mut entries = std::fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let filename = entry.file_name().to_string_lossy().into_owned();
            if !(filename.starts_with(SNAPSHOT_PREFIX) && filename.ends_with(SNAPSHOT_SUFFIX)) {
                continue;
            }
            // stat follows symlinks, includes matching directories, and any
            // failed stat aborts the whole listing exactly like Node's map().
            let path = entry.path();
            let stat = std::fs::metadata(&path)?;
            let created = timestamp(&filename)
                .map(|n| n as f64)
                .unwrap_or(stat.mtime() as f64 * 1000.0 + stat.mtime_nsec() as f64 / 1_000_000.0);
            snapshots.push(json!({"filename":filename,"path":path,"createdAt":js_number(created),"sizeBytes":js_number(stat.len() as f64)}));
        }
        snapshots.sort_by(|a, b| {
            b["createdAt"]
                .as_f64()
                .unwrap()
                .total_cmp(&a["createdAt"].as_f64().unwrap())
        });
    }
    Ok(snapshots)
}

pub(super) fn payload_at(settings: Value, directory: &Path) -> Result<Value> {
    let snapshots = list(directory)?;
    Ok(json!({"settings":settings,"directory":directory,"snapshots":snapshots}))
}

/// `getBackupSnapshotPath`: the snapshot of that exact name, if it is one
/// and it exists. The name is only ever COMPARED with what the directory
/// lists — never joined onto a path — so a request cannot name a file
/// outside `backups/` however it is spelled. (On a case-insensitive volume
/// Node would also find a name that differs only in case; this does not.)
pub(super) fn snapshot_path(env: &Env, filename: &str) -> Option<PathBuf> {
    if !is_snapshot_filename(filename) {
        return None;
    }
    let entry = std::fs::read_dir(directory(env))
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_str() == Some(filename))?;
    // `fs.existsSync` follows a link: a dangling one is not there.
    let path = entry.path();
    path.exists().then_some(path)
}

/// `pruneBackupSnapshots`: everything past the newest `keep`, unlinked on
/// a best effort and reported either way.
fn prune(directory: &Path, keep: usize) -> Result<Vec<Value>> {
    let extra: Vec<Value> = list(directory)?.into_iter().skip(keep).collect();
    for row in &extra {
        if let Some(name) = row["filename"].as_str() {
            let _ = std::fs::remove_file(directory.join(name));
        }
    }
    Ok(extra)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `createBackupSnapshot`: export, write `<name>.tmp-…` 0600 and rename it
/// into place, stamp the last run, prune, and log the activity. Returns
/// `(snapshot, pruned)`.
pub(super) fn create_snapshot(
    cx: &mut Cx,
    env: &Env,
    triggered_by: &str,
) -> std::result::Result<(Value, Vec<Value>), String> {
    let dir = directory(env);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let started_at = cx.now;
    let envelope = backup::export_backup(cx, env)?;
    let exported_at = envelope.exported_at.as_i64().unwrap_or(started_at);
    let stamp = js_iso_string(exported_at).replace([':', '.'], "-");
    let mut filename = format!("{SNAPSHOT_PREFIX}{stamp}{SNAPSHOT_SUFFIX}");
    let mut collision = 1;
    while dir.join(&filename).exists() {
        collision += 1;
        filename = format!("{SNAPSHOT_PREFIX}{stamp}-{collision}{SNAPSHOT_SUFFIX}");
    }
    let final_path = dir.join(&filename);
    let temp_path = dir.join(format!(
        "{filename}.tmp-{}-{:x}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let body = js_json_pretty_vec(&envelope.into_json()).map_err(|e| e.to_string())?;
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp_path)?;
        f.write_all(&body)?;
        drop(f);
        std::fs::rename(&temp_path, &final_path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp_path);
        return Err(e.to_string());
    }
    cx.set(LAST_RUN_AT, &exported_at.to_string())?;

    let retention = settings(cx.w.conn).map_err(|e| e.to_string())?["retentionCount"]
        .as_u64()
        .unwrap_or(10) as usize;
    let pruned = prune(&dir, retention).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&final_path)
        .map_err(|e| e.to_string())?
        .len();
    let snapshot = json!({
        "filename": filename,
        "path": final_path,
        "createdAt": exported_at,
        "sizeBytes": size,
    });
    // Best effort: the snapshot already exists.
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "backup_export",
        "ok",
        None,
        Some(if triggered_by == "scheduled" {
            "Automatic local backup snapshot created"
        } else {
            "Local backup snapshot created"
        }),
        Some(&json!({
            "mode": "local-snapshot",
            "triggeredBy": triggered_by,
            "filename": filename,
            "bytes": size,
            "pruned": pruned.len(),
            "backupVersion": backup::CURRENT_BACKUP_VERSION,
        })),
        started_at,
    );
    Ok((snapshot, pruned))
}

/// `isBackupSnapshotDue`.
fn is_due(conn: &Connection, now: i64) -> Result<bool> {
    let settings = settings(conn)?;
    if settings["enabled"] != json!(true) {
        return Ok(false);
    }
    let Some(last) = settings["lastRunAt"].as_f64() else {
        return Ok(true);
    };
    let interval = settings["intervalHours"].as_f64().unwrap_or(24.0);
    Ok(now as f64 >= last + interval * 3_600_000.0)
}

/// The startup hook's `tickBackupSnapshots`: a snapshot when one is
/// enabled and due, and a line either way it goes.
pub(crate) fn tick_backup_snapshots(db: &mut dyn DbAccess, ids: &mut dyn Ids, now: i64) {
    db.with(|w| {
        let mut cx = Cx { w, ids, now };
        let outcome = match is_due(cx.w.conn, now) {
            Ok(false) => return,
            Ok(true) => create_snapshot(&mut cx, &backup::env(), "scheduled"),
            Err(e) => Err(e.to_string()),
        };
        match outcome {
            Ok((snapshot, pruned)) => log::info!(
                "[BackupSnapshots] Created {}; pruned {}",
                snapshot["filename"].as_str().unwrap_or(""),
                pruned.len()
            ),
            Err(e) => super::diag::log_error(format!("[BackupSnapshots] Tick failed: {e}")),
        }
    });
}

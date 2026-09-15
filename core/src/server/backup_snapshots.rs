//! Snapshot settings and directory listing. No backup creation or pruning.
use super::{settings::get_setting_with, stats::Result, user_content::integer};
use crate::jsnum::js_number;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{os::unix::fs::MetadataExt, path::Path};

pub(super) fn settings(conn: &Connection) -> Result<Value> {
    let enabled = get_setting_with(conn, "backup_snapshot_enabled", "false")? == "true";
    let interval = integer(&get_setting_with(
        conn,
        "backup_snapshot_interval_hours",
        "24",
    )?)
    .unwrap_or(24.0)
    .clamp(1.0, 720.0);
    let retention = integer(&get_setting_with(
        conn,
        "backup_snapshot_retention_count",
        "10",
    )?)
    .unwrap_or(10.0)
    .clamp(1.0, 100.0);
    let last =
        integer(&get_setting_with(conn, "backup_snapshot_last_run_at", "0")?).filter(|n| *n > 0.0);
    let next = if enabled {
        last.map(|n| n + interval * 3_600_000.0)
    } else {
        None
    };
    Ok(
        json!({"enabled":enabled,"intervalHours":js_number(interval),"retentionCount":js_number(retention),"lastRunAt":last.map(js_number),"nextRunAt":next.map(js_number)}),
    )
}
pub(super) fn payload(settings: Value) -> Result<Value> {
    let directory = super::data_layout().data_dir.join("backups");
    payload_at(settings, &directory)
}
fn timestamp(filename: &str) -> Option<i64> {
    let raw = filename
        .strip_prefix("privacytracker-snapshot-")?
        .strip_suffix(".json")?;
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
    super::snapshot_time::parse(std::str::from_utf8(&bytes).ok()?)
}
pub(super) fn payload_at(settings: Value, directory: &Path) -> Result<Value> {
    let mut snapshots = Vec::new();
    if directory.exists() {
        let mut entries = std::fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let filename = entry.file_name().to_string_lossy().into_owned();
            if !(filename.starts_with("privacytracker-snapshot-") && filename.ends_with(".json")) {
                continue;
            }
            // stat follows symlinks, includes matching directories, and any
            // failed stat aborts the whole GET exactly like Node's map().
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
    Ok(json!({"settings":settings,"directory":directory,"snapshots":snapshots}))
}

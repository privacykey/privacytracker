//! Phase 6, batch 2a: the five device routes Phase 4 set aside —
//! `POST /api/device-actions/backup`, `GET` and `POST
//! /api/device-actions/uninstall`, `POST /api/device-sync/preview` and
//! `POST /api/device-sync/commit` — with `lib/device-actions.ts`,
//! `lib/device-backup-verification.ts` and `lib/device-sync.ts` under them.
//!
//! None of them touches hardware: cfgutil runs in the Tauri shell, and
//! these routes record what it did, gate what it may do next, and diff and
//! apply a device's app list. The backup check is the one that reads the
//! disk — a MobileSync backup must be a real, non-empty `Manifest.db` in a
//! direct child of Apple's backup root — and it is ported with Node's
//! checks in Node's order. The root's own parent, whose relative form is
//! `..`, is not a direct child; both used to let it through.
//!
//! Gated by `core/tests/fixtures/device-routes-cases.json`, recorded by
//! `core/scripts/extract-device-routes-cases.mjs` over a MobileSync-shaped
//! tree; `device_writes_tests` replays it.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::{
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::Response,
};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::{
    activity_log::{record_activity, record_activity_client},
    body::BodyOutcome,
    flags::{context_from_db, resolve_flag},
    guard::{record_audit, Actor},
    imports_writes::transaction,
    json::{json_error, json_ok, json_response},
    library_writes::orphan_sweep_app,
    routes_devices,
    settings::get_setting_with,
    writes::{body_json, is_object_like, prop, Cx, RouteSpec, WriteRequest},
    AppState,
};
use crate::jsnum::js_number;
use crate::jsstr::{is_js_whitespace, js_string, js_trim};

/// `BACKUP_FRESHNESS_WINDOW_MS`.
const FRESHNESS_WINDOW_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const BACKUP_PREFIX: &str = "cfgutil_last_backup_";
const SET_SETTING: &str = "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)";
const UPSERT_LINK: &str = "\n    INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at)\n    VALUES (?, ?, ?, ?)\n    ON CONFLICT(app_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at\n  ";
const COPY_LINKS: &str = "\n        INSERT OR IGNORE INTO app_devices (app_id, device_id, first_seen_at, last_seen_at)\n        SELECT ?, device_id, first_seen_at, last_seen_at\n        FROM app_devices WHERE app_id = ?\n      ";
const DELETE_APP_LINKS: &str = "DELETE FROM app_devices WHERE app_id = ?";
const DELETE_APP: &str = "DELETE FROM apps WHERE id = ?";
const DELETE_LINK: &str = "DELETE FROM app_devices WHERE app_id = ? AND device_id = ?";
const TOUCH_DEVICE: &str = "UPDATE devices SET last_synced_at = ? WHERE id = ?";
/// `transferUserDataAcrossAppIds`, in order. Node picks the parameters by
/// counting the `?`s: three is `(new, new, old)`, two is `(new, old)`.
const TRANSFER: [&str; 5] = [
    "UPDATE annotations SET app_id = ? WHERE app_id = ?",
    "\n        DELETE FROM app_verdicts\n        WHERE app_id = ?\n          AND (app_id, source, COALESCE(source_name, ''))\n            IN (\n              SELECT ?, source, COALESCE(source_name, '')\n              FROM app_verdicts WHERE app_id = ?\n            )\n      ",
    "UPDATE app_verdicts SET app_id = ? WHERE app_id = ?",
    "\n        DELETE FROM shortlist_entries\n        WHERE source_app_id = ?\n          AND candidate_name IN (\n            SELECT candidate_name FROM shortlist_entries WHERE source_app_id = ?\n          )\n      ",
    "UPDATE shortlist_entries SET source_app_id = ? WHERE source_app_id = ?",
];
const TRANSFER_SNAPSHOTS: &str = "UPDATE privacy_snapshots SET app_id = ? WHERE app_id = ?";
const PREVIOUS_ROWS: &str = "\n      SELECT ad.app_id AS app_id, a.name AS name, a.bundleId AS bundle_id\n      FROM app_devices ad\n      JOIN apps a ON a.id = ad.app_id\n      WHERE ad.device_id = ?\n    ";
/// `isProposedBundleIdMerge`, bound `(previous, incoming, device, device)`.
const PROPOSED_MERGE: &str = "\n      SELECT 1\n      FROM apps prev\n      JOIN apps inc ON inc.bundleId = prev.bundleId\n      WHERE prev.id = ?\n        AND inc.id = ?\n        AND prev.bundleId != ''\n        AND EXISTS (\n          SELECT 1 FROM app_devices WHERE app_id = prev.id AND device_id = ?\n        )\n        AND NOT EXISTS (\n          SELECT 1 FROM app_devices WHERE app_id = inc.id AND device_id = ?\n        )\n    ";

pub(super) fn handles(spec: &RouteSpec) -> bool {
    spec.method == Method::POST
        && matches!(
            spec.path,
            "/api/device-actions/backup"
                | "/api/device-actions/uninstall"
                | "/api/device-sync/preview"
                | "/api/device-sync/commit"
        )
}

pub(super) fn perform(cx: &mut Cx, req: WriteRequest, actor: &Actor) -> Response {
    match req.spec.path {
        "/api/device-actions/backup" => backup(cx, req.body),
        "/api/device-actions/uninstall" => uninstall_post(cx, req.body),
        "/api/device-sync/preview" => preview(cx, req.body),
        _ => commit(cx, req.body, actor),
    }
}

/// Next's answer when a handler throws: a 500 with no body.
fn thrown() -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    response
}

fn bad(message: &str) -> Response {
    json_error(StatusCode::BAD_REQUEST, message)
}

/// `getActiveFocus().audience`: the stored value or `self`, unchecked.
fn active_audience(conn: &Connection) -> rusqlite::Result<String> {
    let stored = get_setting_with(conn, "flag.focus.audience", "")?;
    Ok(if stored.is_empty() {
        "self".to_string()
    } else {
        stored
    })
}

/// The backup's audience check, which Node makes before it reads the body.
pub(super) fn backup_precheck(conn: &Connection) -> Result<(), Response> {
    match active_audience(conn) {
        Ok(audience) if audience == "self" => Ok(()),
        Ok(_) => Err(json_error(
            StatusCode::FORBIDDEN,
            "Backups can only be recorded under audience=self.",
        )),
        Err(_) => Err(thrown()),
    }
}

// ── lib/device-actions.ts ────────────────────────────────────────────

/// `normalizeEcid`: trimmed, one `0x` stripped, 8 to 24 hex digits,
/// upper-cased.
fn normalize_ecid(value: &str) -> Option<String> {
    let trimmed = js_trim(value);
    let body = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    ((8..=24).contains(&body.len()) && body.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| body.to_ascii_uppercase())
}

/// `getDeviceByEcid`: every row with an ECID, in SQLite's order, the first
/// whose spelling normalises to the same ECID. `safeGetDeviceByEcid`
/// reads a failure as no device.
fn device_by_ecid(conn: &Connection, ecid: &str) -> Option<Value> {
    let target = normalize_ecid(ecid)?;
    let found = (|| -> rusqlite::Result<Option<Value>> {
        let mut stmt =
            conn.prepare("SELECT * FROM devices WHERE ecid IS NOT NULL AND ecid != ''")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let raw: Option<String> = row.get("ecid")?;
            if raw.as_deref().and_then(normalize_ecid).as_deref() == Some(target.as_str()) {
                return routes_devices::device(row).map(Some);
            }
        }
        Ok(None)
    })();
    found.unwrap_or_else(|e| {
        super::diag::log_warn(format!("[device-actions] device lookup failed: {e}"));
        None
    })
}

/// JavaScript truthiness.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `checkDeviceOwnershipGate`.
fn ownership_gate(conn: &Connection, ecid: &str) -> rusqlite::Result<Value> {
    let audience = active_audience(conn)?;
    let device = device_by_ecid(conn, ecid);
    if let Some(device) = &device {
        if let Some(owner) = device["ownerAudience"].as_str() {
            let refused = |reason: &str| {
                json!({
                    "allowed": false,
                    "reason": reason,
                    "activeAudience": audience,
                    "deviceName": device["name"].as_str().unwrap_or(""),
                    "ownerAudience": owner,
                    "ownerLabel": device["ownerLabel"],
                })
            };
            if owner != audience {
                return Ok(refused("device_owner"));
            }
            if owner != "self" && !truthy(&device["permissionAcknowledgedAt"]) {
                return Ok(refused("permission_unacknowledged"));
            }
            return Ok(json!({ "allowed": true }));
        }
    }
    if audience != "self" {
        return Ok(json!({
            "allowed": false,
            "reason": "audience",
            "activeAudience": audience,
        }));
    }
    Ok(json!({ "allowed": true }))
}

/// A stamp as `getLastBackup` hands it back.
struct Stamp {
    finished_at: f64,
    manifest_bytes: Option<Value>,
    path: String,
}

impl Stamp {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("finishedAt".into(), js_number(self.finished_at));
        if let Some(bytes) = &self.manifest_bytes {
            out.insert("manifestBytes".into(), bytes.clone());
        }
        out.insert("path".into(), json!(self.path));
        Value::Object(out)
    }
}

/// `getLastBackup`: nothing for an ECID that does not parse, no stamp, a
/// stamp that is not JSON or not an object, or a completion time that is
/// not a positive number at or before now.
fn last_backup(conn: &Connection, ecid: &str, now: i64) -> rusqlite::Result<Option<Stamp>> {
    let Some(key) = normalize_ecid(ecid) else {
        return Ok(None);
    };
    let raw = get_setting_with(conn, &format!("{BACKUP_PREFIX}{key}"), "")?;
    if raw.is_empty() {
        return Ok(None);
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    let Some(obj) = parsed.as_object() else {
        return Ok(None);
    };
    let Some(finished_at) = obj.get("finishedAt").and_then(Value::as_f64) else {
        return Ok(None);
    };
    if !finished_at.is_finite() || finished_at <= 0.0 || finished_at > now as f64 {
        return Ok(None);
    }
    Ok(Some(Stamp {
        finished_at,
        manifest_bytes: obj
            .get("manifestBytes")
            .filter(|v| v.is_number())
            .map(|v| crate::jsnum::js_normalise_value(v.clone())),
        path: obj
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }))
}

/// `checkUninstallGate`: ownership, then the flag, then (unless the caller
/// acknowledged going without) a verified backup no older than a day.
fn uninstall_gate(conn: &Connection, ecid: &str, ack: bool, now: i64) -> Result<Value, String> {
    let ownership = ownership_gate(conn, ecid).map_err(|e| e.to_string())?;
    if ownership["allowed"] != true {
        return Ok(ownership);
    }
    let ctx = context_from_db(conn).map_err(|e| e.to_string())?;
    let flag =
        resolve_flag("flag.devopts.cfgutil_uninstall", &ctx).map_err(|e| format!("{e:?}"))?;
    if flag != "on" {
        return Ok(json!({ "allowed": false, "reason": "flag" }));
    }
    if ack {
        return Ok(json!({ "allowed": true }));
    }
    let Some(stamp) = last_backup(conn, ecid, now).map_err(|e| e.to_string())? else {
        return Ok(json!({ "allowed": false, "reason": "backup_missing" }));
    };
    let Ok(artifact) = verify_backup(&stamp.path, now) else {
        return Ok(json!({ "allowed": false, "reason": "backup_unverified" }));
    };
    let aged = now as f64 - stamp.finished_at.min(artifact.manifest_modified_at as f64);
    if aged > FRESHNESS_WINDOW_MS {
        return Ok(json!({
            "allowed": false,
            "reason": "backup_stale",
            "agedMs": js_number(aged),
        }));
    }
    Ok(json!({ "allowed": true }))
}

// ── lib/device-backup-verification.ts ───────────────────────────────

struct Verified {
    manifest_bytes: u64,
    manifest_modified_at: i64,
    path: String,
}

/// `getMobileSyncBackupRoot`: Apple's fixed location, or, only in a test
/// phase, the root the tests name.
fn mobile_sync_root() -> PathBuf {
    if crate::host_env::var("NEXT_PHASE").as_deref() == Ok("phase-test") {
        if let Ok(root) = crate::host_env::var("PRIVACYTRACKER_TEST_MOBILESYNC_ROOT") {
            if !root.is_empty() {
                return super::deployment::resolve_path(Path::new(&root));
            }
        }
    }
    Path::new(&super::osinfo::home_dir().unwrap_or_default())
        .join("Library")
        .join("Application Support")
        .join("MobileSync")
        .join("Backup")
}

/// `isDirectChild`: `path.relative` is one segment with no separator, and
/// not `..`, its spelling of the parent's own parent; and the candidate's
/// dirname is the parent.
fn is_direct_child(parent: &Path, candidate: &Path) -> bool {
    let names = |p: &Path| -> Vec<String> {
        p.components()
            .filter_map(|c| match c {
                Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect()
    };
    let (from, to) = (names(parent), names(candidate));
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut segments: Vec<&str> = vec![".."; from.len() - common];
    segments.extend(to[common..].iter().map(String::as_str));
    let relative = segments.join("/");
    !relative.is_empty()
        && relative != ".."
        && !relative.contains('/')
        && !relative.contains('\\')
        && candidate.parent() == Some(parent)
}

fn verify_backup(path: &str, now: i64) -> Result<Verified, &'static str> {
    verify_backup_at(path, &mobile_sync_root(), now)
}

/// `verifyBackupArtifactAtRoot`, check for check.
fn verify_backup_at(path: &str, root: &Path, now: i64) -> Result<Verified, &'static str> {
    if !path.starts_with('/') {
        return Err("backup_not_absolute");
    }
    let root = std::fs::canonicalize(root).map_err(|_| "mobile_sync_root_missing")?;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => return Err("backup_symlink"),
        Ok(_) => {}
        Err(_) => return Err("backup_path_missing"),
    }
    let backup = std::fs::canonicalize(path).map_err(|_| "backup_path_missing")?;
    if !is_direct_child(&root, &backup) {
        return Err("backup_outside_mobile_sync");
    }
    match std::fs::metadata(&backup) {
        Ok(meta) if !meta.is_dir() => return Err("backup_not_directory"),
        Ok(_) => {}
        Err(_) => return Err("backup_path_missing"),
    }
    let manifest = backup.join("Manifest.db");
    match std::fs::symlink_metadata(&manifest) {
        Ok(meta) if meta.file_type().is_symlink() => return Err("manifest_symlink"),
        Ok(_) => {}
        Err(_) => return Err("manifest_missing"),
    }
    let manifest = std::fs::canonicalize(&manifest).map_err(|_| "manifest_missing")?;
    if manifest.parent() != Some(backup.as_path()) {
        return Err("manifest_outside_backup");
    }
    let meta = std::fs::metadata(&manifest).map_err(|_| "manifest_missing")?;
    if !meta.is_file() {
        return Err("manifest_not_file");
    }
    if meta.len() == 0 {
        return Err("manifest_empty");
    }
    // `Math.floor(mtimeMs)`; a time before the epoch is not positive.
    let modified_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .filter(|ms| *ms > 0 && *ms <= now)
        .ok_or("manifest_time_invalid")?;
    Ok(Verified {
        manifest_bytes: meta.len(),
        manifest_modified_at: modified_at,
        path: backup.to_string_lossy().into_owned(),
    })
}

// ── POST /api/device-actions/backup ──────────────────────────────────

fn backup(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(ecid) = prop(&body, "ecid")
        .and_then(Value::as_str)
        .filter(|e| normalize_ecid(e).is_some())
    else {
        return bad("a valid ecid is required");
    };
    let Some(path) = prop(&body, "path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    else {
        return bad("path is required");
    };
    let verified = match verify_backup(path, cx.now) {
        Ok(v) => v,
        Err(reason) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                &json!({ "error": "backup_not_verified", "reason": reason }),
            )
        }
    };
    let device_name = prop(&body, "deviceName").and_then(Value::as_str);
    let recorded = record_backup(cx, ecid, &verified.path, cx.now, device_name)
        .and_then(|()| last_backup(cx.w.conn, ecid, cx.now).map_err(|e| e.to_string()));
    match recorded {
        Ok(stamp) => json_ok(&json!({
            "ok": true,
            "lastBackup": stamp.as_ref().map_or(Value::Null, Stamp::to_json),
        })),
        Err(e) => {
            super::diag::log_error(format!("[/api/device-actions/backup POST] failed: {e}"));
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to record backup")
        }
    }
}

/// `recordBackup`: re-verified, stamped with the manifest's own time when
/// that is older than the completion time, and logged.
fn record_backup(
    cx: &mut Cx,
    ecid: &str,
    path: &str,
    finished_at: i64,
    device_name: Option<&str>,
) -> Result<(), String> {
    let key = normalize_ecid(ecid).ok_or_else(|| format!("recordBackup: invalid ECID {ecid}"))?;
    if finished_at <= 0 || finished_at > cx.now {
        return Err("recordBackup: invalid completion time".into());
    }
    let verified = verify_backup(path, cx.now)
        .map_err(|reason| format!("recordBackup: backup artifact is not verified ({reason})"))?;
    let finished_at = finished_at.min(verified.manifest_modified_at);
    let stamp = json!({
        "finishedAt": finished_at,
        "manifestBytes": verified.manifest_bytes,
        "path": verified.path,
    });
    cx.w.run(
        SET_SETTING,
        vec![
            json!(format!("{BACKUP_PREFIX}{key}")),
            json!(stamp.to_string()),
        ],
    )?;
    let trimmed = device_name
        .map(|n| n.trim_matches(is_js_whitespace))
        .filter(|n| !n.is_empty());
    let summary = match trimmed {
        Some(name) => format!("Backed up {name}"),
        None => "Device backup completed".to_string(),
    };
    let detail = json!({
        "ecid": ecid,
        "path": verified.path,
        "manifestBytes": verified.manifest_bytes,
        "verified": true,
        "deviceName": device_name,
        "finishedAt": finished_at,
    });
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "cfgutil_backup",
        "ok",
        None,
        Some(&summary),
        Some(&detail),
        finished_at,
    );
    Ok(())
}

// ── /api/device-actions/uninstall ────────────────────────────────────

/// `GET /api/device-actions/uninstall?ecid=…[&acknowledgeNoBackup=1]`: the
/// gate as it stands, and the stamp it read. It never writes.
pub(super) fn uninstall_get_response(
    conn: &Connection,
    query: &[(String, String)],
    now: i64,
) -> Response {
    let first = |name: &str| {
        query
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    let Some(ecid) = first("ecid").filter(|e| !e.is_empty()) else {
        return bad("ecid is required");
    };
    let ack = matches!(first("acknowledgeNoBackup"), Some("1" | "true"));
    let gate = match uninstall_gate(conn, ecid, ack, now) {
        Ok(gate) => gate,
        Err(_) => return thrown(),
    };
    let stamp = match last_backup(conn, ecid, now) {
        Ok(stamp) => stamp.as_ref().map_or(Value::Null, Stamp::to_json),
        Err(_) => return thrown(),
    };
    let mut out = gate.as_object().cloned().unwrap_or_default();
    out.insert("lastBackup".into(), stamp);
    json_ok(&Value::Object(out))
}

pub async fn uninstall_get(State(state): State<AppState>, req: Request) -> Response {
    let query: Vec<(String, String)> =
        url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let conn = state.db();
    uninstall_get_response(&conn, &query, super::now_ms())
}

fn uninstall_post(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON") {
        Ok(v) => v,
        Err(r) => return r,
    };
    // `body.ecid` on a JSON null throws, which is Next's bare 500.
    if body.is_null() {
        return thrown();
    }
    let non_empty = |key: &str| {
        prop(&body, key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let Some(ecid) = non_empty("ecid") else {
        return bad("ecid is required");
    };
    let Some(bundle_id) = non_empty("bundleId") else {
        return bad("bundleId is required");
    };
    let Some(ok) = prop(&body, "ok").and_then(Value::as_bool) else {
        return bad("ok is required");
    };
    let ack = prop(&body, "acknowledgeNoBackup") == Some(&Value::Bool(true));
    let gate = match uninstall_gate(cx.w.conn, ecid, ack, cx.now) {
        Ok(gate) => gate,
        Err(_) => return thrown(),
    };
    if gate["allowed"] != true {
        return json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "gate_denied", "gate": gate }),
        );
    }
    // `?? null`: an absent key and a null one are the same here.
    let present = |key: &str| prop(&body, key).filter(|v| !v.is_null());
    let app_name = present("appName");
    let label = app_name.map_or_else(|| bundle_id.to_string(), js_string);
    let summary = if ok {
        format!(
            "Uninstalled {label}{}",
            if ack {
                " (no backup, acknowledged)"
            } else {
                ""
            }
        )
    } else {
        format!("Uninstall failed for {label}")
    };
    let detail = json!({
        "ecid": ecid,
        "bundleId": bundle_id,
        "appName": app_name.cloned().unwrap_or(Value::Null),
        "error": present("error").cloned().unwrap_or(Value::Null),
        "acknowledgedNoBackup": ack,
    });
    record_activity_client(
        cx.w,
        cx.ids,
        cx.now,
        "cfgutil_uninstall",
        if ok { "ok" } else { "error" },
        present("appId"),
        &summary,
        &detail,
        cx.now,
    );
    json_ok(&json!({ "ok": true }))
}

// ── lib/device-sync.ts ───────────────────────────────────────────────

/// One cleaned entry of the preview's `currentImport`.
struct ImportRef {
    app_id: String,
    name: String,
    developer: Option<String>,
    url: Option<String>,
    icon_url: Option<String>,
    bundle_id: Option<String>,
}

enum DiffError {
    UnknownDevice,
    Other(String),
}

impl From<rusqlite::Error> for DiffError {
    fn from(e: rusqlite::Error) -> Self {
        DiffError::Other(e.to_string())
    }
}

/// `wouldOrphanIfUnlinkedFromDevice`: no other device, and none of the
/// three kinds of user data (whose shortlist probe always fails, as in
/// `hasAttachedUserData`).
fn would_orphan(conn: &Connection, app_id: &str, device_id: &str) -> rusqlite::Result<bool> {
    let others: i64 = conn.query_row(
        "SELECT COUNT(*) AS n FROM app_devices WHERE app_id = ? AND device_id != ?",
        [app_id, device_id],
        |r| r.get(0),
    )?;
    if others > 0 {
        return Ok(false);
    }
    for sql in [
        "SELECT 1 FROM app_verdicts WHERE app_id = ? AND source = 'user' LIMIT 1",
        "SELECT 1 FROM annotations WHERE app_id = ? LIMIT 1",
        "SELECT 1 FROM shortlist_entries WHERE app_id = ? LIMIT 1",
    ] {
        let found = conn
            .prepare(sql)
            .and_then(|mut stmt| stmt.exists([app_id]))
            .unwrap_or(false);
        if found {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `computeDeviceSyncDiff`. The previous rows come back in SQLite's order,
/// as Node reads them: no ORDER BY, which decides both the removes' order
/// and which of two same-bundle rows a merge absorbs (the last).
fn compute_diff(
    conn: &Connection,
    device_id: &str,
    refs: &[ImportRef],
) -> Result<Value, DiffError> {
    if routes_devices::by_id(conn, device_id)?.is_none() {
        return Err(DiffError::UnknownDevice);
    }
    let mut stmt = conn.prepare(PREVIOUS_ROWS)?;
    let previous: Vec<(String, Value, Option<String>)> = stmt
        .query_map([device_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                super::row::column(r, "name")?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let previous_ids: HashSet<&str> = previous.iter().map(|(id, _, _)| id.as_str()).collect();
    let mut by_bundle: HashMap<&str, (&str, &Value)> = HashMap::new();
    for (id, name, bundle) in &previous {
        if let Some(bundle) = bundle.as_deref().filter(|b| !b.is_empty()) {
            by_bundle.insert(bundle, (id, name));
        }
    }
    let mut incoming: Vec<&ImportRef> = vec![];
    let mut seen: HashSet<&str> = HashSet::new();
    for r in refs {
        if !r.app_id.is_empty() && seen.insert(r.app_id.as_str()) {
            incoming.push(r);
        }
    }
    let mut adds = vec![];
    let mut merges = vec![];
    let mut absorbed: HashSet<&str> = HashSet::new();
    let mut unchanged = 0;
    for r in &incoming {
        if previous_ids.contains(r.app_id.as_str()) {
            unchanged += 1;
            continue;
        }
        if let Some(bundle) = r.bundle_id.as_deref().filter(|b| !b.is_empty()) {
            if let Some(&(prev_id, prev_name)) = by_bundle.get(bundle) {
                if prev_id != r.app_id {
                    absorbed.insert(prev_id);
                    merges.push(json!({
                        "previousAppId": prev_id,
                        "incomingAppId": r.app_id,
                        "bundleId": bundle,
                        "previousName": prev_name,
                        "incomingName": r.name,
                    }));
                    unchanged += 1;
                    continue;
                }
            }
        }
        adds.push(json!({
            "appId": r.app_id,
            "name": r.name,
            "developer": r.developer,
            "url": r.url,
            "iconUrl": r.icon_url,
            "bundleId": r.bundle_id,
        }));
    }
    let mut removes = vec![];
    for (id, name, _) in &previous {
        if seen.contains(id.as_str()) || absorbed.contains(id.as_str()) {
            continue;
        }
        removes.push(json!({
            "appId": id,
            "name": name,
            "wouldOrphan": would_orphan(conn, id, device_id)?,
        }));
    }
    Ok(json!({
        "deviceId": device_id,
        "adds": adds,
        "removes": removes,
        "unchanged": unchanged,
        "bundleIdMerges": merges,
    }))
}

// ── POST /api/device-sync/preview ────────────────────────────────────

fn preview(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "invalid json") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return bad("expected object body");
    }
    let Some(device_id) = prop(&body, "deviceId")
        .and_then(Value::as_str)
        .filter(|d| !js_trim(d).is_empty())
    else {
        return bad("deviceId required");
    };
    let Some(list) = prop(&body, "currentImport").and_then(Value::as_array) else {
        return bad("currentImport must be an array");
    };
    if list.len() > 2000 {
        return bad("too many apps in currentImport");
    }
    let text = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
    let mut refs: Vec<ImportRef> = vec![];
    for entry in list {
        // An array passes Node's `typeof entry === "object"`, then has no
        // string `appId`: skipped either way.
        let Some(e) = entry.as_object() else {
            continue;
        };
        let Some(app_id) = e
            .get("appId")
            .and_then(Value::as_str)
            .map(js_trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        refs.push(ImportRef {
            app_id: app_id.to_string(),
            name: text(e.get("name")).unwrap_or_default(),
            developer: text(e.get("developer")),
            url: text(e.get("url")),
            icon_url: text(e.get("iconUrl")),
            bundle_id: text(e.get("bundleId")),
        });
    }
    // The bundle-id backfill, one read for every entry that came without
    // one (an empty string counts as none).
    let missing: Vec<&str> = refs
        .iter()
        .filter(|r| r.bundle_id.as_deref().map_or(true, str::is_empty))
        .map(|r| r.app_id.as_str())
        .collect();
    if !missing.is_empty() {
        let placeholders = vec!["?"; missing.len()].join(",");
        let lookup = (|| -> rusqlite::Result<HashMap<String, Option<String>>> {
            let mut stmt = cx.w.conn.prepare(&format!(
                "SELECT id, bundleId FROM apps WHERE id IN ({placeholders})"
            ))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(&missing), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            rows.collect()
        })();
        let Ok(lookup) = lookup else {
            return thrown();
        };
        for r in &mut refs {
            if r.bundle_id.as_deref().is_some_and(|b| !b.is_empty()) {
                continue;
            }
            if let Some(Some(found)) = lookup.get(&r.app_id) {
                if !found.is_empty() {
                    r.bundle_id = Some(found.clone());
                }
            }
        }
    }
    match compute_diff(cx.w.conn, js_trim(device_id), &refs) {
        Ok(diff) => json_ok(&json!({ "diff": diff })),
        Err(DiffError::UnknownDevice) => json_error(StatusCode::NOT_FOUND, "device not found"),
        Err(DiffError::Other(message)) => {
            super::diag::log_error(format!("[device-sync/preview] failed: {message}"));
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &json!({ "error": message }),
            )
        }
    }
}

// ── POST /api/device-sync/commit ─────────────────────────────────────

struct Applied {
    added: i64,
    removed: i64,
    orphaned_and_deleted: i64,
    merged: i64,
}

fn exists(cx: &Cx, app_id: &str) -> Result<bool, String> {
    cx.w.conn
        .prepare("SELECT 1 FROM apps WHERE id = ?")
        .and_then(|mut stmt| stmt.exists([app_id]))
        .map_err(|e| e.to_string())
}

/// `isProposedBundleIdMerge`: whether the diff would propose this merge
/// for the device, read from the library alone. The old app is on the
/// device, the new one exists and is not, and both rows carry the same
/// non-empty bundle id. Unlike the diff, which absorbs only the last of
/// two same-bundle rows on the device, it accepts a pair for each.
fn proposed_merge(
    cx: &Cx,
    device_id: &str,
    previous: &str,
    incoming: &str,
) -> Result<bool, String> {
    cx.w.conn
        .prepare(PROPOSED_MERGE)
        .and_then(|mut stmt| stmt.exists([previous, incoming, device_id, device_id]))
        .map_err(|e| e.to_string())
}

/// `transferUserDataAcrossAppIds`: each statement on its own, a failure
/// logged and skipped, as Node's try/catch does.
fn transfer(cx: &mut Cx, old: &str, new: &str) {
    for sql in TRANSFER {
        let params = if sql.matches('?').count() == 3 {
            vec![json!(new), json!(new), json!(old)]
        } else {
            vec![json!(new), json!(old)]
        };
        if let Err(e) = cx.w.run(sql, params) {
            super::diag::log_warn(format!(
                "[device-sync] transferUserDataAcrossAppIds skipped statement: {e}"
            ));
        }
    }
    if let Err(e) = cx.w.run(TRANSFER_SNAPSHOTS, vec![json!(new), json!(old)]) {
        super::diag::log_warn(format!("[device-sync] snapshot transfer skipped: {e}"));
    }
}

/// `applyDeviceSyncDiff`: one transaction — the merges first, so a remove
/// naming a merged row finds it gone, then the adds, the removes with the
/// orphan sweep, and the device's sync time. Only the client's pairs the
/// diff would propose run, all judged before the first merge moves any
/// links (`proposed_merge`).
fn apply(
    cx: &mut Cx,
    device_id: &str,
    adds: &[&str],
    removes: &[&str],
    merges: &[(&str, &str)],
) -> Result<Applied, String> {
    if routes_devices::by_id(cx.w.conn, device_id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err(format!("unknown deviceId: {device_id}"));
    }
    let now = cx.now;
    transaction(cx, |cx| {
        let mut applied = Applied {
            added: 0,
            removed: 0,
            orphaned_and_deleted: 0,
            merged: 0,
        };
        let mut proposed = vec![];
        for &(previous, incoming) in merges {
            if proposed_merge(cx, device_id, previous, incoming)? {
                proposed.push((previous, incoming));
            }
        }
        for (previous, incoming) in proposed {
            if previous == incoming {
                continue;
            }
            if !(exists(cx, incoming)? && exists(cx, previous)?) {
                continue;
            }
            transfer(cx, previous, incoming);
            cx.w.run(COPY_LINKS, vec![json!(incoming), json!(previous)])?;
            cx.w.run(DELETE_APP_LINKS, vec![json!(previous)])?;
            cx.w.run(DELETE_APP, vec![json!(previous)])?;
            applied.merged += 1;
        }
        for &app_id in adds {
            if !exists(cx, app_id)? {
                continue;
            }
            cx.w.run(
                UPSERT_LINK,
                vec![json!(app_id), json!(device_id), json!(now), json!(now)],
            )?;
            applied.added += 1;
        }
        for &app_id in removes {
            let changed =
                cx.w.run(DELETE_LINK, vec![json!(app_id), json!(device_id)])?;
            if changed > 0 {
                applied.removed += 1;
                if orphan_sweep_app(cx, app_id)? {
                    applied.orphaned_and_deleted += 1;
                }
            }
        }
        cx.w.run(TOUCH_DEVICE, vec![json!(now), json!(device_id)])?;
        Ok(applied)
    })
}

fn commit(cx: &mut Cx, body: BodyOutcome, actor: &Actor) -> Response {
    let body = match body_json(body, "invalid json") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return bad("expected object body");
    }
    let Some(device_raw) = prop(&body, "deviceId")
        .and_then(Value::as_str)
        .filter(|d| !js_trim(d).is_empty())
    else {
        return bad("deviceId required");
    };
    let (Some(adds), Some(removes)) = (
        prop(&body, "addAppIds").and_then(Value::as_array),
        prop(&body, "removeAppIds").and_then(Value::as_array),
    ) else {
        return bad("addAppIds and removeAppIds must be arrays");
    };
    let device_id = js_trim(device_raw);
    match routes_devices::by_id(cx.w.conn, device_id) {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "device not found"),
        Err(_) => return thrown(),
    }
    let ids = |list: &'_ [Value]| -> Vec<String> {
        list.iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    };
    let (adds, removes) = (ids(adds), ids(removes));
    let merges: Vec<(String, String)> = prop(&body, "bundleIdMerges")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let m = m.as_object()?;
                    let id = |key: &str| {
                        m.get(key)
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    };
                    Some((id("previousAppId")?, id("incomingAppId")?))
                })
                .collect()
        })
        .unwrap_or_default();
    let adds: Vec<&str> = adds.iter().map(String::as_str).collect();
    let removes: Vec<&str> = removes.iter().map(String::as_str).collect();
    let merges: Vec<(&str, &str)> = merges
        .iter()
        .map(|(p, i)| (p.as_str(), i.as_str()))
        .collect();
    let outcome = apply(cx, device_id, &adds, &removes, &merges).and_then(|a| {
        cx.set("device_resync.last_committed_at", &cx.now.to_string())?;
        let result = json!({
            "added": a.added,
            "removed": a.removed,
            "orphanedAndDeleted": a.orphaned_and_deleted,
            "merged": a.merged,
        });
        let mut detail = Map::new();
        detail.insert("deviceId".into(), json!(device_raw));
        if let Some(fields) = result.as_object() {
            detail.extend(fields.clone());
        }
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            "device_sync.commit",
            actor,
            Some(&Value::Object(detail).to_string()),
            true,
        );
        Ok(result)
    });
    match outcome {
        Ok(result) => json_ok(&result),
        Err(message) => {
            super::diag::log_error(format!("[device-sync/commit] failed: {message}"));
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &json!({ "error": message }),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecids_normalise_like_node() {
        assert_eq!(
            normalize_ecid(" 0x9118908bb6027 ").as_deref(),
            Some("9118908BB6027")
        );
        assert_eq!(normalize_ecid("0X00000000").as_deref(), Some("00000000"));
        assert_eq!(normalize_ecid("0x1234567"), None);
        assert_eq!(normalize_ecid("1234567890123456789012345"), None);
        assert_eq!(normalize_ecid("0x0x12345678"), None);
        assert_eq!(normalize_ecid("zz"), None);
    }

    #[test]
    fn direct_children_follow_path_relative() {
        let root = Path::new("/a/MobileSync/Backup");
        assert!(is_direct_child(root, Path::new("/a/MobileSync/Backup/X")));
        assert!(!is_direct_child(root, root));
        assert!(!is_direct_child(
            root,
            Path::new("/a/MobileSync/Backup/X/Y")
        ));
        assert!(!is_direct_child(root, Path::new("/a/Elsewhere")));
        // `..`, the root's own parent, is one segment with no separator.
        assert!(!is_direct_child(root, Path::new("/a/MobileSync")));
        // Only `..` itself: a name that starts with it is still a child.
        assert!(is_direct_child(root, Path::new("/a/MobileSync/Backup/..X")));
        assert!(!is_direct_child(
            root,
            Path::new("/a/MobileSync/Backup/a\\b")
        ));
    }
}

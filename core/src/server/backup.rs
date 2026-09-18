//! lib/backup.ts: the full-database backup envelope — export, the
//! per-install HMAC signature, the dry-run preview and the destructive
//! restore. The routes over it are in `backup_writes.rs`, the snapshot
//! files in `backup_snapshots.rs`.
//!
//! The signature has to agree with Node's byte for byte, because an
//! install switches backends and keeps its key: a backup signed by one
//! must verify on the other. The MAC is HMAC-SHA256 over a canonical
//! spelling of the envelope — object keys sorted the way
//! `Array.prototype.sort` sorts them (UTF-16 code units), every scalar as
//! `JSON.stringify` spells it — keyed by `<data-dir>/backup-signing.key`.
use super::{
    imports_writes::transaction,
    json::js_json_vec,
    writes::{js_entries, Cx},
};
use crate::{
    jsstr::{js_locale_compare, js_trim},
    outbound,
    scrape::persist::base64url,
};
use ring::{hmac, rand::SecureRandom};
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::{io::Write, os::unix::fs::OpenOptionsExt, path::PathBuf};

pub(super) const CURRENT_BACKUP_VERSION: i64 = 1;
const BACKUP_HMAC_ALG: &str = "HMAC-SHA256";
const BACKUP_KEY_FILENAME: &str = "backup-signing.key";

/// Parent-first: the wipe walks it backwards, the insert forwards.
pub(super) const TABLES_IN_INSERT_ORDER: [&str; 28] = [
    "apps",
    "devices",
    "app_devices",
    "privacy_types",
    "privacy_purposes",
    "privacy_categories",
    "privacy_data_types",
    "accessibility_features",
    "privacy_snapshots",
    "privacy_policy_analyses",
    "privacy_policy_versions",
    "annotations",
    "app_verdicts",
    "manual_apps",
    "manual_app_events",
    "manual_app_policy_versions",
    "shortlist_entries",
    "notifications",
    "imports",
    "import_items",
    "audit_bundle_imports",
    "app_settings",
    "feature_flag_overrides",
    "ai_debug_log",
    "audit_log",
    "activity_log",
    "change_review_actions",
    "related_apps_observed",
];

/// Settings whose values never leave the install, whoever exports.
const SENSITIVE_SETTING_KEYS: [&str; 2] = ["ai_api_key", "notification_webhook_url"];
/// Settings a restore refuses to write, trusted envelope or not.
const RESTORE_SETTING_KEY_DENY_PREFIXES: [&str; 2] = ["flag.devopts.", "AUDITOR_"];

// ── The environment: where the key lives, where a fresh one comes from ─

/// The data directory and the key source. Production reads the process's
/// data layout and the OS CSPRNG; the replay points both at its own.
pub(super) struct Env {
    pub(super) data_dir: PathBuf,
    fresh_key: fn() -> Result<[u8; 32], String>,
}

fn os_random_key() -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "the system random source failed".to_string())?;
    Ok(key)
}

#[cfg(test)]
thread_local! {
    static TEST_ENV: std::cell::RefCell<Option<(PathBuf, [u8; 32])>> =
        const { std::cell::RefCell::new(None) };
}

/// Point this thread's backup paths at `data_dir` and make the next
/// minted key `fresh_key`. The replay runs its requests on one thread.
#[cfg(test)]
pub(super) fn set_test_env(env: Option<(PathBuf, [u8; 32])>) {
    TEST_ENV.with(|cell| *cell.borrow_mut() = env);
}

#[cfg(test)]
fn test_fresh_key() -> Result<[u8; 32], String> {
    TEST_ENV
        .with(|cell| cell.borrow().as_ref().map(|(_, key)| *key))
        .ok_or_else(|| "no test key".to_string())
}

pub(super) fn env() -> Env {
    #[cfg(test)]
    if let Some(data_dir) = TEST_ENV.with(|cell| cell.borrow().as_ref().map(|(d, _)| d.clone())) {
        return Env {
            data_dir,
            fresh_key: test_fresh_key,
        };
    }
    Env {
        data_dir: super::data_layout().data_dir.clone(),
        fresh_key: os_random_key,
    }
}

// ── base64, as Buffer spells and reads it ────────────────────────────

/// `buf.toString("base64")`: the standard alphabet, padded.
pub(super) fn base64_encode(bytes: &[u8]) -> String {
    let mut out: String = base64url(bytes)
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    while out.len() % 4 != 0 {
        out.push('=');
    }
    out
}

/// `Buffer.from(s, "base64")`: either alphabet, anything else skipped,
/// the first `=` ends the input, and a dangling sextet is dropped.
pub(crate) fn base64_decode_lenient(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u8);
    for c in s.bytes() {
        let sextet = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

// ── The signing key ──────────────────────────────────────────────────

/// `getOrCreateSigningKey`: the file's key when it decodes to sixteen
/// bytes or more, else a fresh one, persisted 0600 on a best effort.
fn get_or_create_signing_key(env: &Env) -> Result<Vec<u8>, String> {
    let file = env.data_dir.join(BACKUP_KEY_FILENAME);
    if let Ok(raw) = std::fs::read(&file) {
        let text = String::from_utf8_lossy(&raw);
        let trimmed = js_trim(&text);
        if !trimmed.is_empty() {
            let key = base64_decode_lenient(trimmed);
            if key.len() >= 16 {
                return Ok(key);
            }
        }
    }
    let fresh = (env.fresh_key)()?;
    let persisted = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&env.data_dir)?;
        // 0600: whoever can read this can forge envelopes for the install.
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&file)?;
        f.write_all(format!("{}\n", base64_encode(&fresh)).as_bytes())
    })();
    if let Err(e) = persisted {
        super::diag::log_warn(format!("[backup] failed to persist signing key: {e}"));
    }
    Ok(fresh.to_vec())
}

// ── The envelope ─────────────────────────────────────────────────────

pub(super) struct Table {
    pub(super) columns: Vec<String>,
    pub(super) rows: Vec<Value>,
}

pub(super) struct Envelope {
    /// A JSON number, as uploaded or as exported.
    pub(super) version: Value,
    /// A JSON number, or null.
    pub(super) exported_at: Value,
    app_name: String,
    /// In `Object.entries` order.
    pub(super) tables: Vec<(String, Table)>,
    signature: Option<(String, String)>,
}

impl Envelope {
    /// The object `exportBackup` returns, key for key.
    pub(super) fn into_json(self) -> Value {
        let mut tables = Map::new();
        for (name, table) in self.tables {
            tables.insert(
                name,
                json!({ "columns": table.columns, "rows": table.rows }),
            );
        }
        let mut out = Map::new();
        out.insert("version".into(), self.version);
        out.insert("exportedAt".into(), self.exported_at);
        out.insert("appName".into(), json!(self.app_name));
        out.insert("tables".into(), Value::Object(tables));
        if let Some((alg, mac)) = self.signature {
            out.insert("signature".into(), json!({ "alg": alg, "mac": mac }));
        }
        Value::Object(out)
    }
}

pub(super) fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A copy with every object's keys in `Array.prototype.sort` order, so the
/// compact serializer spells `canonicalize`'s output.
fn key_sorted(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(key_sorted).collect()),
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| utf16_cmp(a.0, b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(k, v)| (k.clone(), key_sorted(v)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

fn spell<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, String> {
    js_json_vec(value).map_err(|e| e.to_string())
}

/// `computeEnvelopeMac`: HMAC-SHA256 over `canonicalize(envelope without
/// its signature)`, fed a row at a time so a large backup is never copied
/// whole. The fixed keys are already in sorted order: `appName`,
/// `exportedAt`, `tables`, `version`, and within a table `columns`, `rows`.
fn envelope_mac(envelope: &Envelope, key: &hmac::Key) -> Result<hmac::Tag, String> {
    let mut ctx = hmac::Context::with_key(key);
    ctx.update(b"{\"appName\":");
    ctx.update(&spell(&envelope.app_name)?);
    ctx.update(b",\"exportedAt\":");
    ctx.update(&spell(&envelope.exported_at)?);
    ctx.update(b",\"tables\":{");
    let mut tables: Vec<&(String, Table)> = envelope.tables.iter().collect();
    tables.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
    for (i, (name, table)) in tables.into_iter().enumerate() {
        if i > 0 {
            ctx.update(b",");
        }
        ctx.update(&spell(name)?);
        ctx.update(b":{\"columns\":");
        ctx.update(&spell(&table.columns)?);
        ctx.update(b",\"rows\":[");
        for (j, row) in table.rows.iter().enumerate() {
            if j > 0 {
                ctx.update(b",");
            }
            ctx.update(&spell(&key_sorted(row))?);
        }
        ctx.update(b"]}");
    }
    ctx.update(b"},\"version\":");
    ctx.update(&spell(&envelope.version)?);
    ctx.update(b"}");
    Ok(ctx.sign())
}

// ── Export ───────────────────────────────────────────────────────────

fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .and_then(|mut s| s.exists([name]))
        .map_err(|e| e.to_string())
}

fn get_columns(conn: &Connection, name: &str) -> Result<Vec<String>, String> {
    conn.prepare(&format!("PRAGMA table_info({name})"))
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>("name"))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())
}

/// `exportBackup`: every table that exists, read in one transaction, the
/// sensitive settings blanked, the envelope signed.
pub(super) fn export_backup(cx: &mut Cx, env: &Env) -> Result<Envelope, String> {
    let tables = transaction(cx, |cx| {
        let mut tables = Vec::new();
        for name in TABLES_IN_INSERT_ORDER {
            if !table_exists(cx.w.conn, name)? {
                continue;
            }
            let columns = get_columns(cx.w.conn, name)?;
            let mut rows = super::stats::query(cx.w.conn, &format!("SELECT * FROM {name}"), &[])
                .map_err(|e| e.to_string())?;
            if name == "app_settings" {
                for row in &mut rows {
                    let sensitive = row["key"]
                        .as_str()
                        .is_some_and(|k| SENSITIVE_SETTING_KEYS.contains(&k));
                    if sensitive {
                        row["value"] = json!("");
                    }
                }
            }
            tables.push((name.to_string(), Table { columns, rows }));
        }
        Ok(tables)
    })?;
    let mut envelope = Envelope {
        version: json!(CURRENT_BACKUP_VERSION),
        exported_at: json!(cx.now),
        app_name: "privacytracker".to_string(),
        tables,
        signature: None,
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, &get_or_create_signing_key(env)?);
    let mac = envelope_mac(&envelope, &key)?;
    envelope.signature = Some((BACKUP_HMAC_ALG.to_string(), base64_encode(mac.as_ref())));
    Ok(envelope)
}

// ── Parse, preview ───────────────────────────────────────────────────

/// What a restore can fail with, as the route tells them apart.
pub(super) enum RestoreError {
    /// `BackupFormatError`.
    Format(String),
    /// `BackupUntrustedError`.
    Untrusted {
        signature_present: bool,
    },
    Other(String),
}

/// `Object.keys(v)` for an object or an array.
fn js_keys(v: &Value) -> Vec<String> {
    match v {
        Value::Object(map) => js_entries(map)
            .into_iter()
            .map(|(k, _)| k.clone())
            .collect(),
        Value::Array(items) => (0..items.len()).map(|i| i.to_string()).collect(),
        _ => vec![],
    }
}

/// `Object.entries(map)`, owned: array-index keys first and ascending,
/// then the rest as inserted.
fn js_into_entries(map: Map<String, Value>) -> Vec<(String, Value)> {
    let (mut indices, named): (Vec<_>, Vec<_>) = map
        .into_iter()
        .partition(|(k, _)| crate::jsstr::is_array_index_key(k));
    indices.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));
    indices.into_iter().chain(named).collect()
}

/// `parseEnvelope`. Takes the payload so the rows move rather than copy.
pub(super) fn parse_envelope(payload: Value) -> Result<Envelope, String> {
    // `!payload || typeof payload !== "object"`. An array is an object, and
    // fails on its missing version instead.
    let mut p = match payload {
        Value::Object(map) => map,
        Value::Array(_) => Map::new(),
        _ => return Err("Backup payload must be a JSON object.".to_string()),
    };
    let version = match p.get("version") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if !version.is_finite() || version < 1.0 {
        return Err("Backup payload is missing a valid `version` field.".to_string());
    }
    if version > CURRENT_BACKUP_VERSION as f64 {
        return Err(format!(
            "Backup version {} is newer than this app supports (max {CURRENT_BACKUP_VERSION}). Upgrade the app and try again.",
            crate::jsnum::js_number_spelling(version)
        ));
    }
    // `Object.entries(p.tables)`: an object's entries, or an array's
    // elements under their indices.
    let entries: Vec<(String, Value)> = match p.remove("tables") {
        Some(Value::Object(map)) => js_into_entries(map),
        Some(Value::Array(items)) => items
            .into_iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => return Err("Backup payload is missing a `tables` object.".to_string()),
    };
    let mut tables = Vec::new();
    for (name, value) in entries {
        // Only an object can carry an array under `rows`.
        let Value::Object(mut t) = value else {
            continue;
        };
        let Some(Value::Array(rows)) = t.remove("rows") else {
            continue;
        };
        let columns = match t.remove("columns") {
            Some(Value::Array(cols)) => cols
                .into_iter()
                .filter_map(|c| match c {
                    Value::String(s) => Some(s),
                    _ => None,
                })
                .collect(),
            _ => rows.first().map(js_keys).unwrap_or_default(),
        };
        tables.push((name, Table { columns, rows }));
    }
    let signature = match p.get("signature") {
        Some(Value::Object(sig)) => match (sig.get("alg"), sig.get("mac")) {
            (Some(Value::String(alg)), Some(Value::String(mac))) => {
                Some((alg.clone(), mac.clone()))
            }
            _ => None,
        },
        _ => None,
    };
    Ok(Envelope {
        version: crate::jsnum::js_number(version),
        exported_at: match p.get("exportedAt") {
            Some(Value::Number(n)) => crate::jsnum::js_number(n.as_f64().unwrap_or(f64::NAN)),
            _ => Value::Null,
        },
        app_name: match p.get("appName") {
            Some(Value::String(s)) => s.clone(),
            _ => "privacytracker".to_string(),
        },
        tables,
        signature,
    })
}

/// `summarizeBackup`: the backup's own tables — unknown ones included,
/// each with a warning — sorted into the order the restore applies them.
pub(super) fn summarize(envelope: &Envelope) -> Value {
    let position = |name: &str| TABLES_IN_INSERT_ORDER.iter().position(|t| *t == name);
    let mut per_table: Vec<(&str, usize)> = Vec::new();
    let mut warnings = Vec::new();
    let mut total = 0usize;
    for (name, table) in &envelope.tables {
        let count = table.rows.len();
        per_table.push((name, count));
        total += count;
        if position(name).is_none() {
            warnings.push(format!(
                "Table \"{name}\" is in the backup but not recognised by this app version; its {count} rows will be skipped on restore."
            ));
        }
    }
    per_table.sort_by(|a, b| match (position(a.0), position(b.0)) {
        (None, None) => js_locale_compare(a.0, b.0),
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    });
    json!({
        "version": envelope.version,
        "exportedAt": envelope.exported_at,
        "perTable": per_table
            .into_iter()
            .map(|(name, rows)| json!({ "name": name, "rows": rows }))
            .collect::<Vec<_>>(),
        "totalRows": total,
        "warnings": warnings,
    })
}

/// `previewRestore`.
pub(super) fn preview_restore(payload: Value) -> Result<Value, String> {
    parse_envelope(payload).map(|envelope| summarize(&envelope))
}

// ── Restore ──────────────────────────────────────────────────────────

/// `verifyEnvelope`. The key is only read — or minted — once there is a
/// signature of the right algorithm to check.
fn verify_envelope(envelope: &Envelope, env: &Env) -> Result<bool, String> {
    let Some((alg, mac)) = &envelope.signature else {
        return Ok(false);
    };
    if alg != BACKUP_HMAC_ALG {
        return Ok(false);
    }
    let key = hmac::Key::new(hmac::HMAC_SHA256, &get_or_create_signing_key(env)?);
    let expected = envelope_mac(envelope, &key)?;
    let given = base64_decode_lenient(mac);
    // A length mismatch is untrusted, as in Node. Equal lengths are
    // compared under the key rather than byte by byte: `verify` checks
    // HMAC(given) against HMAC(expected) in constant time, and those
    // agree exactly when the two tags do.
    Ok(given.len() == expected.as_ref().len()
        && hmac::verify(&key, &given, hmac::sign(&key, expected.as_ref()).as_ref()).is_ok())
}

/// `sanitizePolicyUrl`: the normalised URL, or the empty string.
fn sanitize_policy_url(raw: &str) -> String {
    outbound::validate(raw, &[], 2048)
        .map(|u| u.to_string())
        .unwrap_or_default()
}

/// `typeof v === "string" ? sanitizePolicyUrl(v) || fallback : fallback`.
fn safe_url(row: &Map<String, Value>, key: &str, fallback: Value) -> Value {
    match row.get(key) {
        Some(Value::String(s)) => {
            let clean = sanitize_policy_url(s);
            if clean.is_empty() {
                fallback
            } else {
                json!(clean)
            }
        }
        _ => fallback,
    }
}

/// `sanitiseRowForRestore`: the fields rewritten for this table, or `None`
/// when the row is dropped. Applied whatever the envelope's trust.
fn sanitise_row(table: &str, row: &Map<String, Value>) -> Option<Vec<(&'static str, Value)>> {
    Some(match table {
        "app_settings" => {
            let denied = row.get("key").and_then(Value::as_str).is_some_and(|k| {
                RESTORE_SETTING_KEY_DENY_PREFIXES
                    .iter()
                    .any(|p| k.starts_with(p))
            });
            if denied {
                return None;
            }
            vec![]
        }
        "apps" => vec![
            ("url", safe_url(row, "url", json!(""))),
            ("iconUrl", safe_url(row, "iconUrl", Value::Null)),
            (
                "privacyPolicyUrl",
                safe_url(row, "privacyPolicyUrl", Value::Null),
            ),
        ],
        "related_apps_observed" => vec![
            (
                "related_store_url",
                safe_url(row, "related_store_url", json!("")),
            ),
            (
                "related_icon_url",
                safe_url(row, "related_icon_url", Value::Null),
            ),
        ],
        "manual_apps" => vec![
            (
                "privacy_policy_url",
                safe_url(row, "privacy_policy_url", Value::Null),
            ),
            ("source_url", safe_url(row, "source_url", Value::Null)),
        ],
        _ => vec![],
    })
}

/// A copy with every object's keys in JavaScript's property order, which
/// is the order `JSON.parse` then `JSON.stringify` replays.
pub(super) fn js_ordered(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(js_ordered).collect()),
        Value::Object(map) => Value::Object(
            js_entries(map)
                .into_iter()
                .map(|(k, v)| (k.clone(), js_ordered(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `coerceSqlValue`: an object or array as its JSON text, a boolean as
/// 0/1 — and a number as the DOUBLE better-sqlite3 binds every JavaScript
/// number as, so a number restored into a TEXT column reads `34.0` on
/// both backends (an INTEGER column takes an integral double back to an
/// integer by affinity).
fn coerce_sql_value(v: Option<&Value>) -> Result<Value, String> {
    Ok(match v {
        None | Some(Value::Null) => Value::Null,
        Some(v @ (Value::Object(_) | Value::Array(_))) => {
            json!(String::from_utf8_lossy(&spell(&js_ordered(v))?).into_owned())
        }
        Some(Value::Bool(b)) => json!(i64::from(*b)),
        Some(Value::Number(n)) => serde_json::Number::from_f64(n.as_f64().unwrap_or(f64::NAN))
            .map_or(Value::Null, Value::Number),
        Some(Value::String(s)) => json!(s),
    })
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn count_rows(conn: &Connection, name: &str) -> Result<i64, String> {
    conn.query_row(&format!("SELECT COUNT(*) AS c FROM {name}"), [], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}

pub(super) struct Restored {
    /// `{ inserted, totalRows, restoredAt, trust, blocked }`.
    pub(super) result: Value,
    /// `backup.restore` or `backup.restore.untrusted`.
    pub(super) audit_action: &'static str,
    /// The audit row's detail, before its 1024-unit cut.
    pub(super) audit_detail: String,
}

/// `restoreBackup`, up to the audit row the caller writes: verify first,
/// count what is about to be lost, then — with foreign keys off around one
/// transaction — wipe children-first, insert parents-first, and let
/// `foreign_key_check` veto the commit.
pub(super) fn restore_backup(
    cx: &mut Cx,
    env: &Env,
    payload: Value,
    allow_untrusted: bool,
) -> Result<Restored, RestoreError> {
    let envelope = parse_envelope(payload).map_err(RestoreError::Format)?;
    let summary = summarize(&envelope);
    let trusted = verify_envelope(&envelope, env).map_err(RestoreError::Other)?;
    if !trusted && !allow_untrusted {
        return Err(RestoreError::Untrusted {
            signature_present: envelope.signature.is_some(),
        });
    }
    let trust = if trusted { "trusted" } else { "untrusted" };

    let mut prior_counts = Vec::new();
    for name in TABLES_IN_INSERT_ORDER {
        let rows = if table_exists(cx.w.conn, name).map_err(RestoreError::Other)? {
            count_rows(cx.w.conn, name).map_err(RestoreError::Other)?
        } else {
            0
        };
        prior_counts.push(json!({ "name": name, "rows": rows }));
    }

    let restored_at = cx.now;
    let mut inserted = Vec::new();
    let mut blocked = Vec::new();
    let mut total_rows = 0usize;

    // The pragma is a no-op inside a transaction, so it goes around one;
    // the caller holds the connection for the whole section.
    let was_fk: i64 =
        cx.w.conn
            .pragma_query_value(None, "foreign_keys", |r| r.get(0))
            .map_err(|e| RestoreError::Other(e.to_string()))?;
    cx.w.conn
        .pragma_update(None, "foreign_keys", false)
        .map_err(|e| RestoreError::Other(e.to_string()))?;
    let written = transaction(cx, |cx| {
        for name in TABLES_IN_INSERT_ORDER.iter().rev() {
            if table_exists(cx.w.conn, name)? {
                cx.w.run(&format!("DELETE FROM {name}"), vec![])?;
            }
        }
        for name in TABLES_IN_INSERT_ORDER {
            if !table_exists(cx.w.conn, name)? {
                continue;
            }
            let table = envelope
                .tables
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, t)| t)
                .filter(|t| !t.rows.is_empty());
            let Some(table) = table else {
                inserted.push(json!({ "name": name, "rows": 0 }));
                continue;
            };
            // Dropped columns are ignored; new ones take their DEFAULT. The
            // backup decides WHICH columns and in what order; the names
            // that reach the SQL are the live schema's own strings, so no
            // uploaded text is ever spliced into a statement.
            let live = get_columns(cx.w.conn, name)?;
            let writable: Vec<&String> = table
                .columns
                .iter()
                .filter_map(|c| live.iter().find(|l| *l == c))
                .collect();
            if writable.is_empty() {
                inserted.push(json!({ "name": name, "rows": 0 }));
                continue;
            }
            let sql = format!(
                "INSERT INTO {name} ({}) VALUES ({})",
                writable
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", "),
                vec!["?"; writable.len()].join(", ")
            );
            let (mut n, mut rejected) = (0usize, 0usize);
            let no_fields = Map::new();
            for row in &table.rows {
                // `!row || typeof row !== "object"`. An array is an object
                // with none of these columns.
                let fields = match row {
                    Value::Object(map) => map,
                    Value::Array(_) => &no_fields,
                    _ => continue,
                };
                let Some(overrides) = sanitise_row(name, fields) else {
                    rejected += 1;
                    continue;
                };
                let mut values = Vec::with_capacity(writable.len());
                for col in &writable {
                    let overridden = overrides
                        .iter()
                        .find(|(k, _)| *k == col.as_str())
                        .map(|(_, v)| v);
                    values.push(coerce_sql_value(overridden.or_else(|| fields.get(*col)))?);
                }
                cx.w.run(&sql, values)?;
                n += 1;
            }
            inserted.push(json!({ "name": name, "rows": n }));
            if rejected > 0 {
                blocked.push(json!({ "name": name, "rows": rejected }));
            }
            total_rows += n;
        }
        let violations = foreign_key_violations(cx.w.conn).map_err(|e| e.to_string())?;
        if violations > 0 {
            return Err(format!(
                "Backup restore aborted: {violations} foreign-key violation(s) detected. The backup references rows that no longer exist. No changes were applied."
            ));
        }
        Ok(())
    });
    let reset =
        cx.w.conn
            .pragma_update(None, "foreign_keys", was_fk != 0)
            .map_err(|e| e.to_string());
    written.map_err(RestoreError::Other)?;
    reset.map_err(RestoreError::Other)?;

    let audit_detail = String::from_utf8_lossy(
        &spell(&json!({
            "restoredAt": restored_at,
            "version": envelope.version,
            "exportedAt": envelope.exported_at,
            "totalRows": total_rows,
            "inserted": inserted,
            "blocked": blocked,
            "priorCounts": prior_counts,
            "trust": trust,
            "summary": summary,
        }))
        .map_err(RestoreError::Other)?,
    )
    .into_owned();
    Ok(Restored {
        result: json!({
            "inserted": inserted,
            "totalRows": total_rows,
            "restoredAt": restored_at,
            "trust": trust,
            "blocked": blocked,
        }),
        audit_action: if trusted {
            "backup.restore"
        } else {
            "backup.restore.untrusted"
        },
        audit_detail,
    })
}

/// How many rows `PRAGMA foreign_key_check` reports.
fn foreign_key_violations(conn: &Connection) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let mut rows = stmt.query([])?;
    let mut n = 0;
    while rows.next()?.is_some() {
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_reads_what_buffer_from_reads() {
        // Each expectation is `[...Buffer.from(s, "base64")]` from node.
        for (s, bytes) in [
            ("QUJD", vec![65, 66, 67]),
            ("QUJ", vec![65, 66]),
            ("QU", vec![65]),
            ("Q", vec![]),
            ("QUJD\n", vec![65, 66, 67]),
            ("QU JD", vec![65, 66, 67]),
            ("QU=JD", vec![65]),
            ("QUJD==", vec![65, 66, 67]),
            ("QU-_", vec![65, 79, 191]),
            ("QU+/", vec![65, 79, 191]),
            ("Q!UJD", vec![65, 66, 67]),
            ("QUJDRA==", vec![65, 66, 67, 68]),
            ("QUJDRA", vec![65, 66, 67, 68]),
            ("=QUJD", vec![]),
            ("QUJDR", vec![65, 66, 67]),
        ] {
            assert_eq!(base64_decode_lenient(s), bytes, "{s:?}");
        }
    }

    #[test]
    fn base64_writes_what_buffer_to_string_writes() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"A"), "QQ==");
        assert_eq!(base64_encode(b"AB"), "QUI=");
        assert_eq!(base64_encode(b"ABC"), "QUJD");
        assert_eq!(base64_encode(&[0xfb, 0xff, 0xfe]), "+//+");
    }

    #[test]
    fn keys_sort_by_utf16_code_unit_as_array_sort_does() {
        // U+FF5E sorts before U+1F4F8 by code point and after its surrogate
        // pair by UTF-16 code unit — which is what JS compares.
        let v = json!({ "\u{ff5e}": 1, "\u{1f4f8}": 2, "b": 3, "B": 4, "10": 5, "9": 6 });
        let keys: Vec<String> = key_sorted(&v)
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, ["10", "9", "B", "b", "\u{1f4f8}", "\u{ff5e}"]);
    }
}

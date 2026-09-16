//! The persist half of `fetchAndParseApp` (Phase 3, batch 2): everything
//! after the page is parsed — the pre-commit reads, the change detection,
//! the one transactional commit, the notifications around it, and the
//! activity row on failure. Gated by `core/tests/fixtures/persist-cases.json`
//! (see `persist_tests.rs`): the real Node handler's ordered write stream,
//! the rows it leaves and the object it returns, per case.
//!
//! Every SQL text here is Node's byte for byte, whitespace included, because
//! the oracle compares the statement stream and not only the rows. Ids come
//! from an [`Ids`] source in the order Node mints them, and the clock is an
//! input, so the stream is reproducible.
use super::{
    accessibility::Feature,
    activity,
    js::truthy,
    notify,
    page::{parse_page, ParsedPage},
    plan::SnapshotType,
};
use crate::{
    jsnum::js_number,
    jsstr::js_string,
    server::{
        diff::{diff_snapshots, CategorySnapshot, TypeSnapshot},
        grid_meta::{self, Mismatch},
    },
};
use rusqlite::{params_from_iter, types::Value as Sql, Connection, OptionalExtension};
use serde_json::{json, Value};

/// What `fetchVersionInfo` derives from the iTunes lookup. Batch 3 ports the
/// lookup; until then the caller supplies it (all `None` on a lookup miss).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VersionInfo {
    pub age_rating: Option<String>,
    pub current_version: Option<String>,
    pub genre_id: Option<f64>,
    pub genre_name: Option<String>,
    pub price_amount: Option<f64>,
    pub price_currency: Option<String>,
    pub price_formatted: Option<String>,
    pub version_updated_at: Option<i64>,
    pub whats_new: Option<String>,
}

/// One scrape's context: everything but the page itself.
#[derive(Debug)]
pub struct ScrapeInput<'a> {
    /// The validated App Store URL that was fetched.
    pub url: &'a str,
    /// `resync`: the activity type (`resync` versus `scrape`).
    pub resync: bool,
    /// `triggered_by` on the snapshot row: `import`, `manual` or `scheduled`.
    pub trigger: &'a str,
    pub version: &'a VersionInfo,
    /// `Date.now()` for the whole scrape: the activity start, every row
    /// timestamp, and the cooldown comparisons.
    pub now: i64,
}

/// Where `crypto.randomUUID()` comes from. Production uses [`RandomIds`];
/// the replay test uses a counter so the stream matches Node's recorded one.
pub trait Ids {
    fn uuid(&mut self, conn: &Connection) -> Result<String, String>;
}

/// Version-4 UUIDs from SQLite's `randomblob`, the entropy source db.rs
/// already uses.
pub struct RandomIds;

impl Ids for RandomIds {
    fn uuid(&mut self, conn: &Connection) -> Result<String, String> {
        random_uuid(conn).map_err(message)
    }
}

/// A v4 UUID: 16 random bytes with the version and variant nibbles set.
pub fn random_uuid(conn: &Connection) -> rusqlite::Result<String> {
    let hex: String = conn.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
    let variant = b"89ab"[usize::from(hex.as_bytes()[16] & 0x03)] as char;
    Ok(format!(
        "{}-{}-4{}-{}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        variant,
        &hex[17..20],
        &hex[20..32]
    ))
}

/// One recorded write: the SQL as run and its bound parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    pub sql: String,
    pub params: Vec<Value>,
}

/// `fetchAndParseApp`'s return value.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub id: String,
    pub name: String,
    pub is_new: bool,
    pub changes_detected: bool,
    pub change_count: usize,
    pub version_changed: bool,
    pub previous_version: Option<String>,
    pub current_version: Option<String>,
    pub version_updated_at: Option<i64>,
}

impl Outcome {
    /// The object Node returns, key for key.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "status": "success",
            "isNew": self.is_new,
            "changesDetected": self.changes_detected,
            "changeCount": self.change_count,
            "versionChanged": self.version_changed,
            "previousVersion": self.previous_version,
            "currentVersion": self.current_version,
            "versionUpdatedAt": self.version_updated_at,
        })
    }
}

// ── The SQL, verbatim from lib/scraper.ts ────────────────────────────
const DELETE_TYPES: &str = "DELETE FROM privacy_types WHERE app_id = ?";
const INSERT_APP: &str = "\n        INSERT INTO apps (\n          id, name, url, iconUrl, developer, privacyPolicyUrl, bundleId,\n          firstSeen, lastSynced, changeCount,\n          currentVersion, versionUpdatedAt, whatsNew, hasPrivacyDetails,\n          hasAccessibilityLabels,\n          priceAmount, priceCurrency, priceFormatted, hasIap,\n          genreId, genreName, ageRating\n        )\n        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n      ";
const UPDATE_APP: &str = "\n        UPDATE apps\n           SET name = ?, url = ?, iconUrl = ?, developer = ?, privacyPolicyUrl = ?,\n               lastSynced = ?,\n               currentVersion = COALESCE(?, currentVersion),\n               versionUpdatedAt = COALESCE(?, versionUpdatedAt),\n               whatsNew = COALESCE(?, whatsNew),\n               hasPrivacyDetails = ?,\n               hasAccessibilityLabels = COALESCE(?, hasAccessibilityLabels),\n               priceAmount = COALESCE(?, priceAmount),\n               priceCurrency = COALESCE(?, priceCurrency),\n               priceFormatted = COALESCE(?, priceFormatted),\n               hasIap = COALESCE(?, hasIap),\n               genreId = COALESCE(?, genreId),\n               genreName = COALESCE(?, genreName),\n               ageRating = COALESCE(?, ageRating)\n         WHERE id = ?\n      ";
const INSERT_TYPE: &str = "\n        INSERT INTO privacy_types (id, app_id, identifier, title, detail)\n        VALUES (?, ?, ?, ?, ?)\n      ";
const INSERT_CATEGORY: &str = "\n          INSERT OR IGNORE INTO privacy_categories (id, type_id, identifier, title)\n          VALUES (?, ?, ?, ?)\n        ";
const DELETE_ACCESSIBILITY: &str = "DELETE FROM accessibility_features WHERE app_id = ?";
const INSERT_ACCESSIBILITY: &str = "INSERT INTO accessibility_features (id, app_id, identifier, title, description, icon_template) VALUES (?, ?, ?, ?, ?, ?)";
const DELETE_RELATED: &str = "DELETE FROM related_apps_observed WHERE source_app_id = ?";
const INSERT_RELATED: &str = "INSERT INTO related_apps_observed\n                (source_app_id, related_apple_id, related_name, related_developer,\n                 related_icon_url, related_store_url, shelf_type, observed_at)\n              VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const INSERT_SNAPSHOT: &str = "\n      INSERT INTO privacy_snapshots\n        (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,\n         source, wayback_snapshot_url, triggered_by,\n         app_version, app_version_updated_at)\n      VALUES (?, ?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?)\n    ";
const BUMP_CHANGE_COUNT: &str = "UPDATE apps SET changeCount = changeCount + 1 WHERE id = ?";
const INSERT_CHANGE_NOTIFICATION: &str = "\n        INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read, not_before)\n        VALUES (?, ?, ?, ?, ?, 0, ?)\n      ";
const INSERT_ACTIVITY: &str = "\n      INSERT INTO activity_log\n        (id, type, status, app_id, app_name, summary, detail,\n         started_at, ended_at, duration_ms)\n      VALUES (?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?)\n    ";
const PRUNE_ACTIVITY: &str = "\n      DELETE FROM activity_log\n       WHERE id IN (\n         SELECT id FROM activity_log\n          ORDER BY started_at DESC\n          LIMIT -1 OFFSET 2000\n       )\n    ";
pub(super) const SET_SETTING: &str =
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)";

/// Runs statements and, when asked, records them — one path for the
/// production write and the replay, so the recording cannot lie.
pub(super) struct Writer<'a> {
    pub(super) conn: &'a Connection,
    log: Option<&'a mut Vec<Statement>>,
}

impl<'a> Writer<'a> {
    pub(super) fn new(conn: &'a Connection, log: Option<&'a mut Vec<Statement>>) -> Self {
        Self { conn, log }
    }
    pub(super) fn run(&mut self, sql: &str, params: Vec<Value>) -> Result<usize, String> {
        if let Some(log) = self.log.as_deref_mut() {
            log.push(Statement {
                sql: sql.to_string(),
                params: params.clone(),
            });
        }
        self.conn
            .execute(sql, params_from_iter(params.iter().map(to_sql)))
            .map_err(message)
    }

    /// A transaction boundary in the recorded stream.
    fn mark(&mut self, marker: &str) {
        if let Some(log) = self.log.as_deref_mut() {
            log.push(Statement {
                sql: marker.to_string(),
                params: vec![],
            });
        }
    }

    /// `setSetting`.
    pub(super) fn set_setting(&mut self, key: &str, value: &str) -> Result<(), String> {
        self.run(SET_SETTING, vec![json!(key), json!(value)])
            .map(drop)
    }
}

/// better-sqlite3 binds numbers, strings and null; nothing here binds
/// anything else.
fn to_sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .map(Sql::Integer)
            .or_else(|| n.as_f64().map(Sql::Real))
            .unwrap_or(Sql::Null),
        Value::String(s) => Sql::Text(s.clone()),
        Value::Array(_) | Value::Object(_) => Sql::Null,
    }
}

/// The message better-sqlite3 surfaces: SQLite's own text, unwrapped.
pub(super) fn message(e: rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(text)) => text,
        other => other.to_string(),
    }
}

/// A stored SQLite value as the JavaScript value better-sqlite3 returns.
pub(super) fn json_of(v: Sql) -> Value {
    match v {
        Sql::Null | Sql::Blob(_) => Value::Null,
        Sql::Integer(i) => Value::from(i),
        Sql::Real(f) => js_number(f),
        Sql::Text(s) => Value::String(s),
    }
}

/// `fetchAndParseApp` from the fetched HTML to the committed rows and the
/// return value; on any failure the error activity row is written and the
/// message returned, as Node's catch block does. The fetch layer in
/// `fetch.rs` reaches the same code through [`persist_page`].
pub fn scrape_and_persist(
    conn: &Connection,
    input: &ScrapeInput,
    html: &str,
    ids: &mut dyn Ids,
    log: Option<&mut Vec<Statement>>,
) -> Result<Outcome, String> {
    let mut w = Writer::new(conn, log);
    let activity_type = if input.resync { "resync" } else { "scrape" };
    // `let appleId: string = crypto.randomUUID();` — minted, then replaced
    // by the URL's id segment, so the sequence starts one later.
    ids.uuid(conn)?;
    let result = parse_page(input.url, html)
        .and_then(|page| persist_page(&mut w, input, page, ids, activity_type));
    if let Err(error) = &result {
        activity::record_error(&mut w, ids, input.url, input.now, activity_type, error);
    }
    result
}

/// From the parsed page to the committed rows and the bells after them.
pub(super) fn persist_page(
    w: &mut Writer,
    input: &ScrapeInput,
    page: ParsedPage,
    ids: &mut dyn Ids,
    activity_type: &str,
) -> Result<Outcome, String> {
    let conn = w.conn;
    let now = input.now;
    let id = page.apple_id.clone();

    // ── The pre-commit reads ──
    let existing = conn
        .query_row(
            "SELECT id, currentVersion, versionUpdatedAt, ageRating FROM apps WHERE id = ?",
            [&id],
            |r| {
                Ok((
                    json_of(r.get::<_, Sql>(1)?),
                    json_of(r.get::<_, Sql>(2)?),
                    json_of(r.get::<_, Sql>(3)?),
                ))
            },
        )
        .optional()
        .map_err(message)?;
    let is_existing = existing.is_some();
    let (previous_version, previous_version_updated_at, previous_age_rating) =
        existing.unwrap_or((Value::Null, Value::Null, Value::Null));
    let previous_snapshot: Option<Vec<TypeSnapshot>> = if is_existing {
        Some(match latest_snapshot(conn, &id)? {
            Some(snapshot) => snapshot,
            None => build_snapshot(conn, &id)?,
        })
    } else {
        None
    };
    let previous_accessibility: Vec<Feature> = if is_existing {
        build_accessibility_snapshot(conn, &id)?
    } else {
        vec![]
    };
    let version = input.version;
    let current_version = version.current_version.as_deref().filter(|v| !v.is_empty());
    let previous_version_text = truthy(&previous_version).then(|| js_string(&previous_version));
    let version_changed = is_existing
        && current_version.is_some()
        && previous_version_text.is_some()
        && current_version != previous_version_text.as_deref();
    let plan = &page.plan;
    let new_snapshot = to_type_snapshots(&plan.snapshot);

    // ── Parser-fallthrough alert: before the commit, best effort ──
    if page.has_privacy_details.is_none() && plan.snapshot.is_empty() {
        if let Err(error) = notify::parser_fallthrough(w, ids, now, &page.name) {
            crate::server::diag::log_error(format!(
                "[scraper] parser-fallthrough notification failed: {error}"
            ));
        }
    }

    // ── Change detection ──
    let profile = grid_meta::get_privacy_profile(conn).map_err(message)?;
    let mismatch_before = match (&profile, is_existing) {
        (Some(profile), true) => Some(grid_meta::compute_profile_mismatch(
            Some(profile),
            &snapshot_to_footprint(previous_snapshot.as_deref().unwrap_or(&[])),
        )),
        _ => None,
    };
    let privacy_changes: Vec<Value> = match &previous_snapshot {
        Some(previous) => diff_snapshots(previous, &new_snapshot)
            .into_iter()
            .map(|entry| serde_json::to_value(entry).expect("change entry serialises"))
            .collect(),
        None => vec![],
    };
    let new_accessibility = plan
        .accessibility_features
        .clone()
        .unwrap_or_else(|| previous_accessibility.clone());
    let accessibility_changes = if is_existing {
        diff_accessibility(&previous_accessibility, &new_accessibility)
    } else {
        vec![]
    };
    let age_rating_changes: Vec<Value> =
        match version.age_rating.as_deref().filter(|r| !r.is_empty()) {
            Some(new_rating)
                if is_existing
                    && truthy(&previous_age_rating)
                    && js_string(&previous_age_rating) != new_rating =>
            {
                vec![json!({
                    "category": "age-rating",
                    "type": "modified",
                    "description": format!(
                        "Age rating changed from {} to {}",
                        js_string(&previous_age_rating),
                        new_rating
                    ),
                })]
            }
            _ => vec![],
        };
    let changes: Vec<Value> = [privacy_changes, accessibility_changes, age_rating_changes].concat();
    let has_changes = !changes.is_empty();

    // ── The commit: one transaction, statements in Node's order ──
    let text = |s: &str| Value::String(s.to_string());
    let opt = |o: &Option<String>| o.clone().map(Value::String).unwrap_or(Value::Null);
    let int = |o: Option<i64>| o.map(Value::from).unwrap_or(Value::Null);
    let num = |o: Option<f64>| o.map(js_number).unwrap_or(Value::Null);
    let mut statements: Vec<(&'static str, Vec<Value>)> = vec![(DELETE_TYPES, vec![text(&id)])];
    if is_existing {
        statements.push((
            UPDATE_APP,
            vec![
                text(&page.name),
                text(input.url),
                text(&page.icon_url),
                text(&page.developer),
                text(&page.privacy_policy_url),
                json!(now),
                opt(&version.current_version),
                int(version.version_updated_at),
                opt(&version.whats_new),
                int(page.has_privacy_details),
                int(plan.has_accessibility_labels),
                num(version.price_amount),
                opt(&version.price_currency),
                opt(&version.price_formatted),
                int(page.has_iap),
                num(version.genre_id),
                opt(&version.genre_name),
                opt(&version.age_rating),
                text(&id),
            ],
        ));
    } else {
        statements.push((
            INSERT_APP,
            vec![
                text(&id),
                text(&page.name),
                text(input.url),
                text(&page.icon_url),
                text(&page.developer),
                text(&page.privacy_policy_url),
                json!(now),
                json!(now),
                opt(&version.current_version),
                int(version.version_updated_at),
                opt(&version.whats_new),
                int(page.has_privacy_details),
                int(plan.has_accessibility_labels),
                num(version.price_amount),
                opt(&version.price_currency),
                opt(&version.price_formatted),
                int(page.has_iap),
                num(version.genre_id),
                opt(&version.genre_name),
                opt(&version.age_rating),
            ],
        ));
    }
    for item in &plan.privacy_items {
        let type_id = format!("{id}_{}", item.identifier);
        statements.push((
            INSERT_TYPE,
            vec![
                text(&type_id),
                text(&id),
                text(&item.identifier),
                text(&item.title),
                text(&item.detail),
            ],
        ));
        for category in &item.categories {
            statements.push((
                INSERT_CATEGORY,
                vec![
                    text(&format!("{type_id}_{}", category.identifier)),
                    text(&type_id),
                    text(&category.identifier),
                    text(&category.title),
                ],
            ));
        }
    }
    if let Some(features) = &plan.accessibility_features {
        statements.push((DELETE_ACCESSIBILITY, vec![text(&id)]));
        for f in features {
            statements.push((
                INSERT_ACCESSIBILITY,
                vec![
                    text(&format!("{id}_{}", f.identifier)),
                    text(&id),
                    text(&f.identifier),
                    text(&f.title),
                    opt(&f.description),
                    opt(&f.icon_template),
                ],
            ));
        }
    }
    // The parser cannot yield `null` here (see `WritePlan`), so this shelf
    // is always rewritten.
    statements.push((DELETE_RELATED, vec![text(&id)]));
    for r in &plan.related_apps {
        statements.push((
            INSERT_RELATED,
            vec![
                text(&id),
                text(&r.related_apple_id),
                text(&r.related_name),
                opt(&r.related_developer),
                opt(&r.related_icon_url),
                text(&r.related_store_url),
                text(r.shelf_type),
                json!(now),
            ],
        ));
    }
    let changes_json = serde_json::to_string(&changes).expect("changes serialise");
    statements.push((
        INSERT_SNAPSHOT,
        vec![
            text(&ids.uuid(conn)?),
            text(&id),
            json!(now),
            text(&plan.snapshot_json()),
            json!(i64::from(has_changes)),
            text(&changes_json),
            text(input.trigger),
            opt(&version.current_version),
            int(version.version_updated_at),
        ],
    ));
    if has_changes {
        statements.push((BUMP_CHANGE_COUNT, vec![text(&id)]));
        statements.push((
            INSERT_CHANGE_NOTIFICATION,
            vec![
                text(&ids.uuid(conn)?),
                text(&id),
                text(&page.name),
                text(&changes_json),
                json!(now),
                int(notify::compute_not_before(conn, now)),
            ],
        ));
    }
    let summary = if has_changes {
        format!(
            "{} change{} detected",
            changes.len(),
            if changes.len() == 1 { "" } else { "s" }
        )
    } else if !is_existing {
        "New app added".to_string()
    } else if let (true, Some(previous), Some(current)) =
        (version_changed, &previous_version_text, current_version)
    {
        format!("Version updated from v{previous} to v{current}; no label changes")
    } else {
        "No App Store label changes".to_string()
    };
    let detail = json!({
        "changeCount": changes.len(),
        "isNew": !is_existing,
        "hasPrivacyDetails": page.has_privacy_details,
        "versionChanged": version_changed,
        "previousVersion": if version_changed { previous_version_text.clone() } else { None },
        "currentVersion": if version_changed { version.current_version.clone() } else { None },
        "versionUpdatedAt": if version_changed { version.version_updated_at } else { None },
    });
    statements.push((
        INSERT_ACTIVITY,
        vec![
            text(&ids.uuid(conn)?),
            text(activity_type),
            text(&id),
            text(&page.name),
            text(&summary),
            text(&detail.to_string()),
            json!(now),
            json!(now),
            json!(0),
        ],
    ));
    statements.push((PRUNE_ACTIVITY, vec![]));

    let tx = conn.unchecked_transaction().map_err(message)?;
    w.mark("BEGIN");
    for (sql, params) in statements {
        if let Err(error) = w.run(sql, params) {
            w.mark("ROLLBACK");
            drop(tx);
            return Err(error);
        }
    }
    w.mark("COMMIT");
    tx.commit().map_err(message)?;

    // ── After the commit: both bells are best effort ──
    if let (true, Some(previous), Some(current)) =
        (version_changed, &previous_version_text, current_version)
    {
        if let Err(error) = notify::version_update(
            w,
            ids,
            now,
            &id,
            &page.name,
            previous,
            current,
            &previous_version_updated_at,
            version.version_updated_at,
        ) {
            crate::server::diag::log_error(format!(
                "[scraper] version-update notification failed: {error}"
            ));
        }
    }
    if let Some(profile) = &profile {
        let after = grid_meta::compute_profile_mismatch(
            Some(profile),
            &snapshot_to_footprint(&new_snapshot),
        );
        if !after.mismatches.is_empty() {
            let known: Vec<&str> = mismatch_before
                .as_ref()
                .map(|before| {
                    before
                        .mismatches
                        .iter()
                        .map(|m| m.category.as_str())
                        .collect()
                })
                .unwrap_or_default();
            let new_mismatches: Vec<&Mismatch> = after
                .mismatches
                .iter()
                .filter(|m| !known.contains(&m.category.as_str()))
                .collect();
            if !new_mismatches.is_empty() {
                if let Err(error) = notify::profile_mismatch(
                    w,
                    ids,
                    now,
                    &id,
                    &page.name,
                    &new_mismatches,
                    !is_existing,
                ) {
                    crate::server::diag::log_error(format!(
                        "[scraper] profile-mismatch notify failed for {} {error}",
                        page.name
                    ));
                }
            }
        }
    }

    Ok(Outcome {
        id,
        name: page.name,
        is_new: !is_existing,
        changes_detected: has_changes,
        change_count: changes.len(),
        version_changed,
        previous_version: if version_changed {
            previous_version_text
        } else {
            None
        },
        current_version: if version_changed {
            current_version.map(str::to_string)
        } else {
            None
        },
        version_updated_at: if version_changed {
            version.version_updated_at
        } else {
            None
        },
    })
}

/// `getLatestSnapshot`: the newest `snapshot_json`, parsed. Node's
/// `JSON.parse` throws its own message on a corrupt blob; the text differs
/// here, but Node wrote every blob this reads.
fn latest_snapshot(conn: &Connection, app_id: &str) -> Result<Option<Vec<TypeSnapshot>>, String> {
    let blob: Option<String> = conn
        .query_row(
            "\n    SELECT snapshot_json FROM privacy_snapshots\n    WHERE app_id = ?\n    ORDER BY scraped_at DESC\n    LIMIT 1\n  ",
            [app_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(message)?;
    blob.map(|json| {
        serde_json::from_str::<Vec<TypeSnapshot>>(&json)
            .map_err(|e| format!("Unexpected snapshot blob: {e}"))
    })
    .transpose()
}

/// `buildSnapshot`: the privacy rows in insertion order.
fn build_snapshot(conn: &Connection, app_id: &str) -> Result<Vec<TypeSnapshot>, String> {
    let mut types = conn
        .prepare("SELECT id, identifier, title FROM privacy_types WHERE app_id = ?")
        .map_err(message)?;
    let rows = types
        .query_map([app_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Sql>(1)?,
                r.get::<_, Sql>(2)?,
            ))
        })
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    let mut out = vec![];
    for (type_id, identifier, title) in rows {
        let mut categories = conn
            .prepare("SELECT identifier, title FROM privacy_categories WHERE type_id = ?")
            .map_err(message)?;
        let categories = categories
            .query_map([&type_id], |r| {
                Ok(CategorySnapshot {
                    identifier: Some(json_of(r.get::<_, Sql>(0)?)),
                    title: Some(json_of(r.get::<_, Sql>(1)?)),
                })
            })
            .map_err(message)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(message)?;
        out.push(TypeSnapshot {
            identifier: Some(json_of(identifier)),
            title: Some(json_of(title)),
            categories,
        });
    }
    Ok(out)
}

/// `buildAccessibilitySnapshot`: ordered by identifier.
fn build_accessibility_snapshot(conn: &Connection, app_id: &str) -> Result<Vec<Feature>, String> {
    let mut stmt = conn
        .prepare("SELECT identifier, title, description, icon_template FROM accessibility_features WHERE app_id = ? ORDER BY identifier")
        .map_err(message)?;
    let rows = stmt
        .query_map([app_id], |r| {
            Ok(Feature {
                identifier: r.get(0)?,
                title: r.get(1)?,
                description: r.get(2)?,
                icon_template: r.get(3)?,
            })
        })
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    Ok(rows)
}

/// The parser's snapshot as the diff's input type.
fn to_type_snapshots(snapshot: &[SnapshotType]) -> Vec<TypeSnapshot> {
    snapshot
        .iter()
        .map(|t| TypeSnapshot {
            identifier: Some(Value::String(t.identifier.clone())),
            title: Some(Value::String(t.title.clone())),
            categories: t
                .categories
                .iter()
                .map(|c| CategorySnapshot {
                    identifier: Some(Value::String(c.identifier.clone())),
                    title: Some(Value::String(c.title.clone())),
                })
                .collect(),
        })
        .collect()
}

/// `snapshotToFootprint`: the worst tier per category, categories in
/// first-seen order.
fn snapshot_to_footprint(snapshot: &[TypeSnapshot]) -> Vec<(String, String)> {
    let key = |v: &Option<Value>| {
        v.as_ref()
            .map(js_string)
            .unwrap_or_else(|| "undefined".to_string())
    };
    let mut worst: Vec<(String, String)> = vec![];
    for t in snapshot {
        let Some(tier) = grid_meta::type_to_tier(&key(&t.identifier)) else {
            continue;
        };
        for c in &t.categories {
            let category = key(&c.identifier);
            match worst.iter_mut().find(|(k, _)| *k == category) {
                Some((_, existing)) => {
                    if grid_meta::tier_rank(tier) > grid_meta::tier_rank(existing) {
                        *existing = tier.to_string();
                    }
                }
                None => worst.push((category, tier.to_string())),
            }
        }
    }
    worst
}

/// `diffAccessibility`: added features first, in the new order, then the
/// removed ones in the old order.
fn diff_accessibility(previous: &[Feature], next: &[Feature]) -> Vec<Value> {
    let mut changes = vec![];
    for f in next {
        if !previous.iter().any(|p| p.identifier == f.identifier) {
            changes.push(json!({
                "type": "added",
                "description": format!("Now supports accessibility feature: \"{}\"", f.title),
                "category": "accessibility",
            }));
        }
    }
    for f in previous {
        if !next.iter().any(|n| n.identifier == f.identifier) {
            changes.push(json!({
                "type": "removed",
                "description": format!("No longer claims accessibility feature: \"{}\"", f.title),
                "category": "accessibility",
            }));
        }
    }
    changes
}

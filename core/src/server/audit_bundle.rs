//! lib/audit-bundle.ts and lib/audit-bundle-import.ts: the `.audit.json`
//! a recommender exports and the recipient merges in.
//!
//! The export is a snapshot of the library with the private notes left
//! out at the SQL, never by a flag. The import trusts nothing in the file:
//! every URL goes through the same validators a scrape's would, labels
//! are replaced only where the bundle is newer than what the recipient
//! already has, notes and recommendations land as `imported` rows under
//! the recommender's name and never touch the recipient's own, and the
//! recommender's profile is stashed as a suggestion rather than applied.
//!
//! A bundle is JSON from someone else's machine, so its fields are
//! whatever they are. Node binds them as better-sqlite3 binds JavaScript
//! values, and the port follows: a number is a DOUBLE (so `42` into a TEXT
//! column reads `42.0`), a missing field is NULL, and a boolean or an
//! object is refused at bind time with better-sqlite3's own words, which
//! rolls the whole import back.
use super::{
    backup::js_ordered,
    grid_meta::get_privacy_profile,
    imports_writes::transaction,
    json::js_json_vec,
    stats::{query, truthy},
    writes::{match_profile_preset, Cx},
};
use crate::{
    jsdate::{js_iso_string, local_time},
    jsnum::js_number_spelling,
    jsstr::{is_js_whitespace, js_slice_prefix, js_string, js_trim},
    outbound,
};
use rusqlite::{types::Value as Sql, Connection};
use serde_json::{json, Map, Value};

pub(super) const BUNDLE_VERSION: f64 = 2.0;
const FALLBACK_RECOMMENDER_NAME: &str = "your friend";
const BIND_REFUSED: &str = "SQLite3 can only bind numbers, strings, bigints, buffers, and null";
const BIND_NAMED: &str = "Too few parameter values were provided";

const UPSERT_APP: &str = "INSERT INTO apps\n       (id, name, url, iconUrl, bundleId, developer, firstSeen, lastSynced,\n        currentVersion, versionUpdatedAt, whatsNew, hasPrivacyDetails,\n        hasAccessibilityLabels, privacyPolicyUrl,\n        priceAmount, priceCurrency, priceFormatted, hasIap)\n     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)\n     ON CONFLICT(id) DO UPDATE SET\n       name                   = excluded.name,\n       url                    = COALESCE(excluded.url, apps.url),\n       iconUrl                = excluded.iconUrl,\n       bundleId               = COALESCE(excluded.bundleId, apps.bundleId),\n       developer              = COALESCE(excluded.developer, apps.developer),\n       lastSynced             = excluded.lastSynced,\n       currentVersion         = COALESCE(excluded.currentVersion, apps.currentVersion),\n       hasPrivacyDetails      = excluded.hasPrivacyDetails,\n       hasAccessibilityLabels = excluded.hasAccessibilityLabels,\n       privacyPolicyUrl       = COALESCE(excluded.privacyPolicyUrl, apps.privacyPolicyUrl),\n       priceAmount            = COALESCE(excluded.priceAmount, apps.priceAmount),\n       priceCurrency          = COALESCE(excluded.priceCurrency, apps.priceCurrency),\n       priceFormatted         = COALESCE(excluded.priceFormatted, apps.priceFormatted),\n       hasIap                 = COALESCE(excluded.hasIap, apps.hasIap)";
const DELETE_TYPES: &str = "DELETE FROM privacy_types WHERE app_id = ?";
const DELETE_FEATURES: &str = "DELETE FROM accessibility_features WHERE app_id = ?";
const INSERT_TYPE: &str =
    "INSERT INTO privacy_types (id, app_id, identifier, title, detail) VALUES (?, ?, ?, ?, ?)";
const INSERT_CATEGORY: &str =
    "INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)";
const INSERT_FEATURE: &str = "INSERT INTO accessibility_features\n         (id, app_id, identifier, title, description, icon_template)\n       VALUES (?, ?, ?, ?, ?, NULL)";
const UPSERT_POLICY: &str = "INSERT INTO privacy_policy_analyses\n       (app_id, policy_url, status, source_text, source_word_count,\n        analysis_mode, summary_json, model, error, updated_at,\n        source_fetched_at)\n     VALUES (?, ?, ?, ?, ?, 'imported', ?, 'imported', NULL, ?, ?)\n     ON CONFLICT(app_id) DO UPDATE SET\n       policy_url        = excluded.policy_url,\n       status            = CASE WHEN COALESCE(excluded.summary_json, privacy_policy_analyses.summary_json) IS NULL THEN 'source_ready' ELSE 'ready' END,\n       source_text       = COALESCE(excluded.source_text, privacy_policy_analyses.source_text),\n       source_word_count = excluded.source_word_count,\n       analysis_mode     = excluded.analysis_mode,\n       summary_json      = COALESCE(excluded.summary_json, privacy_policy_analyses.summary_json),\n       model             = excluded.model,\n       updated_at        = excluded.updated_at,\n       source_fetched_at = COALESCE(excluded.source_fetched_at, privacy_policy_analyses.source_fetched_at)";
const INSERT_ANNOTATION: &str = "INSERT INTO annotations\n         (id, app_id, content, source, source_name, visibility, tag,\n          created_at, updated_at, deleted_at)\n       VALUES (?, ?, ?, 'imported', ?, ?, ?, ?, ?, NULL)";
const UPSERT_VERDICT: &str = "INSERT INTO app_verdicts\n           (id, app_id, verdict, rationale, source, source_name, set_at, updated_at)\n         VALUES (?, ?, ?, ?, 'imported', ?, ?, ?)\n         ON CONFLICT(app_id, source, source_name) DO UPDATE SET\n           verdict    = excluded.verdict,\n           rationale  = excluded.rationale,\n           updated_at = excluded.updated_at";
const INSERT_IMPORT: &str = "INSERT OR IGNORE INTO audit_bundle_imports\n           (id, exported_at, imported_at, recommender_name, bundle_app_version,\n            apps_total, apps_added, apps_updated, apps_skipped, annotations_added)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPSERT_IMPORT: &str = "INSERT INTO audit_bundle_imports\n           (id, exported_at, imported_at, recommender_name, bundle_app_version,\n            apps_total, apps_added, apps_updated, apps_skipped, annotations_added)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n         ON CONFLICT(exported_at) DO UPDATE SET\n           imported_at        = excluded.imported_at,\n           recommender_name   = excluded.recommender_name,\n           apps_total         = excluded.apps_total,\n           apps_added         = excluded.apps_added,\n           apps_updated       = excluded.apps_updated,\n           apps_skipped       = excluded.apps_skipped,\n           annotations_added  = excluded.annotations_added";

/// `package.json`'s version: the app's, not the crate's.
pub(super) fn app_version() -> String {
    serde_json::from_str::<Value>(include_str!("../../../package.json"))
        .ok()
        .and_then(|v| v["version"].as_str().map(str::to_string))
        .unwrap_or_default()
}

// ── Export ───────────────────────────────────────────────────────────

pub(super) struct ExportOptions<'a> {
    /// `body.recommenderName ?? null`, whatever type the body gave it.
    pub(super) recommender_name: &'a Value,
    pub(super) include_profile: bool,
    pub(super) audience: &'a str,
    pub(super) migration_flow: bool,
}

/// One bound text parameter.
fn text(id: &str) -> [Sql; 1] {
    [Sql::Text(id.to_string())]
}

fn privacy_types(conn: &Connection, app_id: &str) -> rusqlite::Result<Vec<Value>> {
    let sql = "\n    SELECT id, identifier, title, detail\n    FROM privacy_types\n    WHERE app_id = ?\n    ORDER BY title\n  ";
    let mut out = Vec::new();
    for t in query(conn, sql, &text(app_id))? {
        let categories = query(
            conn,
            "\n      SELECT identifier, title\n      FROM privacy_categories\n      WHERE type_id = ?\n      ORDER BY title\n    ",
            &text(t["id"].as_str().unwrap_or("")),
        )?;
        out.push(json!({
            "identifier": t["identifier"],
            "title": t["title"],
            "detail": t["detail"],
            "categories": categories,
        }));
    }
    Ok(out)
}

/// `buildAccessibilityFeatures`: every stored feature is a declared one;
/// a failed read is an empty list, as Node's catch makes it.
fn accessibility_features(conn: &Connection, app_id: &str) -> Vec<Value> {
    query(
        conn,
        "\n      SELECT identifier, title, description\n      FROM accessibility_features\n      WHERE app_id = ?\n      ORDER BY title\n    ",
        &text(app_id),
    )
    .map(|rows| {
        rows.into_iter()
            .map(|r| {
                json!({
                    "identifier": r["identifier"],
                    "title": r["title"],
                    "declared": true,
                    "description": r["description"],
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// `buildPolicySummary`: the stored summary with the first 4096 UTF-16
/// units of the policy text — enough to check what was summarised,
/// without shipping every policy in every bundle.
fn policy_summary(conn: &Connection, app_id: &str) -> Value {
    let row = query(
        conn,
        "\n      SELECT summary_json, source_text, source_fetched_at, updated_at AS generated_at\n      FROM privacy_policy_analyses\n      WHERE app_id = ?\n      LIMIT 1\n    ",
        &text(app_id),
    )
    .ok()
    .and_then(|rows| rows.into_iter().next());
    let Some(row) = row else {
        return Value::Null;
    };
    let excerpt = match row["source_text"].as_str() {
        Some(s) if !s.is_empty() => json!(js_slice_prefix(s, 4096)),
        _ => Value::Null,
    };
    json!({
        "summary_json": row["summary_json"],
        "source_text_excerpt": excerpt,
        "fetched_at": row["source_fetched_at"],
        "generated_at": row["generated_at"],
    })
}

/// `buildAuditBundle`, key for key.
pub(super) fn build_audit_bundle(
    conn: &Connection,
    now: i64,
    opts: &ExportOptions,
) -> Result<Value, String> {
    let fail = |e: rusqlite::Error| e.to_string();
    let mut apps = Vec::new();
    for row in query(
        conn,
        "\n    SELECT id, name, developer, bundleId, url, iconUrl, currentVersion,\n           privacyPolicyUrl, hasPrivacyDetails, hasAccessibilityLabels,\n           priceAmount, priceCurrency, priceFormatted, hasIap\n    FROM apps\n    ORDER BY name COLLATE NOCASE\n  ",
        &[],
    )
    .map_err(fail)?
    {
        let id = row["id"].as_str().unwrap_or("").to_string();
        apps.push(json!({
            "id": row["id"],
            "name": row["name"],
            "developer": row["developer"],
            "bundle_id": row["bundleId"],
            "url": row["url"],
            "icon_url": row["iconUrl"],
            "current_version": row["currentVersion"],
            "privacy_policy_url": row["privacyPolicyUrl"],
            "has_privacy_details": row["hasPrivacyDetails"],
            "has_accessibility_labels": row["hasAccessibilityLabels"],
            "privacy_types": privacy_types(conn, &id).map_err(fail)?,
            "accessibility_features": accessibility_features(conn, &id),
            "policy_summary": policy_summary(conn, &id),
            "price_amount": row["priceAmount"],
            "price_currency": row["priceCurrency"],
            "price_formatted": row["priceFormatted"],
            "has_iap": row["hasIap"],
        }));
    }
    // The `visibility = 'export'` filter is the guarantee: a private note
    // never leaves the install, whatever the caller asked for.
    let annotations = query(
        conn,
        "\n    SELECT id, app_id, content, source, source_name, visibility,\n           tag, created_at, updated_at\n    FROM annotations\n    WHERE deleted_at IS NULL\n      AND visibility = 'export'\n    ORDER BY created_at DESC\n  ",
        &[],
    )
    .map_err(fail)?;
    // The recommender's own verdicts only: one they were given is not
    // theirs to pass on.
    let verdicts = query(
        conn,
        "\n    SELECT app_id, verdict, rationale, set_at, updated_at\n    FROM app_verdicts\n    WHERE source = 'user'\n    ORDER BY updated_at DESC\n  ",
        &[],
    )
    .map_err(fail)?;
    let profile: Option<Map<String, Value>> = if opts.include_profile {
        get_privacy_profile(conn).map_err(fail)?.map(|tiers| {
            tiers
                .into_iter()
                .map(|(category, tier)| (category, json!(tier)))
                .collect()
        })
    } else {
        None
    };
    let preset = match_profile_preset(profile.as_ref());

    let mut out = Map::new();
    out.insert("version".into(), json!(BUNDLE_VERSION as i64));
    out.insert("app_version".into(), json!(app_version()));
    out.insert("exported_at".into(), json!(js_iso_string(now)));
    out.insert("exported_by_audience".into(), json!(opts.audience));
    out.insert("recommender_name".into(), opts.recommender_name.clone());
    out.insert("apps".into(), Value::Array(apps));
    out.insert(
        "recommender_profile".into(),
        profile.map_or(Value::Null, Value::Object),
    );
    out.insert("recommender_profile_preset".into(), json!(preset));
    out.insert("annotations".into(), Value::Array(annotations));
    out.insert("verdicts".into(), Value::Array(verdicts));
    // Only when asked for: an older recipient never sees a `false` it
    // would have to special-case.
    if opts.migration_flow {
        out.insert("migration_flow".into(), json!(true));
    }
    Ok(Value::Object(out))
}

/// `buildBundleFilename`: `{slug}-{YYYY-MM-DD}-{HHmm}.audit.json` in the
/// PROCESS timezone, `audit` when the name slugs to nothing.
pub(super) fn bundle_filename(recommender_name: Option<&str>, now: i64) -> String {
    let when = local_time(now).unwrap_or(crate::jsdate::LocalTime {
        year: 1970,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
    });
    let lowered = js_trim(recommender_name.unwrap_or("")).to_lowercase();
    // `.replace(/\s+/g, "-")` then `.replace(/[^a-z0-9-]/g, "")`.
    let mut slug = String::new();
    let mut in_space = false;
    for c in lowered.chars() {
        if is_js_whitespace(c) {
            if !in_space {
                slug.push('-');
            }
            in_space = true;
            continue;
        }
        in_space = false;
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
            slug.push(c);
        }
    }
    let stem = if slug.is_empty() { "audit" } else { &slug };
    format!(
        "{stem}-{:04}-{:02}-{:02}-{:02}{:02}.audit.json",
        when.year, when.month, when.day, when.hour, when.minute
    )
}

// ── Validation ───────────────────────────────────────────────────────

fn corrupted(what: &str) -> String {
    format!("This bundle appears corrupted ({what}).")
}

fn missing(field: &str) -> String {
    corrupted(&format!("missing required field: `{field}`"))
}

fn non_empty_string(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `validateBundle`: each failure is the sentence the client shows as it
/// is. `force` skips the version check and nothing else.
pub(super) fn validate_bundle(parsed: &Value, force: bool) -> Result<&Map<String, Value>, String> {
    let Value::Object(obj) = parsed else {
        return Err("This file isn't a valid audit bundle (couldn't parse JSON).".to_string());
    };
    if !force {
        let Some(version) = obj.get("version").and_then(Value::as_f64) else {
            return Err(missing("version"));
        };
        if version > BUNDLE_VERSION {
            // `obj.app_version || `${obj.version}``, then into a template.
            let yours = match obj.get("app_version") {
                Some(v) if truthy(v) => js_string(v),
                _ => js_number_spelling(version),
            };
            return Err(format!(
                "This bundle is for app version {yours} (you're on {}). Update to import.",
                app_version()
            ));
        }
    }
    for key in ["exported_at", "apps", "annotations"] {
        if !obj.contains_key(key) {
            return Err(missing(key));
        }
    }
    if non_empty_string(obj.get("exported_at")).is_none() {
        return Err(missing("exported_at"));
    }
    let Some(apps) = obj["apps"].as_array() else {
        return Err(missing("apps"));
    };
    if !obj["annotations"].is_array() {
        return Err(missing("annotations"));
    }
    for (i, app) in apps.iter().enumerate() {
        // `!app || typeof app !== "object"`: an array is an object, and
        // fails on its missing id instead.
        let fields = match app {
            Value::Object(map) => Some(map),
            Value::Array(_) => None,
            _ => return Err(corrupted(&format!("apps[{i}] isn't an object"))),
        };
        let Some(id) = non_empty_string(fields.and_then(|f| f.get("id"))) else {
            return Err(corrupted(&format!("apps[{i}] is missing `id`")));
        };
        let fields = fields.expect("an id came from an object");
        if non_empty_string(fields.get("name")).is_none() {
            return Err(corrupted(&format!("apps[{i}] \"{id}\" is missing `name`")));
        }
        if !fields.get("privacy_types").is_some_and(Value::is_array) {
            return Err(corrupted(&format!(
                "apps[{i}] \"{id}\" is missing `privacy_types`"
            )));
        }
    }
    Ok(obj)
}

/// `findExistingImport`.
pub(super) fn find_existing_import(
    conn: &Connection,
    exported_at: &str,
) -> rusqlite::Result<Option<Value>> {
    let rows = query(
        conn,
        "SELECT imported_at, recommender_name, apps_total, apps_added,\n              apps_updated, apps_skipped, annotations_added\n         FROM audit_bundle_imports\n        WHERE exported_at = ?",
        &text(exported_at),
    )?;
    Ok(rows.into_iter().next().map(|r| {
        json!({
            "importedAt": r["imported_at"],
            "recommenderName": r["recommender_name"],
            "appsTotal": r["apps_total"],
            "appsAdded": r["apps_added"],
            "appsUpdated": r["apps_updated"],
            "appsSkipped": r["apps_skipped"],
            "annotationsAdded": r["annotations_added"],
        })
    }))
}

/// `new Date(ms).toLocaleString()` as en-US spells it, in the process
/// timezone: `1/5/2026, 12:05:09 AM`. Node takes the HOST's locale and
/// its ICU's choice of separator before AM/PM; this is the en-US form
/// with a plain space, which is what Node resolves with no `LANG` set.
pub(super) fn locale_string(ms: i64) -> String {
    let Some(t) = local_time(ms) else {
        return String::new();
    };
    let (hour, half) = match t.hour {
        0 => (12, "AM"),
        1..=11 => (t.hour, "AM"),
        12 => (12, "PM"),
        _ => (t.hour - 12, "PM"),
    };
    format!(
        "{}/{}/{}, {hour}:{:02}:{:02} {half}",
        t.month, t.day, t.year, t.minute, t.second
    )
}

// ── Import ───────────────────────────────────────────────────────────

/// A bundle field as better-sqlite3 would bind it.
pub(super) fn bind(v: Option<&Value>) -> Result<Value, &'static str> {
    Ok(match v {
        // `undefined` and `null` both bind as NULL.
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => json!(s),
        // Every JavaScript number is bound as a double.
        Some(Value::Number(n)) => serde_json::Number::from_f64(n.as_f64().unwrap_or(f64::NAN))
            .map_or(Value::Null, Value::Number),
        Some(Value::Bool(_)) => return Err(BIND_REFUSED),
        // A plain object in the argument list is read as a bag of NAMED
        // parameters, which leaves the positional ones one short. (An
        // array is spread into the list instead; that is not reproduced —
        // it is refused like the object, where Node would bind a
        // one-element array as its element.)
        Some(Value::Object(_) | Value::Array(_)) => return Err(BIND_NAMED),
    })
}

/// Run `sql` with bundle-supplied values, or record the attempt and fail
/// with Node's words where one of them cannot be bound.
fn run_bound(cx: &mut Cx, sql: &str, params: Vec<Option<&Value>>) -> Result<(), String> {
    let mut bound = Vec::with_capacity(params.len());
    let mut refused = None;
    for p in &params {
        match bind(*p) {
            Ok(v) => bound.push(v),
            Err(why) => {
                refused.get_or_insert(why);
                bound.push((*p).cloned().unwrap_or(Value::Null));
            }
        }
    }
    if let Some(why) = refused {
        cx.w.refuse(sql, bound);
        return Err(why.to_string());
    }
    cx.w.run(sql, bound).map(drop)
}

/// `safeAppStoreUrl`: a real App Store product URL, or the empty string.
fn safe_app_store_url(raw: Option<&Value>) -> Value {
    let url = non_empty_string(raw)
        .and_then(|s| outbound::app_store_url(s).ok())
        .map(|u| u.to_string())
        .unwrap_or_default();
    json!(url)
}

/// `safeIconUrl` / `safePolicyUrl`: a public http(s) URL, or NULL.
fn safe_public_url(raw: Option<&Value>) -> Value {
    non_empty_string(raw)
        .and_then(|s| outbound::validate(s, &[], 2048).ok())
        .map_or(Value::Null, |u| json!(u.to_string()))
}

/// `guessIncomingLastSynced`: the policy's fetch time when the bundle has
/// one, else when the bundle was exported, else now.
fn incoming_last_synced(app: &Map<String, Value>, exported_at: &str, now: i64) -> f64 {
    let fetched = app
        .get("policy_summary")
        .and_then(|p| p.get("fetched_at"))
        .and_then(Value::as_f64)
        .filter(|n| *n > 0.0);
    fetched.unwrap_or_else(|| crate::jsdate::parse(exported_at).unwrap_or(now) as f64)
}

/// `excerpt.split(/\s+/).length`: one more than the runs of whitespace,
/// so leading and trailing space each count an empty "word".
fn split_on_whitespace_len(s: &str) -> i64 {
    let mut runs = 0;
    let mut in_space = false;
    for c in s.chars() {
        let space = is_js_whitespace(c);
        if space && !in_space {
            runs += 1;
        }
        in_space = space;
    }
    runs + 1
}

fn as_object(v: &Value) -> Result<&Map<String, Value>, String> {
    v.as_object()
        .ok_or_else(|| "This bundle appears corrupted (an entry isn't an object).".to_string())
}

fn items(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn upsert_app(cx: &mut Cx, app: &Map<String, Value>, last_synced: f64) -> Result<(), String> {
    let synced = json!(last_synced);
    let (url, icon, policy) = (
        safe_app_store_url(app.get("url")),
        safe_public_url(app.get("icon_url")),
        safe_public_url(app.get("privacy_policy_url")),
    );
    run_bound(
        cx,
        UPSERT_APP,
        vec![
            app.get("id"),
            app.get("name"),
            Some(&url),
            Some(&icon),
            app.get("bundle_id"),
            app.get("developer"),
            Some(&synced),
            Some(&synced),
            app.get("current_version"),
            app.get("has_privacy_details"),
            app.get("has_accessibility_labels"),
            Some(&policy),
            app.get("price_amount"),
            app.get("price_currency"),
            app.get("price_formatted"),
            app.get("has_iap"),
        ],
    )
}

/// `replaceAppLabels`: wipe and re-insert, as a scrape does. Categories
/// cascade from their types.
fn replace_app_labels(cx: &mut Cx, app: &Map<String, Value>) -> Result<(), String> {
    let app_id = app.get("id");
    run_bound(cx, DELETE_TYPES, vec![app_id])?;
    run_bound(cx, DELETE_FEATURES, vec![app_id])?;
    for kind in items(app.get("privacy_types")) {
        let kind = as_object(kind)?;
        let type_id = json!(cx.ids.hex_id(cx.w.conn, "pt-", 8)?);
        run_bound(
            cx,
            INSERT_TYPE,
            vec![
                Some(&type_id),
                app_id,
                kind.get("identifier"),
                kind.get("title"),
                kind.get("detail"),
            ],
        )?;
        for category in items(kind.get("categories")) {
            let category = as_object(category)?;
            let category_id = json!(cx.ids.hex_id(cx.w.conn, "pc-", 8)?);
            run_bound(
                cx,
                INSERT_CATEGORY,
                vec![
                    Some(&category_id),
                    Some(&type_id),
                    category.get("identifier"),
                    category.get("title"),
                ],
            )?;
        }
    }
    for feature in items(app.get("accessibility_features")) {
        let feature = as_object(feature)?;
        if !feature.get("declared").is_some_and(truthy) {
            continue;
        }
        let feature_id = json!(cx.ids.hex_id(cx.w.conn, "af-", 8)?);
        run_bound(
            cx,
            INSERT_FEATURE,
            vec![
                Some(&feature_id),
                app_id,
                feature.get("identifier"),
                feature.get("title"),
                feature.get("description"),
            ],
        )?;
    }
    Ok(())
}

/// `upsertPolicySummary`: only with something to store and a policy URL
/// that survives sanitising — a summary with nowhere safe to link is
/// dropped rather than stored. The status follows the summary the row
/// ends up with: bound here from the bundle's (`summary_json ?? null`),
/// and decided again in the `ON CONFLICT` against the one it keeps.
fn upsert_policy_summary(cx: &mut Cx, app: &Map<String, Value>) -> Result<(), String> {
    let Some(summary) = app.get("policy_summary").and_then(Value::as_object) else {
        return Ok(());
    };
    let has = |key: &str| summary.get(key).is_some_and(truthy);
    if !(has("summary_json") || has("source_text_excerpt")) {
        return Ok(());
    }
    let policy_url = safe_public_url(app.get("privacy_policy_url"));
    if policy_url.is_null() {
        return Ok(());
    }
    let excerpt = summary.get("source_text_excerpt");
    let words = json!(match excerpt.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => split_on_whitespace_len(s),
        _ => 0,
    });
    let status = json!(match summary.get("summary_json") {
        None | Some(Value::Null) => "source_ready",
        Some(_) => "ready",
    });
    let now = json!(cx.now);
    run_bound(
        cx,
        UPSERT_POLICY,
        vec![
            app.get("id"),
            Some(&policy_url),
            Some(&status),
            excerpt,
            Some(&words),
            summary.get("summary_json"),
            Some(&now),
            summary.get("fetched_at"),
        ],
    )
}

/// `Object.keys(v).length > 0` for a truthy `v`.
fn has_keys(v: &Value) -> bool {
    match v {
        Value::Object(map) => !map.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::String(s) => !s.is_empty(),
        _ => false,
    }
}

fn spelled(v: &Value) -> Result<String, String> {
    js_json_vec(&js_ordered(v))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|e| e.to_string())
}

/// `importAuditBundle`: one transaction, all or nothing. Returns the
/// `ImportSummary`.
pub(super) fn import_audit_bundle(
    cx: &mut Cx,
    bundle: &Map<String, Value>,
    allow_duplicate: bool,
) -> Result<Value, String> {
    // `(bundle.recommender_name ?? "").trim() || "your friend"`. A name
    // that is neither a string nor null is a TypeError on Node, whose text
    // depends on how the build spelled the expression; it is a failed
    // import here too, in plain words.
    let recommender_name = match bundle.get("recommender_name") {
        None | Some(Value::Null) => "",
        Some(Value::String(s)) => js_trim(s),
        Some(_) => return Err("The bundle's recommender name isn't text.".to_string()),
    };
    let recommender_name = if recommender_name.is_empty() {
        FALLBACK_RECOMMENDER_NAME
    } else {
        recommender_name
    };
    let recommender = json!(recommender_name);
    let imported_at = cx.now;
    let imported_at_value = json!(imported_at);
    // Minted before the transaction, so a failed import still spends it.
    let import_id = json!(cx.ids.hex_id(cx.w.conn, "bundle-", 12)?);
    let exported_at = bundle["exported_at"].as_str().unwrap_or("");
    let apps = items(bundle.get("apps"));
    let in_bundle = |app_id: Option<&Value>| {
        app_id.is_some_and(|id| apps.iter().any(|a| a.get("id") == Some(id)))
    };

    let (mut added, mut updated, mut skipped) = (0i64, 0i64, 0i64);
    let (mut annotations_added, mut verdicts_added) = (0i64, 0i64);
    let stashed = transaction(cx, |cx| {
        // Who wins each app is decided against what was here BEFORE the
        // import: the map is not updated as rows land.
        let existing: Vec<(String, f64)> = query(cx.w.conn, "SELECT id, lastSynced FROM apps", &[])
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|r| {
                Some((
                    r["id"].as_str()?.to_string(),
                    r["lastSynced"].as_f64().unwrap_or(0.0),
                ))
            })
            .collect();
        let existing_sync = |id: &str| existing.iter().find(|(e, _)| e == id).map(|(_, at)| *at);
        let known = |app_id: Option<&Value>| {
            app_id
                .and_then(Value::as_str)
                .is_some_and(|id| existing_sync(id).is_some())
                || in_bundle(app_id)
        };

        for app in apps {
            let app = as_object(app)?;
            let incoming = incoming_last_synced(app, exported_at, cx.now);
            let here = existing_sync(app["id"].as_str().unwrap_or(""));
            if here.is_some_and(|at| incoming <= at) {
                // The recipient's copy is as new or newer: keep it.
                skipped += 1;
                continue;
            }
            upsert_app(cx, app, incoming)?;
            replace_app_labels(cx, app)?;
            upsert_policy_summary(cx, app)?;
            if here.is_some() {
                updated += 1;
            } else {
                added += 1;
            }
        }

        // Notes land whoever won the app: they are new rows under the
        // recommender's name, never the recipient's own.
        for note in items(bundle.get("annotations")) {
            let note = as_object(note)?;
            if !known(note.get("app_id")) {
                continue;
            }
            let id = json!(cx.ids.hex_id(cx.w.conn, "imp-", 12)?);
            let export = json!("export");
            run_bound(
                cx,
                INSERT_ANNOTATION,
                vec![
                    Some(&id),
                    note.get("app_id"),
                    note.get("content"),
                    Some(&recommender),
                    Some(&export),
                    note.get("tag"),
                    note.get("created_at")
                        .filter(|v| !v.is_null())
                        .or(Some(&imported_at_value)),
                    note.get("updated_at")
                        .filter(|v| !v.is_null())
                        .or(Some(&imported_at_value)),
                ],
            )?;
            annotations_added += 1;
        }

        // Recommendations: advisory `imported` rows, one per recommender
        // per app. The recipient's own verdict is a different row and is
        // never touched.
        for verdict in items(bundle.get("verdicts")) {
            let verdict = as_object(verdict)?;
            if !known(verdict.get("app_id")) {
                continue;
            }
            let value = verdict.get("verdict").and_then(Value::as_str);
            if !matches!(value, Some("safe" | "replace" | "uninstall")) {
                continue;
            }
            let id = json!(cx.ids.hex_id(cx.w.conn, "imp-vrd-", 12)?);
            run_bound(
                cx,
                UPSERT_VERDICT,
                vec![
                    Some(&id),
                    verdict.get("app_id"),
                    verdict.get("verdict"),
                    verdict.get("rationale"),
                    Some(&recommender),
                    verdict
                        .get("set_at")
                        .filter(|v| !v.is_null())
                        .or(Some(&imported_at_value)),
                    verdict
                        .get("updated_at")
                        .filter(|v| !v.is_null())
                        .or(Some(&imported_at_value)),
                ],
            )?;
            verdicts_added += 1;
        }

        // The recommender's profile is a suggestion to accept later, not
        // something an import applies.
        let preset = bundle
            .get("recommender_profile_preset")
            .cloned()
            .unwrap_or(Value::Null);
        let mut stashed = false;
        if let Some(profile) = bundle.get("recommender_profile").filter(|p| has_keys(p)) {
            let blob = spelled(&json!({
                "profile": profile,
                "preset": preset,
                "recommenderName": recommender_name,
                "stashedAt": imported_at,
            }))?;
            // Best effort on Node; a failed write here fails the import.
            cx.set("recommender_profile_suggestion", &blob)?;
            stashed = true;
        }
        // A same-user migration: one-shot marker for the next dashboard load.
        if bundle.get("migration_flow") == Some(&json!(true)) {
            let blob = spelled(&json!({
                "recommenderName": recommender_name,
                "stashedAt": imported_at,
                "targetPath": "/dashboard/review-recommendations",
            }))?;
            cx.set("migration_flow_pending", &blob)?;
        }

        let total = json!(apps.len());
        let counts = [
            json!(added),
            json!(updated),
            json!(skipped),
            json!(annotations_added),
        ];
        run_bound(
            cx,
            if allow_duplicate {
                UPSERT_IMPORT
            } else {
                INSERT_IMPORT
            },
            vec![
                Some(&import_id),
                bundle.get("exported_at"),
                Some(&imported_at_value),
                bundle.get("recommender_name"),
                bundle.get("app_version"),
                Some(&total),
                Some(&counts[0]),
                Some(&counts[1]),
                Some(&counts[2]),
                Some(&counts[3]),
            ],
        )?;
        Ok(stashed)
    })?;

    Ok(json!({
        "appsTotal": apps.len(),
        "appsAdded": added,
        "appsUpdated": updated,
        "appsSkipped": skipped,
        "annotationsAdded": annotations_added,
        "verdictsAdded": verdicts_added,
        "recommenderProfileStashed": stashed,
        "recommenderProfilePreset": bundle
            .get("recommender_profile_preset")
            .cloned()
            .unwrap_or(Value::Null),
        "recommenderName": recommender_name,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_length_counts_the_empty_ends_as_javascript_does() {
        // `s.split(/\s+/).length` from node.
        for (s, n) in [
            ("one", 1),
            ("two words", 2),
            ("  two\n\twords  ", 4),
            (" ", 2),
            ("a\u{a0}b\u{feff}c", 3),
        ] {
            assert_eq!(split_on_whitespace_len(s), n, "{s:?}");
        }
    }

    #[test]
    fn filenames_slug_the_name_and_fall_back_to_audit() {
        // The date part is in the process zone, which the replay tests
        // switch to UTC while they run: hold the env lock so both reads
        // below see one zone.
        let _env = crate::server::trust::env_lock();
        let at = 1_789_475_696_789;
        let date = {
            let t = local_time(at).unwrap();
            format!(
                "{:04}-{:02}-{:02}-{:02}{:02}",
                t.year, t.month, t.day, t.hour, t.minute
            )
        };
        for (name, stem) in [
            (Some("Sam"), "sam"),
            (Some("  Sam  O'Neil\tJr. "), "sam-oneil-jr"),
            (Some("李 📸 !!"), "--"),
            (Some("Zoë Å"), "zo-"),
            (Some(""), "audit"),
            (None, "audit"),
        ] {
            assert_eq!(
                bundle_filename(name, at),
                format!("{stem}-{date}.audit.json"),
                "{name:?}"
            );
        }
    }
}

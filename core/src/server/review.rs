//! The review queue degrades each read independently. The raw verdict union
//! counts orphan verdicts; the row count counts only tracked apps.
use super::{
    scope::Scope,
    stats::{query, text, Result},
};
use crate::jsstr::{is_js_whitespace, js_keyed_object};
use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

fn safe<T, E: std::fmt::Display>(result: std::result::Result<T, E>, fallback: T, label: &str) -> T {
    result.unwrap_or_else(|e| {
        super::diag::log_warn(format!("[review-queue] {label} failed: {e}"));
        fallback
    })
}
fn verdicts(conn: &Connection, imported: bool) -> rusqlite::Result<Map<String, Value>> {
    let filter = if imported {
        "source = 'imported' ORDER BY set_at DESC"
    } else {
        "source = 'user'"
    };
    let rows=query(conn,&format!("SELECT id, app_id, verdict, rationale, source, source_name, set_at, updated_at FROM app_verdicts WHERE {filter}"),&[])?;
    let mut out = Map::new();
    for r in rows {
        let v = json!({
"id":r["id"],
"appId":r["app_id"],
"verdict":r["verdict"],
"rationale":r["rationale"],
"source":r["source"],
"sourceName":r["source_name"],
"setAt":r["set_at"],
"updatedAt":r["updated_at"]});
        let id = text(&r["app_id"]).to_owned();
        if imported {
            out.entry(id)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .unwrap()
                .push(v);
        } else {
            out.insert(id, v);
        }
    }
    Ok(out)
}
fn modes(raw: &Value) -> Vec<&'static str> {
    let tokens: Vec<_> = text(raw)
        .split(',')
        .map(|s| s.trim_matches(is_js_whitespace).to_lowercase())
        .collect();
    let mut out: Vec<_> = ["privacy", "accessibility"]
        .into_iter()
        .filter(|s| tokens.iter().any(|t| t == s))
        .collect();
    if out.is_empty() {
        out.push("privacy");
    }
    out
}
pub(super) fn shortlist_entry(r: &Value, badges: &Value) -> Value {
    let tracked = r["candidate_is_tracked"] == 1;
    let badge = if tracked {
        badges
            .get(text(&r["candidate_apple_id"]))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    json!({
"id":r["id"],
"sourceAppId":r["source_app_id"],
"candidateAppleId":r["candidate_apple_id"],
"candidateName":r["candidate_name"],
"candidateDeveloper":r["candidate_developer"].as_str().unwrap_or(""),
"candidateIconUrl":r["candidate_icon_url"].as_str().unwrap_or(""),
"candidateStoreUrl":r["candidate_store_url"],
"candidateBundleId":r["candidate_bundle_id"].as_str().unwrap_or(""),
"note":r["note"].as_str().unwrap_or(""),
"addedAt":r["added_at"],
"candidateIsTracked":tracked,
"modes":modes(&r["mode"]),
"profileBadge":badge,
"candidatePriceFormatted":r["candidate_price_formatted"],
"candidatePriceCurrency":r["candidate_price_currency"],
"candidateHasIap":r["candidate_has_iap"]})
}
fn shortlists(conn: &Connection) -> rusqlite::Result<Map<String, Value>> {
    let rows=query(conn,"SELECT s.*, CASE WHEN t.id IS NULL THEN 0 ELSE 1 END AS candidate_is_tracked, t.priceFormatted AS candidate_price_formatted, t.priceCurrency AS candidate_price_currency, t.hasIap AS candidate_has_iap FROM shortlist_entries s JOIN apps a ON a.id = s.source_app_id LEFT JOIN apps t ON t.id = s.candidate_apple_id ORDER BY s.added_at DESC",&[])?;
    let badges = super::grid_meta::candidate_badges(conn)?;
    let mut out = Map::new();
    for r in rows {
        let entry = shortlist_entry(&r, &badges);
        out.entry(text(&r["source_app_id"]).to_owned())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap()
            .push(entry);
    }
    Ok(out)
}
pub(super) fn annotations(conn: &Connection, id: &str, now: i64) -> rusqlite::Result<Vec<Value>> {
    let sweep = (|| -> rusqlite::Result<()> {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM annotations WHERE deleted_at IS NOT NULL AND deleted_at < ?",
            [now - 30_000],
        )?;
        tx.commit()
    })();
    if let Err(e) = sweep {
        super::diag::log_warn(format!("[annotations] sweep failed: {e}"));
    }
    Ok(query(conn,"SELECT id, app_id, content, source, source_name, visibility, tag, created_at, updated_at, deleted_at FROM annotations WHERE app_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",&[SqlValue::Text(id.to_owned())])?.into_iter().map(|r|json!({
"id":r["id"],
"appId":r["app_id"],
"content":r["content"],
"source":r["source"],
"sourceName":r["source_name"],
"visibility":r["visibility"],
"tag":r["tag"],
"createdAt":r["created_at"],
"updatedAt":r["updated_at"],
"deletedAt":r["deleted_at"]})).collect())
}
fn ecids(conn: &Connection, ids: &[String]) -> rusqlite::Result<Value> {
    if ids.is_empty() {
        return Ok(json!({}));
    }
    let rows=query(conn,&format!("SELECT ad.app_id AS app_id, d.ecid AS ecid FROM app_devices ad JOIN devices d ON d.id = ad.device_id WHERE ad.app_id IN ({}) AND d.ecid IS NOT NULL AND d.ecid != ''",vec!["?";ids.len()].join(",")),&ids.iter().cloned().map(SqlValue::Text).collect::<Vec<_>>())?;
    let mut out = Map::new();
    for r in rows {
        let list = out
            .entry(text(&r["app_id"]).to_owned())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap();
        if !list.contains(&r["ecid"]) {
            list.push(r["ecid"].clone());
        }
    }
    Ok(js_keyed_object(out.into_iter().collect()))
}
pub(super) fn queue(conn: &Connection, scope: &Scope, count_only: bool, now: i64) -> Result<Value> {
    let user = safe(verdicts(conn, false), Map::new(), "getUserVerdictsByAppId");
    let imported = safe(
        verdicts(conn, true),
        Map::new(),
        "getImportedVerdictsByAppId",
    );
    let allowed = scope.allowed(conn);
    let union: HashSet<_> = user
        .keys()
        .chain(imported.keys())
        .filter(|id| allowed.as_ref().map_or(true, |set| set.contains(*id)))
        .collect();
    let count = union.len();
    if count_only {
        return Ok(json!({"reviewableCount":count}));
    }
    // Use the scoped SQL inside the getAllApps safe boundary. If the scoped
    // read fails, it degrades to [] rather than silently widening the fleet.
    let apps = safe(
        super::apps::get_all_apps_scoped(conn, scope),
        vec![],
        "getAllApps",
    );
    let badge_result = (|| -> rusqlite::Result<Value> {
        let ids = query(conn, "SELECT id FROM apps", &[])?
            .iter()
            .map(|a| text(&a["id"]).to_owned())
            .collect::<Vec<_>>();
        super::grid_meta::get_profile_badges_by_app(conn, &ids)
    })();
    let badges = safe(badge_result, json!({}), "getProfileBadgesByApp");
    let candidates = safe(shortlists(conn), Map::new(), "shortlist");
    let mut rows = Vec::new();
    for a in &apps {
        let id = text(&a["id"]);
        let own = user.get(id).cloned().unwrap_or(Value::Null);
        let imp = imported.get(id).cloned().unwrap_or(json!([]));
        if own.is_null() && imp.as_array().unwrap().is_empty() {
            continue;
        }
        let notes = safe(
            annotations(conn, id, now),
            vec![],
            &format!("listAnnotations {id}"),
        );
        rows.push(json!({
"id":a["id"],
"name":a["name"],
"developer":a["developer"],
"iconUrl":a["iconUrl"],
"bundleId":a["bundleId"],
"url":a["url"],
"profileBadge":badges.get(id).unwrap_or(&Value::Null),
"shortlistCandidates":candidates.get(id).cloned().unwrap_or(json!([])),
"notes":notes,
"userVerdict":own,
"importedVerdicts":imp}));
    }
    let uninstall = rows
        .iter()
        .filter(|r| r["userVerdict"]["verdict"] == "uninstall")
        .map(|r| text(&r["id"]).to_owned())
        .collect::<Vec<_>>();
    let source_ecids = safe(ecids(conn, &uninstall), json!({}), "getDeviceEcidsForApps");
    Ok(json!({
"rows":rows,
"sourceDeviceEcids":source_ecids,
"rowCount":rows.len(),
"reviewableCount":count,
"total":apps.len()}))
}

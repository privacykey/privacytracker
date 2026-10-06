//! Saved review decisions shared by the desktop and server dashboards.
use super::{
    scope::Scope,
    settings::get_setting_with,
    stats::{number, query, text},
};
use rusqlite::{types::Value as Sql, Connection};
use serde_json::{json, Value};

pub(super) fn tokens(conn: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    let mut result = Vec::new();
    for row in query(conn, "SELECT t.identifier AS kind, c.identifier AS category, d.title AS item FROM privacy_types t LEFT JOIN privacy_categories c ON c.type_id = t.id LEFT JOIN privacy_data_types d ON d.category_id = c.id WHERE t.app_id = ?", &[Sql::Text(id.into())])? {
        let mut items = vec![json!([row["kind"]]).to_string()];
        if !row["category"].is_null() { items.push(json!([row["kind"],row["category"]]).to_string()); }
        if !row["item"].is_null() { items.push(json!([row["kind"],row["category"],row["item"]]).to_string()); }
        for item in items { if !result.contains(&item) { result.push(item); } }
    }
    Ok(result)
}
pub(super) fn acceptance(conn: &Connection, id: &str) -> rusqlite::Result<Value> {
    Ok(json!({"profile":get_setting_with(conn,"privacy_profile", "")?, "tokens":tokens(conn,id)?}))
}
pub(super) fn accepted(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    accepted_with_collections(conn, id, None)
}
fn collection_map(
    conn: &Connection,
) -> rusqlite::Result<std::collections::HashMap<String, Vec<String>>> {
    let mut map = std::collections::HashMap::<String, Vec<String>>::new();
    for row in query(conn,"SELECT t.app_id AS appId, t.identifier AS kind, c.identifier AS category, d.title AS item FROM privacy_types t LEFT JOIN privacy_categories c ON c.type_id = t.id LEFT JOIN privacy_data_types d ON d.category_id = c.id WHERE EXISTS (SELECT 1 FROM app_settings s WHERE s.key = 'review.accept.' || t.app_id)", &[])? {
        let items = map.entry(text(&row["appId"]).to_string()).or_default();
        items.push(json!([row["kind"]]).to_string());
        if !row["category"].is_null() {items.push(json!([row["kind"],row["category"]]).to_string());}
        if !row["item"].is_null() {items.push(json!([row["kind"],row["category"],row["item"]]).to_string());}
    }
    Ok(map)
}
fn accepted_with_collections(
    conn: &Connection,
    id: &str,
    collections: Option<&std::collections::HashMap<String, Vec<String>>>,
) -> rusqlite::Result<bool> {
    let own = query(
        conn,
        "SELECT verdict FROM app_verdicts WHERE app_id = ? AND source = 'user'",
        &[Sql::Text(id.into())],
    )?;
    if own.first().is_none_or(|r| r["verdict"] != "safe") {
        return Ok(false);
    }
    let saved: Value =
        serde_json::from_str(&get_setting_with(conn, &format!("review.accept.{id}"), "")?)
            .unwrap_or(Value::Null);
    let Some(baseline) = saved["tokens"].as_array() else {
        return Ok(false);
    };
    Ok(
        saved["profile"] == get_setting_with(conn, "privacy_profile", "")?
            && collections
                .map(|m| m.get(id).cloned().unwrap_or_default())
                .map(Ok)
                .unwrap_or_else(|| tokens(conn, id))?
                .iter()
                .all(|token| baseline.contains(&json!(token))),
    )
}
pub(super) fn deferred(conn: &Connection, id: &str) -> rusqlite::Result<Option<i64>> {
    Ok(get_setting_with(conn, &format!("review.defer.{id}"), "")?
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991))
}

pub(super) fn decisions(conn: &Connection, scope: &Scope, now: i64) -> rusqlite::Result<Value> {
    let apps = query(
        conn,
        &format!(
            "SELECT a.id FROM apps a {} ORDER BY a.id",
            scope.fragment("WHERE", "a.id")
        ),
        &scope.params(),
    )?;
    let collections = collection_map(conn)?;
    let mut accepted_ids = Vec::new();
    let mut deferred_ids = Vec::new();
    let mut reopened_ids = Vec::new();
    for app in apps {
        let id = text(&app["id"]);
        let is_accepted = accepted_with_collections(conn, id, Some(&collections))?;
        let until = deferred(conn, id)?;
        if is_accepted {
            accepted_ids.push(id.to_string());
        }
        if until.is_some_and(|n| n > now) {
            deferred_ids.push(id.to_string());
        }
        if until.is_some_and(|n| n <= now) || (!get_setting_with(conn,&format!("review.accept.{id}"), "")?.is_empty() && !is_accepted && !query(conn,"SELECT id FROM app_verdicts WHERE app_id = ? AND source = 'user' AND verdict = 'safe'", &[Sql::Text(id.into())])?.is_empty()) {reopened_ids.push(id.to_string());}
    }
    Ok(
        json!({"acceptedAppIds":accepted_ids,"deferredAppIds":deferred_ids,"reopenedAppIds":reopened_ids}),
    )
}
pub(super) fn overview(
    conn: &Connection,
    scope: &Scope,
    since: Option<i64>,
    now: i64,
) -> rusqlite::Result<Value> {
    let rows = query(conn,&format!("SELECT a.id, a.name, a.iconUrl, a.changeCount, (SELECT MAX(scraped_at) FROM privacy_snapshots WHERE app_id = a.id AND changes_detected = 1 AND COALESCE(source, 'live') = 'live') AS changedAt, (SELECT verdict FROM app_verdicts WHERE app_id = a.id AND source = 'user') AS verdict FROM apps a {} ORDER BY a.name, a.id",scope.fragment("WHERE", "a.id")), &scope.params())?;
    let collections = collection_map(conn)?;
    let mut apps = Vec::new();
    let mut due = 0;
    let mut replacements = 0;
    for row in &rows {
        let id = text(&row["id"]);
        let until = deferred(conn, id)?;
        if until.is_some_and(|n| n <= now) {
            due += 1;
        }
        if row["verdict"] == "replace" {
            replacements += 1;
        }
        let decision = if until.is_some_and(|n| n <= now) {
            "due"
        } else if until.is_some() {
            "later"
        } else if row["verdict"] == "safe"
            && accepted_with_collections(conn, id, Some(&collections))?
        {
            "kept"
        } else if row["verdict"] == "replace" || row["verdict"] == "uninstall" {
            text(&row["verdict"])
        } else {
            "review"
        };
        apps.push(json!({"id":row["id"], "name":row["name"], "iconUrl":row["iconUrl"], "changeCount":row["changeCount"], "decision":decision, "remindAt":until}));
    }
    apps.sort_by_key(|a| {
        if a["remindAt"].as_i64().is_some_and(|n| n <= now) {
            0
        } else if a["decision"] == "replace" {
            1
        } else if number(&a["changeCount"]) > 0 {
            2
        } else {
            3
        }
    });
    apps.truncate(8);
    Ok(
        json!({"apps": apps, "pendingChanges": rows.iter().filter(|r| number(&r["changeCount"]) > 0).count(), "newChanges": since.map(|s| rows.iter().filter(|r| number(&r["changedAt"]) > s).count()), "dueCount": due, "replacementCount": replacements}),
    )
}

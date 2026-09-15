//! Dashboard triage, age summary and the entry-level universal changelog.
use super::{
    scope::Scope,
    stats::{number, parse_json, query, text, truthy, Result, DAY},
};
use crate::jsstr::is_js_whitespace;
use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{json, Value};

pub(super) fn rating_min_age(raw: &str) -> Option<i64> {
    // /(\d+)\s*\+/ takes precedence over /\+\s*(\d+)/, even when the
    // latter appears earlier. ASCII digits and JS whitespace are intentional.
    let chars: Vec<char> = raw.chars().collect();
    let digits = |start: usize| {
        let mut end = start;
        while end < chars.len() && chars[end].is_ascii_digit() {
            end += 1;
        }
        (end, chars[start..end].iter().collect::<String>())
    };
    let valid = |s: String| s.parse::<i64>().ok().filter(|n| *n > 0 && *n < 100);
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let (end, s) = digits(i);
            let mut next = end;
            while next < chars.len() && is_js_whitespace(chars[next]) {
                next += 1;
            }
            if chars.get(next) == Some(&'+') {
                return valid(s);
            }
            i = end;
        } else {
            i += 1;
        }
    }
    for i in 0..chars.len() {
        if chars[i] != '+' {
            continue;
        }
        let mut start = i + 1;
        while start < chars.len() && is_js_whitespace(chars[start]) {
            start += 1;
        }
        let (end, s) = digits(start);
        if end > start {
            return valid(s);
        }
    }
    None
}
pub(super) fn age_summary(conn: &Connection) -> Result<Value> {
    let raw = super::settings::get_setting_with(conn, "guardian_child_age_band", "")?;
    let cap = match raw.as_str() {
        "under_9" => 4,
        "9_12" => 9,
        "13_15" => 13,
        "16_17" => 16,
        "18_plus" => 99,
        _ => return Ok(json!({"band":null,"count":0})),
    };
    let count = query(
        conn,
        "SELECT ageRating FROM apps WHERE ageRating IS NOT NULL",
        &[],
    )?
    .iter()
    .filter(|r| rating_min_age(text(&r["ageRating"])).is_some_and(|n| n > cap))
    .count();
    Ok(json!({"band":raw,"count":count}))
}
fn top_change(entries: &[Value]) -> Option<Value> {
    if entries.is_empty() {
        return Some(Value::Null);
    }
    let top = entries
        .iter()
        .find(|e| e["type"] == "added")
        .or_else(|| entries.iter().find(|e| e["type"] == "removed"))
        .unwrap_or(&entries[0]);
    top.get("description").cloned()
}
fn set_top(row: &mut Value, top: Option<Value>) {
    if let Some(top) = top {
        row["topChange"] = top;
    }
}
fn entries(raw: &Value) -> Result<Vec<Value>> {
    let parsed = if truthy(raw) {
        parse_json(raw).unwrap_or(json!([]))
    } else {
        json!([])
    };
    let list = parsed.as_array().ok_or("changes is not an array")?;
    if list.iter().any(Value::is_null) {
        return Err("null change".into());
    }
    Ok(list.clone())
}
fn stripped(mut v: Value) -> Value {
    let m = v.as_object_mut().unwrap();
    m.shift_remove("changeCount");
    m.shift_remove("acknowledgedAt");
    v
}
pub(super) fn empty_triage() -> Value {
    json!({
"changesThisWeek":0,
"higherRisk":[],
"highRiskCount":0,
"lastSyncedAt":0,
"moderateRiskCount":0,
"quiet":true,
"recentActivity":[],
"reviewable":[],
"stale":[],
"staleCount":0,
"totalApps":0,
"totalCategories":0})
}
pub(super) fn triage(conn: &Connection, scope: &Scope, now: i64) -> Result<Value> {
    let rows=query(conn,&format!("SELECT a.id, a.name, a.iconUrl, a.developer, a.lastSynced, a.changeCount, a.changes_acknowledged_at,
      (SELECT COUNT(c.id) FROM privacy_categories c JOIN privacy_types t ON c.type_id=t.id WHERE t.app_id=a.id) AS categoryCount,
      (SELECT COUNT(c.id) FROM privacy_categories c JOIN privacy_types t ON c.type_id=t.id WHERE t.app_id=a.id AND t.identifier='DATA_USED_TO_TRACK_YOU') AS trackCount,
      (SELECT COUNT(c.id) FROM privacy_categories c JOIN privacy_types t ON c.type_id=t.id WHERE t.app_id=a.id AND t.identifier='DATA_LINKED_TO_YOU') AS linkedCount,
      (SELECT COUNT(c.id) FROM privacy_categories c JOIN privacy_types t ON c.type_id=t.id WHERE t.app_id=a.id AND t.identifier='DATA_NOT_LINKED_TO_YOU') AS unlinkedCount
      FROM apps a {} ORDER BY a.name ASC",scope.fragment("WHERE","a.id")),&scope.params())?;
    let apps: Vec<_>=rows.iter().map(|r| {
        let t=number(&r["trackCount"]);let l=number(&r["linkedCount"]);let u=number(&r["unlinkedCount"]);
        json!({
"id":r["id"],
"name":r["name"],
"iconUrl":r["iconUrl"],
"developer":r["developer"],
"lastSynced":r["lastSynced"],
"categoryCount":r["categoryCount"],
"trackCount":r["trackCount"],
"linkedCount":r["linkedCount"],
"unlinkedCount":r["unlinkedCount"],
"riskScore":t*10+l*3+u,
"riskLevel":if t>=1 {"high"} else if l>=3 {"moderate"} else if l>=1 || u>=1 {"low"} else {"minimal"},
"changeCount":number(&r["changeCount"]),
"acknowledgedAt":number(&r["changes_acknowledged_at"])})
    }).collect();
    let total_categories: i64 = apps.iter().map(|a| number(&a["categoryCount"])).sum();
    let high = apps.iter().filter(|a| a["riskLevel"] == "high").count();
    let moderate = apps.iter().filter(|a| a["riskLevel"] == "moderate").count();
    let stale_count = apps
        .iter()
        .filter(|a| now - number(&a["lastSynced"]) > 30 * DAY)
        .count();
    let last = apps
        .iter()
        .map(|a| number(&a["lastSynced"]))
        .max()
        .unwrap_or(0)
        .max(0);
    let mut reviewable = Vec::new();
    for app in &apps {
        if number(&app["changeCount"]) <= 0 {
            continue;
        }
        let snapshot=query(conn,"SELECT scraped_at, changes_summary FROM privacy_snapshots WHERE app_id = ? AND changes_detected = 1 AND scraped_at > ? ORDER BY scraped_at DESC LIMIT 1",&[super::row::to_sql_value(&app["id"]),super::row::to_sql_value(&app["acknowledgedAt"])])?;
        let mut row = app.clone();
        let mut categories = Vec::new();
        let mut top = Some(Value::Null);
        row["lastChangeAt"] = snapshot
            .first()
            .map(|s| s["scraped_at"].clone())
            .unwrap_or_else(|| app["lastSynced"].clone());
        if let Some(s) = snapshot.first() {
            if let Ok(entries) = entries(&s["changes_summary"]) {
                top = top_change(&entries);
                for cat in ["privacy-label", "accessibility", "privacy-policy"] {
                    if entries
                        .iter()
                        .any(|e| e["category"].as_str().unwrap_or("privacy-label") == cat)
                    {
                        categories.push(cat);
                    }
                }
            }
        }
        set_top(&mut row, top);
        row["categories"] = json!(categories);
        reviewable.push(row);
    }
    reviewable.sort_by_key(|a| std::cmp::Reverse(number(&a["lastChangeAt"])));
    let quiet = reviewable.is_empty() && stale_count == 0 && !apps.is_empty();
    reviewable.truncate(6);
    let mut higher: Vec<_> = apps
        .iter()
        .filter(|a| a["riskLevel"] == "high" || a["riskLevel"] == "moderate")
        .cloned()
        .collect();
    higher.sort_by_key(|a| std::cmp::Reverse(number(&a["riskScore"])));
    higher.truncate(6);
    let mut stale: Vec<_> = apps
        .iter()
        .filter(|a| now - number(&a["lastSynced"]) > 30 * DAY)
        .cloned()
        .collect();
    stale.sort_by_key(|a| number(&a["lastSynced"]));
    stale.truncate(6);
    let mut params = vec![SqlValue::Integer(now - 7 * DAY)];
    params.extend(scope.params());
    let week=query(conn,&format!("SELECT ps.app_id, ps.scraped_at, ps.changes_summary, a.name, a.iconUrl FROM privacy_snapshots ps JOIN apps a ON a.id=ps.app_id WHERE ps.changes_detected=1 AND ps.scraped_at > ? {} ORDER BY ps.scraped_at DESC LIMIT 8",scope.fragment("AND","a.id")),&params)?;
    let mut changes_week = 0;
    let mut activity = Vec::new();
    for row in week {
        let entries = entries(&row["changes_summary"])?;
        changes_week += entries.len();
        let mut out = json!({
"appId":row["app_id"],
"appName":row["name"],
"iconUrl":row["iconUrl"],
"scrapedAt":row["scraped_at"],
"addedCount":entries.iter().filter(|e|e["type"]=="added").count(),
"removedCount":entries.iter().filter(|e|e["type"]=="removed").count(),
"modifiedCount":entries.iter().filter(|e|e["type"]=="modified").count()});
        set_top(&mut out, top_change(&entries));
        activity.push(out);
    }
    Ok(json!({
"totalApps":apps.len(),
"totalCategories":total_categories,
"highRiskCount":high,
"moderateRiskCount":moderate,
"staleCount":stale_count,
"lastSyncedAt":last,
"changesThisWeek":changes_week,
"reviewable":reviewable,
"higherRisk":higher.into_iter().map(stripped).collect::<Vec<_>>(),
"stale":stale.into_iter().map(stripped).collect::<Vec<_>>(),
"recentActivity":activity,
"quiet":quiet}))
}

pub(super) fn universal_changelog(
    conn: &Connection,
    q: &super::routes_stats::Params,
) -> Result<Value> {
    use super::routes_stats::{get, nonnegative_int};
    let limit = nonnegative_int(get(q, "limit"))
        .unwrap_or(100.0)
        .clamp(1.0, 500.0) as usize;
    let offset = nonnegative_int(get(q, "offset")).unwrap_or(0.0) as usize;
    let mut clauses = vec!["s.changes_detected > 0"];
    let mut params = Vec::new();
    for (key, clause) in [("from", "s.scraped_at >= ?"), ("to", "s.scraped_at <= ?")] {
        if let Some(n) = nonnegative_int(get(q, key)) {
            clauses.push(clause);
            params.push(SqlValue::Real(n));
        }
    }
    if let Some(id) = get(q, "appId").filter(|s| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }) {
        clauses.push("s.app_id = ?");
        params.push(SqlValue::Text(id.into()));
    }
    params.push(SqlValue::Integer((limit * 8).min(4000) as i64));
    let candidates=query(conn,&format!("SELECT s.id AS snapshot_id, s.app_id, a.name, a.iconUrl, a.developer, s.scraped_at, s.changes_summary, s.source, s.triggered_by FROM privacy_snapshots s JOIN apps a ON a.id=s.app_id WHERE {} ORDER BY s.scraped_at DESC LIMIT ?",clauses.join(" AND ")),&params)?;
    let csv = |raw: Option<&str>, valid: &[&str]| {
        raw.unwrap_or("")
            .split(',')
            .map(|s| s.trim_matches(is_js_whitespace))
            .filter(|s| valid.contains(s))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let types = csv(
        get(q, "type"),
        &["added", "removed", "modified", "policy", "wayback"],
    );
    let categories = csv(
        get(q, "category"),
        &[
            "privacy-label",
            "privacy-policy",
            "wayback-attempt",
            "accessibility",
        ],
    );
    let mut all = Vec::new();
    for r in candidates {
        let entries = if truthy(&r["changes_summary"]) {
            match parse_json(&r["changes_summary"]) {
                Ok(v) => v,
                Err(_) => continue,
            }
        } else {
            json!([])
        };
        // Node's index loop skips objects/numbers with no length; null throws.
        if entries.is_null() {
            return Err("null changes".into());
        }
        let Some(entries) = entries.as_array() else {
            continue;
        };
        for (i, entry) in entries.iter().enumerate() {
            if (!types.is_empty() || !categories.is_empty()) && entry.is_null() {
                return Err("null change".into());
            }
            if !types.is_empty() && !types.iter().any(|t| entry["type"] == *t) {
                continue;
            }
            let category = entry["category"].as_str().unwrap_or("privacy-label");
            if !categories.is_empty() && !categories.iter().any(|c| c == category) {
                continue;
            }
            all.push(json!({
"id":format!("{}:{i}",text(&r["snapshot_id"])),
"appId":r["app_id"],
"appName":r["name"],
"appIconUrl":r["iconUrl"],
"appDeveloper":r["developer"],
"scrapedAt":r["scraped_at"],
"source":if r["source"]=="wayback" {"wayback"} else {"live"},
"triggeredBy":super::changelog::normalize_trigger(r["triggered_by"].as_str(),r["source"].as_str()),
"entry":entry}));
        }
    }
    let total = all.len();
    Ok(json!({"rows":all.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":total}))
}

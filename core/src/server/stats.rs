//! Fleet aggregates. SQL order (including planner-decided ties) and object
//! insertion order deliberately follow lib/stats.ts and lib/stats-views.ts.
use super::{grid_meta, scope::Scope};
use crate::{jsdate::js_iso_string, jsstr::js_keyed_object};
use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};

pub(super) const DAY: i64 = 86_400_000;
pub(super) type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub(super) fn query(
    conn: &Connection,
    sql: &str,
    params: &[SqlValue],
) -> rusqlite::Result<Vec<Value>> {
    conn.prepare(sql)?
        .query_map(rusqlite::params_from_iter(params), super::row::row_to_json)?
        .collect()
}
pub(super) fn metadata() -> Value {
    serde_json::from_str(include_str!("stats_meta.json")).expect("generated metadata")
}
pub(super) fn number(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}
pub(super) fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(super) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub(super) fn parse_json(v: &Value) -> std::result::Result<Value, serde_json::Error> {
    serde_json::from_str(text(v))
}

pub(super) fn summary(conn: &Connection, scope: &Scope, now: i64) -> Result<Value> {
    let p = scope.params();
    let apps = |prefix| scope.fragment(prefix, "apps.id");
    let count = |sql: String, params: &[SqlValue]| -> rusqlite::Result<Value> {
        conn.query_row(&sql, rusqlite::params_from_iter(params), |r| {
            super::row::column(r, "c")
        })
    };
    let total_apps = count(
        format!("SELECT COUNT(*) as c FROM apps{}", apps("WHERE")),
        &p,
    )?;
    let cats = scope.by_id("AND", "pt2.app_id");
    let total_categories = count(format!("SELECT COUNT(*) as c FROM privacy_categories pc JOIN privacy_types pt2 ON pt2.id = pc.type_id WHERE pc.type_id IS NOT NULL{cats}"), &p)?;
    let unique = count(format!("SELECT COUNT(DISTINCT pc.identifier) as c FROM privacy_categories pc JOIN privacy_types pt2 ON pt2.id = pc.type_id WHERE pc.type_id IS NOT NULL{cats}"), &p)?;
    let changed = count(
        format!(
            "SELECT COUNT(*) as c FROM apps WHERE changeCount > 0{}",
            apps("AND")
        ),
        &p,
    )?;
    let mut stale_p = vec![SqlValue::Integer(now - 30 * DAY)];
    stale_p.extend(p.clone());
    let stale = count(
        format!(
            "SELECT COUNT(*) as c FROM apps WHERE lastSynced < ?{}",
            apps("AND")
        ),
        &stale_p,
    )?;
    let syncs = count(
        format!(
            "SELECT COUNT(*) as c FROM privacy_snapshots ps{}",
            scope.by_id("WHERE", "ps.app_id")
        ),
        &p,
    )?;
    let frequency = query(conn, &format!("SELECT pc.identifier, pc.title, COUNT(DISTINCT pt.app_id) AS appCount FROM privacy_categories pc JOIN privacy_types pt ON pt.id = pc.type_id WHERE pc.type_id IS NOT NULL{} GROUP BY pc.identifier, pc.title ORDER BY appCount DESC LIMIT 15", scope.by_id("AND", "pt.app_id")), &p)?;
    let mut recent = query(conn, &format!("SELECT n.id, n.app_id, n.app_name, n.change_summary, n.created_at, n.read, a.iconUrl FROM notifications n LEFT JOIN apps a ON a.id = n.app_id {} ORDER BY n.created_at DESC LIMIT 50", scope.by_id("WHERE", "n.app_id")), &p)?;
    for row in &mut recent {
        row["change_summary"] = parse_json(&row["change_summary"])?;
    }
    let stale_list = query(conn, &format!("SELECT id, name, iconUrl, developer, url, lastSynced FROM apps WHERE lastSynced < ?{} ORDER BY lastSynced ASC LIMIT 10", apps("AND")), &stale_p)?;
    let active = grid_meta::get_privacy_profile(conn)?.is_some_and(|p| !p.is_empty());
    let mismatch_count = if active {
        grid_meta::mismatch_count(conn, scope)?
    } else {
        0
    };
    let with_a11y = count(
        format!(
            "SELECT COUNT(*) as c FROM apps WHERE hasAccessibilityLabels = 1{}",
            apps("AND")
        ),
        &p,
    )?;
    let evaluated = count(
        format!(
            "SELECT COUNT(*) as c FROM apps WHERE hasAccessibilityLabels IS NOT NULL{}",
            apps("AND")
        ),
        &p,
    )?;
    let mut coverage = query(conn, &format!("SELECT af.identifier, MIN(af.title) AS title, COUNT(DISTINCT af.app_id) AS appCount FROM accessibility_features af {} GROUP BY af.identifier ORDER BY appCount DESC, title ASC", scope.by_id("WHERE", "af.app_id")), &p)?;
    let mut a11y = Vec::new();
    for c in metadata()["accessibility"].as_array().unwrap() {
        let hit = coverage
            .iter()
            .position(|r| r["identifier"] == c["identifier"])
            .map(|i| coverage.remove(i));
        a11y.push(json!({"identifier":c["identifier"],"title":c["title"],"appCount":hit.map(|r| r["appCount"].clone()).unwrap_or(json!(0))}));
    }
    a11y.extend(coverage);
    Ok(json!({
"totalApps":total_apps,
"totalCategories":total_categories,
"totalUniqueCategories":unique,
"appsWithChanges":changed,
"staleApps":stale,
"totalSyncs":syncs,
"appsNotMatchingProfile":mismatch_count,
"profileActive":active,
"categoryFrequency":frequency,
"recentChanges":recent,
"staleAppsList":stale_list,
"appsWithAccessibilityLabels":with_a11y,
"appsEvaluatedForAccessibility":evaluated,
"accessibilityFeatureFrequency":a11y}))
}

pub(super) fn matrix(conn: &Connection) -> Result<Value> {
    let apps = query(conn, "SELECT a.id, a.name, a.iconUrl, a.developer, (SELECT COUNT(DISTINCT c.identifier) FROM privacy_categories c JOIN privacy_types t ON t.id = c.type_id WHERE t.app_id = a.id) AS categoryCount FROM apps a ORDER BY a.name COLLATE NOCASE", &[])?;
    let rows = query(conn, "SELECT t.app_id AS appId, t.identifier AS sev, c.identifier AS cat FROM privacy_categories c JOIN privacy_types t ON t.id = c.type_id", &[])?;
    let meta = metadata();
    let severities = meta["severities"].as_array().unwrap();
    let mut cells: Map<String, Value> = Map::new();
    let mut counts: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    let rank = |v: &Value| match v.as_str() {
        Some("DATA_USED_TO_TRACK_YOU") => 3,
        Some("DATA_LINKED_TO_YOU") => 2,
        Some("DATA_NOT_LINKED_TO_YOU") => 1,
        _ => 0,
    };
    for row in rows {
        if rank(&row["sev"]) == 0 {
            continue;
        }
        let id = text(&row["appId"]);
        let cat = text(&row["cat"]);
        let cell = cells
            .entry(id.to_owned())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap();
        if cell
            .get(cat)
            .map_or(true, |prev| rank(&row["sev"]) > rank(prev))
        {
            cell.insert(cat.to_owned(), row["sev"].clone());
        }
        counts
            .entry(cat.to_owned())
            .or_default()
            .insert(id.to_owned());
    }
    let mut categories = Vec::new();
    for c in meta["categories"].as_array().unwrap() {
        if let Some(ids) = counts.remove(text(&c["identifier"])) {
            categories.push(
                json!({"identifier":c["identifier"],"label":c["label"],"appCount":ids.len()}),
            );
        }
    }
    let mut extras: Vec<_> = counts.into_iter().collect();
    // JS's default Array.sort compares UTF-16 units, not UTF-8 bytes.
    extras.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    categories.extend(
        extras
            .into_iter()
            .map(|(id, ids)| json!({"identifier":id,"label":id,"appCount":ids.len()})),
    );
    let cells = js_keyed_object(
        cells
            .into_iter()
            .map(|(id, c)| {
                (
                    id,
                    js_keyed_object(c.as_object().unwrap().clone().into_iter().collect()),
                )
            })
            .collect(),
    );
    Ok(json!({
"apps":apps,
"categories":categories,
"severities":severities,
"cells":cells}))
}

pub(super) fn radar(conn: &Connection, ids: &[String]) -> Result<Value> {
    let filter = if ids.is_empty() {
        "WHERE p.summary_json IS NOT NULL ORDER BY a.lastSynced DESC, a.id ASC LIMIT 6".into()
    } else {
        format!("WHERE a.id IN ({})", vec!["?"; ids.len()].join(","))
    };
    let rows = query(conn, &format!("SELECT a.id, a.name, a.iconUrl, p.summary_json, p.status FROM apps a LEFT JOIN privacy_policy_analyses p ON p.app_id = a.id {filter}"), &ids.iter().cloned().map(SqlValue::Text).collect::<Vec<_>>())?;
    let meta = metadata();
    let mut apps = Vec::new();
    for r in rows {
        let summary = parse_json(&r["summary_json"]).unwrap_or(Value::Null);
        let lenses = if summary["lenses"].is_null() {
            vec![]
        } else {
            summary["lenses"]
                .as_array()
                .ok_or("lenses is not iterable")?
                .clone()
        };
        let mut out = Vec::new();
        for axis in meta["axes"].as_array().unwrap() {
            if lenses.iter().any(Value::is_null) {
                return Err("null lens".into());
            }
            let hit = lenses.iter().rev().find(|l| l["key"] == axis["key"]);
            let rating = hit.map(|l| l["rating"].clone()).unwrap_or(Value::Null);
            let mut lens = json!({"key":axis["key"],"label":axis["label"],"rating":rating});
            let score = match rating.as_str() {
                Some("favorable") => Some(json!(1)),
                Some("unclear") => Some(json!(1.5)),
                Some("mixed") => Some(json!(3)),
                Some("concerning") => Some(json!(4)),
                _ => None,
            };
            // Unknown truthy ratings produce undefined and omit score in Node.
            if let Some(score) = score {
                lens["score"] = score;
            } else if !truthy(&rating) {
                lens["score"] = Value::Null;
            }
            out.push(lens);
        }
        let mut app = json!({
"id":r["id"],
"name":r["name"],
"iconUrl":r["iconUrl"],
"lenses":out,
"hasPolicy":truthy(&summary)});
        if !r["status"].is_null() {
            app["status"] = r["status"].clone();
        }
        apps.push(app);
    }
    Ok(json!({"axes":meta["axes"],"ratings":meta["ratings"],"apps":apps}))
}

fn date_parts(ms: i64) -> (i64, i64, i64) {
    // Existing ISO helper handles the full Date range, including signed years.
    let iso = js_iso_string(ms);
    let date = iso.split('T').next().unwrap();
    let mut fields = date.rsplitn(3, '-');
    let d = fields.next().unwrap().parse().unwrap();
    let m = fields.next().unwrap().parse().unwrap();
    let y = fields.next().unwrap().parse().unwrap();
    (y, m, d)
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}
fn date_utc(y: i64, m: i64, d: i64) -> i64 {
    // Date.UTC remaps 0..99 to 1900..1999 (including weekly bucketKey).
    days_from_civil(if (0..=99).contains(&y) { y + 1900 } else { y }, m, d) * DAY
}
fn bucket_key(ms: i64, kind: &str) -> String {
    let (y, m, d) = date_parts(ms);
    if kind == "month" {
        return format!("{y}-{m:02}-01");
    }
    if kind == "week" {
        let diff = (ms.div_euclid(DAY) + 3).rem_euclid(7);
        let (y, m, d) = date_parts(date_utc(y, m, d - diff));
        return format!("{y}-{m:02}-{d:02}");
    }
    format!("{y}-{m:02}-{d:02}")
}
fn empty_point(key: &str) -> Value {
    json!({
"bucket":key,
"added":0,
"removed":0,
"modified":0,
"policy":0,
"accessibilityAdded":0,
"accessibilityRemoved":0,
"syncs":0,
"reviews":0})
}
pub(super) fn timeline(
    conn: &Connection,
    from: f64,
    to: f64,
    forced: Option<&str>,
    app_id: Option<&str>,
) -> Result<Value> {
    let kind = forced.unwrap_or(if to - from <= 14.0 * DAY as f64 {
        "day"
    } else if to - from <= 120.0 * DAY as f64 {
        "week"
    } else {
        "month"
    });
    let mut params = vec![SqlValue::Real(from), SqlValue::Real(to)];
    let filter = if let Some(id) = app_id {
        params.push(SqlValue::Text(id.to_owned()));
        "AND app_id = ?"
    } else {
        ""
    };
    let rows = query(conn,&format!("SELECT scraped_at AS ts, changes_summary AS changes FROM privacy_snapshots WHERE changes_detected = 1 AND scraped_at >= ? AND scraped_at <= ? {filter}"),&params)?;
    let syncs = query(conn,&format!("SELECT scraped_at AS ts FROM privacy_snapshots WHERE scraped_at >= ? AND scraped_at <= ? {filter}"),&params)?;
    let reviews = query(conn,&format!("SELECT acted_at AS ts FROM change_review_actions WHERE acted_at >= ? AND acted_at <= ? {filter}"),&params)?;
    let mut buckets = BTreeMap::new();
    let mut total = 0;
    for r in rows {
        let entries = if truthy(&r["changes"]) {
            match parse_json(&r["changes"]) {
                Ok(v) => v,
                Err(_) => continue,
            }
        } else {
            json!([])
        };
        let key = bucket_key(number(&r["ts"]), kind);
        let point = buckets
            .entry(key.clone())
            .or_insert_with(|| empty_point(&key));
        for e in entries.as_array().ok_or("changes is not iterable")? {
            if e.is_null() {
                return Err("null change".into());
            }
            let field = match (e["category"].as_str(), e["type"].as_str()) {
                (Some("accessibility"), Some("added")) => "accessibilityAdded",
                (Some("accessibility"), Some("removed")) => "accessibilityRemoved",
                (Some("accessibility"), _) => continue,
                (_, Some(t @ ("added" | "removed" | "modified" | "policy"))) => t,
                _ => continue,
            };
            point[field] = json!(number(&point[field]) + 1);
            total += 1;
        }
    }
    for (rows, field) in [(syncs, "syncs"), (reviews, "reviews")] {
        for r in rows {
            let key = bucket_key(number(&r["ts"]), kind);
            let point = buckets
                .entry(key.clone())
                .or_insert_with(|| empty_point(&key));
            point[field] = json!(number(&point[field]) + 1);
        }
    }
    let mut points = Vec::new();
    // Invalid Dates make Node's fill loop skip entirely, even with a forced bucket.
    if from.abs() <= 8.64e15 && to.abs() <= 8.64e15 {
        let (y, m, d) = date_parts(from as i64);
        let mut cursor = date_utc(y, m, if kind == "month" { 1 } else { d });
        if kind == "week" {
            cursor -= (cursor.div_euclid(DAY) + 3).rem_euclid(7) * DAY;
        }
        while cursor as f64 <= to {
            let key = bucket_key(cursor, kind);
            points.push(buckets.remove(&key).unwrap_or_else(|| empty_point(&key)));
            cursor = if kind == "month" {
                let (y, m, _) = date_parts(cursor);
                days_from_civil(y + i64::from(m == 12), if m == 12 { 1 } else { m + 1 }, 1) * DAY
            } else {
                cursor + if kind == "week" { 7 * DAY } else { DAY }
            };
        }
    }
    Ok(json!({
"from":crate::jsnum::js_number(from),
"to":crate::jsnum::js_number(to),
"bucketType":kind,
"points":points,
"total":total}))
}

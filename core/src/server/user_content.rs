//! Activity, notification and preference readers. SQL and wire coercions
//! follow the Node routes, including failures on malformed notification JSON.
use super::{
    flags,
    routes_stats::{get, Params},
    settings::get_setting_with,
    stats::{query, text, truthy, Result},
};
use crate::{
    jsnum::js_number,
    jsstr::{is_js_whitespace, js_keyed_object},
};
use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{json, Value};
use std::sync::OnceLock;

pub(super) fn metadata() -> &'static Value {
    static META: OnceLock<Value> = OnceLock::new();
    META.get_or_init(|| {
        serde_json::from_str(include_str!("content_meta.json")).expect("generated content metadata")
    })
}
/// JSON.parse/stringify: numeric keys enumerate first, and all numbers
/// have JS Number precision and spelling, including inside arbitrary detail.
pub(super) fn parse(raw: &str) -> Result<Value> {
    fn normalize(v: Value) -> Value {
        match v {
            Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
            Value::Array(a) => Value::Array(a.into_iter().map(normalize).collect()),
            Value::Object(m) => {
                js_keyed_object(m.into_iter().map(|(k, v)| (k, normalize(v))).collect())
            }
            v => v,
        }
    }
    Ok(normalize(serde_json::from_str(raw)?))
}
pub(super) fn integer(raw: &str) -> Option<f64> {
    let s = raw.trim_start_matches(is_js_whitespace);
    let start = usize::from(s.starts_with('+') || s.starts_with('-'));
    let n = s
        .as_bytes()
        .iter()
        .skip(start)
        .take_while(|b| b.is_ascii_digit())
        .count();
    if n == 0 {
        return None;
    }
    s[..start + n].parse::<f64>().ok().filter(|n| n.is_finite())
}
pub(super) fn activity(conn: &Connection, q: &Params) -> Result<Value> {
    let limit = integer(get(q, "limit").unwrap_or("50")).unwrap_or(50.0);
    let offset = integer(get(q, "offset").unwrap_or("0")).unwrap_or(0.0);
    let kind = get(q, "type").filter(|k| {
        metadata()["activityTypes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == k)
    });
    let status = get(q, "status").filter(|v| ["ok", "error", "partial", "cancelled"].contains(v));
    let since = get(q, "since").and_then(integer).filter(|n| *n >= 0.0);
    let until = get(q, "until").and_then(integer).filter(|n| *n >= 0.0);
    let sort = get(q, "sortBy")
        .filter(|v| ["started_at", "ended_at", "duration_ms"].contains(v))
        .unwrap_or("started_at");
    let dir = get(q, "sortDir")
        .filter(|v| ["asc", "desc"].contains(v))
        .unwrap_or("desc");
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    for (column, value) in [("type", kind), ("status", status)] {
        if let Some(v) = value {
            clauses.push(format!("{column} = ?"));
            params.push(SqlValue::Text(v.into()));
        }
    }
    for (operator, value) in [(">=", since), ("<=", until)] {
        if let Some(n) = value {
            clauses.push(format!("started_at {operator} ?"));
            params.push(SqlValue::Real(n));
        }
    }
    let filter = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let order = match (sort, dir) {
        ("duration_ms", "asc") => "COALESCE(duration_ms, 9223372036854775807) ASC, started_at DESC",
        ("duration_ms", _) => "COALESCE(duration_ms, -1) DESC, started_at DESC",
        ("ended_at", "asc") => "COALESCE(ended_at, 9223372036854775807) ASC, started_at DESC",
        ("ended_at", _) => "COALESCE(ended_at, 0) DESC, started_at DESC",
        (_, "asc") => "started_at ASC",
        _ => "started_at DESC",
    };
    let mut paged = params.clone();
    paged.extend([
        SqlValue::Real(limit.clamp(1.0, 500.0)),
        SqlValue::Real(offset.max(0.0)),
    ]);
    let rows=query(conn,&format!("SELECT id,type,status,app_id,app_name,summary,detail,started_at,ended_at,duration_ms FROM activity_log {filter} ORDER BY {order} LIMIT ? OFFSET ?"),&paged)?;
    let rows=rows.into_iter().map(|r|json!({"id":r["id"],"type":r["type"],"status":r["status"],"appId":r["app_id"],"appName":r["app_name"],"summary":r["summary"],"detail":parse(text(&r["detail"])).unwrap_or(Value::Null),"startedAt":r["started_at"],"endedAt":r["ended_at"],"durationMs":r["duration_ms"]})).collect::<Vec<_>>();
    let total = query(
        conn,
        &format!("SELECT COUNT(*) AS n FROM activity_log {filter}"),
        &params,
    )?[0]["n"]
        .clone();
    // Echo the route's unclamped inputs, while SQL uses the helper's clamp.
    Ok(
        json!({"rows":rows,"total":total,"limit":js_number(limit),"offset":js_number(offset),"type":kind,"status":status,"since":since.map(js_number),"until":until.map(js_number),"sortBy":sort,"sortDir":dir}),
    )
}
pub(super) const NOTIFICATION_TYPES: [&str; 4] = [
    "label_changes",
    "policy_updates",
    "accessibility_changes",
    "new_privacy_types",
];
pub(super) fn enabled_types(conn: &Connection) -> Result<[bool; 4]> {
    let ctx = flags::context_from_db(conn)?;
    let mut enabled = [false; 4];
    for (i, k) in NOTIFICATION_TYPES.iter().enumerate() {
        enabled[i] = flags::resolve_flag(&format!("flag.notifications.types.{k}"), &ctx)
            .map_err(|e| format!("notification flag: {e:?}"))?
            == "on";
    }
    Ok(enabled)
}
pub(super) fn notification_prefs(conn: &Connection) -> Result<Value> {
    let prefs = match enabled_types(conn) {
        Ok(enabled) => Value::Object(
            NOTIFICATION_TYPES
                .iter()
                .zip(enabled)
                .map(|(k, v)| (k.to_string(), json!(v)))
                .collect(),
        ),
        Err(_) => {
            let parsed =
                parse(&get_setting_with(conn, "notification_prefs", "")?).unwrap_or(Value::Null);
            let mut out = serde_json::Map::new();
            if let Value::Object(m) = parsed {
                for (k, v) in m {
                    if metadata()["notificationDefaults"].get(&k).is_some() && v.is_boolean() {
                        out.insert(k, v);
                    }
                }
            }
            Value::Object(out)
        }
    };
    Ok(json!({"prefs":prefs,"stored":prefs,"defaults":metadata()["notificationDefaults"]}))
}
fn empty_length(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.is_empty())
        || v.as_str().is_some_and(|s| s.is_empty())
        || v.as_object()
            .is_some_and(|m| m.get("length") == Some(&json!(0)))
}
fn filter_changes(parsed: &Value, enabled: &[bool; 4]) -> Result<Value> {
    if empty_length(parsed) {
        return Ok(parsed.clone());
    }
    let list = parsed.as_array().ok_or("change_summary must be an array")?;
    let mut out = Vec::new();
    for c in list {
        if c.is_null() {
            return Err("null notification change".into());
        }
        let details = &c["details"];
        let empty_details = empty_length(details);
        let i = if c["category"] == "privacy-policy" {
            1
        } else if c["category"] == "accessibility" {
            2
        } else if c["type"] == "added" && (!truthy(details) || empty_details) {
            3
        } else {
            0
        };
        if enabled[i] {
            out.push(c.clone());
        }
    }
    Ok(json!(out))
}
pub(super) fn notifications(conn: &Connection, now: i64) -> Result<Value> {
    let enabled = enabled_types(conn).unwrap_or([true; 4]);
    // LIMIT happens BEFORE filtering; a suppressed row is not backfilled.
    let rows=query(conn,"SELECT n.id,n.app_id,n.app_name,n.change_summary,n.created_at,n.read,n.stale,a.iconUrl FROM notifications n LEFT JOIN apps a ON a.id=n.app_id WHERE n.not_before IS NULL OR n.not_before <= ? ORDER BY n.created_at DESC LIMIT 30",&[SqlValue::Integer(now)])?;
    let mut notifications = Vec::new();
    for r in rows {
        let parsed = parse(text(&r["change_summary"]))?;
        let filtered = filter_changes(&parsed, &enabled)?;
        if empty_length(&parsed) || filtered.as_array().is_some_and(|a| !a.is_empty()) {
            notifications.push(json!({"id":r["id"],"app_id":r["app_id"],"app_name":r["app_name"],"change_summary":filtered,"created_at":r["created_at"],"read":r["read"],"stale":r["stale"],"iconUrl":r["iconUrl"]}));
        }
    }
    let unread = if enabled.iter().all(|b| *b) {
        query(conn,"SELECT COUNT(*) AS n FROM notifications WHERE read=0 AND (not_before IS NULL OR not_before <= ?)",&[SqlValue::Integer(now)])?[0]["n"].as_u64().unwrap_or(0)
    } else {
        let mut count = 0;
        for r in query(conn,"SELECT change_summary FROM notifications WHERE read=0 AND (not_before IS NULL OR not_before <= ?)",&[SqlValue::Integer(now)])? {
            // Only unread counting recovers corrupt JSON as a synthetic row.
            let parsed=parse(text(&r["change_summary"])).unwrap_or(json!([]));
            let filtered=filter_changes(&parsed,&enabled)?;
            if empty_length(&parsed) || filtered.as_array().is_some_and(|a|!a.is_empty()) {count+=1;}
        }
        count
    };
    Ok(json!({"notifications":notifications,"unreadCount":unread}))
}

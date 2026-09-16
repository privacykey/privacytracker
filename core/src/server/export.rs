//! Whole-install JSON and spreadsheet CSV, matching app/api/export/route.ts.
use super::{
    apps,
    stats::{query, text, truthy, Result},
};
use crate::{jsdate::js_iso_string, jsstr::is_js_whitespace};
use rusqlite::Connection;
use serde_json::{json, Value};

pub(super) fn full_json(conn: &Connection, now: i64) -> Result<Value> {
    let full = apps::get_all_apps(conn)?
        .iter()
        .map(|a| apps::get_app_with_privacy(conn, text(&a["id"])))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({"exported_at":js_iso_string(now),"apps":full}))
}

fn escape(text: &str) -> String {
    let prefix = text.starts_with(['\t', '\r', '\n'])
        || text
            .chars()
            .find(|c| !is_js_whitespace(*c) && (*c as u32) >= 32 && *c != '\u{7f}')
            .is_some_and(|c| "=+-@＝＋－＠".contains(c));
    format!(
        "\"{}{}\"",
        if prefix { "\t" } else { "" },
        text.replace('"', "\"\"")
    )
}

pub(super) fn csv(conn: &Connection) -> Result<String> {
    let rows = query(conn,"SELECT a.name AS app_name,a.developer,a.url,a.lastSynced,pt.title AS privacy_type,pc.title AS category FROM apps a LEFT JOIN privacy_types pt ON pt.app_id=a.id LEFT JOIN privacy_categories pc ON pc.type_id=pt.id ORDER BY a.name,pt.identifier,pc.identifier", &[])?;
    let mut lines = vec![[
        "App Name",
        "Developer",
        "URL",
        "Last Synced",
        "Privacy Type",
        "Category",
    ]
    .map(escape)
    .join(",")];
    for r in rows {
        let date = if truthy(&r["lastSynced"]) {
            let ms = if let Some(raw) = r["lastSynced"].as_str() {
                crate::jsdate::parse(raw).ok_or("invalid export date")? as f64
            } else {
                r["lastSynced"].as_f64().ok_or("invalid export date")?
            };
            if ms.abs() > 8_640_000_000_000_000.0 {
                return Err("invalid export date".into());
            }
            js_iso_string(ms as i64)
                .split('T')
                .next()
                .unwrap()
                .to_owned()
        } else {
            String::new()
        };
        lines.push(
            [
                text(&r["app_name"]),
                text(&r["developer"]),
                text(&r["url"]),
                &date,
                text(&r["privacy_type"]),
                text(&r["category"]),
            ]
            .map(escape)
            .join(","),
        );
    }
    Ok(lines.join("\n"))
}

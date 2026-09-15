//! Grouped alternatives and the whole-install Markdown export.
use super::{
    grid_meta, review,
    scope::Scope,
    stats::{query, text, Result},
};
use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;

fn snapshot(conn: &Connection, id: &str) -> rusqlite::Result<Vec<Value>> {
    query(
        conn,
        "SELECT * FROM privacy_types WHERE app_id = ?",
        &[SqlValue::Text(id.into())],
    )?
    .into_iter()
    .map(|t| {
        let categories = query(
            conn,
            "SELECT * FROM privacy_categories WHERE type_id = ?",
            &[super::row::to_sql_value(&t["id"])],
        )?
        .into_iter()
        .map(|c| json!({"identifier":c["identifier"],"title":c["title"]}))
        .collect::<Vec<_>>();
        Ok(json!({"identifier":t["identifier"],"title":t["title"],"categories":categories}))
    })
    .collect()
}
pub(super) fn groups(conn: &Connection, scope: &Scope) -> Result<Vec<Value>> {
    let rows = query(conn, &format!("SELECT s.*, CASE WHEN t.id IS NULL THEN 0 ELSE 1 END AS candidate_is_tracked, t.priceFormatted AS candidate_price_formatted, t.priceCurrency AS candidate_price_currency, t.hasIap AS candidate_has_iap, a.name AS source_name, a.iconUrl AS source_icon, a.developer AS source_developer, a.priceFormatted AS source_price_formatted, a.priceCurrency AS source_price_currency, a.hasIap AS source_has_iap FROM shortlist_entries s JOIN apps a ON a.id = s.source_app_id LEFT JOIN apps t ON t.id = s.candidate_apple_id{} ORDER BY s.added_at DESC",scope.fragment("WHERE","a.id")), &scope.params())?;
    let (badges, mismatches) = grid_meta::shortlist_profile_maps(conn)?;
    // Vec, not a JS object: numeric app IDs must retain insertion order.
    let mut groups: Vec<Value> = Vec::new();
    let mut by_app = HashMap::new();
    for r in rows {
        let id = text(&r["source_app_id"]);
        let index = match by_app.get(id).copied() {
            Some(i) => i,
            None => {
                let mut source = json!({"id":r["source_app_id"],"name":r["source_name"],"iconUrl":r["source_icon"].as_str().unwrap_or(""),"developer":r["source_developer"].as_str().unwrap_or("")});
                if let Ok(types) = snapshot(conn, id) {
                    if !types.is_empty() {
                        source["privacyTypes"] = json!(types);
                    }
                }
                if let Some(mismatch) = mismatches.get(id) {
                    source["profileMismatch"] = mismatch.clone();
                }
                source["priceFormatted"] = r["source_price_formatted"].clone();
                source["priceCurrency"] = r["source_price_currency"].clone();
                source["hasIap"] = r["source_has_iap"].clone();
                by_app.insert(id.to_owned(), groups.len());
                groups.push(json!({"sourceApp":source,"entries":[]}));
                groups.len() - 1
            }
        };
        groups[index]["entries"]
            .as_array_mut()
            .unwrap()
            .push(review::shortlist_entry(&r, &badges));
    }
    Ok(groups)
}
pub(super) fn list(conn: &Connection, scope: &Scope) -> Result<Value> {
    let groups = groups(conn, scope)?;
    let pairs = query(
        conn,
        "SELECT source_app_id,candidate_apple_id FROM shortlist_entries",
        &[],
    )?
    .into_iter()
    .map(|r| json!({"sourceAppId":r["source_app_id"],"candidateAppleId":r["candidate_apple_id"]}))
    .collect::<Vec<_>>();
    let total = if scope.all() {
        query(conn, "SELECT COUNT(*) AS n FROM shortlist_entries", &[])?[0]["n"].clone()
    } else {
        json!(groups
            .iter()
            .map(|g| g["entries"].as_array().unwrap().len())
            .sum::<usize>())
    };
    Ok(json!({"groups":groups,"pairs":pairs,"total":total}))
}
pub(super) fn markdown(groups: &[Value], date: &str) -> String {
    if groups.is_empty() {
        return "# App alternatives shortlist\n\n_No alternatives shortlisted yet._\n".into();
    }
    let mut lines = vec![
        "# App alternatives shortlist".into(),
        "".into(),
        format!("_Exported {date} from privacytracker._"),
        "".into(),
    ];
    for group in groups {
        let source = &group["sourceApp"];
        let dev = text(&source["developer"]);
        lines.push(format!(
            "## Alternatives to {}{}",
            text(&source["name"]),
            if dev.is_empty() {
                String::new()
            } else {
                format!(" · {dev}")
            }
        ));
        lines.push("".into());
        for e in group["entries"].as_array().unwrap() {
            let dev = text(&e["candidateDeveloper"]);
            let modes = e["modes"]
                .as_array()
                .unwrap()
                .iter()
                .map(text)
                .collect::<Vec<_>>();
            lines.push(format!(
                "- [{}]({}){}{}{}",
                text(&e["candidateName"]),
                text(&e["candidateStoreUrl"]),
                if dev.is_empty() {
                    String::new()
                } else {
                    format!(" — {dev}")
                },
                if e["candidateIsTracked"] == true {
                    " _(tracked)_"
                } else {
                    ""
                },
                if modes == ["privacy"] {
                    String::new()
                } else {
                    format!(" _(saved for {})_", modes.join(" + "))
                }
            ));
            let note = text(&e["note"]);
            if !note.is_empty() {
                lines.push(format!("  - {note}"));
            }
        }
        lines.push("".into());
    }
    lines.join("\n")
}

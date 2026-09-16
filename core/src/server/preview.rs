//! Non-persisting comparison parser, matching lib/compare-scrape.ts. Its
//! modern-only input contract is intentionally distinct from the full scraper.
use super::stats::truthy;
use crate::{
    jsstr::{is_js_whitespace, js_length},
    outbound,
};
use serde_json::{json, Value};
use std::sync::OnceLock;

fn patterns() -> &'static Vec<regex::Regex> {
    static RE: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    RE.get_or_init(||[
        r#"<meta\s+property="og:title"\s+content="([^"]+)""#,
        r#"<meta\s+property="og:image"\s+content="([^"]+)""#,
        r#"/id([0-9]+)"#,
        r#""author"\s*:\s*\{\s*"@type"[^}]*"name"\s*:\s*"([^"]+)""#,
        r#"<a\s+([^<>]{0,2048}?)aria-label="developer[’']s privacy policy"([\s\S]{0,2048}?)href="([^"]+)""#,
        r#"<a\s+([\s\S]{0,2048}?)href="([^"]+)"([\s\S]{0,2048}?)aria-label="developer[’']s privacy policy""#,
        r#"id="notpurchasedlinks"[\s\S]*?<a\s+[^>]*?href="([^"]+)"[^>]*?>\s*privacy policy\s*</a>"#,
        r#"<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)</script>"#,
    ].iter().map(|s|regex::Regex::new(&s.replace(r"[\s\S]",r"(?s:.)").replace(r"\s",r"[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]")).unwrap()).collect())
}
fn captured(index: usize, original: &str, search: &str) -> Option<String> {
    let c = patterns()[index].captures(search)?.get(1)?;
    Some(original[c.range()].to_string())
}
pub(super) fn string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => crate::jsnum::js_number_to_string(n),
        Value::Array(a) => a.iter().map(string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
fn length(v: &Value) -> usize {
    match v {
        Value::Array(a) => a.len(),
        Value::String(s) => js_length(s),
        _ => v["length"].as_u64().unwrap_or(0) as usize,
    }
}
fn category(c: &Value) -> Result<Value, String> {
    if c.is_null() {
        return Err("Cannot read properties of null (reading 'identifier')".into());
    }
    Ok(json!({"identifier":string(&c["identifier"]),"title":string(&c["title"])}))
}
fn privacy(data: &Value) -> Result<Vec<Value>, String> {
    let map = &data[0]["data"]["shelfMapping"];
    let mut items = Value::Array(vec![]);
    // Errors while finding the shelf are swallowed by Node; errors mapping
    // the selected items are outside that catch and reach the route's 500.
    let select = (|| -> Result<(), String> {
        if length(&map["privacyTypes"]["items"]) > 0 {
            items = map["privacyTypes"]["items"].clone();
        }
        if length(&items) == 0 {
            let shelves = &map["privacyHeader"]["seeAllAction"]["pageData"]["shelves"];
            if length(shelves) > 0 {
                for shelf in shelves.as_array().ok_or("viaHeader is not iterable")? {
                    if shelf.is_null() {
                        return Err("null shelf".into());
                    }
                    if shelf["contentType"] != "privacyType" {
                        continue;
                    }
                    let empty = Vec::new();
                    let rows = if shelf["items"].is_null() {
                        &empty
                    } else {
                        shelf["items"].as_array().ok_or("items not iterable")?
                    };
                    for item in rows {
                        if item.is_null() {
                            return Err("null item".into());
                        }
                        if length(&item["categories"]) > 0 {
                            items.as_array_mut().unwrap().push(item.clone());
                        } else if length(&item["purposes"]) > 0 {
                            let mut categories: Vec<(Value, Value)> = vec![];
                            for p in item["purposes"].as_array().ok_or("purposes not iterable")? {
                                if p.is_null() {
                                    return Err("null purpose".into());
                                }
                                let empty = Vec::new();
                                for c in if p["categories"].is_null() {
                                    &empty
                                } else {
                                    p["categories"]
                                        .as_array()
                                        .ok_or("categories not iterable")?
                                } {
                                    if c.is_null() {
                                        return Err("null category".into());
                                    }
                                    let id = c["identifier"].clone();
                                    if !categories.iter().any(|(key, _)| *key == id) {
                                        categories.push((id,json!({"identifier":c["identifier"],"title":c["title"]})));
                                    }
                                }
                            }
                            let mut normalized = item.clone();
                            normalized["categories"] =
                                Value::Array(categories.into_iter().map(|(_, v)| v).collect());
                            items.as_array_mut().unwrap().push(normalized);
                        }
                    }
                }
            }
        }
        if length(&items) == 0 {
            let shelves = &data[0]["data"]["pageData"]["shelves"];
            if length(shelves) > 0 {
                for shelf in shelves.as_array().ok_or("shelves not iterable")? {
                    if shelf.is_null() {
                        return Err("null shelf".into());
                    }
                    if shelf["contentType"] == "privacyType" {
                        if shelf["items"].is_null() {
                            continue;
                        }
                        items.as_array_mut().unwrap().extend(
                            shelf["items"]
                                .as_array()
                                .ok_or("items not iterable")?
                                .clone(),
                        );
                    }
                }
            }
        }
        Ok(())
    })();
    if let Err(e) = select {
        super::diag::log_error(format!(
            "[compare] Could not extract privacy data from raw JSON {e}"
        ));
    }
    items.as_array().ok_or("privacyItems.map is not a function")?.iter().map(|item|{
        if item.is_null(){return Err("Cannot read properties of null (reading 'identifier')".into());}
        let empty=vec![];
        let cats=if item["categories"].is_null(){&empty}else{item["categories"].as_array().ok_or("(item.categories ?? []).map is not a function")?};
        Ok(json!({"identifier":string(&item["identifier"]),"title":string(&item["title"]),"categories":cats.iter().map(category).collect::<Result<Vec<_>,_>>()?}))
    }).collect()
}
fn normalize_features(raw: &[Value]) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for f in raw {
        let Some(title) = f["title"]
            .as_str()
            .map(|s| s.trim_matches(is_js_whitespace))
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let mut slug = String::new();
        for c in title.to_lowercase().chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                slug.push(c);
            } else if !slug.ends_with('_') {
                slug.push('_');
            }
        }
        let id = slug.trim_matches('_').chars().take(64).collect::<String>();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let description = f["description"]
            .as_str()
            .map(|s| s.trim_matches(is_js_whitespace))
            .filter(|s| !s.is_empty());
        let icon = f["artwork"]["template"].as_str().filter(|s| !s.is_empty());
        out.push(
            json!({"identifier":id,"title":title,"description":description,"iconTemplate":icon}),
        );
    }
    out
}
fn accessibility(data: &Value) -> Option<Vec<Value>> {
    let map = &data[0]["data"]["shelfMapping"];
    if !map.is_object() && !map.is_array() {
        return None;
    }
    if let Some(shelves) =
        map["accessibilityHeader"]["seeAllAction"]["pageData"]["shelves"].as_array()
    {
        for shelf in shelves {
            if shelf["contentType"] != "accessibilityFeatures" {
                continue;
            }
            if let Some(items) = shelf["items"].as_array() {
                for item in items {
                    if let Some(f) = item["features"].as_array() {
                        return Some(normalize_features(f));
                    }
                }
            }
        }
    }
    if let Some(items) = map["accessibilityFeatures"]["items"].as_array() {
        for item in items {
            if let Some(f) = item["features"].as_array() {
                return Some(normalize_features(f));
            }
        }
    }
    if truthy(&map["accessibilityHeader"]) {
        Some(vec![])
    } else {
        None
    }
}
pub(super) fn parse(html: &str, url: &str) -> Result<Value, String> {
    let lower = html.to_ascii_lowercase();
    let mut name = captured(0, html, &lower)
        .map(|mut s| {
            if s.to_ascii_lowercase().ends_with(" on the app store") {
                s.truncate(s.len() - 17);
            }
            s.trim_matches(is_js_whitespace).to_string()
        })
        .unwrap_or("Unknown App".into());
    let icon = captured(1, html, &lower).unwrap_or_default();
    let id = captured(2, url, &url.to_ascii_lowercase()).unwrap_or_default();
    let developer = captured(3, html, html).unwrap_or_default();
    let mut policy = None;
    for (index, before, after, value) in [(4, 1, 2, 3), (5, 1, 3, 2)] {
        if policy.is_some() {
            break;
        }
        for caps in patterns()[index].captures_iter(&lower) {
            if js_length(caps.get(before).unwrap().as_str()) <= 2048
                && js_length(caps.get(after).unwrap().as_str()) <= 2048
            {
                policy = Some(html[caps.get(value).unwrap().range()].to_string());
                break;
            }
        }
    }
    let policy = outbound::sanitize_policy(
        &policy
            .or_else(|| captured(6, html, &lower))
            .unwrap_or_default(),
    );
    let script = captured(7, html, html)
        .ok_or("No serialized-server-data script found in App Store page")?;
    let raw = super::user_content::parse(&script)
        .map_err(|_| "Failed to parse serialized-server-data JSON")?;
    if raw.is_null() {
        return Err("Failed to parse serialized-server-data JSON".into());
    }
    let data = if raw.is_array() {
        raw
    } else {
        raw["data"].clone()
    };
    let title = &data[0]["data"]["title"];
    if truthy(title) {
        name = title
            .as_str()
            .ok_or("jsonTitle.trim is not a function")?
            .trim_matches(is_js_whitespace)
            .to_string();
    }
    let types = privacy(&data)?;
    let features = accessibility(&data);
    let has_a11y = features.as_ref().map(|a| i32::from(!a.is_empty()));
    Ok(json!({
        "appleId":id,
        "name":name,
        "iconUrl":icon,
        "developer":developer,
        "privacyPolicyUrl":policy,
        "url":url,
        "privacyTypes":types,
        "hasPrivacyDetails":if types.is_empty(){Value::Null}else{json!(1)},
        "accessibilityFeatures":features.unwrap_or_default(),
        "hasAccessibilityLabels":has_a11y
    }))
}

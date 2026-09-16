//! `extractFromShoebox`: Apple's pre-redesign Ember/FastBoot cache, which
//! every Wayback capture from 2021 until November 2025 depends on. One
//! try/catch wraps the whole walk, so the single throw inside it — a
//! candidate whose JSON is `null` — ends the extraction with nothing.
use super::js::{js_regex, truthy};
use crate::jsstr::js_object_key_order;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

fn script_pattern() -> &'static Regex {
    static P: OnceLock<Regex> = OnceLock::new();
    P.get_or_init(|| {
        js_regex(
            r#"(?i)<script[^>]*(?-u:\b)type="fastboot/shoebox"[^>]*(?-u:\b)id="(shoebox-[^"]*)"[^>]*>([\s\S]*?)</script(?-u:\b)[^>]*>"#,
        )
    })
}

fn id_pattern() -> &'static Regex {
    static P: OnceLock<Regex> = OnceLock::new();
    P.get_or_init(|| Regex::new("(?i)media-api|apps|ember-data").expect("static regex"))
}

/// Ember writes the shoebox body HTML-escaped; the six entities Node undoes,
/// in its order.
fn decode(body: &str) -> String {
    body.replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Privacy items in the modern item shape (`identifier`, `title`,
/// `categories`), or empty.
pub fn extract(html: &str) -> Vec<Value> {
    let candidates: Vec<&str> = script_pattern()
        .captures_iter(html)
        .filter(|c| id_pattern().is_match(&c[1]))
        .map(|c| c.get(2).map_or("", |m| m.as_str()))
        .collect();
    for body in candidates {
        let Ok(outer) = serde_json::from_str::<Value>(&decode(body)) else {
            continue;
        };
        // `Object.values(outer)`: an object's values in JavaScript key order,
        // an array's elements, a string's characters — and a throw on null.
        let values: Vec<Value> = match outer {
            Value::Object(map) => js_object_key_order(map.keys().map(String::as_str))
                .into_iter()
                .filter_map(|k| map.get(k).cloned())
                .collect(),
            Value::Array(items) => items,
            Value::String(s) => s.chars().map(|c| Value::String(c.to_string())).collect(),
            Value::Null => return vec![],
            _ => vec![],
        };
        for value in values {
            let entry = match value {
                Value::String(s) => match serde_json::from_str::<Value>(&s) {
                    Ok(parsed) => parsed,
                    Err(_) => continue,
                },
                other => other,
            };
            let record = match &entry["d"] {
                Value::Array(d) if !d.is_empty() => d[0].clone(),
                _ => entry["data"].clone(),
            };
            let Value::Array(types) = &record["attributes"]["privacy"]["privacyTypes"] else {
                continue;
            };
            if types.is_empty() {
                continue;
            }
            return types
                .iter()
                .filter(|t| truthy(t) && t["identifier"].is_string())
                .map(|t| {
                    let identifier = t["identifier"].clone();
                    let title = match (&t["privacyType"], &t["title"]) {
                        (Value::String(s), _) | (_, Value::String(s)) => Value::String(s.clone()),
                        _ => identifier.clone(),
                    };
                    let categories: Vec<Value> = match &t["dataCategories"] {
                        Value::Array(list) => list
                            .iter()
                            .filter(|c| truthy(c) && c["identifier"].is_string())
                            .map(|c| {
                                let id = c["identifier"].clone();
                                let name = match (&c["dataCategory"], &c["title"]) {
                                    (Value::String(s), _) | (_, Value::String(s)) => {
                                        Value::String(s.clone())
                                    }
                                    _ => id.clone(),
                                };
                                json!({"identifier": id, "title": name})
                            })
                            .collect(),
                        _ => vec![],
                    };
                    json!({"identifier": identifier, "title": title, "categories": categories})
                })
                .collect();
        }
    }
    vec![]
}

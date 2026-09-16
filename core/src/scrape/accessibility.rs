//! `extractAccessibilityFeatures` from lib/accessibility.ts: the rich
//! header variant first, the compact shelf second, an empty list when only
//! the header exists, `None` when nothing does. Nothing in it throws on
//! JSON input, so the try/catch around it in Node never fires.
use super::js::{at, truthy};
use crate::jsstr::js_trim;
use regex::Regex;
use serde_json::Value;
use std::{collections::HashSet, sync::OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feature {
    /// `slugifyFeatureTitle(title)`.
    pub identifier: String,
    /// Trimmed.
    pub title: String,
    pub description: Option<String>,
    pub icon_template: Option<String>,
}

/// `title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64)`.
pub fn slugify(title: &str) -> String {
    static NON_ALNUM: OnceLock<Regex> = OnceLock::new();
    let re = NON_ALNUM.get_or_init(|| Regex::new("[^a-z0-9]+").expect("static regex"));
    let lower = title.to_lowercase();
    let slug = re.replace_all(&lower, "_");
    // ASCII by now, so a byte slice is the UTF-16 slice.
    slug.trim_matches('_').chars().take(64).collect()
}

pub fn extract(data: &Value) -> Option<Vec<Feature>> {
    let shelf_mapping = at(data, 0)["data"]["shelfMapping"].clone();
    if !matches!(shelf_mapping, Value::Object(_) | Value::Array(_)) {
        return None;
    }

    // Path 1: the rich variant with descriptions.
    if let Value::Array(shelves) =
        &shelf_mapping["accessibilityHeader"]["seeAllAction"]["pageData"]["shelves"]
    {
        for shelf in shelves {
            if !matches!(shelf, Value::Object(_) | Value::Array(_)) {
                continue;
            }
            if shelf["contentType"] != "accessibilityFeatures" {
                continue;
            }
            let Value::Array(items) = &shelf["items"] else {
                continue;
            };
            for item in items {
                if truthy(item) {
                    if let Value::Array(features) = &item["features"] {
                        return Some(normalize(features));
                    }
                }
            }
        }
    }

    // Path 2: the compact variant.
    let direct = &shelf_mapping["accessibilityFeatures"];
    if matches!(direct, Value::Object(_) | Value::Array(_)) {
        if let Value::Array(items) = &direct["items"] {
            for item in items {
                if truthy(item) {
                    if let Value::Array(features) = &item["features"] {
                        return Some(normalize(features));
                    }
                }
            }
        }
    }

    // Header without a feature shelf: exists, claims nothing.
    if truthy(&shelf_mapping["accessibilityHeader"]) {
        return Some(vec![]);
    }
    None
}

fn normalize(raw: &[Value]) -> Vec<Feature> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for feature in raw {
        if !matches!(feature, Value::Object(_) | Value::Array(_)) {
            continue;
        }
        let Value::String(raw_title) = &feature["title"] else {
            continue;
        };
        let title = js_trim(raw_title);
        if title.is_empty() {
            continue;
        }
        let identifier = slugify(title);
        if identifier.is_empty() || !seen.insert(identifier.clone()) {
            continue;
        }
        let description = match &feature["description"] {
            Value::String(s) if !js_trim(s).is_empty() => Some(js_trim(s).to_string()),
            _ => None,
        };
        let icon_template = match &feature["artwork"]["template"] {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        out.push(Feature {
            identifier,
            title: title.to_string(),
            description,
            icon_template,
        });
    }
    out
}

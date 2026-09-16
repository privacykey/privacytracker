//! `extractRelatedAppShelves`: the two related-app shelves, each read from
//! the first of its candidate keys that yields items, capped at ten
//! records. Nothing in it throws on JSON input, so Node's `null` arm
//! ("could not decide") is unreachable.
use super::js::{at, truthy};
use crate::jsstr::{js_string, js_trim};
use serde_json::Value;

pub const MAX_RELATED_PER_SHELF: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelatedApp {
    /// `String(id ?? appleId ?? adamId)`.
    pub related_apple_id: String,
    pub related_name: String,
    pub related_developer: Option<String>,
    pub related_icon_url: Option<String>,
    pub related_store_url: String,
    /// `may_also_like` or `more_by_developer`.
    pub shelf_type: &'static str,
}

const SHELF_CANDIDATES: [(&[&str], &str); 2] = [
    (
        &[
            "customersAlsoBoughtAppsCollection",
            "customersAlsoBoughtApps",
            "youMightAlsoLike",
            "youMightAlsoLikeApps",
        ],
        "may_also_like",
    ),
    (
        &[
            "moreByThisDeveloperCollection",
            "moreByThisDeveloper",
            "moreByDeveloper",
        ],
        "more_by_developer",
    ),
];

pub fn extract(data: &Value) -> Vec<RelatedApp> {
    let mut out = vec![];
    let shelf_map = at(data, 0)["data"]["shelfMapping"].clone();
    if !matches!(shelf_map, Value::Object(_) | Value::Array(_)) {
        return out;
    }
    for (keys, shelf_type) in SHELF_CANDIDATES {
        for key in keys {
            let shelf = &shelf_map[*key];
            if !truthy(shelf) {
                continue;
            }
            let items = read_shelf_items(shelf);
            if items.is_empty() {
                continue;
            }
            let mut captured = 0;
            for item in items {
                if captured >= MAX_RELATED_PER_SHELF {
                    break;
                }
                if let Some(record) = normalise(item, shelf_type) {
                    out.push(record);
                    captured += 1;
                }
            }
            // First key that hits wins for this shelf type.
            break;
        }
    }
    out
}

/// `shelf.items` when it is an array, else every `items` array under the
/// shelf's `seeAllAction.pageData.shelves`.
fn read_shelf_items(shelf: &Value) -> Vec<&Value> {
    if let Value::Array(items) = &shelf["items"] {
        return items.iter().collect();
    }
    if let Value::Array(nested) = &shelf["seeAllAction"]["pageData"]["shelves"] {
        return nested
            .iter()
            .filter_map(|inner| inner["items"].as_array())
            .flatten()
            .collect();
    }
    vec![]
}

/// The first string argument with a non-blank trim, trimmed; else `""`.
fn pick_string(values: &[&Value]) -> String {
    values
        .iter()
        .find_map(|v| match v {
            Value::String(s) if !js_trim(s).is_empty() => Some(js_trim(s).to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn normalise(item: &Value, shelf_type: &'static str) -> Option<RelatedApp> {
    if !matches!(item, Value::Object(_) | Value::Array(_)) {
        return None;
    }
    let id_raw = [&item["id"], &item["appleId"], &item["adamId"]]
        .into_iter()
        .find(|v| !v.is_null());
    let related_apple_id = id_raw.map(js_string).unwrap_or_default();
    if related_apple_id.is_empty() {
        return None;
    }
    let related_name = pick_string(&[&item["name"], &item["title"]]);
    if related_name.is_empty() {
        return None;
    }
    let attribute_url = &item["attributes"]["url"];
    let related_store_url = pick_string(&[
        &item["url"],
        &item["appLink"],
        &item["storeUrl"],
        if attribute_url.is_string() {
            attribute_url
        } else {
            &Value::Null
        },
    ]);
    if related_store_url.is_empty() {
        return None;
    }
    let related_developer = pick_string(&[
        &item["artistName"],
        &item["developerName"],
        &item["subtitle"],
        &item["attributes"]["artistName"],
    ]);
    let icon_template = pick_string(&[
        &item["artwork"]["url"],
        &item["artwork"]["template"],
        &item["iconUrl"],
        &item["imageUrl"],
    ]);
    Some(RelatedApp {
        related_apple_id,
        related_name,
        related_developer: Some(related_developer).filter(|s| !s.is_empty()),
        related_icon_url: Some(icon_template).filter(|s| !s.is_empty()),
        related_store_url,
        shelf_type,
    })
}

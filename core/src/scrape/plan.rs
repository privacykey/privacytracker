//! `prepareScrapeWritePlan`: the privacy-type fallback chain, the
//! normaliser, the snapshot, and the two side shelves.
//!
//! The chain sits inside one try/catch in Node, so a throw anywhere in it
//! keeps whatever was pushed before and skips every later fallback. The
//! normaliser runs AFTER that try, so its own throws — a `categories` that
//! is not iterable, or an `items` that is not — escape from the scrape.
use super::{
    accessibility::{self, Feature},
    js::{at, has_length, iterate, truthy},
    related::{self, RelatedApp},
    shoebox,
};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Category {
    pub identifier: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivacyItem {
    pub identifier: String,
    pub title: String,
    /// `""` when the item carries no string `detail`.
    pub detail: String,
    /// Deduplicated by identifier, first title wins.
    pub categories: Vec<Category>,
}

/// One type of the `snapshot_json` blob: the item minus its detail, in the
/// key order `JSON.stringify` writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SnapshotType {
    pub identifier: String,
    pub title: String,
    pub categories: Vec<SnapshotCategory>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SnapshotCategory {
    pub identifier: String,
    pub title: String,
}

#[derive(Debug)]
pub struct WritePlan {
    pub privacy_items: Vec<PrivacyItem>,
    /// `None` is "could not decide" and leaves existing rows alone; `Some`
    /// and empty means the shelf exists and claims nothing.
    pub accessibility_features: Option<Vec<Feature>>,
    pub has_accessibility_labels: Option<i64>,
    /// Node's is `RelatedAppShelfRecord[] | null`, but its extractor cannot
    /// throw on JSON input, so the `null` arm is unreachable and this is a
    /// plain vector.
    pub related_apps: Vec<RelatedApp>,
    pub snapshot: Vec<SnapshotType>,
}

impl WritePlan {
    /// `JSON.stringify(writePlan.snapshot)` — the `privacy_snapshots` blob.
    pub fn snapshot_json(&self) -> String {
        serde_json::to_string(&self.snapshot).expect("snapshot serialises")
    }
}

pub fn prepare(data: &Value, html: &str) -> Result<WritePlan, String> {
    let accessibility_features = accessibility::extract(data);
    let has_accessibility_labels = accessibility_features
        .as_ref()
        .map(|features| i64::from(!features.is_empty()));
    let raw_items = select_privacy_items(data, html);
    let privacy_items = normalize(&raw_items)?;
    let related_apps = related::extract(data);
    let snapshot = privacy_items
        .iter()
        .map(|item| SnapshotType {
            identifier: item.identifier.clone(),
            title: item.title.clone(),
            categories: item
                .categories
                .iter()
                .map(|c| SnapshotCategory {
                    identifier: c.identifier.clone(),
                    title: c.title.clone(),
                })
                .collect(),
        })
        .collect();
    Ok(WritePlan {
        privacy_items,
        accessibility_features,
        has_accessibility_labels,
        related_apps,
        snapshot,
    })
}

/// The fallback chain. Returns whatever `privacyItems` held when the chain
/// finished or threw: the product-page shelf as-is (so possibly a string or
/// an object), else the accumulated array.
fn select_privacy_items(data: &Value, html: &str) -> Value {
    let mut items = Value::Array(vec![]);
    // `Err(())` is the TypeError Node's catch swallows; `items` keeps what
    // was pushed before it.
    let chain = (|| -> Result<(), ()> {
        let shelf_map = at(data, 0)["data"]["shelfMapping"].clone();

        // Product-page shelf, taken whole.
        if has_length(&shelf_map["privacyTypes"]["items"]) {
            items = shelf_map["privacyTypes"]["items"].clone();
        }

        // privacyHeader detail shelves, flattening nested purposes.
        if !has_length(&items) {
            let via_header = &shelf_map["privacyHeader"]["seeAllAction"]["pageData"]["shelves"];
            if has_length(via_header) {
                for shelf in iterate(via_header).map_err(drop)? {
                    if shelf.is_null() {
                        return Err(());
                    }
                    if shelf["contentType"] != "privacyType" {
                        continue;
                    }
                    let shelf_items = if shelf["items"].is_null() {
                        vec![]
                    } else {
                        iterate(&shelf["items"]).map_err(drop)?
                    };
                    for item in shelf_items {
                        if item.is_null() {
                            return Err(());
                        }
                        if has_length(&item["categories"]) {
                            push(&mut items, item);
                        } else if has_length(&item["purposes"]) {
                            let mut seen: Vec<(Value, Value)> = vec![];
                            for purpose in iterate(&item["purposes"]).map_err(drop)? {
                                if purpose.is_null() {
                                    return Err(());
                                }
                                let categories = if purpose["categories"].is_null() {
                                    vec![]
                                } else {
                                    iterate(&purpose["categories"]).map_err(drop)?
                                };
                                for category in categories {
                                    if category.is_null() {
                                        return Err(());
                                    }
                                    let key = category["identifier"].clone();
                                    if !seen.iter().any(|(k, _)| *k == key) {
                                        seen.push((
                                            key,
                                            json!({"identifier": category["identifier"], "title": category["title"]}),
                                        ));
                                    }
                                }
                            }
                            // `{ ...item, categories: [...], purposes: [] }`
                            let mut normalized = item;
                            normalized["categories"] =
                                Value::Array(seen.into_iter().map(|(_, v)| v).collect());
                            normalized["purposes"] = Value::Array(vec![]);
                            push(&mut items, normalized);
                        }
                    }
                }
            }
        }

        // Generic pageData shelves.
        if !has_length(&items) {
            let page_data = at(data, 0)["data"]["pageData"].clone();
            if has_length(&page_data["shelves"]) {
                for shelf in iterate(&page_data["shelves"]).map_err(drop)? {
                    if shelf.is_null() {
                        return Err(());
                    }
                    if shelf["contentType"] == "privacyType" && !shelf["items"].is_null() {
                        for item in iterate(&shelf["items"]).map_err(drop)? {
                            push(&mut items, item);
                        }
                    }
                }
            }
        }

        // The historical Ember/FastBoot shoebox, when there is HTML to scan.
        if !has_length(&items) && !html.is_empty() {
            items = Value::Array(shoebox::extract(html));
        }
        Ok(())
    })();
    if chain.is_err() {
        crate::server::diag::log_error("[scrape] Could not extract privacy data from raw JSON");
    }
    items
}

/// `privacyItems.push(x)`: only ever reached while `privacyItems` is still
/// the array the chain started with.
fn push(items: &mut Value, item: Value) {
    if let Value::Array(list) = items {
        list.push(item);
    }
}

/// `normalizePrivacyItems`: string identifier and title required, detail
/// defaulted, categories deduplicated by identifier.
fn normalize(items: &Value) -> Result<Vec<PrivacyItem>, String> {
    let list = iterate(items).map_err(|e| e.named_message("items"))?;
    let mut out = vec![];
    for item in &list {
        if !truthy(item) {
            continue;
        }
        let (Value::String(identifier), Value::String(title)) =
            (&item["identifier"], &item["title"])
        else {
            continue;
        };
        let raw_categories = if item["categories"].is_null() {
            vec![]
        } else {
            iterate(&item["categories"]).map_err(|e| e.typed_message())?
        };
        let mut categories: Vec<Category> = vec![];
        for category in &raw_categories {
            if !truthy(category) {
                continue;
            }
            let (Value::String(id), Value::String(name)) =
                (&category["identifier"], &category["title"])
            else {
                continue;
            };
            if !categories.iter().any(|c| c.identifier == *id) {
                categories.push(Category {
                    identifier: id.clone(),
                    title: name.clone(),
                });
            }
        }
        out.push(PrivacyItem {
            identifier: identifier.clone(),
            title: title.clone(),
            detail: match &item["detail"] {
                Value::String(s) => s.clone(),
                _ => String::new(),
            },
            categories,
        });
    }
    Ok(out)
}

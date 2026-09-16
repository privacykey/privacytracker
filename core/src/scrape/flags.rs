//! `detectPrivacyDetailsFlag` and `detectIapFlag`: three-state flags read
//! from the blob first and the HTML last. Both sit in their own try/catch
//! in Node, so any throw is `null`.
use super::js::{at, has_length, js_regex, truthy};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

struct Patterns {
    iap_row_title: Regex,
    iap_attribute_key: Regex,
    iap_badge: Regex,
    no_details: Regex,
    required_copy: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        iap_row_title: js_regex(r"(?i)^in[-‑ ]?app\s+purchases$"),
        iap_attribute_key: js_regex(r"(?i)^in[-_‑]?app[-_‑]?purchases$"),
        iap_badge: js_regex(r"(?i)Offers\s+In[-‑ ]?App\s+Purchases"),
        no_details: js_regex(r"(?i)No\s+Details\s+Provided"),
        required_copy: js_regex(
            r"(?i)required\s+to\s+provide\s+privacy\s+details\s+when\s+they\s+submit",
        ),
    })
}

/// `1` when either privacy shelf has items, `0` on Apple's "No Details
/// Provided" copy, `None` otherwise — or on the one throw: a header
/// `shelves` that exists but is not an array has no `.some`.
pub fn detect_privacy_details(html: &str, data: &Value) -> Option<i64> {
    let shelf_map = at(data, 0)["data"]["shelfMapping"].clone();
    if has_length(&shelf_map["privacyTypes"]["items"]) {
        return Some(1);
    }
    let via_header = match &shelf_map["privacyHeader"]["seeAllAction"]["pageData"]["shelves"] {
        Value::Null => false,
        Value::Array(shelves) => shelves
            .iter()
            .any(|s| s["contentType"] == "privacyType" && has_length(&s["items"])),
        _ => return None,
    };
    if via_header {
        return Some(1);
    }
    let p = patterns();
    if p.no_details.is_match(html) || p.required_copy.is_match(html) {
        return Some(0);
    }
    None
}

/// The four IAP paths in Node's order: the dedicated shelf, the
/// information row, the legacy attribute (whose boolean is honoured), and
/// finally the badge text in the HTML.
pub fn detect_iap(html: &str, data: &Value) -> Option<i64> {
    let root = at(data, 0)["data"].clone();
    if !truthy(&root) {
        return None;
    }
    let iap_shelf = &root["shelfMapping"]["inAppPurchases"];
    if truthy(iap_shelf) {
        if let Value::Array(items) = &iap_shelf["items"] {
            return Some(if items.is_empty() { 0 } else { 1 });
        }
    }
    let p = patterns();
    if let Value::Array(rows) = &root["shelfMapping"]["information"]["items"] {
        for row in rows {
            if let Value::String(title) = &row["title"] {
                if p.iap_row_title.is_match(title) {
                    return Some(1);
                }
            }
        }
    }
    if let Value::Array(attributes) = &root["additionalAttributes"]["attributes"] {
        for attribute in attributes {
            if let Value::String(key) = &attribute["attributeKey"] {
                if p.iap_attribute_key.is_match(key) {
                    return Some(match &attribute["value"] {
                        Value::Bool(b) => i64::from(*b),
                        _ => 1,
                    });
                }
            }
        }
    }
    if p.iap_badge.is_match(html) {
        return Some(1);
    }
    None
}

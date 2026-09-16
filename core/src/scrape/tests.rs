//! Replays `core/tests/fixtures/scrape-cases.json`: the real
//! `fetchAndParseApp` over synthetic pages, with the page-derived columns,
//! the privacy rows, the exact `snapshot_json`, the accessibility rows and
//! the related-app rows projected out of what Node wrote — or Node's error
//! message. `parse_page` must reproduce every projection.
use super::{parse_page, ParsedPage};
use serde_json::{json, Value};

fn project(url: &str, page: &ParsedPage) -> Value {
    let plan = &page.plan;
    json!({
        "ok": true,
        "id": page.apple_id,
        "name": page.name,
        "app": {
            "name": page.name,
            "url": url,
            "iconUrl": page.icon_url,
            "developer": page.developer,
            "privacyPolicyUrl": page.privacy_policy_url,
            "hasPrivacyDetails": page.has_privacy_details,
            "hasIap": page.has_iap,
            "hasAccessibilityLabels": plan.has_accessibility_labels,
        },
        "privacyItems": plan.privacy_items.iter().map(|item| json!({
            "identifier": item.identifier,
            "title": item.title,
            "detail": item.detail,
            "categories": item.categories.iter().map(|c| json!({
                "identifier": c.identifier,
                "title": c.title,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "snapshot": plan.snapshot_json(),
        "accessibilityFeatures": plan.accessibility_features.as_ref().map(|features| {
            features.iter().map(|f| json!({
                "identifier": f.identifier,
                "title": f.title,
                "description": f.description,
                "iconTemplate": f.icon_template,
            })).collect::<Vec<_>>()
        }),
        "relatedApps": plan.related_apps.iter().map(|r| json!({
            "relatedAppleId": r.related_apple_id,
            "relatedName": r.related_name,
            "relatedDeveloper": r.related_developer,
            "relatedIconUrl": r.related_icon_url,
            "relatedStoreUrl": r.related_store_url,
            "shelfType": r.shelf_type,
        })).collect::<Vec<_>>(),
    })
}

#[test]
fn page_parse_matches_node_rows_and_errors() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/scrape-cases.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    let mut failures = vec![];
    for case in cases {
        let url = case["url"].as_str().unwrap();
        let html = case["html"].as_str().unwrap();
        let actual = match parse_page(url, html) {
            Ok(page) => project(url, &page),
            Err(error) => json!({"ok": false, "error": error}),
        };
        if actual != case["expected"] {
            failures.push(format!(
                "{}\nexpected: {}\nactual:   {}",
                case["name"], case["expected"], actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
}

#[test]
fn slug_rules_match_node() {
    use super::accessibility::slugify;
    // Every pair is `slugifyFeatureTitle` from node -e.
    assert_eq!(slugify("VoiceOver"), "voiceover");
    assert_eq!(slugify("Zoom\u{2011}In"), "zoom_in");
    assert_eq!(slugify("Éclair Mode"), "clair_mode");
    assert_eq!(slugify("İstanbul Kit"), "i_stanbul_kit");
    assert_eq!(slugify(&"A".repeat(70)).len(), 64);
    assert_eq!(slugify("\u{00a0}"), "");
}

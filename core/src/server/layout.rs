//! Port of `lib/dashboard-layout.ts` — the editable home-dashboard layout:
//! canonical card order, the five named presets, `reconcileLayout` and
//! `matchDashboardPreset` — and of `getDashboardLayout` /
//! `readDashboardLayoutWithMatch` from `lib/dashboard-layout-server.ts`.
//!
//! `reconcileLayout` is the part worth reading twice. A stored layout keeps
//! the user's order for the cards it names; every canonical card it does
//! NOT name is slotted in next to its nearest PRECEDING canonical neighbour
//! that is already placed — and when there is none, it is `unshift`ed to
//! the front, not appended. So a stored `order: ["hero"]` does not come back
//! as hero-first: `task_list` has no predecessor and goes to the front,
//! `review_cta` then slots after `task_list`, and so on down the canonical
//! list until hero has been pushed to sixth. The generated fixture pins
//! that case by name.
//!
//! `hidden` only ever holds first-class cards — callouts are reorder-only —
//! and is deduplicated and sorted into canonical order, which is what lets
//! preset matching ignore the order the user's client happened to send.

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

use super::settings::get_setting_with;

/// `CANONICAL_ORDER` — also the full `DashboardCardId` union.
pub const CANONICAL_ORDER: [&str; 18] = [
    "task_list",
    "review_cta",
    "focus_strip",
    "background_mode_wizard",
    "risk_section",
    "hero",
    "cleanup_callout",
    "family_callout",
    "age_rating_callout",
    "third_party_callout",
    "glance_section",
    "definitions_callout",
    "review_section",
    "profile_mismatch_section",
    "stale_section",
    "activity_section",
    "risk_tier_legend",
    "manual_apps_banner",
];

/// `FIRST_CLASS_CARDS` — the cards the user can hide. Declaration order is
/// the JS Set's insertion order; nothing observable depends on it because
/// every walk over it is sorted canonically afterwards.
pub const FIRST_CLASS_CARDS: [&str; 13] = [
    "task_list",
    "review_cta",
    "focus_strip",
    "background_mode_wizard",
    "risk_section",
    "hero",
    "glance_section",
    "definitions_callout",
    "review_section",
    "profile_mismatch_section",
    "stale_section",
    "activity_section",
    "risk_tier_legend",
];

/// `CALLOUT_CARDS` — reorder-only; never valid in `hidden`.
pub const CALLOUT_CARDS: [&str; 5] = [
    "manual_apps_banner",
    "cleanup_callout",
    "family_callout",
    "age_rating_callout",
    "third_party_callout",
];

/// `DASHBOARD_PRESET_KEYS`, in match order.
pub const PRESET_KEYS: [&str; 5] = ["default", "minimal", "caretaker", "watchdog", "at_a_glance"];

/// `DashboardLayout`. Field order is the object-literal order every producer
/// in `lib/dashboard-layout.ts` uses: `{ v: 1, order, hidden }`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub v: i64,
    pub order: Vec<String>,
    pub hidden: Vec<String>,
}

fn canonical_index(id: &str) -> usize {
    CANONICAL_ORDER
        .iter()
        .position(|c| *c == id)
        .expect("only canonical ids reach the sort")
}

fn is_first_class(id: &str) -> bool {
    FIRST_CLASS_CARDS.contains(&id)
}

/// `DEFAULT_LAYOUT` / the early-return literal in `reconcileLayout`.
pub fn default_layout() -> Layout {
    Layout {
        v: 1,
        order: CANONICAL_ORDER.iter().map(|s| s.to_string()).collect(),
        hidden: Vec::new(),
    }
}

/// `buildPreset(visibleFirstClass)`: the chosen cards in the order given,
/// then everything else in canonical order; hidden = the first-class cards
/// not chosen, canonically sorted.
fn build_preset(visible: &[&str]) -> Layout {
    let mut order: Vec<String> = Vec::with_capacity(CANONICAL_ORDER.len());
    let mut consumed: HashSet<&str> = HashSet::new();
    for id in visible {
        if !CANONICAL_ORDER.contains(id) {
            continue;
        }
        order.push(id.to_string());
        consumed.insert(id);
    }
    for id in CANONICAL_ORDER {
        if consumed.insert(id) {
            order.push(id.to_string());
        }
    }
    let mut hidden: Vec<&str> = FIRST_CLASS_CARDS
        .iter()
        .copied()
        .filter(|id| !visible.contains(id))
        .collect();
    hidden.sort_by_key(|id| canonical_index(id));
    Layout {
        v: 1,
        order,
        hidden: hidden.into_iter().map(str::to_string).collect(),
    }
}

/// `DASHBOARD_PRESETS`, in `PRESET_KEYS` order.
pub fn presets() -> Vec<(&'static str, Layout)> {
    vec![
        ("default", default_layout()),
        (
            "minimal",
            build_preset(&[
                "review_cta",
                "hero",
                "risk_section",
                "review_section",
                "glance_section",
            ]),
        ),
        (
            "caretaker",
            build_preset(&[
                "review_cta",
                "risk_section",
                "profile_mismatch_section",
                "review_section",
                "activity_section",
                "glance_section",
                "hero",
                "task_list",
                "focus_strip",
            ]),
        ),
        (
            "watchdog",
            build_preset(&[
                "review_cta",
                "risk_section",
                "profile_mismatch_section",
                "stale_section",
                "activity_section",
                "review_section",
                "hero",
                "focus_strip",
                "glance_section",
            ]),
        ),
        (
            "at_a_glance",
            build_preset(&[
                "review_cta",
                "glance_section",
                "hero",
                "review_section",
                "activity_section",
                "risk_section",
                "focus_strip",
            ]),
        ),
    ]
}

/// `normaliseLayout`: dedupe `order`; keep only first-class ids in `hidden`,
/// dedupe, and sort them canonically.
fn normalise_layout(layout: Layout) -> Layout {
    let mut seen: HashSet<String> = HashSet::new();
    let order: Vec<String> = layout
        .order
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    let mut seen_hidden: HashSet<String> = HashSet::new();
    let mut hidden: Vec<String> = layout
        .hidden
        .into_iter()
        .filter(|id| is_first_class(id) && seen_hidden.insert(id.clone()))
        .collect();
    hidden.sort_by_key(|id| canonical_index(id));
    Layout {
        v: 1,
        order,
        hidden,
    }
}

/// `layoutsEqual`: normalise both, then element-wise on `order` and `hidden`.
fn layouts_equal(a: &Layout, b: &Layout) -> bool {
    let an = normalise_layout(a.clone());
    let bn = normalise_layout(b.clone());
    an.order == bn.order && an.hidden == bn.hidden
}

/// `(Array.isArray(v) ? v : []).filter(id => typeof id === "string" && keep(id))`
fn as_ids(v: Option<&Value>, keep: fn(&str) -> bool) -> Vec<&str> {
    v.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| keep(id))
                .collect()
        })
        .unwrap_or_default()
}

/// `reconcileLayout(stored)` over a parsed JSON value.
///
/// `!stored || typeof stored !== "object"` rejects null, booleans, numbers
/// and strings — but NOT arrays, which are objects with no `order` and no
/// `hidden` and so reconcile to the canonical layout by the long road.
pub fn reconcile_layout(stored: &Value) -> Layout {
    let (order_v, hidden_v) = match stored {
        Value::Object(m) => (m.get("order"), m.get("hidden")),
        Value::Array(_) => (None, None),
        _ => return default_layout(),
    };
    // Known ids in the user's order, first occurrence wins.
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out: Vec<&str> = Vec::with_capacity(CANONICAL_ORDER.len());
    for id in as_ids(order_v, |id| CANONICAL_ORDER.contains(&id)) {
        if seen.insert(id) {
            out.push(id);
        }
    }

    // Slot each missing canonical id after its nearest preceding canonical
    // neighbour that is already placed; with none, UNSHIFT.
    for (c_idx, id) in CANONICAL_ORDER.iter().enumerate() {
        if seen.contains(id) {
            continue;
        }
        let mut inserted = false;
        for i in (0..c_idx).rev() {
            let neighbour = CANONICAL_ORDER[i];
            if let Some(at) = out.iter().position(|x| *x == neighbour) {
                out.insert(at + 1, id);
                inserted = true;
                break;
            }
        }
        if !inserted {
            out.insert(0, id);
        }
        seen.insert(id);
    }

    let hidden = as_ids(hidden_v, is_first_class);

    normalise_layout(Layout {
        v: 1,
        order: out.into_iter().map(str::to_string).collect(),
        hidden: hidden.into_iter().map(str::to_string).collect(),
    })
}

/// `matchDashboardPreset`: the first preset, in key order, equal to the
/// layout under normalisation.
pub fn match_dashboard_preset(layout: &Layout) -> Option<&'static str> {
    presets()
        .into_iter()
        .find(|(_, preset)| layouts_equal(layout, preset))
        .map(|(key, _)| key)
}

/// `readDashboardLayoutWithMatch()` — the whole `GET /api/dashboard/layout`
/// body. Key order is the literal's: `layout`, then `matchedPreset`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LayoutWithMatch {
    pub layout: Layout,
    #[serde(rename = "matchedPreset")]
    pub matched_preset: Option<&'static str>,
}

/// `getDashboardLayout`: an empty row is the default, a row that is not
/// JSON is the default (left in place for an operator to salvage), and
/// anything else is reconciled — including a JSON literal that is not an
/// object, which `reconcileLayout` maps to the default itself.
pub fn read_layout_with_match(conn: &Connection) -> rusqlite::Result<LayoutWithMatch> {
    let raw = get_setting_with(conn, "dashboard.layout", "")?;
    let layout = if raw.is_empty() {
        default_layout()
    } else {
        match serde_json::from_str::<Value>(&raw) {
            Ok(parsed) => reconcile_layout(&parsed),
            Err(_) => default_layout(),
        }
    };
    let matched_preset = match_dashboard_preset(&layout);
    Ok(LayoutWithMatch {
        layout,
        matched_preset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_three_tables_partition_the_canonical_list() {
        let all: HashSet<&str> = CANONICAL_ORDER.iter().copied().collect();
        let first: HashSet<&str> = FIRST_CLASS_CARDS.iter().copied().collect();
        let callouts: HashSet<&str> = CALLOUT_CARDS.iter().copied().collect();
        assert!(first.is_disjoint(&callouts));
        assert_eq!(&first | &callouts, all);
    }

    #[test]
    fn every_preset_matches_itself_and_default_is_canonical() {
        for (key, preset) in presets() {
            assert_eq!(match_dashboard_preset(&preset), Some(key), "{key}");
            assert_eq!(preset.order.len(), 18, "{key} lists every card once");
        }
        assert_eq!(presets()[0].1, default_layout());
    }

    #[test]
    fn scalar_and_null_stored_values_are_the_default_but_an_array_is_not_special() {
        for v in [json!(null), json!(true), json!(5), json!("nope")] {
            assert_eq!(reconcile_layout(&v), default_layout(), "{v}");
        }
        // Arrives by the long road at the same answer.
        assert_eq!(reconcile_layout(&json!([])), default_layout());
        assert_eq!(reconcile_layout(&json!({})), default_layout());
    }

    #[test]
    fn a_lone_hero_is_not_first_after_reconciliation() {
        // The unshift-then-chain behaviour described in the module docs.
        let got = reconcile_layout(&json!({ "order": ["hero"] }));
        assert_eq!(got.order[0], "task_list");
        assert_eq!(got.order.iter().position(|id| id == "hero"), Some(5));
        assert_eq!(got.order.len(), 18);
    }

    #[test]
    fn hidden_drops_callouts_and_unknowns_then_sorts_canonically() {
        let got = reconcile_layout(&json!({
            "order": [],
            "hidden": ["activity_section", "cleanup_callout", "hero", "hero", "nope", 7]
        }));
        assert_eq!(got.hidden, vec!["hero", "activity_section"]);
        assert_eq!(match_dashboard_preset(&got), None);
    }

    #[test]
    fn preset_match_ignores_hidden_order() {
        let minimal = presets()[1].1.clone();
        let mut shuffled = minimal.clone();
        shuffled.hidden.reverse();
        assert_eq!(match_dashboard_preset(&shuffled), Some("minimal"));
    }
}

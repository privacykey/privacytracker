//! Port of `diffSnapshots` from `lib/changelog.ts` — the first piece of real
//! business logic in the core, as opposed to a read shim.
//!
//! **The parity harness is blind to this function.** Every app the canned
//! seed creates ends up with a baseline and a latest snapshot whose types and
//! categories have identical membership (the arrays are reordered between
//! them, which is itself worth knowing — it proves the diff is
//! identifier-keyed — but membership never changes), so
//! `/api/apps/{id}/since-install` answers `"changes": []` for all ten seeded
//! apps. A port of this module that returned an empty vec unconditionally
//! would pass the read gate. It is therefore pinned by
//! `core/tests/diff_cases.rs`, which replays a fixture whose expected values
//! were produced by running the REAL Node function
//! (`core/scripts/extract-diff-cases.mjs`). Treat "parity green" as saying
//! nothing whatsoever about this file.
//!
//! Two JavaScript semantics carry the whole design:
//!
//! 1. `new Map(arr.map(t => [t.identifier, t]))` preserves INSERTION order,
//!    and on a duplicate key keeps the FIRST occurrence's POSITION with the
//!    LAST occurrence's VALUE. A `BTreeMap` sorts (wrong order), a plain
//!    `HashMap` loses order entirely, and a naive `Vec` scan emits the
//!    duplicate twice. `ordered_by_identifier` below reproduces the Map.
//! 2. Map keys are compared by SameValueZero, so `1`, `"1"`, `null` and a
//!    missing field are four DISTINCT keys — while `0`/`-0` and `1`/`1.0`
//!    are the SAME key. Modelling `identifier` as `String`, or as `Value`
//!    with `#[serde(default)]` (which collapses missing onto null), merges
//!    buckets Node keeps apart; formatting the raw JSON token splits buckets
//!    Node merges.
//!
//! Two boundaries where this port knowingly differs from Node, both verified
//! against the real function and both unreachable from data this application
//! writes:
//!
//! * **Non-scalar identifiers.** JavaScript compares objects and arrays by
//!   REFERENCE, so two structurally identical ones are different Map keys.
//!   Nothing survives deserialisation with its reference identity intact, so
//!   they collapse to one key here. `saveSnapshot` has only ever written
//!   string identifiers.
//! * **Integers beyond 2^53 inside a title.** JavaScript parses them into an
//!   f64 and loses precision; `serde_json` keeps them exact, so the rendered
//!   description can differ in the last digit.
//!
//! A structurally malformed blob — a type with no `categories`, or an array
//! element that is not an object — makes Node throw out of `diffSnapshots`
//! and the route answer 500. Here it fails to deserialise and the route
//! answers `"sinceInstall": null`. Different, but both are refusals; the
//! alternative was to default the missing field and invent an answer.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Distinguish "the key was absent" from "the key was present and null".
///
/// serde's default for `Option<T>` maps BOTH to `None`, which is exactly the
/// distinction JavaScript's Map keys keep — `undefined` and `null` are
/// different keys. Pairing this with `#[serde(default)]` gives `None` only
/// for a missing field and `Some(Value::Null)` for an explicit one.
fn present_or_null<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

/// A category inside a snapshot blob.
///
/// `identifier` and `title` are `Option<Value>` rather than `String` on
/// purpose: the blob is JSON that has been round-tripping through this
/// database since long before the Rust core existed, and the Node code puts
/// whatever it finds straight into a template literal or a Map key without
/// checking the type. `None` means the key was ABSENT (JavaScript
/// `undefined`), which is distinct from `Some(Value::Null)`.
#[derive(Debug, Deserialize)]
pub struct CategorySnapshot {
    #[serde(default, deserialize_with = "present_or_null")]
    pub identifier: Option<Value>,
    #[serde(default, deserialize_with = "present_or_null")]
    pub title: Option<Value>,
}

/// A top-level privacy type inside a snapshot blob.
#[derive(Debug, Deserialize)]
pub struct TypeSnapshot {
    #[serde(default, deserialize_with = "present_or_null")]
    pub identifier: Option<Value>,
    #[serde(default, deserialize_with = "present_or_null")]
    pub title: Option<Value>,
    /// Deliberately NOT `#[serde(default)]`. A blob whose type is missing
    /// `categories`, or has it as null, makes Node throw a TypeError out of
    /// `diffSnapshots` — the try/catch upstream wraps only `JSON.parse` — so
    /// the route answers 500. Defaulting to an empty vec here would instead
    /// invent a plausible-looking answer for data Node refuses outright.
    /// Failing to deserialise routes it to `sinceInstall: null`, which is a
    /// refusal rather than a fabrication. See the module note on malformed
    /// blobs.
    pub categories: Vec<CategorySnapshot>,
}

/// One entry of `changes_summary`.
///
/// The Node `ChangeEntry` interface declares seven more optional fields
/// (`category`, `policy_event`, `policy_version_id`, `save_now_url`,
/// `target_date`, `wayback_event`), but `diffSnapshots` never sets any of
/// them, and `JSON.stringify` drops `undefined`. So they must be ABSENT
/// here, not null — which is why this struct simply does not have them
/// rather than carrying skipped `Option`s.
///
/// Key order is `type`, `description`, `details`, matching the object
/// literals in `diffSnapshots`.
#[derive(Debug, Serialize)]
pub struct ChangeEntry {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub description: String,
    /// Present ONLY on added-type entries, where it lists the new type's
    /// category titles. `skip_serializing_if` is right here because absence
    /// is meaningful — but note it must still emit `[]` for an added type
    /// with no categories, which `Some(vec![])` does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Vec<Value>>,
}

/// Render a value the way a JavaScript template literal would.
///
/// Only the cases a snapshot blob can actually hold are handled precisely.
/// Very large or very small numbers reach exponent notation in JS by rules
/// this does not reproduce; no snapshot has ever held one, and the parity
/// differ collapses numeric noise anyway.
fn js_display(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => {
            // `1.0` is `1` in JavaScript. serde_json's Display would say
            // "1.0", so collapse integral floats back to integers.
            match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
                _ => n.to_string(),
            }
        }
        // JS gives "a,b" for arrays and "[object Object]" for plain objects.
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                other => js_display(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// A stable stand-in for a JavaScript Map key.
///
/// The discriminant prefix is what keeps `undefined`, `null`, `"1"` and `1`
/// apart — serialising alone would render the last two as `"1"` and `1`,
/// which is already distinct, but `undefined` has no JSON form at all.
///
/// Objects and arrays used as identifiers would be compared by REFERENCE in
/// JavaScript, so two structurally-equal ones are different Map keys there
/// and the same key here. No snapshot has ever carried a non-scalar
/// identifier; the alternative is to give up on ordering entirely.
fn map_key(value: Option<&Value>) -> String {
    match value {
        None => "\u{0}undefined".to_string(),
        // SameValueZero: `0` and `-0` are ONE key, and JavaScript has a
        // single number type so `1` and `1.0` are too. Formatting the JSON
        // token would keep all three apart — verified against Node, which
        // reports no change at all for a 0 → -0 identifier edit.
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            let f = if f == 0.0 { 0.0 } else { f };
            format!("\u{1}n{f}")
        }
        Some(v) => format!("\u{1}{v}"),
    }
}

/// Reproduce `new Map(list.map(t => [t.identifier, t]))`: unique keys in
/// first-occurrence order, each holding the LAST value seen for that key.
fn ordered_by_identifier(list: &[TypeSnapshot]) -> Vec<(String, &TypeSnapshot)> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<(String, &TypeSnapshot)> = Vec::new();
    for item in list {
        let key = map_key(item.identifier.as_ref());
        match seen.get(&key) {
            // A repeat key keeps its slot and takes the newer value.
            Some(&at) => out[at].1 = item,
            None => {
                seen.insert(key.clone(), out.len());
                out.push((key, item));
            }
        }
    }
    out
}

/// Port of `diffSnapshots`. Three passes, in this order — added types, then
/// removed types, then per-type category changes — because that order is the
/// wire contract, not an implementation detail.
pub fn diff_snapshots(
    old_snapshot: &[TypeSnapshot],
    new_snapshot: &[TypeSnapshot],
) -> Vec<ChangeEntry> {
    let mut changes: Vec<ChangeEntry> = Vec::new();

    let old_types = ordered_by_identifier(old_snapshot);
    let new_types = ordered_by_identifier(new_snapshot);
    let old_keys: HashSet<&str> = old_types.iter().map(|(k, _)| k.as_str()).collect();
    let new_keys: HashSet<&str> = new_types.iter().map(|(k, _)| k.as_str()).collect();

    // 1. New top-level privacy types, in the NEW snapshot's order.
    for (key, new_type) in &new_types {
        if !old_keys.contains(key.as_str()) {
            changes.push(ChangeEntry {
                kind: "added",
                description: format!(
                    "New privacy label: \"{}\"",
                    js_display(new_type.title.as_ref())
                ),
                // Raw title VALUES, not stringified: Node maps the array
                // without touching it, so a null title lands as JSON null
                // inside `details` while the description says "null".
                details: Some(
                    new_type
                        .categories
                        .iter()
                        .map(|c| c.title.clone().unwrap_or(Value::Null))
                        .collect(),
                ),
            });
        }
    }

    // 2. Removed top-level privacy types, in the OLD snapshot's order.
    for (key, old_type) in &old_types {
        if !new_keys.contains(key.as_str()) {
            changes.push(ChangeEntry {
                kind: "removed",
                description: format!(
                    "Removed privacy label: \"{}\"",
                    js_display(old_type.title.as_ref())
                ),
                details: None,
            });
        }
    }

    // 3. Category-level changes within types present on both sides.
    for (key, new_type) in &new_types {
        let Some((_, old_type)) = old_types.iter().find(|(k, _)| k == key) else {
            continue;
        };

        let old_cat_keys: HashSet<String> = old_type
            .categories
            .iter()
            .map(|c| map_key(c.identifier.as_ref()))
            .collect();
        let new_cat_keys: HashSet<String> = new_type
            .categories
            .iter()
            .map(|c| map_key(c.identifier.as_ref()))
            .collect();

        // Filtered from the ARRAY, not from the set, so a category listed
        // twice produces two entries. The set is membership only.
        // Every added category precedes every removed one.
        for c in new_type
            .categories
            .iter()
            .filter(|c| !old_cat_keys.contains(&map_key(c.identifier.as_ref())))
        {
            changes.push(ChangeEntry {
                kind: "added",
                description: format!(
                    "\"{}\" now collects: {}",
                    js_display(new_type.title.as_ref()),
                    js_display(c.title.as_ref())
                ),
                details: None,
            });
        }

        for c in old_type
            .categories
            .iter()
            .filter(|c| !new_cat_keys.contains(&map_key(c.identifier.as_ref())))
        {
            changes.push(ChangeEntry {
                kind: "removed",
                // The NEW type's title, even though the category came from
                // the old one — Node reads `newType.title` in both loops.
                description: format!(
                    "\"{}\" no longer collects: {}",
                    js_display(new_type.title.as_ref()),
                    js_display(c.title.as_ref())
                ),
                details: None,
            });
        }
    }

    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Vec<TypeSnapshot> {
        serde_json::from_str(json).expect("fixture parses")
    }

    #[test]
    fn an_empty_diff_serialises_as_an_array_not_null() {
        let out = diff_snapshots(&[], &[]);
        assert_eq!(serde_json::to_string(&out).unwrap(), "[]");
    }

    #[test]
    fn added_type_carries_details_and_removed_type_does_not() {
        let new = parse(
            r#"[{"identifier":"T","title":"Label","categories":[{"identifier":"C","title":"Cat"}]}]"#,
        );
        let added = serde_json::to_string(&diff_snapshots(&[], &new)).unwrap();
        assert_eq!(
            added,
            r#"[{"type":"added","description":"New privacy label: \"Label\"","details":["Cat"]}]"#
        );

        let removed = serde_json::to_string(&diff_snapshots(&new, &[])).unwrap();
        // No `details` key at all — not `"details":null`.
        assert_eq!(
            removed,
            r#"[{"type":"removed","description":"Removed privacy label: \"Label\""}]"#
        );
    }

    #[test]
    fn an_added_type_with_no_categories_emits_an_empty_details_array() {
        let new = parse(r#"[{"identifier":"T","title":"Label","categories":[]}]"#);
        assert_eq!(
            serde_json::to_string(&diff_snapshots(&[], &new)).unwrap(),
            r#"[{"type":"added","description":"New privacy label: \"Label\"","details":[]}]"#
        );
    }

    #[test]
    fn a_duplicate_identifier_keeps_the_first_slot_and_the_last_value() {
        let new = parse(
            r#"[{"identifier":"DUP","title":"First","categories":[]},
                {"identifier":"OTHER","title":"Other","categories":[]},
                {"identifier":"DUP","title":"Second","categories":[]}]"#,
        );
        let out = diff_snapshots(&[], &new);
        let titles: Vec<&str> = out.iter().map(|c| c.description.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "New privacy label: \"Second\"",
                "New privacy label: \"Other\"",
            ],
            "the duplicate must collapse to one entry in the FIRST position with the LAST title"
        );
    }

    #[test]
    fn scalar_identifiers_of_different_types_do_not_collide() {
        let new = parse(
            r#"[{"identifier":1,"title":"Numeric","categories":[]},{"identifier":"1","title":"String","categories":[]}]"#,
        );
        assert_eq!(diff_snapshots(&[], &new).len(), 2);
    }

    #[test]
    fn a_missing_identifier_is_not_the_same_key_as_an_explicit_null() {
        let new = parse(
            r#"[{"title":"Absent","categories":[]},{"identifier":null,"title":"Null","categories":[]}]"#,
        );
        assert_eq!(
            diff_snapshots(&[], &new).len(),
            2,
            "undefined and null are distinct Map keys in JavaScript"
        );
    }

    #[test]
    fn reordering_alone_is_not_a_change() {
        let a = parse(
            r#"[{"identifier":"A","title":"Alpha","categories":[{"identifier":"C1","title":"One"},{"identifier":"C2","title":"Two"}]},{"identifier":"B","title":"Beta","categories":[]}]"#,
        );
        let b = parse(
            r#"[{"identifier":"B","title":"Beta","categories":[]},{"identifier":"A","title":"Alpha","categories":[{"identifier":"C2","title":"Two"},{"identifier":"C1","title":"One"}]}]"#,
        );
        assert!(diff_snapshots(&a, &b).is_empty());
    }

    #[test]
    fn js_display_matches_javascript_stringification() {
        assert_eq!(js_display(None), "undefined");
        assert_eq!(js_display(Some(&Value::Null)), "null");
        assert_eq!(js_display(Some(&serde_json::json!(true))), "true");
        assert_eq!(js_display(Some(&serde_json::json!("x"))), "x");
        assert_eq!(js_display(Some(&serde_json::json!(1))), "1");
        assert_eq!(js_display(Some(&serde_json::json!(2.5))), "2.5");
        // The one that catches a naive float formatter.
        assert_eq!(
            js_display(Some(&Value::Number(
                serde_json::Number::from_f64(1.0).unwrap()
            ))),
            "1"
        );
    }
}

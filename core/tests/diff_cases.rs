//! Differential test: replay `core/tests/fixtures/diff-cases.json` through
//! the Rust `diff_snapshots` and require BYTE-identical output.
//!
//! This is the only thing standing between a wrong `diffSnapshots` port and
//! a green build. The read-parity gate cannot help: every app the canned
//! seed creates has identical type/category membership across its baseline
//! and latest snapshots, so `/api/apps/{id}/since-install` answers
//! `"changes": []` for all ten of them and an empty-vec implementation
//! passes. See `core/src/server/diff.rs` for the full rationale.
//!
//! The fixture's `expected` values were produced by importing and CALLING
//! the real `diffSnapshots` from `lib/changelog.ts`
//! (`core/scripts/extract-diff-cases.mjs`), so there is no transcription
//! step to get wrong. Regenerate with `just parity-diff-cases`, which CI
//! also runs and fails on if the checked-in fixture has drifted — a change
//! to the Node diff that nobody ported gets caught there.
//!
//! Comparison is on the SERIALISED STRING, not on `Value`. `serde_json` is
//! built with `preserve_order`, so its `Map` is an `IndexMap`, and
//! `IndexMap`'s `PartialEq` ignores order — comparing `Value`s would silently
//! accept `{"description":…,"type":…}` for `{"type":…,"description":…}` and
//! miss exactly the class of bug this file exists to catch.

use privacytracker_core::server::diff::{diff_snapshots, TypeSnapshot};
use serde_json::Value;

const FIXTURE: &str = include_str!("fixtures/diff-cases.json");

#[test]
fn every_node_case_reproduces_byte_for_byte() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
    let cases = fixture["cases"].as_array().expect("fixture has cases[]");
    assert!(
        cases.len() >= 30,
        "the fixture looks truncated ({} cases); regenerate it with `just parity-diff-cases`",
        cases.len()
    );

    let mut failures: Vec<String> = Vec::new();

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let why = case["why"].as_str().unwrap_or("");

        let old: Result<Vec<TypeSnapshot>, _> = serde_json::from_value(case["old"].clone());
        let new: Result<Vec<TypeSnapshot>, _> = serde_json::from_value(case["new"].clone());

        // A case the Node function THROWS on. The upstream try/catch wraps
        // only JSON.parse, so the blob reaches diffSnapshots intact and the
        // route answers 500. This port must refuse the blob too — what it
        // must never do is default the missing field and answer as though
        // the data were fine.
        if let Some(kind) = case["throws"].as_str() {
            if old.is_ok() && new.is_ok() {
                failures.push(format!(
                    "── {name}\n   why: {why}\n   node: throws {kind}\n   rust: deserialised it happily and would answer as if the blob were valid"
                ));
            }
            continue;
        }

        let (Ok(old), Ok(new)) = (old, new) else {
            failures.push(format!(
                "── {name}\n   why: {why}\n   node: returned a diff\n   rust: refused to deserialise the snapshot"
            ));
            continue;
        };

        let actual = serde_json::to_string(&diff_snapshots(&old, &new)).expect("serialises");
        // Re-serialising the parsed expectation normalises whitespace only —
        // `preserve_order` keeps the key order the Node function emitted.
        let expected = serde_json::to_string(&case["expected"]).expect("serialises");

        if actual != expected {
            failures.push(format!(
                "── {name}\n   why: {why}\n   node: {expected}\n   rust: {actual}"
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} diff cases diverged from Node:\n\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
}

/// The fixture is only as good as its coverage. If someone trims it down to
/// the easy cases the test above still passes, so pin the hard ones by name.
#[test]
fn the_fixture_still_covers_the_cases_that_actually_catch_a_bad_port() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
    let names: Vec<&str> = fixture["cases"]
        .as_array()
        .expect("cases[]")
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();

    for required in [
        "added type with no categories",
        "several added types keep NEW array order",
        "several removed types keep OLD array order",
        "added, removed and modified together",
        "duplicate type identifier in the new snapshot",
        "missing identifier and explicit null identifier are distinct keys",
        "zero and negative zero are the SAME identifier",
        "throws: a type with no categories",
    ] {
        assert!(
            names.contains(&required),
            "the fixture no longer covers `{required}` — that case exists because a plausible \
             Rust implementation gets it wrong, so removing it removes the only signal"
        );
    }
}

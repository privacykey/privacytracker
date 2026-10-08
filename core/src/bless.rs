//! `PT_BLESS=1`: rewrite a Rust-owned replay fixture from what the core
//! does now.
//!
//! Since the Wayback redesign (docs/WAYBACK_IMPORT.md) the historical
//! import and the bulk Wayback runner are Rust-only, so three fixtures are
//! no longer recorded from Node: `history-cases.json` (replayed by
//! `scrape::history_tests`), `wayback-runner-cases.json`
//! (`server::wayback_runner_tests`) and `import-history-route-cases.json`,
//! the per-app import route (`server::imports_tests`). They are regression
//! fixtures the core owns. With `PT_BLESS=1` a replay still runs every case, then sets the
//! case's output keys (`calls`, `stream`, `rows`, `expected`) to what it
//! actually produced, leaves its inputs alone, writes the file back in the
//! format the Node extractors wrote (two-space JSON, keys in their existing
//! order, one trailing newline) and passes. A case written by hand with
//! inputs only gets its outputs appended. Unset, or set to anything else,
//! the replays compare as they always have.
//!
//! A blessed fixture pins what the code does now, right or wrong: review
//! every blessed diff before committing it.
use serde_json::Value;
use std::path::{Path, PathBuf};

/// One fixture's blessing, for one run of its replay.
pub(crate) struct Bless {
    path: PathBuf,
    /// The fixture being rewritten; `None` unless `PT_BLESS=1`.
    blessed: Option<Value>,
    next: usize,
    rewritten: Vec<String>,
}

impl Bless {
    /// `name` is the file under `core/tests/fixtures/`, `fixture` what the
    /// replay parsed from it.
    pub(crate) fn new(name: &str, fixture: &Value) -> Self {
        let on = std::env::var("PT_BLESS").is_ok_and(|v| v == "1");
        Self {
            path: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(name),
            blessed: on.then(|| fixture.clone()),
            next: 0,
            rewritten: vec![],
        }
    }

    /// Takes one replayed case's actual outputs. Called once per case, in
    /// fixture order; `case` is the fixture's own case, checked against the
    /// one expected next. A key the case has keeps its place, a new one goes
    /// last.
    pub(crate) fn record(&mut self, case: &Value, outputs: &[(&str, &Value)]) {
        let Some(fixture) = self.blessed.as_mut() else {
            return;
        };
        let slot = fixture["cases"][self.next]
            .as_object_mut()
            .expect("a fixture case is an object");
        assert_eq!(
            slot.get("name"),
            case.get("name"),
            "PT_BLESS: case {} recorded out of order",
            self.next
        );
        self.next += 1;
        let mut changed = false;
        for &(key, value) in outputs {
            if slot.get(key) != Some(value) {
                slot.insert(key.to_owned(), value.clone());
                changed = true;
            }
        }
        if changed {
            self.rewritten
                .push(case["name"].as_str().unwrap_or_default().to_owned());
        }
    }

    /// Writes the blessed fixture back when its text changed. True while
    /// blessing, so the replay skips its assertion.
    pub(crate) fn finish(self) -> bool {
        let Some(fixture) = self.blessed else {
            return false;
        };
        let cases = fixture["cases"].as_array().map_or(0, Vec::len);
        assert_eq!(
            self.next, cases,
            "PT_BLESS: the replay recorded {} of {cases} cases",
            self.next
        );
        let text = to_fixture_text(&fixture);
        if std::fs::read_to_string(&self.path).ok().as_deref() != Some(text.as_str()) {
            std::fs::write(&self.path, &text).unwrap();
        }
        eprintln!(
            "PT_BLESS: {} of {cases} cases rewritten in {}{}",
            self.rewritten.len(),
            self.path.display(),
            self.rewritten
                .iter()
                .map(|name| format!("\n  {name}"))
                .collect::<String>()
        );
        true
    }
}

/// `JSON.stringify(fixture, null, 2)` plus the newline the extractors
/// added. Both escape the same characters and keep key order (the crate's
/// serde_json has `preserve_order`), so a fixture they wrote round-trips
/// unchanged.
fn to_fixture_text(fixture: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(fixture).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Blessing a fixture the code still reproduces must not move a byte,
    /// or every bless would bury its real changes in reformatting.
    #[test]
    fn rust_owned_fixtures_are_in_blessed_form() {
        for (name, text) in [
            (
                "history-cases.json",
                include_str!("../tests/fixtures/history-cases.json"),
            ),
            (
                "wayback-runner-cases.json",
                include_str!("../tests/fixtures/wayback-runner-cases.json"),
            ),
            (
                "import-history-route-cases.json",
                include_str!("../tests/fixtures/import-history-route-cases.json"),
            ),
        ] {
            let fixture: Value = serde_json::from_str(text).unwrap();
            assert!(
                to_fixture_text(&fixture) == text,
                "{name} is not in the form PT_BLESS writes; bless it"
            );
        }
    }

    #[test]
    fn outputs_are_replaced_in_place_and_missing_ones_appended() {
        let dir = std::env::temp_dir().join(format!("pt-bless-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fixture = json!({"cases": [
            {"name": "kept", "replies": [1], "calls": [], "expected": {"ok": true}},
            {"name": "changed", "replies": [2], "calls": [], "expected": {"ok": true}},
            {"name": "new", "replies": [3]},
        ]});
        let mut bless = Bless {
            path: dir.join("cases.json"),
            blessed: Some(fixture.clone()),
            next: 0,
            rewritten: vec![],
        };
        let cases = fixture["cases"].as_array().unwrap();
        let (calls, ok, failed) = (json!([]), json!({"ok": true}), json!({"ok": false}));
        bless.record(&cases[0], &[("calls", &calls), ("expected", &ok)]);
        bless.record(&cases[1], &[("calls", &calls), ("expected", &failed)]);
        bless.record(&cases[2], &[("calls", &calls), ("expected", &ok)]);
        assert_eq!(bless.rewritten, ["changed", "new"]);
        let path = bless.path.clone();
        assert!(bless.finish());
        let written = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        // The text carries key order: the new case's outputs come last.
        let expected = json!({"cases": [
            {"name": "kept", "replies": [1], "calls": [], "expected": {"ok": true}},
            {"name": "changed", "replies": [2], "calls": [], "expected": {"ok": false}},
            {"name": "new", "replies": [3], "calls": [], "expected": {"ok": true}},
        ]});
        assert_eq!(written, to_fixture_text(&expected));
    }

    #[test]
    fn an_unblessed_run_writes_nothing() {
        let bless = Bless {
            path: PathBuf::from("/nonexistent/pt-bless/cases.json"),
            blessed: None,
            next: 0,
            rewritten: vec![],
        };
        assert!(!bless.finish());
    }
}

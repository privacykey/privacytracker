//! Port of the `app.policyAnalysis` hydration from `lib/privacy-policy.ts`:
//! `getPolicyAnalysis` → `getPolicyAnalysisRow` → `hydratePolicyAnalysis`
//! and the normalisers under it, plus `getArchiveUrlForHash` from
//! `lib/policy-versions.ts`.
//!
//! This is the densest present-null-vs-absent surface in the API. Of the
//! twenty keys in `hydratePolicyAnalysis`'s return literal, TWELVE are
//! `?? undefined` — `JSON.stringify` drops them when the column is NULL —
//! while `summary` and `previousSummary` are present-null and `updatedAt`
//! is the raw column even when that is null. Every field below says which.
//! A blanket `skip_serializing_if` or a blanket "emit null" both diverge on
//! ten of the twenty.
//!
//! Everything is built as `serde_json::Map` in literal order rather than as
//! structs, because half the keys are conditional and their POSITION when
//! present is fixed — a struct with `skip_serializing_if` reproduces that,
//! but the conditions here read the row three different ways (`??`,
//! truthiness, strict equality) and a map makes each one explicit.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

use super::row::row_to_json;
use crate::jsnum::{js_number, js_to_number};
use crate::jsstr::{clean_sentence, js_length, js_slice_prefix};

const SOURCE_PREVIEW_CHARS: usize = 6000;

/// `POLICY_LENSES` from `lib/policy-summary-meta.ts`, in its order — the
/// summary always emits all eight, in this order, whatever was stored.
const POLICY_LENSES: [&str; 8] = [
    "collection_scope",
    "product_use",
    "ads_marketing",
    "third_party_sharing",
    "tracking_analytics",
    "user_controls",
    "data_retention",
    "children_minors",
];
const POLICY_ANALYSIS_STATUSES: [&str; 7] = [
    "ready",
    "source_ready",
    "needs_ai_config",
    "fetch_error",
    "unsupported_content_type",
    "too_short",
    "analysis_error",
];
const POLICY_SOURCE_ORIGINS: [&str; 3] = ["direct", "browser_retry", "wayback"];
const POLICY_RATINGS: [&str; 4] = ["favorable", "mixed", "concerning", "unclear"];

const DEFAULT_LENS_SUMMARY: &str = "The policy does not address this clearly.";
const DEFAULT_OVERVIEW: &str =
    "This AI summary highlights how the developer says it collects, uses, shares, and retains customer data.";

/// `getPolicyAnalysisRow`: `SELECT * FROM privacy_policy_analyses WHERE
/// app_id = ?`, `?? null`.
fn get_policy_analysis_row(conn: &Connection, app_id: &str) -> rusqlite::Result<Option<Value>> {
    conn.query_row(
        "SELECT * FROM privacy_policy_analyses WHERE app_id = ?",
        [app_id],
        row_to_json,
    )
    .optional()
}

/// `getPolicyAnalysis(appId)`: `row ? hydratePolicyAnalysis(row) : null`.
pub fn get_policy_analysis(conn: &Connection, app_id: &str) -> rusqlite::Result<Value> {
    match get_policy_analysis_row(conn, app_id)? {
        None => Ok(Value::Null),
        Some(row) => hydrate_policy_analysis(conn, app_id, &row),
    }
}

// ── the JS reads, named after the operator they use ──────────────────

/// `row.x` — the raw column, null included. Missing column → null too, which
/// is what `undefined` becomes on the wire in the one place it is used raw.
fn raw(row: &Value, col: &str) -> Value {
    row.get(col).cloned().unwrap_or(Value::Null)
}

/// `row.x ?? undefined`: `Some` only when the column is neither null nor
/// absent. Empty strings and zeros are NOT nullish and survive.
fn coalesce(row: &Value, col: &str) -> Option<Value> {
    match row.get(col) {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.clone()),
    }
}

/// JS truthiness on a column.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn as_str(v: &Value) -> Option<&str> {
    v.as_str()
}

/// `LIST.find(x => x === value) ?? null` — strict, so only an exact string.
fn allowlisted<'a>(list: &[&'a str], v: &Value) -> Option<&'a str> {
    let s = v.as_str()?;
    list.iter().copied().find(|x| *x == s)
}

fn hydrate_policy_analysis(
    conn: &Connection,
    app_id: &str,
    row: &Value,
) -> rusqlite::Result<Value> {
    // Chunk notes surface only when captured against the CURRENT source
    // text: `storedNotes && row.chunk_notes_hash && row.chunk_notes_hash ===
    // (row.content_hash ?? "")`. The hash must be truthy AND strictly equal
    // to content_hash-or-"" — so with a null content_hash it can never match.
    let stored_notes = parse_stored_chunk_notes(&raw(row, "chunk_notes_json"));
    let chunk_notes = match (stored_notes, row.get("chunk_notes_hash")) {
        (Some(notes), Some(hash)) if truthy(hash) => {
            let content = coalesce(row, "content_hash").unwrap_or_else(|| Value::from(""));
            if *hash == content {
                Some(notes)
            } else {
                None
            }
        }
        _ => None,
    };

    let mut out = Map::new();

    // status: normalizeStatus(row.status) ?? "analysis_error" — always present.
    out.insert(
        "status".into(),
        Value::from(
            allowlisted(&POLICY_ANALYSIS_STATUSES, &raw(row, "status")).unwrap_or("analysis_error"),
        ),
    );
    // sourceTitle: ?? undefined
    if let Some(v) = coalesce(row, "source_title") {
        out.insert("sourceTitle".into(), v);
    }
    // sourceWordCount: Number(row.source_word_count ?? 0) — always present.
    // `Number("abc")` is NaN and JSON.stringify(NaN) is null, so a garbage
    // text column comes out as null rather than 0.
    let word_count = coalesce(row, "source_word_count").unwrap_or(Value::from(0));
    out.insert(
        "sourceWordCount".into(),
        js_number(js_to_number(&word_count)),
    );
    // sourceOrigin: normalizeSourceOrigin(…) ?? undefined
    if let Some(o) = allowlisted(&POLICY_SOURCE_ORIGINS, &raw(row, "source_origin")) {
        out.insert("sourceOrigin".into(), Value::from(o));
    }
    // sourceFinalUrl: ?? undefined
    if let Some(v) = coalesce(row, "source_final_url") {
        out.insert("sourceFinalUrl".into(), v);
    }
    // updatedAt: RAW — present even when null. Not `?? undefined`.
    out.insert("updatedAt".into(), raw(row, "updated_at"));
    // sourceFetchedAt: ?? undefined
    if let Some(v) = coalesce(row, "source_fetched_at") {
        out.insert("sourceFetchedAt".into(), v);
    }
    // analysisMode: only the two literals; anything else absent.
    if let Some(m) =
        as_str(&raw(row, "analysis_mode")).filter(|m| *m == "direct" || *m == "chunked")
    {
        out.insert("analysisMode".into(), Value::from(m));
    }
    // model: ?? undefined
    if let Some(v) = coalesce(row, "model") {
        out.insert("model".into(), v);
    }
    // summary / previousSummary: TRUTHINESS on the column — an empty string
    // is null here, not a parse attempt — and present-null otherwise.
    out.insert("summary".into(), summary_or_null(&raw(row, "summary_json")));
    out.insert(
        "previousSummary".into(),
        summary_or_null(&raw(row, "previous_summary_json")),
    );
    // previousSummaryAt / error: ?? undefined
    if let Some(v) = coalesce(row, "previous_summary_at") {
        out.insert("previousSummaryAt".into(), v);
    }
    if let Some(v) = coalesce(row, "error") {
        out.insert("error".into(), v);
    }
    // sourcePreview: truthy text → first 6000 UTF-16 units; else ABSENT.
    // sourceLength: truthy text → its UTF-16 length; else 0. Always present.
    let source_text = raw(row, "source_text");
    match as_str(&source_text).filter(|s| !s.is_empty()) {
        Some(text) => {
            out.insert(
                "sourcePreview".into(),
                Value::from(js_slice_prefix(text, SOURCE_PREVIEW_CHARS)),
            );
            out.insert("sourceLength".into(), Value::from(js_length(text) as i64));
        }
        None => {
            out.insert("sourceLength".into(), Value::from(0));
        }
    }
    // lastRunLog: parseRunLog returns undefined (absent) or an array — and
    // that array can legitimately be empty and still present.
    if let Some(log) = parse_run_log(&raw(row, "last_run_log")) {
        out.insert("lastRunLog".into(), Value::Array(log));
    }
    // archiveUrl: getArchiveUrlForHash(...) ?? undefined
    if let Some(url) = get_archive_url_for_hash(conn, app_id, &raw(row, "content_hash"))? {
        out.insert("archiveUrl".into(), url);
    }
    // chunkNotes: conditional, computed above.
    if let Some(notes) = chunk_notes {
        out.insert("chunkNotes".into(), Value::Array(notes));
    }
    // runStatus: literally "running", else "idle". Always present.
    out.insert(
        "runStatus".into(),
        Value::from(if as_str(&raw(row, "run_status")) == Some("running") {
            "running"
        } else {
            "idle"
        }),
    );
    // runStartedAt: ?? undefined
    if let Some(v) = coalesce(row, "run_started_at") {
        out.insert("runStartedAt".into(), v);
    }

    Ok(Value::Object(out))
}

/// `row.x ? safeParseSummary(row.x) : null`.
fn summary_or_null(col: &Value) -> Value {
    match as_str(col).filter(|s| !s.is_empty()) {
        Some(json) => safe_parse_summary(json),
        None => Value::Null,
    }
}

/// `safeParseSummary`: a parse FAILURE is null; any parsed value — including
/// a number or a string — goes through `normalizePolicySummary`, whose
/// optional chaining turns a non-object into the all-defaults summary.
fn safe_parse_summary(json: &str) -> Value {
    match serde_json::from_str::<Value>(json) {
        Ok(v) => normalize_policy_summary(&v),
        Err(_) => Value::Null,
    }
}

/// `uniqueStrings`: trim, then Set-dedupe (FIRST occurrence's position),
/// then drop empties.
fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for v in values {
        let t = v.trim_matches(crate::jsstr::is_js_whitespace).to_string();
        if t.is_empty() || !seen.insert(t.clone()) {
            continue;
        }
        out.push(t);
    }
    out
}

fn normalize_policy_summary(input: &Value) -> Value {
    // `input?.lenses` — `?.` on a non-object yields undefined, not a throw.
    let lens_entries: Vec<Value> = match input.get("lenses") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    // Map<key, {rating, summary}> — last entry for a key wins, position is
    // irrelevant because the output walks POLICY_LENSES, not the map.
    let mut by_key: std::collections::HashMap<&str, (&str, String)> =
        std::collections::HashMap::new();
    for entry in &lens_entries {
        let Some(key) = entry
            .get("key")
            .and_then(|k| allowlisted(&POLICY_LENSES, k))
        else {
            continue;
        };
        let rating = entry
            .get("rating")
            .and_then(|r| allowlisted(&POLICY_RATINGS, r))
            .unwrap_or("unclear");
        // `cleanSentence(x) || default` — `||`, so an empty cleaned string
        // takes the default.
        let summary = match clean_sentence(entry.get("summary")) {
            s if s.is_empty() => DEFAULT_LENS_SUMMARY.to_string(),
            s => s,
        };
        by_key.insert(key, (rating, summary));
    }

    let lenses: Vec<Value> = POLICY_LENSES
        .iter()
        .map(|key| {
            let (rating, summary) = by_key
                .get(key)
                .map(|(r, s)| (*r, s.clone()))
                .unwrap_or(("unclear", DEFAULT_LENS_SUMMARY.to_string()));
            let mut m = Map::new();
            m.insert("key".into(), Value::from(*key));
            m.insert("rating".into(), Value::from(rating));
            m.insert("summary".into(), Value::from(summary));
            Value::Object(m)
        })
        .collect();

    // highlights: clean → drop empties → uniqueStrings → first 5; then pad
    // from the lenses' summaries, indexed by CURRENT LENGTH, until there are
    // three. The pad path does not dedupe against what is already there.
    let mut highlights: Vec<String> = match input.get("highlights") {
        Some(Value::Array(items)) => unique_strings(
            items
                .iter()
                .map(|i| clean_sentence(Some(i)))
                .filter(|s| !s.is_empty()),
        )
        .into_iter()
        .take(5)
        .collect(),
        _ => Vec::new(),
    };
    while highlights.len() < 3 {
        let Some(candidate) = lenses
            .get(highlights.len())
            .and_then(|l| l.get("summary"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            break;
        };
        highlights.push(candidate.to_string());
    }

    let external_references = normalize_external_references(input.get("externalReferences"));
    let safety_summary = normalize_safety_summary(input.get("safetySummary"));

    let mut out = Map::new();
    // `cleanSentence(x)?.slice(0, 320) || default` — an empty cleaned string
    // is falsy and takes the default.
    let overview = js_slice_prefix(&clean_sentence(input.get("overview")), 320);
    out.insert(
        "overview".into(),
        Value::from(if overview.is_empty() {
            DEFAULT_OVERVIEW.to_string()
        } else {
            overview
        }),
    );
    out.insert(
        "highlights".into(),
        Value::Array(highlights.into_iter().map(Value::from).collect()),
    );
    out.insert("lenses".into(), Value::Array(lenses));
    // Both spreads are CONDITIONAL: absent, not empty/null, when they have
    // nothing to say.
    if !external_references.is_empty() {
        out.insert(
            "externalReferences".into(),
            Value::Array(external_references),
        );
    }
    if let Some(safety) = safety_summary {
        out.insert("safetySummary".into(), safety);
    }
    Value::Object(out)
}

fn normalize_external_references(value: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            if !item.is_object() {
                return None;
            }
            let source = item.get("source").and_then(Value::as_str)?;
            if source != "privacyspy" && source != "tosdr" {
                return None;
            }
            let label = clean_sentence(item.get("label"));
            let url = clean_sentence(item.get("url"));
            let summary = clean_sentence(item.get("summary"));
            let score_label = clean_sentence(item.get("scoreLabel"));
            if label.is_empty() || url.is_empty() || summary.is_empty() {
                return None;
            }
            let mut m = Map::new();
            m.insert("source".into(), Value::from(source));
            m.insert("label".into(), Value::from(label));
            m.insert("url".into(), Value::from(url));
            m.insert("summary".into(), Value::from(summary));
            if !score_label.is_empty() {
                m.insert("scoreLabel".into(), Value::from(score_label));
            }
            Some(Value::Object(m))
        })
        .collect()
}

/// `undefined` (absent) unless the input is an object with a non-empty
/// cleaned paragraph. `concerns` is always present when the object is,
/// even as `[]`.
fn normalize_safety_summary(input: Option<&Value>) -> Option<Value> {
    let input = input.filter(|v| v.is_object())?;
    let paragraph = clean_sentence(input.get("paragraph"));
    if paragraph.is_empty() {
        return None;
    }
    let concerns: Vec<String> = match input.get("concerns") {
        Some(Value::Array(items)) => unique_strings(
            items
                .iter()
                .map(|i| clean_sentence(Some(i)))
                .filter(|s| !s.is_empty()),
        )
        .into_iter()
        .take(5)
        .collect(),
        _ => Vec::new(),
    };
    let mut m = Map::new();
    m.insert(
        "paragraph".into(),
        Value::from(js_slice_prefix(&paragraph, 1400)),
    );
    m.insert(
        "concerns".into(),
        Value::Array(concerns.into_iter().map(Value::from).collect()),
    );
    Some(Value::Object(m))
}

/// `parseRunLog`: `undefined` (absent) on a falsy column, a parse error, or
/// a non-array — but a valid EMPTY array is present as `[]`. Entries keep
/// `{phase, at}` and add `note`/`error` when they are strings (even empty
/// ones) and `ms` when it is a finite number.
fn parse_run_log(col: &Value) -> Option<Vec<Value>> {
    let raw = as_str(col).filter(|s| !s.is_empty())?;
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    Some(
        items
            .iter()
            .filter_map(|entry| {
                if !entry.is_object() {
                    return None;
                }
                let phase = entry
                    .get("phase")
                    .and_then(Value::as_str)
                    .filter(|p| !p.is_empty())?;
                // `Number(entry.at)`, then Number.isFinite.
                let at = js_to_number(entry.get("at").unwrap_or(&Value::Null));
                if !at.is_finite() {
                    return None;
                }
                let mut m = Map::new();
                m.insert("phase".into(), Value::from(phase));
                m.insert("at".into(), js_number(at));
                if let Some(Value::String(note)) = entry.get("note") {
                    m.insert("note".into(), Value::from(note.as_str()));
                }
                if let Some(Value::String(err)) = entry.get("error") {
                    m.insert("error".into(), Value::from(err.as_str()));
                }
                if let Some(Value::Number(ms)) = entry.get("ms") {
                    if ms.as_f64().is_some_and(f64::is_finite) {
                        m.insert("ms".into(), Value::Number(ms.clone()));
                    }
                }
                Some(Value::Object(m))
            })
            .collect(),
    )
}

/// `parseStoredChunkNotes`: null on a falsy column, parse error, non-array
/// or NO usable entries. Non-object entries are skipped; a non-string
/// summary becomes `""` rather than skipping the note.
fn parse_stored_chunk_notes(col: &Value) -> Option<Vec<Value>> {
    let raw = as_str(col).filter(|s| !s.is_empty())?;
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    let notes: Vec<Value> = items
        .iter()
        .filter(|e| e.is_object())
        .map(|entry| {
            let summary = entry.get("summary").and_then(Value::as_str).unwrap_or("");
            let highlights: Vec<Value> = match entry.get("highlights") {
                Some(Value::Array(hs)) => hs
                    .iter()
                    .filter_map(|h| h.as_str().filter(|s| !s.is_empty()))
                    .map(Value::from)
                    .collect(),
                _ => Vec::new(),
            };
            let mut m = Map::new();
            m.insert("summary".into(), Value::from(summary));
            m.insert("highlights".into(), Value::Array(highlights));
            Value::Object(m)
        })
        .collect();
    if notes.is_empty() {
        None
    } else {
        Some(notes)
    }
}

/// `getArchiveUrlForHash`: null on a falsy hash WITHOUT querying; otherwise
/// `LIMIT 1` with no ORDER BY — planner order decides which row wins if
/// several share a hash.
fn get_archive_url_for_hash(
    conn: &Connection,
    app_id: &str,
    content_hash: &Value,
) -> rusqlite::Result<Option<Value>> {
    let Some(hash) = as_str(content_hash).filter(|h| !h.is_empty()) else {
        return Ok(None);
    };
    let url: Option<Value> = conn
        .query_row(
            "SELECT archive_url FROM privacy_policy_versions \
              WHERE app_id = ? AND content_hash = ? \
              LIMIT 1",
            [app_id, hash],
            |row| super::row::column(row, "archive_url"),
        )
        .optional()?;
    // `row?.archive_url ?? null` — a row whose url is NULL is null too.
    Ok(url.filter(|u| !u.is_null()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn keys(v: &Value) -> Vec<&str> {
        v.as_object().unwrap().keys().map(String::as_str).collect()
    }

    #[test]
    fn a_minimal_row_emits_exactly_the_always_present_keys_in_order() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE privacy_policy_versions (app_id TEXT, content_hash TEXT, archive_url TEXT);").unwrap();
        // Every nullable column null: the twelve `?? undefined` keys vanish.
        let row = json!({
            "app_id": "1", "status": null, "source_title": null, "source_word_count": null,
            "source_origin": null, "source_final_url": null, "updated_at": null,
            "source_fetched_at": null, "analysis_mode": null, "model": null,
            "summary_json": null, "previous_summary_json": null, "previous_summary_at": null,
            "error": null, "source_text": null, "last_run_log": null, "content_hash": null,
            "chunk_notes_json": null, "chunk_notes_hash": null, "run_status": null,
            "run_started_at": null
        });
        let out = hydrate_policy_analysis(&c, "1", &row).unwrap();
        assert_eq!(
            keys(&out),
            [
                "status",
                "sourceWordCount",
                "updatedAt",
                "summary",
                "previousSummary",
                "sourceLength",
                "runStatus"
            ]
        );
        assert_eq!(out["status"], "analysis_error");
        assert_eq!(out["sourceWordCount"], 0);
        assert_eq!(out["updatedAt"], Value::Null, "raw column, present-null");
        assert_eq!(out["summary"], Value::Null);
        assert_eq!(out["sourceLength"], 0);
        assert_eq!(out["runStatus"], "idle");
    }

    #[test]
    fn empty_strings_are_not_nullish_but_are_falsy() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE privacy_policy_versions (app_id TEXT, content_hash TEXT, archive_url TEXT);").unwrap();
        let row = json!({
            "app_id": "1", "source_title": "", "source_text": "", "summary_json": "",
            "model": "", "last_run_log": "", "updated_at": 5
        });
        let out = hydrate_policy_analysis(&c, "1", &row).unwrap();
        // `??` keeps "" (sourceTitle, model present as ""), truthiness drops it
        // (no sourcePreview, summary null, no lastRunLog, sourceLength 0).
        assert_eq!(out["sourceTitle"], "");
        assert_eq!(out["model"], "");
        assert!(out.get("sourcePreview").is_none());
        assert_eq!(out["sourceLength"], 0);
        assert_eq!(out["summary"], Value::Null);
        assert!(out.get("lastRunLog").is_none());
    }

    #[test]
    fn summary_normalisation_pads_highlights_and_emits_all_eight_lenses() {
        let s = normalize_policy_summary(&json!({
            "overview": "  Collects   a lot.  ",
            "highlights": ["  one ", "one", "", 7],
            "lenses": [
                {"key": "user_controls", "rating": "mixed", "summary": " you  can opt out "},
                {"key": "bogus", "rating": "favorable", "summary": "ignored"},
                {"key": "ads_marketing", "rating": "nope", "summary": ""}
            ]
        }));
        assert_eq!(keys(&s), ["overview", "highlights", "lenses"]);
        assert_eq!(s["overview"], "Collects a lot.");
        // "one" deduped to one entry, then padded from lenses[1] and
        // lenses[2] — indexed by current length, not by lens order of
        // relevance.
        assert_eq!(
            s["highlights"],
            json!(["one", DEFAULT_LENS_SUMMARY, DEFAULT_LENS_SUMMARY])
        );
        let lenses = s["lenses"].as_array().unwrap();
        assert_eq!(lenses.len(), 8);
        assert_eq!(lenses[0]["key"], "collection_scope");
        assert_eq!(lenses[2]["key"], "ads_marketing");
        // Unknown rating → "unclear"; empty summary → default via `||`.
        assert_eq!(lenses[2]["rating"], "unclear");
        assert_eq!(lenses[2]["summary"], DEFAULT_LENS_SUMMARY);
        assert_eq!(lenses[5]["rating"], "mixed");
        assert_eq!(lenses[5]["summary"], "you can opt out");
    }

    #[test]
    fn a_parsed_non_object_summary_is_the_defaults_not_null() {
        // JSON.parse("42") succeeds; `input?.lenses` is undefined, not a throw.
        let s = safe_parse_summary("42");
        assert_eq!(s["overview"], DEFAULT_OVERVIEW);
        assert_eq!(s["highlights"].as_array().unwrap().len(), 3);
        // Only a parse FAILURE is null.
        assert_eq!(safe_parse_summary("{not json"), Value::Null);
    }

    #[test]
    fn external_references_and_safety_are_absent_unless_populated() {
        let s = normalize_policy_summary(&json!({
            "externalReferences": [
                {"source": "tosdr", "label": " L ", "url": "u", "summary": "s", "scoreLabel": ""},
                {"source": "other", "label": "L", "url": "u", "summary": "s"},
                {"source": "privacyspy", "label": "", "url": "u", "summary": "s"},
                "not an object"
            ],
            "safetySummary": {"paragraph": "  p  ", "concerns": ["a", " a", "", 3, "b"]}
        }));
        assert_eq!(
            keys(&s),
            [
                "overview",
                "highlights",
                "lenses",
                "externalReferences",
                "safetySummary"
            ]
        );
        let refs = s["externalReferences"].as_array().unwrap();
        assert_eq!(
            refs.len(),
            1,
            "wrong source, empty label and non-object all dropped"
        );
        assert_eq!(
            keys(&refs[0]),
            ["source", "label", "url", "summary"],
            "empty scoreLabel omitted"
        );
        assert_eq!(
            s["safetySummary"],
            json!({"paragraph": "p", "concerns": ["a", "b"]})
        );

        let none = normalize_policy_summary(&json!({"safetySummary": {"paragraph": "   "}}));
        assert_eq!(keys(&none), ["overview", "highlights", "lenses"]);
    }

    #[test]
    fn run_log_entries_keep_only_well_formed_phases() {
        let log = parse_run_log(&json!(
            r#"[{"phase":"fetch","at":"1700000000000","note":"","ms":12.5},
                {"phase":"","at":1},{"at":1},{"phase":"x","at":"abc"},7,
                {"phase":"done","at":2,"error":"boom","ms":"fast"}]"#
        ))
        .expect("array");
        assert_eq!(log.len(), 2);
        // Number("1700000000000") coerces; note "" is a string and kept.
        assert_eq!(
            log[0],
            json!({"phase":"fetch","at":1700000000000i64,"note":"","ms":12.5})
        );
        // ms "fast" is not a number → omitted; error kept.
        assert_eq!(log[1], json!({"phase":"done","at":2,"error":"boom"}));
        // An empty array is PRESENT, a non-array is absent.
        assert_eq!(parse_run_log(&json!("[]")), Some(Vec::new()));
        assert_eq!(parse_run_log(&json!("{}")), None);
        assert_eq!(parse_run_log(&json!("")), None);
    }

    #[test]
    fn chunk_notes_need_a_truthy_hash_that_matches_the_content_hash() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE privacy_policy_versions (app_id TEXT, content_hash TEXT, archive_url TEXT);").unwrap();
        let base = json!({"app_id":"1","updated_at":0,"chunk_notes_json":r#"[{"summary":"s","highlights":["h",""]},"junk"]"#});
        let with = |hash: Value, content: Value| {
            let mut r = base.clone();
            r["chunk_notes_hash"] = hash;
            r["content_hash"] = content;
            hydrate_policy_analysis(&c, "1", &r).unwrap()
        };
        assert_eq!(
            with(json!("abc"), json!("abc"))["chunkNotes"],
            json!([{"summary":"s","highlights":["h"]}])
        );
        assert!(with(json!("abc"), json!("zzz")).get("chunkNotes").is_none());
        // Null content_hash coalesces to "" — which a truthy hash never equals.
        assert!(with(json!("abc"), Value::Null).get("chunkNotes").is_none());
        assert!(
            with(json!(""), json!("")).get("chunkNotes").is_none(),
            "empty hash is falsy"
        );
    }

    #[test]
    fn archive_url_is_absent_for_a_falsy_hash_without_a_query_and_for_a_null_url() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE privacy_policy_versions (app_id TEXT, content_hash TEXT, archive_url TEXT);
             INSERT INTO privacy_policy_versions VALUES ('1','h1','https://a'), ('1','h2',NULL);",
        )
        .unwrap();
        assert_eq!(
            get_archive_url_for_hash(&c, "1", &json!("h1")).unwrap(),
            Some(json!("https://a"))
        );
        assert_eq!(
            get_archive_url_for_hash(&c, "1", &json!("h2")).unwrap(),
            None
        );
        assert_eq!(get_archive_url_for_hash(&c, "1", &json!("")).unwrap(), None);
        assert_eq!(
            get_archive_url_for_hash(&c, "1", &Value::Null).unwrap(),
            None
        );
    }
}

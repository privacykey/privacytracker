//! Phase 4, batch 5d: `POST /api/dev/seed-sample-data` — the route that
//! gives a fresh install something to look at. Two modes, the Node route
//! in order, gated by `core/tests/fixtures/seed-cases.json`.
//!
//! **Canned** (`?source=canned`) writes the ten-app demo set in one
//! transaction: the app, its declared accessibility features resolved
//! against the catalogue, a hand-written policy summary stored as a real
//! `ready` analysis (and, where the fixture has an earlier one, the two
//! policy versions that make the change banner render), the labels, and a
//! back-dated timeline diffed step by step. The set itself is DATA —
//! `sample_apps.json`, written by the oracle from `lib/sample-apps.ts` and
//! held current by CI — and everything done with it is ported here.
//!
//! **Live** asks the iTunes top-free chart for a region, then runs each
//! entry through the same `fetch_and_parse_app` an import uses, adds two
//! back-dated snapshots so the timeline has history, and waits 250 ms
//! before the next. Apple's rate limit stops the walk and keeps what it
//! has. The connection is taken per section, as in the import pipeline.
//!
//! One thing is not here. Node scrapes with `summarizePolicies` on, so
//! each new app then goes through the policy pipeline — fetch the
//! developer's page, hash it, summarise it. That pipeline is Phase 5. The
//! one branch of it that is a plain write is ported: an app with no
//! policy link has its analysis row deleted, as Node's first line does.
//! An app WITH a link gets nothing further here, where Node would go on
//! to fetch it.
use super::{
    activity_log::record_activity,
    diff::{diff_snapshots, CategorySnapshot, ChangeEntry, TypeSnapshot},
    grid_meta::category_label,
    guard::{record_audit, Actor},
    imports_writes::transaction,
    json::{json_ok, json_response},
    settings::get_setting_with,
    sync_runner::clock_for,
    writes::{Cx, RouteSpec, WriteRequest},
};
use crate::{
    jsnum::js_parse_int,
    jsstr::{is_js_whitespace, js_encode_uri_component, js_trim},
    outbound::{Fetcher, Request},
    scrape::{
        fetch::fetch_and_parse_app,
        history::{snapshot_json, INSERT_SNAPSHOT},
        persist::{build_snapshot, DbAccess, Ids, Writer},
        region::normalize_country,
    },
};
use axum::{
    http::{header, HeaderValue, StatusCode},
    response::Response,
};
use ring::digest;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{sync::OnceLock, time::Duration};

// ── The SQL, verbatim from the route ─────────────────────────────────
const APP_EXISTS: &str = "SELECT 1 FROM apps WHERE id = ?";
const INSERT_APP: &str = "INSERT INTO apps (\n           id, name, url, iconUrl, bundleId, developer, privacyPolicyUrl,\n           firstSeen, lastSynced, changeCount,\n           changes_acknowledged_at, changes_snoozed_until,\n           hasPrivacyDetails, hasAccessibilityLabels\n         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const INSERT_FEATURE: &str = "INSERT INTO accessibility_features\n               (id, app_id, identifier, title, description, icon_template)\n             VALUES (?, ?, ?, ?, ?, ?)";
const INSERT_ANALYSIS: &str = "INSERT INTO privacy_policy_analyses (\n       app_id, policy_url, status,\n       source_title, source_content_type, source_text, source_word_count,\n       source_origin, source_final_url, content_hash,\n       analysis_mode, summary_json,\n       previous_summary_json, previous_summary_at,\n       model, updated_at, source_fetched_at\n     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const INSERT_VERSION: &str = "INSERT INTO privacy_policy_versions (\n         id, app_id, content_hash, first_fetched_at, last_fetched_at,\n         policy_url, source_final_url, source_title, source_content_type,\n         source_origin, source_word_count, source_text\n       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const INSERT_TYPE: &str =
    "INSERT INTO privacy_types (id, app_id, identifier, title)\n           VALUES (?, ?, ?, ?)";
const INSERT_CATEGORY: &str = "INSERT INTO privacy_categories (id, type_id, identifier, title)\n             VALUES (?, ?, ?, ?)";
/// The first line of `syncPrivacyPolicyAnalysis`, for an app with no link.
const CLEAR_ANALYSIS: &str = "DELETE FROM privacy_policy_analyses WHERE app_id = ?";

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Australia: what the people who run this route see on their own phones.
const DEFAULT_DEV_REGION: &str = "au";
const SEED_MAX_LIMIT: i64 = 25;
const SEED_DEFAULT_LIMIT: i64 = 10;
/// Between live scrapes, so a seed never looks like a burst to Apple. The
/// replay does not wait, as it does not read the wall clock.
fn per_app_delay() -> Duration {
    Duration::from_millis(if cfg!(test) { 0 } else { 250 })
}
const CANNED_HINT: &str = "Try `?source=canned` to seed the canned SAMPLE_APPS instead, or pick a different `?country=<iso2>`.";

pub(super) fn handles(spec: &RouteSpec) -> bool {
    spec.path == "/api/dev/seed-sample-data"
}

// ── The demo set ─────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Table {
    /// `POLICY_LENSES`, in order: a summary lists its lenses in this order
    /// whatever order the fixture rated them in.
    lens_order: Vec<String>,
    /// `SAMPLE_LENS_NOTE_BY_RATING`.
    lens_notes: Map<String, Value>,
    /// `CANONICAL_ACCESSIBILITY_FEATURES`.
    accessibility: Vec<Canonical>,
    apps: Vec<Sample>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Canonical {
    identifier: String,
    title: String,
    fallback_description: String,
    icon_template: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    id: String,
    name: String,
    developer: String,
    has_privacy_details: bool,
    has_accessibility_labels: bool,
    accessibility_features: Option<Vec<String>>,
    privacy_types: Vec<SampleType>,
    ai_summary: Summary,
    ai_summary_previous: Option<Summary>,
    history: Vec<Step>,
}

#[derive(Deserialize)]
struct SampleType {
    identifier: String,
    title: String,
    /// `CATEGORY_META` keys, not titles.
    categories: Vec<String>,
}

#[derive(Deserialize)]
struct Summary {
    paragraph: String,
    highlights: Vec<String>,
    /// Lens key → rating.
    lenses: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    days_ago: i64,
    privacy_types: Vec<SampleType>,
    version: Option<String>,
    wayback_url: Option<String>,
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(include_str!("sample_apps.json"))
            .expect("sample_apps.json is written by the seed oracle")
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(text: &str) -> String {
    hex(digest::digest(&digest::SHA256, text.as_bytes()).as_ref())
}

/// `syntheticIdFor`: a stable eight-digit id from the fixture's slug,
/// starting with a 9 so it cannot be mistaken for a real track id. SHA-1
/// because that is what Node's ids were minted with; nothing rests on it.
fn synthetic_id_for(slug: &str) -> String {
    let hash = hex(digest::digest(&digest::SHA1_FOR_LEGACY_USE_ONLY, slug.as_bytes()).as_ref());
    let numeric = u32::from_str_radix(&hash[..6], 16).unwrap_or(0) % 9_000_000;
    format!("9{numeric:07}")
}

/// `sample.id.replace(/^sample-/, "")`.
fn short_slug(id: &str) -> &str {
    id.strip_prefix("sample-").unwrap_or(id)
}

/// `text.split(/\s+/).filter(Boolean).length`.
fn word_count(text: &str) -> i64 {
    text.split(is_js_whitespace)
        .filter(|w| !w.is_empty())
        .count() as i64
}

/// `samplePolicySourceText`: the stand-in for a fetched policy page,
/// which says of itself that it is sample data.
fn policy_source_text(sample: &Sample, summary: &Summary) -> String {
    let mut lines = vec![
        format!("{} Privacy Policy (sample)", sample.name),
        String::new(),
        format!(
            "This sample document stands in for {}'s real privacy policy so the demo can exercise the summary pipeline without fetching anything.",
            sample.developer
        ),
        String::new(),
        summary.paragraph.clone(),
        String::new(),
        "Key points:".to_string(),
    ];
    lines.extend(summary.highlights.iter().map(|h| format!("- {h}")));
    lines.join("\n")
}

/// `JSON.stringify(sampleSummaryToPolicySummary(summary))`: only the
/// lenses the fixture rates, in the canonical order.
fn policy_summary_json(summary: &Summary) -> String {
    let t = table();
    let mut lenses = vec![];
    for key in &t.lens_order {
        let Some(rating) = summary.lenses.get(key).and_then(Value::as_str) else {
            continue;
        };
        if rating.is_empty() {
            continue;
        }
        let mut lens = Map::new();
        lens.insert("key".into(), json!(key));
        lens.insert("rating".into(), json!(rating));
        if let Some(note) = t.lens_notes.get(rating) {
            lens.insert("summary".into(), note.clone());
        }
        lenses.push(Value::Object(lens));
    }
    let mut out = Map::new();
    out.insert("overview".into(), json!(summary.paragraph));
    out.insert("highlights".into(), json!(summary.highlights));
    out.insert("lenses".into(), Value::Array(lenses));
    Value::Object(out).to_string()
}

/// `sampleStepToSnapshot`: category keys become `{identifier, title}` with
/// the human label, or the key itself for one the label table lacks.
fn step_snapshot(types: &[SampleType]) -> Vec<TypeSnapshot> {
    types
        .iter()
        .map(|t| TypeSnapshot {
            identifier: Some(json!(t.identifier)),
            title: Some(json!(t.title)),
            categories: t
                .categories
                .iter()
                .map(|key| CategorySnapshot {
                    identifier: Some(json!(key)),
                    title: Some(json!(category_label(key).unwrap_or(key))),
                })
                .collect(),
        })
        .collect()
}

/// `saveSnapshot` as this route calls it: never a change-count bump, and
/// always `triggered_by = 'sample'`, which is what the timeline's purple
/// SAMPLE pill reads.
fn save_snapshot(
    cx: &mut Cx,
    app_id: &str,
    snapshot: &[TypeSnapshot],
    changes: &[ChangeEntry],
    scraped_at: i64,
    wayback_url: Option<&str>,
    app_version: Option<&str>,
) -> Result<(), String> {
    let id = cx.ids.uuid(cx.w.conn)?;
    let changes_json = serde_json::to_string(changes).map_err(|e| e.to_string())?;
    cx.w.run(
        INSERT_SNAPSHOT,
        vec![
            json!(id),
            json!(app_id),
            json!(scraped_at),
            json!(snapshot_json(snapshot)),
            json!(i64::from(!changes.is_empty())),
            json!(changes_json),
            json!(if wayback_url.is_some() {
                "wayback"
            } else {
                "live"
            }),
            json!(wayback_url),
            json!("sample"),
            json!(app_version),
            Value::Null,
        ],
    )
    .map(drop)
}

/// One row of the response's `results`, keys in the route's order.
fn result_row(
    id: &str,
    name: &str,
    status: &str,
    source: &str,
    message: Option<&str>,
    snapshots_written: i64,
) -> Value {
    let mut row = Map::new();
    row.insert("id".into(), json!(id));
    row.insert("name".into(), json!(name));
    row.insert("status".into(), json!(status));
    row.insert("source".into(), json!(source));
    if let Some(message) = message {
        row.insert("message".into(), json!(message));
    }
    row.insert("snapshotsWritten".into(), json!(snapshots_written));
    Value::Object(row)
}

// ── Canned ───────────────────────────────────────────────────────────

/// `seedCannedPolicyAnalysis`.
fn seed_canned_policy_analysis(
    cx: &mut Cx,
    sample: &Sample,
    app_id: &str,
    policy_url: &str,
) -> Result<(), String> {
    let now = cx.now;
    let source_text = policy_source_text(sample, &sample.ai_summary);
    let content_hash = sha256_hex(&source_text);
    let title = format!("{} Privacy Policy (sample)", sample.name);
    let previous = sample.ai_summary_previous.as_ref();
    // Nine days ago: inside the policy-change alert window however short
    // the user has set it.
    let changed_at = now - 9 * DAY_MS;
    let settled_at = if previous.is_some() {
        changed_at
    } else {
        now - 14 * DAY_MS
    };
    cx.w.run(
        INSERT_ANALYSIS,
        vec![
            json!(app_id),
            json!(policy_url),
            json!("ready"),
            json!(title),
            json!("text/html"),
            json!(source_text),
            json!(word_count(&source_text)),
            json!("direct"),
            json!(policy_url),
            json!(content_hash),
            json!("direct"),
            json!(policy_summary_json(&sample.ai_summary)),
            previous.map_or(Value::Null, |p| json!(policy_summary_json(p))),
            previous.map_or(Value::Null, |_| json!(changed_at)),
            json!("sample-fixture"),
            json!(settled_at),
            json!(settled_at),
        ],
    )?;
    let Some(previous) = previous else {
        return Ok(());
    };
    let previous_text = policy_source_text(sample, previous);
    let versions = [
        (
            sha256_hex(&previous_text),
            previous_text,
            now - 100 * DAY_MS,
            now - 10 * DAY_MS,
        ),
        (content_hash, source_text, changed_at, now),
    ];
    for (hash, text, first_fetched, last_fetched) in versions {
        let id = cx.ids.uuid(cx.w.conn)?;
        cx.w.run(
            INSERT_VERSION,
            vec![
                json!(id),
                json!(app_id),
                json!(hash),
                json!(first_fetched),
                json!(last_fetched),
                json!(policy_url),
                json!(policy_url),
                json!(title),
                json!("text/html"),
                json!("direct"),
                json!(word_count(&text)),
                json!(text),
            ],
        )?;
    }
    Ok(())
}

fn app_exists(cx: &Cx, id: &str) -> Result<bool, String> {
    cx.w.conn
        .prepare(APP_EXISTS)
        .and_then(|mut s| s.exists([id]))
        .map_err(|e| e.to_string())
}

/// One sample, inside the seed's transaction.
fn seed_sample(cx: &mut Cx, sample: &Sample) -> Result<Value, String> {
    let app_id = synthetic_id_for(&sample.id);
    if app_exists(cx, &app_id)? {
        return Ok(result_row(
            &app_id,
            &sample.name,
            "skipped",
            "canned",
            None,
            0,
        ));
    }
    let now = cx.now;
    // A reserved-for-documentation domain, so the policy link and the AI
    // Policy tab's source pill are visibly not a real developer's.
    let policy_url = format!("https://example.com/privacy/{}", short_slug(&sample.id));
    cx.w.run(
        INSERT_APP,
        vec![
            json!(app_id),
            json!(sample.name),
            json!(format!(
                "https://apps.apple.com/us/app/{}/id{app_id}",
                js_encode_uri_component(&sample.name)
            )),
            json!(""),
            json!(format!("com.sample.{}", short_slug(&sample.id))),
            json!(sample.developer),
            json!(policy_url),
            json!(now - 14 * DAY_MS),
            json!(now),
            json!(0),
            json!(0),
            json!(0),
            json!(i64::from(sample.has_privacy_details)),
            json!(i64::from(sample.has_accessibility_labels)),
        ],
    )?;
    // A feature the catalogue does not know is skipped: a typo in the
    // fixture must not take the whole seed down.
    if sample.has_accessibility_labels {
        for identifier in sample.accessibility_features.iter().flatten() {
            let Some(canonical) = table()
                .accessibility
                .iter()
                .find(|c| &c.identifier == identifier)
            else {
                continue;
            };
            let id = cx.ids.uuid(cx.w.conn)?;
            cx.w.run(
                INSERT_FEATURE,
                vec![
                    json!(id),
                    json!(app_id),
                    json!(canonical.identifier),
                    json!(canonical.title),
                    json!(canonical.fallback_description),
                    json!(canonical.icon_template),
                ],
            )?;
        }
    }
    seed_canned_policy_analysis(cx, sample, &app_id, &policy_url)?;
    for t in &sample.privacy_types {
        let type_row_id = cx.ids.uuid(cx.w.conn)?;
        cx.w.run(
            INSERT_TYPE,
            vec![
                json!(type_row_id),
                json!(app_id),
                json!(t.identifier),
                json!(t.title),
            ],
        )?;
        // The KEY is the stored identifier, which is what profile
        // mismatch detection matches on; the label is only the title.
        for key in &t.categories {
            let category_id = cx.ids.uuid(cx.w.conn)?;
            cx.w.run(
                INSERT_CATEGORY,
                vec![
                    json!(category_id),
                    json!(type_row_id),
                    json!(key),
                    json!(category_label(key).unwrap_or(key)),
                ],
            )?;
        }
    }
    let current = build_snapshot(cx.w.conn, &app_id)?;
    let mut snapshots_written = 0;
    if !current.is_empty() {
        // Oldest first; the sort is stable, as JavaScript's is.
        let mut history: Vec<&Step> = sample.history.iter().collect();
        history.sort_by_key(|step| std::cmp::Reverse(step.days_ago));
        let mut previous: Vec<TypeSnapshot> = vec![];
        for step in history {
            let snapshot = step_snapshot(&step.privacy_types);
            let changes = diff_snapshots(&previous, &snapshot);
            save_snapshot(
                cx,
                &app_id,
                &snapshot,
                &changes,
                now - step.days_ago * DAY_MS,
                step.wayback_url.as_deref(),
                step.version.as_deref(),
            )?;
            snapshots_written += 1;
            previous = snapshot;
        }
        let changes = diff_snapshots(&previous, &current);
        save_snapshot(cx, &app_id, &current, &changes, now, None, None)?;
        snapshots_written += 1;
    }
    Ok(result_row(
        &app_id,
        &sample.name,
        "inserted",
        "canned",
        None,
        snapshots_written,
    ))
}

/// `seedFromCanned`: all ten or none.
fn seed_from_canned(cx: &mut Cx) -> Result<Vec<Value>, String> {
    transaction(cx, |cx| {
        let mut results = vec![];
        for sample in &table().apps {
            results.push(seed_sample(cx, sample)?);
        }
        Ok(results)
    })
}

// ── Live ─────────────────────────────────────────────────────────────

struct ChartEntry {
    id: String,
    name: String,
    url: String,
}

enum Chart {
    Apps(Vec<ChartEntry>),
    RateLimited(i64),
}

/// `fetchTopFreeApps`: the legacy RSS chart, every field wrapped in a
/// `{ label, attributes }` envelope. An entry without both a track id and
/// a product link is dropped.
async fn fetch_top_free_apps(
    fetcher: &dyn Fetcher,
    country: &str,
    limit: i64,
) -> Result<Chart, String> {
    let mut request = Request::apple(
        format!("https://itunes.apple.com/{country}/rss/topfreeapplications/limit={limit}/json"),
        &["itunes.apple.com"],
        1024 * 1024,
        8000,
    );
    request.headers = vec![("Accept".to_string(), "application/json".to_string())];
    let reply = fetcher.fetch(request).await?;
    if reply.status == 429 {
        let retry_after_ms = reply
            .header("retry-after")
            .filter(|h| !h.is_empty())
            .and_then(js_parse_int)
            .map(|seconds| seconds.saturating_mul(1000))
            .filter(|ms| *ms > 0)
            .unwrap_or(70_000);
        return Ok(Chart::RateLimited(retry_after_ms));
    }
    if !reply.ok() {
        return Err(format!(
            "iTunes RSS returned HTTP {} for country={country}",
            reply.status
        ));
    }
    let data: Value = serde_json::from_str(&String::from_utf8_lossy(&reply.body))
        .map_err(|_| "iTunes RSS returned non-JSON body".to_string())?;
    let label = |v: &Value| v["label"].as_str().unwrap_or("").to_string();
    let apps = data["feed"]["entry"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|entry| {
            let id = entry["id"]["attributes"]["im:id"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let url = label(&entry["id"]);
            (!id.is_empty() && !url.is_empty()).then(|| ChartEntry {
                id,
                name: label(&entry["im:name"]),
                url,
            })
        })
        .collect();
    Ok(Chart::Apps(apps))
}

/// `backfillFakeHistory`: two snapshots dated before the live one — sixty
/// days ago with two categories trimmed off the FIRST type, thirty days
/// ago with one — so the timeline reads as a label that grew. Nothing to
/// trim from, nothing written.
fn backfill_fake_history(
    cx: &mut Cx,
    app_id: &str,
    current: &[TypeSnapshot],
) -> Result<i64, String> {
    if !current.iter().any(|t| t.categories.len() >= 2) {
        return Ok(0);
    }
    let now = cx.now;
    let mut written = 0;
    let mut previous: Vec<TypeSnapshot> = vec![];
    for (days_ago, trim) in [(60, 2usize), (30, 1)] {
        let synthesised: Vec<TypeSnapshot> = current
            .iter()
            .enumerate()
            .map(|(index, t)| {
                let keep = if index == 0 {
                    t.categories.len().saturating_sub(trim)
                } else {
                    t.categories.len()
                };
                TypeSnapshot {
                    identifier: t.identifier.clone(),
                    title: t.title.clone(),
                    categories: t.categories[..keep]
                        .iter()
                        .map(|c| CategorySnapshot {
                            identifier: c.identifier.clone(),
                            title: c.title.clone(),
                        })
                        .collect(),
                }
            })
            .collect();
        let changes = diff_snapshots(&previous, &synthesised);
        save_snapshot(
            cx,
            app_id,
            &synthesised,
            &changes,
            now - days_ago * DAY_MS,
            None,
            None,
        )?;
        written += 1;
        previous = synthesised;
    }
    Ok(written)
}

/// What Node does once `fetchAndParseApp` has committed: the policy step
/// (see the module note), then the history. A failure in the history is
/// swallowed — the app is usable with one timeline row.
fn after_scrape(cx: &mut Cx, scraped_id: &str, chart_id: &str) -> i64 {
    let policy_url: Option<String> =
        cx.w.conn
            .query_row(
                "SELECT privacyPolicyUrl FROM apps WHERE id = ?",
                [scraped_id],
                |r| r.get(0),
            )
            .unwrap_or(None);
    if policy_url.as_deref().unwrap_or("").is_empty() {
        let _ = cx.w.run(CLEAR_ANALYSIS, vec![json!(scraped_id)]);
    }
    // The snapshot is read back under the CHART's id. When the chart and
    // the product link disagree that is an app nobody scraped, the
    // snapshot is empty, and there is no history — as on Node.
    let written = build_snapshot(cx.w.conn, chart_id)
        .and_then(|current| backfill_fake_history(cx, chart_id, &current));
    1 + written.unwrap_or_else(|e| {
        super::diag::log_warn(format!(
            "[seed] backfillFakeHistory failed for {chart_id}: {e}"
        ));
        0
    })
}

// ── The route ────────────────────────────────────────────────────────

struct Region {
    country: String,
    source: &'static str,
}

/// An explicit `?country=` wins; otherwise the stored `app_country`, but
/// only when one was actually set — a blank setting is a fresh install and
/// means the dev default, not the system's.
fn resolve_region(cx: &Cx, requested: Option<&str>) -> Region {
    if let Some(requested) = requested.filter(|c| !c.is_empty()) {
        return Region {
            country: normalize_country(Some(requested)),
            source: "query",
        };
    }
    let stored = get_setting_with(cx.w.conn, "app_country", "").unwrap_or_default();
    let stored = js_trim(&stored);
    if stored.is_empty() {
        Region {
            country: DEFAULT_DEV_REGION.to_string(),
            source: "default",
        }
    } else {
        Region {
            country: normalize_country(Some(stored)),
            source: "setting",
        }
    }
}

fn first<'a>(query: &'a [(String, String)], key: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn section<'a, 'b>(w: &'a mut Writer<'b>, ids: &'a mut dyn Ids, now: i64) -> Cx<'a, 'b> {
    Cx { w, ids, now }
}

pub(super) async fn perform(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    fetcher: &dyn Fetcher,
    req: WriteRequest<'_>,
    actor: &Actor,
) -> Response {
    let use_canned = first(req.query, "source") == Some("canned");
    let limit = first(req.query, "limit")
        .and_then(js_parse_int)
        .filter(|n| *n > 0)
        .unwrap_or(SEED_DEFAULT_LIMIT)
        .min(SEED_MAX_LIMIT);
    let requested = first(req.query, "country");
    let region = db.with(|w| resolve_region(&section(w, ids, now), requested));
    // A live walk outlasts the request's instant by seconds, so each app
    // and the closing rows read the clock again, as `Date.now()` does.
    let clock = clock_for(now);
    let started_at = now;

    if use_canned {
        return db.with(|w| {
            let cx = &mut section(w, ids, now);
            match seed_from_canned(cx) {
                Ok(results) => finish(cx, results, &region, "canned", None, actor, started_at),
                Err(message) => {
                    super::diag::log_error(format!(
                        "[/api/dev/seed-sample-data] canned seed failed: {message}"
                    ));
                    failed(cx, actor, &message);
                    json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &json!({ "error": message }),
                    )
                }
            }
        });
    }

    let chart = match fetch_top_free_apps(fetcher, &region.country, limit).await {
        Ok(chart) => chart,
        Err(message) => {
            super::diag::log_error(format!(
                "[/api/dev/seed-sample-data] RSS fetch failed: {message}"
            ));
            db.with(|w| failed(&mut section(w, ids, now), actor, &message));
            return json_response(
                StatusCode::BAD_GATEWAY,
                &json!({
                    "error": message,
                    "hint": CANNED_HINT,
                    "country": region.country,
                    "regionSource": region.source,
                }),
            );
        }
    };
    let apps = match chart {
        Chart::RateLimited(retry_after_ms) => {
            db.with(|w| {
                record_audit(
                    w,
                    ids,
                    now,
                    "dev.seed_sample_data.rate_limited_upstream",
                    actor,
                    Some(&format!(
                        "country={} retryAfterMs={retry_after_ms}",
                        region.country
                    )),
                    false,
                );
            });
            let mut response = json_response(
                StatusCode::TOO_MANY_REQUESTS,
                &json!({
                    "error": "Apple iTunes RSS rate-limited the request",
                    "retryAfterMs": retry_after_ms,
                    "hint": "Wait a minute and retry, or use `?source=canned` to seed offline data.",
                    "country": region.country,
                    "regionSource": region.source,
                }),
            );
            // `Math.ceil(retryAfterMs / 1000)`.
            let seconds = (retry_after_ms + 999) / 1000;
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
            return response;
        }
        Chart::Apps(apps) => apps,
    };
    if apps.is_empty() {
        let message = format!(
            "iTunes RSS returned zero entries for country={}",
            region.country
        );
        db.with(|w| failed(&mut section(w, ids, now), actor, &message));
        return json_response(
            StatusCode::BAD_GATEWAY,
            &json!({
                "error": message,
                "hint": "The country code may be valid but unsupported by the chart feed.",
                "country": region.country,
                "regionSource": region.source,
            }),
        );
    }

    // In chart order, one at a time. Apple's first rate limit ends the
    // walk with whatever it has.
    let mut results = vec![];
    let mut stopped_early = None;
    for entry in &apps {
        let now = clock.now();
        let tracked = db.with(|w| app_exists(&section(w, ids, now), &entry.id));
        if tracked.unwrap_or(false) {
            results.push(result_row(
                &entry.id,
                &entry.name,
                "skipped",
                "live",
                Some("already tracked"),
                0,
            ));
            continue;
        }
        match fetch_and_parse_app(db, fetcher, &entry.url, false, None, now, ids).await {
            Ok(outcome) => {
                let now = clock.now();
                let written =
                    db.with(|w| after_scrape(&mut section(w, ids, now), &outcome.id, &entry.id));
                results.push(result_row(
                    &entry.id,
                    &entry.name,
                    "inserted",
                    "live",
                    None,
                    written,
                ));
            }
            Err(error) => match error.retry_after_ms {
                Some(retry_after_ms) => {
                    stopped_early = Some(retry_after_ms);
                    break;
                }
                None => results.push(result_row(
                    &entry.id,
                    &entry.name,
                    "error",
                    "live",
                    Some(&error.message),
                    0,
                )),
            },
        }
        tokio::time::sleep(per_app_delay()).await;
    }
    let now = clock.now();
    db.with(|w| {
        finish(
            &mut section(w, ids, now),
            results,
            &region,
            "live",
            Some(stopped_early),
            actor,
            started_at,
        )
    })
}

/// The audit row every refusal after the guard leaves.
fn failed(cx: &mut Cx, actor: &Actor, detail: &str) {
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "dev.seed_sample_data.failed",
        actor,
        Some(detail),
        false,
    );
}

/// `finishResponse`. `stopped_early` is `None` for the canned seed, which
/// never passes one — so the key is ABSENT from its response and its
/// activity detail — and `Some(None)` for a live walk that ran to the
/// end, where it is `null`.
fn finish(
    cx: &mut Cx,
    results: Vec<Value>,
    region: &Region,
    mode: &str,
    stopped_early: Option<Option<i64>>,
    actor: &Actor,
    started_at: i64,
) -> Response {
    let count = |status: &str| results.iter().filter(|r| r["status"] == status).count();
    let (inserted, skipped, errored) = (count("inserted"), count("skipped"), count("error"));
    let stopped = stopped_early.flatten();
    let stopped_json = stopped_early.map(|s| {
        s.map_or(
            Value::Null,
            |retry_after_ms| json!({ "reason": "rate-limited", "retryAfterMs": retry_after_ms }),
        )
    });
    let partial = errored > 0 || stopped.is_some();
    let summary = if mode == "live" {
        format!(
            "Dev seed (live, {}/{}) — inserted {inserted}, skipped {skipped}{}{}",
            region.country,
            region.source,
            if errored > 0 {
                format!(", {errored} errored")
            } else {
                String::new()
            },
            if stopped.is_some() {
                ", stopped early (rate-limited)"
            } else {
                ""
            },
        )
    } else {
        format!("Dev seed (canned) — inserted {inserted}, skipped {skipped}")
    };
    let mut detail = Map::new();
    detail.insert("mode".into(), json!(format!("dev-seed-{mode}")));
    detail.insert("country".into(), json!(region.country));
    detail.insert("regionSource".into(), json!(region.source));
    detail.insert("results".into(), Value::Array(results.clone()));
    if let Some(stopped) = &stopped_json {
        detail.insert("stoppedEarly".into(), stopped.clone());
    }
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "reset",
        if partial { "partial" } else { "ok" },
        None,
        Some(&summary),
        Some(&Value::Object(detail)),
        started_at,
    );
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        if partial {
            "dev.seed_sample_data.partial"
        } else {
            "dev.seed_sample_data.success"
        },
        actor,
        Some(&format!(
            "mode={mode} country={} inserted={inserted} skipped={skipped} errored={errored}",
            region.country
        )),
        !partial,
    );

    let mut body = Map::new();
    body.insert("ok".into(), json!(true));
    body.insert("mode".into(), json!(mode));
    body.insert("country".into(), json!(region.country));
    body.insert("regionSource".into(), json!(region.source));
    body.insert("inserted".into(), json!(inserted));
    body.insert("skipped".into(), json!(skipped));
    body.insert("errored".into(), json!(errored));
    if let Some(stopped) = stopped_json {
        body.insert("stoppedEarly".into(), stopped);
    }
    body.insert("results".into(), Value::Array(results));
    body.insert("durationMs".into(), json!(cx.now - started_at));
    json_ok(&Value::Object(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sample_table_parses_and_is_the_ten_app_set() {
        let t = table();
        assert_eq!(t.apps.len(), 10);
        assert!(t.lens_order.len() >= 6);
        assert!(t.accessibility.iter().any(|c| c.identifier == "voiceover"));
        // Every category key the set uses has a label: a fallback to the
        // key would be a silent typo in the fixture.
        for sample in &t.apps {
            for ty in &sample.privacy_types {
                for key in &ty.categories {
                    assert!(category_label(key).is_some(), "{}: {key}", sample.id);
                }
            }
        }
    }

    #[test]
    fn synthetic_ids_are_eight_digits_starting_with_nine() {
        // Node: `9${String(parseInt(sha1(slug).slice(0, 6), 16) % 9e6).padStart(7, "0")}`.
        assert_eq!(synthetic_id_for("sample-instagram"), "94961186");
        assert_eq!(synthetic_id_for("sample-tiktok"), "96650412");
    }

    #[test]
    fn words_are_counted_the_way_split_on_whitespace_counts_them() {
        assert_eq!(word_count("  two\n\twords  "), 2);
        assert_eq!(word_count(""), 0);
        assert_eq!(word_count("one\u{a0}two\u{feff}three"), 3);
    }
}

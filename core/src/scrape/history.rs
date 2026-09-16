//! `importAppHistory` from lib/historical-import.ts (Phase 3, batch 4):
//! the per-app Wayback back-fill. Targets walk back from today by the
//! cadence to the February 2021 floor, with the install date as an extra
//! anchor; each is answered from the CDX index, or from availability-API
//! probes when the index is unusable; captures already covered by date
//! window or by URL are skipped; a usable page is parsed and inserted as a
//! back-dated row in one transaction that also re-diffs the wayback row
//! after it; and when the archive holds nothing recent, Save Page Now is
//! asked once. Throttling anywhere is the import's error, not a quiet
//! quarter. Gated by `core/tests/fixtures/history-cases.json`.
//!
//! Holds the connection across awaits like the other scrape entry points;
//! the Phase 4 routes will stage it around the lock.
use super::{
    js::{at, has_length, iterate, truthy},
    persist::{json_of, message, Ids, Statement, Writer},
    shoebox,
    wayback::{self, Capture, Snapshot, Unavailable},
};
use crate::{
    jsdate::{civil_from_days, days_from_civil},
    jsnum::{js_normalise_value, js_to_number},
    outbound::{Fetcher, Request},
    server::diff::{diff_snapshots, CategorySnapshot, TypeSnapshot},
};
use regex::Regex;
use rusqlite::{types::Value as Sql, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

/// `APP_STORE_HISTORICAL_FLOOR`: 1 February 2021, the first App Store web
/// pages that carried privacy labels.
pub const APP_STORE_HISTORICAL_FLOOR_MS: i64 = 1_612_137_600_000;
const QUARTER_MONTHS: i64 = 3;
const CAPTURE_DRIFT_TOLERANCE_MS: i64 = 45 * 24 * 60 * 60 * 1000;
const WAYBACK_FALLBACK_OFFSET_DAYS: [i64; 7] = [0, -14, 14, -28, 28, -42, 42];
const ONE_DAY_MS: i64 = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS: i64 = 30 * ONE_DAY_MS;
const ARCHIVE_HTML_MAX_BYTES: usize = 4 * 1024 * 1024;
const ARCHIVE_HTML_TIMEOUT_MS: u64 = 30_000;
/// historical-import.ts has its own, shorter allowlist for replays.
pub const REPLAY_HOSTS: &[&str] = &["web.archive.org", "archive.org"];
const REPLAY_USER_AGENT: &str =
    "privacytracker/1.0 (+privacy-history archiver) Mozilla/5.0 (compatible)";

const INSERT_SNAPSHOT: &str = "\n    INSERT INTO privacy_snapshots\n      (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,\n       source, wayback_snapshot_url, triggered_by,\n       app_version, app_version_updated_at)\n    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n  ";
const INSERT_ATTEMPT: &str = "\n    INSERT INTO privacy_snapshots\n      (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,\n       source, triggered_by)\n    VALUES (?, ?, ?, ?, 0, ?, 'live', 'wayback')\n  ";
const UPDATE_SUCCESSOR: &str = "UPDATE privacy_snapshots\n        SET changes_summary = ?, changes_detected = ?\n      WHERE id = ?";

/// `dedupeWindowForInterval`: half the cadence, capped at the drift
/// tolerance.
pub fn dedupe_window_for_interval(interval_months: f64) -> i64 {
    let months = interval_months.floor().max(1.0);
    ((months * THIRTY_DAYS_MS as f64) / 2.0)
        .round()
        .min(CAPTURE_DRIFT_TOLERANCE_MS as f64) as i64
}

/// `ArchiveAppRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppRow {
    pub id: String,
    pub name: String,
    pub url: String,
}

/// `ImportAppHistoryOptions` minus the progress callback and the abort
/// signal, which belong to the bulk runner.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HistoryOptions {
    pub dedupe_window_ms: Option<f64>,
    pub force: bool,
    pub interval_months: Option<f64>,
    /// `today`; the clock when absent.
    pub today: Option<i64>,
}

/// What `importAppHistory` throws: archive.org throttling, or the rare
/// malformed stored snapshot that Node's diff would choke on.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryError {
    pub message: String,
    pub unavailable: Option<Unavailable>,
}

impl From<Unavailable> for HistoryError {
    fn from(u: Unavailable) -> Self {
        Self {
            message: u.message.clone(),
            unavailable: Some(u),
        }
    }
}

impl From<String> for HistoryError {
    fn from(message: String) -> Self {
        Self {
            message,
            unavailable: None,
        }
    }
}

/// `date.setUTCMonth(date.getUTCMonth() - months)`: the same day of month
/// and time of day, with JavaScript's overflow into the next month when
/// the target month is shorter.
fn set_utc_month_minus(ms: i64, months: i64) -> i64 {
    let (year, month, day) = civil_from_days(ms.div_euclid(ONE_DAY_MS));
    let time_of_day = ms.rem_euclid(ONE_DAY_MS);
    let index = i64::from(month) - 1 - months;
    let year = year + index.div_euclid(12);
    let month = index.rem_euclid(12) + 1;
    (days_from_civil(year, month, 1) + i64::from(day) - 1) * ONE_DAY_MS + time_of_day
}

/// `computeHistoricalTargets`: back from today by the cadence to the
/// floor, plus in-range anchors, sorted and thinned to one per day.
pub fn compute_historical_targets(
    today_ms: i64,
    floor_ms: i64,
    interval_months: i64,
    anchors: &[i64],
) -> Vec<i64> {
    let now = today_ms.max(floor_ms);
    let mut targets = vec![];
    let mut cursor = set_utc_month_minus(now, interval_months);
    while cursor > floor_ms {
        targets.push(cursor);
        cursor = set_utc_month_minus(cursor, interval_months);
    }
    targets.push(floor_ms);
    for &anchor in anchors {
        if anchor >= floor_ms && anchor <= now {
            targets.push(anchor);
        }
    }
    targets.sort_unstable();
    let mut unique: Vec<i64> = vec![];
    for ts in targets {
        if unique.last().map_or(true, |last| ts - last > ONE_DAY_MS) {
            unique.push(ts);
        }
    }
    unique
}

enum Walk {
    InTolerance { snapshot: Snapshot, capture_ms: i64 },
    Drift { snapshot: Snapshot, capture_ms: i64 },
    None,
}

/// `pickCaptureFromIndex`: the nearest capture, first one winning ties.
fn pick_capture_from_index(captures: &[Capture], target_ms: i64, tolerance_ms: i64) -> Walk {
    let Some(first) = captures.first() else {
        return Walk::None;
    };
    let mut best = first;
    let mut best_drift = (best.ms - target_ms).abs();
    for capture in captures {
        let drift = (capture.ms - target_ms).abs();
        if drift < best_drift {
            best = capture;
            best_drift = drift;
        }
    }
    let snapshot = Snapshot {
        url: best.url.clone(),
        timestamp: Some(best.timestamp.clone()),
    };
    if best_drift <= tolerance_ms {
        Walk::InTolerance {
            snapshot,
            capture_ms: best.ms,
        }
    } else {
        Walk::Drift {
            snapshot,
            capture_ms: best.ms,
        }
    }
}

/// `findCaptureWithinTolerance`: availability probes at the fallback
/// offsets, stopping at the first in tolerance, else the nearest miss.
async fn find_capture_within_tolerance(
    fetcher: &dyn Fetcher,
    target_url: &str,
    target_ms: i64,
    tolerance_ms: i64,
    now: i64,
) -> Result<Walk, Unavailable> {
    let mut seen = HashSet::new();
    let mut best_miss: Option<(Snapshot, i64, i64)> = None;
    for offset_days in WAYBACK_FALLBACK_OFFSET_DAYS {
        let probe_ms = target_ms + offset_days * ONE_DAY_MS;
        let Some(lookup) = wayback::lookup_near(fetcher, target_url, probe_ms, now).await? else {
            continue;
        };
        if !seen.insert(lookup.url.clone()) {
            continue;
        }
        let timestamp = lookup
            .timestamp
            .clone()
            .or_else(|| wayback::extract_timestamp(&lookup.url));
        let capture_ms = wayback::parse_timestamp_ms(timestamp.as_deref()).unwrap_or(probe_ms);
        let drift = (capture_ms - target_ms).abs();
        if drift <= tolerance_ms {
            return Ok(Walk::InTolerance {
                snapshot: lookup,
                capture_ms,
            });
        }
        if best_miss
            .as_ref()
            .map_or(true, |(_, _, best)| drift < *best)
        {
            best_miss = Some((lookup, capture_ms, drift));
        }
    }
    Ok(match best_miss {
        Some((snapshot, capture_ms, _)) => Walk::Drift {
            snapshot,
            capture_ms,
        },
        None => Walk::None,
    })
}

/// `normaliseWaybackUrl`: `http://` becomes `https://`; empty is nothing.
fn normalise_wayback_url(url: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new("(?i)^http://").expect("static regex"));
    Some(re.replace(url, "https://").into_owned())
}

/// `buildReplayUrl`: the `id_` raw replay of the original URL at the
/// capture's timestamp.
fn build_replay_url(wayback_url: &str, timestamp: Option<&str>, original_url: &str) -> String {
    match timestamp
        .map(str::to_string)
        .or_else(|| wayback::extract_timestamp(wayback_url))
    {
        Some(ts) => format!("https://web.archive.org/web/{ts}id_/{original_url}"),
        None => wayback_url.to_string(),
    }
}

enum ReplayFailure {
    Unavailable(Unavailable),
    Other(String),
}

/// `fetchArchivedHtml`.
async fn fetch_archived_html(
    fetcher: &dyn Fetcher,
    replay_url: &str,
    now: i64,
) -> Result<String, ReplayFailure> {
    let mut request = Request::apple(
        replay_url.to_string(),
        REPLAY_HOSTS,
        ARCHIVE_HTML_MAX_BYTES,
        ARCHIVE_HTML_TIMEOUT_MS,
    );
    request.headers = vec![
        ("User-Agent".to_string(), REPLAY_USER_AGENT.to_string()),
        (
            "Accept".to_string(),
            "text/html,application/xhtml+xml".to_string(),
        ),
        ("Accept-Language".to_string(), "en-US,en;q=0.9".to_string()),
    ];
    let reply = fetcher.fetch(request).await.map_err(ReplayFailure::Other)?;
    if reply.status == 429 || reply.status >= 500 {
        return Err(ReplayFailure::Unavailable(Unavailable::new(
            reply.status,
            wayback::parse_retry_after_ms(reply.header("retry-after"), now),
            "replay",
        )));
    }
    if reply.status != 200 {
        return Err(ReplayFailure::Other(format!(
            "archive replay returned HTTP {}",
            reply.status
        )));
    }
    Ok(String::from_utf8_lossy(&reply.body).into_owned())
}

/// `looksLikeAppStoreProductPage`.
fn looks_like_app_store_product_page(html: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?i)<script[^>]*(?-u:\b)id="(?:serialized-server-data|shoebox-(?:ember-data-store|media-api-cache-apps|uts-api-cache-apps))""#)
            .expect("static regex")
    });
    re.is_match(html)
}

/// `parsePrivacyItemsFromArchivedHtml`: the modern chain (whole, not
/// partial — any throw inside it is `None`), then the shoebox, then a
/// normalisation that keeps the first of each identifier and falls back
/// to the identifier for a non-string title. `Err` is the one `TypeError`
/// that escapes it: a `categories` that is not iterable.
pub fn parse_privacy_items_from_archived_html(
    html: &str,
) -> Result<Option<Vec<TypeSnapshot>>, String> {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    let script = SCRIPT.get_or_init(|| {
        Regex::new(
            r#"<script[^>]*id="serialized-server-data"[^>]*>((?s:.)*?)</script(?-u:\b)[^>]*>"#,
        )
        .expect("static regex")
    });
    let data: Value = match script.captures(html) {
        Some(c) => match serde_json::from_str::<Value>(&c[1]) {
            Ok(Value::Array(items)) => Value::Array(items),
            Ok(Value::Object(mut o)) => match o.remove("data") {
                Some(v) if !v.is_null() => v,
                _ => Value::Array(vec![]),
            },
            Ok(_) => Value::Array(vec![]),
            Err(_) => Value::Null,
        },
        None => Value::Null,
    };
    let chain: Result<Value, ()> = (|| {
        let shelf_map = at(&data, 0)["data"]["shelfMapping"].clone();
        let mut items = Value::Array(vec![]);
        if has_length(&shelf_map["privacyTypes"]["items"]) {
            items = shelf_map["privacyTypes"]["items"].clone();
        }
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
                            push(
                                &mut items,
                                json!({
                                    "identifier": item["identifier"],
                                    "title": item["title"],
                                    "categories": seen.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
                                }),
                            );
                        }
                    }
                }
            }
        }
        if !has_length(&items) {
            let page_data = at(&data, 0)["data"]["pageData"].clone();
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
        if !has_length(&items) {
            items = Value::Array(shoebox::extract(html));
        }
        Ok(items)
    })();
    let Ok(items) = chain else {
        return Ok(None);
    };
    if !has_length(&items) {
        return Ok(None);
    }
    let list = iterate(&items).map_err(|e| e.named_message("privacyItems"))?;
    let mut snapshot = vec![];
    let mut type_ids: Vec<Value> = vec![];
    for item in &list {
        let identifier = item["identifier"].clone();
        if !truthy(&identifier) || type_ids.contains(&identifier) {
            continue;
        }
        type_ids.push(identifier.clone());
        let raw_categories = if item["categories"].is_null() {
            vec![]
        } else {
            iterate(&item["categories"]).map_err(|e| e.typed_message())?
        };
        let mut categories = vec![];
        let mut category_ids: Vec<Value> = vec![];
        for category in &raw_categories {
            let id = category["identifier"].clone();
            if !truthy(&id) || category_ids.contains(&id) {
                continue;
            }
            category_ids.push(id.clone());
            let title = match &category["title"] {
                Value::String(_) => category["title"].clone(),
                _ => id.clone(),
            };
            categories.push(CategorySnapshot {
                identifier: Some(id),
                title: Some(title),
            });
        }
        let title = match &item["title"] {
            Value::String(_) => item["title"].clone(),
            _ => identifier.clone(),
        };
        snapshot.push(TypeSnapshot {
            identifier: Some(identifier),
            title: Some(title),
            categories,
        });
    }
    Ok(Some(snapshot))
}

fn push(items: &mut Value, item: Value) {
    if let Value::Array(list) = items {
        list.push(item);
    }
}

/// `JSON.stringify` of a `PrivacyTypeSnapshot[]`.
fn snapshot_json(snapshot: &[TypeSnapshot]) -> String {
    let value = Value::Array(
        snapshot
            .iter()
            .map(|t| {
                let mut out = Map::new();
                if let Some(v) = &t.identifier {
                    out.insert("identifier".into(), v.clone());
                }
                if let Some(v) = &t.title {
                    out.insert("title".into(), v.clone());
                }
                out.insert(
                    "categories".into(),
                    Value::Array(
                        t.categories
                            .iter()
                            .map(|c| {
                                let mut cat = Map::new();
                                if let Some(v) = &c.identifier {
                                    cat.insert("identifier".into(), v.clone());
                                }
                                if let Some(v) = &c.title {
                                    cat.insert("title".into(), v.clone());
                                }
                                Value::Object(cat)
                            })
                            .collect(),
                    ),
                );
                Value::Object(out)
            })
            .collect(),
    );
    js_normalise_value(value).to_string()
}

/// A stored blob as the diff's input. `Ok(None)` for no row, a null blob or
/// unparseable JSON (Node treats each as "nothing before"); `Err` for JSON
/// that parses but is not a snapshot array, which Node's diff throws on.
fn stored_snapshot(blob: Option<&str>) -> Result<Option<Vec<TypeSnapshot>>, String> {
    let Some(blob) = blob else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(blob) else {
        return Ok(None);
    };
    serde_json::from_value::<Vec<TypeSnapshot>>(value)
        .map(Some)
        .map_err(|e| format!("stored snapshot is not a privacy snapshot: {e}"))
}

/// `getSnapshotBefore`.
fn snapshot_before(
    conn: &Connection,
    app_id: &str,
    before_ms: i64,
) -> Result<Option<Vec<TypeSnapshot>>, String> {
    let blob: Option<Option<String>> = conn
        .query_row(
            "SELECT snapshot_json\n         FROM privacy_snapshots\n        WHERE app_id = ? AND scraped_at < ?\n        ORDER BY scraped_at DESC\n        LIMIT 1",
            rusqlite::params![app_id, before_ms],
            |r| r.get(0),
        )
        .optional()
        .map_err(message)?;
    stored_snapshot(blob.flatten().as_deref().filter(|s| !s.is_empty()))
}

/// `writeWaybackSnapshot`: the back-dated row and the successor repair, in
/// one transaction. Returns the changes and whether this is the baseline.
fn write_wayback_snapshot(
    w: &mut Writer,
    ids: &mut dyn Ids,
    app_id: &str,
    snapshot: &[TypeSnapshot],
    capture_ms: i64,
    wayback_url: &str,
) -> Result<(Vec<Value>, bool), String> {
    let conn = w.conn;
    let tx = conn.unchecked_transaction().map_err(message)?;
    w.mark("BEGIN");
    let body = (|| -> Result<(Vec<Value>, bool), String> {
        let previous = snapshot_before(conn, app_id, capture_ms)?;
        let changes: Vec<Value> = previous
            .as_ref()
            .map(|p| {
                diff_snapshots(p, snapshot)
                    .into_iter()
                    .map(|c| serde_json::to_value(c).expect("change entry serialises"))
                    .collect()
            })
            .unwrap_or_default();
        let id = ids.uuid(conn)?;
        w.run(
            INSERT_SNAPSHOT,
            vec![
                json!(id),
                json!(app_id),
                json!(capture_ms),
                json!(snapshot_json(snapshot)),
                json!(i64::from(!changes.is_empty())),
                json!(serde_json::to_string(&changes).expect("changes serialise")),
                json!("wayback"),
                json!(wayback_url),
                json!("wayback"),
                Value::Null,
                Value::Null,
            ],
        )?;
        repair_successor_wayback_diff(w, app_id, capture_ms, snapshot)?;
        Ok((changes, previous.is_none()))
    })();
    match body {
        Ok(out) => {
            w.mark("COMMIT");
            tx.commit().map_err(message)?;
            Ok(out)
        }
        Err(error) => {
            w.mark("ROLLBACK");
            drop(tx);
            Err(error)
        }
    }
}

/// `repairSuccessorWaybackDiff`: the wayback row right after the inserted
/// one is re-diffed against it; a live successor is left alone.
fn repair_successor_wayback_diff(
    w: &mut Writer,
    app_id: &str,
    inserted_at_ms: i64,
    inserted: &[TypeSnapshot],
) -> Result<(), String> {
    let next = w
        .conn
        .query_row(
            "SELECT id, source, snapshot_json\n         FROM privacy_snapshots\n        WHERE app_id = ? AND scraped_at > ?\n        ORDER BY scraped_at ASC\n        LIMIT 1",
            rusqlite::params![app_id, inserted_at_ms],
            |r| Ok((r.get::<_, Sql>(0)?, json_of(r.get::<_, Sql>(1)?), json_of(r.get::<_, Sql>(2)?))),
        )
        .optional()
        .map_err(message)?;
    let Some((id, source, blob)) = next else {
        return Ok(());
    };
    if source != "wayback" || !truthy(&blob) {
        return Ok(());
    }
    let Value::String(blob) = blob else {
        return Ok(());
    };
    let Ok(value) = serde_json::from_str::<Value>(&blob) else {
        return Ok(());
    };
    let next_snapshot = serde_json::from_value::<Vec<TypeSnapshot>>(value)
        .map_err(|e| format!("successor snapshot is not a privacy snapshot: {e}"))?;
    let changes: Vec<Value> = diff_snapshots(inserted, &next_snapshot)
        .into_iter()
        .map(|c| serde_json::to_value(c).expect("change entry serialises"))
        .collect();
    w.run(
        UPDATE_SUCCESSOR,
        vec![
            json!(serde_json::to_string(&changes).expect("changes serialise")),
            json!(i64::from(!changes.is_empty())),
            json_of(id),
        ],
    )?;
    Ok(())
}

/// `appendWaybackAttemptEntry` for a Save Page Now request.
fn append_wayback_attempt_entry(
    w: &mut Writer,
    ids: &mut dyn Ids,
    app_id: &str,
    now: i64,
    description: &str,
    save_now_url: &str,
    target_date: i64,
) -> Result<(), String> {
    let latest: Option<Option<String>> = w
        .conn
        .query_row(
            "\n    SELECT snapshot_json FROM privacy_snapshots\n    WHERE app_id = ?\n    ORDER BY scraped_at DESC\n    LIMIT 1\n  ",
            [app_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(message)?;
    let latest: Value = match latest.flatten() {
        None => Value::Array(vec![]),
        Some(blob) => match serde_json::from_str::<Value>(&blob).map_err(|e| e.to_string())? {
            Value::Null => Value::Array(vec![]),
            other => js_normalise_value(other),
        },
    };
    let id = ids.uuid(w.conn)?;
    let entry = json!({
        "type": "wayback",
        "description": description,
        "category": "wayback-attempt",
        "wayback_event": "requested_snapshot",
        "save_now_url": save_now_url,
        "target_date": target_date,
    });
    w.run(
        INSERT_ATTEMPT,
        vec![
            json!(id),
            json!(app_id),
            json!(now),
            json!(latest.to_string()),
            json!(Value::Array(vec![entry]).to_string()),
        ],
    )?;
    Ok(())
}

/// `requestFreshCapture`.
async fn request_fresh_capture(
    w: &mut Writer<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    app: &AppRow,
    today_ms: i64,
    now: i64,
) -> Value {
    let failed = |error: String| json!({"targetDate": today_ms, "outcome": "skipped_save_now_failed", "errorMessage": error});
    match wayback::save_now(fetcher, &app.url).await {
        wayback::SaveResult::Failed(error) => failed(error),
        wayback::SaveResult::Saved(snapshot) => {
            let mut info = json!({
                "targetDate": today_ms,
                "outcome": "requested_snapshot",
                "saveNowUrl": snapshot.url,
            });
            if let Some(ms) = wayback::parse_timestamp_ms(snapshot.timestamp.as_deref()) {
                info["captureDate"] = json!(ms);
            }
            match append_wayback_attempt_entry(
                w,
                ids,
                &app.id,
                now,
                "Requested a fresh Wayback capture of the live App Store page so the next import has a recent baseline.",
                &snapshot.url,
                today_ms,
            ) {
                Ok(()) => info,
                Err(error) => failed(error),
            }
        }
    }
}

/// `importAppHistory(app, options)`: the result object as JSON, or the
/// error the import throws.
#[allow(clippy::too_many_arguments)]
pub async fn import_app_history(
    conn: &Connection,
    fetcher: &dyn Fetcher,
    app: &AppRow,
    options: &HistoryOptions,
    now: i64,
    ids: &mut dyn Ids,
    log: Option<&mut Vec<Statement>>,
) -> Result<Value, HistoryError> {
    let mut w = Writer::new(conn, log);
    let today_ms = options.today.unwrap_or(now);
    let interval_months = options
        .interval_months
        .unwrap_or(QUARTER_MONTHS as f64)
        .floor()
        .max(1.0) as i64;
    let dedupe_window_ms = options
        .dedupe_window_ms
        .unwrap_or(dedupe_window_for_interval(interval_months as f64) as f64);

    // `Number(row?.firstSeen) || 0`, then the anchor once the install is
    // older than the window.
    let first_seen: Option<Value> = conn
        .query_row("SELECT firstSeen FROM apps WHERE id = ?", [&app.id], |r| {
            Ok(json_of(r.get::<_, Sql>(0)?))
        })
        .optional()
        .map_err(message)?;
    let first_seen_ms = js_to_number(&first_seen.unwrap_or(Value::Null));
    let first_seen_ms = if first_seen_ms.is_nan() {
        0.0
    } else {
        first_seen_ms
    };
    let mut anchors = vec![];
    if first_seen_ms > 0.0 && (today_ms as f64) - first_seen_ms > dedupe_window_ms {
        anchors.push(first_seen_ms.trunc() as i64);
    }
    let targets = compute_historical_targets(
        today_ms,
        APP_STORE_HISTORICAL_FLOOR_MS,
        interval_months,
        &anchors,
    );

    let mut existing: Vec<(f64, Option<String>)> = conn
        .prepare("SELECT scraped_at, wayback_snapshot_url\n         FROM privacy_snapshots\n        WHERE app_id = ? AND source = 'wayback'")
        .map_err(message)?
        .query_map([&app.id], |r| {
            Ok((
                js_to_number(&json_of(r.get::<_, Sql>(0)?)),
                match json_of(r.get::<_, Sql>(1)?) {
                    Value::String(s) => Some(s),
                    _ => None,
                },
            ))
        })
        .map_err(message)?
        .collect::<rusqlite::Result<_>>()
        .map_err(message)?;
    let mut existing_urls: HashSet<String> = existing
        .iter()
        .filter_map(|(_, url)| url.as_deref().and_then(normalise_wayback_url))
        .collect();

    let mut attempted = 0i64;
    let mut imported = 0i64;
    let mut unchanged = 0i64;
    let mut skipped = 0i64;
    let mut failed = 0i64;
    let mut snapshots_requested = 0i64;
    let mut target_results: Vec<Value> = vec![];

    let captures =
        wayback::list_captures(fetcher, &app.url, Some(APP_STORE_HISTORICAL_FLOOR_MS), now).await?;
    let mut unusable: HashMap<String, &'static str> = HashMap::new();
    let newest_target = targets.last().copied();
    let mut newest_covered = false;

    for &target_ms in &targets {
        attempted += 1;
        let is_newest = Some(target_ms) == newest_target;
        let covered = !options.force
            && existing
                .iter()
                .any(|(scraped_at, _)| (scraped_at - target_ms as f64).abs() <= dedupe_window_ms);
        if covered {
            if is_newest {
                newest_covered = true;
            }
            target_results.push(json!({"targetDate": target_ms, "outcome": "skipped_existing"}));
            skipped += 1;
            continue;
        }
        let walk = match &captures {
            Some(captures) => {
                pick_capture_from_index(captures, target_ms, CAPTURE_DRIFT_TOLERANCE_MS)
            }
            None => {
                find_capture_within_tolerance(
                    fetcher,
                    &app.url,
                    target_ms,
                    CAPTURE_DRIFT_TOLERANCE_MS,
                    now,
                )
                .await?
            }
        };
        let (snapshot, capture_ms) = match walk {
            Walk::None => {
                target_results
                    .push(json!({"targetDate": target_ms, "outcome": "skipped_no_capture"}));
                skipped += 1;
                continue;
            }
            Walk::Drift {
                snapshot,
                capture_ms,
            } => {
                target_results.push(json!({
                    "targetDate": target_ms,
                    "outcome": "skipped_drift",
                    "captureDate": capture_ms,
                    "waybackUrl": snapshot.url,
                }));
                skipped += 1;
                continue;
            }
            Walk::InTolerance {
                snapshot,
                capture_ms,
            } => (snapshot, capture_ms),
        };
        let lookup_key = normalise_wayback_url(&snapshot.url);
        if lookup_key
            .as_ref()
            .is_some_and(|k| existing_urls.contains(k))
        {
            if is_newest {
                newest_covered = true;
            }
            target_results.push(json!({
                "targetDate": target_ms,
                "outcome": "skipped_existing",
                "captureDate": capture_ms,
                "waybackUrl": snapshot.url,
            }));
            skipped += 1;
            continue;
        }
        if let Some(prior) = lookup_key.as_ref().and_then(|k| unusable.get(k)).copied() {
            target_results.push(json!({
                "targetDate": target_ms,
                "outcome": prior,
                "captureDate": capture_ms,
                "waybackUrl": snapshot.url,
            }));
            if prior == "skipped_no_labels" {
                skipped += 1;
            } else {
                failed += 1;
            }
            continue;
        }
        let replay_url = build_replay_url(&snapshot.url, snapshot.timestamp.as_deref(), &app.url);
        let html = match fetch_archived_html(fetcher, &replay_url, now).await {
            Ok(html) => html,
            Err(ReplayFailure::Unavailable(u)) => return Err(u.into()),
            Err(ReplayFailure::Other(error)) => {
                if let Some(key) = &lookup_key {
                    unusable.insert(key.clone(), "skipped_fetch_failure");
                }
                target_results.push(json!({
                    "targetDate": target_ms,
                    "outcome": "skipped_fetch_failure",
                    "captureDate": capture_ms,
                    "waybackUrl": snapshot.url,
                    "errorMessage": error,
                }));
                failed += 1;
                continue;
            }
        };
        let Some(parsed) = parse_privacy_items_from_archived_html(&html)? else {
            let no_labels = looks_like_app_store_product_page(&html);
            let outcome = if no_labels {
                "skipped_no_labels"
            } else {
                "skipped_parse_failure"
            };
            if let Some(key) = &lookup_key {
                unusable.insert(key.clone(), outcome);
            }
            target_results.push(json!({
                "targetDate": target_ms,
                "outcome": outcome,
                "captureDate": capture_ms,
                "waybackUrl": snapshot.url,
            }));
            if no_labels {
                skipped += 1;
            } else {
                failed += 1;
            }
            continue;
        };
        let (changes, is_baseline) =
            write_wayback_snapshot(&mut w, ids, &app.id, &parsed, capture_ms, &snapshot.url)?;
        existing.push((capture_ms as f64, Some(snapshot.url.clone())));
        if let Some(key) = &lookup_key {
            existing_urls.insert(key.clone());
        }
        if is_newest {
            newest_covered = true;
        }
        let outcome = if !changes.is_empty() || is_baseline {
            imported += 1;
            "imported"
        } else {
            unchanged += 1;
            "unchanged"
        };
        target_results.push(json!({
            "targetDate": target_ms,
            "outcome": outcome,
            "captureDate": capture_ms,
            "waybackUrl": snapshot.url,
            "changeCount": changes.len(),
        }));
    }

    let has_recent_capture = match &captures {
        Some(captures) => captures
            .iter()
            .any(|c| (today_ms - c.ms).abs() <= CAPTURE_DRIFT_TOLERANCE_MS),
        None => newest_covered,
    };
    if !has_recent_capture {
        let info = request_fresh_capture(&mut w, ids, fetcher, app, today_ms, now).await;
        if info["outcome"] == "requested_snapshot" {
            snapshots_requested += 1;
        } else {
            skipped += 1;
        }
        target_results.push(info);
    }

    Ok(json!({
        "appId": app.id,
        "attempted": attempted,
        "imported": imported,
        "unchanged": unchanged,
        "skipped": skipped,
        "failed": failed,
        "snapshotsRequested": snapshots_requested,
        "targets": target_results,
    }))
}

/// `removeImportedHistory(appId?)`: the wayback rows and the importer's
/// own notes. Returns the rows removed.
pub fn remove_imported_history(conn: &Connection, app_id: Option<&str>) -> Result<usize, String> {
    let condition = "(source = 'wayback' OR (source = 'live' AND triggered_by = 'wayback'))";
    match app_id {
        Some(id) => conn
            .execute(
                &format!("DELETE FROM privacy_snapshots WHERE {condition} AND app_id = ?"),
                [id],
            )
            .map_err(message),
        None => conn
            .execute(
                &format!("DELETE FROM privacy_snapshots WHERE {condition}"),
                [],
            )
            .map_err(message),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compute_historical_targets, dedupe_window_for_interval, APP_STORE_HISTORICAL_FLOOR_MS,
    };

    #[test]
    fn targets_walk_like_node() {
        // Every value is computeHistoricalTargets from node -e.
        let nov_1 = 1_635_768_000_000; // 2021-11-01T12:00:00Z
        assert_eq!(
            compute_historical_targets(nov_1, APP_STORE_HISTORICAL_FLOOR_MS, 3, &[]),
            vec![
                APP_STORE_HISTORICAL_FLOOR_MS,
                1_619_870_400_000,
                1_627_819_200_000
            ]
        );
        // 31 May minus three months is 3 March: February has no 31st.
        let may_31 = 1_622_462_400_000; // 2021-05-31T12:00:00Z
        assert_eq!(
            compute_historical_targets(may_31, APP_STORE_HISTORICAL_FLOOR_MS, 3, &[]),
            vec![APP_STORE_HISTORICAL_FLOOR_MS, 1_614_772_800_000]
        );
        assert_eq!(dedupe_window_for_interval(3.0), 45 * 24 * 60 * 60 * 1000);
        assert_eq!(dedupe_window_for_interval(1.0), 15 * 24 * 60 * 60 * 1000);
    }
}

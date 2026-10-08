//! The per-app Wayback back-fill. It began as a port of `importAppHistory`
//! (lib/historical-import.ts), which reads one archived page per quarter;
//! the Node rollback still does. Labels rarely change, so this one reads a
//! skeleton instead — the earliest capture on or after the February 2021
//! floor, the newest, and the capture nearest each cadence step back from
//! today — then bisects wherever two neighbouring samples differ, until
//! each change sits between captures that are adjacent in the index or at
//! most a week apart. Rows go in for the baseline, both sides of each
//! change and the newest read, each back-dated in one transaction that also
//! re-diffs the wayback row after it. Stored wayback rows are the samples a
//! run starts from. Without a usable index the run probes the availability
//! API once per skeleton date and does not bisect, and when the archive
//! holds nothing recent Save Page Now is asked once. Throttling anywhere, a
//! refused connection included, is the import's error, not an empty
//! archive; what the run learned before it is stored first, so the next
//! run picks up from there. docs/WAYBACK_IMPORT.md (P2) is the design and
//! `core/tests/fixtures/history-cases.json` gates it.
//!
//! The planner, [`Sampler`], does no I/O: it names the capture to read next
//! and takes what that page held, so it is tested without HTTP. The
//! connection comes through a [`DbAccess`] and is taken for one section at
//! a time — the stored-row read before the index listing, each back-dated
//! row's transaction, the Save Page Now attempt entry — and released for
//! every archive request.
use super::{
    js::{at, has_length, iterate, truthy},
    persist::{json_of, message, DbAccess, Ids, Writer},
    shoebox,
    wayback::{self, Capture, Unavailable},
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
    collections::{HashMap, HashSet, VecDeque},
    sync::OnceLock,
};

/// `APP_STORE_HISTORICAL_FLOOR`: 1 February 2021, the first App Store web
/// pages that carried privacy labels.
pub const APP_STORE_HISTORICAL_FLOOR_MS: i64 = 1_612_137_600_000;
/// The skeleton's cadence when the caller names none.
pub const DEFAULT_INTERVAL_MONTHS: i64 = 12;
/// How near today a capture must be for the archive to count as holding
/// something recent, which is when Save Page Now is not asked.
const CAPTURE_DRIFT_TOLERANCE_MS: i64 = 45 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS: i64 = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS: i64 = 30 * ONE_DAY_MS;
/// A change between captures this close needs no more reads.
const SETTLED_GAP_MS: i64 = 7 * ONE_DAY_MS;
/// Reads one point may spend on unusable captures before giving up on it.
const MAX_TRIES_PER_POINT: u8 = 2;
const ARCHIVE_HTML_MAX_BYTES: usize = 4 * 1024 * 1024;
const ARCHIVE_HTML_TIMEOUT_MS: u64 = 30_000;
/// historical-import.ts has its own, shorter allowlist for replays.
pub const REPLAY_HOSTS: &[&str] = &["web.archive.org", "archive.org"];
const REPLAY_USER_AGENT: &str =
    "privacytracker/1.0 (+privacy-history archiver) Mozilla/5.0 (compatible)";

pub(crate) const INSERT_SNAPSHOT: &str = "\n    INSERT INTO privacy_snapshots\n      (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,\n       source, wayback_snapshot_url, triggered_by,\n       app_version, app_version_updated_at)\n    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n  ";
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
    /// How near a skeleton date a stored row must be to stand in for it;
    /// [`dedupe_window_for_interval`] of the cadence when absent.
    pub dedupe_window_ms: Option<f64>,
    /// Ask the archive again instead of trusting stored rows as samples.
    /// A capture already stored is still never stored twice.
    pub force: bool,
    /// The skeleton's cadence in months, [`DEFAULT_INTERVAL_MONTHS`] when
    /// absent. Naming one asks for that density, so two stored rows with the
    /// same labels no longer vouch for the skeleton dates between them.
    pub interval_months: Option<f64>,
    /// `today`; the clock when absent.
    pub today: Option<i64>,
    /// A capture list the caller already holds (the bulk runner's survey
    /// keeps one per app), used instead of asking the CDX index again. Each
    /// capture is replayed at the address in its own URL.
    pub captures: Option<Vec<Capture>>,
    /// Never ask Save Page Now. Bulk runs set it: a capture request is a
    /// write to the public archive with its own, stricter limits, and it
    /// gives the user nothing now.
    pub skip_save_now: bool,
    /// When the CDX index cannot be used, fail the import instead of probing
    /// the availability API once per skeleton date. Bulk runs set it: the
    /// probes go to archive.org's most throttled endpoint and cannot bisect.
    pub skip_availability_fallback: bool,
}

/// The error a bulk import records when the CDX index is unusable and
/// `skip_availability_fallback` is set.
pub const INDEX_UNAVAILABLE: &str = "archive.org's capture index could not be read for this app";

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

/// The skeleton's dates: back from today by the cadence while still after
/// the floor, oldest first. The month arithmetic is JavaScript's, so 31 May
/// minus three months is 3 March.
pub fn skeleton_anchors(today_ms: i64, floor_ms: i64, interval_months: i64) -> Vec<i64> {
    let mut anchors = vec![];
    let mut cursor = set_utc_month_minus(today_ms.max(floor_ms), interval_months);
    while cursor > floor_ms {
        anchors.push(cursor);
        cursor = set_utc_month_minus(cursor, interval_months);
    }
    anchors.reverse();
    anchors
}

/// The skeleton without an index, which has no earliest or newest capture
/// to read: the floor, the dates back from today, and today, one per day.
fn probe_targets(today_ms: i64, interval_months: i64) -> Vec<i64> {
    let floor = APP_STORE_HISTORICAL_FLOOR_MS;
    let today = today_ms.max(floor);
    let mut targets = vec![floor];
    targets.extend(skeleton_anchors(today, floor, interval_months));
    targets.push(today);
    let mut unique: Vec<i64> = vec![];
    for ts in targets {
        if unique.last().map_or(true, |last| ts - last > ONE_DAY_MS) {
            unique.push(ts);
        }
    }
    unique
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

/// The address inside a `/web/<timestamp>/<address>` capture URL. The CDX
/// listing builds its captures from the app's own URL, but a held capture
/// list may carry captures of another address (an older App Store URL,
/// another storefront), and the replay must ask for the one captured.
fn archived_address(capture_url: &str) -> Option<&str> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"(?i)^https?://(?:www\.)?web\.archive\.org/web/[0-9]{4,14}(?:[a-z_]+)?/(https?://.+)$",
        )
        .expect("static regex")
    });
    re.captures(capture_url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
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
    // A refused connection is archive.org cutting us off, not a bad capture.
    let reply = fetcher
        .fetch(request)
        .await
        .map_err(|error| match Unavailable::transport(&error, "replay") {
            Some(unavailable) => ReplayFailure::Unavailable(unavailable),
            None => ReplayFailure::Other(error),
        })?;
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
pub(crate) fn snapshot_json(snapshot: &[TypeSnapshot]) -> String {
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

/// `requestFreshCapture`: Save Page Now with the connection released, then
/// the attempt entry in one section.
async fn request_fresh_capture(
    db: &mut dyn DbAccess,
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
            let appended = db.with(|w| {
                append_wayback_attempt_entry(
                    w,
                    ids,
                    &app.id,
                    now,
                    "Requested a fresh Wayback capture of the live App Store page so the next import has a recent baseline.",
                    &snapshot.url,
                    today_ms,
                )
            });
            match appended {
                Ok(()) => info,
                Err(error) => failed(error),
            }
        }
    }
}

/// What one archived page held.
#[derive(Debug)]
pub(crate) enum Page {
    /// A product page with privacy labels.
    Labels(Vec<TypeSnapshot>),
    /// A product page without a privacy section: Apple was still adding
    /// labels to its web pages in early February 2021, and an app whose
    /// developer had filed none has none.
    NoLabels,
    /// Not a product page, or a replay that failed for a reason other than
    /// throttling. `outcome` is what its target reports.
    Unusable {
        outcome: &'static str,
        error: Option<String>,
    },
}

/// The pass that asked for a read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Skeleton,
    Bisect,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Skeleton => "skeleton",
            Self::Bisect => "bisect",
        }
    }
}

/// A capture the planner wants read, and the date it stands in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ask {
    pub capture: usize,
    pub target_ms: i64,
    pub phase: Phase,
}

/// A sample's labels, as an index into the distinct label sets seen. Two
/// snapshots share one when `diff_snapshots` finds nothing between them, so
/// the planner's "changed" is exactly what a stored row records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum State {
    NoLabels,
    Labels(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    /// Not read.
    Unknown,
    /// Held by a stored row the planner trusts.
    Stored,
    /// Read in this run and kept as a sample.
    Sampled,
    /// Read in this run and unusable, with the outcome it reported.
    Unusable(&'static str),
}

#[derive(Debug, Clone, Copy)]
struct SampleRead {
    capture: usize,
    entry: usize,
    snapshot: Option<usize>,
}

#[derive(Debug)]
struct Sample {
    id: usize,
    ms: i64,
    url: String,
    state: State,
    /// How this run read it; `None` for a stored row.
    read: Option<SampleRead>,
}

/// The point being resolved: a skeleton date, or the midpoint between two
/// neighbouring samples that differ (`between`, their ids in `pair`).
#[derive(Debug, Clone, Copy)]
struct Point {
    target_ms: i64,
    phase: Phase,
    between: Option<(i64, i64)>,
    pair: Option<(usize, usize)>,
    tries: u8,
}

/// A stored wayback row as the planner sees it.
pub(crate) struct StoredRow {
    pub ms: i64,
    pub url: Option<String>,
    /// `None` for a blob that is not a snapshot: the row is never stored
    /// twice, but it tells the planner nothing.
    pub snapshot: Option<Vec<TypeSnapshot>>,
}

/// What the planner takes from the import's options.
pub(crate) struct SamplerConfig {
    pub today_ms: i64,
    pub interval_months: i64,
    pub dedupe_window_ms: f64,
    pub force: bool,
    /// Whether two neighbouring stored rows with the same labels vouch for
    /// the skeleton dates between them.
    pub cover_between_equal_rows: bool,
}

/// A read the run stores as a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RowToWrite {
    pub ms: i64,
    pub url: String,
    pub snapshot: usize,
    pub entry: usize,
}

/// The change-finding planner. `next` names the capture to read, `answer`
/// takes what the page held, and once `next` is done `rows` lists the
/// reads to store. It never fetches or writes.
///
/// The skeleton goes first, oldest date first: a date a stored row already
/// covers costs nothing; otherwise the nearest capture is read, and an
/// unusable one hands over to the next nearest, two reads at most. Then,
/// while two neighbouring samples differ, the capture nearest their
/// midpoint is read, until every change sits between captures at most a
/// week apart or with nothing left to read between them. A midpoint that
/// fails twice leaves its change as wide as it was.
///
/// A page with no labels before any page with them is a sample of its own,
/// so the stretch before labels appeared is bisected like a change and the
/// baseline lands where they first show. Anywhere else such a page is
/// unusable.
pub(crate) struct Sampler {
    /// The index, oldest first; on the no-index path, the probed captures
    /// in the order they came.
    captures: Vec<Capture>,
    slots: Vec<Slot>,
    by_url: HashMap<String, usize>,
    /// Every stored wayback row's capture: never stored again.
    stored_urls: HashSet<String>,
    /// The stored rows the planner trusts as samples.
    stored_sample_urls: HashSet<String>,
    /// Ordered by time.
    samples: Vec<Sample>,
    snapshots: Vec<Vec<TypeSnapshot>>,
    /// Each distinct label set's first snapshot.
    versions: Vec<usize>,
    skeleton: VecDeque<i64>,
    current: Option<Point>,
    failed_pairs: HashSet<(usize, usize)>,
    entries: Vec<Value>,
    reads: i64,
    next_id: usize,
    dedupe_window_ms: f64,
    cover_between_equal_rows: bool,
}

/// One target, in the order the result has always carried its fields.
fn target_entry(
    target_ms: i64,
    outcome: &str,
    capture: Option<(i64, &str)>,
    error: Option<String>,
    phase: Phase,
) -> Value {
    let mut entry = Map::new();
    entry.insert("targetDate".into(), json!(target_ms));
    entry.insert("outcome".into(), json!(outcome));
    if let Some((ms, url)) = capture {
        entry.insert("captureDate".into(), json!(ms));
        entry.insert("waybackUrl".into(), json!(url));
    }
    if let Some(error) = error {
        entry.insert("errorMessage".into(), json!(error));
    }
    entry.insert("phase".into(), json!(phase.as_str()));
    Value::Object(entry)
}

impl Sampler {
    pub(crate) fn new(
        captures: Vec<Capture>,
        stored: Vec<StoredRow>,
        config: &SamplerConfig,
    ) -> Self {
        let mut captures: Vec<Capture> = captures
            .into_iter()
            .filter(|c| c.ms >= APP_STORE_HISTORICAL_FLOOR_MS)
            .collect();
        captures.sort_by_key(|c| c.ms);
        let mut by_url = HashMap::new();
        for (i, capture) in captures.iter().enumerate() {
            if let Some(key) = normalise_wayback_url(&capture.url) {
                by_url.entry(key).or_insert(i);
            }
        }
        let mut sampler = Self {
            slots: vec![Slot::Unknown; captures.len()],
            captures,
            by_url,
            stored_urls: HashSet::new(),
            stored_sample_urls: HashSet::new(),
            samples: vec![],
            snapshots: vec![],
            versions: vec![],
            skeleton: VecDeque::new(),
            current: None,
            failed_pairs: HashSet::new(),
            entries: vec![],
            reads: 0,
            next_id: 0,
            dedupe_window_ms: config.dedupe_window_ms,
            cover_between_equal_rows: config.cover_between_equal_rows,
        };
        for row in stored {
            let key = row.url.as_deref().and_then(normalise_wayback_url);
            if let Some(key) = &key {
                sampler.stored_urls.insert(key.clone());
            }
            // Forcing asks the archive again, stored rows or not.
            if config.force {
                continue;
            }
            let Some(snapshot) = row.snapshot else {
                continue;
            };
            if let Some(key) = &key {
                if !sampler.stored_sample_urls.insert(key.clone()) {
                    continue;
                }
                if let Some(&i) = sampler.by_url.get(key) {
                    sampler.slots[i] = Slot::Stored;
                }
            }
            let (label, _) = sampler.register(snapshot);
            sampler.add_sample(
                row.ms,
                row.url.unwrap_or_default(),
                State::Labels(label),
                None,
            );
        }
        if let (Some(first), Some(last)) = (sampler.captures.first(), sampler.captures.last()) {
            let (earliest, newest) = (first.ms, last.ms);
            let mut targets = vec![earliest];
            targets.extend(
                skeleton_anchors(
                    config.today_ms,
                    APP_STORE_HISTORICAL_FLOOR_MS,
                    config.interval_months,
                )
                .into_iter()
                .filter(|&t| earliest < t && t < newest),
            );
            if newest > earliest {
                targets.push(newest);
            }
            sampler.skeleton = targets.into();
        }
        sampler
    }

    pub(crate) fn capture(&self, index: usize) -> &Capture {
        &self.captures[index]
    }

    pub(crate) fn entries(&self) -> &[Value] {
        &self.entries
    }

    pub(crate) fn reads(&self) -> i64 {
        self.reads
    }

    pub(crate) fn snapshot(&self, index: usize) -> &[TypeSnapshot] {
        &self.snapshots[index]
    }

    /// The label set's index, registering it when it is new.
    fn register(&mut self, snapshot: Vec<TypeSnapshot>) -> (usize, usize) {
        let at = self.snapshots.len();
        self.snapshots.push(snapshot);
        let seen = self.versions.iter().position(|&first| {
            diff_snapshots(&self.snapshots[first], &self.snapshots[at]).is_empty()
        });
        match seen {
            Some(label) => (label, at),
            None => {
                self.versions.push(at);
                (self.versions.len() - 1, at)
            }
        }
    }

    fn add_sample(&mut self, ms: i64, url: String, state: State, read: Option<SampleRead>) {
        let id = self.next_id;
        self.next_id += 1;
        let at = self.samples.partition_point(|s| s.ms <= ms);
        self.samples.insert(
            at,
            Sample {
                id,
                ms,
                url,
                state,
                read,
            },
        );
        if let State::Labels(_) = state {
            // A page without labels after one with them is not the stretch
            // before labels appeared: it was an unusable read after all.
            let mut demoted = vec![];
            self.samples.retain(|s| {
                let late = s.state == State::NoLabels && s.ms > ms;
                if late {
                    demoted.extend(s.read.map(|r| r.capture));
                }
                !late
            });
            for capture in demoted {
                self.slots[capture] = Slot::Unusable("skipped_no_labels");
            }
        }
    }

    /// Whether a page at `ms` would come before every page with labels.
    fn leading(&self, ms: i64) -> bool {
        !self
            .samples
            .iter()
            .any(|s| matches!(s.state, State::Labels(_)) && s.ms < ms)
    }

    /// Whether stored rows already stand in for a skeleton date: one is
    /// within the dedupe window, or (at the default cadence) the date lies
    /// between two neighbouring stored rows with the same labels, which the
    /// run that stored them sampled at least as densely.
    pub(crate) fn covered(&self, target_ms: i64) -> bool {
        let stored: Vec<&Sample> = self.samples.iter().filter(|s| s.read.is_none()).collect();
        if stored
            .iter()
            .any(|s| ((s.ms - target_ms) as f64).abs() <= self.dedupe_window_ms)
        {
            return true;
        }
        self.cover_between_equal_rows
            && stored
                .windows(2)
                .any(|w| w[0].ms < target_ms && target_ms < w[1].ms && w[0].state == w[1].state)
    }

    /// The next capture to read, or `None` once every change is settled.
    pub(crate) fn next(&mut self) -> Option<Ask> {
        loop {
            if let Some(point) = self.current {
                match self.candidate(&point) {
                    None => self.fail_current(),
                    Some(i) => match self.slots[i] {
                        Slot::Unknown => {
                            return Some(Ask {
                                capture: i,
                                target_ms: point.target_ms,
                                phase: point.phase,
                            })
                        }
                        Slot::Stored => {
                            let capture = &self.captures[i];
                            let entry = target_entry(
                                point.target_ms,
                                "skipped_existing",
                                Some((capture.ms, &capture.url)),
                                None,
                                point.phase,
                            );
                            self.entries.push(entry);
                            self.current = None;
                        }
                        // Another date's read already stands here.
                        Slot::Sampled | Slot::Unusable(_) => self.current = None,
                    },
                }
                continue;
            }
            if let Some(target_ms) = self.skeleton.pop_front() {
                if self.covered(target_ms) {
                    self.note(target_ms, "skipped_existing");
                } else {
                    self.current = Some(Point {
                        target_ms,
                        phase: Phase::Skeleton,
                        between: None,
                        pair: None,
                        tries: 0,
                    });
                }
                continue;
            }
            let (l, r) = self.unsettled_pair()?;
            let (lo, hi) = (&self.samples[l], &self.samples[r]);
            self.current = Some(Point {
                target_ms: lo.ms + (hi.ms - lo.ms) / 2,
                phase: Phase::Bisect,
                between: Some((lo.ms, hi.ms)),
                pair: Some((lo.id, hi.id)),
                tries: 0,
            });
        }
    }

    /// The capture nearest the point, the earlier on a tie. A skeleton date
    /// takes any capture not found unusable, read or not; a midpoint only an
    /// unread one strictly between its two samples.
    fn candidate(&self, point: &Point) -> Option<usize> {
        let range = match point.between {
            Some((lo, hi)) => {
                self.captures.partition_point(|c| c.ms <= lo)
                    ..self.captures.partition_point(|c| c.ms < hi)
            }
            None => 0..self.captures.len(),
        };
        let mut best: Option<(usize, i64)> = None;
        for i in range {
            let eligible = match point.between {
                Some(_) => self.slots[i] == Slot::Unknown,
                None => !matches!(self.slots[i], Slot::Unusable(_)),
            };
            let drift = (self.captures[i].ms - point.target_ms).abs();
            if eligible && best.map_or(true, |(_, d)| drift < d) {
                best = Some((i, drift));
            }
        }
        best.map(|(i, _)| i)
    }

    /// The first two neighbouring samples that differ and can still be
    /// narrowed.
    fn unsettled_pair(&self) -> Option<(usize, usize)> {
        (1..self.samples.len()).map(|r| (r - 1, r)).find(|&(l, r)| {
            let (lo, hi) = (&self.samples[l], &self.samples[r]);
            let differ = match (lo.state, hi.state) {
                (State::NoLabels, State::Labels(_)) => true,
                (State::Labels(a), State::Labels(b)) => a != b,
                _ => false,
            };
            differ
                && hi.ms - lo.ms > SETTLED_GAP_MS
                && !self.failed_pairs.contains(&(lo.id, hi.id))
                && self.unread_between(lo.ms, hi.ms)
        })
    }

    fn unread_between(&self, lo: i64, hi: i64) -> bool {
        let from = self.captures.partition_point(|c| c.ms <= lo);
        let to = self.captures.partition_point(|c| c.ms < hi);
        (from..to).any(|i| self.slots[i] == Slot::Unknown)
    }

    fn fail_current(&mut self) {
        if let Some(Point {
            pair: Some(pair), ..
        }) = self.current.take()
        {
            self.failed_pairs.insert(pair);
        }
    }

    /// A target that read nothing: covered by a stored row, or (without an
    /// index) a date the archive has no capture near.
    pub(crate) fn note(&mut self, target_ms: i64, outcome: &str) {
        self.entries.push(target_entry(
            target_ms,
            outcome,
            None,
            None,
            Phase::Skeleton,
        ));
    }

    /// What the page `ask` named held.
    pub(crate) fn answer(&mut self, ask: Ask, page: Page) {
        self.reads += 1;
        let (ms, url) = {
            let capture = &self.captures[ask.capture];
            (capture.ms, capture.url.clone())
        };
        let state = match page {
            Page::Labels(snapshot) => {
                let (label, snapshot) = self.register(snapshot);
                Some((State::Labels(label), "sampled", Some(snapshot)))
            }
            Page::NoLabels if self.leading(ms) => {
                Some((State::NoLabels, "skipped_no_labels", None))
            }
            Page::NoLabels => {
                self.unusable(ask, "skipped_no_labels", None);
                None
            }
            Page::Unusable { outcome, error } => {
                self.unusable(ask, outcome, error);
                None
            }
        };
        let Some((state, outcome, snapshot)) = state else {
            return;
        };
        let entry = self.entries.len();
        self.entries.push(target_entry(
            ask.target_ms,
            outcome,
            Some((ms, &url)),
            None,
            ask.phase,
        ));
        self.slots[ask.capture] = Slot::Sampled;
        let read = SampleRead {
            capture: ask.capture,
            entry,
            snapshot,
        };
        self.add_sample(ms, url, state, Some(read));
        self.current = None;
    }

    fn unusable(&mut self, ask: Ask, outcome: &'static str, error: Option<String>) {
        let capture = &self.captures[ask.capture];
        let entry = target_entry(
            ask.target_ms,
            outcome,
            Some((capture.ms, &capture.url)),
            error,
            ask.phase,
        );
        self.entries.push(entry);
        self.slots[ask.capture] = Slot::Unusable(outcome);
        if let Some(point) = self.current.as_mut() {
            point.tries += 1;
            if point.tries >= MAX_TRIES_PER_POINT {
                self.fail_current();
            }
        }
    }

    /// The no-index path: the availability probe for `target_ms` answered
    /// with `capture`. `Some` when it still has to be read; a capture already
    /// held or read reports what it was.
    pub(crate) fn offer(&mut self, target_ms: i64, capture: Capture) -> Option<Ask> {
        let key = normalise_wayback_url(&capture.url);
        let seen = key.as_ref().and_then(|k| self.by_url.get(k).copied());
        let stored = key
            .as_ref()
            .is_some_and(|k| self.stored_sample_urls.contains(k));
        let known = match seen.map(|i| self.slots[i]) {
            _ if stored => Some("skipped_existing"),
            Some(Slot::Stored | Slot::Sampled) => Some("skipped_existing"),
            Some(Slot::Unusable(prior)) => Some(prior),
            Some(Slot::Unknown) | None => None,
        };
        if let Some(outcome) = known {
            let entry = target_entry(
                target_ms,
                outcome,
                Some((capture.ms, &capture.url)),
                None,
                Phase::Skeleton,
            );
            self.entries.push(entry);
            return None;
        }
        let index = seen.unwrap_or_else(|| {
            self.captures.push(capture);
            self.slots.push(Slot::Unknown);
            let index = self.captures.len() - 1;
            if let Some(key) = key {
                self.by_url.insert(key, index);
            }
            index
        });
        Some(Ask {
            capture: index,
            target_ms,
            phase: Phase::Skeleton,
        })
    }

    /// The samples with labels, oldest first.
    fn labelled(&self) -> impl Iterator<Item = &Sample> {
        self.samples
            .iter()
            .filter(|s| matches!(s.state, State::Labels(_)))
    }

    /// The reads to store, oldest first: the earliest sample with labels
    /// (the baseline), both sides of every change, and the newest. Stored
    /// rows among them are already there.
    pub(crate) fn rows(&self) -> Vec<RowToWrite> {
        let labelled: Vec<&Sample> = self.labelled().collect();
        let last = labelled.len().saturating_sub(1);
        labelled
            .iter()
            .enumerate()
            .filter(|&(k, s)| {
                k == 0
                    || k == last
                    || labelled[k - 1].state != s.state
                    || labelled[k + 1].state != s.state
            })
            .filter_map(|(_, s)| {
                let read = s.read?;
                Some(RowToWrite {
                    ms: s.ms,
                    url: s.url.clone(),
                    snapshot: read.snapshot?,
                    entry: read.entry,
                })
            })
            .collect()
    }

    /// Each change as the captures either side of it.
    pub(crate) fn windows(&self) -> Vec<(i64, i64)> {
        let labelled: Vec<&Sample> = self.labelled().collect();
        labelled
            .windows(2)
            .filter(|w| w[0].state != w[1].state)
            .map(|w| (w[0].ms, w[1].ms))
            .collect()
    }

    /// The distinct label sets among the samples.
    pub(crate) fn label_versions(&self) -> usize {
        self.labelled()
            .map(|s| s.state)
            .collect::<HashSet<_>>()
            .len()
    }

    /// Whether a stored row already holds this capture.
    pub(crate) fn is_stored_url(&self, url: &str) -> bool {
        normalise_wayback_url(url).is_some_and(|k| self.stored_urls.contains(&k))
    }

    /// Whether a trusted stored row is within `tolerance_ms` of `ms`.
    fn stored_near(&self, ms: i64, tolerance_ms: i64) -> bool {
        self.samples
            .iter()
            .any(|s| s.read.is_none() && (s.ms - ms).abs() <= tolerance_ms)
    }

    /// Rewrites a read's target once the run knows what became of it.
    pub(crate) fn settle(&mut self, entry: usize, outcome: &str, change_count: Option<usize>) {
        let old = &self.entries[entry];
        let mut settled = Map::new();
        settled.insert("targetDate".into(), old["targetDate"].clone());
        settled.insert("outcome".into(), json!(outcome));
        settled.insert("captureDate".into(), old["captureDate"].clone());
        settled.insert("waybackUrl".into(), old["waybackUrl"].clone());
        if let Some(count) = change_count {
            settled.insert("changeCount".into(), json!(count));
        }
        settled.insert("phase".into(), old["phase"].clone());
        self.entries[entry] = Value::Object(settled);
    }

    pub(crate) fn take_entries(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.entries)
    }
}

/// Reads one archived page. Throttling, and the one parse error Node
/// throws, are the import's errors; anything else wrong with the page is
/// an unusable read.
async fn read_page(
    fetcher: &dyn Fetcher,
    replay_url: &str,
    now: i64,
) -> Result<Page, HistoryError> {
    let html = match fetch_archived_html(fetcher, replay_url, now).await {
        Ok(html) => html,
        Err(ReplayFailure::Unavailable(u)) => return Err(u.into()),
        Err(ReplayFailure::Other(error)) => {
            return Ok(Page::Unusable {
                outcome: "skipped_fetch_failure",
                error: Some(error),
            })
        }
    };
    Ok(match parse_privacy_items_from_archived_html(&html)? {
        Some(snapshot) => Page::Labels(snapshot),
        None if looks_like_app_store_product_page(&html) => Page::NoLabels,
        None => Page::Unusable {
            outcome: "skipped_parse_failure",
            error: None,
        },
    })
}

/// `onProgress`: each target as `{ appId, ...info }`, in the order the
/// result's `targets` carries them. A usable read is reported `sampled`
/// when it lands; the result then marks the ones stored as rows `imported`
/// or `unchanged`. The bulk runner turns them into its `target` frames.
pub(crate) type Progress<'a> = Option<&'a mut (dyn FnMut(Value) + Send)>;

fn report(progress: &mut Progress<'_>, app_id: &str, info: &Value) {
    if let Some(sink) = progress.as_mut() {
        let mut event = serde_json::Map::new();
        event.insert("appId".into(), json!(app_id));
        if let Some(fields) = info.as_object() {
            for (k, v) in fields {
                event.insert(k.clone(), v.clone());
            }
        }
        sink(Value::Object(event));
    }
}

/// One app's walk through the archive.
struct Walk<'a, 'p> {
    sampler: Sampler,
    fetcher: &'a dyn Fetcher,
    app: &'a AppRow,
    now: i64,
    progress: Progress<'p>,
    reported: usize,
}

impl Walk<'_, '_> {
    fn report_new(&mut self) {
        for info in &self.sampler.entries()[self.reported..] {
            report(&mut self.progress, &self.app.id, info);
        }
        self.reported = self.sampler.entries().len();
    }

    /// The skeleton and the bisection over a capture index.
    async fn index(&mut self) -> Result<(), HistoryError> {
        loop {
            let ask = self.sampler.next();
            self.report_new();
            let Some(ask) = ask else {
                return Ok(());
            };
            let replay_url = {
                let capture = self.sampler.capture(ask.capture);
                let address = archived_address(&capture.url).unwrap_or(self.app.url.as_str());
                let timestamp = Some(capture.timestamp.as_str()).filter(|t| !t.is_empty());
                build_replay_url(&capture.url, timestamp, address)
            };
            let page = read_page(self.fetcher, &replay_url, self.now).await?;
            self.sampler.answer(ask, page);
            self.report_new();
        }
    }

    /// Without a usable index: one availability probe per skeleton date at
    /// that date, and no bisection. Each probed capture's time goes into
    /// `probed`, which decides whether the archive holds anything recent.
    async fn probes(
        &mut self,
        targets: &[i64],
        skip_availability_fallback: bool,
        probed: &mut Vec<i64>,
    ) -> Result<(), HistoryError> {
        for &target_ms in targets {
            if self.sampler.covered(target_ms) {
                self.sampler.note(target_ms, "skipped_existing");
                self.report_new();
                continue;
            }
            if skip_availability_fallback {
                return Err(INDEX_UNAVAILABLE.to_string().into());
            }
            let found =
                wayback::lookup_near(self.fetcher, &self.app.url, target_ms, self.now).await?;
            let Some(snapshot) = found else {
                self.sampler.note(target_ms, "skipped_no_capture");
                self.report_new();
                continue;
            };
            let timestamp = snapshot
                .timestamp
                .clone()
                .or_else(|| wayback::extract_timestamp(&snapshot.url));
            let capture_ms = wayback::parse_timestamp_ms(timestamp.as_deref()).unwrap_or(target_ms);
            probed.push(capture_ms);
            let replay_url =
                build_replay_url(&snapshot.url, snapshot.timestamp.as_deref(), &self.app.url);
            let capture = Capture {
                ms: capture_ms,
                timestamp: timestamp.unwrap_or_default(),
                url: snapshot.url,
            };
            let ask = self.sampler.offer(target_ms, capture);
            self.report_new();
            let Some(ask) = ask else {
                continue;
            };
            let page = read_page(self.fetcher, &replay_url, self.now).await?;
            self.sampler.answer(ask, page);
            self.report_new();
        }
        Ok(())
    }
}

/// Stores the reads the planner keeps, oldest first, so each target's
/// change count is against the row it ends up after.
fn commit_rows(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    sampler: &mut Sampler,
    app_id: &str,
) -> Result<(), HistoryError> {
    for row in sampler.rows() {
        if sampler.is_stored_url(&row.url) {
            // A forced run re-read a capture that is already a row.
            sampler.settle(row.entry, "skipped_existing", None);
            continue;
        }
        let snapshot = sampler.snapshot(row.snapshot);
        let (changes, is_baseline) =
            db.with(|w| write_wayback_snapshot(w, ids, app_id, snapshot, row.ms, &row.url))?;
        let outcome = if !changes.is_empty() || is_baseline {
            "imported"
        } else {
            "unchanged"
        };
        sampler.settle(row.entry, outcome, Some(changes.len()));
    }
    Ok(())
}

/// `importAppHistory(app, options)`, redesigned: the result object as
/// JSON, or the error the import throws. The result keeps every field the
/// quarterly sweep had — `targets` now lists each read and each skeleton
/// date that needed none, with its `phase` — and adds `reads` (pages
/// fetched), `changes`, `labelVersions` (distinct label sets),
/// `firstCaptureMs` / `lastCaptureMs` (the index's range, null without
/// one) and `windows` (each change's `fromMs` / `toMs`).
pub(crate) async fn import_app_history(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    app: &AppRow,
    options: &HistoryOptions,
    now: i64,
    ids: &mut dyn Ids,
    progress: Progress<'_>,
) -> Result<Value, HistoryError> {
    let today_ms = options.today.unwrap_or(now);
    let interval_months = options
        .interval_months
        .unwrap_or(DEFAULT_INTERVAL_MONTHS as f64)
        .floor()
        .max(1.0) as i64;
    let dedupe_window_ms = options
        .dedupe_window_ms
        .unwrap_or(dedupe_window_for_interval(interval_months as f64) as f64);

    // The rows already held are where the walk starts. One section, before
    // the first archive request.
    let stored = db.with(|w| stored_wayback_rows(w.conn, &app.id))?;
    let captures = match &options.captures {
        Some(held) => Some(held.clone()),
        None => {
            wayback::list_captures(fetcher, &app.url, Some(APP_STORE_HISTORICAL_FLOOR_MS), now)
                .await?
        }
    };
    let in_range = |list: &[Capture]| {
        list.iter()
            .map(|c| c.ms)
            .filter(|&ms| ms >= APP_STORE_HISTORICAL_FLOOR_MS)
            .collect::<Vec<_>>()
    };
    let (first_capture_ms, last_capture_ms) = match &captures {
        Some(list) => {
            let range = in_range(list);
            (range.iter().min().copied(), range.iter().max().copied())
        }
        None => (None, None),
    };
    let config = SamplerConfig {
        today_ms,
        interval_months,
        dedupe_window_ms,
        force: options.force,
        cover_between_equal_rows: options.interval_months.is_none() && !options.force,
    };
    let mut walk = Walk {
        sampler: Sampler::new(captures.clone().unwrap_or_default(), stored, &config),
        fetcher,
        app,
        now,
        progress,
        reported: 0,
    };
    let mut probed = vec![];
    let walked = match &captures {
        Some(_) => walk.index().await,
        None => {
            let targets = probe_targets(today_ms, interval_months);
            walk.probes(&targets, options.skip_availability_fallback, &mut probed)
                .await
        }
    };
    // Stored even when the walk stopped early: a throttled run's reads are
    // the next run's samples.
    let committed = commit_rows(db, ids, &mut walk.sampler, &app.id);
    walked?;
    committed?;

    let mut targets = walk.sampler.take_entries();
    let attempted = targets.len();
    let (mut imported, mut unchanged, mut skipped, mut failed) = (0i64, 0i64, 0i64, 0i64);
    for target in &targets {
        match target["outcome"].as_str().unwrap_or("") {
            "imported" => imported += 1,
            "unchanged" => unchanged += 1,
            "skipped_existing" | "skipped_no_labels" | "skipped_no_capture" => skipped += 1,
            "skipped_parse_failure" | "skipped_fetch_failure" => failed += 1,
            _ => {}
        }
    }

    let has_recent_capture = match &captures {
        Some(list) => list
            .iter()
            .any(|c| (today_ms - c.ms).abs() <= CAPTURE_DRIFT_TOLERANCE_MS),
        None => {
            probed
                .iter()
                .any(|ms| (today_ms - ms).abs() <= CAPTURE_DRIFT_TOLERANCE_MS)
                || walk
                    .sampler
                    .stored_near(today_ms, CAPTURE_DRIFT_TOLERANCE_MS)
        }
    };
    let mut snapshots_requested = 0i64;
    if !has_recent_capture && !options.skip_save_now {
        let info = request_fresh_capture(db, ids, fetcher, app, today_ms, now).await;
        if info["outcome"] == "requested_snapshot" {
            snapshots_requested += 1;
        } else {
            skipped += 1;
        }
        report(&mut walk.progress, &app.id, &info);
        targets.push(info);
    }

    let windows = walk.sampler.windows();
    Ok(json!({
        "appId": app.id,
        "attempted": attempted,
        "imported": imported,
        "unchanged": unchanged,
        "skipped": skipped,
        "failed": failed,
        "snapshotsRequested": snapshots_requested,
        "targets": targets,
        "reads": walk.sampler.reads(),
        "changes": windows.len(),
        "labelVersions": walk.sampler.label_versions(),
        "firstCaptureMs": first_capture_ms,
        "lastCaptureMs": last_capture_ms,
        "windows": windows
            .iter()
            .map(|(from, to)| json!({"fromMs": from, "toMs": to}))
            .collect::<Vec<_>>(),
    }))
}

/// The wayback rows already held, oldest first.
fn stored_wayback_rows(conn: &Connection, app_id: &str) -> Result<Vec<StoredRow>, String> {
    let rows: Vec<(f64, Value, Value)> = conn
        .prepare("SELECT scraped_at, wayback_snapshot_url, snapshot_json\n         FROM privacy_snapshots\n        WHERE app_id = ? AND source = 'wayback'\n        ORDER BY scraped_at, rowid")
        .map_err(message)?
        .query_map([app_id], |r| {
            Ok((
                js_to_number(&json_of(r.get::<_, Sql>(0)?)),
                json_of(r.get::<_, Sql>(1)?),
                json_of(r.get::<_, Sql>(2)?),
            ))
        })
        .map_err(message)?
        .collect::<rusqlite::Result<_>>()
        .map_err(message)?;
    Ok(rows
        .into_iter()
        .filter(|(ms, _, _)| ms.is_finite())
        .map(|(ms, url, blob)| StoredRow {
            ms: ms.trunc() as i64,
            url: match url {
                Value::String(url) => Some(url),
                _ => None,
            },
            snapshot: match blob {
                Value::String(blob) if !blob.is_empty() => {
                    stored_snapshot(Some(&blob)).ok().flatten()
                }
                _ => None,
            },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        dedupe_window_for_interval, probe_targets, skeleton_anchors, Capture, Page, Phase, Sampler,
        SamplerConfig, StoredRow, APP_STORE_HISTORICAL_FLOOR_MS,
    };
    use crate::{scrape::wayback::format_timestamp, server::diff::TypeSnapshot};
    use serde_json::json;

    const DAY: i64 = 24 * 60 * 60 * 1000;
    /// 2021-03-01T12:00:00Z.
    const MARCH_2021: i64 = 1_614_600_000_000;

    fn day(n: i64) -> i64 {
        MARCH_2021 + n * DAY
    }

    fn capture(ms: i64) -> Capture {
        let timestamp = format!("{}120000", format_timestamp(ms));
        Capture {
            ms,
            url: format!(
                "https://web.archive.org/web/{timestamp}/https://apps.apple.com/us/app/x/id1"
            ),
            timestamp,
        }
    }

    fn daily(days: std::ops::RangeInclusive<i64>) -> Vec<Capture> {
        days.map(|n| capture(day(n))).collect()
    }

    /// Label set `v`: one type collecting `v + 1` categories, so every `v`
    /// is a version of its own.
    fn labels(v: usize) -> Vec<TypeSnapshot> {
        let categories: Vec<_> = (0..=v)
            .map(|c| json!({"identifier": format!("C{c}"), "title": format!("C{c}")}))
            .collect();
        serde_json::from_value(json!([{
            "identifier": "DATA_LINKED_TO_YOU",
            "title": "Data Linked to You",
            "categories": categories,
        }]))
        .unwrap()
    }

    /// Five years of noon captures end on day 1825; today is 1 March 2026,
    /// so the skeleton is days 0, 365, 730, 1096, 1461 and 1825.
    const TODAY: i64 = MARCH_2021 + 1826 * DAY;

    fn config() -> SamplerConfig {
        SamplerConfig {
            today_ms: TODAY,
            interval_months: 12,
            dedupe_window_ms: dedupe_window_for_interval(12.0) as f64,
            force: false,
            cover_between_equal_rows: true,
        }
    }

    /// Runs the planner to the end; returns the days it read.
    fn drive(sampler: &mut Sampler, page: impl Fn(i64) -> Page) -> Vec<(i64, Phase)> {
        let mut asked = vec![];
        while let Some(ask) = sampler.next() {
            let ms = sampler.capture(ask.capture).ms;
            asked.push(((ms - MARCH_2021) / DAY, ask.phase));
            sampler.answer(ask, page(ms));
        }
        asked
    }

    /// The version in force on a day, given the days labels changed.
    fn version(changes: &[i64], ms: i64) -> usize {
        changes.iter().filter(|&&c| day(c) <= ms).count()
    }

    fn days(windows: &[(i64, i64)]) -> Vec<(i64, i64)> {
        windows
            .iter()
            .map(|(a, b)| ((a - MARCH_2021) / DAY, (b - MARCH_2021) / DAY))
            .collect()
    }

    fn row_days(sampler: &Sampler) -> Vec<i64> {
        sampler
            .rows()
            .iter()
            .map(|r| (r.ms - MARCH_2021) / DAY)
            .collect()
    }

    #[test]
    fn bisection_brackets_each_change_within_a_week() {
        let changes = [400, 1300];
        let mut sampler = Sampler::new(daily(0..=1825), vec![], &config());
        let asked = drive(&mut sampler, |ms| {
            Page::Labels(labels(version(&changes, ms)))
        });
        // Midpoints round down to noon and ties go to the earlier capture:
        // 547, 456, 410, 387, 398, 404 for the first change, six reads each.
        assert_eq!(
            asked,
            [0, 365, 730, 1096, 1461, 1825]
                .map(|d| (d, Phase::Skeleton))
                .into_iter()
                .chain(
                    [547, 456, 410, 387, 398, 404, 1278, 1369, 1323, 1300, 1289, 1294]
                        .map(|d| (d, Phase::Bisect))
                )
                .collect::<Vec<_>>()
        );
        assert_eq!(days(&sampler.windows()), vec![(398, 404), (1294, 1300)]);
        assert_eq!(row_days(&sampler), vec![0, 398, 404, 1294, 1300, 1825]);
        assert_eq!((sampler.reads(), sampler.label_versions()), (18, 3));
    }

    #[test]
    fn a_stable_app_costs_the_skeleton() {
        let mut sampler = Sampler::new(daily(0..=1825), vec![], &config());
        drive(&mut sampler, |_| Page::Labels(labels(0)));
        assert_eq!(sampler.reads(), 6);
        assert!(sampler.windows().is_empty());
        assert_eq!(row_days(&sampler), vec![0, 1825]);
        assert_eq!(sampler.label_versions(), 1);
    }

    #[test]
    fn captures_more_than_a_week_apart_settle_when_adjacent() {
        // Every tenth day: the bracket stops only when nothing is left
        // between, so the rows are the last capture before the change and
        // the first after it.
        let captures: Vec<Capture> = (0..=182).map(|n| capture(day(n * 10))).collect();
        let mut sampler = Sampler::new(captures, vec![], &config());
        drive(&mut sampler, |ms| Page::Labels(labels(version(&[405], ms))));
        assert_eq!(days(&sampler.windows()), vec![(400, 410)]);
        assert_eq!(row_days(&sampler), vec![0, 400, 410, 1820]);
    }

    #[test]
    fn a_change_that_reverts_between_skeleton_reads_is_missed() {
        // Days 500 to 600 carry other labels; days 365 and 730 agree, so
        // nothing is bisected. A denser cadence finds it.
        let page = |ms: i64| Page::Labels(labels(usize::from((day(500)..=day(600)).contains(&ms))));
        let mut yearly = Sampler::new(daily(0..=1825), vec![], &config());
        drive(&mut yearly, page);
        assert!(yearly.windows().is_empty());
        assert_eq!(yearly.reads(), 6);

        let quarterly = SamplerConfig {
            interval_months: 3,
            ..config()
        };
        let mut dense = Sampler::new(daily(0..=1825), vec![], &quarterly);
        drive(&mut dense, page);
        let found = days(&dense.windows());
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found[0].0 < 500 && 500 <= found[0].1 && found[0].1 - found[0].0 <= 7);
        assert!(found[1].0 <= 600 && 600 < found[1].1 && found[1].1 - found[1].0 <= 7);
    }

    #[test]
    fn unusable_captures_hand_over_to_the_next_nearest() {
        let unusable = |outcome| Page::Unusable {
            outcome,
            error: None,
        };
        // The earliest capture is no product page: the baseline is the next.
        // The first midpoint, 547, and the next nearest, 548, both fail, so
        // that change stays as wide as the skeleton found it.
        let mut sampler = Sampler::new(daily(0..=1825), vec![], &config());
        let asked = drive(&mut sampler, |ms| match (ms - MARCH_2021) / DAY {
            0 => unusable("skipped_parse_failure"),
            547 | 548 => unusable("skipped_fetch_failure"),
            _ => Page::Labels(labels(version(&[400], ms))),
        });
        assert_eq!(
            asked.iter().map(|(d, _)| *d).collect::<Vec<_>>(),
            vec![0, 1, 365, 730, 1096, 1461, 1825, 547, 548]
        );
        assert_eq!(days(&sampler.windows()), vec![(365, 730)]);
        assert_eq!(row_days(&sampler), vec![1, 365, 730, 1825]);
        let outcomes: Vec<&str> = sampler
            .entries()
            .iter()
            .map(|e| e["outcome"].as_str().unwrap())
            .collect();
        assert_eq!(
            outcomes,
            [
                "skipped_parse_failure",
                "sampled",
                "sampled",
                "sampled",
                "sampled",
                "sampled",
                "sampled",
                "skipped_fetch_failure",
                "skipped_fetch_failure"
            ]
        );
    }

    #[test]
    fn pages_without_labels_before_any_with_them_are_bisected() {
        // Apple added labels to its web pages during February 2021: the
        // stretch before them is bisected like a change, and the baseline
        // lands within a week of the first page that has them.
        let mut sampler = Sampler::new(daily(0..=1825), vec![], &config());
        let asked = drive(&mut sampler, |ms| {
            if ms < day(15) {
                Page::NoLabels
            } else {
                Page::Labels(labels(0))
            }
        });
        assert_eq!(
            asked
                .iter()
                .filter(|(_, p)| *p == Phase::Bisect)
                .map(|(d, _)| *d)
                .collect::<Vec<_>>(),
            vec![182, 91, 45, 22, 11, 16]
        );
        assert_eq!(row_days(&sampler), vec![16, 1825]);
        assert!(
            sampler.windows().is_empty(),
            "labels appearing is no change"
        );
        assert_eq!(sampler.label_versions(), 1);

        // After the first page with labels, one without is just unusable.
        let mut sampler = Sampler::new(daily(0..=1825), vec![], &config());
        let asked = drive(&mut sampler, |ms| {
            if ms == day(730) {
                Page::NoLabels
            } else {
                Page::Labels(labels(0))
            }
        });
        // The next nearest to 730 is 729: ties go to the earlier capture.
        assert_eq!(
            asked.iter().map(|(d, _)| *d).collect::<Vec<_>>(),
            vec![0, 365, 730, 729, 1096, 1461, 1825]
        );
    }

    fn stored(rows: &[(i64, usize)]) -> Vec<StoredRow> {
        rows.iter()
            .map(|&(d, v)| StoredRow {
                ms: day(d),
                url: Some(capture(day(d)).url),
                snapshot: Some(labels(v)),
            })
            .collect()
    }

    #[test]
    fn stored_rows_are_samples_and_cover_the_skeleton() {
        // What the first test stores. Each skeleton date is near a stored
        // row or between two that agree, and both changes are settled.
        let previous = [(0, 0), (398, 0), (404, 1), (1294, 1), (1300, 2), (1825, 2)];
        let changes = [400, 1300];
        let page = |ms: i64| Page::Labels(labels(version(&changes, ms)));
        let mut again = Sampler::new(daily(0..=1825), stored(&previous), &config());
        assert!(drive(&mut again, page).is_empty());
        assert_eq!(days(&again.windows()), vec![(398, 404), (1294, 1300)]);
        assert!(again.rows().is_empty());

        // Newer captures: only the newest is read, and it becomes the row.
        let mut later = Sampler::new(daily(0..=1900), stored(&previous), &config());
        assert_eq!(drive(&mut later, page), vec![(1900, Phase::Skeleton)]);
        assert_eq!(row_days(&later), vec![1900]);

        // An explicit cadence asks for its density: the dates between rows
        // that agree are read again (365 is still within 45 days of 398),
        // though none of them becomes a row.
        let explicit = SamplerConfig {
            cover_between_equal_rows: false,
            ..config()
        };
        let mut dense = Sampler::new(daily(0..=1825), stored(&previous), &explicit);
        assert_eq!(
            drive(&mut dense, page)
                .iter()
                .map(|(d, _)| *d)
                .collect::<Vec<_>>(),
            vec![730, 1096, 1461]
        );
        assert!(dense.rows().is_empty());

        // Forcing ignores the stored rows and reads the archive afresh; the
        // reads that land on stored captures are not stored again.
        let forced = SamplerConfig {
            force: true,
            cover_between_equal_rows: false,
            ..config()
        };
        let mut fresh = Sampler::new(daily(0..=1825), stored(&previous), &forced);
        assert_eq!(drive(&mut fresh, page).len(), 18);
        assert_eq!(row_days(&fresh), vec![0, 398, 404, 1294, 1300, 1825]);
        assert!(fresh.rows().iter().all(|r| fresh.is_stored_url(&r.url)));
    }

    /// xorshift64*: deterministic noise without a dependency.
    struct Noise(u64);

    impl Noise {
        fn below(&mut self, n: u64) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) % n
        }
    }

    #[test]
    fn random_timelines_find_every_change_the_skeleton_can_see() {
        // Labels only move forward and changes are more than a week apart,
        // so no change can hide; captures are irregular and a few unusable.
        let mut noise = Noise(0x9e37_79b9_7f4a_7c15);
        for _ in 0..300 {
            let mut captures = vec![];
            let mut n = 0;
            while n <= 1825 {
                captures.push(capture(day(n)));
                n += 1 + noise.below(12) as i64;
            }
            let mut changes: Vec<i64> = (0..noise.below(6))
                .map(|_| 1 + noise.below(1824) as i64)
                .collect();
            changes.sort_unstable();
            changes.dedup_by(|b, a| *b - *a <= 7);
            let broken: Vec<i64> = captures
                .iter()
                .filter(|_| noise.below(20) == 0)
                .map(|c| c.ms)
                .collect();
            let mut sampler = Sampler::new(captures.clone(), vec![], &config());
            drive(&mut sampler, |ms| {
                if broken.contains(&ms) {
                    Page::Unusable {
                        outcome: "skipped_fetch_failure",
                        error: None,
                    }
                } else {
                    Page::Labels(labels(version(&changes, ms)))
                }
            });
            let windows = sampler.windows();
            for (from, to) in &windows {
                assert!(version(&changes, *from) < version(&changes, *to));
            }
            let usable: Vec<i64> = captures
                .iter()
                .map(|c| c.ms)
                .filter(|ms| !broken.contains(ms))
                .collect();
            // What the planner holds. A change outside it is out of sight: a
            // skeleton date whose two tries both failed leaves its stretch
            // unread, as the contract allows.
            let sampled: Vec<i64> = sampler
                .entries()
                .iter()
                .filter(|e| e["outcome"] == "sampled")
                .map(|e| e["captureDate"].as_i64().unwrap())
                .collect();
            for c in &changes {
                let before = sampled.iter().any(|&ms| ms < day(*c));
                let after = sampled.iter().any(|&ms| ms >= day(*c));
                if !(before && after) {
                    continue;
                }
                let holder = windows
                    .iter()
                    .find(|(from, to)| *from < day(*c) && day(*c) <= *to);
                let (from, to) = holder.unwrap_or_else(|| panic!("change on day {c} missed"));
                // Settled: within a week, nothing usable left between, or
                // the midpoint that gave up after two unusable reads.
                let usable_between = usable.iter().filter(|&&ms| *from < ms && ms < *to).count();
                let broken_between = broken.iter().filter(|&&ms| *from < ms && ms < *to).count();
                assert!(
                    to - from <= 7 * DAY || usable_between == 0 || broken_between >= 2,
                    "change on day {c} not settled: {from}..{to}"
                );
            }
            let rows = sampler.rows();
            assert!(rows.windows(2).all(|w| w[0].ms < w[1].ms));
            assert!(sampler.reads() <= 6 + 14 * (changes.len() as i64 + 1));
        }
    }

    #[test]
    fn anchors_walk_like_node() {
        // Every value is computeHistoricalTargets from node -e. Node's list
        // thinned 1 February 12:00 against the floor, twelve hours before
        // it; as a skeleton date it stands.
        let nov_1 = 1_635_768_000_000; // 2021-11-01T12:00:00Z
        assert_eq!(
            skeleton_anchors(nov_1, APP_STORE_HISTORICAL_FLOOR_MS, 3),
            vec![1_612_180_800_000, 1_619_870_400_000, 1_627_819_200_000]
        );
        assert_eq!(
            probe_targets(nov_1, 3),
            vec![
                APP_STORE_HISTORICAL_FLOOR_MS,
                1_619_870_400_000,
                1_627_819_200_000,
                nov_1
            ]
        );
        // 31 May minus three months is 3 March: February has no 31st.
        let may_31 = 1_622_462_400_000; // 2021-05-31T12:00:00Z
        assert_eq!(
            skeleton_anchors(may_31, APP_STORE_HISTORICAL_FLOOR_MS, 3),
            vec![1_614_772_800_000]
        );
        // A year back from November 2021 is before the floor.
        assert_eq!(
            skeleton_anchors(nov_1, APP_STORE_HISTORICAL_FLOOR_MS, 12),
            Vec::<i64>::new()
        );
        assert_eq!(
            probe_targets(nov_1, 12),
            vec![APP_STORE_HISTORICAL_FLOOR_MS, nov_1]
        );
        assert_eq!(dedupe_window_for_interval(3.0), 45 * 24 * 60 * 60 * 1000);
        assert_eq!(dedupe_window_for_interval(1.0), 15 * 24 * 60 * 60 * 1000);
        assert_eq!(dedupe_window_for_interval(12.0), 45 * 24 * 60 * 60 * 1000);
    }
}

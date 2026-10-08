//! The bulk Wayback import: a survey of archive.org's capture index for
//! every app, then the archived pages read app by app, with throttling
//! waited out rather than handed back to the user. Started by the routes
//! in `runner_writes.rs` and by the boot-time resume at the bottom of this
//! file; docs/WAYBACK_IMPORT.md (P3) is the design.
//!
//! The run outlives its request: `POST ?stream=1` and `PATCH resume`
//! spawn it, so it owns its accessor, fetcher, ids and clock (the
//! `detach`/`shared` hooks on those traits hand out owned copies), and
//! its frames go down an unbounded channel the response streams. Its
//! state blob (`version: 3`) is a JSON object mutated key by key, as the
//! Node runner it was ported from did: an `undefined` assignment creates a
//! key that serialises to nothing, so it is kept as a `Value` with an
//! undefined sentinel and stripped on write. A v1 or v2 blob from before
//! the survey still resumes, as a reading phase with no survey.
//!
//! - **Survey** (fresh runs): one CDX listing per app, cached for a week
//!   as `wayback.captures.<appId>`. Apps with no captures finish there,
//!   with nothing read; the rest are ordered for reading, apps never
//!   imported first, then the most archived.
//! - **Reading**: `import_app_history` over the cached listing, with Save
//!   Page Now and the availability fallback off.
//! - **Throttling**, in either phase: the run waits until archive.org's
//!   `Retry-After` (five minutes without one), shows the wait in its state
//!   and frames, and asks again for the same app. A pause or a cancel ends
//!   a wait; six throttles in a row with no app finished pause the queue.
//!
//! The state is rewritten at every app boundary, survey included, and at
//! every write a pause or cancel the PATCH stored in the meantime is
//! carried over rather than overwritten. Cancellation is a token per run:
//! the PATCH cancels it, and the runner selects on it around every archive
//! request and every wait. Gated by
//! `core/tests/fixtures/wayback-runner-cases.json`, replayed by
//! `wayback_runner_tests`, which also holds the unit tests of the waits,
//! the survey and the estimate.
use super::{
    activity_log::{record_activity, record_activity_named},
    flags::{context_from_db, resolve_flag},
    guard::{record_audit, Actor},
    live_runs::{self, Job},
    sync_runner::Clock,
    writes::Cx,
};
use crate::{
    jsnum::js_number,
    jsstr::js_slice_prefix,
    outbound::Fetcher,
    scrape::{
        history::{
            alternate_urls_key, history_starts_late, read_alternate_urls, INDEX_UNAVAILABLE,
        },
        import_app_history, notify,
        persist::{DbAccess, Ids, Writer as DbWriter},
        wayback::{self, AppListing, Capture, Unavailable},
        AppRow, HistoryOptions, APP_STORE_HISTORICAL_FLOOR_MS,
    },
};
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

pub(crate) const STATE_KEY: &str = "wayback_bulk_state";
pub(crate) const MUTEX_KEY: &str = "wayback_import_running";
const STATE_SCHEMA_VERSION: i64 = 3;
const CLEAR_STATE: &str = "DELETE FROM app_settings WHERE key = ?";
const INSERT_NOTIFICATION: &str = "\n    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)\n    VALUES (?, ?, ?, ?, ?, 0)\n  ";
const WAYBACK_RESUME_NOTIFICATION_APP_ID: &str = "__wayback_resume__";
const MISSING_URL: &str = "App no longer has a URL — may have been deleted.";

/// Six throttles in a row with no app finished between them pause the
/// queue: archive.org is refusing us for longer than waiting can help.
pub(crate) const MAX_CONSECUTIVE_THROTTLES: i64 = 6;
/// With no Retry-After (always the case for a refused connection) the wait
/// is five minutes: archive.org's blocks have been reported to last about
/// that long, so a shorter retry lands inside the block and extends it.
const WAIT_DEFAULT_MS: i64 = 300_000;
/// A `Retry-After: 0` still waits a second, so a throttling archive is
/// never asked again in a tight loop.
const WAIT_MIN_MS: i64 = 1_000;
/// How long a wait sleeps between looks at the stored state for a pause.
const WAIT_SLICE_MS: i64 = 1_000;
/// How often a long wait rewrites the state, so the health check, which
/// clears a lock whose state has not moved in hours, never reads a waiting
/// run as an abandoned one.
const WAIT_HEARTBEAT_MS: i64 = 10 * 60 * 1000;

/// `wayback.captures.<appId>`: the survey's listing of one app. A cache,
/// so backups leave it out.
pub(crate) const CAPTURE_CACHE_PREFIX: &str = "wayback.captures.";
/// A listing younger than this is reused without asking the index again.
pub(crate) const CAPTURE_CACHE_MAX_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// The paced client's state; its `perMinute` drives the estimate.
const PACER_STATE_KEY: &str = "wayback_pacer_state";
/// The paced client's cooldown (epoch ms): no request leaves before it.
const PACER_COOLDOWN_KEY: &str = "wayback_cooldown_until";
const DEFAULT_PER_MINUTE: f64 = 10.0;
const YEAR_MS: i64 = 365 * 24 * 60 * 60 * 1000;
/// Bisection stops at captures a week apart, about six halvings of a year.
const MAX_BISECT_READS: i64 = 6;
/// The listing assumed for an app the run has no survey of (a resumed v2
/// queue): about a capture every four days since the floor.
const UNSURVEYED_CAPTURES: i64 = 500;

// ── The state blob as JavaScript sees it ─────────────────────────────

const UNDEFINED: &str = "\u{0}undefined\u{0}";

/// An `undefined` assignment: the key exists and serialises to nothing.
pub(crate) fn undefined() -> Value {
    Value::String(UNDEFINED.to_string())
}

fn is_undefined(v: &Value) -> bool {
    v.as_str() == Some(UNDEFINED)
}

fn strip_undefined(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(_, v)| !is_undefined(v))
                .map(|(k, v)| (k.clone(), strip_undefined(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(strip_undefined).collect()),
        other => other.clone(),
    }
}

/// `JSON.stringify`.
pub(crate) fn stringify(v: &Value) -> String {
    strip_undefined(v).to_string()
}

/// `obj.key = value`: in place when present, appended when new.
pub(crate) fn set(obj: &mut Value, key: &str, value: Value) {
    if let Some(m) = obj.as_object_mut() {
        m.insert(key.to_string(), value);
    }
}

/// `obj.key`, an undefined-valued key reading as absent.
pub(crate) fn get<'a>(obj: &'a Value, key: &str) -> Option<&'a Value> {
    obj.get(key).filter(|v| !is_undefined(v))
}

fn str_of<'a>(obj: &'a Value, key: &str) -> &'a str {
    get(obj, key).and_then(Value::as_str).unwrap_or("")
}

fn int_of(obj: &Value, key: &str) -> i64 {
    get(obj, key).and_then(Value::as_i64).unwrap_or(0)
}

/// `obj.key += by`, a missing key counting from zero.
fn add(obj: &mut Value, key: &str, by: i64) {
    let current = int_of(obj, key);
    set(obj, key, json!(current + by));
}

fn normalise_run_status(raw: Option<&Value>) -> &'static str {
    match raw.and_then(Value::as_str) {
        Some("pause_requested") => "pause_requested",
        Some("paused") => "paused",
        Some("cancel_requested") => "cancel_requested",
        _ => "running",
    }
}

/// `readBulkState`: absent, unparseable, an unknown version or a missing
/// field all read as nothing; a v1 or v2 blob is upgraded on read and
/// carries on as a reading phase (see [`prepare_resumed_state`]).
pub(crate) fn read_bulk_state(cx: &Cx) -> Option<Value> {
    let raw = cx.get(STATE_KEY, "");
    if raw.is_empty() {
        return None;
    }
    let mut parsed: Value = serde_json::from_str(&raw).ok()?;
    if !parsed.is_object()
        || !(parsed["version"] == json!(1)
            || parsed["version"] == json!(2)
            || parsed["version"] == json!(STATE_SCHEMA_VERSION))
        || !parsed["runId"].is_string()
        || !parsed["queue"].is_array()
    {
        return None;
    }
    let status = normalise_run_status(parsed.get("status"));
    set(&mut parsed, "version", json!(STATE_SCHEMA_VERSION));
    set(&mut parsed, "status", json!(status));
    Some(parsed)
}

/// `writeBulkState`: the version, a normalised status and `updatedAt`,
/// each in place when the blob already has the key.
pub(crate) fn write_bulk_state(cx: &mut Cx, next: &Value) -> Result<(), String> {
    let mut payload = next.clone();
    let status = normalise_run_status(get(next, "status"));
    set(&mut payload, "version", json!(STATE_SCHEMA_VERSION));
    set(&mut payload, "status", json!(status));
    set(&mut payload, "updatedAt", json!(cx.now));
    cx.set(STATE_KEY, &stringify(&payload))
}

pub(crate) fn clear_bulk_state(cx: &mut Cx) -> Result<(), String> {
    cx.w.run(CLEAR_STATE, vec![json!(STATE_KEY)]).map(drop)
}

pub(crate) fn mutex_held(cx: &Cx) -> bool {
    cx.get(MUTEX_KEY, "") == "true"
}

fn acquire_mutex(cx: &mut Cx) -> Result<bool, String> {
    if mutex_held(cx) {
        return Ok(false);
    }
    cx.set(MUTEX_KEY, "true")?;
    Ok(true)
}

pub(crate) fn release_mutex(cx: &mut Cx) -> Result<(), String> {
    cx.set(MUTEX_KEY, "false")
}

/// `summariseState`.
pub(crate) fn summarise(state: &Value) -> Value {
    let (mut pending, mut in_progress, mut done, mut failed) = (0, 0, 0, 0);
    let queue = state["queue"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    for entry in queue {
        match str_of(entry, "status") {
            "pending" => pending += 1,
            "in_progress" => in_progress += 1,
            "done" => done += 1,
            "failed" => failed += 1,
            _ => {}
        }
    }
    json!({
        "total": queue.len(),
        "pending": pending,
        "inProgress": in_progress,
        "done": done,
        "failed": failed,
        "remaining": pending + in_progress,
    })
}

pub(crate) fn has_pending_work(state: Option<&Value>) -> bool {
    state.is_some_and(|s| {
        s["queue"].as_array().is_some_and(|q| {
            q.iter()
                .any(|e| matches!(str_of(e, "status"), "pending" | "in_progress"))
        })
    })
}

pub(crate) fn is_paused(state: Option<&Value>) -> bool {
    state.is_some_and(|s| matches!(str_of(s, "status"), "paused" | "pause_requested"))
}

pub(crate) fn is_cancel_requested(state: Option<&Value>) -> bool {
    state.is_some_and(|s| str_of(s, "status") == "cancel_requested")
}

/// The run's totals: the per-checkpoint counts the per-app import reports,
/// then the run in apps, pages read and label changes.
pub(crate) fn zero_totals() -> Value {
    json!({
        "appsAttempted": 0,
        "appsWithImports": 0,
        "targetsAttempted": 0,
        "imported": 0,
        "unchanged": 0,
        "skipped": 0,
        "failed": 0,
        "snapshotsRequested": 0,
        "appsDone": 0,
        "appsRead": 0,
        "appsWithHistory": 0,
        "appsNoArchive": 0,
        "reads": 0,
        "changes": 0,
        "labelVersions": 0,
    })
}

fn zero_survey() -> Value {
    json!({
        "appsSurveyed": 0,
        "appsWithCaptures": 0,
        "appsWithoutCaptures": 0,
        "capturesTotal": 0,
        "estimatedReads": 0,
        "completedAt": null,
    })
}

fn queue_len(state: &Value) -> usize {
    state["queue"].as_array().map_or(0, Vec::len)
}

fn is_finished(entry: &Value) -> bool {
    matches!(str_of(entry, "status"), "done" | "failed")
}

fn surveyed(entry: &Value) -> bool {
    get(entry, "captureCount").is_some_and(|v| !v.is_null())
}

/// An app with archived history: a label state read from the archive, or,
/// from an import that predates the count, a row written.
fn has_history(result: &Value) -> bool {
    int_of(result, "labelVersions") > 0 || int_of(result, "imported") > 0
}

/// The v3 totals a blob from before them lacks, counted from its queue.
fn upgrade_totals(state: &mut Value) {
    if !state["totals"].is_object() {
        set(state, "totals", zero_totals());
    }
    let queue = state["queue"].as_array().cloned().unwrap_or_default();
    let finished = || queue.iter().filter(|e| is_finished(e));
    let no_archive = |e: &&Value| get(e, "noArchive").and_then(Value::as_bool) == Some(true);
    let sum = |key: &str| queue.iter().map(|e| int_of(e, key)).sum::<i64>();
    let fills = [
        ("appsDone", finished().count() as i64),
        (
            "appsRead",
            finished().filter(|e| !no_archive(e)).count() as i64,
        ),
        (
            "appsWithHistory",
            finished()
                .filter(|e| str_of(e, "status") == "done" && has_history(e))
                .count() as i64,
        ),
        (
            "appsNoArchive",
            queue.iter().filter(no_archive).count() as i64,
        ),
        ("reads", sum("reads")),
        ("changes", sum("changes")),
        ("labelVersions", sum("labelVersions")),
    ];
    for (key, value) in fills {
        if get(&state["totals"], key).is_none() {
            set(&mut state["totals"], key, json!(value));
        }
    }
}

/// A queue a run resumes: the phase it was in (a blob from before the
/// survey is a reading phase), the throttle count, and the v3 totals. A
/// manual resume is the user asking to try again, so its throttle count
/// starts over; a boot resume carries on the run it was.
fn prepare_resumed_state(state: &mut Value, initiator: &str, now: i64) {
    if str_of(state, "phase") != "survey" {
        set(state, "phase", json!("reading"));
    } else if !state.get("survey").is_some_and(Value::is_object) {
        set(state, "survey", zero_survey());
    }
    if initiator == "manual" || get(state, "consecutiveThrottles").is_none() {
        set(state, "consecutiveThrottles", json!(0));
    }
    upgrade_totals(state);
    // A wait that ran out while the process was down is over.
    let wait_over = match get(state, "waitingUntil") {
        None => false,
        Some(until) => until.as_i64().map_or(true, |until| until <= now),
    };
    if wait_over {
        set(state, "waitingUntil", undefined());
        set(state, "waitReason", undefined());
    }
}

// ── The cancellation registry ────────────────────────────────────────

struct Active {
    tag: u64,
    token: CancellationToken,
}

fn active_runs() -> &'static Mutex<HashMap<String, Active>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Active>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_TAG: AtomicU64 = AtomicU64::new(1);

/// `requestActiveBulkWaybackCancel`: the run with that id, or every run
/// when none is named. True when something was told to stop.
pub(crate) fn request_active_cancel(run_id: Option<&str>) -> bool {
    let runs = super::lifecycle::lock_state(active_runs());
    match run_id.filter(|id| !id.is_empty()) {
        Some(id) => match runs.get(id) {
            Some(active) => {
                active.token.cancel();
                true
            }
            None => false,
        },
        None => {
            let mut aborted = false;
            for active in runs.values() {
                active.token.cancel();
                aborted = true;
            }
            aborted
        }
    }
}

// ── The capture cache, the pacer's rate and the estimate ─────────────

fn capture_cache_key(app_id: &str) -> String {
    format!("{CAPTURE_CACHE_PREFIX}{app_id}")
}

/// The survey's listing of `app`, while it is younger than a week and was
/// taken of the addresses the app has now: the same stored address and the
/// same older ones. A listing from before the US lookup has no
/// `storedUrl`; it was of the stored address, which is still the lookup
/// address only for a US page. Anything malformed reads as no listing, and
/// the index is asked again.
pub(crate) fn cached_listing(cx: &Cx, app: &AppRow, alternates: &[String]) -> Option<AppListing> {
    let raw = cx.get(&capture_cache_key(&app.id), "");
    let cache: Value = serde_json::from_str(&raw).ok()?;
    let fetched_at = cache.get("fetchedAt")?.as_f64()?;
    if (cx.now as f64) - fetched_at >= CAPTURE_CACHE_MAX_AGE_MS as f64 {
        return None;
    }
    let lookup_url = cache.get("url")?.as_str()?;
    let taken_for_this_address = match cache.get("storedUrl") {
        Some(stored) => stored.as_str()? == app.url,
        None => {
            lookup_url == app.url
                && wayback::us_storefront_url(&app.url).map_or(true, |us| us == app.url)
        }
    };
    if !taken_for_this_address {
        return None;
    }
    let mut listed: Vec<(&str, &Vec<Value>)> =
        vec![(lookup_url, cache.get("timestamps")?.as_array()?)];
    let mut alternate_urls = vec![];
    if let Some(cached) = cache.get("alternates") {
        for alternate in cached.as_array()? {
            let url = alternate.get("url")?.as_str()?;
            listed.push((url, alternate.get("timestamps")?.as_array()?));
            alternate_urls.push(url.to_string());
        }
    }
    let (mut asked, mut wanted) = (alternate_urls.clone(), alternates.to_vec());
    asked.sort();
    wanted.sort();
    if asked != wanted {
        return None;
    }
    let mut captures = vec![];
    let mut seen = HashSet::new();
    for (address, timestamps) in listed {
        for timestamp in timestamps {
            let timestamp = timestamp.as_str()?;
            if !seen.insert(timestamp) {
                continue;
            }
            captures.push(Capture {
                ms: wayback::parse_timestamp_ms(Some(timestamp))?,
                timestamp: timestamp.to_string(),
                url: format!("https://web.archive.org/web/{timestamp}/{address}"),
            });
        }
    }
    captures.sort_by_key(|c| c.ms);
    Some(AppListing {
        lookup_url: lookup_url.to_string(),
        alternate_urls,
        captures,
    })
}

/// `{fetchedAt, url, timestamps}` as before, `url` now the address whose
/// listing led, plus the stored address it was taken for and each older
/// address's own timestamps.
fn cache_listing(cx: &mut Cx, app: &AppRow, listing: &AppListing) -> Result<(), String> {
    let of = |address: &str| -> Vec<&str> {
        listing
            .captures
            .iter()
            .filter(|c| wayback::capture_address(&c.url) == Some(address))
            .map(|c| c.timestamp.as_str())
            .collect()
    };
    let mut cache = json!({
        "fetchedAt": cx.now,
        "url": listing.lookup_url,
        "timestamps": of(&listing.lookup_url),
        "storedUrl": app.url,
    });
    if !listing.alternate_urls.is_empty() {
        cache["alternates"] = listing
            .alternate_urls
            .iter()
            .map(|url| json!({ "url": url, "timestamps": of(url) }))
            .collect();
    }
    cx.set(&capture_cache_key(&app.id), &cache.to_string())
}

/// The settings that belong to one app and go when it does: the survey's
/// listing and the older addresses the user added. Each is read first and
/// deleted only when present, so deleting an app with neither runs exactly
/// the statements it always did.
pub(crate) fn forget_app_settings(w: &mut DbWriter<'_>, app_id: &str) -> Result<(), String> {
    for key in [capture_cache_key(app_id), alternate_urls_key(app_id)] {
        let present = w
            .conn
            .query_row("SELECT 1 FROM app_settings WHERE key = ?", [&key], |_| {
                Ok(())
            })
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if present {
            w.run(CLEAR_STATE, vec![json!(key)])?;
        }
    }
    Ok(())
}

/// `wayback_cooldown_until`, the end of the paced client's cooldown, or 0.
fn pacer_cooldown_until(cx: &Cx) -> i64 {
    let raw = cx.get(PACER_COOLDOWN_KEY, "");
    raw.trim()
        .parse::<f64>()
        .ok()
        .filter(|until| until.is_finite())
        .map_or(0, |until| until as i64)
}

/// `wayback_pacer_state.perMinute`, the paced client's current rate, or 10.
fn pacer_per_minute(cx: &Cx) -> f64 {
    serde_json::from_str::<Value>(&cx.get(PACER_STATE_KEY, ""))
        .ok()
        .and_then(|state| state.get("perMinute").and_then(Value::as_f64))
        .filter(|rate| rate.is_finite() && *rate > 0.0)
        .unwrap_or(DEFAULT_PER_MINUTE)
}

fn ceil_log2(n: i64) -> i64 {
    if n <= 1 {
        0
    } else {
        i64::from(64 - (n - 1).leading_zeros())
    }
}

/// About how many archived pages reading one app takes, from its listing
/// alone. The import reads a skeleton (the earliest and the newest capture
/// and one a year back from today between them), then bisects each change
/// down to captures a week apart. The changes cannot be known in advance,
/// so this assumes one: about log2 of the captures between two skeleton
/// reads, six at most. An estimate for the progress card, not a budget.
pub(crate) fn estimate_reads(
    capture_count: i64,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
    now: i64,
) -> i64 {
    if capture_count <= 0 {
        return 0;
    }
    let first = first_ms.unwrap_or(APP_STORE_HISTORICAL_FLOOR_MS);
    let last = last_ms.unwrap_or(now);
    let mut anchors = 0;
    let mut anchor = now - YEAR_MS;
    while anchor > APP_STORE_HISTORICAL_FLOOR_MS {
        if anchor > first && anchor < last {
            anchors += 1;
        }
        anchor -= YEAR_MS;
    }
    let skeleton = (2 + anchors).min(capture_count);
    if skeleton < 2 {
        return skeleton;
    }
    let bisect = ceil_log2(capture_count / (skeleton - 1)).min(MAX_BISECT_READS);
    (skeleton + bisect).min(capture_count)
}

fn entry_estimated_reads(entry: &Value, now: i64) -> i64 {
    if !surveyed(entry) {
        return estimate_reads(UNSURVEYED_CAPTURES, None, None, now);
    }
    estimate_reads(
        int_of(entry, "captureCount"),
        get(entry, "firstCaptureMs").and_then(Value::as_i64),
        get(entry, "lastCaptureMs").and_then(Value::as_i64),
        now,
    )
}

/// `estimate`: the pages read so far, the pages the apps still to read are
/// expected to take, and how long those take at the pacer's rate.
pub(crate) fn compute_estimate(state: &Value, per_minute: f64, now: i64) -> Value {
    let reads_remaining: i64 = state["queue"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|e| !is_finished(e))
        .map(|e| entry_estimated_reads(e, now))
        .sum();
    let eta_ms = (reads_remaining as f64 * 60_000.0 / per_minute).ceil() as i64;
    json!({
        "readsDone": int_of(&state["totals"], "reads"),
        "readsRemaining": reads_remaining,
        "perMinute": js_number(per_minute),
        "etaMs": eta_ms,
    })
}

fn refresh_estimate(cx: &Cx, state: &mut Value) -> Value {
    let estimate = compute_estimate(state, pacer_per_minute(cx), cx.now);
    set(state, "estimate", estimate.clone());
    estimate
}

/// The order apps are read in: apps the archive has pages of and no
/// imported rows yet first, then the most archived; apps already finished
/// (no captures, or a failed listing) go to the back. Ties keep the name
/// order the queue was built in.
fn order_queue(cx: &Cx, state: &mut Value) -> Result<(), String> {
    let id_text = |v: &Value| match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    let imported: HashSet<String> = super::stats::query(
        cx.w.conn,
        "SELECT DISTINCT app_id FROM privacy_snapshots WHERE source = 'wayback'",
        &[],
    )
    .map_err(|e| e.to_string())?
    .iter()
    .map(|r| id_text(&r["app_id"]))
    .collect();
    let Some(queue) = state["queue"].as_array_mut() else {
        return Ok(());
    };
    let mut keyed: Vec<_> = queue
        .drain(..)
        .enumerate()
        .map(|(at, entry)| {
            let key = (
                is_finished(&entry),
                imported.contains(&id_text(&entry["appId"])),
                Reverse(int_of(&entry, "captureCount")),
                at,
            );
            (key, entry)
        })
        .collect();
    keyed.sort_by_key(|(key, _)| *key);
    queue.extend(keyed.into_iter().map(|(_, entry)| entry));
    Ok(())
}

// ── lib/wayback-bulk-runner.ts ───────────────────────────────────────

/// `buildInitialQueue`: every app with a URL, by name.
pub(crate) fn build_initial_queue(cx: &Cx) -> Result<Vec<Value>, String> {
    let rows = super::stats::query(
        cx.w.conn,
        "SELECT id, url, name
         FROM apps
        WHERE url IS NOT NULL AND TRIM(url) != ''
        ORDER BY name COLLATE NOCASE ASC",
        &[],
    )
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| json!({"appId": r["id"], "appName": r["name"], "status": "pending"}))
        .collect())
}

fn lookup_app_row(cx: &Cx, app_id: &str) -> Result<Option<AppRow>, String> {
    let rows = super::stats::query(
        cx.w.conn,
        "SELECT id, url, name FROM apps WHERE id = ?",
        &[rusqlite::types::Value::Text(app_id.to_string())],
    )
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().next().map(|r| AppRow {
        id: r["id"].as_str().unwrap_or("").to_string(),
        name: r["name"].as_str().unwrap_or("").to_string(),
        url: r["url"].as_str().unwrap_or("").to_string(),
    }))
}

/// How long a throttle waits: archive.org's `Retry-After`, or five minutes
/// without one, and never less than a second. No upper bound: the paced
/// client hands back what is left of its cooldown, which can be an hour.
pub(crate) fn wait_ms_for(retry_after_ms: Option<i64>) -> i64 {
    retry_after_ms.unwrap_or(WAIT_DEFAULT_MS).max(WAIT_MIN_MS)
}

/// The per-checkpoint counts, then pages, changes and label states, which
/// an import that does not report them adds nothing to.
fn accumulate_totals(totals: &mut Value, result: &Value) {
    add(totals, "targetsAttempted", int_of(result, "attempted"));
    for key in [
        "imported",
        "unchanged",
        "skipped",
        "failed",
        "snapshotsRequested",
        "reads",
        "changes",
        "labelVersions",
    ] {
        add(totals, key, int_of(result, key));
    }
    if int_of(result, "imported") > 0 {
        add(totals, "appsWithImports", 1);
    }
    if has_history(result) {
        add(totals, "appsWithHistory", 1);
    }
}

fn plural(n: i64) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

fn changes_found(changes: i64) -> String {
    match changes {
        0 => "no label changes found".to_string(),
        1 => "1 label change found".to_string(),
        n => format!("{n} label changes found"),
    }
}

/// The activity row of one app: "Instagram: 3 label changes found, 12
/// pages read".
fn bulk_app_line(app_name: &str, result: &Value) -> String {
    let reads = int_of(result, "reads");
    js_slice_prefix(
        &format!(
            "{app_name}: {}, {reads} page{} read",
            changes_found(int_of(result, "changes")),
            plural(reads)
        ),
        200,
    )
}

/// The activity row of the run: "Wayback import: 201 of 201 apps checked,
/// 37 label changes found, 58 apps have no archived pages".
fn build_bulk_summary(
    totals: &Value,
    initiator: &str,
    queue_length: usize,
    failed_apps: i64,
) -> String {
    let total = queue_length as i64;
    let mut parts = vec![
        format!(
            "{} of {total} app{} checked",
            int_of(totals, "appsDone"),
            plural(total)
        ),
        changes_found(int_of(totals, "changes")),
    ];
    let no_archive = int_of(totals, "appsNoArchive");
    if no_archive > 0 {
        parts.push(format!(
            "{no_archive} app{} {} no archived pages",
            plural(no_archive),
            if no_archive == 1 { "has" } else { "have" }
        ));
    }
    if failed_apps > 0 {
        parts.push(format!("{failed_apps} failed"));
    }
    let prefix = if initiator == "resume" {
        "Wayback import (resumed)"
    } else {
        "Wayback import"
    };
    js_slice_prefix(&format!("{prefix}: {}", parts.join(", ")), 200)
}

fn pick_app_activity_status(result: &Value) -> &'static str {
    if int_of(result, "failed") == 0 {
        "ok"
    } else if int_of(result, "imported") > 0 || int_of(result, "unchanged") > 0 {
        "partial"
    } else {
        "error"
    }
}

/// "5 min", or seconds under a minute.
fn human_duration(ms: i64) -> String {
    let seconds = (ms + 999) / 1000;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{} min", (seconds + 59) / 60)
    }
}

/// The NDJSON sink: frames are dropped when nobody is streaming.
pub(crate) type Writer = Option<UnboundedSender<Value>>;

fn emit(writer: &Writer, frame: Value) {
    if let Some(tx) = writer {
        let _ = tx.send(frame);
    }
}

fn frame(kind: &str, fields: Value) -> Value {
    let mut out = Map::new();
    out.insert("type".into(), json!(kind));
    if let Some(m) = fields.as_object() {
        for (k, v) in m {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

pub(crate) struct RunOptions {
    pub initiator: &'static str,
    pub resume_state: Option<Value>,
    pub stream_requested: bool,
    pub writer: Writer,
    pub actor_ip: Option<String>,
    pub user_agent: Option<String>,
}

pub(crate) struct RunResult {
    pub totals: Value,
    pub duration_ms: i64,
}

fn audit_actor(options: &RunOptions) -> Actor {
    Actor {
        ip: options.actor_ip.clone().unwrap_or_default(),
        user_agent: options.user_agent.clone(),
    }
}

// ── The waits ────────────────────────────────────────────────────────

/// One slice of a wait. A test can swap in a fake clock's sleep, which
/// moves its time on instead of waiting for it.
async fn sleep(duration: Duration) {
    #[cfg(test)]
    {
        if let Some(advance) = TEST_SLEEP.with(|s| s.borrow().clone()) {
            advance(duration);
            tokio::task::yield_now().await;
            return;
        }
    }
    tokio::time::sleep(duration).await;
}

/// A fake clock's advance, called with every slice a wait sleeps.
#[cfg(test)]
pub(crate) type FakeSleep = std::sync::Arc<dyn Fn(Duration) + Send + Sync>;

#[cfg(test)]
thread_local! {
    static TEST_SLEEP: std::cell::RefCell<Option<FakeSleep>> = const { std::cell::RefCell::new(None) };
}

/// Every wait on this thread advances `advance` instead of sleeping, until
/// it is set back to `None`. The replay and the unit tests run each run on
/// a current-thread runtime, so the run's waits are on the test's thread.
#[cfg(test)]
pub(crate) fn fake_sleep(advance: Option<FakeSleep>) {
    TEST_SLEEP.with(|s| *s.borrow_mut() = advance);
}

// ── The run ──────────────────────────────────────────────────────────

/// The run's connection, ids and clock, taken one section at a time.
struct Io<'r> {
    db: &'r mut dyn DbAccess,
    ids: &'r mut dyn Ids,
    clock: &'r dyn Clock,
}

impl Io<'_> {
    fn section<R>(&mut self, f: impl FnOnce(&mut Cx) -> R) -> R {
        let now = self.clock.now();
        let ids = &mut *self.ids;
        self.db.with(move |w| f(&mut Cx { w, ids, now }))
    }
}

/// What the run reads but never changes.
struct Ctl<'r> {
    fetcher: &'r dyn Fetcher,
    options: &'r RunOptions,
    writer: &'r Writer,
    token: &'r CancellationToken,
    run_started_at: i64,
}

/// What the archive walk of one app came back with.
enum Walked {
    Done(Value),
    Failed(String),
    Unavailable(Unavailable),
    Aborted,
}

/// `runBulkWaybackImport`. Errors are what the outer catch rethrows, with
/// the state and mutex left in place for the next boot.
pub(crate) async fn run_bulk_wayback_import(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    options: RunOptions,
) -> Result<RunResult, String> {
    // Live on this server until the run ends, however it ends, so the boot
    // check never mistakes it for a run a previous process left behind.
    let _live = db.with(|w| live_runs::enter(w.conn, Job::Wayback));
    let writer = options.writer.clone();
    let token = CancellationToken::new();
    let tag = NEXT_TAG.fetch_add(1, Ordering::SeqCst);

    // The seed, the mutex, the batch frame: one section before any await.
    let now = clock.now();
    let mut state: Value = match options.resume_state.clone() {
        Some(mut state) => {
            // The blob still names whoever started the run; record who runs
            // it now ("resume" from the boot check, "manual" from Resume
            // queue), before the first write, so a resume reads as one.
            set(&mut state, "initiator", json!(options.initiator));
            // An app in flight when the process died is redone, and its
            // attempt, counted then, is counted again: un-count the first,
            // as the throttled-retry path does.
            let mut redone = 0;
            if let Some(queue) = state["queue"].as_array_mut() {
                for entry in queue {
                    if str_of(entry, "status") == "in_progress" {
                        set(entry, "status", json!("pending"));
                        redone += 1;
                    }
                }
            }
            for _ in 0..redone {
                let attempted = int_of(&state["totals"], "appsAttempted");
                set(
                    &mut state["totals"],
                    "appsAttempted",
                    json!((attempted - 1).max(0)),
                );
            }
            prepare_resumed_state(&mut state, options.initiator, now);
            state
        }
        None => Value::Null,
    };
    let seeded = db.with(|w| -> Result<(), String> {
        let cx = &mut Cx { w, ids, now };
        if state.is_null() {
            let queue = build_initial_queue(cx)?;
            state = json!({
                "version": STATE_SCHEMA_VERSION,
                "runId": cx.ids.uuid(cx.w.conn)?,
                "startedAt": cx.now,
                "initiator": options.initiator,
                "updatedAt": cx.now,
                "currentAppId": Value::Null,
                "status": "running",
                "phase": "survey",
                "consecutiveThrottles": 0,
                "queue": queue,
                "totals": zero_totals(),
                "survey": zero_survey(),
                "streamRequested": options.stream_requested,
            });
        }
        set(&mut state, "status", json!("running"));
        set(&mut state, "pausedAt", undefined());
        set(&mut state, "pauseCause", undefined());
        set(&mut state, "pauseRequestedAt", undefined());
        set(&mut state, "cancelRequestedAt", undefined());
        acquire_mutex(cx)?;
        write_bulk_state(cx, &state)
    });
    seeded?;
    let run_id = str_of(&state, "runId").to_string();
    super::lifecycle::lock_state(active_runs()).insert(
        run_id.clone(),
        Active {
            tag,
            token: token.clone(),
        },
    );
    let run_started_at = clock.now();
    let queue_len = queue_len(&state);
    emit(
        &writer,
        frame(
            "batch-start",
            json!({
                "total": queue_len,
                "startedAt": state["startedAt"],
                "initiator": state["initiator"],
                "runId": run_id,
            }),
        ),
    );

    let ctl = Ctl {
        fetcher,
        options: &options,
        writer: &writer,
        token: &token,
        run_started_at,
    };
    let outcome = {
        let mut io = Io {
            db: &mut *db,
            ids: &mut *ids,
            clock,
        };
        walk(&mut io, &ctl, &mut state).await
    };
    {
        let mut runs = super::lifecycle::lock_state(active_runs());
        if runs.get(&run_id).is_some_and(|a| a.tag == tag) {
            runs.remove(&run_id);
        }
    }
    match outcome {
        Ok(result) => Ok(result),
        Err(message) => {
            // The outer catch: the frame and the rows, then the rethrow with
            // the state and mutex left for the next boot.
            emit(&writer, frame("error", json!({ "error": message })));
            let now = clock.now();
            db.with(|w| {
                let cx = &mut Cx { w, ids, now };
                record_activity(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback_import",
                    "error",
                    None,
                    Some(&js_slice_prefix(
                        &format!("Bulk Wayback import aborted: {message}"),
                        200,
                    )),
                    Some(&json!({
                        "mode": "bulk",
                        "errorMessage": message,
                        "totals": state["totals"],
                        "runId": state["runId"],
                    })),
                    int_of(&state, "startedAt"),
                );
                record_audit(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback.import.bulk.failed",
                    &audit_actor(&options),
                    Some(&js_slice_prefix(&message, 200)),
                    false,
                );
            });
            Err(message)
        }
    }
}

/// The phases in order, then the clean completion.
async fn walk(io: &mut Io<'_>, ctl: &Ctl<'_>, state: &mut Value) -> Result<RunResult, String> {
    let surveying = str_of(state, "phase") == "survey";
    emit(
        ctl.writer,
        frame(
            "phase",
            json!({ "phase": if surveying { "survey" } else { "reading" } }),
        ),
    );
    if let Some(finished) = resume_wait(io, ctl, state).await? {
        return Ok(finished);
    }
    if surveying {
        if let Some(finished) = survey(io, ctl, state).await? {
            return Ok(finished);
        }
        emit(ctl.writer, frame("phase", json!({ "phase": "reading" })));
    } else {
        // A resumed reading phase: where the run stands before its first app.
        let estimate = io.section(|cx| refresh_estimate(cx, state));
        emit(
            ctl.writer,
            frame("estimate", json!({ "estimate": estimate })),
        );
    }
    if let Some(finished) = read_all(io, ctl, state).await? {
        return Ok(finished);
    }
    complete(io, ctl, state)
}

/// The state at a boundary, with a pause or a cancel the PATCH stored since
/// the last write carried over rather than overwritten.
fn persist(cx: &mut Cx, state: &mut Value) -> Result<(), String> {
    sync_control_status_from_disk(cx, state);
    write_bulk_state(cx, state)
}

/// The app a wait is for: the next one the run asks archive.org about.
fn next_app(state: &Value) -> (Value, Value) {
    let surveying = str_of(state, "phase") == "survey";
    state["queue"]
        .as_array()
        .and_then(|queue| {
            queue
                .iter()
                .find(|e| !(is_finished(e) || (surveying && surveyed(e))))
        })
        .map_or((Value::Null, Value::Null), |e| {
            (e["appId"].clone(), e["appName"].clone())
        })
}

/// A wait the previous process was in the middle of: what is left of it,
/// before anything is asked of archive.org.
async fn resume_wait(
    io: &mut Io<'_>,
    ctl: &Ctl<'_>,
    state: &mut Value,
) -> Result<Option<RunResult>, String> {
    let Some(until) = get(state, "waitingUntil").and_then(Value::as_i64) else {
        return Ok(None);
    };
    let left = until - io.clock.now();
    let (app_id, app_name) = next_app(state);
    emit(
        ctl.writer,
        frame(
            "waiting",
            json!({ "appId": app_id, "name": app_name, "until": until, "reason": str_of(state, "waitReason") }),
        ),
    );
    wait_out(io, ctl, state, left).await
}

/// Sleeps out a wait a slice at a time, looking at the stored state after
/// each for a pause the PATCH asked for (a cancel wakes it at once through
/// the token), and rewriting the state now and then on a long one. The
/// end of the wait is persisted before the retry.
async fn wait_out(
    io: &mut Io<'_>,
    ctl: &Ctl<'_>,
    state: &mut Value,
    delay_ms: i64,
) -> Result<Option<RunResult>, String> {
    let mut left = delay_ms.max(0);
    let mut since_heartbeat = 0;
    while left > 0 {
        let slice = left.min(WAIT_SLICE_MS);
        let cancelled = tokio::select! {
            biased;
            _ = ctl.token.cancelled() => true,
            _ = sleep(Duration::from_millis(slice as u64)) => false,
        };
        if cancelled {
            return aborted(io, ctl, state, "Wayback import cancelled");
        }
        left -= slice;
        since_heartbeat += slice;
        let heartbeat = since_heartbeat >= WAIT_HEARTBEAT_MS;
        if heartbeat {
            since_heartbeat = 0;
        }
        let finished = io.section(|cx| -> Result<Option<RunResult>, String> {
            sync_control_status_from_disk(cx, state);
            if matches!(
                str_of(state, "status"),
                "pause_requested" | "cancel_requested"
            ) {
                return finish_if_control_requested(cx, state, ctl);
            }
            if heartbeat {
                write_bulk_state(cx, state)?;
            }
            Ok(None)
        })?;
        if finished.is_some() {
            return Ok(finished);
        }
    }
    io.section(|cx| {
        set(state, "waitingUntil", undefined());
        set(state, "waitReason", undefined());
        persist(cx, state)
    })?;
    Ok(None)
}

/// The token fired: a cancel the PATCH stored finishes the run, and
/// anything else is the outer catch's error.
fn aborted(
    io: &mut Io<'_>,
    ctl: &Ctl<'_>,
    state: &mut Value,
    error: &str,
) -> Result<Option<RunResult>, String> {
    set(state, "currentAppId", Value::Null);
    match io.section(|cx| finish_if_control_requested(cx, state, ctl))? {
        Some(finished) => Ok(Some(finished)),
        None => Err(error.to_string()),
    }
}

enum Throttled {
    Retry,
    Finished(RunResult),
}

/// archive.org refused us, in either phase: count it, pause the queue on
/// the sixth in a row, and otherwise wait until it said to ask again and
/// retry the same app.
async fn throttled(
    io: &mut Io<'_>,
    ctl: &Ctl<'_>,
    state: &mut Value,
    index: usize,
    app: &AppRow,
    unavailable: Unavailable,
) -> Result<Throttled, String> {
    let reading = str_of(state, "phase") != "survey";
    let resumed = str_of(state, "initiator") == "resume";
    let message = unavailable.message;
    let decided = io.section(|cx| -> Result<Result<i64, RunResult>, String> {
        let throttles = int_of(state, "consecutiveThrottles") + 1;
        set(state, "consecutiveThrottles", json!(throttles));
        if reading {
            // Nothing is wrong with the app: it goes back in the queue, and
            // its attempt is counted again when it is retried.
            let entry = &mut state["queue"][index];
            set(entry, "status", json!("pending"));
            set(entry, "finishedAt", undefined());
            set(entry, "error", json!(js_slice_prefix(&message, 200)));
            let attempted = int_of(&state["totals"], "appsAttempted");
            set(
                &mut state["totals"],
                "appsAttempted",
                json!((attempted - 1).max(0)),
            );
        }
        set(state, "currentAppId", Value::Null);
        if throttles >= MAX_CONSECUTIVE_THROTTLES {
            return pause_run(cx, state, ctl, "rate_limited", Some(&message)).map(Err);
        }
        // Until archive.org said to ask again, and never inside the paced
        // client's cooldown, which a retry would only meet as one more
        // throttle.
        let until = (cx.now + wait_ms_for(unavailable.retry_after_ms))
            .max(pacer_cooldown_until(cx));
        let delay_ms = until - cx.now;
        set(state, "waitingUntil", json!(until));
        set(state, "waitReason", json!(js_slice_prefix(&message, 200)));
        persist(cx, state)?;
        emit(
            ctl.writer,
            frame(
                "waiting",
                json!({ "appId": app.id, "name": app.name, "until": until, "reason": message }),
            ),
        );
        record_activity_named(
            cx.w,
            cx.ids,
            cx.now,
            "wayback_import",
            "partial",
            Some(&app.id),
            Some(&app.name),
            Some(&js_slice_prefix(
                &format!(
                    "archive.org is limiting requests; the Wayback import waits {} before retrying {}",
                    human_duration(delay_ms),
                    app.name
                ),
                200,
            )),
            Some(&json!({
                "mode": "bulk-wait",
                "phase": if reading { "reading" } else { "survey" },
                "waitingUntil": until,
                "delayMs": delay_ms,
                "consecutiveThrottles": throttles,
                "errorMessage": message,
                "resumedRun": resumed,
            })),
            cx.now,
        );
        Ok(Ok(delay_ms))
    })?;
    let delay_ms = match decided {
        Err(finished) => return Ok(Throttled::Finished(finished)),
        Ok(delay_ms) => delay_ms,
    };
    Ok(match wait_out(io, ctl, state, delay_ms).await? {
        Some(finished) => Throttled::Finished(finished),
        None => Throttled::Retry,
    })
}

// ── The survey ───────────────────────────────────────────────────────

enum SurveyStep {
    Finished(RunResult),
    Missing { app_id: String, app_name: String },
    Cached(AppRow, AppListing),
    List(AppRow, Vec<String>),
}

/// One listing per app not surveyed yet, then the queue ordered for
/// reading and the survey's totals with the first estimate.
async fn survey(
    io: &mut Io<'_>,
    ctl: &Ctl<'_>,
    state: &mut Value,
) -> Result<Option<RunResult>, String> {
    let total = queue_len(state);
    let mut index = 0;
    while index < total {
        if is_finished(&state["queue"][index]) || surveyed(&state["queue"][index]) {
            index += 1;
            continue;
        }
        // The boundary: a pause or a cancel, then the app and its cache.
        let step = io.section(|cx| -> Result<SurveyStep, String> {
            if let Some(finished) = finish_if_control_requested(cx, state, ctl)? {
                return Ok(SurveyStep::Finished(finished));
            }
            let entry = &state["queue"][index];
            let app_id = str_of(entry, "appId").to_string();
            let app_name = str_of(entry, "appName").to_string();
            let Some(app) = lookup_app_row(cx, &app_id)?.filter(|a| !a.url.is_empty()) else {
                return Ok(SurveyStep::Missing { app_id, app_name });
            };
            let alternates = read_alternate_urls(cx.w.conn, &app.id)?;
            Ok(match cached_listing(cx, &app, &alternates) {
                Some(listing) => SurveyStep::Cached(app, listing),
                None => SurveyStep::List(app, alternates),
            })
        })?;
        let (app, listed, cached) = match step {
            SurveyStep::Finished(finished) => return Ok(Some(finished)),
            SurveyStep::Missing { app_id, app_name } => {
                io.section(|cx| {
                    survey_failed(cx, state, ctl, index, &app_id, &app_name, MISSING_URL)
                })?;
                index += 1;
                continue;
            }
            SurveyStep::Cached(app, listing) => (app, Ok(Some(listing)), true),
            SurveyStep::List(app, alternates) => {
                let listing = wayback::list_app_captures(
                    ctl.fetcher,
                    &app.url,
                    &alternates,
                    Some(APP_STORE_HISTORICAL_FLOOR_MS),
                    io.clock.now(),
                );
                let listed = tokio::select! {
                    biased;
                    _ = ctl.token.cancelled() => None,
                    listed = listing => Some(listed),
                };
                let Some(listed) = listed else {
                    return aborted(io, ctl, state, "This operation was aborted");
                };
                (app, listed, false)
            }
        };
        match listed {
            Err(unavailable) => match throttled(io, ctl, state, index, &app, unavailable).await? {
                // The same app again: `index` stays.
                Throttled::Retry => continue,
                Throttled::Finished(finished) => return Ok(Some(finished)),
            },
            // The index answered with something unusable, and a bulk run
            // never falls back to probing every date.
            Ok(None) => io.section(|cx| {
                survey_failed(cx, state, ctl, index, &app.id, &app.name, INDEX_UNAVAILABLE)
            })?,
            Ok(Some(listing)) => {
                io.section(|cx| surveyed_app(cx, state, ctl, index, &app, &listing, cached))?;
            }
        }
        index += 1;
    }
    io.section(|cx| -> Result<Option<RunResult>, String> {
        order_queue(cx, state)?;
        set(&mut state["survey"], "completedAt", json!(cx.now));
        set(state, "phase", json!("reading"));
        let estimate = refresh_estimate(cx, state);
        persist(cx, state)?;
        emit(
            ctl.writer,
            frame(
                "survey-done",
                json!({ "survey": state["survey"], "estimate": estimate }),
            ),
        );
        finish_if_control_requested(cx, state, ctl)
    })
}

/// One app's listing recorded: on its queue entry, in the cache when it is
/// new, in the survey's totals; an app with no captures is finished here.
fn surveyed_app(
    cx: &mut Cx,
    state: &mut Value,
    ctl: &Ctl<'_>,
    index: usize,
    app: &AppRow,
    listing: &AppListing,
    cached: bool,
) -> Result<(), String> {
    if !cached {
        cache_listing(cx, app, listing)?;
    }
    let captures = &listing.captures;
    let count = captures.len() as i64;
    let first = captures.first().map(|c| c.ms);
    let last = captures.last().map(|c| c.ms);
    let starts_late = history_starts_late(first, None);
    let entry = &mut state["queue"][index];
    set(entry, "captureCount", json!(count));
    set(entry, "firstCaptureMs", json!(first));
    set(entry, "lastCaptureMs", json!(last));
    set(entry, "noArchive", json!(count == 0));
    set(entry, "lookupUrl", json!(listing.lookup_url));
    set(entry, "historyStartsLate", json!(starts_late));
    if count == 0 {
        set(entry, "status", json!("done"));
        set(entry, "finishedAt", json!(cx.now));
        set(entry, "reads", json!(0));
        set(entry, "changes", json!(0));
        set(entry, "labelVersions", json!(0));
        add(&mut state["totals"], "appsDone", 1);
        add(&mut state["totals"], "appsNoArchive", 1);
    }
    let survey = &mut state["survey"];
    add(survey, "appsSurveyed", 1);
    add(
        survey,
        if count > 0 {
            "appsWithCaptures"
        } else {
            "appsWithoutCaptures"
        },
        1,
    );
    add(survey, "capturesTotal", count);
    add(
        survey,
        "estimatedReads",
        estimate_reads(count, first, last, cx.now),
    );
    set(state, "consecutiveThrottles", json!(0));
    persist(cx, state)?;
    emit(
        ctl.writer,
        frame(
            "survey-app",
            json!({
                "appId": app.id,
                "name": app.name,
                "index": index,
                "total": queue_len(state),
                "captureCount": count,
                "firstCaptureMs": first,
                "lastCaptureMs": last,
                "cached": cached,
                "lookupUrl": listing.lookup_url,
                "historyStartsLate": starts_late,
            }),
        ),
    );
    Ok(())
}

/// An app the survey could not list: gone from the library, or an index
/// answer that is not a listing. It finishes as failed, with nothing read.
fn survey_failed(
    cx: &mut Cx,
    state: &mut Value,
    ctl: &Ctl<'_>,
    index: usize,
    app_id: &str,
    app_name: &str,
    message: &str,
) -> Result<(), String> {
    let resumed = str_of(state, "initiator") == "resume";
    let entry = &mut state["queue"][index];
    set(entry, "status", json!("failed"));
    set(entry, "finishedAt", json!(cx.now));
    set(entry, "error", json!(js_slice_prefix(message, 200)));
    add(&mut state["totals"], "failed", 1);
    add(&mut state["totals"], "appsDone", 1);
    add(&mut state["survey"], "appsSurveyed", 1);
    set(state, "consecutiveThrottles", json!(0));
    persist(cx, state)?;
    if message != MISSING_URL {
        record_activity_named(
            cx.w,
            cx.ids,
            cx.now,
            "wayback_import",
            "error",
            Some(app_id),
            Some(app_name),
            Some(&js_slice_prefix(
                &format!("Wayback import failed for {app_name}: {message}"),
                200,
            )),
            Some(&json!({ "mode": "bulk-app", "errorMessage": message, "resumedRun": resumed })),
            cx.now,
        );
    }
    emit(
        ctl.writer,
        frame(
            "survey-app",
            json!({
                "appId": app_id,
                "name": app_name,
                "index": index,
                "total": queue_len(state),
                "captureCount": Value::Null,
                "firstCaptureMs": Value::Null,
                "lastCaptureMs": Value::Null,
                "cached": false,
                "error": message,
            }),
        ),
    );
    Ok(())
}

// ── The reading phase ────────────────────────────────────────────────

enum ReadStep {
    Finished(RunResult),
    Skipped,
    Read(AppRow, Option<AppListing>),
}

/// Every app still to read, in queue order, each retried after a wait.
async fn read_all(
    io: &mut Io<'_>,
    ctl: &Ctl<'_>,
    state: &mut Value,
) -> Result<Option<RunResult>, String> {
    let total = queue_len(state);
    let resumed = str_of(state, "initiator") == "resume";
    let mut i = 0usize;
    while i < total {
        let index = i;
        i += 1;
        if is_finished(&state["queue"][index]) {
            continue;
        }
        // The pre-app control check, the in-flight mark, its persist and
        // the app row: no await between them.
        let step = io.section(|cx| -> Result<ReadStep, String> {
            if let Some(finished) = finish_if_control_requested(cx, state, ctl)? {
                return Ok(ReadStep::Finished(finished));
            }
            let entry = &mut state["queue"][index];
            set(entry, "status", json!("in_progress"));
            set(entry, "startedAt", json!(cx.now));
            set(entry, "finishedAt", undefined());
            set(entry, "error", undefined());
            let app_id = str_of(entry, "appId").to_string();
            let app_name = str_of(entry, "appName").to_string();
            set(state, "currentAppId", json!(app_id));
            add(&mut state["totals"], "appsAttempted", 1);
            persist(cx, state)?;
            emit(
                ctl.writer,
                frame(
                    "app-start",
                    json!({ "appId": app_id, "name": app_name, "index": index, "total": total }),
                ),
            );
            let Some(app) = lookup_app_row(cx, &app_id)?.filter(|a| !a.url.is_empty()) else {
                let entry = &mut state["queue"][index];
                set(entry, "status", json!("failed"));
                set(entry, "finishedAt", json!(cx.now));
                set(entry, "error", json!(MISSING_URL));
                add(&mut state["totals"], "failed", 1);
                add(&mut state["totals"], "appsDone", 1);
                add(&mut state["totals"], "appsRead", 1);
                set(state, "currentAppId", Value::Null);
                set(state, "consecutiveThrottles", json!(0));
                let estimate = refresh_estimate(cx, state);
                persist(cx, state)?;
                emit(
                    ctl.writer,
                    frame(
                        "app-done",
                        json!({ "appId": app_id, "name": app_name, "index": index, "total": total, "error": MISSING_URL }),
                    ),
                );
                emit(ctl.writer, frame("estimate", json!({ "estimate": estimate })));
                return Ok(ReadStep::Skipped);
            };
            let alternates = read_alternate_urls(cx.w.conn, &app.id)?;
            let listing = cached_listing(cx, &app, &alternates);
            Ok(ReadStep::Read(app, listing))
        })?;
        let (app, listing) = match step {
            ReadStep::Finished(finished) => return Ok(Some(finished)),
            ReadStep::Skipped => continue,
            ReadStep::Read(app, listing) => (app, listing),
        };

        // The archive walk, with the lock taken per section inside and the
        // cancellation token watched throughout.
        let walked = {
            let mut sink = |event: Value| emit(ctl.writer, frame("target", event));
            // A listing gone stale since the survey is taken again by the
            // import itself, which lists the same addresses.
            let options_for_app = match listing {
                Some(listing) => HistoryOptions {
                    captures: Some(listing.captures),
                    lookup_url: Some(listing.lookup_url),
                    alternate_urls: listing.alternate_urls,
                    skip_save_now: true,
                    skip_availability_fallback: true,
                    ..HistoryOptions::default()
                },
                None => HistoryOptions {
                    skip_save_now: true,
                    skip_availability_fallback: true,
                    ..HistoryOptions::default()
                },
            };
            let import = import_app_history(
                &mut *io.db,
                ctl.fetcher,
                &app,
                &options_for_app,
                io.clock.now(),
                &mut *io.ids,
                Some(&mut sink),
            );
            tokio::select! {
                biased;
                _ = ctl.token.cancelled() => Walked::Aborted,
                result = import => match result {
                    Ok(result) => Walked::Done(result),
                    Err(error) => match error.unavailable {
                        Some(unavailable) => Walked::Unavailable(unavailable),
                        // `INDEX_UNAVAILABLE` among them: a failed app.
                        None => Walked::Failed(error.message),
                    },
                },
            }
        };

        let app_id = app.id.clone();
        let app_name = app.name.clone();
        let finished = match walked {
            Walked::Aborted => return aborted(io, ctl, state, "This operation was aborted"),
            Walked::Unavailable(unavailable) => {
                match throttled(io, ctl, state, index, &app, unavailable).await? {
                    Throttled::Retry => {
                        // Re-run this app; the pre-app check still fires.
                        i = index;
                        continue;
                    }
                    Throttled::Finished(finished) => return Ok(Some(finished)),
                }
            }
            Walked::Done(result) => io.section(|cx| -> Result<Option<RunResult>, String> {
                accumulate_totals(&mut state["totals"], &result);
                add(&mut state["totals"], "appsDone", 1);
                add(&mut state["totals"], "appsRead", 1);
                let entry = &mut state["queue"][index];
                set(entry, "status", json!("done"));
                set(entry, "finishedAt", json!(cx.now));
                set(entry, "imported", result["imported"].clone());
                set(entry, "unchanged", result["unchanged"].clone());
                set(entry, "skipped", result["skipped"].clone());
                set(entry, "failed", result["failed"].clone());
                set(
                    entry,
                    "snapshotsRequested",
                    json!(int_of(&result, "snapshotsRequested")),
                );
                for key in ["reads", "changes", "labelVersions"] {
                    set(entry, key, json!(int_of(&result, key)));
                }
                for key in ["lookupUrl", "historyStartsLate"] {
                    if let Some(value) = result.get(key) {
                        set(entry, key, value.clone());
                    }
                }
                let started_at = get(entry, "startedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or(cx.now);
                set(state, "currentAppId", Value::Null);
                set(state, "consecutiveThrottles", json!(0));
                let estimate = refresh_estimate(cx, state);
                persist(cx, state)?;
                record_activity_named(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback_import",
                    pick_app_activity_status(&result),
                    Some(&app_id),
                    Some(&app_name),
                    Some(&bulk_app_line(&app_name, &result)),
                    Some(&json!({ "mode": "bulk-app", "result": result, "resumedRun": resumed })),
                    started_at,
                );
                emit(
                    ctl.writer,
                    frame(
                        "app-done",
                        json!({ "appId": app_id, "name": app_name, "index": index, "total": total, "result": result }),
                    ),
                );
                emit(ctl.writer, frame("estimate", json!({ "estimate": estimate })));
                finish_if_control_requested(cx, state, ctl)
            })?,
            Walked::Failed(message) => io.section(|cx| -> Result<Option<RunResult>, String> {
                let entry = &mut state["queue"][index];
                set(entry, "status", json!("failed"));
                set(entry, "finishedAt", json!(cx.now));
                set(entry, "error", json!(js_slice_prefix(&message, 200)));
                let started_at = get(entry, "startedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or(cx.now);
                add(&mut state["totals"], "failed", 1);
                add(&mut state["totals"], "appsDone", 1);
                add(&mut state["totals"], "appsRead", 1);
                set(state, "currentAppId", Value::Null);
                set(state, "consecutiveThrottles", json!(0));
                let estimate = refresh_estimate(cx, state);
                persist(cx, state)?;
                record_activity_named(
                    cx.w,
                    cx.ids,
                    cx.now,
                    "wayback_import",
                    "error",
                    Some(&app_id),
                    Some(&app_name),
                    Some(&js_slice_prefix(
                        &format!("Wayback import failed for {app_name}: {message}"),
                        200,
                    )),
                    Some(&json!({ "mode": "bulk-app", "errorMessage": message, "resumedRun": resumed })),
                    started_at,
                );
                emit(
                    ctl.writer,
                    frame(
                        "app-done",
                        json!({ "appId": app_id, "name": app_name, "index": index, "total": total, "error": message }),
                    ),
                );
                emit(ctl.writer, frame("estimate", json!({ "estimate": estimate })));
                finish_if_control_requested(cx, state, ctl)
            })?,
        };
        if let Some(finished) = finished {
            return Ok(Some(finished));
        }
    }
    Ok(None)
}

/// Clean completion: the summary frame and rows, then the state and mutex
/// cleared.
fn complete(io: &mut Io<'_>, ctl: &Ctl<'_>, state: &mut Value) -> Result<RunResult, String> {
    let queue_len = queue_len(state);
    io.section(|cx| {
        let duration_ms = cx.now - ctl.run_started_at;
        let totals = state["totals"].clone();
        emit(
            ctl.writer,
            frame(
                "summary",
                json!({ "totals": totals, "durationMs": duration_ms }),
            ),
        );
        let initiator = str_of(state, "initiator").to_string();
        let failed_apps = int_of(&summarise(state), "failed");
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "wayback_import",
            if int_of(&totals, "failed") > 0 {
                "partial"
            } else {
                "ok"
            },
            None,
            Some(&build_bulk_summary(
                &totals,
                &initiator,
                queue_len,
                failed_apps,
            )),
            Some(&json!({
                "mode": if initiator == "resume" { "bulk-resumed" } else { "bulk" },
                "totals": totals,
                "runId": state["runId"],
            })),
            int_of(state, "startedAt"),
        );
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            if initiator == "resume" {
                "wayback.import.bulk.resumed.success"
            } else {
                "wayback.import.bulk.success"
            },
            &audit_actor(ctl.options),
            Some(&format!(
                "apps={queue_len} imported={} unchanged={} skipped={} failed={}",
                int_of(&totals, "imported"),
                int_of(&totals, "unchanged"),
                int_of(&totals, "skipped"),
                int_of(&totals, "failed")
            )),
            true,
        );
        clear_bulk_state(cx)?;
        release_mutex(cx)?;
        Ok(RunResult {
            totals,
            duration_ms,
        })
    })
}

/// `syncControlStatusFromDisk`: a pause or cancel the PATCH wrote for
/// this run is copied onto the in-memory state.
fn sync_control_status_from_disk(cx: &Cx, state: &mut Value) {
    let Some(persisted) = read_bulk_state(cx) else {
        return;
    };
    if persisted["runId"] != state["runId"] {
        return;
    }
    let status = str_of(&persisted, "status");
    if status == "pause_requested" || status == "cancel_requested" {
        set(state, "status", json!(status));
        set(
            state,
            "pauseRequestedAt",
            get(&persisted, "pauseRequestedAt")
                .cloned()
                .unwrap_or_else(undefined),
        );
        set(
            state,
            "cancelRequestedAt",
            get(&persisted, "cancelRequestedAt")
                .cloned()
                .unwrap_or_else(undefined),
        );
    }
}

/// `finishIfControlRequested`: the pause or the cancel at an app boundary
/// or during a wait.
fn finish_if_control_requested(
    cx: &mut Cx,
    state: &mut Value,
    ctl: &Ctl<'_>,
) -> Result<Option<RunResult>, String> {
    sync_control_status_from_disk(cx, state);
    match str_of(state, "status") {
        "pause_requested" => pause_run(cx, state, ctl, "user", None).map(Some),
        "cancel_requested" => {
            let duration_ms = cx.now - ctl.run_started_at;
            let summary = summarise(state);
            let remaining = int_of(&summary, "remaining");
            let total = int_of(&summary, "total");
            let message = format!(
                "Wayback import cancelled — {remaining} of {total} app{} not processed",
                if total == 1 { "" } else { "s" }
            );
            let totals = state["totals"].clone();
            emit(
                ctl.writer,
                frame(
                    "cancelled",
                    json!({ "totals": totals, "durationMs": duration_ms, "summary": summary }),
                ),
            );
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "wayback_import",
                "cancelled",
                None,
                Some(&message),
                Some(&json!({
                    "mode": "bulk",
                    "cancelled": true,
                    "totals": totals,
                    "runId": state["runId"],
                    "remaining": remaining,
                    "total": total,
                })),
                int_of(state, "startedAt"),
            );
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "wayback.import.bulk.cancelled",
                &audit_actor(ctl.options),
                Some(&format!("remaining={remaining} total={total}")),
                true,
            );
            clear_bulk_state(cx)?;
            release_mutex(cx)?;
            Ok(Some(RunResult {
                totals,
                duration_ms,
            }))
        }
        _ => Ok(None),
    }
}

/// `pauseRun`: the queue parked at an app boundary or a wait, by the user
/// or by an archive that kept refusing us. A paused queue is not waiting.
fn pause_run(
    cx: &mut Cx,
    state: &mut Value,
    ctl: &Ctl<'_>,
    cause: &str,
    message: Option<&str>,
) -> Result<RunResult, String> {
    let duration_ms = cx.now - ctl.run_started_at;
    set(state, "status", json!("paused"));
    set(state, "pausedAt", json!(cx.now));
    set(state, "pauseCause", json!(cause));
    set(state, "currentAppId", Value::Null);
    set(state, "waitingUntil", undefined());
    set(state, "waitReason", undefined());
    write_bulk_state(cx, state)?;
    release_mutex(cx)?;
    let summary = summarise(state);
    let remaining = int_of(&summary, "remaining");
    let total = int_of(&summary, "total");
    let apps = format!(
        "{remaining} of {total} app{}",
        if total == 1 { "" } else { "s" }
    );
    let text = if cause == "rate_limited" {
        format!("Wayback import paused — archive.org is rate-limiting requests; {apps} remaining. Resume from Settings once it clears.")
    } else {
        format!("Wayback import paused — {apps} remaining")
    };
    let totals = state["totals"].clone();
    emit(
        ctl.writer,
        frame(
            "paused",
            json!({ "cause": cause, "totals": totals, "durationMs": duration_ms, "summary": summary }),
        ),
    );
    let mut detail = Map::new();
    detail.insert("mode".into(), json!("bulk-paused"));
    detail.insert("cause".into(), json!(cause));
    if let Some(message) = message {
        detail.insert("errorMessage".into(), json!(message));
    }
    detail.insert("totals".into(), totals.clone());
    detail.insert("runId".into(), state["runId"].clone());
    record_activity(
        cx.w,
        cx.ids,
        cx.now,
        "wayback_import",
        "cancelled",
        None,
        Some(&js_slice_prefix(&text, 200)),
        Some(&Value::Object(detail)),
        int_of(state, "startedAt"),
    );
    record_audit(
        cx.w,
        cx.ids,
        cx.now,
        "wayback.import.bulk.paused",
        &audit_actor(ctl.options),
        Some(&format!(
            "cause={cause} remaining={remaining} total={total}"
        )),
        true,
    );
    Ok(RunResult {
        totals,
        duration_ms,
    })
}

// ── lib/notifications.ts: createWaybackResumeNotification ────────────

fn resume_enabled(cx: &Cx) -> bool {
    context_from_db(cx.w.conn)
        .ok()
        .and_then(|ctx| resolve_flag("flag.notifications.resume.enabled", &ctx).ok())
        .map_or(true, |v| v == "on")
}

fn wayback_resume_notification(
    cx: &mut Cx,
    apps_remaining: i64,
    total_apps: i64,
    stale_healed: bool,
) -> Result<(), String> {
    if !resume_enabled(cx) {
        return Ok(());
    }
    let apps_remaining = apps_remaining.max(0);
    let total_apps = total_apps.max(0);
    let description = if stale_healed {
        "A previous Wayback import lock was stuck after a server restart and has been cleared. You can start a new import now.".to_string()
    } else {
        format!(
            "Wayback import resumed — {apps_remaining} of {total_apps} app{} still to process. Running in the background.",
            if total_apps == 1 { "" } else { "s" }
        )
    };
    let id = cx.ids.uuid(cx.w.conn)?;
    let payload = json!([{
        "type": if stale_healed { "wayback_stale_cleared" } else { "wayback_resumed" },
        "description": description,
        "appsRemaining": apps_remaining,
        "totalApps": total_apps,
    }]);
    cx.w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!(WAYBACK_RESUME_NOTIFICATION_APP_ID),
            json!("Wayback import"),
            json!(payload.to_string()),
            json!(cx.now),
        ],
    )?;
    notify::prune_notifications(cx.w);
    Ok(())
}

// ── instrumentation.ts: resumeWaybackImport ──────────────────────────

/// The boot check: a paused queue is left for the user, a cancelled or
/// finished one is cleared, a stale lock healed, pending work resumed —
/// here to completion, on the server inside its own task. A queue the
/// process died in the middle of surveying resumes its survey, and one
/// it died waiting in waits out what is left of the wait first.
pub(crate) async fn resume_wayback_import(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
) -> Result<(), String> {
    let now = clock.now();
    let resume = db.with(|w| -> Result<Option<Value>, String> {
        if live_runs::is_live(w.conn, Job::Wayback) {
            return Ok(None);
        }
        let cx = &mut Cx { w, ids, now };
        let state = read_bulk_state(cx);
        let held = mutex_held(cx);
        if state.is_none() && !held {
            return Ok(None);
        }
        if is_paused(state.as_ref()) {
            if held {
                release_mutex(cx)?;
            }
            if let Some(state) = &state {
                if str_of(state, "status") == "pause_requested" {
                    let mut next = state.clone();
                    set(&mut next, "status", json!("paused"));
                    set(
                        &mut next,
                        "pausedAt",
                        get(state, "pausedAt").cloned().unwrap_or(json!(cx.now)),
                    );
                    set(&mut next, "currentAppId", Value::Null);
                    set(&mut next, "waitingUntil", undefined());
                    set(&mut next, "waitReason", undefined());
                    write_bulk_state(cx, &next)?;
                }
            }
            return Ok(None);
        }
        if is_cancel_requested(state.as_ref()) {
            if held {
                release_mutex(cx)?;
            }
            if state.is_some() {
                clear_bulk_state(cx)?;
            }
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "wayback_import",
                "cancelled",
                None,
                Some("Cleared cancelled Wayback import queue from a previous server run"),
                Some(&json!({ "mode": "bulk-cancelled-stale" })),
                cx.now,
            );
            return Ok(None);
        }
        if !has_pending_work(state.as_ref()) {
            if held {
                release_mutex(cx)?;
            }
            if state.is_some() {
                clear_bulk_state(cx)?;
            }
            if let Err(e) = wayback_resume_notification(cx, 0, 0, true) {
                super::diag::log_warn(format!(
                    "[WaybackResume] Failed to raise stale-heal notification: {e}"
                ));
            }
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "wayback_import",
                "ok",
                None,
                Some("Cleared stuck Wayback import lock from a previous server run"),
                Some(&json!({ "mode": "bulk-stale-healed" })),
                cx.now,
            );
            return Ok(None);
        }
        let state = state.expect("pending work needs a blob");
        let summary = summarise(&state);
        let remaining = int_of(&summary, "remaining");
        let total = int_of(&summary, "total");
        if let Err(e) = wayback_resume_notification(cx, remaining, total, false) {
            super::diag::log_warn(format!(
                "[WaybackResume] Failed to raise resume notification: {e}"
            ));
        }
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "wayback_import",
            "ok",
            None,
            Some(&format!(
                "Wayback import resumed after server restart — {remaining} of {total} app{} left",
                if total == 1 { "" } else { "s" }
            )),
            Some(&json!({
                "mode": "bulk-resume-start",
                "runId": state["runId"],
                "remaining": remaining,
                "total": total,
            })),
            cx.now,
        );
        Ok(Some(state))
    })?;
    if let Some(state) = resume {
        let stream_requested = get(&state, "streamRequested")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = RunOptions {
            initiator: "resume",
            resume_state: Some(state),
            stream_requested,
            writer: None,
            actor_ip: None,
            user_agent: None,
        };
        if let Err(e) = run_bulk_wayback_import(db, fetcher, ids, clock, options).await {
            super::diag::log_error(format!("[WaybackResume] Resumed run failed: {e}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undefined_keys_are_omitted_but_keep_their_place() {
        let mut state = json!({ "runId": "r", "status": "running" });
        set(&mut state, "pausedAt", undefined());
        set(&mut state, "pauseCause", undefined());
        set(&mut state, "extra", json!(1));
        assert_eq!(
            stringify(&state),
            r#"{"runId":"r","status":"running","extra":1}"#
        );
        // A later assignment lands where the undefined key was created.
        set(&mut state, "pauseCause", json!("user"));
        assert_eq!(
            stringify(&state),
            r#"{"runId":"r","status":"running","pauseCause":"user","extra":1}"#
        );
    }

    #[test]
    fn a_wait_is_retry_after_or_five_minutes_and_never_capped() {
        assert_eq!(wait_ms_for(None), 300_000);
        assert_eq!(wait_ms_for(Some(0)), 1_000);
        assert_eq!(wait_ms_for(Some(1)), 1_000);
        assert_eq!(wait_ms_for(Some(5_000)), 5_000);
        assert_eq!(wait_ms_for(Some(600_000)), 600_000);
        // The 900 s cap is gone: an hour's cooldown is an hour's wait.
        assert_eq!(wait_ms_for(Some(3_600_000)), 3_600_000);
    }

    #[test]
    fn the_activity_rows_speak_in_apps_and_changes() {
        let result = json!({ "reads": 12, "changes": 3, "labelVersions": 4 });
        assert_eq!(
            bulk_app_line("Instagram", &result),
            "Instagram: 3 label changes found, 12 pages read"
        );
        assert_eq!(
            bulk_app_line("Solo", &json!({ "reads": 1, "changes": 1 })),
            "Solo: 1 label change found, 1 page read"
        );
        // An import that predates the counts reads as nothing found.
        assert_eq!(
            bulk_app_line("Old", &json!({ "imported": 2 })),
            "Old: no label changes found, 0 pages read"
        );
        let totals = json!({ "appsDone": 201, "changes": 37, "appsNoArchive": 58 });
        assert_eq!(
            build_bulk_summary(&totals, "manual", 201, 0),
            "Wayback import: 201 of 201 apps checked, 37 label changes found, 58 apps have no archived pages"
        );
        let totals = json!({ "appsDone": 1, "changes": 0, "appsNoArchive": 1 });
        assert_eq!(
            build_bulk_summary(&totals, "resume", 1, 0),
            "Wayback import (resumed): 1 of 1 app checked, no label changes found, 1 app has no archived pages"
        );
        let totals = json!({ "appsDone": 3, "changes": 1 });
        assert_eq!(
            build_bulk_summary(&totals, "manual", 3, 2),
            "Wayback import: 3 of 3 apps checked, 1 label change found, 2 failed"
        );
        assert_eq!(human_duration(300_000), "5 min");
        assert_eq!(human_duration(90_500), "2 min");
        assert_eq!(human_duration(1_000), "1s");
    }
}

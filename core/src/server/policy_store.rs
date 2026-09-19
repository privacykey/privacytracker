//! Phase 5, batch 2: the policy store. `syncPrivacyPolicyAnalysis` with
//! `phase: "fetch"` from `lib/privacy-policy.ts` — the run marker, the run
//! log persisted as it grows (`PolicyRunLogger`), and
//! `fetchAndStorePolicySource`: the kill-switch, the throttle, the fetch
//! (`crate::policy::source`), the failure branches, the first/same/changed
//! classification, the version backfill and upsert
//! (`lib/policy-versions.ts`), the archive lookup, the History row
//! (`appendPolicyChangeEntry`) and the notification, the cache hit and the
//! source-ready write — then the activity row.
//!
//! **What Node fires and forgets starts where Node starts it.** Save Page
//! Now and the immediate webhook are `void`ed in Node: the request goes out
//! at once, and what it writes lands after the sync has returned. On the
//! server each is a task of its own, spawned at that point. In the replay,
//! whose canned hop answers at once, the request is made there too — so a
//! summary's AI call that follows it (batch 3a's `all` phase) comes after
//! it, as in Node — and only the capture's link is handed back as
//! [`FollowUps`], written after the sync, where the oracle's held reply
//! writes it, as production's 10 to 30 second archive always does.
//!
//! **Hydration reads the row it was handed.** Node returns
//! `hydratePolicyAnalysis(row)` with the row read when it was written, so
//! a log event written after it (the History write's) is on the stored row
//! but not in the returned analysis, and the kill-switch and the throttle
//! return the row as it was before their own log line. The analysis also
//! says the run is still `running`: the marker is cleared in a `finally`
//! after the value is built. All three are Node's and kept.
//!
//! Until batch 3 routes `POST /api/policy/regenerate` and batch 4 the bulk
//! runner, the replay is the only caller.
#![cfg_attr(not(test), allow(dead_code))]

use super::{
    activity_log::record_activity_named,
    flags,
    maintenance_writes::INSERT_NOTIFICATION,
    policy::hydrate_policy_analysis,
    row::row_to_json,
    settings::get_setting_with,
    sync_runner::Clock,
    webhook_writes::{self, Immediate},
};
use crate::{
    jsjson,
    jsnum::{js_number, js_number_spelling, js_parse_int, js_to_number},
    jsstr::js_slice_prefix,
    outbound::Fetcher,
    policy::{
        diag::{classify_network_error, SourceError},
        locale_int,
        source::{fetch_privacy_policy_source, PolicyLog, Source, SourceStatus},
        url::safe_url_label,
    },
    scrape::{
        js::truthy,
        notify,
        persist::{DbAccess, Ids, Writer},
        wayback::{self, SaveResult},
    },
};
use futures_util::FutureExt;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

const DELETE_ANALYSIS: &str = "DELETE FROM privacy_policy_analyses WHERE app_id = ?";
const DELETE_PLACEHOLDER: &str =
    "DELETE FROM privacy_policy_analyses WHERE app_id = ? AND status = 'pending'";
const MARK_RUNNING: &str = "UPDATE privacy_policy_analyses\n          SET run_status = 'running', run_started_at = ?\n        WHERE app_id = ?";
const INSERT_PLACEHOLDER: &str = "\n    INSERT INTO privacy_policy_analyses (\n      app_id, policy_url, status, source_word_count, updated_at,\n      run_status, run_started_at\n    )\n    VALUES (?, '', 'pending', 0, ?, 'running', ?)\n    ON CONFLICT(app_id) DO UPDATE SET\n      run_status = 'running',\n      run_started_at = excluded.run_started_at\n  ";
const MARK_IDLE: &str =
    "UPDATE privacy_policy_analyses\n        SET run_status = 'idle'\n      WHERE app_id = ?";
const PERSIST_LOG: &str =
    "UPDATE privacy_policy_analyses\n        SET last_run_log = ?\n      WHERE app_id = ?";
const PERSIST_ANALYSIS: &str = "\n    INSERT INTO privacy_policy_analyses (\n      app_id,\n      policy_url,\n      status,\n      source_title,\n      source_content_type,\n      source_text,\n      source_word_count,\n      source_origin,\n      source_final_url,\n      content_hash,\n      analysis_mode,\n      summary_json,\n      previous_summary_json,\n      previous_summary_at,\n      model,\n      error,\n      updated_at,\n      last_run_log,\n      source_fetched_at\n    )\n    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n    ON CONFLICT(app_id) DO UPDATE SET\n      policy_url = excluded.policy_url,\n      status = excluded.status,\n      source_title = excluded.source_title,\n      source_content_type = excluded.source_content_type,\n      source_text = excluded.source_text,\n      source_word_count = excluded.source_word_count,\n      source_origin = excluded.source_origin,\n      source_final_url = excluded.source_final_url,\n      content_hash = excluded.content_hash,\n      analysis_mode = excluded.analysis_mode,\n      summary_json = excluded.summary_json,\n      previous_summary_json = excluded.previous_summary_json,\n      previous_summary_at = excluded.previous_summary_at,\n      model = excluded.model,\n      error = excluded.error,\n      updated_at = excluded.updated_at,\n      last_run_log = excluded.last_run_log,\n      source_fetched_at = excluded.source_fetched_at\n  ";
const TOUCH_VERSION: &str = "UPDATE privacy_policy_versions SET last_fetched_at = ? WHERE id = ?";
const INSERT_VERSION: &str = "INSERT INTO privacy_policy_versions (\n       id, app_id, content_hash, first_fetched_at, last_fetched_at,\n       policy_url, source_final_url, source_title, source_content_type,\n       source_origin, source_word_count, source_text\n     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const SET_ARCHIVE_URL: &str =
    "UPDATE privacy_policy_versions SET archive_url = ?, archive_submitted_at = ? WHERE id = ?";
const INSERT_SNAPSHOT: &str = "\n    INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary)\n    VALUES (?, ?, ?, ?, ?, ?)\n  ";
const POLICY_UPDATES_FLAG: &str = "flag.notifications.types.policy_updates";
const SOURCE_ORIGINS: [&str; 3] = ["direct", "browser_retry", "wayback"];

/// `PolicyAnalysisRequest`.
pub(crate) struct PolicyRequest {
    pub app_id: String,
    pub app_name: String,
    /// Named in the prompts; "Unknown developer" when absent or empty.
    pub developer: Option<String>,
    pub policy_url: Option<String>,
}

/// `PolicyPhase`: fetch the source, summarise the stored one, or both.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum Phase {
    Fetch,
    Summarise,
    /// `options.phase ?? "all"`.
    #[default]
    All,
}

impl Phase {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Fetch => "fetch",
            Self::Summarise => "summarise",
            Self::All => "all",
        }
    }
}

/// `PolicySyncOptions`.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SyncOptions {
    pub phase: Phase,
    pub force_resummarise: bool,
    pub bypass_throttle: bool,
}

/// Save Page Now for the version the sync stored.
pub(crate) enum SaveNow {
    /// Answered where Node fired it (the replay's canned hop answers at
    /// once); only the link is left, written after the sync, where Node's
    /// held reply writes it.
    Landed(SaveResult),
    /// Not started: it could be neither spawned nor answered at once.
    Later(String),
}

/// What the sync fired and forgot and has yet to finish: Save Page Now for
/// the version it stored, and the immediate webhook for the notification
/// it raised, when that could not be posted when fired. On the server both
/// start as tasks of their own where Node starts them, and nothing is left.
#[derive(Default)]
pub(crate) struct FollowUps {
    pub save_now: Option<(String, SaveNow)>,
    pub immediate: Option<(i64, Immediate)>,
}

/// `void submitToWaybackSaveNow(...)`: started where Node starts it, the
/// capture linked to the version when it lands.
fn fire_save_now(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    follow_ups: &mut FollowUps,
    version_id: String,
    target: String,
) {
    if let (Some(fetcher), Some(mut db)) = (fetcher.shared(), db.detach()) {
        tokio::spawn(async move {
            let result = wayback::save_now(fetcher.as_ref(), &target).await;
            link_capture(db.as_mut(), &super::sync_runner::Live, &version_id, result);
        });
        return;
    }
    let state = match wayback::save_now(fetcher, &target).now_or_never() {
        Some(result) => SaveNow::Landed(result),
        None => SaveNow::Later(target),
    };
    follow_ups.save_now = Some((version_id, state));
}

/// The capture Save Page Now reported, stamped on its version.
fn link_capture(db: &mut dyn DbAccess, clock: &dyn Clock, version_id: &str, result: SaveResult) {
    if let SaveResult::Saved(snapshot) = result {
        if !snapshot.url.is_empty() {
            let now = clock.now();
            let _ = db.with(|w| {
                w.run(
                    SET_ARCHIVE_URL,
                    vec![json!(snapshot.url), json!(now), json!(version_id)],
                )
            });
        }
    }
}

/// `fireWebhookIfConfigured`, as `createNotification` starts it: posted
/// where Node posts it — detached on the server, at once in the replay —
/// or after the sync when it can be neither.
fn fire_webhook(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    now: i64,
    immediate: Immediate,
    follow_ups: &mut FollowUps,
) {
    let posted = webhook_writes::fire_immediate(db, fetcher, now, immediate.clone()).now_or_never();
    if posted.is_none() {
        follow_ups.immediate = Some((now, immediate));
    }
}

pub(crate) struct Synced {
    /// The hydrated analysis, or null when the policy URL was cleared or
    /// the kill-switch stopped a first fetch.
    pub analysis: Value,
    pub follow_ups: FollowUps,
}

// ── The run logger ───────────────────────────────────────────────────

/// `PolicyRunLogger` with `syncPrivacyPolicyAnalysis`'s persist callback:
/// every phase record stamped with the time, the whole list written to
/// `last_run_log` after each change. The store reaches the database
/// through it, since it holds the accessor for the length of the run.
pub(crate) struct RunLogger<'a> {
    db: &'a mut dyn DbAccess,
    clock: &'a dyn Clock,
    app_id: String,
    /// Whether each change is written to the row; `new PolicyRunLogger()`
    /// with no callback, as the sample summary makes one, writes nothing.
    persist: bool,
    phases: Vec<Map<String, Value>>,
    current: Option<usize>,
}

impl<'a> RunLogger<'a> {
    pub(super) fn new(db: &'a mut dyn DbAccess, clock: &'a dyn Clock, app_id: &str) -> Self {
        Self {
            db,
            clock,
            app_id: app_id.to_string(),
            persist: true,
            phases: Vec::new(),
            current: None,
        }
    }
    /// A logger that keeps its phases in memory only. The calls it logs
    /// still reach the database for their settings, debug rows and
    /// notifications.
    pub(super) fn detached(db: &'a mut dyn DbAccess, clock: &'a dyn Clock) -> Self {
        Self {
            persist: false,
            ..Self::new(db, clock, "")
        }
    }
    pub(super) fn db(&mut self) -> &mut dyn DbAccess {
        &mut *self.db
    }
    pub(super) fn now(&self) -> i64 {
        self.clock.now()
    }
    /// `logger.phases`, as the sample summary returns them.
    pub(super) fn phases(&self) -> Vec<Value> {
        self.phases.iter().cloned().map(Value::Object).collect()
    }
    /// `startPhase`: a phase left open is closed as `incomplete` first.
    pub(super) fn start_phase(&mut self, phase: &str, note: Option<String>) {
        if let Some(i) = self.current.take() {
            let now = self.now();
            let stale = &mut self.phases[i];
            let at = stale.get("at").and_then(Value::as_i64).unwrap_or(now);
            stale.insert("ms".into(), json!(now - at));
            if !stale.get("note").is_some_and(truthy) {
                stale.insert("note".into(), json!("incomplete"));
            }
        }
        let mut record = Map::new();
        record.insert("phase".into(), json!(phase));
        record.insert("at".into(), json!(self.now()));
        if let Some(note) = note.filter(|n| !n.is_empty()) {
            record.insert("note".into(), json!(note));
        }
        self.current = Some(self.phases.len());
        self.phases.push(record);
        self.flush();
    }
    /// `endPhase`: the open phase gains its duration, and a note or an
    /// error; nothing when no phase is open.
    pub(super) fn end_phase(&mut self, note: Option<String>, error: Option<String>) {
        let Some(i) = self.current.take() else {
            return;
        };
        let now = self.now();
        let record = &mut self.phases[i];
        let at = record.get("at").and_then(Value::as_i64).unwrap_or(now);
        record.insert("ms".into(), json!(now - at));
        if let Some(note) = note.filter(|n| !n.is_empty()) {
            record.insert("note".into(), json!(note));
        }
        if let Some(error) = error.filter(|e| !e.is_empty()) {
            record.insert("error".into(), json!(error));
        }
        self.flush();
    }
    /// `toJson`.
    pub(super) fn to_json(&self) -> String {
        Value::Array(self.phases.iter().cloned().map(Value::Object).collect()).to_string()
    }
    /// `phases.some((entry) => entry.phase === phase)`.
    fn logged(&self, phase: &str) -> bool {
        self.phases
            .iter()
            .any(|record| record.get("phase").and_then(Value::as_str) == Some(phase))
    }
    /// `persistPolicyRunLog`, swallowed and logged as Node's `flush` does.
    fn flush(&mut self) {
        if !self.persist {
            return;
        }
        let log = self.to_json();
        let app_id = self.app_id.clone();
        if let Err(e) = self
            .db
            .with(|w| w.run(PERSIST_LOG, vec![json!(log), json!(app_id)]))
        {
            super::diag::log_warn(format!("[privacy-policy] failed to persist run log: {e}"));
        }
    }
}

impl PolicyLog for RunLogger<'_> {
    fn event(&mut self, phase: &str, note: Option<String>, error: Option<String>) {
        let mut record = Map::new();
        record.insert("phase".into(), json!(phase));
        record.insert("at".into(), json!(self.now()));
        if let Some(note) = note.filter(|n| !n.is_empty()) {
            record.insert("note".into(), json!(note));
        }
        if let Some(error) = error.filter(|e| !e.is_empty()) {
            record.insert("error".into(), json!(error));
        }
        self.phases.push(record);
        self.flush();
    }
}

impl RunLogger<'_> {
    pub(super) fn note(&mut self, phase: &str, note: impl Into<String>) {
        self.event(phase, Some(note.into()), None);
    }
    pub(super) fn fail(&mut self, phase: &str, error: impl Into<String>) {
        self.event(phase, None, Some(error.into()));
    }
}

// ── Rows ─────────────────────────────────────────────────────────────

/// `getPolicyAnalysisRow`.
pub(super) fn read_row(conn: &Connection, app_id: &str) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT * FROM privacy_policy_analyses WHERE app_id = ?",
        [app_id],
        row_to_json,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// `existing?.col ?? null`.
pub(super) fn col(existing: Option<&Value>, name: &str) -> Value {
    existing
        .and_then(|row| row.get(name))
        .cloned()
        .unwrap_or(Value::Null)
}

/// `normalizeSourceOrigin`.
pub(super) fn source_origin(value: &Value) -> Value {
    value
        .as_str()
        .filter(|s| SOURCE_ORIGINS.contains(s))
        .map_or(Value::Null, |s| json!(s))
}

/// `normalizeAnalysisMode`.
fn analysis_mode(value: &Value) -> Value {
    match value.as_str() {
        Some(mode @ ("direct" | "chunked")) => json!(mode),
        _ => Value::Null,
    }
}

/// `persistPolicyAnalysis`'s input, each column already the value bound.
pub(super) struct Persist {
    pub(super) status: Value,
    pub(super) source_title: Value,
    pub(super) source_content_type: Value,
    pub(super) source_text: Value,
    pub(super) source_word_count: Value,
    pub(super) source_origin: Value,
    pub(super) source_final_url: Value,
    pub(super) content_hash: Value,
    pub(super) analysis_mode: Value,
    pub(super) summary_json: Value,
    pub(super) previous_summary_json: Value,
    pub(super) previous_summary_at: Value,
    pub(super) model: Value,
    pub(super) error: Value,
    pub(super) source_fetched_at: Value,
}

impl Persist {
    /// The stored source, summary and model carried over as they are:
    /// what the kill-switch, the throttle and both failure branches write.
    fn keep(existing: Option<&Value>, status: Value, error: Value, fetched_at: Value) -> Self {
        let word_count = col(existing, "source_word_count");
        Self {
            status,
            source_title: col(existing, "source_title"),
            source_content_type: col(existing, "source_content_type"),
            source_text: col(existing, "source_text"),
            source_word_count: if word_count.is_null() {
                json!(0)
            } else {
                word_count
            },
            source_origin: source_origin(&col(existing, "source_origin")),
            source_final_url: col(existing, "source_final_url"),
            content_hash: col(existing, "content_hash"),
            analysis_mode: analysis_mode(&col(existing, "analysis_mode")),
            summary_json: col(existing, "summary_json"),
            previous_summary_json: col(existing, "previous_summary_json"),
            previous_summary_at: col(existing, "previous_summary_at"),
            model: col(existing, "model"),
            error,
            source_fetched_at: fetched_at,
        }
    }
}

/// `persistPolicyAnalysis`: the upsert, then the row as it now reads.
pub(super) fn persist(
    w: &mut Writer,
    app_id: &str,
    policy_url: &str,
    p: Persist,
    updated_at: i64,
    log: String,
) -> Result<Value, String> {
    w.run(
        PERSIST_ANALYSIS,
        vec![
            json!(app_id),
            json!(policy_url),
            p.status,
            p.source_title,
            p.source_content_type,
            p.source_text,
            p.source_word_count,
            p.source_origin,
            p.source_final_url,
            p.content_hash,
            p.analysis_mode,
            p.summary_json,
            p.previous_summary_json,
            p.previous_summary_at,
            p.model,
            p.error,
            json!(updated_at),
            json!(log),
            p.source_fetched_at,
        ],
    )?;
    read_row(w.conn, app_id)?.ok_or_else(|| "Failed to persist privacy policy analysis".to_string())
}

pub(super) fn hydrate(conn: &Connection, app_id: &str, row: &Value) -> Result<Value, String> {
    hydrate_policy_analysis(conn, app_id, row).map_err(|e| e.to_string())
}

/// `markPolicyRunStart`: the marker on the existing row, or a placeholder
/// row when there is none. Refused by the foreign key for an app the
/// library does not track.
fn mark_policy_run_start(w: &mut Writer, app_id: &str, now: i64) -> Result<(), String> {
    if read_row(w.conn, app_id)?.is_some() {
        w.run(MARK_RUNNING, vec![json!(now), json!(app_id)])?;
    } else {
        w.run(
            INSERT_PLACEHOLDER,
            vec![json!(app_id), json!(now), json!(now)],
        )?;
    }
    Ok(())
}

// ── Versions ─────────────────────────────────────────────────────────

/// `hasAnyPolicyVersion`.
fn has_any_policy_version(conn: &Connection, app_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 AS present FROM privacy_policy_versions WHERE app_id = ? LIMIT 1",
        [app_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// `upsertPolicyVersion`: the existing row for this text touched, or a new
/// one; either way its id.
fn upsert_policy_version(
    w: &mut Writer,
    ids: &mut dyn Ids,
    app_id: &str,
    content_hash: &str,
    fetched_at: Value,
    columns: [Value; 6],
    source_text: &str,
) -> Result<String, String> {
    let existing: Option<String> = w
        .conn
        .query_row(
            "SELECT id FROM privacy_policy_versions WHERE app_id = ? AND content_hash = ?",
            [app_id, content_hash],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing.filter(|id| !id.is_empty()) {
        w.run(TOUCH_VERSION, vec![fetched_at, json!(id)])?;
        return Ok(id);
    }
    let id = ids.uuid(w.conn)?;
    let [policy_url, final_url, title, content_type, origin, word_count] = columns;
    w.run(
        INSERT_VERSION,
        vec![
            json!(id),
            json!(app_id),
            json!(content_hash),
            fetched_at.clone(),
            fetched_at,
            policy_url,
            final_url,
            title,
            content_type,
            origin,
            word_count,
            json!(source_text),
        ],
    )?;
    Ok(id)
}

// ── History and the bell ─────────────────────────────────────────────

/// `JSON.stringify(getLatestSnapshot(appId) ?? [])`, failing in V8's words
/// when the stored snapshot is not JSON.
fn latest_snapshot_json(conn: &Connection, app_id: &str) -> Result<String, String> {
    let stored: Option<String> = conn
        .query_row(
            "\n    SELECT snapshot_json FROM privacy_snapshots\n    WHERE app_id = ?\n    ORDER BY scraped_at DESC\n    LIMIT 1\n  ",
            [app_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(stored) = stored else {
        return Ok("[]".to_string());
    };
    match jsjson::parse(&stored)? {
        Value::Null => Ok("[]".to_string()),
        value => Ok(value.to_string()),
    }
}

/// `appendPolicyChangeEntry`: every event is a History row; only a text
/// change, and only with the toggle on, is flagged. Whether it was.
fn append_policy_change_entry(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    app_id: &str,
    entry: &Value,
    surface_changes: bool,
) -> Result<bool, String> {
    let latest = latest_snapshot_json(w.conn, app_id)?;
    let id = ids.uuid(w.conn)?;
    let flagged = entry["policy_event"] == "changed" && surface_changes;
    w.run(
        INSERT_SNAPSHOT,
        vec![
            json!(id),
            json!(app_id),
            json!(now),
            json!(latest),
            json!(i64::from(flagged)),
            json!(Value::Array(vec![entry.clone()]).to_string()),
        ],
    )?;
    Ok(flagged)
}

/// `policyUpdateNotificationsEnabled`: the toggle, or its hard default
/// when the resolver cannot answer.
fn policy_update_notifications_enabled(conn: &Connection) -> bool {
    match flags::context_from_db(conn)
        .ok()
        .and_then(|ctx| flags::resolve_flag(POLICY_UPDATES_FLAG, &ctx).ok())
    {
        Some(value) => value == "on",
        None => flags::rules().hard_default(POLICY_UPDATES_FLAG) == "on",
    }
}

/// `createNotification(appId, appName, [entry])`: the row with its
/// quiet-hours deferral and the retention prune; the webhook fan-out is
/// handed back.
fn create_notification(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    app_id: &str,
    app_name: &str,
    entry: &Value,
) -> Result<Immediate, String> {
    let not_before = notify::compute_not_before(w.conn, now);
    let id = ids.uuid(w.conn)?;
    w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!(app_id),
            json!(app_name),
            json!(Value::Array(vec![entry.clone()]).to_string()),
            json!(now),
            not_before.map_or(Value::Null, |n| json!(n)),
        ],
    )?;
    notify::prune_notifications(w);
    let headline = entry["description"]
        .as_str()
        .filter(|d| !d.is_empty())
        .map_or_else(|| "1 change".to_string(), str::to_string);
    Ok(Immediate {
        app_name: app_name.to_string(),
        headline,
    })
}

/// One `appendPolicyChangeEntry` of an error event, its outcome logged as
/// the `changelog` phase.
fn record_error_entry(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    app_id: &str,
    entry: &Value,
    note: String,
) {
    let now = log.now();
    match log
        .db()
        .with(|w| append_policy_change_entry(w, ids, now, app_id, entry, false))
    {
        Ok(_) => log.note("changelog", note),
        Err(e) => log.fail("changelog", e),
    }
}

// ── The store ────────────────────────────────────────────────────────

/// `stashFetchDiagnostics`' argument for a failed fetch.
fn diagnostics_for(err: &SourceError, policy_url: &str) -> Value {
    if let Some(Value::Object(d)) = &err.diagnostics {
        let mut d = d.clone();
        if d.get("requestedUrl").map_or(true, Value::is_null) {
            d.insert("requestedUrl".into(), json!(policy_url));
        }
        return Value::Object(d);
    }
    let (hint, troubleshoot) = classify_network_error(&err.message);
    let mut d = Map::new();
    d.insert("requestedUrl".into(), json!(policy_url));
    if let Some(hint) = hint {
        d.insert("networkHint".into(), json!(hint));
    }
    if !troubleshoot.is_empty() {
        d.insert("troubleshoot".into(), json!(troubleshoot));
    }
    Value::Object(d)
}

pub(super) fn setting(log: &mut RunLogger<'_>, key: &str, default: &str) -> String {
    log.db()
        .with(|w| get_setting_with(w.conn, key, default))
        .unwrap_or_else(|_| default.to_string())
}

pub(super) fn sha256_hex(text: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `fetchAndStorePolicySource`. `Err` is what Node throws out of it — a
/// write that failed outside a `try` — with the fetch diagnostics it had
/// stashed by then left in `stash`.
async fn fetch_and_store(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    request: &PolicyRequest,
    policy_url: &str,
    options: SyncOptions,
    stash: &mut Option<Value>,
) -> Result<(Value, FollowUps), String> {
    let app_id = request.app_id.as_str();
    let existing = log.db().with(|w| read_row(w.conn, app_id))?;
    let existing = existing.as_ref();
    let now = log.now();

    // The kill-switch: nothing is fetched and the stored row is kept.
    if !options.bypass_throttle && setting(log, "policy_scrape_disabled", "false") == "true" {
        log.note(
            "disabled",
            "Policy scraping is disabled in Settings. Re-enable to fetch.",
        );
        // A first run has nothing stored: its only row is the run marker's
        // placeholder, whose `pending` would hydrate as `analysis_error`.
        // It is dropped, and nothing is returned.
        if col(existing, "status") == "pending" {
            log.db()
                .with(|w| w.run(DELETE_PLACEHOLDER, vec![json!(app_id)]))?;
            return Ok((Value::Null, FollowUps::default()));
        }
        let Some(row) = existing else {
            return Ok((Value::Null, FollowUps::default()));
        };
        let keep = Persist::keep(
            existing,
            col(existing, "status"),
            col(existing, "error"),
            col(existing, "source_fetched_at"),
        );
        let json = log.to_json();
        let _ = log
            .db()
            .with(|w| persist(w, app_id, policy_url, keep, now, json));
        let analysis = log.db().with(|w| hydrate(w.conn, app_id, row))?;
        return Ok((analysis, FollowUps::default()));
    }

    // The throttle: a ready analysis fetched inside the cooldown is kept.
    let throttle_enabled = setting(log, "policy_scrape_throttle_enabled", "true") != "false";
    let minutes = js_parse_int(&setting(log, "policy_scrape_throttle_minutes", "60"))
        .filter(|m| *m > 0)
        .unwrap_or(0);
    let fetched_at = col(existing, "source_fetched_at");
    if !options.bypass_throttle
        && throttle_enabled
        && minutes > 0
        && truthy(&fetched_at)
        && col(existing, "status") == "ready"
    {
        let elapsed = now as f64 - js_to_number(&fetched_at);
        let window = (minutes * 60_000) as f64;
        if elapsed >= 0.0 && elapsed < window {
            let elapsed_min = (elapsed / 60_000.0).round().max(1.0);
            let remaining_min = ((window - elapsed) / 60_000.0).ceil().max(1.0);
            log.note(
                "throttled",
                format!(
                    "Skipped scrape — last fetch was {} min ago (cooldown {minutes} min, {} min remaining). Disable Policy Scrape Throttle in Settings to override.",
                    js_number_spelling(elapsed_min),
                    js_number_spelling(remaining_min),
                ),
            );
            let keep = Persist::keep(
                existing,
                col(existing, "status"),
                col(existing, "error"),
                fetched_at,
            );
            let json = log.to_json();
            let _ = log
                .db()
                .with(|w| persist(w, app_id, policy_url, keep, now, json));
            let row = existing.expect("the throttle reads a stored row");
            let analysis = log.db().with(|w| hydrate(w.conn, app_id, row))?;
            return Ok((analysis, FollowUps::default()));
        }
    }

    log.start_phase(
        "fetching",
        Some(format!("Requesting {}", safe_url_label(policy_url))),
    );
    let source: Source = match fetch_privacy_policy_source(fetcher, policy_url, log).await {
        Ok(source) => {
            let note = if source.status == SourceStatus::Ready {
                format!(
                    "Fetched {} words via {} from {}.",
                    locale_int(source.word_count),
                    source.origin.as_str(),
                    safe_url_label(&source.final_url)
                )
            } else {
                let url = if source.final_url.is_empty() {
                    policy_url
                } else {
                    &source.final_url
                };
                format!(
                    "Source rejected: {} ({}).",
                    source.status.as_str(),
                    safe_url_label(url)
                )
            };
            log.end_phase(Some(note), None);
            source
        }
        Err(err) => {
            log.end_phase(None, Some(err.message.clone()));
            *stash = Some(diagnostics_for(&err, policy_url));
            let keep = Persist::keep(
                existing,
                json!("fetch_error"),
                json!(err.message),
                json!(now),
            );
            let json = log.to_json();
            let row = log
                .db()
                .with(|w| persist(w, app_id, policy_url, keep, now, json))?;
            let entry = json!({
                "type": "policy",
                "category": "privacy-policy",
                "description": format!("Privacy policy rescrape failed at {}.", safe_url_label(policy_url)),
                "details": [err.message],
                "policy_event": "error",
            });
            record_error_entry(
                log,
                ids,
                app_id,
                &entry,
                "Recorded failed rescrape in History.".to_string(),
            );
            let analysis = log.db().with(|w| hydrate(w.conn, app_id, &row))?;
            return Ok((analysis, FollowUps::default()));
        }
    };

    if source.status != SourceStatus::Ready {
        // An unusable body keeps the last policy actually read.
        let keep = Persist::keep(
            existing,
            json!(source.status.as_str()),
            source.error.clone().map_or(Value::Null, |e| json!(e)),
            json!(now),
        );
        let json = log.to_json();
        let row = log
            .db()
            .with(|w| persist(w, app_id, policy_url, keep, now, json))?;
        let reason = match source.error.as_deref() {
            Some(e) if !e.is_empty() => e.to_string(),
            _ => format!("Source rejected: {}", source.status.as_str()),
        };
        let url = if source.final_url.is_empty() {
            policy_url
        } else {
            &source.final_url
        };
        let entry = json!({
            "type": "policy",
            "category": "privacy-policy",
            "description": format!("Privacy policy rescrape couldn't be used at {}.", safe_url_label(url)),
            "details": [reason, format!("Fetched via {}.", source.origin.as_str())],
            "policy_event": "error",
        });
        record_error_entry(
            log,
            ids,
            app_id,
            &entry,
            format!(
                "Recorded unusable rescrape ({}) in History.",
                source.status.as_str()
            ),
        );
        let analysis = log.db().with(|w| hydrate(w.conn, app_id, &row))?;
        return Ok((analysis, FollowUps::default()));
    }

    let content_hash = sha256_hex(&source.text);
    let existing_hash = col(existing, "content_hash");
    let had_prior_version =
        log.db().with(|w| has_any_policy_version(w.conn, app_id)) || truthy(&existing_hash);
    let same_as_previous = existing.is_some() && existing_hash == json!(content_hash);
    let policy_event = match (had_prior_version, same_as_previous) {
        (false, _) => "first",
        (true, true) => "same",
        (true, false) => "changed",
    };

    // The backfill: a prior text the versions table never got, stored as
    // the version before this one so the diff has something to compare.
    let existing_text = col(existing, "source_text");
    if truthy(&existing_hash) && truthy(&existing_text) && existing_hash != json!(content_hash) {
        let fetched = col(existing, "source_fetched_at");
        let seed_at = if fetched.is_number() && js_to_number(&fetched) > 0.0 {
            fetched
        } else {
            col(existing, "updated_at")
        };
        let seed_at = if seed_at.is_null() {
            (now - 1).max(1) as f64
        } else {
            js_to_number(&seed_at)
        };
        let fetched_at = js_number(seed_at.min((now - 1) as f64));
        let word_count = col(existing, "source_word_count");
        let columns = [
            json!(policy_url),
            col(existing, "source_final_url"),
            col(existing, "source_title"),
            col(existing, "source_content_type"),
            col(existing, "source_origin"),
            if word_count.is_null() {
                json!(0)
            } else {
                word_count
            },
        ];
        let hash = existing_hash.as_str().unwrap_or_default().to_string();
        let text = existing_text.as_str().unwrap_or_default().to_string();
        match log
            .db()
            .with(|w| upsert_policy_version(w, ids, app_id, &hash, fetched_at, columns, &text))
        {
            Ok(_) => log.note(
                "version-backfill",
                "Seeded previous policy text from analysis row for diff history.",
            ),
            Err(e) => log.fail("version-backfill", e),
        }
    }

    let columns = [
        json!(policy_url),
        json!(source.final_url),
        json!(source.title),
        json!(source.content_type),
        json!(source.origin.as_str()),
        json!(source.word_count),
    ];
    let version_id = match log.db().with(|w| {
        upsert_policy_version(
            w,
            ids,
            app_id,
            &content_hash,
            json!(now),
            columns,
            &source.text,
        )
    }) {
        Ok(id) => Some(id),
        Err(e) => {
            log.fail("version-store", e);
            None
        }
    };

    let mut follow_ups = FollowUps::default();
    if let Some(version_id) = &version_id {
        let target = if source.final_url.is_empty() {
            policy_url.to_string()
        } else {
            source.final_url.clone()
        };
        match wayback::lookup_latest(fetcher, &target).await {
            Some(snapshot) => {
                let at = log.now();
                let linked = log.db().with(|w| {
                    w.run(
                        SET_ARCHIVE_URL,
                        vec![json!(snapshot.url), json!(at), json!(version_id)],
                    )
                });
                match linked {
                    Ok(_) => log.note(
                        "archive-existing",
                        format!(
                            "Linked to existing Wayback snapshot ({}).",
                            snapshot.timestamp.as_deref().unwrap_or("unknown ts")
                        ),
                    ),
                    Err(e) => log.fail("archive-existing", e),
                }
            }
            None => log.note("archive-existing", "No existing Wayback snapshot found."),
        }
        fire_save_now(
            log.db(),
            fetcher,
            &mut follow_ups,
            version_id.clone(),
            target,
        );
    }

    let label = safe_url_label(policy_url);
    let description = match policy_event {
        "first" => format!("Privacy policy first downloaded from {label}."),
        "changed" => format!("Privacy policy text changed at {label}."),
        _ => format!("Privacy policy scraped — returned same text as previous version at {label}."),
    };
    let mut details = vec![json!(format!(
        "{} words, fetched via {}.",
        locale_int(source.word_count),
        source.origin.as_str()
    ))];
    match policy_event {
        "changed" => details.push(json!(
            "Re-summarise from the AI Policy tab to refresh ratings."
        )),
        "first" => details.push(json!(
            "Summarise from the AI Policy tab to generate ratings."
        )),
        _ => {}
    }
    let mut entry = Map::new();
    entry.insert("type".into(), json!("policy"));
    entry.insert("category".into(), json!("privacy-policy"));
    entry.insert("description".into(), json!(description));
    entry.insert("details".into(), Value::Array(details));
    entry.insert("policy_event".into(), json!(policy_event));
    if let Some(id) = &version_id {
        entry.insert("policy_version_id".into(), json!(id));
    }
    let entry = Value::Object(entry);
    let now_entry = log.now();
    let app_name = request.app_name.as_str();
    let recorded = log
        .db()
        .with(|w| -> Result<(bool, Option<Immediate>), String> {
            let surface = policy_event == "changed" && policy_update_notifications_enabled(w.conn);
            let flagged = append_policy_change_entry(w, ids, now_entry, app_id, &entry, surface)?;
            let immediate = if flagged {
                Some(create_notification(
                    w, ids, now_entry, app_id, app_name, &entry,
                )?)
            } else {
                None
            };
            Ok((flagged, immediate))
        });
    match recorded {
        Ok((flagged, immediate)) => {
            if let Some(immediate) = immediate {
                fire_webhook(log.db(), fetcher, now_entry, immediate, &mut follow_ups);
            }
            log.note(
                "changelog",
                if flagged {
                    format!("Recorded policy {policy_event} event in History and notified.")
                } else {
                    format!("Recorded policy {policy_event} event in History.")
                },
            );
        }
        Err(e) => log.fail("changelog", e),
    }

    let summary = col(existing, "summary_json");
    let persisted =
        if !options.force_resummarise && existing_hash == json!(content_hash) && truthy(&summary) {
            log.note(
                "cache-hit",
                "Policy text is unchanged since the last summary.",
            );
            Persist {
                status: json!("ready"),
                source_title: json!(source.title),
                source_content_type: json!(source.content_type),
                source_text: json!(source.text),
                source_word_count: json!(source.word_count),
                source_origin: json!(source.origin.as_str()),
                source_final_url: json!(source.final_url),
                content_hash: json!(content_hash),
                analysis_mode: analysis_mode(&col(existing, "analysis_mode")),
                summary_json: summary,
                previous_summary_json: col(existing, "previous_summary_json"),
                previous_summary_at: col(existing, "previous_summary_at"),
                model: col(existing, "model"),
                error: Value::Null,
                source_fetched_at: json!(now),
            }
        } else {
            let previous_summary_json = if summary.is_null() {
                col(existing, "previous_summary_json")
            } else {
                summary.clone()
            };
            let previous_summary_at = if truthy(&summary) {
                col(existing, "updated_at")
            } else {
                col(existing, "previous_summary_at")
            };
            Persist {
                status: json!("source_ready"),
                source_title: json!(source.title),
                source_content_type: json!(source.content_type),
                source_text: json!(source.text),
                source_word_count: json!(source.word_count),
                source_origin: json!(source.origin.as_str()),
                source_final_url: json!(source.final_url),
                content_hash: json!(content_hash),
                analysis_mode: Value::Null,
                summary_json: Value::Null,
                previous_summary_json,
                previous_summary_at,
                model: Value::Null,
                error: Value::Null,
                source_fetched_at: json!(now),
            }
        };
    let json = log.to_json();
    let row = log
        .db()
        .with(|w| persist(w, app_id, policy_url, persisted, now, json))?;
    let analysis = log.db().with(|w| hydrate(w.conn, app_id, &row))?;
    Ok((analysis, follow_ups))
}

/// The activity row's status and summary for a result. `scrape_disabled`
/// is whether the run log shows the kill-switch stopped the fetch.
fn activity_summary(result: &Value, scrape_disabled: bool, phase: Phase) -> (&'static str, String) {
    if result.is_null() {
        if scrape_disabled {
            return ("partial", "Policy skipped: scraping disabled".to_string());
        }
        return ("ok", "Policy URL cleared".to_string());
    }
    let error = result["error"].as_str().filter(|e| !e.is_empty());
    match result["status"].as_str().unwrap_or("") {
        "ready" if phase == Phase::Fetch => ("ok", "Policy source fetched (cached)".to_string()),
        "ready" => ("ok", "Policy summary ready".to_string()),
        "source_ready" => ("ok", "Policy source fetched".to_string()),
        "fetch_error" => (
            "error",
            error.map_or_else(
                || "Policy fetch failed".to_string(),
                |e| js_slice_prefix(&format!("Fetch failed: {e}"), 200),
            ),
        ),
        "analysis_error" => (
            "error",
            error.map_or_else(
                || "Policy summary failed".to_string(),
                |e| js_slice_prefix(&format!("Summary failed: {e}"), 200),
            ),
        ),
        status @ ("too_short" | "unsupported_content_type") => (
            "partial",
            format!("Policy skipped: {}", status.replace('_', " ")),
        ),
        "needs_ai_config" => (
            "partial",
            "Policy source ready — AI not configured".to_string(),
        ),
        "" => ("ok", "Policy summary complete".to_string()),
        status => ("ok", format!("Policy status: {status}")),
    }
}

/// The phase the options name: the fetch, the summary of what is stored,
/// or the fetch and then — only when it landed a clean new source — the
/// summary. A cache hit is already `ready` and is not summarised again.
#[allow(clippy::too_many_arguments)]
async fn run_phase(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: &dyn Clock,
    request: &PolicyRequest,
    policy_url: &str,
    options: SyncOptions,
    stash: &mut Option<Value>,
) -> Result<(Value, FollowUps), String> {
    use super::policy_summary::summarise_stored_policy;
    let force = options.force_resummarise;
    match options.phase {
        Phase::Fetch => {
            fetch_and_store(log, ids, fetcher, request, policy_url, options, stash).await
        }
        Phase::Summarise => summarise_stored_policy(log, ids, fetcher, clock, request, force).await,
        Phase::All => {
            let (after_fetch, follow_ups) =
                fetch_and_store(log, ids, fetcher, request, policy_url, options, stash).await?;
            if after_fetch.get("status").and_then(Value::as_str) == Some("source_ready") {
                let (analysis, nested) =
                    summarise_stored_policy(log, ids, fetcher, clock, request, force).await?;
                Ok((
                    analysis,
                    FollowUps {
                        save_now: follow_ups.save_now.or(nested.save_now),
                        immediate: follow_ups.immediate.or(nested.immediate),
                    },
                ))
            } else {
                Ok((after_fetch, follow_ups))
            }
        }
    }
}

/// `syncPrivacyPolicyAnalysis`. `Err` is what Node throws: the run marker
/// refused, or a write outside a `try`.
pub(crate) async fn sync_policy_analysis(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: &dyn Clock,
    request: &PolicyRequest,
    options: SyncOptions,
) -> Result<Synced, String> {
    let app_id = request.app_id.as_str();
    let Some(policy_url) = request.policy_url.as_deref().filter(|u| !u.is_empty()) else {
        db.with(|w| w.run(DELETE_ANALYSIS, vec![json!(app_id)]))?;
        return Ok(Synced {
            analysis: Value::Null,
            follow_ups: FollowUps::default(),
        });
    };
    let started = clock.now();
    db.with(|w| mark_policy_run_start(w, app_id, started))?;
    let activity_start = clock.now();

    let mut stash: Option<Value> = None;
    let (outcome, scrape_disabled) = {
        let mut log = RunLogger::new(&mut *db, clock, app_id);
        let outcome = run_phase(
            &mut log, ids, fetcher, clock, request, policy_url, options, &mut stash,
        )
        .await;
        (outcome, log.logged("disabled"))
    };

    let result = db.with(|w| {
        let ended = clock.now();
        match outcome {
            Ok((analysis, follow_ups)) => {
                let (status, summary) = activity_summary(&analysis, scrape_disabled, options.phase);
                let mut detail = Map::new();
                detail.insert("phase".into(), json!(options.phase.as_str()));
                detail.insert("forceResummarise".into(), json!(options.force_resummarise));
                detail.insert(
                    "resultStatus".into(),
                    analysis.get("status").cloned().unwrap_or(Value::Null),
                );
                detail.insert("policyUrl".into(), json!(policy_url));
                detail.insert(
                    "model".into(),
                    analysis.get("model").cloned().unwrap_or(Value::Null),
                );
                if let Some(error) = analysis.get("error").filter(|e| truthy(e)) {
                    detail.insert("errorMessage".into(), error.clone());
                }
                if status == "error" {
                    if let Some(d) = stash.take() {
                        detail.insert("fetchDiagnostics".into(), d);
                    }
                }
                record_activity_named(
                    w,
                    ids,
                    ended,
                    "policy_summary",
                    status,
                    Some(app_id),
                    Some(&request.app_name),
                    Some(&summary),
                    Some(&Value::Object(detail)),
                    activity_start,
                );
                Ok(Synced {
                    analysis,
                    follow_ups,
                })
            }
            Err(message) => {
                let mut detail = Map::new();
                detail.insert("phase".into(), json!(options.phase.as_str()));
                detail.insert("forceResummarise".into(), json!(options.force_resummarise));
                detail.insert("policyUrl".into(), json!(policy_url));
                detail.insert("errorMessage".into(), json!(message));
                if let Some(d) = stash.take() {
                    detail.insert("fetchDiagnostics".into(), d);
                }
                record_activity_named(
                    w,
                    ids,
                    ended,
                    "policy_summary",
                    "error",
                    Some(app_id),
                    Some(&request.app_name),
                    Some(&js_slice_prefix(
                        &format!("Policy sync threw: {message}"),
                        200,
                    )),
                    Some(&Value::Object(detail)),
                    activity_start,
                );
                Err(message)
            }
        }
    });
    // `finally { markPolicyRunEnd(appId) }`: its own failure replaces the
    // outcome, as a throw from a `finally` does.
    db.with(|w| w.run(MARK_IDLE, vec![json!(app_id)]))?;
    result
}

/// Finish what the sync handed back: the capture Save Page Now reported
/// (or the request itself, when it could not be made when fired) stamped
/// on the version first, then any immediate webhook not yet posted.
pub(crate) async fn run_follow_ups(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    clock: &dyn Clock,
    follow_ups: FollowUps,
) {
    if let Some((version_id, save_now)) = follow_ups.save_now {
        let result = match save_now {
            SaveNow::Landed(result) => result,
            SaveNow::Later(target) => wayback::save_now(fetcher, &target).await,
        };
        link_capture(db, clock, &version_id, result);
    }
    if let Some((now, immediate)) = follow_ups.immediate {
        webhook_writes::fire_immediate(db, fetcher, now, immediate).await;
    }
}

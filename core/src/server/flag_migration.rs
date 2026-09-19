//! Phase 6, batch 2b: `runFeatureFlagMigration` from
//! `lib/migrations/v1_feature_flags.ts`, which Node's startup hook runs
//! once, before any ticker, so the resolver and everything after it see
//! migrated state.
//!
//! Six steps, each between a "started" and a "completed" activity row: a
//! check that the tables exist, the legacy `user_intent` turned into a
//! focus, the legacy `notification_prefs` blob turned into per-type
//! overrides, the retired callout overrides dropped, the override
//! quarantine brought up to date with the flag registry, and the old goal
//! keys moved to their new names. Then the version marker and a closing
//! row. A step that fails writes a "failed" row and ends the run WITHOUT
//! the marker, so the next boot runs everything again; there is no
//! transaction around the run, so the steps before the failure keep what
//! they wrote.
//!
//! Gated by `core/tests/fixtures/flag-migration-cases.json`, recorded by
//! `core/scripts/extract-flag-migration-cases.mjs`; `flag_migration_tests`
//! replays it.
use serde_json::{json, Value};

use super::{
    activity_log::record_activity, flags, routes_focus::infer_focus_workflow,
    settings::get_setting_with, sync_runner::Clock,
};
use crate::jsnum::js_parse_int;
use crate::scrape::{persist::Writer, Ids};

const MIGRATION_VERSION: i64 = 2;
const MIGRATION_KEY: &str = "feature_flag_migration_version";

const SET_SETTING: &str = "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)";
const DELETE_INTENT: &str = "DELETE FROM app_settings WHERE key = 'user_intent'";
const DELETE_PREFS: &str = "DELETE FROM app_settings WHERE key = 'notification_prefs'";
const DELETE_SETTING: &str = "DELETE FROM app_settings WHERE key = ?";
const UPSERT_OVERRIDE: &str = "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, quarantined)\n         VALUES (?, ?, ?, 'migration', 0)\n         ON CONFLICT(flag_key) DO UPDATE SET\n           override_value = excluded.override_value,\n           set_at = excluded.set_at,\n           set_by = 'migration',\n           quarantined = 0";
const DELETE_OVERRIDE: &str = "DELETE FROM feature_flag_overrides WHERE flag_key = ?";
/// `unquarantineKnownOverrides` and `quarantineUnknownOverrides`, before
/// their placeholder lists.
const UNQUARANTINE_KNOWN: &str =
    "UPDATE feature_flag_overrides\n     SET quarantined = 0\n     WHERE quarantined = 1\n       AND flag_key IN (";
const QUARANTINE_UNKNOWN: &str =
    "UPDATE feature_flag_overrides\n     SET quarantined = 1\n     WHERE quarantined = 0\n       AND flag_key NOT IN (";

/// `INTENT_MAP`: the legacy intent, then the audience and the two goals.
const INTENTS: [(&str, &str, bool, bool); 4] = [
    ("curious", "self", true, false),
    ("cleanup", "self", false, true),
    ("hygiene", "self", true, true),
    ("family", "guardian", true, false),
];
const CALLOUT_LEGACY_KEYS: [&str; 4] = [
    "flag.dashboard.cleanup_callout",
    "flag.dashboard.family_callout",
    "flag.dashboard.hygiene_callout",
    "flag.dashboard.definitions_callout",
];
/// `NOTIFICATION_TYPE_KEYS`, in its key order.
const NOTIFICATION_TYPE_KEYS: [(&str, &str); 4] = [
    ("label_changes", "flag.notifications.types.label_changes"),
    ("policy_updates", "flag.notifications.types.policy_updates"),
    (
        "accessibility_changes",
        "flag.notifications.types.accessibility_changes",
    ),
    (
        "new_privacy_types",
        "flag.notifications.types.new_privacy_types",
    ),
];
const GOAL_RENAMES: [(&str, &str); 2] = [
    ("flag.focus.goal.understand", "flag.focus.goal.monitor"),
    ("flag.focus.goal.declutter", "flag.focus.goal.cleanup"),
];
const OVERRIDES_MISSING: &str =
    "feature_flag_overrides table is missing — lib/db.ts did not create it";
const ANNOTATIONS_MISSING: &str = "annotations table is missing — lib/db.ts did not create it";
/// V8's `TypeError` for `Object.hasOwn(null, key)`.
const NULL_TO_OBJECT: &str = "Cannot convert undefined or null to object";

/// One step's entry in the run's result and its closing row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StepResult {
    pub(crate) name: &'static str,
    pub(crate) duration_ms: i64,
}

/// Why the run stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Failure {
    /// `MigrationError`: a step threw, and the "failed" row was written.
    Step { step: &'static str, cause: String },
    /// Anything before the steps (the version read), which Node lets
    /// propagate as it is.
    Other(String),
}

impl Failure {
    /// `error.message`.
    pub(crate) fn message(&self) -> String {
        match self {
            Failure::Step { step, cause } => format!("Migration step `{step}` failed: {cause}"),
            Failure::Other(message) => message.clone(),
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Step { .. } => write!(f, "MigrationError: {}", self.message()),
            Failure::Other(message) => f.write_str(message),
        }
    }
}

/// SQLite's own text, as better-sqlite3 surfaces it.
fn sql_message(e: rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(text)) => text,
        other => other.to_string(),
    }
}

/// `db.transaction(fn)()`. better-sqlite3 opens a savepoint when a
/// transaction is already open, which is how `setActiveFocus`'s own
/// transaction nests inside step 2's; a savepoint at the top opens one.
/// Marked as Node's oracle marks every call: BEGIN, then COMMIT once it has
/// committed, or ROLLBACK.
fn transaction<T>(
    w: &mut Writer,
    body: impl FnOnce(&mut Writer) -> Result<T, String>,
) -> Result<T, String> {
    w.conn
        .execute_batch("SAVEPOINT flag_migration")
        .map_err(sql_message)?;
    w.mark("BEGIN");
    let released = body(w).and_then(|value| {
        w.conn
            .execute_batch("RELEASE flag_migration")
            .map(|()| value)
            .map_err(sql_message)
    });
    match released {
        Ok(value) => {
            w.mark("COMMIT");
            Ok(value)
        }
        Err(e) => {
            w.mark("ROLLBACK");
            let _ = w
                .conn
                .execute_batch("ROLLBACK TO flag_migration; RELEASE flag_migration");
            Err(e)
        }
    }
}

/// `runFeatureFlagMigration`: nothing at version 2 or later (by
/// `Number.parseInt`, so `"2.5"` and `"\t 2"` count and `"0x2"` does not),
/// else the six steps, the marker and the closing row.
pub(crate) fn run(
    w: &mut Writer,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
) -> Result<Vec<StepResult>, Failure> {
    let stored =
        get_setting_with(w.conn, MIGRATION_KEY, "0").map_err(|e| Failure::Other(sql_message(e)))?;
    if js_parse_int(&stored).is_some_and(|current| current >= MIGRATION_VERSION) {
        return Ok(vec![]);
    }
    let total_start = clock.now();
    let mut results = vec![];
    let steps: [(&'static str, StepFn); 6] = [
        ("schema_check", schema_check),
        ("user_intent_migration", user_intent_migration),
        ("notification_prefs_absorb", notification_prefs_absorb),
        ("callout_rename", callout_rename),
        ("quarantine_check", quarantine_check),
        ("focus_goal_rename", focus_goal_rename),
    ];
    for (name, step) in steps {
        match run_step(w, ids, clock, name, step) {
            Ok(result) => results.push(result),
            Err(cause) => {
                record_activity(
                    w,
                    ids,
                    clock.now(),
                    "migration",
                    "error",
                    None,
                    Some(&format!("migration_v1_step_failed: {name}")),
                    Some(&json!({ "error": cause })),
                    clock.now(),
                );
                return Err(Failure::Step { step: name, cause });
            }
        }
    }
    // The marker only once every step has succeeded. Node lets a failure
    // here propagate as it is.
    w.run(
        SET_SETTING,
        vec![json!(MIGRATION_KEY), json!(MIGRATION_VERSION.to_string())],
    )
    .map_err(Failure::Other)?;
    let total_ms = clock.now() - total_start;
    let steps: Vec<Value> = results
        .iter()
        .map(|r| json!({ "name": r.name, "durationMs": r.duration_ms }))
        .collect();
    record_activity(
        w,
        ids,
        clock.now(),
        "migration",
        "ok",
        None,
        Some(&format!(
            "migration_v1_completed: {n}/{n} steps, total: {total_ms}ms",
            n = results.len()
        )),
        Some(&json!({ "steps": steps })),
        total_start,
    );
    Ok(results)
}

type StepFn = fn(&mut Writer, &dyn Clock) -> Result<(), String>;

/// `runStep`: the "started" row, the step, the "completed" row.
fn run_step(
    w: &mut Writer,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
    name: &'static str,
    step: StepFn,
) -> Result<StepResult, String> {
    let start = clock.now();
    record_activity(
        w,
        ids,
        clock.now(),
        "migration",
        "ok",
        None,
        Some(&format!("migration_v1_step_started: {name}")),
        None,
        start,
    );
    step(w, clock)?;
    let duration_ms = clock.now() - start;
    record_activity(
        w,
        ids,
        clock.now(),
        "migration",
        "ok",
        None,
        Some(&format!(
            "migration_v1_step_completed: {name}, duration: {duration_ms}ms"
        )),
        Some(&json!({ "durationMs": duration_ms })),
        start,
    );
    Ok(StepResult { name, duration_ms })
}

/// Step 1: both tables must exist. A read only.
fn schema_check(w: &mut Writer, _clock: &dyn Clock) -> Result<(), String> {
    for (table, missing) in [
        ("feature_flag_overrides", OVERRIDES_MISSING),
        ("annotations", ANNOTATIONS_MISSING),
    ] {
        let present = w
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .and_then(|mut stmt| stmt.exists([table]))
            .map_err(sql_message)?;
        if !present {
            return Err(missing.to_string());
        }
    }
    Ok(())
}

/// `setActiveFocus`, in its own transaction. `audience` is `None` for an
/// intent that only an inherited `INTENT_MAP` entry answers (`toString`,
/// `__proto__`): its audience is `undefined`, which better-sqlite3 binds as
/// NULL, and the first write fails the NOT NULL column.
fn set_active_focus(
    w: &mut Writer,
    clock: &dyn Clock,
    audience: Option<&str>,
    monitor: bool,
    cleanup: bool,
) -> Result<(), String> {
    transaction(w, |w| {
        let Some(audience) = audience else {
            w.run(SET_SETTING, vec![json!("flag.focus.audience"), Value::Null])?;
            return Ok(());
        };
        let workflow = infer_focus_workflow(audience, monitor, cleanup, false);
        for (key, value) in [
            ("flag.focus.audience", audience.to_string()),
            ("flag.focus.goal.monitor", monitor.to_string()),
            ("flag.focus.goal.cleanup", cleanup.to_string()),
            ("flag.focus.goal.minimal", "false".to_string()),
            ("flag.focus.goal.accessibility", "false".to_string()),
            ("flag.focus.workflow", workflow.to_string()),
            ("flag.focus.updated_at", clock.now().to_string()),
        ] {
            w.run(SET_SETTING, vec![json!(key), json!(value)])?;
        }
        Ok(())
    })
}

/// Step 2: the legacy intent becomes a focus, then goes. An intent the map
/// does not know is dropped with a warning.
fn user_intent_migration(w: &mut Writer, clock: &dyn Clock) -> Result<(), String> {
    let intent = get_setting_with(w.conn, "user_intent", "").map_err(sql_message)?;
    if intent.is_empty() {
        return Ok(());
    }
    let mapped = INTENTS.iter().find(|(name, ..)| *name == intent);
    let inherited = flags::OBJECT_PROTOTYPE_NAMES.contains(&intent.as_str());
    if mapped.is_none() && !inherited {
        super::diag::log_warn(format!(
            "[Migration] Unknown user_intent value '{intent}', skipping"
        ));
        w.run(DELETE_INTENT, vec![])?;
        return Ok(());
    }
    transaction(w, |w| {
        match mapped {
            Some(&(_, audience, monitor, cleanup)) => {
                set_active_focus(w, clock, Some(audience), monitor, cleanup)?
            }
            None => set_active_focus(w, clock, None, false, false)?,
        }
        w.run(DELETE_INTENT, vec![])?;
        Ok(())
    })
}

/// Step 3: each notification type the blob names (as an own property)
/// becomes an override, `on` for `true`, `"on"` or `"true"` and `off` for
/// anything else; then the blob goes. A blob that is not JSON is dropped
/// with a warning; one that parses to `null` fails the step, as
/// `Object.hasOwn(null, …)` throws.
fn notification_prefs_absorb(w: &mut Writer, clock: &dyn Clock) -> Result<(), String> {
    let blob = get_setting_with(w.conn, "notification_prefs", "").map_err(sql_message)?;
    if blob.is_empty() {
        return Ok(());
    }
    let parsed = match crate::jsjson::parse(&blob) {
        Ok(parsed) => parsed,
        Err(e) => {
            super::diag::log_warn(format!(
                "[Migration] notification_prefs JSON unparseable, dropping: SyntaxError: {e}"
            ));
            w.run(DELETE_PREFS, vec![])?;
            return Ok(());
        }
    };
    let now = clock.now();
    transaction(w, |w| {
        if parsed.is_null() {
            return Err(NULL_TO_OBJECT.to_string());
        }
        for (legacy, flag) in NOTIFICATION_TYPE_KEYS {
            // Only an object has these as own properties; an array, a
            // string or a number has none of them.
            let Some(raw) = parsed.as_object().and_then(|m| m.get(legacy)) else {
                continue;
            };
            let on = *raw == Value::Bool(true) || matches!(raw.as_str(), Some("on" | "true"));
            w.run(
                UPSERT_OVERRIDE,
                vec![
                    json!(flag),
                    json!(if on { "on" } else { "off" }),
                    json!(now),
                ],
            )?;
        }
        w.run(DELETE_PREFS, vec![])?;
        Ok(())
    })
}

/// Step 4: the retired callout overrides are dropped, not carried over.
fn callout_rename(w: &mut Writer, _clock: &dyn Clock) -> Result<(), String> {
    transaction(w, |w| {
        for key in CALLOUT_LEGACY_KEYS {
            w.run(DELETE_OVERRIDE, vec![json!(key)])?;
        }
        Ok(())
    })
}

/// Step 5: overrides whose key the registry knows leave quarantine, and
/// the rest enter it. Each statement binds every registry key, in
/// `Object.keys(HARD_DEFAULTS)` order.
fn quarantine_check(w: &mut Writer, _clock: &dyn Clock) -> Result<(), String> {
    let keys: Vec<Value> = flags::rules().keys().map(|k| json!(k)).collect();
    let placeholders = vec!["?"; keys.len()].join(", ");
    w.run(
        &format!("{UNQUARANTINE_KNOWN}{placeholders})"),
        keys.clone(),
    )?;
    w.run(&format!("{QUARANTINE_UNKNOWN}{placeholders})"), keys)?;
    Ok(())
}

/// Step 6: an old goal key's value moves to the new key unless that is
/// already set; the old key goes either way.
fn focus_goal_rename(w: &mut Writer, _clock: &dyn Clock) -> Result<(), String> {
    transaction(w, |w| {
        for (old, new) in GOAL_RENAMES {
            let value = get_setting_with(w.conn, old, "").map_err(sql_message)?;
            if !value.is_empty()
                && get_setting_with(w.conn, new, "")
                    .map_err(sql_message)?
                    .is_empty()
            {
                w.run(SET_SETTING, vec![json!(new), json!(value)])?;
            }
            w.run(DELETE_SETTING, vec![json!(old)])?;
        }
        Ok(())
    })
}

//! `GET /api/apps/{id}/detail` — everything the app-detail page renders, in
//! one payload. Fourteen keys, assembled from reads that are almost all
//! already ported: `getAppWithPrivacy` (apps.rs), `getChangelogPage`
//! (changelog.rs), the two profile parsers (routes.rs), the import-item
//! hydrator (routes_imports.rs) and the rate gate (routes_manual.rs). Three
//! reads are new and live here.
//!
//! Two things shape this route and neither is a query:
//!
//! 1. **Every read is wrapped in `safe()`** with its own fallback. A failure
//!    in one degrades THAT field to the page's old default and nothing else
//!    — so a schema drift in one table cannot blank the page. The single
//!    exception is the app row, whose failure IS the 404. A port that `?`s
//!    any other read out of the handler turns a partial answer into a 500.
//! 2. **`ID_RE = /^\d{1,20}$/` runs BEFORE the existence check.** A
//!    non-numeric id is a 400, not a 404 — which also means the parity
//!    fixture's `pt-fixture-*` apps can never reach this route; its
//!    fixture coverage has to hang off a seeded, numeric-id app.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{Map, Value};

use super::apps::get_app_with_privacy;
use super::changelog::{get_changelog_page, ChangelogRow};
use super::json::{json_error, json_ok};
use super::now_ms;
use super::routes::{
    parse_stored_profile, A11Y_FEATURE_KEYS, A11Y_PREFERENCES, PROFILE_CATEGORY_KEYS, PROFILE_TIERS,
};
use super::routes_imports::{hydrate_item, normalize, ImportItemRow, IMPORT_SOURCES};
use super::routes_manual::rate_gate;
use super::row::{column, to_sql_value};
use super::settings::get_setting_with;
use super::AppState;
use crate::jsnum::js_parse_int;

const AGE_BAND_KEYS: [&str; 5] = ["under_9", "9_12", "13_15", "16_17", "18_plus"];
const AI_PROVIDERS: [&str; 4] = ["disabled", "openai", "anthropic", "custom"];

/// `ID_RE = /^\d{1,20}$/`.
fn is_valid_app_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
}

/// `normalizeAiProvider`: the legacy `"ollama"` maps to `"custom"`; anything
/// not in the allowlist is `"disabled"`.
pub(super) fn normalize_ai_provider(value: &str) -> &'static str {
    if value == "ollama" {
        return "custom";
    }
    AI_PROVIDERS
        .iter()
        .copied()
        .find(|p| *p == value)
        .unwrap_or("disabled")
}

// ── getUnacknowledgedChanges ─────────────────────────────────────────

#[derive(Serialize)]
struct UnacknowledgedEvent {
    id: Value,
    scraped_at: Value,
    changes: Vec<Value>,
}

/// Literal order: `since, events, totalCount, addedCount, removedCount,
/// snoozedUntil` — and the route's `EMPTY_UNACKNOWLEDGED` fallback uses the
/// same order, so one struct serves both.
#[derive(Serialize)]
struct Unacknowledged {
    since: Value,
    events: Vec<UnacknowledgedEvent>,
    #[serde(rename = "totalCount")]
    total_count: i64,
    #[serde(rename = "addedCount")]
    added_count: i64,
    #[serde(rename = "removedCount")]
    removed_count: i64,
    #[serde(rename = "snoozedUntil")]
    snoozed_until: Value,
}

fn empty_unacknowledged() -> Unacknowledged {
    Unacknowledged {
        since: Value::from(0),
        events: Vec::new(),
        total_count: 0,
        added_count: 0,
        removed_count: 0,
        snoozed_until: Value::from(0),
    }
}

/// Port of `getUnacknowledgedChanges`.
///
/// `since` is `changes_acknowledged_at ?? 0` — a NULL column is 0, and a
/// missing app row is also 0 (the query still runs, and matches nothing
/// newer than the epoch). The snooze expires by comparison with the wall
/// clock: anything not strictly in the future reads as 0. Events parse
/// `changes_summary` with a try/catch (unlike `getChangelog`), so a bad
/// blob is an event with no changes rather than a 500.
fn get_unacknowledged_changes(conn: &Connection, app_id: &str) -> rusqlite::Result<Unacknowledged> {
    let ack: Option<(Value, Value)> = conn
        .query_row(
            "SELECT changes_acknowledged_at, changes_snoozed_until FROM apps WHERE id = ?",
            [app_id],
            |row| {
                Ok((
                    column(row, "changes_acknowledged_at")?,
                    column(row, "changes_snoozed_until")?,
                ))
            },
        )
        .optional()?;
    let (since, raw_snooze) = match ack {
        Some((a, s)) => (nullish_or(a, 0), nullish_or(s, 0)),
        None => (Value::from(0), Value::from(0)),
    };
    // `rawSnoozeUntil > Date.now() ? rawSnoozeUntil : 0` — a non-numeric
    // value compares false in JS and reads as 0.
    let snoozed_until = match raw_snooze.as_f64() {
        Some(f) if f > now_ms() as f64 => raw_snooze.clone(),
        _ => Value::from(0),
    };

    let mut stmt = conn.prepare(
        "SELECT id, scraped_at, changes_summary \
           FROM privacy_snapshots \
          WHERE app_id = ? AND changes_detected = 1 AND scraped_at > ? \
          ORDER BY scraped_at DESC",
    )?;
    let events: Vec<UnacknowledgedEvent> = stmt
        .query_map(rusqlite::params![app_id, to_sql_value(&since)], |row| {
            let raw: Option<String> = row.get("changes_summary")?;
            // `if (r.changes_summary) try { parse } catch { [] }` — falsy
            // (null or "") and unparseable both give an empty list; a
            // parsed non-array is spread as-is and only explodes later,
            // which this treats as empty for the same reason as elsewhere.
            let changes = raw
                .filter(|s| !s.is_empty())
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| match v {
                    Value::Array(a) => Some(a),
                    _ => None,
                })
                .unwrap_or_default();
            Ok(UnacknowledgedEvent {
                id: column(row, "id")?,
                scraped_at: column(row, "scraped_at")?,
                changes,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let (mut total, mut added, mut removed) = (0i64, 0i64, 0i64);
    for e in &events {
        for c in &e.changes {
            total += 1;
            match c.get("type").and_then(Value::as_str) {
                Some("added") => added += 1,
                Some("removed") => removed += 1,
                _ => {}
            }
        }
    }
    Ok(Unacknowledged {
        since,
        events,
        total_count: total,
        added_count: added,
        removed_count: removed,
        snoozed_until,
    })
}

/// `x ?? n` for a column value.
fn nullish_or(v: Value, n: i64) -> Value {
    if v.is_null() {
        Value::from(n)
    } else {
        v
    }
}

// ── getRecentPolicyChange ────────────────────────────────────────────

const POLICY_VERSION_COLUMNS: &str =
    "id, app_id, content_hash, first_fetched_at, last_fetched_at, \
              policy_url, source_final_url, source_title, source_content_type, \
              source_origin, source_word_count, source_text, \
              archive_url, archive_submitted_at";

struct PolicyVersion {
    id: Value,
    app_id: String,
    content_hash: Value,
    first_fetched_at: Value,
}

fn policy_version(row: &rusqlite::Row<'_>) -> rusqlite::Result<PolicyVersion> {
    Ok(PolicyVersion {
        id: column(row, "id")?,
        app_id: row.get::<_, Option<String>>("app_id")?.unwrap_or_default(),
        content_hash: column(row, "content_hash")?,
        first_fetched_at: column(row, "first_fetched_at")?,
    })
}

/// Port of `getRecentPolicyChange`. `getCurrentPolicyVersion` is the newest
/// by `last_fetched_at`; `getPreviousPolicyVersion` is the newest by
/// `first_fetched_at` with a DIFFERENT hash and an earlier first fetch.
/// Node re-reads the current row by id in between (`getPolicyVersion`) —
/// a redundant lookup on a single locked connection, elided here with no
/// effect on the wire.
fn get_recent_policy_change(
    conn: &Connection,
    app_id: &str,
    window_days: i64,
) -> rusqlite::Result<Option<Value>> {
    if window_days <= 0 {
        return Ok(None);
    }
    let current: Option<PolicyVersion> = conn
        .query_row(
            &format!(
                "SELECT {POLICY_VERSION_COLUMNS} FROM privacy_policy_versions \
                  WHERE app_id = ? ORDER BY last_fetched_at DESC LIMIT 1"
            ),
            [app_id],
            policy_version,
        )
        .optional()?;
    let Some(current) = current else {
        return Ok(None);
    };
    let previous: Option<PolicyVersion> = conn
        .query_row(
            &format!(
                "SELECT {POLICY_VERSION_COLUMNS} FROM privacy_policy_versions \
                  WHERE app_id = ? AND content_hash != ? AND first_fetched_at < ? \
                  ORDER BY first_fetched_at DESC LIMIT 1"
            ),
            rusqlite::params![
                current.app_id,
                to_sql_value(&current.content_hash),
                to_sql_value(&current.first_fetched_at)
            ],
            policy_version,
        )
        .optional()?;
    let Some(previous) = previous else {
        return Ok(None);
    };
    // `current.first_fetched_at + windowMs <= Date.now()` → null. A
    // non-numeric first_fetched_at makes the sum NaN, and `NaN <= x` is
    // false, so the change is reported.
    let window_ms = window_days as f64 * 24.0 * 60.0 * 60.0 * 1000.0;
    if let Some(f) = current.first_fetched_at.as_f64() {
        if f + window_ms <= now_ms() as f64 {
            return Ok(None);
        }
    }
    let mut m = Map::new();
    m.insert("currentVersionId".into(), current.id);
    m.insert("previousVersionId".into(), previous.id);
    m.insert("changedAt".into(), current.first_fetched_at);
    Ok(Some(Value::Object(m)))
}

// ── getAppImportProvenance ───────────────────────────────────────────

#[derive(Serialize)]
struct ImportProvenance {
    item: ImportItemRow,
    #[serde(rename = "importId")]
    import_id: Value,
    #[serde(rename = "importedAt")]
    imported_at: Value,
    source: String,
    #[serde(rename = "sourceLabel")]
    source_label: Value,
}

/// Port of `getAppImportProvenance`. The CASE ordering prefers `imported`
/// over `matched` over `queued`, then the parent import's `created_at`
/// DESC; `LIMIT 1` with that ORDER BY is deterministic up to rows that tie
/// on both.
fn get_app_import_provenance(conn: &Connection, app_id: &str) -> rusqlite::Result<Option<Value>> {
    if app_id.is_empty() {
        return Ok(None);
    }
    let row: Option<ImportProvenance> = conn
        .query_row(
            "SELECT ii.*, i.created_at AS i_created_at, \
                    i.source AS i_source, i.source_label AS i_source_label \
               FROM import_items ii \
               JOIN imports i ON i.id = ii.import_id \
              WHERE ii.app_id = ? OR ii.removed_app_id = ? \
              ORDER BY \
                CASE ii.status \
                  WHEN 'imported' THEN 0 \
                  WHEN 'matched'  THEN 1 \
                  WHEN 'queued'   THEN 2 \
                  ELSE 3 \
                END, \
                i.created_at DESC \
              LIMIT 1",
            [app_id, app_id],
            |row| {
                let raw_source: Option<String> = row.get("i_source")?;
                Ok(ImportProvenance {
                    item: hydrate_item(row)?,
                    import_id: column(row, "import_id")?,
                    imported_at: column(row, "i_created_at")?,
                    source: normalize(&raw_source.unwrap_or_default(), &IMPORT_SOURCES, "manual"),
                    source_label: column(row, "i_source_label")?,
                })
            },
        )
        .optional()?;
    Ok(row.map(|p| serde_json::to_value(p).unwrap_or(Value::Null)))
}

// ── the route ────────────────────────────────────────────────────────

#[derive(Serialize)]
struct DetailBody {
    app: Value,
    changelog: Vec<ChangelogRow>,
    #[serde(rename = "changelogHasMore")]
    changelog_has_more: bool,
    unacknowledged: Unacknowledged,
    #[serde(rename = "recentPolicyChange")]
    recent_policy_change: Option<Value>,
    #[serde(rename = "importProvenance")]
    import_provenance: Option<Value>,
    #[serde(rename = "aiProvider")]
    ai_provider: &'static str,
    #[serde(rename = "policyDiffAlertDays")]
    policy_diff_alert_days: i64,
    #[serde(rename = "privacyProfile")]
    privacy_profile: Option<Value>,
    #[serde(rename = "a11yProfile")]
    a11y_profile: Option<Value>,
    #[serde(rename = "waybackShowImportedDefault")]
    wayback_show_imported_default: bool,
    #[serde(rename = "trackAccessibility")]
    track_accessibility: bool,
    #[serde(rename = "childAgeBand")]
    child_age_band: Option<String>,
    audience: String,
}

pub async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(denied) = rate_gate(&state, &headers, "apps.detail", 120, 60_000) {
        return denied;
    }
    if !is_valid_app_id(&id) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid app id");
    }

    let conn = state.conn.lock().expect("db mutex poisoned");

    // `safe(fn, fallback)`: every read below degrades to its fallback on
    // error, and the warning is the only trace — exactly as in Node.
    macro_rules! safe {
        ($label:literal, $fallback:expr, $e:expr) => {
            match $e {
                Ok(v) => v,
                Err(err) => {
                    eprintln!("[apps/{id}/detail] {} failed: {err}", $label);
                    $fallback
                }
            }
        };
    }

    // The one read whose failure IS the 404.
    let app = match get_app_with_privacy(&conn, &id) {
        Ok(Some(app)) => app,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Not found"),
        Err(err) => {
            eprintln!("[apps/{id}/detail] getAppWithPrivacy failed: {err}");
            return json_error(StatusCode::NOT_FOUND, "Not found");
        }
    };
    // `app.id` from the ROW, as Node passes it — same value as the path id.
    let app_id: String = app
        .get("id")
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_else(|| id.clone());

    // Parsed once, guarded once (`>= 0` — 0 is meaningful and disables the
    // banner), then used for both fields that depend on it.
    let raw_days = safe!(
        "alert days",
        "90".to_string(),
        get_setting_with(&conn, "policy_diff_alert_days", "90")
    );
    let policy_diff_alert_days = match js_parse_int(&raw_days) {
        Some(n) if n >= 0 => n,
        _ => 90,
    };

    let raw_band = safe!(
        "child age band",
        String::new(),
        get_setting_with(&conn, "guardian_child_age_band", "")
    );

    let (changelog, changelog_has_more) = safe!(
        "getChangelogPage",
        (Vec::new(), false),
        get_changelog_page(&conn, &id, 50, None)
    );

    let unacknowledged = safe!(
        "getUnacknowledgedChanges",
        empty_unacknowledged(),
        get_unacknowledged_changes(&conn, &id)
    );
    let recent_policy_change = safe!(
        "getRecentPolicyChange",
        None,
        get_recent_policy_change(&conn, &app_id, policy_diff_alert_days)
    );
    let import_provenance = safe!(
        "getAppImportProvenance",
        None,
        get_app_import_provenance(&conn, &app_id)
    );
    let ai_provider = safe!(
        "ai provider",
        "disabled",
        get_setting_with(&conn, "ai_provider", "disabled").map(|v| normalize_ai_provider(&v))
    );
    let privacy_profile = safe!(
        "getPrivacyProfile",
        None,
        get_setting_with(&conn, "privacy_profile", "").map(|raw| parse_stored_profile(
            &raw,
            &PROFILE_CATEGORY_KEYS,
            &PROFILE_TIERS
        ))
    );
    let a11y_profile = safe!(
        "getAccessibilityProfile",
        None,
        get_setting_with(&conn, "accessibility_profile", "").map(|raw| parse_stored_profile(
            &raw,
            &A11Y_FEATURE_KEYS,
            &A11Y_PREFERENCES
        ))
    );
    // `getSetting(k, "true") !== "false"` — ONLY the literal "false" is
    // false; "0", "no" and "" are all true.
    let wayback_show_imported_default = safe!(
        "wayback_show_imported",
        true,
        get_setting_with(&conn, "wayback_show_imported", "true").map(|v| v != "false")
    );
    let track_accessibility = safe!(
        "track_accessibility_labels",
        true,
        get_setting_with(&conn, "track_accessibility_labels", "true").map(|v| v != "false")
    );
    // `getActiveFocus().audience` is `getSetting("flag.focus.audience", "")
    // || "self"` — `||`, so a stored empty string is "self" too. The other
    // focus reads are not needed for the one field this route uses.
    let audience = safe!(
        "getActiveFocus",
        "self".to_string(),
        get_setting_with(&conn, "flag.focus.audience", "").map(|v| if v.is_empty() {
            "self".to_string()
        } else {
            v
        })
    );

    json_ok(&DetailBody {
        app,
        changelog,
        changelog_has_more,
        unacknowledged,
        recent_policy_change,
        import_provenance,
        ai_provider,
        policy_diff_alert_days,
        privacy_profile,
        a11y_profile,
        wayback_show_imported_default,
        track_accessibility,
        // `isValidAgeBand(rawBand) ? rawBand : null` — present-null.
        child_age_band: AGE_BAND_KEYS
            .contains(&raw_band.as_str())
            .then_some(raw_band),
        audience,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_id_regex_is_one_to_twenty_ascii_digits() {
        for ok in ["1", "94961186", "00000000000000000000"] {
            assert!(is_valid_app_id(ok), "{ok}");
        }
        for bad in [
            "",
            "pt-fixture-diff",
            "123456789012345678901",
            "12a",
            " 1",
            "-1",
        ] {
            assert!(!is_valid_app_id(bad), "{bad}");
        }
    }

    #[test]
    fn ai_provider_normalises_ollama_and_rejects_unknowns() {
        assert_eq!(normalize_ai_provider("ollama"), "custom");
        assert_eq!(normalize_ai_provider("openai"), "openai");
        assert_eq!(
            normalize_ai_provider("OpenAI"),
            "disabled",
            "case-sensitive"
        );
        assert_eq!(normalize_ai_provider(""), "disabled");
    }

    #[test]
    fn empty_unacknowledged_matches_the_route_constant() {
        assert_eq!(
            serde_json::to_string(&empty_unacknowledged()).unwrap(),
            r#"{"since":0,"events":[],"totalCount":0,"addedCount":0,"removedCount":0,"snoozedUntil":0}"#
        );
    }

    #[test]
    fn unacknowledged_counts_entries_and_expires_the_snooze() {
        let c = Connection::open_in_memory().unwrap();
        let future = now_ms() + 100_000;
        c.execute_batch(&format!(
            "CREATE TABLE apps (id TEXT PRIMARY KEY, changes_acknowledged_at INTEGER, changes_snoozed_until INTEGER);
             CREATE TABLE privacy_snapshots (id TEXT, app_id TEXT, changes_detected INTEGER, scraped_at INTEGER, changes_summary TEXT);
             INSERT INTO apps VALUES ('1', 10, {future}), ('2', NULL, 5);
             INSERT INTO privacy_snapshots VALUES
               ('s1','1',1,20,'[{{\"type\":\"added\"}},{{\"type\":\"removed\"}},{{\"type\":\"policy\"}}]'),
               ('s0','1',1,10,'[{{\"type\":\"added\"}}]'),   -- not > since: excluded
               ('s2','1',0,30,'[{{\"type\":\"added\"}}]'),   -- not detected: excluded
               ('s3','1',1,40,'not json'),                   -- caught → no changes
               ('s4','2',1,1,NULL);"
        ))
        .unwrap();
        let u = get_unacknowledged_changes(&c, "1").unwrap();
        assert_eq!(u.since, Value::from(10));
        assert_eq!(
            u.snoozed_until,
            Value::from(future),
            "future snooze survives"
        );
        assert_eq!(u.events.len(), 2);
        assert_eq!(u.events[0].id, Value::from("s3"), "newest first");
        assert_eq!((u.total_count, u.added_count, u.removed_count), (3, 1, 1));

        let u2 = get_unacknowledged_changes(&c, "2").unwrap();
        assert_eq!(u2.since, Value::from(0), "NULL ?? 0");
        assert_eq!(u2.snoozed_until, Value::from(0), "past snooze reads as 0");
        assert_eq!(u2.events.len(), 1);
        assert!(u2.events[0].changes.is_empty());
    }

    #[test]
    fn recent_policy_change_needs_a_prior_hash_inside_the_window() {
        let c = Connection::open_in_memory().unwrap();
        let now = now_ms();
        c.execute_batch(&format!(
            "CREATE TABLE privacy_policy_versions (id TEXT, app_id TEXT, content_hash TEXT, first_fetched_at INTEGER, last_fetched_at INTEGER, policy_url TEXT, source_final_url TEXT, source_title TEXT, source_content_type TEXT, source_origin TEXT, source_word_count INTEGER, source_text TEXT, archive_url TEXT, archive_submitted_at INTEGER);
             INSERT INTO privacy_policy_versions (id, app_id, content_hash, first_fetched_at, last_fetched_at) VALUES
               ('v2','a','h2',{now},{now}), ('v1','a','h1',{now}-1000,{now}-1000),
               ('same','b','h','{now}','{now}');"
        ))
        .unwrap();
        let r = get_recent_policy_change(&c, "a", 90).unwrap().unwrap();
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            format!(r#"{{"currentVersionId":"v2","previousVersionId":"v1","changedAt":{now}}}"#)
        );
        assert!(
            get_recent_policy_change(&c, "a", 0).unwrap().is_none(),
            "window 0 → null"
        );
        assert!(
            get_recent_policy_change(&c, "b", 90).unwrap().is_none(),
            "no prior hash → null"
        );
        assert!(get_recent_policy_change(&c, "zzz", 90).unwrap().is_none());
    }
}

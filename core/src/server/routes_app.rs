//! `GET /api/apps/{id}/since-install` — the first per-app route, and the
//! first one whose body is computed rather than read.
//!
//! Ports `getSinceInstallDiff` from `lib/changelog.ts` on top of
//! `diff::diff_snapshots`. The interesting part is not the diff (that lives
//! next door) but the endpoint selection and the pile of JavaScript
//! coercions between the SQLite rows and the JSON: `Number(x) || 0`,
//! truthiness on `snapshot_json`, `===` against the string `"wayback"`, and
//! `?? null`. Each one is a place where the obvious Rust is a different
//! answer.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Response,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

use super::changelog::{get_changelog_page, ChangelogRow};
use super::diff::{diff_snapshots, ChangeEntry, TypeSnapshot};
use super::json::{json_error, json_ok};
use super::now_ms;
use super::row::column;
use super::trend::{compute_category_trend, compute_quarterly_changes};
use super::AppState;
use crate::jsnum::{js_number, js_parse_int, js_to_number};

/// JavaScript truthiness — `if (!latest?.snapshot_json)`.
///
/// The SQL already filters `snapshot_json IS NOT NULL`, so the only value
/// this actually rejects is the EMPTY STRING. That is not a hypothetical
/// distinction: an empty-string baseline falls through to the approximate
/// fallback *and sets `baselineIsApprox`*, while an empty-string latest
/// makes the whole response `null`.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        // Arrays and objects are always truthy in JS, including `[]` and `{}`.
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `===` between two column values. Only the Number/Number case needs care:
/// serde_json's own `PartialEq` distinguishes the integer 1 from the float
/// 1.0, where JavaScript's `===` does not.
fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
        _ => a == b,
    }
}

/// The four columns every endpoint pick reads.
struct EndpointRow {
    scraped_at: Value,
    snapshot_json: Value,
    source: Value,
    app_version: Value,
}

fn endpoint_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EndpointRow> {
    Ok(EndpointRow {
        scraped_at: column(row, "scraped_at")?,
        snapshot_json: column(row, "snapshot_json")?,
        source: column(row, "source")?,
        app_version: column(row, "app_version")?,
    })
}

/// Field order is the RETURN OBJECT LITERAL's, not the declaration order of
/// the `SinceInstallDiff` interface in `lib/changelog-types.ts`. Those two
/// disagree — the interface is alphabetised — and it is the literal that
/// reaches the wire.
#[derive(Serialize)]
struct SinceInstallDiff {
    #[serde(rename = "firstSeen")]
    first_seen: Value,
    #[serde(rename = "baselineDate")]
    baseline_date: Value,
    #[serde(rename = "baselineSource")]
    baseline_source: &'static str,
    #[serde(rename = "baselineVersion")]
    baseline_version: Value,
    #[serde(rename = "baselineIsApprox")]
    baseline_is_approx: bool,
    #[serde(rename = "isSingleSnapshot")]
    is_single_snapshot: bool,
    #[serde(rename = "latestDate")]
    latest_date: Value,
    #[serde(rename = "latestVersion")]
    latest_version: Value,
    changes: Vec<ChangeEntry>,
    #[serde(rename = "addedCount")]
    added_count: i64,
    #[serde(rename = "removedCount")]
    removed_count: i64,
}

#[derive(Serialize)]
struct SinceInstallBody {
    #[serde(rename = "appId")]
    app_id: String,
    // Present-null: the route always emits the key, `null` when the app has
    // no usable snapshot, so the client can render nothing without probing.
    #[serde(rename = "sinceInstall")]
    since_install: Option<SinceInstallDiff>,
}

const ENDPOINT_COLUMNS: &str = "scraped_at, snapshot_json, source, app_version";

/// Port of `getSinceInstallDiff`. `Ok(None)` is Node's `null` return;
/// `Err` is reserved for a genuine database failure, which Node would let
/// propagate into a 500.
fn since_install_diff(
    conn: &rusqlite::Connection,
    app_id: &str,
) -> rusqlite::Result<Option<SinceInstallDiff>> {
    // `.optional()` rather than `.ok()` throughout: `.ok()` folds
    // SQLITE_BUSY, SQLITE_CORRUPT and every other real failure into "no
    // rows", which is indistinguishable from an empty table. Node wraps none
    // of these queries, so a database error there propagates and the route
    // answers 500 — swallowing it here would turn an unavailable database
    // into a cheerful `"sinceInstall": null` and a client could not tell the
    // two apart.
    let first_seen_raw: Option<Value> = conn
        .query_row("SELECT firstSeen FROM apps WHERE id = ?", [app_id], |row| {
            column(row, "firstSeen")
        })
        .optional()?;
    let Some(first_seen_raw) = first_seen_raw else {
        return Ok(None);
    };
    // `Number(appRow.firstSeen) || 0` — NaN, null, "" and 0 all collapse to
    // 0, and the result is NOT necessarily an integer.
    let first_seen = match js_to_number(&first_seen_raw) {
        n if n.is_nan() || n == 0.0 => 0.0,
        n => n,
    };

    let latest = conn
        .query_row(
            &format!(
                "SELECT {ENDPOINT_COLUMNS} \
                   FROM privacy_snapshots \
                  WHERE app_id = ? AND snapshot_json IS NOT NULL \
                  ORDER BY scraped_at DESC \
                  LIMIT 1"
            ),
            [app_id],
            endpoint_row,
        )
        .optional()?;
    let Some(latest) = latest.filter(|r| truthy(&r.snapshot_json)) else {
        return Ok(None);
    };

    // Baseline = newest snapshot at-or-before the user's first-seen date.
    let baseline = conn
        .query_row(
            &format!(
                "SELECT {ENDPOINT_COLUMNS} \
                   FROM privacy_snapshots \
                  WHERE app_id = ? AND snapshot_json IS NOT NULL AND scraped_at <= ? \
                  ORDER BY scraped_at DESC \
                  LIMIT 1"
            ),
            rusqlite::params![app_id, bind_number(first_seen)],
            endpoint_row,
        )
        .optional()?
        .filter(|r| truthy(&r.snapshot_json));

    let mut baseline_is_approx = false;
    let baseline = match baseline {
        Some(row) => row,
        None => {
            // Nothing usable at-or-before install — fall back to the earliest
            // snapshot and flag the comparison as approximate. Note the flag
            // is set even when the fallback returns the very row the primary
            // query would have, because Node sets it before re-querying.
            baseline_is_approx = true;
            let earliest = conn
                .query_row(
                    &format!(
                        "SELECT {ENDPOINT_COLUMNS} \
                           FROM privacy_snapshots \
                          WHERE app_id = ? AND snapshot_json IS NOT NULL \
                          ORDER BY scraped_at ASC \
                          LIMIT 1"
                    ),
                    [app_id],
                    endpoint_row,
                )
                .optional()?;
            match earliest.filter(|r| truthy(&r.snapshot_json)) {
                Some(row) => row,
                None => return Ok(None),
            }
        }
    };

    // A blob that is not valid JSON makes the whole response null.
    let (Some(baseline_snap), Some(latest_snap)) = (
        parse_snapshot(&baseline.snapshot_json),
        parse_snapshot(&latest.snapshot_json),
    ) else {
        return Ok(None);
    };

    // Same TIMESTAMP on both ends — not the same row id. Two distinct rows
    // sharing a scraped_at therefore read as a single snapshot and diff to
    // nothing, which is Node's behaviour and not obviously desirable.
    let is_single_snapshot = strict_eq(&baseline.scraped_at, &latest.scraped_at);
    let changes = if is_single_snapshot {
        Vec::new()
    } else {
        diff_snapshots(&baseline_snap, &latest_snap)
    };

    let mut added_count = 0i64;
    let mut removed_count = 0i64;
    for change in &changes {
        if change.kind == "added" {
            added_count += 1;
        } else if change.kind == "removed" {
            removed_count += 1;
        }
    }

    Ok(Some(SinceInstallDiff {
        first_seen: js_number(first_seen),
        baseline_date: baseline.scraped_at,
        // Strict equality against the literal string: anything else,
        // including NULL, reads as "live".
        baseline_source: if baseline.source == *"wayback" {
            "wayback"
        } else {
            "live"
        },
        baseline_version: baseline.app_version,
        baseline_is_approx,
        is_single_snapshot,
        latest_date: latest.scraped_at,
        latest_version: latest.app_version,
        changes,
        added_count,
        removed_count,
    }))
}

/// better-sqlite3 binds a JS number as INTEGER when it is integral and as
/// REAL otherwise. `firstSeen` is written as an integer by every code path,
/// but `Number()` above can yield a fraction from a text column.
fn bind_number(f: f64) -> SqlValue {
    if f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
        SqlValue::Integer(f as i64)
    } else {
        SqlValue::Real(f)
    }
}

/// `JSON.parse`, returning `None` where Node's `try` block catches.
///
/// Node's catch covers ONLY the parse. A blob that is valid JSON but not an
/// array — `{}`, `"x"`, `null` — parses fine there and then throws a
/// TypeError inside `diffSnapshots`, which nothing catches, so the route
/// answers 500. Rather than reproduce an uncaught crash, this treats a
/// non-array as unusable and returns null. The divergence is unreachable:
/// every writer of `snapshot_json` goes through `saveSnapshot`, which always
/// stores an array.
fn parse_snapshot(value: &Value) -> Option<Vec<TypeSnapshot>> {
    let text = value.as_str()?;
    serde_json::from_str::<Vec<TypeSnapshot>>(text).ok()
}

pub async fn since_install(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // Node guards `if (!id)`. Axum will not route an empty path segment
    // here, so this is unreachable over HTTP on both sides — kept because
    // the two backends should refuse the same things for the same reasons.
    if id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Missing id");
    }

    let conn = state.conn.lock().expect("db mutex poisoned");

    // A SEPARATE existence check from the one inside the diff. It is what
    // separates "unknown app" (404) from "known app with no usable
    // snapshot" (200 with a null body).
    // `.is_ok()` here would answer 404 "App not found" for a database that
    // is merely locked — a wrong and quite convincing answer.
    let exists = match conn
        .query_row("SELECT 1 FROM apps WHERE id = ?", [&id], |_| Ok(()))
        .optional()
    {
        Ok(found) => found.is_some(),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    };
    if !exists {
        return json_error(StatusCode::NOT_FOUND, "App not found");
    }

    match since_install_diff(&conn, &id) {
        Ok(since_install) => json_ok(&SinceInstallBody {
            app_id: id,
            since_install,
        }),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

// ── GET /api/apps/{id}/history-stats ─────────────────────────────────

#[derive(serde::Serialize)]
struct HistoryStatsBody {
    #[serde(rename = "appId")]
    app_id: String,
    #[serde(rename = "categoryTrend")]
    category_trend: super::trend::CategoryTrendResult,
    quarterly: Vec<super::trend::QuarterlyChangePoint>,
}

/// The aggregates behind the widgets under the per-app timeline.
///
/// Same guard chain as `since_install` — and the same deliberate split
/// between them: an unknown app is a 404, while a known app with no
/// snapshots is a 200 whose buckets are all zero.
///
/// The bucket list runs from Q1 2021 through the quarter containing NOW, so
/// the response depends on the wall clock. Both backends are called within
/// milliseconds of each other, so they only disagree if a run straddles a
/// quarter boundary — three times a year, at midnight UTC.
pub async fn history_stats(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Missing id");
    }

    let conn = state.conn.lock().expect("db mutex poisoned");

    let exists = match conn
        .query_row("SELECT 1 FROM apps WHERE id = ?", [&id], |_| Ok(()))
        .optional()
    {
        Ok(found) => found.is_some(),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    };
    if !exists {
        return json_error(StatusCode::NOT_FOUND, "App not found");
    }

    let now = now_ms();
    // Node calls `new Date()` separately inside each compute function. Using
    // ONE instant for both is the safer reading: a request that crossed a
    // quarter boundary between the two calls would otherwise return a
    // `categoryTrend` with a different bucket count from `quarterly`, which
    // the UI indexes into in lockstep.
    let computed = compute_category_trend(&conn, &id, now)
        .and_then(|trend| Ok((trend, compute_quarterly_changes(&conn, &id, now)?)));

    match computed {
        Ok((category_trend, quarterly)) => json_ok(&HistoryStatsBody {
            app_id: id,
            category_trend,
            quarterly,
        }),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

// ── GET /api/apps/{id}/changelog ─────────────────────────────────────

const CHANGELOG_DEFAULT_LIMIT: i64 = 50;
const CHANGELOG_MAX_LIMIT: i64 = 200;

#[derive(serde::Serialize)]
struct ChangelogBody {
    #[serde(rename = "appId")]
    app_id: String,
    // `{ appId: id, ...page }` — the spread puts rows then hasMore after it.
    rows: Vec<ChangelogRow>,
    #[serde(rename = "hasMore")]
    has_more: bool,
}

/// Older pages of the History tab.
///
/// The two query parameters are validated by DIFFERENT functions, and the
/// difference is observable:
///
/// * `before` goes through `Number(raw)`, which is all-or-nothing — but
///   `Number("")` is 0, so an EMPTY `?before=` is present, valid, and means
///   "strictly before the epoch" (an empty page). `Number.parseInt` would
///   have rejected it.
/// * `limit` goes through `Number.parseInt(raw, 10)`, which IS
///   prefix-tolerant — `?limit=25abc` is 25 — but an empty `?limit=` is NaN
///   and 400s.
///
/// Both are checked for PRESENCE (`!== null`), not truthiness, so supplying
/// either one empty behaves differently from omitting it.
pub async fn app_changelog(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Missing id");
    }

    let conn = state.conn.lock().expect("db mutex poisoned");

    let exists = match conn
        .query_row("SELECT 1 FROM apps WHERE id = ?", [&id], |_| Ok(()))
        .optional()
    {
        Ok(found) => found.is_some(),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    };
    if !exists {
        return json_error(StatusCode::NOT_FOUND, "App not found");
    }

    let mut before_ms: Option<f64> = None;
    if let Some(raw) = q.get("before") {
        let parsed = js_to_number(&Value::from(raw.as_str()));
        if !parsed.is_finite() || parsed < 0.0 {
            return json_error(
                StatusCode::BAD_REQUEST,
                "`before` must be a non-negative epoch-ms number",
            );
        }
        before_ms = Some(parsed);
    }

    let mut limit = CHANGELOG_DEFAULT_LIMIT;
    if let Some(raw) = q.get("limit") {
        match js_parse_int(raw) {
            Some(parsed) if (1..=CHANGELOG_MAX_LIMIT).contains(&parsed) => limit = parsed,
            _ => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    &format!("`limit` must be an integer between 1 and {CHANGELOG_MAX_LIMIT}"),
                );
            }
        }
    }

    match get_changelog_page(&conn, &id, limit, before_ms) {
        Ok((rows, has_more)) => json_ok(&ChangelogBody {
            app_id: id,
            rows,
            has_more,
        }),
        // getChangelog parses changes_summary without a try/catch, so a
        // malformed blob is a 500 there too — with a zero-byte body rather
        // than this envelope. See core/src/server/changelog.rs.
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthiness_matches_javascript() {
        assert!(!truthy(&Value::Null));
        // The case the SQL cannot filter: present but empty.
        assert!(!truthy(&Value::from("")));
        assert!(truthy(&Value::from("[]")));
        assert!(!truthy(&Value::from(0)));
        assert!(truthy(&Value::from(1)));
        // Empty containers are truthy in JS, unlike in most other languages.
        assert!(truthy(&serde_json::json!([])));
        assert!(truthy(&serde_json::json!({})));
    }

    #[test]
    fn strict_equality_ignores_the_integer_float_distinction() {
        assert!(strict_eq(&Value::from(5), &js_number(5.0)));
        assert!(!strict_eq(&Value::from(5), &Value::from("5")));
        assert!(!strict_eq(&Value::Null, &Value::from(0)));
    }

    #[test]
    fn a_non_array_snapshot_blob_is_unusable() {
        assert!(parse_snapshot(&Value::from("[]")).is_some());
        assert!(parse_snapshot(&Value::from("{}")).is_none());
        assert!(parse_snapshot(&Value::from("null")).is_none());
        assert!(parse_snapshot(&Value::from("not json")).is_none());
        assert!(parse_snapshot(&Value::Null).is_none());
    }

    #[test]
    fn baseline_source_is_live_for_anything_but_the_exact_string() {
        for raw in [
            Value::Null,
            Value::from("live"),
            Value::from("Wayback"),
            Value::from(1),
        ] {
            assert_ne!(raw, Value::from("wayback"), "guard: {raw} must not match");
        }
        assert_eq!(Value::from("wayback"), Value::from("wayback"));
    }

    #[test]
    fn a_number_binds_as_an_integer_when_it_is_integral() {
        assert!(matches!(bind_number(0.0), SqlValue::Integer(0)));
        assert!(matches!(
            bind_number(1_787_843_602_839.0),
            SqlValue::Integer(1_787_843_602_839)
        ));
        assert!(matches!(bind_number(1.9), SqlValue::Real(_)));
    }
}

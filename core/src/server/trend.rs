//! Port of `computeCategoryTrend` and `computeQuarterlyChanges` from
//! `lib/historical-import.ts` — the quarterly aggregates behind
//! `/api/apps/{id}/history-stats`.
//!
//! Pure apart from one SQL read, and deliberately kept separate from the
//! handler so the bucketing can be unit-tested against a FIXED `today`.
//! That matters more than usual here: the parity differ masks every number
//! above 1.4e12 as `~epoch`, and every bucket boundary in this response is
//! an epoch in that range — so the differ compares the `label` strings and
//! the counts, and is blind to `startMs`/`endMs` entirely. A port with the
//! quarter boundaries an hour or a month out would pass the gate.
//!
//! Two things the Node code does that look like bugs and are not:
//!
//! 1. The first bucket starts on 1 JANUARY 2021, not on the documented
//!    floor of 1 February. `bucketByQuarter` floors the floor's month to
//!    its quarter (`Math.floor(1 / 3) === 0` → Q1), and Q1 begins in
//!    January. Anchoring on the floor date itself shifts every boundary.
//! 2. `computeQuarterlyChanges` tests `changes_detected !== 1`, a STRICT
//!    comparison, so a row storing 2 is skipped. `computeCategoryTrend`
//!    does not look at the column at all and counts such a row's entries.
//!    The two functions genuinely disagree about what a change is.
//!
//! ## One knowing divergence
//!
//! A `changes_summary` that is valid JSON but NOT an array — `{}` — makes
//! `computeCategoryTrend` throw, and the route answers 500. Its try/catch
//! wraps only the `JSON.parse`; the `for (const change of parsed)` that
//! follows sits outside it, and `for…of` over a plain object is a
//! TypeError. (`computeQuarterlyChanges` keeps its `.filter` inside the
//! try, so the same row is merely skipped there — the two functions do not
//! even agree on this.) Verified against the running Node server: a row
//! holding `{}` returns HTTP 500.
//!
//! Here `entries()` deserialises into `Vec<Value>`, which fails on a
//! non-array, so the row contributes nothing and the request succeeds.
//! Rust answers 200 where Node answers 500. The same trade as in
//! `diff.rs`: reproducing an uncaught crash faithfully would mean
//! reproducing Next's error page, and the alternative to refusing is
//! inventing an answer. Unreachable from data this application writes —
//! `saveSnapshot` always stores an array — and deliberately NOT added to
//! the parity fixture, because a fixture row for it would fail the gate by
//! design rather than catch a regression.

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

/// 1 Feb 2021 — `APP_STORE_HISTORICAL_FLOOR`, aliased `APP_STORE_WEB_LAUNCH`.
/// Only its YEAR and QUARTER are ever read; see the note above.
const FLOOR_YEAR: i64 = 2021;
const FLOOR_MONTH0: i64 = 1; // February, zero-based as in JavaScript.

/// One row of the aggregation read.
struct AggregationRow {
    scraped_at: i64,
    changes_detected: i64,
    changes_summary: Option<String>,
}

/// Field order is the object literal's: `startMs, endMs, label, added,
/// removed`. The `CategoryTrendBucket` interface declares them
/// alphabetically, which is a different order and is not what ships.
#[derive(Debug, Serialize)]
pub struct CategoryTrendBucket {
    #[serde(rename = "startMs")]
    start_ms: i64,
    #[serde(rename = "endMs")]
    end_ms: i64,
    label: String,
    added: i64,
    removed: i64,
}

#[derive(Debug, Serialize)]
pub struct CategoryTrendResult {
    #[serde(rename = "totalAdded")]
    total_added: i64,
    #[serde(rename = "totalRemoved")]
    total_removed: i64,
    #[serde(rename = "netChange")]
    net_change: i64,
    buckets: Vec<CategoryTrendBucket>,
}

#[derive(Debug, Serialize)]
pub struct QuarterlyChangePoint {
    #[serde(rename = "startMs")]
    start_ms: i64,
    #[serde(rename = "endMs")]
    end_ms: i64,
    label: String,
    #[serde(rename = "changeEvents")]
    change_events: i64,
    #[serde(rename = "changeEntries")]
    change_entries: i64,
}

/// `Date.UTC(year, month0, 1)` in epoch milliseconds.
///
/// Howard Hinnant's days-from-civil, which is exact for the whole
/// proleptic Gregorian calendar — no leap-year table and no dependency.
fn utc_month_start_ms(year: i64, month0: i64) -> i64 {
    // Normalise a month index outside 0..=11 the way Date.UTC does.
    let year = year + month0.div_euclid(12);
    let month0 = month0.rem_euclid(12);
    let m = month0 + 1; // 1..=12
    let y = if m <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // March = 0
    let doy = (153 * mp + 2) / 5; // day-of-year for the 1st
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    let days = era * 146_097 + doe - 719_468; // days since 1970-01-01
    days * 86_400_000
}

/// The UTC year and zero-based month containing an epoch-ms instant —
/// `getUTCFullYear()` / `getUTCMonth()`, which is all `bucketByQuarter`
/// reads off `today`.
fn utc_year_month(ms: i64) -> (i64, i64) {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // 1..=12
    let year = if m <= 2 { y + 1 } else { y };
    (year, m - 1)
}

struct QuarterBucket {
    start_ms: i64,
    end_ms: i64,
    label: String,
}

/// Calendar quarters from the floor's quarter through the quarter
/// containing `today`, inclusive. Empty quarters are still emitted so the
/// sparkline keeps a continuous x-axis.
fn bucket_by_quarter(today_ms: i64) -> Vec<QuarterBucket> {
    let start_year = FLOOR_YEAR;
    // Math.floor(month / 3) — February floors to Q1, whose first day is
    // 1 January. The floor date's own day-of-month never enters into it.
    let start_quarter = FLOOR_MONTH0.div_euclid(3);
    let (end_year, end_month0) = utc_year_month(today_ms);
    let end_quarter = end_month0.div_euclid(3);

    let mut buckets = Vec::new();
    let (mut y, mut q) = (start_year, start_quarter);
    while y < end_year || (y == end_year && q <= end_quarter) {
        buckets.push(QuarterBucket {
            start_ms: utc_month_start_ms(y, q * 3),
            end_ms: utc_month_start_ms(if q == 3 { y + 1 } else { y }, ((q + 1) % 4) * 3),
            label: format!("Q{} {}", q + 1, y),
        });
        q += 1;
        if q > 3 {
            q = 0;
            y += 1;
        }
    }
    buckets
}

/// `(change.category ?? "privacy-label") === "privacy-label"`.
///
/// Privacy-label diffs are the untagged default; `privacy-policy`,
/// `accessibility`, `age-rating` and `wayback-attempt` entries share the
/// table and must not feed these aggregates. `??` means an explicit JSON
/// `null` counts as untagged, where `||` would also have swallowed `""`.
fn is_privacy_label_entry(entry: &Value) -> bool {
    match entry.get("category") {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s == "privacy-label",
        // A non-string category is not the string "privacy-label".
        Some(_) => false,
    }
}

/// Parse `changes_summary`, treating anything unusable as no entries.
///
/// Both Node functions catch a parse FAILURE and fall back to `[]`. Neither
/// catches valid-JSON-but-not-an-array: see the module note — that case
/// throws out of `computeCategoryTrend` and 500s, where this returns empty.
fn entries(summary: Option<&String>) -> Vec<Value> {
    summary
        .and_then(|s| serde_json::from_str::<Vec<Value>>(s).ok())
        .unwrap_or_default()
}

fn load_aggregation_rows(conn: &Connection, app_id: &str) -> rusqlite::Result<Vec<AggregationRow>> {
    let mut stmt = conn.prepare(
        "SELECT scraped_at, changes_detected, changes_summary, source \
           FROM privacy_snapshots \
          WHERE app_id = ? \
          ORDER BY scraped_at ASC",
    )?;
    let rows = stmt.query_map([app_id], |row| {
        Ok(AggregationRow {
            scraped_at: row.get("scraped_at")?,
            // Stored INTEGER NOT NULL, but a legacy row could hold anything;
            // a non-integer simply fails the `=== 1` test below, as in JS.
            changes_detected: row.get::<_, Option<i64>>("changes_detected")?.unwrap_or(-1),
            changes_summary: row.get("changes_summary")?,
        })
    })?;
    rows.collect()
}

/// Which bucket a row falls in: the FIRST whose `[startMs, endMs)` contains
/// it. `Array.prototype.find` returns undefined for a row outside every
/// bucket — older than Q1 2021, or dated in the future — and such a row is
/// silently dropped from both aggregates rather than clamped.
fn bucket_index(buckets: &[QuarterBucket], scraped_at: i64) -> Option<usize> {
    buckets
        .iter()
        .position(|b| scraped_at >= b.start_ms && scraped_at < b.end_ms)
}

pub fn compute_category_trend(
    conn: &Connection,
    app_id: &str,
    today_ms: i64,
) -> rusqlite::Result<CategoryTrendResult> {
    let rows = load_aggregation_rows(conn, app_id)?;
    let buckets = bucket_by_quarter(today_ms);

    let mut added = vec![0i64; buckets.len()];
    let mut removed = vec![0i64; buckets.len()];
    for row in &rows {
        let Some(i) = bucket_index(&buckets, row.scraped_at) else {
            continue;
        };
        // Note: `changes_detected` is NOT consulted here, unlike in
        // compute_quarterly_changes. A row flagged as having no changes but
        // carrying entries still contributes to this total.
        for entry in entries(row.changes_summary.as_ref()) {
            if !is_privacy_label_entry(&entry) {
                continue;
            }
            match entry.get("type").and_then(Value::as_str) {
                Some("added") => added[i] += 1,
                Some("removed") => removed[i] += 1,
                _ => {}
            }
        }
    }

    let total_added: i64 = added.iter().sum();
    let total_removed: i64 = removed.iter().sum();
    Ok(CategoryTrendResult {
        total_added,
        total_removed,
        net_change: total_added - total_removed,
        buckets: buckets
            .into_iter()
            .enumerate()
            .map(|(i, b)| CategoryTrendBucket {
                start_ms: b.start_ms,
                end_ms: b.end_ms,
                label: b.label,
                added: added[i],
                removed: removed[i],
            })
            .collect(),
    })
}

pub fn compute_quarterly_changes(
    conn: &Connection,
    app_id: &str,
    today_ms: i64,
) -> rusqlite::Result<Vec<QuarterlyChangePoint>> {
    let rows = load_aggregation_rows(conn, app_id)?;
    let buckets = bucket_by_quarter(today_ms);

    let mut events = vec![0i64; buckets.len()];
    let mut entry_counts = vec![0i64; buckets.len()];
    for row in &rows {
        // STRICT `!== 1`: a row storing 2 is skipped here while
        // compute_category_trend counts it.
        if row.changes_detected != 1 || row.changes_summary.is_none() {
            continue;
        }
        let Some(i) = bucket_index(&buckets, row.scraped_at) else {
            continue;
        };
        let label_entries = entries(row.changes_summary.as_ref())
            .iter()
            .filter(|e| is_privacy_label_entry(e))
            .count() as i64;
        // A row whose entries are all policy/accessibility is not an event.
        if label_entries > 0 {
            events[i] += 1;
            entry_counts[i] += label_entries;
        }
    }

    Ok(buckets
        .into_iter()
        .enumerate()
        .map(|(i, b)| QuarterlyChangePoint {
            start_ms: b.start_ms,
            end_ms: b.end_ms,
            label: b.label,
            change_events: events[i],
            change_entries: entry_counts[i],
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Date.UTC(y, m0, 1)` values, read out of `node -e` rather than
    /// computed by the same algorithm under test — a self-derived constant
    /// would make this test agree with any bug it shares.
    #[test]
    fn utc_month_start_matches_date_utc() {
        assert_eq!(utc_month_start_ms(1970, 0), 0);
        assert_eq!(utc_month_start_ms(2021, 0), 1_609_459_200_000);
        assert_eq!(utc_month_start_ms(2021, 1), 1_612_137_600_000);
        assert_eq!(utc_month_start_ms(2021, 3), 1_617_235_200_000);
        assert_eq!(utc_month_start_ms(2024, 1), 1_706_745_600_000); // leap year
        assert_eq!(utc_month_start_ms(2026, 9), 1_790_812_800_000);
        // Date.UTC rolls a month index of 12 into the next January.
        assert_eq!(utc_month_start_ms(2021, 12), utc_month_start_ms(2022, 0));
    }

    #[test]
    fn utc_year_month_round_trips() {
        for (y, m) in [(1970, 0), (2021, 1), (2024, 1), (2026, 8), (1999, 11)] {
            let ms = utc_month_start_ms(y, m);
            assert_eq!(utc_year_month(ms), (y, m), "round trip for {y}-{m}");
            // Last instant of that month still reports the same month.
            let next = utc_month_start_ms(y, m + 1);
            assert_eq!(utc_year_month(next - 1), (y, m));
        }
    }

    #[test]
    fn the_first_bucket_starts_in_january_not_february() {
        // The documented floor is 1 Feb 2021, but the code floors its month
        // to the quarter — so Q1 2021 begins on 1 January. Anchoring on the
        // floor date itself would shift every boundary by a month.
        let buckets = bucket_by_quarter(utc_month_start_ms(2021, 1));
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].label, "Q1 2021");
        assert_eq!(buckets[0].start_ms, utc_month_start_ms(2021, 0));
        assert_eq!(buckets[0].end_ms, utc_month_start_ms(2021, 3));
    }

    #[test]
    fn buckets_run_through_the_quarter_containing_today() {
        // Through Q4 2021 → four buckets; the year rolls over correctly.
        let buckets = bucket_by_quarter(utc_month_start_ms(2021, 11));
        let labels: Vec<&str> = buckets.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, vec!["Q1 2021", "Q2 2021", "Q3 2021", "Q4 2021"]);
        assert_eq!(buckets[3].end_ms, utc_month_start_ms(2022, 0));

        let across = bucket_by_quarter(utc_month_start_ms(2022, 0));
        assert_eq!(across.len(), 5);
        assert_eq!(across[4].label, "Q1 2022");
    }

    #[test]
    fn a_row_outside_every_bucket_is_dropped_not_clamped() {
        let buckets = bucket_by_quarter(utc_month_start_ms(2021, 5));
        // 2020 predates the first bucket.
        assert_eq!(bucket_index(&buckets, utc_month_start_ms(2020, 5)), None);
        // A future row past the last bucket's end is dropped too.
        assert_eq!(bucket_index(&buckets, utc_month_start_ms(2030, 0)), None);
        assert_eq!(bucket_index(&buckets, utc_month_start_ms(2021, 4)), Some(1));
        // The boundary is half-open: a row exactly on endMs lands in the NEXT
        // bucket, not this one.
        assert_eq!(bucket_index(&buckets, buckets[0].end_ms), Some(1));
    }

    #[test]
    fn untagged_entries_are_privacy_labels_and_tagged_ones_are_not() {
        let e = |v: serde_json::Value| v;
        assert!(is_privacy_label_entry(&e(
            serde_json::json!({"type": "added"})
        )));
        assert!(is_privacy_label_entry(&e(
            serde_json::json!({"category": null, "type": "added"})
        )));
        assert!(is_privacy_label_entry(&e(
            serde_json::json!({"category": "privacy-label"})
        )));
        for other in [
            "privacy-policy",
            "accessibility",
            "age-rating",
            "wayback-attempt",
        ] {
            assert!(!is_privacy_label_entry(&e(
                serde_json::json!({ "category": other })
            )));
        }
    }

    #[test]
    fn malformed_changes_summary_yields_no_entries() {
        assert!(entries(None).is_empty());
        assert!(entries(Some(&"not json".to_string())).is_empty());
        // Valid JSON that is not an array. Node reaches `for…of` on it and
        // throws a TypeError the route does not catch, answering 500; this
        // treats it as empty and answers 200. Documented in the module note
        // — pinned here so the divergence is a decision, not a surprise.
        assert!(entries(Some(&"{}".to_string())).is_empty());
        assert_eq!(entries(Some(&r#"[{"type":"added"}]"#.to_string())).len(), 1);
    }

    #[test]
    fn serialised_key_order_is_the_object_literals_not_the_interfaces() {
        let bucket = CategoryTrendBucket {
            start_ms: 1,
            end_ms: 2,
            label: "Q1 2021".into(),
            added: 0,
            removed: 0,
        };
        let json = serde_json::to_string(&bucket).unwrap();
        assert!(
            json.starts_with(r#"{"startMs":1,"endMs":2,"label":"Q1 2021","added":0,"removed":0}"#),
            "unexpected key order: {json}"
        );
        let point = QuarterlyChangePoint {
            start_ms: 1,
            end_ms: 2,
            label: "Q1 2021".into(),
            change_events: 0,
            change_entries: 0,
        };
        assert_eq!(
            serde_json::to_string(&point).unwrap(),
            r#"{"startMs":1,"endMs":2,"label":"Q1 2021","changeEvents":0,"changeEntries":0}"#
        );
    }
}

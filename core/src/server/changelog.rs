//! Port of `getChangelog` / `getChangelogPage` and their read-time helpers
//! from `lib/changelog.ts` — the per-app timeline kernel.
//!
//! Worth porting before `/api/apps` or `/api/apps/{id}/detail`, because both
//! of those are this function wearing a hat: `/api/apps?id=X&changelog=true`
//! is literally `getChangelog(id, 50)`, and detail's `changelog` /
//! `changelogHasMore` fields are `getChangelogPage` verbatim. Written once
//! here, it turns two large routes into assembly.
//!
//! Four things decide the bytes, and none of them is obvious:
//!
//! 1. **Two keys are added by MUTATION after the row object is built**, so
//!    they serialise AFTER `app_version_updated_at` rather than wherever an
//!    interface would put them. `archive_bridge` is assigned by
//!    `bridgeOldestLiveRow`, which runs first; `matches_live_sync` by the
//!    loop after it. They are mutually exclusive in practice (one lands on
//!    a live row, the other only on wayback rows), so their relative order
//!    is unobservable — but their position after the fixed keys is not.
//! 2. **The merge is a stable sort**, and the tie-break is only partial:
//!    equal `scraped_at` puts snapshots before reviews, and two rows of the
//!    SAME kind compare equal, so they keep the order the SQL returned
//!    them in. `Vec::sort_by` is stable too, so this survives — but only if
//!    the comparator returns Equal rather than inventing a tiebreak.
//! 3. **Both queries take the SAME `limit`**, and the merged list is sliced
//!    to it afterwards. A page of 50 therefore reads up to 50 snapshots AND
//!    50 reviews and throws away half. Narrowing either query changes which
//!    rows survive the merge.
//! 4. **`changes_summary` is parsed WITHOUT a try/catch** here, unlike
//!    everywhere else in this file. See the divergence note on
//!    `parse_changes_summary`.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use super::diff::{diff_snapshots, TypeSnapshot};
use super::row::column;

/// `{ from_scraped_at, wayback_snapshot_url }`, in that order.
#[derive(Debug, Serialize)]
pub struct ArchiveBridge {
    from_scraped_at: Value,
    wayback_snapshot_url: Value,
}

/// A `kind: "snapshot"` row.
///
/// Field order is the object literal's, with the two mutation-added keys
/// last. Every `Value` field is present-null rather than skipped: the Node
/// literal uses `?? null`, which produces a key holding null, not an absent
/// key.
#[derive(Debug, Serialize)]
pub struct SnapshotRow {
    kind: &'static str,
    id: String,
    scraped_at: Value,
    snapshot_json: Value,
    changes_detected: Value,
    changes_summary: Vec<Value>,
    source: &'static str,
    wayback_snapshot_url: Value,
    /// `normalizeTrigger` returns a trigger or null — present-null, so no
    /// `skip_serializing_if`.
    triggered_by: Option<&'static str>,
    app_version: Value,
    app_version_updated_at: Value,
    /// Assigned by `bridgeOldestLiveRow`; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_bridge: Option<ArchiveBridge>,
    /// Assigned by the neighbour scan; absent otherwise. Never `false` —
    /// Node only ever writes `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    matches_live_sync: Option<bool>,
}

/// A `kind: "review"` row.
#[derive(Debug, Serialize)]
pub struct ReviewRow {
    kind: &'static str,
    /// `review:<uuid>` — prefixed so it cannot collide with a snapshot id.
    id: String,
    /// Populated from `acted_at`, so the two kinds sort on one field.
    scraped_at: Value,
    action: Value,
    covered_count: Value,
    covered_snapshot_ids: Vec<String>,
    snooze_until: Value,
    note: Value,
}

/// The merged timeline row.
///
/// Both variants are boxed so the enum stays pointer-sized rather than the
/// width of its larger arm — a page holds up to 200 of these. `Box<T>`
/// serialises transparently, so the wire shape is unaffected.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ChangelogRow {
    Snapshot(Box<SnapshotRow>),
    Review(Box<ReviewRow>),
}

impl ChangelogRow {
    fn scraped_at(&self) -> &Value {
        match self {
            ChangelogRow::Snapshot(r) => &r.scraped_at,
            ChangelogRow::Review(r) => &r.scraped_at,
        }
    }

    fn is_snapshot(&self) -> bool {
        matches!(self, ChangelogRow::Snapshot(_))
    }
}

/// `normalizeTrigger`: a recognised trigger passes through; anything else
/// falls back to `"wayback"` when the RAW source column says wayback, and to
/// null otherwise.
///
/// Note it tests the raw `source`, not the normalised one — the difference
/// is invisible here because both spell the same string, but a port that
/// passed the already-normalised `"live"` would still be correct only by
/// accident.
fn normalize_trigger(raw: Option<&str>, source: Option<&str>) -> Option<&'static str> {
    match raw {
        Some("scheduled") => return Some("scheduled"),
        Some("manual") => return Some("manual"),
        Some("import") => return Some("import"),
        Some("wayback") => return Some("wayback"),
        Some("sample") => return Some("sample"),
        _ => {}
    }
    if source == Some("wayback") {
        Some("wayback")
    } else {
        None
    }
}

/// `parseCoveredSnapshotIds`: defensive throughout. A falsy column, invalid
/// JSON, or a non-array all give `[]`, and inside a valid array only
/// non-empty strings survive — `null`, numbers and `""` are dropped rather
/// than coerced.
fn parse_covered_snapshot_ids(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|v| match v {
            Value::String(s) if !s.is_empty() => Some(s),
            _ => None,
        })
        .collect()
}

/// `row.changes_summary ? JSON.parse(row.changes_summary) : []`.
///
/// JS TRUTHINESS on the column, so an empty string yields `[]` without the
/// parse ever running — the `IS NOT NULL`-style guard people expect is
/// actually a falsy check, and it catches `""` too.
///
/// ## Divergence
///
/// That `JSON.parse` is NOT wrapped in a try/catch, unlike every other
/// parse in `lib/changelog.ts`. A `changes_summary` holding invalid JSON
/// throws out of `getChangelog` and the route answers 500 with a ZERO-BYTE
/// body — not even the `{"error":…}` envelope, because nothing catches it.
/// Returning `Err` here produces a 500 with the standard envelope instead:
/// same status, different body. Consistent with the choice made in
/// `diff.rs` and `trend.rs` — refuse rather than invent — and unreachable
/// from data this application writes, since `saveSnapshot` always stores
/// `JSON.stringify` of an array.
fn parse_changes_summary(raw: Option<&str>) -> Result<Vec<Value>, ()> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(Vec::new());
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => Ok(items),
        // A non-array parses fine in Node and is spread into the row as-is;
        // it only explodes later, where `.length` is read. Treat it as
        // unusable here for the same reason as above.
        Ok(_) | Err(_) => Err(()),
    }
}

const SNAPSHOT_COLUMNS: &str = "id, scraped_at, snapshot_json, changes_detected, changes_summary, \
     source, wayback_snapshot_url, triggered_by, app_version, app_version_updated_at";

fn load_snapshots(
    conn: &Connection,
    app_id: &str,
    limit: i64,
    before_ms: Option<f64>,
) -> rusqlite::Result<Vec<SnapshotRow>> {
    let where_extra = if before_ms.is_none() {
        ""
    } else {
        " AND scraped_at < ?"
    };
    let sql = format!(
        "SELECT {SNAPSHOT_COLUMNS} \
           FROM privacy_snapshots \
          WHERE app_id = ?{where_extra} \
          ORDER BY scraped_at DESC \
          LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;

    let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<SnapshotRow> {
        let raw_source: Option<String> = row.get("source")?;
        let raw_trigger: Option<String> = row.get("triggered_by")?;
        let raw_summary: Option<String> = row.get("changes_summary")?;
        Ok(SnapshotRow {
            kind: "snapshot",
            id: row.get("id")?,
            scraped_at: column(row, "scraped_at")?,
            snapshot_json: column(row, "snapshot_json")?,
            changes_detected: column(row, "changes_detected")?,
            // A parse failure has to surface as a rusqlite error so the
            // handler can 500; there is no other channel out of query_map.
            changes_summary: parse_changes_summary(raw_summary.as_deref()).map_err(|()| {
                rusqlite::Error::InvalidColumnType(
                    0,
                    "changes_summary".into(),
                    rusqlite::types::Type::Text,
                )
            })?,
            // NULL and every unrecognised value normalise to "live", so the
            // UI can branch on a guaranteed string.
            source: if raw_source.as_deref() == Some("wayback") {
                "wayback"
            } else {
                "live"
            },
            wayback_snapshot_url: column(row, "wayback_snapshot_url")?,
            triggered_by: normalize_trigger(raw_trigger.as_deref(), raw_source.as_deref()),
            app_version: column(row, "app_version")?,
            app_version_updated_at: column(row, "app_version_updated_at")?,
            archive_bridge: None,
            matches_live_sync: None,
        })
    };

    let rows = match before_ms {
        None => stmt
            .query_map(rusqlite::params![app_id, limit], map)?
            .collect(),
        Some(ms) => stmt
            .query_map(rusqlite::params![app_id, ms, limit], map)?
            .collect(),
    };
    rows
}

fn load_reviews(
    conn: &Connection,
    app_id: &str,
    limit: i64,
    before_ms: Option<f64>,
) -> rusqlite::Result<Vec<ReviewRow>> {
    let where_extra = if before_ms.is_none() {
        ""
    } else {
        " AND acted_at < ?"
    };
    let sql = format!(
        "SELECT id, acted_at, action, covered_count, covered_snapshot_ids, snooze_until, note \
           FROM change_review_actions \
          WHERE app_id = ?{where_extra} \
          ORDER BY acted_at DESC \
          LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;

    let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<ReviewRow> {
        let covered: Option<String> = row.get("covered_snapshot_ids")?;
        Ok(ReviewRow {
            kind: "review",
            id: format!("review:{}", row.get::<_, String>("id")?),
            scraped_at: column(row, "acted_at")?,
            action: column(row, "action")?,
            covered_count: column(row, "covered_count")?,
            covered_snapshot_ids: parse_covered_snapshot_ids(covered.as_deref()),
            snooze_until: column(row, "snooze_until")?,
            note: column(row, "note")?,
        })
    };

    match before_ms {
        None => stmt
            .query_map(rusqlite::params![app_id, limit], map)?
            .collect(),
        Some(ms) => stmt
            .query_map(rusqlite::params![app_id, ms, limit], map)?
            .collect(),
    }
}

/// Derive the last archive → live hop at read time.
///
/// The first live scrape stored an empty diff because nothing preceded it.
/// Once a Wayback import back-fills captures BEFORE it, that hop is the one
/// change the timeline would never show. Node derives it here rather than
/// rewriting the live row, because live rows feed the review queue and
/// imported history must never re-raise "changes to review".
///
/// The qualifying row is found by `MIN(scraped_at)` over
/// `COALESCE(source, 'live') = 'live'` — so a NULL source counts as live in
/// the SQL, matching the normalisation applied to the mapped rows.
fn bridge_oldest_live_row(
    conn: &Connection,
    app_id: &str,
    snapshots: &mut [SnapshotRow],
) -> rusqlite::Result<()> {
    let first_live: Option<Value> = conn
        .query_row(
            "SELECT MIN(scraped_at) AS ms FROM privacy_snapshots \
              WHERE app_id = ? AND COALESCE(source, 'live') = 'live'",
            [app_id],
            |row| column(row, "ms"),
        )
        .optional()?
        .filter(|v| v.is_number());
    // MIN over no rows is NULL, which `typeof … !== "number"` rejects.
    let Some(first_live_ms) = first_live else {
        return Ok(());
    };

    let Some(idx) = snapshots
        .iter()
        .position(|r| r.source == "live" && r.scraped_at == first_live_ms)
    else {
        return Ok(());
    };

    // Only a row that recorded NO changes qualifies: anything else already
    // has a diff the timeline is showing.
    {
        let row = &snapshots[idx];
        // `!== 0` in JS, where there is one number type. `column()` has
        // already collapsed an integral REAL to an integer via `js_number`,
        // so comparing against the integer 0 is the same test.
        if row.changes_detected != 0
            || !row.changes_summary.is_empty()
            || !truthy_str(&row.snapshot_json)
        {
            return Ok(());
        }
    }

    // The row directly BELOW it in the newest-first list — nothing else.
    let Some(older) = snapshots.get(idx + 1) else {
        return Ok(());
    };
    if older.source != "wayback"
        || !truthy_str(&older.snapshot_json)
        || older.snapshot_json == snapshots[idx].snapshot_json
    {
        return Ok(());
    }

    let (Some(previous), Some(current)) = (
        parse_snapshot(&older.snapshot_json),
        parse_snapshot(&snapshots[idx].snapshot_json),
    ) else {
        // Node catches the parse here. (It does NOT catch diffSnapshots
        // throwing on a structurally malformed blob immediately after —
        // see diff.rs, which refuses such a blob rather than panicking.)
        return Ok(());
    };

    let changes = diff_snapshots(&previous, &current);
    if changes.is_empty() {
        return Ok(());
    }

    let from_scraped_at = older.scraped_at.clone();
    let wayback_snapshot_url = older.wayback_snapshot_url.clone();
    let row = &mut snapshots[idx];
    row.changes_summary = changes
        .into_iter()
        .map(|c| serde_json::to_value(c).unwrap_or(Value::Null))
        .collect();
    row.changes_detected = Value::from(1);
    row.archive_bridge = Some(ArchiveBridge {
        from_scraped_at,
        wayback_snapshot_url,
    });
    Ok(())
}

/// `!row.snapshot_json` — truthiness, so null AND the empty string both fail.
fn truthy_str(v: &Value) -> bool {
    match v {
        Value::String(s) => !s.is_empty(),
        Value::Null => false,
        _ => true,
    }
}

fn parse_snapshot(v: &Value) -> Option<Vec<TypeSnapshot>> {
    serde_json::from_str::<Vec<TypeSnapshot>>(v.as_str()?).ok()
}

/// Mark wayback rows whose snapshot content is byte-identical to an adjacent
/// live row, so the UI can show "Matches live sync".
///
/// Both neighbours are checked because a back-dated import lands either just
/// before or just after a live row depending on when it ran. Comparison is
/// over the raw `snapshot_json` STRING — `buildSnapshot` is deterministic,
/// so stringifying twice in the same order is a reliable test.
fn mark_matching_wayback_rows(snapshots: &mut [SnapshotRow]) {
    for i in 0..snapshots.len() {
        if snapshots[i].source != "wayback" || !truthy_str(&snapshots[i].snapshot_json) {
            continue;
        }
        let mine = snapshots[i].snapshot_json.clone();
        let neighbours = [i.checked_sub(1), Some(i + 1)];
        let matched = neighbours.into_iter().flatten().any(|j| {
            snapshots.get(j).is_some_and(|o| {
                o.source == "live" && truthy_str(&o.snapshot_json) && o.snapshot_json == mine
            })
        });
        if matched {
            snapshots[i].matches_live_sync = Some(true);
        }
    }
}

/// Port of `getChangelog`. Newest first, snapshots interleaved with review
/// actions, capped at `limit` AFTER the merge.
pub fn get_changelog(
    conn: &Connection,
    app_id: &str,
    limit: i64,
    before_ms: Option<f64>,
) -> rusqlite::Result<Vec<ChangelogRow>> {
    // `typeof options.beforeMs === "number" && Number.isFinite(...)` — a
    // non-finite value is dropped rather than clamped, so the query runs
    // unfiltered.
    let before_ms = before_ms.filter(|v| v.is_finite());

    let mut snapshots = load_snapshots(conn, app_id, limit, before_ms)?;
    bridge_oldest_live_row(conn, app_id, &mut snapshots)?;
    mark_matching_wayback_rows(&mut snapshots);

    let reviews = load_reviews(conn, app_id, limit, before_ms)?;

    // `[...snapshots, ...reviews]` then a STABLE sort, so rows that compare
    // equal keep this concatenation order.
    let mut merged: Vec<ChangelogRow> = snapshots
        .into_iter()
        .map(|r| ChangelogRow::Snapshot(Box::new(r)))
        .chain(
            reviews
                .into_iter()
                .map(|r| ChangelogRow::Review(Box::new(r))),
        )
        .collect();

    merged.sort_by(|a, b| {
        let (av, bv) = (num(a.scraped_at()), num(b.scraped_at()));
        // `b.scraped_at - a.scraped_at` — descending. A NaN difference (a
        // non-numeric timestamp) is neither < nor > 0, which JS's sort reads
        // as "equal", so the stable order stands.
        match bv.partial_cmp(&av) {
            Some(std::cmp::Ordering::Equal) | None => {
                // Equal timestamps: snapshot before review. Two rows of the
                // SAME kind compare Equal and keep their SQL order.
                match (a.is_snapshot(), b.is_snapshot()) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => std::cmp::Ordering::Equal,
                }
            }
            Some(other) => other,
        }
    });

    merged.truncate(limit.max(0) as usize);
    Ok(merged)
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

/// Port of `getChangelogPage`: fetch one more than asked for, and report
/// whether it came back.
pub fn get_changelog_page(
    conn: &Connection,
    app_id: &str,
    limit: i64,
    before_ms: Option<f64>,
) -> rusqlite::Result<(Vec<ChangelogRow>, bool)> {
    let mut rows = get_changelog(conn, app_id, limit.saturating_add(1), before_ms)?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit.max(0) as usize);
    Ok((rows, has_more))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_normalisation_falls_back_to_the_raw_source() {
        for t in ["scheduled", "manual", "import", "wayback", "sample"] {
            assert_eq!(normalize_trigger(Some(t), None), Some(t));
        }
        // Unrecognised or missing: only a raw source of "wayback" rescues it.
        assert_eq!(normalize_trigger(None, Some("wayback")), Some("wayback"));
        assert_eq!(
            normalize_trigger(Some("bogus"), Some("wayback")),
            Some("wayback")
        );
        assert_eq!(normalize_trigger(None, Some("live")), None);
        assert_eq!(normalize_trigger(None, None), None);
        assert_eq!(
            normalize_trigger(Some("Scheduled"), None),
            None,
            "case-sensitive"
        );
    }

    #[test]
    fn covered_snapshot_ids_drop_everything_that_is_not_a_non_empty_string() {
        assert_eq!(parse_covered_snapshot_ids(None), Vec::<String>::new());
        assert_eq!(parse_covered_snapshot_ids(Some("")), Vec::<String>::new());
        assert_eq!(
            parse_covered_snapshot_ids(Some("not json")),
            Vec::<String>::new()
        );
        // Valid JSON that is not an array.
        assert_eq!(parse_covered_snapshot_ids(Some("{}")), Vec::<String>::new());
        assert_eq!(
            parse_covered_snapshot_ids(Some(r#"["a", "", null, 7, "b"]"#)),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn an_empty_changes_summary_column_is_an_empty_list_not_a_parse_error() {
        // Truthiness: the empty string never reaches JSON.parse.
        assert_eq!(parse_changes_summary(None), Ok(Vec::new()));
        assert_eq!(parse_changes_summary(Some("")), Ok(Vec::new()));
        assert_eq!(parse_changes_summary(Some("[]")), Ok(Vec::new()));
        assert!(parse_changes_summary(Some("[{\"type\":\"added\"}]")).is_ok());
        // Unparseable: Node throws out of the route with a zero-byte 500.
        assert!(parse_changes_summary(Some("not json")).is_err());
        assert!(parse_changes_summary(Some("{}")).is_err());
    }

    #[test]
    fn snapshot_key_order_puts_the_mutated_keys_last() {
        let row = SnapshotRow {
            kind: "snapshot",
            id: "s1".into(),
            scraped_at: Value::from(5),
            snapshot_json: Value::Null,
            changes_detected: Value::from(0),
            changes_summary: Vec::new(),
            source: "live",
            wayback_snapshot_url: Value::Null,
            triggered_by: None,
            app_version: Value::Null,
            app_version_updated_at: Value::Null,
            archive_bridge: None,
            matches_live_sync: None,
        };
        assert_eq!(
            serde_json::to_string(&row).unwrap(),
            r#"{"kind":"snapshot","id":"s1","scraped_at":5,"snapshot_json":null,"changes_detected":0,"changes_summary":[],"source":"live","wayback_snapshot_url":null,"triggered_by":null,"app_version":null,"app_version_updated_at":null}"#,
            "absent optional keys must not appear, and triggered_by must be present-null"
        );

        let bridged = SnapshotRow {
            archive_bridge: Some(ArchiveBridge {
                from_scraped_at: Value::from(1),
                wayback_snapshot_url: Value::Null,
            }),
            matches_live_sync: Some(true),
            ..row
        };
        let json = serde_json::to_string(&bridged).unwrap();
        assert!(
            json.ends_with(
                r#""app_version_updated_at":null,"archive_bridge":{"from_scraped_at":1,"wayback_snapshot_url":null},"matches_live_sync":true}"#
            ),
            "the mutation-added keys must trail the fixed ones: {json}"
        );
    }

    #[test]
    fn review_rows_serialise_without_a_kind_wrapper() {
        let row = ChangelogRow::Review(Box::new(ReviewRow {
            kind: "review",
            id: "review:abc".into(),
            scraped_at: Value::from(9),
            action: Value::from("reviewed"),
            covered_count: Value::from(2),
            covered_snapshot_ids: vec!["s1".into()],
            snooze_until: Value::Null,
            note: Value::Null,
        }));
        // `#[serde(untagged)]` — the enum must be invisible on the wire.
        assert_eq!(
            serde_json::to_string(&row).unwrap(),
            r#"{"kind":"review","id":"review:abc","scraped_at":9,"action":"reviewed","covered_count":2,"covered_snapshot_ids":["s1"],"snooze_until":null,"note":null}"#
        );
    }

    #[test]
    fn truthiness_on_snapshot_json_rejects_null_and_the_empty_string() {
        assert!(!truthy_str(&Value::Null));
        assert!(!truthy_str(&Value::from("")));
        assert!(truthy_str(&Value::from("[]")));
    }
}

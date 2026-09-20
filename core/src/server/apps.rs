//! The `/api/apps` read queries from `lib/scraper.ts`.
//!
//! `getAllApps`, `getAppsPage` and `countApps` are each a single statement,
//! which makes them look mechanical. Two things stop them being so.
//!
//! **`SELECT a.*` is not a fixed column list.** It expands to the table's
//! runtime column order, which differs between a fresh install and one that
//! predates a column — `lib/db.ts` lists several columns in both the
//! `CREATE TABLE` body and the `migrations` array, so an upgraded database
//! has them appended in migration order instead. `row_to_json` reads the
//! order off the statement for exactly this reason; see `row.rs`.
//!
//! **The two list queries order differently, on purpose.** `getAllApps` is
//! `ORDER BY a.name ASC` with no tiebreak; `getAppsPage` adds `, id ASC` so
//! offset paging is deterministic across requests. Apps sharing a name
//! therefore come back in a planner-decided order from the bare endpoint and
//! a defined one from the paged endpoint — and the two backends bundle
//! DIFFERENT SQLite versions (rusqlite 3.46.0, better-sqlite3 3.53.2), so
//! "both run SQLite" is not an argument that the planner agrees. Keeping the
//! SQL byte-identical is what makes it agree in practice; adding a tiebreak
//! to the Rust side alone would guarantee it does not.
//!
//! **Every list read takes the request's device scope** (`?devices=`), and
//! the route passes the unrestricted scope when the param is absent, so a
//! bare request still gets the whole fleet. Export is the exception: it
//! calls [`get_all_apps`], which is never scoped.

use rusqlite::Connection;
use serde_json::Value;

use super::row::{column, row_to_json};

/// The six computed aggregates both list queries append after `a.*`.
const COUNT_COLUMNS: &str = "COALESCE(pc.categoryCount, 0) AS categoryCount,
      COALESCE(pc.trackCount, 0) AS trackCount,
      COALESCE(pc.linkedCount, 0) AS linkedCount,
      COALESCE(pc.unlinkedCount, 0) AS unlinkedCount,
      COALESCE(sc.syncCount, 0) AS syncCount,
      COALESCE(ac.accessibilityCount, 0) AS accessibilityCount";

/// Port of `getAllApps` with no scope: the whole fleet, as export needs it.
pub fn get_all_apps(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    get_all_apps_scoped(conn, &super::scope::Scope::default())
}

pub(super) fn get_all_apps_scoped(
    conn: &Connection,
    scope: &super::scope::Scope,
) -> rusqlite::Result<Vec<Value>> {
    let filter = scope.fragment("WHERE", "a.id");
    let sql = format!(
        "
    WITH privacy_counts AS (
      SELECT
        t.app_id,
        COUNT(c.id) AS categoryCount,
        SUM(CASE WHEN c.id IS NOT NULL AND t.identifier = 'DATA_USED_TO_TRACK_YOU' THEN 1 ELSE 0 END) AS trackCount,
        SUM(CASE WHEN c.id IS NOT NULL AND t.identifier = 'DATA_LINKED_TO_YOU' THEN 1 ELSE 0 END) AS linkedCount,
        SUM(CASE WHEN c.id IS NOT NULL AND t.identifier = 'DATA_NOT_LINKED_TO_YOU' THEN 1 ELSE 0 END) AS unlinkedCount
      FROM privacy_types t
      LEFT JOIN privacy_categories c ON c.type_id = t.id
      GROUP BY t.app_id
    ),
    sync_counts AS (
      SELECT app_id, COUNT(*) AS syncCount
      FROM privacy_snapshots
      GROUP BY app_id
    ),
    accessibility_counts AS (
      SELECT app_id, COUNT(*) AS accessibilityCount
      FROM accessibility_features
      GROUP BY app_id
    )
    SELECT a.*,
      {COUNT_COLUMNS}
    FROM apps a
    LEFT JOIN privacy_counts pc ON pc.app_id = a.id
    LEFT JOIN sync_counts sc ON sc.app_id = a.id
    LEFT JOIN accessibility_counts ac ON ac.app_id = a.id
    {filter}
    ORDER BY a.name ASC
  "
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(scope.params()), row_to_json)?;
    rows.collect()
}

/// Port of `getAppsPage`. Same row shape as `get_all_apps`, with the count
/// CTEs scoped to the page so a 500-row page does 500 apps' worth of
/// aggregation rather than the whole fleet's.
///
/// The device scope goes INSIDE `page_apps`, before `LIMIT`/`OFFSET`, so the
/// offsets page through the scoped set. Filtering the page afterwards would
/// return short or empty pages and break the grid's offset arithmetic.
pub(super) fn get_apps_page(
    conn: &Connection,
    limit: i64,
    offset: i64,
    scope: &super::scope::Scope,
) -> rusqlite::Result<Vec<Value>> {
    let filter = scope.fragment("WHERE", "a.id");
    let sql = format!(
        "
    WITH page_apps AS (
      SELECT a.*
      FROM apps a
      {filter}
      ORDER BY a.name ASC, a.id ASC
      LIMIT ? OFFSET ?
    ),
    privacy_counts AS (
      SELECT
        t.app_id,
        COUNT(c.id) AS categoryCount,
        SUM(CASE WHEN c.id IS NOT NULL AND t.identifier = 'DATA_USED_TO_TRACK_YOU' THEN 1 ELSE 0 END) AS trackCount,
        SUM(CASE WHEN c.id IS NOT NULL AND t.identifier = 'DATA_LINKED_TO_YOU' THEN 1 ELSE 0 END) AS linkedCount,
        SUM(CASE WHEN c.id IS NOT NULL AND t.identifier = 'DATA_NOT_LINKED_TO_YOU' THEN 1 ELSE 0 END) AS unlinkedCount
      FROM privacy_types t
      LEFT JOIN privacy_categories c ON c.type_id = t.id
      WHERE t.app_id IN (SELECT id FROM page_apps)
      GROUP BY t.app_id
    ),
    sync_counts AS (
      SELECT app_id, COUNT(*) AS syncCount
      FROM privacy_snapshots
      WHERE app_id IN (SELECT id FROM page_apps)
      GROUP BY app_id
    ),
    accessibility_counts AS (
      SELECT app_id, COUNT(*) AS accessibilityCount
      FROM accessibility_features
      WHERE app_id IN (SELECT id FROM page_apps)
      GROUP BY app_id
    )
    SELECT a.*,
      {COUNT_COLUMNS}
    FROM page_apps a
    LEFT JOIN privacy_counts pc ON pc.app_id = a.id
    LEFT JOIN sync_counts sc ON sc.app_id = a.id
    LEFT JOIN accessibility_counts ac ON ac.app_id = a.id
    ORDER BY a.name ASC, a.id ASC
  "
    );
    let mut params = scope.params();
    params.push(limit.into());
    params.push(offset.into());
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params), row_to_json)?;
    rows.collect()
}

/// Port of `countApps` — the whole SCOPE, not the page, so the grid's
/// "loaded N of TOTAL" counts the same set the pages come from.
pub(super) fn count_apps(conn: &Connection, scope: &super::scope::Scope) -> rusqlite::Result<i64> {
    conn.query_row(
        &format!(
            "SELECT COUNT(*) AS n FROM apps a{}",
            scope.fragment("WHERE", "a.id")
        ),
        rusqlite::params_from_iter(scope.params()),
        |row| row.get(0),
    )
}

// ── ?id=<app> ────────────────────────────────────────────────────────

/// Port of `getAppWithPrivacy`.
///
/// The app object is `SELECT * FROM apps`, so its key order is the runtime
/// column order (see `row_to_json`) — on the seeded database that puts
/// `privacyPolicyUrl` LAST, because `lib/db.ts` only ever adds it by ALTER.
/// Three keys are then assigned onto it in this order: `privacyTypes`,
/// `policyAnalysis`, `accessibilityFeatures`.
///
/// `privacyTypes[]` and each type's `categories[]` are also `SELECT *`, and
/// `privacy_categories` still has the dead legacy `purpose_id` column, which
/// therefore MUST be emitted (always null). Neither query has an ORDER BY,
/// so both arrays are in planner order — the same order `buildSnapshot`
/// relies on, and the same caveat about the two SQLite versions applies.
///
/// `accessibilityFeatures` is the one explicit projection, with
/// `icon_template AS iconTemplate` and an ORDER BY. An empty array is
/// meaningful there and is emitted as `[]`, never null.
///
/// Returns `Ok(None)` for an unknown id — the route turns that into the
/// 404 — and never for an app that merely has no privacy rows.
pub fn get_app_with_privacy(conn: &Connection, app_id: &str) -> rusqlite::Result<Option<Value>> {
    use rusqlite::OptionalExtension;

    let Some(Value::Object(mut app)) = conn
        .query_row("SELECT * FROM apps WHERE id = ?", [app_id], row_to_json)
        .optional()?
    else {
        return Ok(None);
    };

    let mut types_stmt = conn.prepare("SELECT * FROM privacy_types WHERE app_id = ?")?;
    let mut cats_stmt = conn.prepare("SELECT * FROM privacy_categories WHERE type_id = ?")?;
    let types: Vec<Value> = types_stmt
        .query_map([app_id], |row| {
            Ok((row.get::<_, String>("id")?, row_to_json(row)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|(type_id, mut t)| {
            let cats: Vec<Value> = cats_stmt
                .query_map([&type_id], row_to_json)?
                .collect::<rusqlite::Result<_>>()?;
            // `t.categories = […]` — assigned after the row's own columns.
            if let Value::Object(obj) = &mut t {
                obj.insert("categories".into(), Value::Array(cats));
            }
            Ok(t)
        })
        .collect::<rusqlite::Result<_>>()?;

    let mut a11y_stmt = conn.prepare(
        "SELECT identifier, title, description, icon_template AS iconTemplate            FROM accessibility_features WHERE app_id = ? ORDER BY identifier",
    )?;
    let accessibility: Vec<Value> = a11y_stmt
        .query_map([app_id], row_to_json)?
        .collect::<rusqlite::Result<_>>()?;

    app.insert("privacyTypes".into(), Value::Array(types));
    app.insert(
        "policyAnalysis".into(),
        super::policy::get_policy_analysis(conn, app_id)?,
    );
    app.insert("accessibilityFeatures".into(), Value::Array(accessibility));
    Ok(Some(Value::Object(app)))
}

// ── ?view=grouped ────────────────────────────────────────────────────

/// `categoryRiskWeight`, transcribed. `OTHER` is the real `CATEGORY_META`
/// key (its label is "Other Data"), so it does match; anything outside the
/// fourteen falls through to the `?? 2` default.
fn category_risk_weight(identifier: &str) -> i64 {
    match identifier {
        "SENSITIVE_INFO" | "LOCATION" | "HEALTH_AND_FITNESS" | "IDENTIFIERS" => 5,
        "FINANCIAL_INFO" | "USER_CONTENT" | "BROWSING_HISTORY" | "SEARCH_HISTORY"
        | "USAGE_DATA" => 4,
        "CONTACT_INFO" | "CONTACTS" | "PURCHASES" => 3,
        "DIAGNOSTICS" | "OTHER" => 1,
        _ => 2,
    }
}

/// `comparePrivacyTypeDisplayOrder`: a rank of 0/1/2, anything else
/// `Number.MAX_SAFE_INTEGER`. Returned as a SUBTRACTION, so two unknown types
/// compare 0 — equal — and a stable sort leaves them in SQL row order.
fn privacy_type_display_rank(identifier: &str) -> i64 {
    match identifier {
        "DATA_NOT_LINKED_TO_YOU" => 0,
        "DATA_LINKED_TO_YOU" => 1,
        "DATA_USED_TO_TRACK_YOU" => 2,
        _ => 9_007_199_254_740_991, // Number.MAX_SAFE_INTEGER
    }
}

/// Port of `getGroupedPrivacyView`.
///
/// Three order-sensitive mechanisms stack on one un-ORDER-BY'd join, and all
/// three resolve to "the order SQLite returned the rows in":
///
/// 1. `grouped` is a plain object keyed by type identifier, and
///    `Object.values` walks string keys in INSERTION order (these keys are
///    not integer-like, so the integer-key exception does not apply). Same
///    for the nested `categories` object.
/// 2. `appIds` is a `Set`, which also iterates in insertion order, and the
///    `.map(appMap.get).filter(Boolean)` after it silently DROPS an app id
///    with no matching row rather than emitting a hole.
/// 3. Both sorts are stable and both can return 0 — the category sort on a
///    full weight+count tie, the group sort on two unknown types — leaving
///    the tied elements in that same insertion order.
///
/// The object spread `{...group, categories: […]}` overwrites `categories`
/// in place, so it stays FOURTH rather than moving to the end.
///
/// A device scope filters BOTH queries. The category rows go through the
/// same scope rather than being checked against the app map afterwards, so
/// a category whose only apps are out of scope disappears instead of staying
/// as an empty entry.
pub(super) fn get_grouped_privacy_view(
    conn: &Connection,
    scope: &super::scope::Scope,
) -> rusqlite::Result<Vec<Value>> {
    let clause = scope.clause("a.id");
    let (scope_where, row_scope_where) = if clause.is_empty() {
        (String::new(), String::new())
    } else {
        (
            format!("WHERE {clause}"),
            format!("WHERE EXISTS (SELECT 1 FROM apps a WHERE a.id = pt.app_id AND {clause})"),
        )
    };
    // `SELECT a.id, a.name, a.iconUrl, a.developer FROM apps a` — an
    // explicit projection, so this one is a fixed key order.
    let mut app_stmt = conn.prepare(&format!(
        "SELECT a.id, a.name, a.iconUrl, a.developer FROM apps a {scope_where}"
    ))?;
    let app_rows: Vec<(String, Value)> = app_stmt
        .query_map(rusqlite::params_from_iter(scope.params()), |row| {
            Ok((row.get::<_, String>("id")?, row_to_json(row)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    // `new Map(apps.map(a => [a.id, a]))` — last row wins on a duplicate id.
    let mut app_map: std::collections::HashMap<String, Value> =
        std::collections::HashMap::with_capacity(app_rows.len());
    for (id, row) in app_rows {
        app_map.insert(id, row);
    }

    let mut stmt = conn.prepare(&format!(
        "
    SELECT
      pt.identifier  AS typeId,
      pt.title       AS typeTitle,
      pt.detail      AS typeDetail,
      pc.identifier  AS categoryId,
      pc.title       AS categoryTitle,
      pt.app_id
    FROM privacy_types pt
    JOIN privacy_categories pc ON pc.type_id = pt.id
    {row_scope_where}
  "
    ))?;

    struct Category {
        identifier: Value,
        title: Value,
        app_ids: Vec<String>,
    }
    struct Group {
        identifier: Value,
        title: Value,
        detail: Value,
        categories: Vec<(String, Category)>,
    }

    // Insertion-ordered, because that is what `Object.values` replays.
    let mut groups: Vec<(String, Group)> = Vec::new();

    let rows = stmt.query_map(rusqlite::params_from_iter(scope.params()), |row| {
        Ok((
            row.get::<_, Option<String>>("typeId")?.unwrap_or_default(),
            column(row, "typeId")?,
            column(row, "typeTitle")?,
            column(row, "typeDetail")?,
            row.get::<_, Option<String>>("categoryId")?
                .unwrap_or_default(),
            column(row, "categoryId")?,
            column(row, "categoryTitle")?,
            row.get::<_, Option<String>>("app_id")?.unwrap_or_default(),
        ))
    })?;

    for row in rows {
        let (type_key, type_id, type_title, type_detail, cat_key, cat_id, cat_title, app_id) = row?;

        let gi = match groups.iter().position(|(k, _)| *k == type_key) {
            Some(i) => i,
            None => {
                groups.push((
                    type_key,
                    Group {
                        identifier: type_id,
                        title: type_title,
                        detail: type_detail,
                        categories: Vec::new(),
                    },
                ));
                groups.len() - 1
            }
        };

        let cats = &mut groups[gi].1.categories;
        let ci = match cats.iter().position(|(k, _)| *k == cat_key) {
            Some(i) => i,
            None => {
                cats.push((
                    cat_key,
                    Category {
                        identifier: cat_id,
                        title: cat_title,
                        app_ids: Vec::new(),
                    },
                ));
                cats.len() - 1
            }
        };

        // `Set.add` — a repeat keeps its original position and adds nothing.
        if !cats[ci].1.app_ids.contains(&app_id) {
            cats[ci].1.app_ids.push(app_id);
        }
    }

    let mut out: Vec<(i64, Value)> = groups
        .into_iter()
        .map(|(_, group)| {
            let mut categories: Vec<(i64, usize, Value)> = group
                .categories
                .into_iter()
                .map(|(_, c)| {
                    let weight = category_risk_weight(c.identifier.as_str().unwrap_or(""));
                    // An app id with no row is DROPPED, not emitted as null.
                    let apps: Vec<Value> = c
                        .app_ids
                        .iter()
                        .filter_map(|id| app_map.get(id).cloned())
                        .collect();
                    let count = apps.len();
                    let mut obj = serde_json::Map::new();
                    obj.insert("identifier".into(), c.identifier);
                    obj.insert("title".into(), c.title);
                    obj.insert("riskWeight".into(), Value::from(weight));
                    obj.insert("apps".into(), Value::Array(apps));
                    (weight, count, Value::Object(obj))
                })
                .collect();
            // Weight DESC, then app count DESC. A full tie compares equal and
            // the stable sort leaves SQL order standing — which the canned
            // seed actually reaches.
            categories.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));

            let rank = privacy_type_display_rank(group.identifier.as_str().unwrap_or(""));
            let mut obj = serde_json::Map::new();
            // Spread order: identifier, title, detail, then `categories`
            // overwritten IN PLACE — so it stays fourth.
            obj.insert("identifier".into(), group.identifier);
            obj.insert("title".into(), group.title);
            obj.insert("detail".into(), group.detail);
            obj.insert(
                "categories".into(),
                Value::Array(categories.into_iter().map(|(_, _, v)| v).collect()),
            );
            (rank, Value::Object(obj))
        })
        .collect();

    out.sort_by_key(|(rank, _)| *rank);
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let c = crate::db::open_and_migrate(std::path::Path::new(":memory:"))
            .expect("in-memory migrate");
        c.execute_batch(
            "INSERT INTO apps (id, name, url, lastSynced) VALUES
               ('2', 'Beta',  'https://e/2', 0),
               ('1', 'Alpha', 'https://e/1', 0),
               ('3', 'Alpha', 'https://e/3', 0);",
        )
        .expect("fixture rows");
        c
    }

    fn all() -> super::super::scope::Scope {
        super::super::scope::Scope::default()
    }

    fn scoped(c: &Connection, raw: &str) -> super::super::scope::Scope {
        super::super::scope::Scope::from_request(c, Some(raw))
    }

    /// `seeded()` plus devices: both Alphas on d1, nothing on d2, and Beta
    /// on no device at all.
    fn with_devices() -> Connection {
        let c = seeded();
        c.execute_batch(
            "INSERT INTO devices (id, name, created_at, last_synced_at) VALUES
               ('d1', 'Phone', 0, 0),
               ('d2', 'Empty tablet', 0, 0);
             INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at) VALUES
               ('1', 'd1', 0, 0),
               ('3', 'd1', 0, 0);",
        )
        .expect("device rows");
        c
    }

    fn ids(rows: &[Value]) -> Vec<&str> {
        rows.iter().filter_map(|r| r["id"].as_str()).collect()
    }

    #[test]
    fn a_device_scope_pages_and_counts_inside_the_scope() {
        let c = with_devices();
        let d1 = scoped(&c, "d1");
        assert_eq!(count_apps(&c, &d1).unwrap(), 2);
        assert_eq!(ids(&get_apps_page(&c, 1, 1, &d1).unwrap()), ["3"]);

        // The fleet's first page is Alpha (1), which is attached, so a filter
        // applied after LIMIT would return nothing here.
        let unattached = scoped(&c, "unattached");
        assert_eq!(ids(&get_apps_page(&c, 1, 0, &unattached).unwrap()), ["2"]);
        assert_eq!(count_apps(&c, &unattached).unwrap(), 1);

        let empty = scoped(&c, "d2");
        assert_eq!(count_apps(&c, &empty).unwrap(), 0);
        assert!(get_apps_page(&c, 250, 0, &empty).unwrap().is_empty());
        assert!(get_all_apps_scoped(&c, &empty).unwrap().is_empty());

        // A device that no longer exists is the unrestricted scope.
        assert_eq!(count_apps(&c, &scoped(&c, "gone")).unwrap(), 3);
        assert_eq!(get_all_apps(&c).unwrap().len(), 3);
    }

    #[test]
    fn a_scoped_grouped_view_drops_categories_with_no_app_in_scope() {
        let c = with_devices();
        c.execute_batch(
            "INSERT INTO privacy_types (id, app_id, identifier, title) VALUES
               ('t1', '1', 'DATA_LINKED_TO_YOU', 'Linked'),
               ('t2', '2', 'DATA_NOT_LINKED_TO_YOU', 'Not linked'),
               ('t3', '2', 'DATA_LINKED_TO_YOU', 'Linked');
             INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES
               ('c1', 't1', 'CONTACT_INFO', 'Contact Info'),
               ('c2', 't2', 'LOCATION', 'Location'),
               ('c3', 't3', 'CONTACT_INFO', 'Contact Info');",
        )
        .unwrap();
        let types = |groups: &[Value]| -> Vec<String> {
            groups
                .iter()
                .map(|g| g["identifier"].as_str().unwrap().to_owned())
                .collect()
        };

        let whole = get_grouped_privacy_view(&c, &all()).unwrap();
        assert_eq!(
            types(&whole),
            ["DATA_NOT_LINKED_TO_YOU", "DATA_LINKED_TO_YOU"]
        );

        let d1 = get_grouped_privacy_view(&c, &scoped(&c, "d1")).unwrap();
        assert_eq!(types(&d1), ["DATA_LINKED_TO_YOU"]);
        let apps = d1[0]["categories"][0]["apps"].as_array().unwrap();
        assert_eq!(ids(apps), ["1"], "Beta is out of scope");

        assert!(get_grouped_privacy_view(&c, &scoped(&c, "d2"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_bare_list_orders_by_name_and_appends_the_six_counts() {
        let c = seeded();
        let rows = get_all_apps(&c).expect("query");
        assert_eq!(rows.len(), 3);
        let names: Vec<&str> = rows.iter().filter_map(|r| r["name"].as_str()).collect();
        assert_eq!(names, vec!["Alpha", "Alpha", "Beta"]);

        // The counts trail every table column, and COALESCE means an app with
        // no privacy rows reports 0 rather than null.
        let keys: Vec<&str> = rows[0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let tail = &keys[keys.len() - 6..];
        assert_eq!(
            tail,
            [
                "categoryCount",
                "trackCount",
                "linkedCount",
                "unlinkedCount",
                "syncCount",
                "accessibilityCount"
            ]
        );
        assert_eq!(rows[0]["categoryCount"], Value::from(0));
        assert_eq!(keys[0], "id", "`a.*` starts at the table's first column");
    }

    #[test]
    fn the_paged_list_breaks_name_ties_by_id_where_the_bare_one_does_not() {
        let c = seeded();
        // Two apps named "Alpha" (ids 1 and 3). The paged query's `, id ASC`
        // makes their order defined; the bare query leaves it to the planner,
        // which is why the two are not interchangeable.
        let page = get_apps_page(&c, 2, 0, &all()).expect("query");
        let ids: Vec<&str> = page.iter().filter_map(|r| r["id"].as_str()).collect();
        assert_eq!(ids, vec!["1", "3"]);

        let second = get_apps_page(&c, 2, 2, &all()).expect("query");
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["name"], Value::from("Beta"));
    }

    #[test]
    fn the_page_and_the_bare_list_agree_on_row_shape() {
        let c = seeded();
        let bare = get_all_apps(&c).expect("query");
        let page = get_apps_page(&c, 500, 0, &all()).expect("query");
        let keys = |v: &Value| {
            v.as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<String>>()
        };
        assert_eq!(
            keys(&bare[0]),
            keys(&page[0]),
            "the grid hydrates one from the other, so the key sets must match"
        );
    }

    #[test]
    fn count_is_the_whole_fleet_not_the_page() {
        let c = seeded();
        assert_eq!(count_apps(&c, &all()).expect("count"), 3);
        assert_eq!(get_apps_page(&c, 1, 0, &all()).expect("query").len(), 1);
    }

    #[test]
    fn app_with_privacy_appends_the_three_keys_in_order_and_404s_on_unknown() {
        let c = seeded();
        c.execute_batch(
            "INSERT INTO privacy_types (id, app_id, identifier, title) VALUES ('t1', '1', 'DATA_LINKED_TO_YOU', 'Linked');
             INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES ('c1', 't1', 'CONTACT_INFO', 'Contact Info');",
        )
        .unwrap();
        let app = get_app_with_privacy(&c, "1").unwrap().expect("known app");
        let keys: Vec<&str> = app
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let tail = &keys[keys.len() - 3..];
        assert_eq!(
            tail,
            ["privacyTypes", "policyAnalysis", "accessibilityFeatures"]
        );
        // The legacy purpose_id column is still emitted, as null.
        let cat = &app["privacyTypes"][0]["categories"][0];
        assert!(cat.as_object().unwrap().contains_key("purpose_id"));
        assert_eq!(cat["purpose_id"], Value::Null);
        assert_eq!(app["accessibilityFeatures"], serde_json::json!([]));

        assert!(get_app_with_privacy(&c, "nope").unwrap().is_none());
    }

    #[test]
    fn an_offset_past_the_end_is_an_empty_page_not_an_error() {
        let c = seeded();
        assert!(get_apps_page(&c, 10, 99, &all()).expect("query").is_empty());
    }
}

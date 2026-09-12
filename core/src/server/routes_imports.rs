//! `GET /api/imports` — the batch-2 bare-array route, plus its `?id` branch.
//!
//! Two shapes from one path, which is why it is worth porting early:
//!
//!   * no `?id`  → a BARE ARRAY of import rows. No envelope. Empty database
//!     gives `[]`, never `null`.
//!   * `?id=<found>`   → `{"import": …, "items": […]}`
//!   * `?id=<missing>` → 404 `{"error":"Import not found"}`
//!
//! The `id` check is JavaScript truthiness, so `?id=` (present but empty)
//! falls THROUGH to the list response rather than 404ing. A Rust
//! `Option<String>` check would 404 on it.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Response,
};
use rusqlite::Row;
use serde::Serialize;
use std::collections::HashMap;

use super::json::{json_error, json_ok};
use super::AppState;

pub(super) const IMPORT_SOURCES: [&str; 3] = ["screenshots", "file", "manual"];
const IMPORT_ITEM_STATUSES: [&str; 8] = [
    "matched",
    "unmatched",
    "skipped",
    "imported",
    "error",
    "pending_search",
    "queued",
    "removed",
];

/// The live-counter join, shared by the list and single-row reads so both
/// return the same shape. `queued_count` deliberately folds `pending_search`
/// in with `queued` — from the user's point of view both mean "still in
/// flight". Splitting them changes the number.
const COUNTER_JOIN: &str = "COALESCE(s.queued_count, 0)   AS queued_count,
              COALESCE(s.errored_count, 0)  AS errored_count,
              COALESCE(s.removed_count, 0)  AS removed_count,
              COALESCE(s.item_count, 0)     AS item_count
         FROM imports i
         LEFT JOIN (
           SELECT import_id,
                  SUM(CASE WHEN status IN ('queued', 'pending_search') THEN 1 ELSE 0 END) AS queued_count,
                  SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS errored_count,
                  SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) AS removed_count,
                  COUNT(*)                                            AS item_count
             FROM import_items";

/// Field order per `hydrateImport` in lib/imports.ts.
#[derive(Serialize)]
struct ImportRow {
    id: String,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(rename = "completedAt")]
    completed_at: Option<i64>,
    source: String,
    #[serde(rename = "sourceLabel")]
    source_label: Option<String>,
    total: i64,
    matched: i64,
    unmatched: i64,
    imported: i64,
    queued: i64,
    errored: i64,
    removed: i64,
    #[serde(rename = "itemCount")]
    item_count: i64,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
}

/// Field order per `hydrateImportItem`. Note the asymmetry the Node code
/// bakes in and a "tidy" port would smooth away: `attemptCount` coerces NULL
/// to 0, while the adjacent `nextAttemptAt` stays null.
#[derive(Serialize)]
pub(super) struct ImportItemRow {
    id: String,
    #[serde(rename = "importId")]
    import_id: String,
    query: String,
    #[serde(rename = "editedQuery")]
    edited_query: Option<String>,
    status: String,
    #[serde(rename = "appId")]
    app_id: Option<String>,
    #[serde(rename = "appName")]
    app_name: Option<String>,
    developer: Option<String>,
    url: Option<String>,
    #[serde(rename = "iconUrl")]
    icon_url: Option<String>,
    country: Option<String>,
    #[serde(rename = "scrapeError")]
    scrape_error: Option<String>,
    #[serde(rename = "removedAppId")]
    removed_app_id: Option<String>,
    #[serde(rename = "nextAttemptAt")]
    next_attempt_at: Option<i64>,
    #[serde(rename = "attemptCount")]
    attempt_count: i64,
}

#[derive(Serialize)]
struct ImportDetail {
    #[serde(rename = "import")]
    import_row: ImportRow,
    items: Vec<ImportItemRow>,
}

/// `normalizeSource` / `normalizeItemStatus`: an unrecognised stored value is
/// silently coerced to a default, never surfaced and never an error.
pub(super) fn normalize(value: &str, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&value) {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

fn hydrate_import(row: &Row<'_>) -> rusqlite::Result<ImportRow> {
    Ok(ImportRow {
        id: row.get("id")?,
        created_at: row.get("created_at")?,
        completed_at: row.get("completed_at")?,
        source: normalize(&row.get::<_, String>("source")?, &IMPORT_SOURCES, "manual"),
        source_label: row.get("source_label")?,
        total: row.get("total")?,
        matched: row.get("matched")?,
        unmatched: row.get("unmatched")?,
        imported: row.get("imported")?,
        queued: row.get("queued_count")?,
        errored: row.get("errored_count")?,
        removed: row.get("removed_count")?,
        item_count: row.get("item_count")?,
        device_id: row.get("device_id")?,
    })
}

pub(super) fn hydrate_item(row: &Row<'_>) -> rusqlite::Result<ImportItemRow> {
    Ok(ImportItemRow {
        id: row.get("id")?,
        import_id: row.get("import_id")?,
        query: row.get("query")?,
        edited_query: row.get("edited_query")?,
        status: normalize(
            &row.get::<_, String>("status")?,
            &IMPORT_ITEM_STATUSES,
            "unmatched",
        ),
        app_id: row.get("app_id")?,
        app_name: row.get("app_name")?,
        developer: row.get("developer")?,
        url: row.get("url")?,
        icon_url: row.get("icon_url")?,
        country: row.get("country")?,
        scrape_error: row.get("scrape_error")?,
        removed_app_id: row.get("removed_app_id")?,
        next_attempt_at: row.get("next_attempt_at")?,
        // NULL → 0 here, but next_attempt_at above stays null. Deliberate.
        attempt_count: row.get::<_, Option<i64>>("attempt_count")?.unwrap_or(0),
    })
}

pub async fn imports(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    // JS truthiness: an EMPTY ?id= is falsy and falls through to the list.
    let id = q.get("id").filter(|v| !v.is_empty());

    let conn = state.conn.lock().expect("db mutex poisoned");

    if let Some(id) = id {
        let sql = format!(
            "SELECT i.*, {COUNTER_JOIN}
            WHERE import_id = ?1
            GROUP BY import_id
         ) s ON s.import_id = i.id
        WHERE i.id = ?2"
        );
        let found = conn
            .query_row(&sql, rusqlite::params![id, id], hydrate_import)
            .ok();
        let Some(import_row) = found else {
            return json_error(StatusCode::NOT_FOUND, "Import not found");
        };

        let items = (|| -> rusqlite::Result<Vec<ImportItemRow>> {
            let mut stmt =
                conn.prepare("SELECT * FROM import_items WHERE import_id = ? ORDER BY rowid ASC")?;
            let rows = stmt.query_map([id], hydrate_item)?;
            rows.collect()
        })();
        let Ok(items) = items else {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
        };

        return json_ok(&ImportDetail { import_row, items });
    }

    let sql = format!(
        "SELECT i.*, {COUNTER_JOIN}
            GROUP BY import_id
         ) s ON s.import_id = i.id
         ORDER BY i.created_at DESC"
    );
    let listed = (|| -> rusqlite::Result<Vec<ImportRow>> {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], hydrate_import)?;
        rows.collect()
    })();
    match listed {
        // Bare array — no envelope, and `[]` rather than null when empty.
        Ok(rows) => json_ok(&rows),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrecognised_stored_values_coerce_to_defaults() {
        assert_eq!(normalize("manual", &IMPORT_SOURCES, "manual"), "manual");
        assert_eq!(normalize("file", &IMPORT_SOURCES, "manual"), "file");
        // Silently coerced, not surfaced and not an error.
        assert_eq!(normalize("bogus", &IMPORT_SOURCES, "manual"), "manual");
        assert_eq!(normalize("", &IMPORT_SOURCES, "manual"), "manual");

        assert_eq!(
            normalize("pending_search", &IMPORT_ITEM_STATUSES, "unmatched"),
            "pending_search"
        );
        assert_eq!(
            normalize("nonsense", &IMPORT_ITEM_STATUSES, "unmatched"),
            "unmatched"
        );
    }

    #[test]
    fn empty_list_serialises_as_an_array_not_null() {
        let empty: Vec<ImportRow> = Vec::new();
        assert_eq!(serde_json::to_string(&empty).unwrap(), "[]");
    }
}

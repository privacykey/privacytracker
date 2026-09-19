//! Device GETs mirror the Node routes, including their asymmetric trimming
//! and error fallbacks. No hardware access or device mutations live here.
use super::{
    json::{json_error, json_ok, json_response},
    routes_stats::{get, Params},
    row::{column, row_to_json},
    AppState,
};
use crate::jsstr::is_js_whitespace;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Response,
};
use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::{json, Value};

pub(super) fn device(row: &Row<'_>) -> rusqlite::Result<Value> {
    let label: Option<String> = row.get("owner_label")?;
    let label = label
        .as_deref()
        .map(|s| s.trim_matches(is_js_whitespace))
        .filter(|s| !s.is_empty());
    let audience: Option<String> = row.get("owner_audience")?;
    let audience = audience
        .as_deref()
        .filter(|s| ["self", "loved_one", "guardian"].contains(s));
    // Key order is lib/devices.ts's rowToDevice literal, not its interface
    // or the table's physical column order (which differs on old installs).
    Ok(json!({
        "id": column(row, "id")?,
        "name": column(row, "name")?,
        "ecid": column(row, "ecid")?,
        "model": column(row, "model")?,
        "iosVersion": column(row, "ios_version")?,
        "deviceClass": column(row, "device_class")?,
        "createdAt": column(row, "created_at")?,
        "lastSyncedAt": column(row, "last_synced_at")?,
        "isUnknownPlaceholder": column(row, "is_unknown_placeholder")? == json!(1),
        "ownerLabel": label,
        "ownerAudience": audience,
        "permissionAcknowledgedAt": column(row, "permission_acknowledged_at")?,
    }))
}

pub(super) fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    conn.query_row("SELECT * FROM devices WHERE id = ?", [id], device)
        .optional()
}

fn import_history(conn: &Connection, id: &str) -> Value {
    // lib/imports.ts swallows a missing/partial imports table independently
    // of the surrounding device read. Completion is a non-NULL timestamp,
    // including zero; neither the source nor imported count filters it.
    conn.query_row(
        "SELECT COUNT(*) AS count, MAX(completed_at) AS last_completed
         FROM imports WHERE device_id = ? AND completed_at IS NOT NULL",
        [id],
        |row| {
            Ok(json!({
                "count": column(row, "count")?,
                "lastCompletedAt": column(row, "last_completed")?,
            }))
        },
    )
    .unwrap_or_else(|_| json!({"count":0,"lastCompletedAt":null}))
}

fn list(conn: &Connection, ecid: Option<&str>) -> rusqlite::Result<Value> {
    if let Some(ecid) = ecid
        .map(|s| s.trim_matches(is_js_whitespace))
        .filter(|s| !s.is_empty())
    {
        // This route intentionally does NOT use getDeviceByEcid's prefix /
        // case normalisation: Node's GET uses an exact SQL equality lookup.
        let id: Option<String> = conn
            .query_row("SELECT id FROM devices WHERE ecid = ?", [ecid], |r| {
                r.get(0)
            })
            .optional()?;
        return Ok(match id {
            Some(id) => json!({"device":by_id(conn,&id)?,"importHistory":import_history(conn,&id)}),
            None => json!({"device":null,"importHistory":null}),
        });
    }
    let mut stmt = conn.prepare("SELECT * FROM devices ORDER BY last_synced_at DESC, name")?;
    let mut devices = stmt.query_map([], device)?.collect::<Result<Vec<_>, _>>()?;
    let mut stmt =
        conn.prepare("SELECT device_id, COUNT(*) AS n FROM app_devices GROUP BY device_id")?;
    let counts = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, column(r, "n")?)))?
        .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
    for d in &mut devices {
        d["appCount"] = counts
            .get(d["id"].as_str().unwrap_or_default())
            .cloned()
            .unwrap_or(json!(0));
    }
    Ok(json!({"devices":devices}))
}

fn respond(
    result: rusqlite::Result<Value>,
    label: &str,
    fallback: Value,
    status: StatusCode,
) -> Response {
    match result {
        Ok(value) => json_ok(&value),
        Err(error) => {
            super::diag::log_error(format!("{label} failed: {error}"));
            json_response(status, &fallback)
        }
    }
}

pub async fn devices(State(state): State<AppState>, Query(q): Query<Params>) -> Response {
    let result = list(&state.db(), get(&q, "ecid"));
    respond(
        result,
        "[devices] GET",
        json!({"devices":[]}),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

/// Saved picker state is reconciled on read, never persisted by this GET.
pub async fn device_scope(State(state): State<AppState>) -> Response {
    let conn = state.db();
    let raw = match super::settings::get_setting_with(&conn, "device.scope", "") {
        Ok(raw) => raw,
        Err(error) => {
            super::diag::log_error(error.to_string());
            return Response::builder()
                .status(500)
                .body(axum::body::Body::empty())
                .unwrap();
        }
    };
    let parsed = super::user_content::parse(&raw).unwrap_or(Value::Null);
    let known: Vec<String> = super::stats::query(&conn, "SELECT id FROM devices", &[])
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| r["id"].as_str().map(str::to_string))
        .collect();
    let scope = reconcile_scope(&parsed, &known);
    json_ok(&json!({"scope":scope,"devices":picker_devices(&conn)}))
}

/// `SCOPE_ALL`.
pub(super) fn scope_all() -> Value {
    json!({"v":1,"mode":"all","deviceIds":[],"includeUnattached":true})
}

/// `reconcileScope(stored, knownDeviceIds)`: only string ids that exist,
/// in the known order; an empty subset, and a subset naming every device
/// plus the unattached bucket, collapse to "all".
pub(super) fn reconcile_scope(parsed: &Value, known: &[String]) -> Value {
    if parsed["mode"] != "subset" {
        return scope_all();
    }
    let requested: Vec<&str> = parsed["deviceIds"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let ids: Vec<&str> = known
        .iter()
        .map(String::as_str)
        .filter(|id| requested.contains(id))
        .collect();
    let unattached = parsed["includeUnattached"] == true;
    if (ids.is_empty() && !unattached) || (ids.len() == known.len() && unattached) {
        return scope_all();
    }
    json!({"v":1,"mode":"subset","deviceIds":ids,"includeUnattached":unattached})
}

/// `pickerDevices()`: the minimal rows the picker renders, or nothing when
/// the list cannot be read.
pub(super) fn picker_devices(conn: &Connection) -> Vec<Value> {
    match list(conn, None) {
        Ok(value) => value["devices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| {
                json!({
                    "appCount":d["appCount"],
                    "deviceClass":d["deviceClass"],
                    "id":d["id"],
                    "model":d["model"],
                    "name":d["name"],
                    "ownerAudience":d["ownerAudience"],
                    "ownerLabel":d["ownerLabel"]
                })
            })
            .collect::<Vec<_>>(),
        Err(error) => {
            super::diag::log_warn(format!("[device-scope] device list failed: {error}"));
            vec![]
        }
    }
}

pub async fn detail(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // Unlike bundles/tracked-apps/for-app, detail never trims its path ID.
    let result = {
        let conn = state.db();
        by_id(&conn, &id)
            .map(|d| d.map(|d| json!({"device":d,"importHistory":import_history(&conn,&id)})))
    };
    match result {
        Ok(Some(value)) => json_ok(&value),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "device not found"),
        Err(error) => respond(
            Err(error),
            "[devices/[id]] GET",
            json!({"error":"internal"}),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

pub async fn bundles(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let id = id.trim_matches(is_js_whitespace);
    let result = (|| {
        if id.is_empty() {
            return Ok(json!({"bundleIds":[]}));
        }
        let conn = state.db();
        // Planner-decided order, exactly as in Node. Do not sort or trim
        // bundle IDs: only NULL and the empty string are excluded.
        let mut stmt = conn.prepare(
            "SELECT DISTINCT a.bundleId AS bundleId FROM app_devices ad
             JOIN apps a ON a.id = ad.app_id WHERE ad.device_id = ?
             AND a.bundleId IS NOT NULL AND a.bundleId != ''",
        )?;
        let ids = stmt
            .query_map([id], |r| column(r, "bundleId"))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"bundleIds":ids}))
    })();
    respond(
        result,
        "[devices/[id]/bundles]",
        json!({"bundleIds":[]}),
        StatusCode::OK,
    )
}

pub async fn tracked_apps(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let id = id.trim_matches(is_js_whitespace);
    let result = (|| {
        if id.is_empty() {
            return Ok(json!({"apps":[]}));
        }
        let conn = state.db();
        // NOCASE is SQLite's ASCII folding, not JS localeCompare. Ties
        // retain the planner's order; Node has no secondary ORDER BY.
        let mut stmt = conn.prepare(
            "SELECT a.id AS appId, a.name AS name, a.bundleId AS bundleId
             FROM app_devices ad JOIN apps a ON a.id = ad.app_id
             WHERE ad.device_id = ? ORDER BY a.name COLLATE NOCASE",
        )?;
        let apps = stmt
            .query_map([id], row_to_json)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"apps":apps}))
    })();
    respond(
        result,
        "[devices/[id]/tracked-apps]",
        json!({"apps":[]}),
        StatusCode::OK,
    )
}

pub async fn for_app(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let id = id.trim_matches(is_js_whitespace);
    if id.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"devices":[]}));
    }
    let result = (|| {
        let conn = state.db();
        let mut stmt = conn.prepare(
            "SELECT d.* FROM devices d JOIN app_devices ad ON ad.device_id = d.id
             WHERE ad.app_id = ? ORDER BY d.last_synced_at DESC, d.name",
        )?;
        let devices = stmt
            .query_map([id], device)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"devices":devices}))
    })();
    respond(
        result,
        "[devices/for-app]",
        json!({"devices":[]}),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

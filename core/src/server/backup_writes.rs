//! Phase 4, batch 5b: the backup routes — the snapshot settings and the
//! manual snapshot (`PUT`/`POST /api/backup/snapshots`), the snapshot
//! download (`GET /api/backup/snapshots/[filename]`), the full export
//! (`GET /api/backup/export`), the dry-run preview (`POST
//! /api/backup/preview`) and the destructive restore (`POST
//! /api/backup/restore`). Each is the Node route in order, gated by
//! `core/tests/fixtures/backup-cases.json`.
//!
//! The export is a GET that writes — its audit row — and guards itself
//! inline, so it runs through the write framework like the routes beside
//! it. The download neither writes nor guards and is a plain handler.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use super::{
    backup::{self, RestoreError},
    backup_snapshots,
    body::{body_error_response, BodyOutcome},
    diag,
    guard::{record_audit, Actor},
    json::{js_json_pretty_vec, json_error, json_ok, json_response},
    writes::{internal_error, Cx, RouteSpec, WriteRequest},
};
use crate::{
    jsdate::js_iso_string,
    jsstr::{js_length, js_slice_prefix},
};
use axum::{
    body::Body,
    http::{header, HeaderMap, Method, StatusCode},
    response::Response,
};
use serde_json::{json, Value};

/// Backups run to tens of megabytes on a long-lived install.
pub(super) const MAX_BACKUP_BYTES: usize = 100 * 1024 * 1024;

pub(super) fn handles(spec: &RouteSpec) -> bool {
    matches!(
        spec.path,
        "/api/backup/snapshots"
            | "/api/backup/export"
            | "/api/backup/preview"
            | "/api/backup/restore"
    )
}

pub(super) fn perform(cx: &mut Cx, req: WriteRequest, actor: &Actor) -> Response {
    let spec = req.spec;
    match (spec.path, &spec.method) {
        ("/api/backup/snapshots", &Method::PUT) => snapshot_settings(cx, req.body),
        ("/api/backup/snapshots", &Method::POST) => snapshot_create(cx),
        ("/api/backup/export", &Method::GET) => export(cx, actor),
        ("/api/backup/preview", &Method::POST) => preview(req.body),
        ("/api/backup/restore", &Method::POST) => {
            restore(cx, req.body, req.query, req.headers, actor)
        }
        _ => json_error(StatusCode::NOT_FOUND, "Not Found"),
    }
}

/// `snapshotPayload()`.
fn snapshot_payload(cx: &Cx) -> Result<Value, Response> {
    backup_snapshots::settings(cx.w.conn)
        .and_then(backup_snapshots::payload)
        .map_err(|_| internal_error())
}

// ── PUT /api/backup/snapshots ────────────────────────────────────────

fn snapshot_settings(cx: &mut Cx, body: BodyOutcome) -> Response {
    if let Some(response) = body_error_response(&body) {
        return response;
    }
    let body = match body {
        BodyOutcome::Json(v) => v,
        BodyOutcome::Empty => return json_error(StatusCode::BAD_REQUEST, "Request body is empty"),
        _ => return json_error(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };
    if backup_snapshots::save_settings(cx, &body).is_err() {
        return internal_error();
    }
    match snapshot_payload(cx) {
        Ok(payload) => json_ok(&payload),
        Err(response) => response,
    }
}

// ── POST /api/backup/snapshots ───────────────────────────────────────

fn snapshot_create(cx: &mut Cx) -> Response {
    let (snapshot, pruned) = match backup_snapshots::create_snapshot(cx, &backup::env(), "manual") {
        Ok(created) => created,
        Err(e) => {
            diag::log_error(format!("[backup] snapshot failed: {e}"));
            return internal_error();
        }
    };
    let mut payload = match snapshot_payload(cx) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    payload["created"] = snapshot;
    payload["pruned"] = Value::Array(pruned);
    json_ok(&payload)
}

// ── GET /api/backup/snapshots/[filename] ─────────────────────────────

fn download_response(body: Vec<u8>, filename: &str, version: Option<&Value>) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .header(header::CACHE_CONTROL, "no-store");
    if let Some(version) = version {
        builder = builder.header("x-backup-version", crate::jsstr::js_string(version));
    }
    builder
        .body(Body::from(body))
        .unwrap_or_else(|_| internal_error())
}

/// The snapshot's bytes as an attachment, or the route's 404. The
/// attachment name is the file's own with every UTF-16 unit outside
/// `[A-Za-z0-9._-]` replaced, so nothing a header treats specially — a
/// quote, a CR or LF — can reach it whatever a snapshot is named.
pub(super) fn download(filename: &str) -> Response {
    let Some(path) = backup_snapshots::snapshot_path(&backup::env(), filename) else {
        return json_error(StatusCode::NOT_FOUND, "Snapshot not found");
    };
    let body = match std::fs::read(&path) {
        Ok(body) => body,
        Err(e) => {
            diag::log_error(format!("[backup] snapshot read failed: {e}"));
            return internal_error();
        }
    };
    let safe: String = filename
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
            std::iter::repeat(if keep { c } else { '_' }).take(c.len_utf16())
        })
        .collect();
    download_response(body, &safe, None)
}

// ── GET /api/backup/export ───────────────────────────────────────────

fn export(cx: &mut Cx, actor: &Actor) -> Response {
    let built = backup::export_backup(cx, &backup::env()).and_then(|envelope| {
        let version = envelope.version.clone();
        let exported_at = envelope.exported_at.as_i64().unwrap_or(cx.now);
        let body = js_json_pretty_vec(&envelope.into_json()).map_err(|e| e.to_string())?;
        Ok((version, exported_at, body))
    });
    match built {
        Ok((version, exported_at, body)) => {
            let filename = format!(
                "privacytracker-backup-{}.json",
                js_iso_string(exported_at).replace([':', '.'], "-")
            );
            // `body.length` counts UTF-16 units, not bytes.
            let units = js_length(&String::from_utf8_lossy(&body));
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "backup.export.success",
                actor,
                Some(&format!(
                    "version={}, bytes={units}",
                    backup::CURRENT_BACKUP_VERSION
                )),
                true,
            );
            download_response(body, &filename, Some(&version))
        }
        Err(e) => {
            diag::log_error(format!("[backup] export failed: {e}"));
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "backup.export.failed",
                actor,
                Some(&e),
                false,
            );
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to build backup. Check server logs.",
            )
        }
    }
}

// ── POST /api/backup/preview, POST /api/backup/restore ───────────────

/// `readJsonBody`: the routes' own reader over `readBoundedBody`. `Err`
/// is the message of a plain `Error`; the size and timeout responses are
/// the caller's to return first. A body of only whitespace is not empty
/// here — it has bytes, and fails to parse.
fn upload(body: BodyOutcome) -> Result<Value, &'static str> {
    match body {
        BodyOutcome::Json(v) => Ok(v),
        BodyOutcome::Empty => Err("Empty upload."),
        _ => Err("Uploaded file is not valid JSON."),
    }
}

fn preview(body: BodyOutcome) -> Response {
    if let Some(response) = body_error_response(&body) {
        return response;
    }
    match upload(body)
        .map_err(str::to_string)
        .and_then(backup::preview_restore)
    {
        Ok(summary) => json_ok(&summary),
        // A format error and any other failure are both a 400 with the
        // message; an empty message cannot arise from either.
        Err(message) => json_error(StatusCode::BAD_REQUEST, &message),
    }
}

/// The 409 `/api/backup/restore` answers while a sync runs — after its
/// guard and BEFORE it reads the body, so an oversized upload still hears
/// about the sync rather than its size.
pub(super) fn restore_precheck(w: &crate::scrape::persist::Writer) -> Result<(), Response> {
    let running = super::settings::get_setting_with(w.conn, "sync_running", "false")
        .unwrap_or_else(|_| "false".to_string());
    if running == "true" {
        return Err(json_error(
            StatusCode::CONFLICT,
            "A sync is currently running. Please wait until it finishes before restoring.",
        ));
    }
    Ok(())
}

fn restore(
    cx: &mut Cx,
    body: BodyOutcome,
    query: &[(String, String)],
    headers: &HeaderMap,
    actor: &Actor,
) -> Response {
    if let Some(response) = body_error_response(&body) {
        return response;
    }
    let refuse = |cx: &mut Cx, action: &str, status: StatusCode, message: &str| {
        record_audit(
            cx.w,
            cx.ids,
            cx.now,
            action,
            actor,
            Some(&js_slice_prefix(message, 256)),
            false,
        );
        json_error(status, message)
    };
    let payload = match upload(body) {
        Ok(payload) => payload,
        Err(message) => {
            return refuse(
                cx,
                "backup.restore.bad_request",
                StatusCode::BAD_REQUEST,
                message,
            )
        }
    };
    // The opt-in for a backup this install did not sign: the first
    // `allowUntrusted` in the query, or the header, as `1` or `true`.
    let allowed = |v: Option<&str>| matches!(v, Some("1" | "true"));
    let allow_untrusted = allowed(
        query
            .iter()
            .find(|(k, _)| k == "allowUntrusted")
            .map(|(_, v)| v.as_str()),
    ) || allowed(
        headers
            .get("x-allow-untrusted-backup")
            .and_then(|v| v.to_str().ok()),
    );
    match backup::restore_backup(cx, &backup::env(), payload, allow_untrusted) {
        Ok(restored) => {
            // Best effort: the restore has already happened.
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                restored.audit_action,
                actor,
                Some(&js_slice_prefix(&restored.audit_detail, 1024)),
                true,
            );
            let mut out = serde_json::Map::new();
            out.insert("success".into(), json!(true));
            if let Value::Object(result) = restored.result {
                out.extend(result);
            }
            json_ok(&Value::Object(out))
        }
        Err(RestoreError::Untrusted { signature_present }) => {
            let message = if signature_present {
                "Backup signature does not match this install. Pass allowUntrusted=true to restore anyway."
            } else {
                "Backup is unsigned (no signature found). Pass allowUntrusted=true to restore anyway."
            };
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "backup.restore.untrusted_rejected",
                actor,
                Some(&js_slice_prefix(message, 256)),
                false,
            );
            json_response(
                StatusCode::CONFLICT,
                &json!({
                    "error": message,
                    "code": "untrusted_backup",
                    "signaturePresent": signature_present,
                }),
            )
        }
        Err(RestoreError::Format(message)) => refuse(
            cx,
            "backup.restore.format_error",
            StatusCode::BAD_REQUEST,
            &message,
        ),
        Err(RestoreError::Other(message)) => {
            diag::log_error(format!("[backup] restore failed: {message}"));
            // `message || "Failed to restore backup."` on the wire; the
            // audit row keeps the message as it was.
            let response = refuse(
                cx,
                "backup.restore.failed",
                StatusCode::INTERNAL_SERVER_ERROR,
                &message,
            );
            if message.is_empty() {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to restore backup.",
                );
            }
            response
        }
    }
}

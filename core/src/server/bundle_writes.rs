//! Phase 4, batch 5c: the audit bundle's two routes — `POST
//! /api/export/audit-bundle` and `POST /api/import/audit-bundle` — and the
//! two support bundles, `GET /api/diagnostics/bundle` and `GET
//! /api/deployment/support-bundle`. Each is the Node route in order, gated
//! by `core/tests/fixtures/bundles-cases.json`.
//!
//! The export and the import run through the write framework. The import
//! has no guard of its own — the gate's origin check is what stands in
//! front of it — and is the one route that takes `multipart/form-data`,
//! so its body arrives unparsed (`BodyOutcome::Raw`) when the request says
//! that is what it is. The two support bundles are reads assembled from
//! snapshots other routes already serve.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use super::{
    activity_log::record_activity,
    audit_bundle::{
        self, bundle_filename, find_existing_import, import_audit_bundle, locale_string,
        validate_bundle, ExportOptions,
    },
    body::{body_error_response, BodyOutcome},
    deployment::build_deployment_diagnostics,
    diag,
    diagnostics::{last_integrity_check, snapshot_database_health, snapshot_disk},
    flags,
    json::{js_json_pretty_vec, json_error, json_ok, json_response},
    multipart,
    operations::{self, Job},
    osinfo::{node_arch, uname_parts},
    routes_focus::infer_focus_workflow,
    runtime_diag::{self, sqlite_metrics},
    stats::{query, truthy},
    sysproc::{cpu_count, host_memory},
    writes::{prop, Cx, RouteSpec, WriteRequest},
    AppState,
};
use crate::jsdate::js_iso_string;
use axum::{
    body::Body,
    http::{header, HeaderMap, Method, StatusCode},
    response::Response,
};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

/// A few hundred apps' worth of labels, excerpts and notes.
pub(super) const MAX_AUDIT_BUNDLE_BYTES: usize = 8 * 1024 * 1024;
const NOT_A_BUNDLE: &str = "This file isn't a valid audit bundle (couldn't parse JSON).";
const FOCUS_WORKFLOWS: [&str; 5] = [
    "self_monitor",
    "self_cleanup",
    "other_handoff",
    "other_monitor",
    "custom",
];

pub(super) fn handles(spec: &RouteSpec) -> bool {
    matches!(
        spec.path,
        "/api/export/audit-bundle" | "/api/import/audit-bundle"
    )
}

/// Whether this request's body is handed to the route unparsed.
pub(super) fn takes_raw_body(spec: &RouteSpec, headers: &HeaderMap) -> bool {
    spec.path == "/api/import/audit-bundle"
        && headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("multipart/form-data"))
}

pub(super) fn perform(cx: &mut Cx, req: WriteRequest) -> Response {
    match (req.spec.path, &req.spec.method) {
        ("/api/export/audit-bundle", &Method::POST) => export(cx, req.body),
        ("/api/import/audit-bundle", &Method::POST) => import(cx, req.body, req.query, req.headers),
        _ => json_error(StatusCode::NOT_FOUND, "Not Found"),
    }
}

/// A 500 with no body, which is what Next answers when a handler throws.
fn thrown() -> Response {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(Body::empty())
        .expect("static response")
}

// ── POST /api/export/audit-bundle ────────────────────────────────────

/// `getActiveFocus().audience` and `getActiveFocusWorkflow(focus)`.
fn focus_and_workflow(cx: &Cx) -> (String, String) {
    let stored = cx.get("flag.focus.audience", "");
    let audience = if stored.is_empty() {
        "self".to_string()
    } else {
        stored
    };
    let workflow = cx.get("flag.focus.workflow", "");
    if FOCUS_WORKFLOWS.contains(&workflow.as_str()) {
        return (audience, workflow);
    }
    let goal = |key: &str| cx.get(key, "") == "true";
    // `activeGoalsFrom`: minimal suppresses the two tiles.
    let minimal = goal("flag.focus.goal.minimal");
    let inferred = infer_focus_workflow(
        &audience,
        !minimal && goal("flag.focus.goal.monitor"),
        !minimal && goal("flag.focus.goal.cleanup"),
        minimal,
    );
    (audience, inferred.to_string())
}

fn export(cx: &mut Cx, body: BodyOutcome) -> Response {
    if let Some(response) = body_error_response(&body) {
        return response;
    }
    // `readOptionalBoundedJson(request, 4096, {})`: nothing, or nothing
    // but whitespace, is the empty object.
    let body = match body {
        BodyOutcome::Json(v) => v,
        BodyOutcome::Empty | BodyOutcome::Whitespace => json!({}),
        _ => return json_error(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };
    let (audience, workflow) = focus_and_workflow(cx);

    // The flag, or a workflow that is preparing a handoff. A client hides
    // the button; this is the gate.
    let flag = flags::context_from_db(cx.w.conn)
        .map_err(|e| e.to_string())
        .and_then(|ctx| {
            flags::resolve_flag("flag.settings.admin.export.audit_bundle", &ctx)
                .map_err(|e| format!("{e:?}"))
        });
    match flag {
        Ok(value) if value == "on" || workflow == "other_handoff" => {}
        Ok(_) => {
            return json_error(
                StatusCode::FORBIDDEN,
                "Audit-bundle export is not enabled for your focus",
            )
        }
        Err(e) => {
            diag::log_warn(format!(
                "[/api/export/audit-bundle] flag resolution failed: {e}"
            ));
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not check export permission",
            );
        }
    }

    // `body.recommenderName` on `null` is a TypeError inside Node's try:
    // the one body that fails the build rather than defaulting.
    if body.is_null() {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to build audit bundle",
        );
    }
    let recommender_name = prop(&body, "recommenderName")
        .cloned()
        .unwrap_or(Value::Null);
    let bundle = audit_bundle::build_audit_bundle(
        cx.w.conn,
        cx.now,
        &ExportOptions {
            recommender_name: &recommender_name,
            include_profile: prop(&body, "includeRecommenderProfile") != Some(&json!(false)),
            audience: &audience,
            migration_flow: prop(&body, "migrationFlow") == Some(&json!(true)),
        },
    );
    let bundle = match bundle {
        Ok(bundle) => bundle,
        Err(e) => {
            diag::log_error(format!("[/api/export/audit-bundle] build failed: {e}"));
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to build audit bundle",
            );
        }
    };
    // `buildBundleFilename` calls `.trim()` on the name: anything that is
    // neither a string nor null throws, after the build and before the
    // setting is written.
    let name = match &recommender_name {
        Value::Null => None,
        Value::String(s) => Some(s.as_str()),
        _ => return thrown(),
    };
    let filename = bundle_filename(name, cx.now);
    let Ok(text) = js_json_pretty_vec(&bundle) else {
        return thrown();
    };
    if cx
        .set("audit_bundle_last_exported_at", &cx.now.to_string())
        .is_err()
    {
        return thrown();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        // A bundle is a point-in-time export.
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(text))
        .unwrap_or_else(|_| thrown())
}

// ── POST /api/import/audit-bundle ────────────────────────────────────

/// The uploaded bundle, parsed: the file field of a multipart form, or
/// the JSON body itself.
fn uploaded(body: BodyOutcome, headers: &HeaderMap) -> Result<Value, Response> {
    let not_a_bundle = || json_error(StatusCode::BAD_REQUEST, NOT_A_BUNDLE);
    match body {
        BodyOutcome::Json(v) => Ok(v),
        BodyOutcome::Raw(bytes) => {
            let unreadable =
                || json_error(StatusCode::BAD_REQUEST, "Could not read the uploaded file.");
            let content_type = headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            let boundary = multipart::boundary_of(content_type).ok_or_else(unreadable)?;
            let parts = multipart::parse(&bytes, &boundary).map_err(|_| unreadable())?;
            // `form.get("file")` is the FIRST entry of that name, and it is
            // a File only if its part carried a filename.
            let file = parts
                .into_iter()
                .find(|p| p.name == "file")
                .filter(|p| p.filename.is_some())
                .ok_or_else(|| {
                    json_error(
                        StatusCode::BAD_REQUEST,
                        "No file uploaded. Attach a `.audit.json` file to the `file` form field.",
                    )
                })?;
            if file.body.len() > MAX_AUDIT_BUNDLE_BYTES {
                return Err(json_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    &format!(
                        "Audit bundle is too large ({} > {MAX_AUDIT_BUNDLE_BYTES} bytes).",
                        file.body.len()
                    ),
                ));
            }
            // `file.text()` decodes UTF-8 and drops a byte-order mark; the
            // JSON path below does not, and a BOM there fails to parse.
            let text = String::from_utf8_lossy(&file.body);
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            serde_json::from_str(text).map_err(|_| not_a_bundle())
        }
        _ => Err(not_a_bundle()),
    }
}

/// A key of the preview's `bundle` object: present when the bundle has
/// it, whatever it holds, and absent when it does not — `JSON.stringify`
/// drops an `undefined`.
fn carry(out: &mut Map<String, Value>, bundle: &Map<String, Value>, key: &str) {
    if let Some(v) = bundle.get(key) {
        out.insert(key.to_string(), v.clone());
    }
}

fn import(
    cx: &mut Cx,
    body: BodyOutcome,
    query_string: &[(String, String)],
    headers: &HeaderMap,
) -> Response {
    // `searchParams.get(name) === "1"`: the first occurrence, and only "1".
    let flag = |name: &str| {
        query_string
            .iter()
            .find(|(k, _)| k == name)
            .is_some_and(|(_, v)| v == "1")
    };
    let (confirm, allow_duplicate, force) =
        (flag("confirm"), flag("allowDuplicate"), flag("force"));

    if let Some(response) = body_error_response(&body) {
        return response;
    }
    let parsed = match uploaded(body, headers) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let bundle = match validate_bundle(&parsed, force) {
        Ok(bundle) => bundle,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, &message),
    };
    // Looked up on the preview AND on the commit, so an import that landed
    // between the two is still caught.
    let exported_at = bundle["exported_at"].as_str().unwrap_or("");
    let existing = match find_existing_import(cx.w.conn, exported_at) {
        Ok(existing) => existing,
        Err(_) => return thrown(),
    };

    if !confirm {
        let mut envelope = Map::new();
        for key in [
            "version",
            "app_version",
            "exported_at",
            "recommender_name",
            "exported_by_audience",
        ] {
            carry(&mut envelope, bundle, key);
        }
        let count = |key: &str| bundle[key].as_array().map_or(0, Vec::len);
        envelope.insert("apps_count".into(), json!(count("apps")));
        envelope.insert("annotations_count".into(), json!(count("annotations")));
        envelope.insert(
            "has_recommender_profile".into(),
            json!(bundle.get("recommender_profile").is_some_and(truthy)),
        );
        envelope.insert(
            "recommender_profile_preset".into(),
            bundle
                .get("recommender_profile_preset")
                .cloned()
                .unwrap_or(Value::Null),
        );
        return json_ok(&json!({
            "ok": true,
            "preview": true,
            "bundle": envelope,
            "existingImport": existing,
        }));
    }

    if let Some(existing) = existing.filter(|_| !allow_duplicate) {
        let when = locale_string(existing["importedAt"].as_i64().unwrap_or(0));
        return json_response(
            StatusCode::CONFLICT,
            &json!({
                "ok": false,
                "error": "duplicate",
                "existingImport": existing,
                "message": format!("You already imported this bundle on {when}."),
            }),
        );
    }

    match import_audit_bundle(cx, bundle, allow_duplicate) {
        Ok(summary) => {
            let n = |key: &str| summary[key].as_i64().unwrap_or(0);
            let notes = n("annotationsAdded");
            let line = format!(
                "{} added · {} updated · {} skipped · {notes} note{}",
                n("appsAdded"),
                n("appsUpdated"),
                n("appsSkipped"),
                if notes == 1 { "" } else { "s" }
            );
            let mut detail = summary.as_object().cloned().unwrap_or_default();
            detail.insert("exportedAt".into(), json!(exported_at));
            // Best effort: the data has already landed.
            record_activity(
                cx.w,
                cx.ids,
                cx.now,
                "bundle_imported",
                "ok",
                None,
                Some(&line),
                Some(&Value::Object(detail)),
                cx.now,
            );
            json_ok(&json!({ "ok": true, "preview": false, "summary": summary }))
        }
        Err(message) => {
            diag::log_error(format!(
                "[/api/import/audit-bundle POST] import failed: {message}"
            ));
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                if message.is_empty() {
                    "Failed to import bundle."
                } else {
                    &message
                },
            )
        }
    }
}

// ── GET /api/diagnostics/bundle ──────────────────────────────────────

/// `flagsDiffFromDefaults`: every flag that resolves away from its hard
/// default, or carries an override even if it resolves back to it.
fn flags_diff_from_defaults(conn: &Connection) -> Vec<Value> {
    let Ok(ctx) = flags::context_from_db(conn) else {
        return vec![];
    };
    let rules = flags::rules();
    let mut diffs = Vec::new();
    for key in rules.keys() {
        let hard_default = rules.hard_default(key);
        let Ok(current) = flags::resolve_flag(key, &ctx) else {
            return vec![];
        };
        let overridden = ctx.overrides.get(key);
        if current != hard_default || overridden.is_some() {
            diffs.push(json!({
                "key": key,
                "hardDefault": hard_default,
                "current": current,
                "override": overridden,
            }));
        }
    }
    diffs
}

/// Every diagnostics snapshot the app has, in one object, for a support
/// ticket. Each section is on its own: one that fails is `null` (or its
/// empty shape) and the rest still come back, because whoever is
/// collecting this is probably doing so because something is broken.
pub(super) fn diagnostics_bundle(state: &AppState, headers: &HeaderMap, now: i64) -> Value {
    // Everything that needs the database, under one lock.
    let (sqlite, database, disk, jobs, rate_limits, flag_diff, deployment) = {
        let conn = state.db();
        let layout = super::data_layout();
        let mut database = snapshot_database_health(&conn, &layout.db_path);
        database.integrity_check = last_integrity_check();
        let job = |job| operations::describe_run(&conn, job).unwrap_or(Value::Null);
        (
            sqlite_metrics(&conn),
            serde_json::to_value(&database).unwrap_or(Value::Null),
            snapshot_disk(&conn, &layout.data_dir)
                .ok()
                .and_then(|d| serde_json::to_value(&d).ok())
                .unwrap_or(Value::Null),
            json!({
                "wayback": job(Job::Wayback),
                "sync": job(Job::Sync),
                "policy": job(Job::Policy),
            }),
            operations::cooldowns(&conn, now).unwrap_or(Value::Null),
            flags_diff_from_defaults(&conn),
            build_deployment_diagnostics(state, &conn, headers)
                .ok()
                .and_then(|d| serde_json::to_value(&d).ok())
                .unwrap_or(Value::Null),
        )
    };
    let (os_type, os_release) = uname_parts();
    let memory = host_memory();
    let mb = |bytes: Option<u64>| bytes.map_or(0, |b| (b as f64 / 1024.0 / 1024.0).round() as i64);
    json!({
        "generatedAt": js_iso_string(now),
        "schemaVersion": 3,
        "app": {
            // `process.env.npm_package_version ?? null`: set when the
            // server was started through the package manager.
            "version": crate::host_env::var("npm_package_version").ok(),
            // `process.version`: this server's identity stands in, as it
            // does in the desktop and deployment diagnostics.
            "nodeVersion": format!("pt-core {}", env!("CARGO_PKG_VERSION")),
            "platform": match std::env::consts::OS {
                "macos" => "darwin",
                "windows" => "win32",
                other => other,
            },
            "arch": node_arch(),
        },
        "host": {
            "osType": os_type,
            "osRelease": os_release,
            "totalMemMb": mb(memory.total_bytes),
            "freeMemMb": mb(memory.free_bytes),
            "cpuCount": cpu_count().unwrap_or(0),
            "pid": std::process::id(),
            "uptimeSeconds": state.started_at.elapsed().as_secs_f64().round() as u64,
        },
        "runtime": serde_json::to_value(runtime_diag::build(state, sqlite, None))
            .unwrap_or(Value::Null),
        "database": database,
        "disk": disk,
        "errorLog": serde_json::to_value(diag::error_log_snapshot(Some(50)))
            .unwrap_or_else(|_| json!({ "entries": [], "capacity": 0 })),
        "backgroundJobs": jobs,
        "rateLimits": rate_limits,
        "featureFlagOverrides": flag_diff,
        "deployment": deployment,
    })
}

// ── GET /api/deployment/support-bundle ───────────────────────────────

/// `redactFetchDiagnostics`: six named fields of a failed fetch and
/// nothing else — never the URL, never the body.
fn redact_fetch_diagnostics(detail: Option<&Value>) -> Value {
    let Some(raw) = detail
        .and_then(|d| d.get("fetchDiagnostics"))
        .and_then(Value::as_object)
    else {
        return Value::Null;
    };
    let safe: Map<String, Value> = [
        "httpStatus",
        "contentType",
        "origin",
        "networkHint",
        "troubleshoot",
        "retryAfterMs",
    ]
    .into_iter()
    .filter_map(|key| raw.get(key).map(|v| (key.to_string(), v.clone())))
    .collect();
    if safe.is_empty() {
        Value::Null
    } else {
        Value::Object(safe)
    }
}

/// `readRecentSafeErrors`: the eight newest failed activity rows, down to
/// what is safe to paste into an issue. A failed read is an empty list.
fn recent_safe_errors(conn: &Connection) -> Vec<Value> {
    let rows = query(
        conn,
        "SELECT type, status, detail, started_at, ended_at, duration_ms \
         FROM activity_log WHERE status = 'error' ORDER BY started_at DESC LIMIT 8",
        &[],
    )
    .unwrap_or_default();
    rows.into_iter()
        .map(|row| {
            // A detail that does not parse is no detail.
            let detail: Option<Value> = row["detail"]
                .as_str()
                .filter(|s| !s.is_empty())
                .and_then(|s| serde_json::from_str(s).ok());
            let message = ["errorMessage", "error"].into_iter().find_map(|key| {
                detail
                    .as_ref()
                    .and_then(|d| d.get(key))
                    .and_then(Value::as_str)
            });
            json!({
                "type": row["type"],
                "status": row["status"],
                "startedAt": row["started_at"],
                "endedAt": row["ended_at"],
                "durationMs": row["duration_ms"],
                "errorMessage": message,
                "fetchDiagnostics": redact_fetch_diagnostics(detail.as_ref()),
            })
        })
        .collect()
}

/// A support bundle safe to copy and paste: the deployment diagnostics
/// and the recent errors, with no keys, tokens, app names or full URLs.
pub(super) fn support_bundle(
    state: &AppState,
    headers: &HeaderMap,
    now: i64,
) -> rusqlite::Result<Value> {
    let conn = state.db();
    let diagnostics = build_deployment_diagnostics(state, &conn, headers)?;
    Ok(json!({
        "generatedAt": js_iso_string(now),
        "diagnostics": diagnostics,
        "recentErrors": recent_safe_errors(&conn),
    }))
}

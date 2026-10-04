//! Companion pairing: the read-only tokens the iOS companion app sends as
//! `X-PrivacyTracker-Companion-Token`. Port of lib/companion.ts and
//! lib/companion-gate.ts.
//!
//! A companion token unlocks GET on [`is_companion_route`]'s allowlist and
//! nothing else. The same header on any other path or method is a 403,
//! whatever other credential rides along, so a pairing code never widens
//! another one. Only the SHA-256 of a token is stored; a token never used
//! within [`CLAIM_WINDOW_MS`] stops working; `last_used_at` is written at
//! most once a minute.
//!
//! Node's proxy cannot open SQLite, so it checks an in-memory registry that
//! lib/companion.ts keeps in step with the table. The gate here has no
//! state either, so the check is split in two instead: [`front`] runs
//! just outside the gate with the server's state, looks the token up and
//! leaves a [`CompanionVerdict`] on the request; the gate acts on it at its
//! step 0.6, after the host allowlist and the slash redirect, exactly where
//! proxy.ts acts. A gate that finds the header and no verdict refuses it.
//!
//! The desktop app's Wi-Fi listener (companion_lan.rs) serves the same
//! allowlist through [`required`] instead of the gate: there is no host
//! allowlist to pass on a LAN address, and no other credential to accept.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.

use super::{
    body::{body_error_response, read_json, BodyOutcome},
    guard::{self, AdminRule, GuardOptions},
    json::{json_error, json_response},
    routes_manual::rate_gate,
    AppState,
};
use crate::{
    jsstr::{is_js_whitespace, js_slice_prefix, js_trim},
    scrape::{persist::Writer, Ids, RandomIds},
};
use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::Response,
};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::OnceLock;

pub(crate) const HEADER: &str = "x-privacytracker-companion-token";
const TOKEN_PREFIX: &str = "ptc_";
const SCOPE_READ: &str = "read";
/// 15 minutes: an unused pairing code stops working after this.
pub(crate) const CLAIM_WINDOW_MS: i64 = 15 * 60 * 1000;
/// `last_used_at` is refreshed at most this often per token.
const LAST_USED_RESOLUTION_MS: i64 = 60 * 1000;
const LABEL_MAX: usize = 60;
const INSTANCE_NAME_MAX: usize = 60;
const INSTANCE_NAME_KEY: &str = "companion_instance_name";
/// The name phones see until someone names the instance: the Mac's name in
/// the desktop app (`PRIVACYTRACKER_COMPUTER_NAME`, from the shell), a plain
/// description anywhere else. Mirrors `lib/companion.ts`.
const SERVER_NAME_DEFAULT: &str = "privacytracker server";
const DESKTOP_NAME_FALLBACK: &str = "My Mac";
/// The default before it described the host; it reads as unnamed.
const INSTANCE_NAME_LEGACY: &str = "privacytracker";
const LABEL_DEFAULT: &str = "iPhone";
const MAX_DEVICES: i64 = 20;

const INVALID: &str = "Companion token is not valid. Pair this phone again.";
const OUT_OF_SCOPE: &str =
    "A companion token can only read the app list and its history. It cannot be used here.";
const STATUS_ONLY: &str =
    "This route answers the companion app only. Pair a phone in Settings → Companion.";
const PACKAGE_JSON: &str = include_str!("../../../package.json");

// ── Allowlist and token shape ─────────────────────────────────────────

fn route_patterns() -> &'static [Regex; 5] {
    static PATTERNS: OnceLock<[Regex; 5]> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            Regex::new(r"^/api/companion/status$").expect("static regex"),
            Regex::new(r"^/api/apps$").expect("static regex"),
            Regex::new(r"^/api/apps/\d{1,20}/(?:detail|changelog|since-install|history-stats)$")
                .expect("static regex"),
            Regex::new(r"^/api/changelog$").expect("static regex"),
            Regex::new(r"^/api/triage$").expect("static regex"),
        ]
    })
}

/// `isCompanionRoute`: GET only, on the exact paths the phone reads.
pub(crate) fn is_companion_route(method: &Method, path: &str) -> bool {
    method == Method::GET && route_patterns().iter().any(|re| re.is_match(path))
}

fn is_well_formed(token: &str) -> bool {
    token.len() == 68
        && token.starts_with(TOKEN_PREFIX)
        && token[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_token(token: &str) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, token.as_bytes()).as_ref())
}

fn mint_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
        .map_err(|_| "the system random source failed".to_string())?;
    Ok(format!("{TOKEN_PREFIX}{}", hex(&bytes)))
}

/// `cleanLabel`: whitespace runs collapsed to one space, trimmed, capped at
/// `max` UTF-16 units and trimmed again; empty falls back.
fn clean_label(raw: Option<&str>, fallback: &str, max: usize) -> String {
    let Some(raw) = raw else {
        return fallback.to_string();
    };
    let mut collapsed = String::with_capacity(raw.len());
    let mut in_space = false;
    for c in raw.chars() {
        if is_js_whitespace(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let trimmed = js_trim(&collapsed);
    let capped = js_slice_prefix(trimmed, max);
    let cleaned = js_trim(&capped);
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.to_string()
    }
}

// ── Verification ──────────────────────────────────────────────────────

/// Who a valid companion token belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CompanionDevice {
    pub id: String,
    pub label: String,
}

/// What [`front`] or [`required`] found, for the gate and the status route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CompanionVerdict {
    Allowed(CompanionDevice),
    OutOfScope,
    Invalid,
}

/// `checkCompanionRequest` for a request already on the allowlist: look the
/// token up by its hash and record the use. A lookup by the SHA-256 of a
/// 256-bit random secret leaks nothing a timing attack could use.
fn verify(conn: &Connection, token: &str, now: i64) -> CompanionVerdict {
    let token = js_trim(token);
    if !is_well_formed(token) {
        return CompanionVerdict::Invalid;
    }
    type Row = (String, String, i64, Option<i64>, Option<i64>);
    let row: Option<Row> = conn
        .query_row(
            "SELECT id, label, claim_expires_at, first_used_at, last_used_at
               FROM companion_tokens WHERE token_hash = ?",
            params![hash_token(token)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .unwrap_or(None);
    let Some((id, label, claim_expires_at, first_used_at, last_used_at)) = row else {
        return CompanionVerdict::Invalid;
    };
    if first_used_at.is_none() && now > claim_expires_at {
        return CompanionVerdict::Invalid;
    }
    let stale = match last_used_at {
        Some(last) => now - last >= LAST_USED_RESOLUTION_MS,
        None => true,
    };
    if first_used_at.is_none() || stale {
        if let Err(e) = conn.execute(
            "UPDATE companion_tokens SET first_used_at = COALESCE(first_used_at, ?), last_used_at = ? WHERE id = ?",
            params![now, now, id],
        ) {
            super::diag::log_error(format!("[companion] failed to record a use {e}"));
        }
    }
    CompanionVerdict::Allowed(CompanionDevice { id, label })
}

fn header_token(headers: &HeaderMap) -> Option<String> {
    // A value that is not valid UTF-8 is still a companion request: it is
    // judged (and refused) rather than let through as if absent.
    headers
        .get(HEADER)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
}

/// Runs just outside the gate. For a request carrying the companion header
/// it leaves a [`CompanionVerdict`] for the gate's step 0.6; it never
/// answers the request itself, so the host allowlist and the slash
/// redirect still come first, as in proxy.ts.
pub async fn front(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let Some(token) = header_token(req.headers()) else {
        return next.run(req).await;
    };
    let path = super::gate::next_url_pathname(req.uri().path());
    let verdict = if !is_companion_route(req.method(), &path) {
        CompanionVerdict::OutOfScope
    } else if !super::trust::is_host_allowed(
        super::trust::effective_host(req.headers(), super::trust::trust_proxy()).as_deref(),
    ) {
        // Refused at step 0 with a 400 before the verdict is read; no use
        // is recorded for a request from a host this server won't answer.
        CompanionVerdict::Invalid
    } else {
        let conn = state.db();
        verify(&conn, &token, super::now_ms())
    };
    req.extensions_mut().insert(verdict);
    next.run(req).await
}

/// The Wi-Fi listener's whole gate: the header is required, the allowlist
/// is the only thing it serves, and nothing else is accepted.
pub async fn required(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let Some(token) = header_token(req.headers()) else {
        return refusal(StatusCode::UNAUTHORIZED, INVALID);
    };
    let path = super::gate::next_url_pathname(req.uri().path());
    if !is_companion_route(req.method(), &path) {
        return refusal(StatusCode::FORBIDDEN, OUT_OF_SCOPE);
    }
    let verdict = {
        let conn = state.db();
        verify(&conn, &token, super::now_ms())
    };
    if !matches!(verdict, CompanionVerdict::Allowed(_)) {
        return refusal(StatusCode::UNAUTHORIZED, INVALID);
    }
    req.extensions_mut().insert(verdict);
    no_store(next.run(req).await)
}

/// The gate's answer at step 0.6 for a request carrying the header. `None`
/// means it may pass, skipping the desktop credential, the admin token and
/// the origin check.
pub(crate) fn gate_refusal(req: &Request) -> Option<Response> {
    match req.extensions().get::<CompanionVerdict>() {
        Some(CompanionVerdict::Allowed(_)) => None,
        Some(CompanionVerdict::OutOfScope) => Some(refusal(StatusCode::FORBIDDEN, OUT_OF_SCOPE)),
        // No verdict (a router built without `front`) fails closed.
        _ => Some(refusal(StatusCode::UNAUTHORIZED, INVALID)),
    }
}

fn no_store(mut res: Response) -> Response {
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn refusal(status: StatusCode, message: &str) -> Response {
    no_store(json_error(status, message))
}

/// 404 for a Wi-Fi listener path nothing matched.
pub async fn lan_not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "Not Found")
}

// ── Reads ─────────────────────────────────────────────────────────────

fn default_instance_name() -> String {
    let desktop = crate::host_env::var("PRIVACYTRACKER_RUNTIME").is_ok_and(|v| v == "desktop");
    let computer = crate::host_env::var("PRIVACYTRACKER_COMPUTER_NAME").ok();
    default_instance_name_for(desktop, computer.as_deref())
}

fn default_instance_name_for(desktop: bool, computer: Option<&str>) -> String {
    if desktop {
        clean_label(computer, DESKTOP_NAME_FALLBACK, INSTANCE_NAME_MAX)
    } else {
        SERVER_NAME_DEFAULT.to_string()
    }
}

/// The stored name, unless there is none or it is the legacy default.
fn chosen_instance_name(stored: &str) -> Option<String> {
    let cleaned = clean_label(Some(stored), "", INSTANCE_NAME_MAX);
    (!cleaned.is_empty() && cleaned != INSTANCE_NAME_LEGACY).then_some(cleaned)
}

fn instance_name(conn: &Connection) -> String {
    let stored =
        super::settings::get_setting_with(conn, INSTANCE_NAME_KEY, "").unwrap_or_default();
    chosen_instance_name(&stored).unwrap_or_else(default_instance_name)
}

fn device_json(
    id: &str,
    label: &str,
    scope: &str,
    created_at: i64,
    claim_expires_at: i64,
    first_used_at: Option<i64>,
    last_used_at: Option<i64>,
    now: i64,
) -> Value {
    let state = match first_used_at {
        Some(_) => "active",
        None if now > claim_expires_at => "expired",
        None => "waiting",
    };
    json!({
        "id": id,
        "label": label,
        "scope": scope,
        "createdAt": created_at,
        "claimExpiresAt": claim_expires_at,
        "firstUsedAt": first_used_at,
        "lastUsedAt": last_used_at,
        "state": state,
    })
}

fn listing(conn: &Connection, now: i64) -> rusqlite::Result<Value> {
    let mut stmt = conn.prepare(
        "SELECT id, label, scope, created_at, claim_expires_at, first_used_at, last_used_at
           FROM companion_tokens
          ORDER BY created_at DESC, id",
    )?;
    let devices = stmt
        .query_map([], |r| {
            Ok(device_json(
                &r.get::<_, String>(0)?,
                &r.get::<_, String>(1)?,
                &r.get::<_, String>(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                now,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({
        "instanceName": instance_name(conn),
        "devices": devices,
        "maxDevices": MAX_DEVICES,
        "claimWindowMs": CLAIM_WINDOW_MS,
    }))
}

/// `GET /api/companion`.
pub async fn list(State(state): State<AppState>) -> Response {
    let conn = state.db();
    match listing(&conn, super::now_ms()) {
        Ok(body) => json_response(StatusCode::OK, &body),
        Err(e) => {
            super::diag::log_error(format!("[companion] listing failed {e}"));
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
        }
    }
}

/// `GET /api/companion/status`: the phone's pairing check.
pub async fn status(State(state): State<AppState>, req: Request) -> Response {
    if let Some(limited) = rate_gate(&state, req.headers(), "companion.status", 120, 60_000) {
        return limited;
    }
    if req.headers().get(HEADER).is_none() {
        return json_error(StatusCode::UNAUTHORIZED, STATUS_ONLY);
    }
    let Some(CompanionVerdict::Allowed(device)) = req.extensions().get::<CompanionVerdict>() else {
        return json_error(StatusCode::UNAUTHORIZED, INVALID);
    };
    let conn = state.db();
    let app_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM apps", [], |r| r.get(0))
        .unwrap_or(0);
    let version = serde_json::from_str::<Value>(PACKAGE_JSON)
        .ok()
        .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(str::to_string))
        .unwrap_or_default();
    json_response(
        StatusCode::OK,
        &json!({
            "instanceName": instance_name(&conn),
            "appCount": app_count,
            "version": version,
            "scope": SCOPE_READ,
            "device": { "id": device.id, "label": device.label },
        }),
    )
}

// ── Writes ────────────────────────────────────────────────────────────

fn guard_for(
    state: &AppState,
    conn: &Connection,
    headers: &HeaderMap,
    action: &'static str,
    limit: i64,
    message: Option<&'static str>,
    now: i64,
) -> Result<guard::Actor, Response> {
    let mut w = Writer::new(conn, None);
    guard::require_mutation_guard(
        &mut w,
        &mut RandomIds,
        &state.rate_limiter,
        headers,
        &GuardOptions {
            action,
            key_prefix: action,
            limit,
            window_ms: 60_000,
            message,
            admin: AdminRule::Required,
        },
        now,
    )
}

/// `readBoundedJson`'s refusals.
fn bounded_json(body: BodyOutcome) -> Result<Value, Response> {
    if let Some(response) = body_error_response(&body) {
        return Err(response);
    }
    match body {
        BodyOutcome::Json(v) => Ok(v),
        BodyOutcome::Empty => Err(json_error(StatusCode::BAD_REQUEST, "Request body is empty")),
        _ => Err(json_error(StatusCode::BAD_REQUEST, "Invalid JSON body")),
    }
}

/// `readOptionalBoundedJson(request, limit, {})`.
fn optional_json(body: BodyOutcome) -> Result<Value, Response> {
    if let Some(response) = body_error_response(&body) {
        return Err(response);
    }
    match body {
        BodyOutcome::Json(v) => Ok(v),
        BodyOutcome::Empty | BodyOutcome::Whitespace => Ok(json!({})),
        _ => Err(json_error(StatusCode::BAD_REQUEST, "Invalid JSON body")),
    }
}

/// `PUT /api/companion` — `{ instanceName }`.
pub async fn rename(State(state): State<AppState>, req: Request) -> Response {
    let now = super::now_ms();
    let (parts, body) = req.into_parts();
    {
        let conn = state.db();
        if let Err(response) =
            guard_for(&state, &conn, &parts.headers, "companion.settings", 30, None, now)
        {
            return response;
        }
    }
    let body = match bounded_json(read_json(&parts.headers, body, 4 * 1024).await) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let Some(name) = body.get("instanceName").and_then(Value::as_str) else {
        return json_error(StatusCode::BAD_REQUEST, "instanceName must be a string");
    };
    let conn = state.db();
    // An empty name clears it, so the default applies again.
    let cleaned = clean_label(Some(name), "", INSTANCE_NAME_MAX);
    if let Err(e) = super::settings::set_setting_with(&conn, INSTANCE_NAME_KEY, &cleaned) {
        super::diag::log_error(format!("[companion] rename failed {e}"));
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
    }
    match listing(&conn, now) {
        Ok(body) => json_response(StatusCode::OK, &body),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

/// `POST /api/companion/pairings` — `{ label? }`: mint one token.
pub async fn pair(State(state): State<AppState>, req: Request) -> Response {
    let now = super::now_ms();
    let (parts, body) = req.into_parts();
    let actor = {
        let conn = state.db();
        match guard_for(
            &state,
            &conn,
            &parts.headers,
            "companion.pair",
            10,
            Some("Too many pairing codes. Try again in a minute."),
            now,
        ) {
            Ok(actor) => actor,
            Err(response) => return response,
        }
    };
    let body = match optional_json(read_json(&parts.headers, body, 4 * 1024).await) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let conn = state.db();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM companion_tokens", [], |r| r.get(0))
        .unwrap_or(0);
    if count >= MAX_DEVICES {
        return json_error(
            StatusCode::CONFLICT,
            &format!("{MAX_DEVICES} phones are paired already. Remove one in Settings → Companion first."),
        );
    }
    let label = clean_label(body.get("label").and_then(Value::as_str), LABEL_DEFAULT, LABEL_MAX);
    let mut ids = RandomIds;
    let (id, token) = match (ids.uuid(&conn), mint_token()) {
        (Ok(id), Ok(token)) => (id, token),
        (Err(e), _) | (_, Err(e)) => {
            super::diag::log_error(format!("[companion] pairing failed {e}"));
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
        }
    };
    let claim_expires_at = now + CLAIM_WINDOW_MS;
    if let Err(e) = conn.execute(
        "INSERT INTO companion_tokens
           (id, label, token_hash, scope, created_at, claim_expires_at, first_used_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
        params![id, label, hash_token(&token), SCOPE_READ, now, claim_expires_at],
    ) {
        super::diag::log_error(format!("[companion] pairing failed {e}"));
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
    }
    let mut w = Writer::new(&conn, None);
    let detail = json!({ "id": id, "label": label }).to_string();
    guard::record_audit(
        &mut w,
        &mut ids,
        now,
        "companion.paired",
        &actor,
        Some(&detail),
        true,
    );
    json_response(
        StatusCode::CREATED,
        &json!({
            "device": device_json(&id, &label, SCOPE_READ, now, claim_expires_at, None, None, now),
            "token": token,
        }),
    )
}

/// `DELETE /api/companion/pairings/{id}`.
pub async fn revoke(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let now = super::now_ms();
    let conn = state.db();
    let actor = match guard_for(&state, &conn, &headers, "companion.revoke", 30, None, now) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let label: Option<String> = if !id.is_empty() && crate::jsstr::js_length(&id) <= 64 {
        conn.query_row(
            "SELECT label FROM companion_tokens WHERE id = ?",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None)
    } else {
        None
    };
    let Some(label) = label else {
        return json_error(StatusCode::NOT_FOUND, "No pairing with that id");
    };
    if let Err(e) = conn.execute("DELETE FROM companion_tokens WHERE id = ?", params![id]) {
        super::diag::log_error(format!("[companion] revoke failed {e}"));
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
    }
    let mut w = Writer::new(&conn, None);
    let detail = json!({ "id": id, "label": label }).to_string();
    guard::record_audit(
        &mut w,
        &mut RandomIds,
        now,
        "companion.revoked",
        &actor,
        Some(&detail),
        true,
    );
    json_response(StatusCode::OK, &json!({ "ok": true, "id": id }))
}

// ── The Wi-Fi listener's settings ─────────────────────────────────────

const LAN_ONLY_IN_DESKTOP: &str =
    "Phone connections over Wi-Fi are part of the desktop app's built-in server only.";

/// `GET /api/companion/lan`.
pub async fn lan_get(State(state): State<AppState>) -> Response {
    json_response(StatusCode::OK, &super::companion_lan::describe(&state))
}

/// `PUT /api/companion/lan` — `{ enabled }`.
pub async fn lan_put(State(state): State<AppState>, req: Request) -> Response {
    let now = super::now_ms();
    let (parts, body) = req.into_parts();
    {
        let conn = state.db();
        if let Err(response) =
            guard_for(&state, &conn, &parts.headers, "companion.lan", 10, None, now)
        {
            return response;
        }
    }
    if !super::companion_lan::supported() {
        return json_error(StatusCode::CONFLICT, LAN_ONLY_IN_DESKTOP);
    }
    let body = match bounded_json(read_json(&parts.headers, body, 4 * 1024).await) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let Some(enabled) = body.get("enabled").and_then(Value::as_bool) else {
        return json_error(StatusCode::BAD_REQUEST, "enabled must be true or false");
    };
    super::companion_lan::set_enabled(&state, enabled);
    json_response(StatusCode::OK, &super::companion_lan::describe(&state))
}

#[cfg(test)]
#[path = "companion_tests.rs"]
mod tests;

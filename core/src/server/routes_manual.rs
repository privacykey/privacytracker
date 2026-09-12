//! The two routes the inbound rate limiter was blocking:
//! `GET /api/manual-apps` and `GET /api/import/audit-bundle/recent`.
//!
//! Both call `checkRateLimit` before doing any work, which is why they waited
//! for `ratelimit.rs` rather than being ported with the limiter faked out.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde::Serialize;
use std::collections::HashMap;

use super::json::{json_error, json_ok};
use super::now_ms;
use super::ratelimit::key_for_request;
use super::AppState;
use crate::jsnum::js_parse_int;

fn hdr<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

/// Shared gate: returns the 429 response when the limit is tripped.
fn rate_gate(
    state: &AppState,
    headers: &HeaderMap,
    prefix: &str,
    limit: i64,
    window_ms: i64,
) -> Option<Response> {
    let key = key_for_request(
        hdr(headers, "x-forwarded-for"),
        hdr(headers, "x-real-ip"),
        prefix,
    );
    let verdict = state.rate_limiter.check(&key, limit, window_ms, now_ms());
    if verdict.allowed {
        None
    } else {
        Some(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Rate limit exceeded",
        ))
    }
}

// ── /api/manual-apps ─────────────────────────────────────────────────

#[derive(Serialize)]
struct ManualApp {
    id: String,
    name: String,
    source: String,
    developer: Option<String>,
    #[serde(rename = "privacyPolicyUrl")]
    privacy_policy_url: Option<String>,
    #[serde(rename = "sourceUrl")]
    source_url: Option<String>,
    notes: Option<String>,
    #[serde(rename = "firstSeen")]
    first_seen: i64,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
}

/// One entry of the hard-coded source metadata table. Field order matches the
/// Node object literal; the strings are copied verbatim, including the emoji
/// and the ellipsis characters in the placeholders.
#[derive(Serialize)]
struct SourceMeta {
    value: &'static str,
    label: &'static str,
    #[serde(rename = "shortLabel")]
    short_label: &'static str,
    icon: &'static str,
    description: &'static str,
    #[serde(rename = "supportsSourceUrl")]
    supports_source_url: bool,
    #[serde(rename = "sourceUrlPlaceholder")]
    source_url_placeholder: &'static str,
}

const MANUAL_APP_SOURCES: [&str; 4] = ["web_clip", "testflight", "own_build", "sideloaded"];

/// `MANUAL_APP_SOURCE_META`, emitted in `MANUAL_APP_SOURCES` order because
/// the route maps over that array rather than over the object.
fn source_meta() -> Vec<SourceMeta> {
    vec![
        SourceMeta {
            value: "web_clip",
            label: "Safari web app",
            short_label: "Web app",
            icon: "🔖",
            description: "A website added to your Home Screen as a web clip. No App Store listing or privacy labels exist — only what the site itself publishes.",
            supports_source_url: true,
            source_url_placeholder: "https://example.com",
        },
        SourceMeta {
            value: "testflight",
            label: "TestFlight beta",
            short_label: "TestFlight",
            icon: "🧪",
            description: "An app installed via an Apple TestFlight invite. The production build may eventually ship to the App Store; until then you manage the privacy context manually.",
            supports_source_url: true,
            source_url_placeholder: "https://testflight.apple.com/join/…",
        },
        SourceMeta {
            value: "own_build",
            label: "Personal build",
            short_label: "Personal",
            icon: "🛠",
            description: "An app you (or a developer you know) built and side-loaded via Xcode. Link the source repository if it is public so reviewers can inspect it.",
            supports_source_url: true,
            source_url_placeholder: "https://github.com/you/app-repo",
        },
        SourceMeta {
            value: "sideloaded",
            label: "Sideloaded",
            short_label: "Sideloaded",
            icon: "📦",
            description: "An app installed from a third-party marketplace (EU DMA store, AltStore, enterprise deployment, etc.). The App Store is no longer the source of truth for its privacy posture.",
            supports_source_url: true,
            source_url_placeholder: "https://store.example/app/…",
        },
    ]
}

#[derive(Serialize)]
struct ManualAppsBody {
    apps: Vec<ManualApp>,
    sources: Vec<SourceMeta>,
}

pub async fn manual_apps(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(denied) = rate_gate(&state, &headers, "manual-apps.list", 120, 60_000) {
        return denied;
    }

    let conn = state.conn.lock().expect("db mutex poisoned");
    let listed = (|| -> rusqlite::Result<Vec<ManualApp>> {
        // COLLATE NOCASE is ASCII-only in SQLite, and both backends run
        // SQLite, so the ordering matches without extra work here.
        let mut stmt = conn.prepare(
            "SELECT id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at \
             FROM manual_apps ORDER BY updated_at DESC, name COLLATE NOCASE ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let raw_source: String = row.get("source")?;
                Ok(ManualApp {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    // An unknown source (e.g. a downgrade after a newer
                    // version added a flavour) falls back to the catch-all
                    // rather than erroring the whole list.
                    source: if MANUAL_APP_SOURCES.contains(&raw_source.as_str()) {
                        raw_source
                    } else {
                        "sideloaded".to_string()
                    },
                    developer: row.get("developer")?,
                    privacy_policy_url: row.get("privacy_policy_url")?,
                    source_url: row.get("source_url")?,
                    notes: row.get("notes")?,
                    first_seen: row.get("first_seen")?,
                    updated_at: row.get("updated_at")?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })();

    match listed {
        Ok(apps) => json_ok(&ManualAppsBody {
            apps,
            sources: source_meta(),
        }),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

// ── /api/import/audit-bundle/recent ──────────────────────────────────

const DEFAULT_WITHIN_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_WITHIN_MS: i64 = 365 * 24 * 60 * 60 * 1000;

#[derive(Serialize)]
struct RecentImport {
    #[serde(rename = "importedAt")]
    imported_at: i64,
    #[serde(rename = "recommenderName")]
    recommender_name: Option<String>,
    #[serde(rename = "appsTotal")]
    apps_total: i64,
    #[serde(rename = "appsAdded")]
    apps_added: i64,
    #[serde(rename = "appsUpdated")]
    apps_updated: i64,
    #[serde(rename = "appsSkipped")]
    apps_skipped: i64,
    #[serde(rename = "annotationsAdded")]
    annotations_added: i64,
}

#[derive(Serialize)]
struct RecentBody {
    // Present-null: `{"recent": null}` when nothing is in the window.
    recent: Option<RecentImport>,
}

pub async fn audit_bundle_recent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Some(denied) = rate_gate(&state, &headers, "audit-bundle.recent", 120, 60_000) {
        return denied;
    }

    // The param is validated only when PRESENT. Node checks `raw !== null`,
    // so an empty `?withinMs=` IS present and fails validation — unlike the
    // truthiness checks elsewhere in this API.
    let mut within_ms = DEFAULT_WITHIN_MS;
    if let Some(raw) = q.get("withinMs") {
        match js_parse_int(raw) {
            Some(parsed) if parsed > 0 && parsed <= MAX_WITHIN_MS => within_ms = parsed,
            _ => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    &format!("withinMs must be an integer in 1..{MAX_WITHIN_MS}"),
                );
            }
        }
    }

    let cutoff = now_ms() - within_ms;
    let conn = state.conn.lock().expect("db mutex poisoned");
    let found = conn
        .query_row(
            "SELECT imported_at, recommender_name, apps_total, apps_added, apps_updated, \
             apps_skipped, annotations_added FROM audit_bundle_imports \
             WHERE imported_at >= ? ORDER BY imported_at DESC LIMIT 1",
            [cutoff],
            |row| {
                Ok(RecentImport {
                    imported_at: row.get("imported_at")?,
                    recommender_name: row.get("recommender_name")?,
                    apps_total: row.get("apps_total")?,
                    apps_added: row.get("apps_added")?,
                    apps_updated: row.get("apps_updated")?,
                    apps_skipped: row.get("apps_skipped")?,
                    annotations_added: row.get("annotations_added")?,
                })
            },
        )
        .ok();

    // Node wraps the read in try/catch and answers 200 {"recent": null} on
    // failure, so a query error must NOT become a 500 here.
    json_ok(&RecentBody { recent: found })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_metadata_is_emitted_in_declared_order() {
        let metas = source_meta();
        let values: Vec<&str> = metas.iter().map(|m| m.value).collect();
        assert_eq!(values, MANUAL_APP_SOURCES.to_vec());
    }

    #[test]
    fn source_metadata_field_order_matches_node() {
        let one = &source_meta()[0];
        let json = serde_json::to_string(one).unwrap();
        // Key ORDER is part of the contract, so assert the serialised prefix
        // rather than just the values.
        assert!(
            json.starts_with(r#"{"value":"web_clip","label":"Safari web app","shortLabel":"Web app","icon":"🔖","description":"#),
            "unexpected key order or content: {json}"
        );
        assert!(json.ends_with(
            r#""supportsSourceUrl":true,"sourceUrlPlaceholder":"https://example.com"}"#
        ));
    }

    #[test]
    fn within_ms_bounds() {
        // Mirrors the route's guard: > 0 and <= MAX, else 400.
        let ok = |n: i64| n > 0 && n <= MAX_WITHIN_MS;
        assert!(ok(1));
        assert!(ok(MAX_WITHIN_MS));
        assert!(!ok(0));
        assert!(!ok(-1));
        assert!(!ok(MAX_WITHIN_MS + 1));
    }
}

//! Batch 1 of the read-only API.
//!
//! Every struct below declares its fields in the order the Node route's
//! object literal writes them, because `serde`'s derive emits declaration
//! order and the parity differ compares key order (`JSON.parse` preserves
//! insertion order; `JSON.stringify` replays it).
//!
//! Nullable fields default to serialising `null` — Node's `JSON.stringify`
//! keeps `null` and drops `undefined`, and the differ treats those as
//! different. `skip_serializing_if` is therefore opt-in per field, only where
//! the Node source has been read and confirmed to produce `undefined`.

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use rusqlite::OptionalExtension;
use serde::Serialize;

use super::auth::{admin_token_configured, request_has_valid_admin_token};
use super::json::{json_ok, json_response};
use super::settings::get_setting;
use super::AppState;

// ── /api/health ──────────────────────────────────────────────────────
// A DB ping, deliberately NOT touching /api/apps (that route reveals what
// the user tracks, and a liveness probe must not be an oracle for it).
// Failure is 503, not 500 — it is the container HEALTHCHECK contract.

#[derive(Serialize)]
struct HealthBody {
    status: &'static str,
}

pub async fn health(State(state): State<AppState>) -> Response {
    let ok = {
        let conn = state.conn.lock().expect("db mutex poisoned");
        conn.query_row("SELECT 1 as ok", [], |row| row.get::<_, i64>(0))
            .optional()
    };
    match ok {
        Ok(Some(1)) => json_ok(&HealthBody { status: "ok" }),
        _ => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            &HealthBody { status: "degraded" },
        ),
    }
}

// ── /api/auth/admin-token/status ─────────────────────────────────────
// Never returns the token. `configured` is env-driven, so both servers must
// run with an identical AUDITOR_ADMIN_TOKEN or this route diffs for reasons
// that have nothing to do with the port.

#[derive(Serialize)]
struct AdminTokenStatus {
    configured: bool,
    unlocked: bool,
}

pub async fn admin_token_status(headers: HeaderMap) -> Response {
    let header_token = headers
        .get("x-auditor-admin-token")
        .and_then(|v| v.to_str().ok());
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    json_ok(&AdminTokenStatus {
        configured: admin_token_configured(),
        unlocked: request_has_valid_admin_token(header_token, cookie),
    })
}

// ── /api/locale ──────────────────────────────────────────────────────
// No database at all: a cookie read against a compile-time constant.
// `locale` and `explicitlySet` can legitimately disagree — an unsupported
// cookie value yields {"locale":"en","explicitlySet":false} — so they are
// computed independently rather than derived from one another.

const SUPPORTED_LOCALES: [&str; 2] = ["en", "zh"];
const DEFAULT_LOCALE: &str = "en";
const LOCALE_COOKIE: &str = "NEXT_LOCALE";

fn is_supported_locale(v: Option<&str>) -> bool {
    matches!(v, Some(v) if SUPPORTED_LOCALES.contains(&v))
}

/// Read one cookie value by name. Next returns the FIRST occurrence.
fn cookie_value<'a>(cookie_header: Option<&'a str>, name: &str) -> Option<&'a str> {
    for part in cookie_header.unwrap_or("").split(';') {
        let sep = part.find('=')?;
        if part[..sep].trim() == name {
            return Some(part[sep + 1..].trim());
        }
    }
    None
}

#[derive(Serialize)]
struct LocaleBody {
    locale: String,
    #[serde(rename = "explicitlySet")]
    explicitly_set: bool,
    supported: Vec<&'static str>,
}

pub async fn locale(headers: HeaderMap) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let raw = cookie_value(cookie, LOCALE_COOKIE);
    let supported = is_supported_locale(raw);
    json_ok(&LocaleBody {
        locale: if supported {
            raw.unwrap_or(DEFAULT_LOCALE).to_string()
        } else {
            DEFAULT_LOCALE.to_string()
        },
        explicitly_set: supported,
        supported: SUPPORTED_LOCALES.to_vec(),
    })
}

// ── /api/date-format ─────────────────────────────────────────────────
// The read is wrapped in try/catch in Node: a SQLite failure returns HTTP
// 200 {"mode":"auto"}, never a 500. A Rust `?` here would be wrong.

#[derive(Serialize)]
struct DateFormatBody {
    mode: &'static str,
}

/// Port of `normaliseDateFormat`: exact, case-sensitive, no trimming.
fn normalise_date_format(raw: &str) -> &'static str {
    match raw {
        "dmy" => "dmy",
        "mdy" => "mdy",
        "iso" => "iso",
        "auto" => "auto",
        _ => "auto",
    }
}

pub async fn date_format(State(state): State<AppState>) -> Response {
    // Errors are swallowed to the default, mirroring the Node try/catch.
    let raw = get_setting(&state, "date_format", "").unwrap_or_default();
    json_ok(&DateFormatBody {
        mode: normalise_date_format(&raw),
    })
}

// ── /api/preferences ─────────────────────────────────────────────────
// The flag is "is the stored timestamp string non-empty after trimming",
// not a boolean parse — the column holds a dismissal timestamp.

#[derive(Serialize)]
struct PreferencesBody {
    #[serde(rename = "manualAppsBannerDismissed")]
    manual_apps_banner_dismissed: bool,
}

pub async fn preferences(State(state): State<AppState>) -> Response {
    let raw = get_setting(&state, "manual_apps_banner_dismissed_at", "").unwrap_or_default();
    json_ok(&PreferencesBody {
        manual_apps_banner_dismissed: !raw.trim().is_empty(),
    })
}

// ── /api/coachmark-state and /api/dev-menu-state ─────────────────────
// Structurally identical, deliberately kept as two functions: the field
// names differ ("completed" vs "enabled") and folding them into one shared
// helper is exactly the refactor that silently swaps them.

#[derive(Serialize)]
struct CoachmarkBody {
    completed: bool,
}

pub async fn coachmark_state(State(state): State<AppState>) -> Response {
    let raw = get_setting(&state, "coachmark_tour_done", "false").unwrap_or_default();
    json_ok(&CoachmarkBody {
        completed: raw == "true",
    })
}

#[derive(Serialize)]
struct DevMenuBody {
    enabled: bool,
}

pub async fn dev_menu_state(State(state): State<AppState>) -> Response {
    let raw = get_setting(&state, "dev_menu_enabled", "false").unwrap_or_default();
    json_ok(&DevMenuBody {
        enabled: raw == "true",
    })
}

// ── /api/privacy-profile and /api/accessibility-profile ──────────────
// Both re-emit a stored JSON blob filtered against an allowlist, PRESERVING
// the stored key order. That is why serde_json is built with
// `preserve_order`: the default BTreeMap-backed Map would alphabetise and
// fail the differ.
//
// parseStoredProfile returns null when the raw string is empty, unparseable,
// or not a non-array object; otherwise a filtered object that may be empty.
// So `{}` (stored empty object) and `null` (absent/garbage) are DIFFERENT
// responses and the differ can tell them apart.

pub(super) const PROFILE_CATEGORY_KEYS: [&str; 14] = [
    "CONTACT_INFO",
    "HEALTH_AND_FITNESS",
    "FINANCIAL_INFO",
    "LOCATION",
    "SENSITIVE_INFO",
    "CONTACTS",
    "USER_CONTENT",
    "BROWSING_HISTORY",
    "SEARCH_HISTORY",
    "IDENTIFIERS",
    "PURCHASES",
    "USAGE_DATA",
    "DIAGNOSTICS",
    "OTHER",
];
pub(super) const PROFILE_TIERS: [&str; 4] = ["not_collected", "not_linked", "linked", "tracking"];

pub(super) const A11Y_FEATURE_KEYS: [&str; 9] = [
    "voiceover",
    "voice_control",
    "larger_text",
    "dark_interface",
    "differentiate_without_color_alone",
    "sufficient_contrast",
    "reduced_motion",
    "captions",
    "audio_descriptions",
];
pub(super) const A11Y_PREFERENCES: [&str; 2] = ["required", "nice"];

/// Shared port of parseStoredProfile / parseStoredA11yProfile — identical
/// logic over different allowlists.
pub(super) fn parse_stored_profile(
    raw: &str,
    allowed_keys: &[&str],
    allowed_values: &[&str],
) -> Option<serde_json::Value> {
    if raw.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = match parsed {
        serde_json::Value::Object(o) => o,
        // Arrays and scalars are rejected, exactly as the `!parsed ||
        // typeof !== object || Array.isArray` guard does.
        _ => return None,
    };
    // Iterating the parsed Map preserves the stored insertion order because
    // serde_json is built with `preserve_order`.
    let mut out = serde_json::Map::new();
    for (key, value) in obj {
        if !allowed_keys.contains(&key.as_str()) {
            continue;
        }
        let Some(s) = value.as_str() else { continue };
        if !allowed_values.contains(&s) {
            continue;
        }
        out.insert(key, value);
    }
    Some(serde_json::Value::Object(out))
}

#[derive(Serialize)]
struct ProfileBody {
    // Present-null, never absent: Node emits `{"profile": null}`.
    profile: Option<serde_json::Value>,
}

pub async fn privacy_profile(State(state): State<AppState>) -> Response {
    let raw = get_setting(&state, "privacy_profile", "").unwrap_or_default();
    json_ok(&ProfileBody {
        profile: parse_stored_profile(&raw, &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS),
    })
}

pub async fn accessibility_profile(State(state): State<AppState>) -> Response {
    let raw = get_setting(&state, "accessibility_profile", "").unwrap_or_default();
    json_ok(&ProfileBody {
        profile: parse_stored_profile(&raw, &A11Y_FEATURE_KEYS, &A11Y_PREFERENCES),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_format_is_exact_and_case_sensitive() {
        assert_eq!(normalise_date_format("iso"), "iso");
        assert_eq!(normalise_date_format("ISO"), "auto");
        assert_eq!(normalise_date_format(" iso"), "auto");
        assert_eq!(normalise_date_format(""), "auto");
    }

    #[test]
    fn stored_profile_preserves_key_order_and_filters() {
        let raw =
            r#"{"LOCATION":"linked","BOGUS":"linked","CONTACT_INFO":"tracking","OTHER":"nope"}"#;
        let v = parse_stored_profile(raw, &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS).unwrap();
        // Unknown key dropped, bad value dropped, STORED order preserved
        // (LOCATION before CONTACT_INFO, which is not the canonical order).
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"LOCATION":"linked","CONTACT_INFO":"tracking"}"#
        );
    }

    #[test]
    fn stored_profile_null_vs_empty_object_are_distinct() {
        // Absent / unparseable / non-object → null
        assert!(parse_stored_profile("", &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS).is_none());
        assert!(parse_stored_profile("not json", &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS).is_none());
        assert!(parse_stored_profile("[]", &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS).is_none());
        assert!(parse_stored_profile("3", &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS).is_none());
        // Stored empty object → {} , which is NOT null
        let v = parse_stored_profile("{}", &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS).unwrap();
        assert_eq!(serde_json::to_string(&v).unwrap(), "{}");
    }

    #[test]
    fn cookie_parsing_takes_the_first_match() {
        assert_eq!(
            cookie_value(Some("a=1; NEXT_LOCALE=zh; b=2"), "NEXT_LOCALE"),
            Some("zh")
        );
        assert_eq!(
            cookie_value(Some(" NEXT_LOCALE = en "), "NEXT_LOCALE"),
            Some("en")
        );
        assert_eq!(cookie_value(Some("other=1"), "NEXT_LOCALE"), None);
        assert_eq!(cookie_value(None, "NEXT_LOCALE"), None);
    }

    #[test]
    fn unsupported_locale_cookie_is_not_explicitly_set() {
        // The pair must be able to disagree: an unsupported value falls back
        // to "en" while explicitlySet stays false.
        assert!(!is_supported_locale(Some("EN")));
        assert!(!is_supported_locale(Some(" en")));
        assert!(is_supported_locale(Some("en")));
        assert!(is_supported_locale(Some("zh")));
        assert!(!is_supported_locale(None));
    }
}

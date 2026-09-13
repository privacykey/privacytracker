//! The settings-backed reads: `GET /api/settings`, `GET /api/settings/desktop`,
//! `GET /api/dashboard/layout` and `GET /api/feature-flags`.
//!
//! Three of the four are `app_settings` reads dressed in a coercion each;
//! the fourth runs the flag resolver (`flags.rs`). What they share is that
//! the differ sees each of them on ONE database state, so every coercion
//! below is also pinned on its own — by unit tests here, by
//! `tests/settings_cases.rs` replaying the generated fixture, and by the
//! fixture rows `read-parity.mjs` writes before it copies the database.
//!
//! `/api/settings/desktop` is the first GET in this server that WRITES:
//! `markDesktopRuntimeIfTrusted` upserts `runtime_environment = "desktop"`
//! when the process env or the `x-privacytracker-runtime` header says so.
//! It is ported as it is, because the flag resolver reads that row back,
//! and a Rust server that never wrote it would resolve two flags
//! differently from Node on every desktop boot.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde::Serialize;
use serde_json::Value;

use super::auth::admin_token_configured;
use super::flags::{build_rows, context_from_db, FlagRow};
use super::json::{json_error, json_ok};
use super::layout::read_layout_with_match;
use super::routes_detail::normalize_ai_provider;
use super::settings::{get_setting_with, set_setting_with};
use super::trust::is_network_exposed;
use super::webhook::mask_webhook_url;
use super::AppState;
use crate::jsnum::{js_number, js_parse_float, js_parse_int};

fn internal_error() -> Response {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

// ── /api/settings ────────────────────────────────────────────────────
// Thirty-two keys, in the route literal's order. Every value is a raw
// `getSetting` string except where the literal coerces it, and the two
// secrets (`ai_api_key`, `notification_webhook_url`) are masked — the
// second through the URL parser in `webhook.rs`.

#[derive(Serialize)]
struct SettingsBody {
    sync_schedule: String,
    last_auto_sync: String,
    sync_running: String,
    app_country: String,
    app_country_explicit: bool,
    ai_provider: &'static str,
    ai_api_key: &'static str,
    ai_api_key_set: bool,
    ai_base_url: String,
    ai_model: String,
    ai_summarize_on_import: String,
    ai_debug_logging: String,
    ai_timeout_direct_ms: String,
    ai_timeout_chunk_ms: String,
    ai_timeout_merge_ms: String,
    policy_diff_alert_days: String,
    policy_scrape_throttle_enabled: bool,
    policy_scrape_throttle_minutes: String,
    policy_scrape_disabled: bool,
    wayback_show_imported: bool,
    track_accessibility_labels: bool,
    queue_show_progress_bar: bool,
    cfgutil_imported_at: String,
    notification_webhook_url: String,
    notification_webhook_url_set: bool,
    notification_webhook_format: String,
    notification_webhook_frequency: String,
    notification_quiet_hours_start: String,
    notification_quiet_hours_end: String,
    background_wizard_completed_at: String,
    background_wizard_dismissed_at: String,
    admin_token_required: bool,
}

const DEFAULT_COUNTRY: &str = "us";
const MASKED_SECRET_VALUE: &str = "__SET__";

pub async fn settings(State(state): State<AppState>) -> Response {
    let conn = state.conn.lock().expect("db mutex poisoned");
    let body = (|| -> rusqlite::Result<SettingsBody> {
        let get = |key: &str, default: &str| get_setting_with(&conn, key, default);

        let stored_key = get("ai_api_key", "")?;
        let stored_country = get("app_country", "")?;
        let stored_webhook_url = get("notification_webhook_url", "")?;

        Ok(SettingsBody {
            sync_schedule: get("sync_schedule", "manual")?,
            last_auto_sync: get("last_auto_sync", "0")?,
            sync_running: get("sync_running", "false")?,
            // `storedCountry || DEFAULT_COUNTRY` and `!!storedCountry`: both
            // are emptiness tests, so they agree — unlike the focus route's
            // audience pair, which reads one key two ways.
            app_country: if stored_country.is_empty() {
                DEFAULT_COUNTRY.to_string()
            } else {
                stored_country.clone()
            },
            app_country_explicit: !stored_country.is_empty(),
            ai_provider: normalize_ai_provider(&get("ai_provider", "disabled")?),
            ai_api_key: if stored_key.is_empty() {
                ""
            } else {
                MASKED_SECRET_VALUE
            },
            ai_api_key_set: !stored_key.is_empty(),
            ai_base_url: get("ai_base_url", "")?,
            ai_model: get("ai_model", "")?,
            ai_summarize_on_import: get("ai_summarize_on_import", "false")?,
            ai_debug_logging: get("ai_debug_logging", "false")?,
            ai_timeout_direct_ms: get("ai_timeout_direct_ms", "")?,
            ai_timeout_chunk_ms: get("ai_timeout_chunk_ms", "")?,
            ai_timeout_merge_ms: get("ai_timeout_merge_ms", "")?,
            policy_diff_alert_days: get("policy_diff_alert_days", "90")?,
            // Three `!== "false"` reads and one `=== "true"`: only the exact
            // lowercase literal flips each of them.
            policy_scrape_throttle_enabled: get("policy_scrape_throttle_enabled", "true")?
                != "false",
            policy_scrape_throttle_minutes: get("policy_scrape_throttle_minutes", "60")?,
            policy_scrape_disabled: get("policy_scrape_disabled", "false")? == "true",
            wayback_show_imported: get("wayback_show_imported", "true")? != "false",
            track_accessibility_labels: get("track_accessibility_labels", "true")? != "false",
            queue_show_progress_bar: get("queue_show_progress_bar", "true")? != "false",
            cfgutil_imported_at: get("cfgutil_imported_at", "")?,
            notification_webhook_url: mask_webhook_url(&stored_webhook_url),
            notification_webhook_url_set: !stored_webhook_url.is_empty(),
            notification_webhook_format: get("notification_webhook_format", "generic")?,
            notification_webhook_frequency: get("notification_webhook_frequency", "immediate")?,
            notification_quiet_hours_start: get("notification_quiet_hours_start", "")?,
            notification_quiet_hours_end: get("notification_quiet_hours_end", "")?,
            background_wizard_completed_at: get("background_wizard_completed_at", "")?,
            background_wizard_dismissed_at: get("background_wizard_dismissed_at", "")?,
            // `adminTokenRequiredForRequest(request)` ignores its argument.
            admin_token_required: admin_token_configured() || is_network_exposed(),
        })
    })();
    match body {
        Ok(body) => json_ok(&body),
        Err(_) => internal_error(),
    }
}

// ── /api/settings/desktop ────────────────────────────────────────────
// Eleven `desktop_*` rows, each decoded by type and each falling back to
// its default on an EMPTY row — and, for the three validated ones, on a
// value outside its allowlist or range. Booleans are `raw === "true"`, so
// `"TRUE"` is false. The body repeats every field under its `desktop_*`
// alias, after the short names, in the same order.

#[derive(Serialize)]
struct DesktopBody {
    hide_dock: bool,
    launch_hidden: bool,
    autostart: bool,
    native_notifications: bool,
    global_shortcut: String,
    require_unlock: bool,
    auto_lock_idle_minutes: i64,
    theme_override: String,
    devtools_open: bool,
    tray_visible: bool,
    zoom_level: Value,
    desktop_hide_dock: bool,
    desktop_launch_hidden: bool,
    desktop_autostart: bool,
    desktop_native_notifications: bool,
    desktop_global_shortcut: String,
    desktop_require_unlock: bool,
    desktop_auto_lock_idle_minutes: i64,
    desktop_theme_override: String,
    desktop_devtools_open: bool,
    desktop_tray_visible: bool,
    desktop_zoom_level: Value,
}

const DEFAULT_GLOBAL_SHORTCUT: &str = "CmdOrCtrl+Shift+P";
const DEFAULT_AUTO_LOCK_IDLE_MINUTES: i64 = 15;
const DEFAULT_THEME_OVERRIDE: &str = "system";
const DEFAULT_ZOOM_LEVEL: f64 = 1.0;
const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 3.0;

/// The boolean arm of `readSetting`: empty → default, else `=== "true"`.
fn desktop_bool(raw: &str, default: bool) -> bool {
    if raw.is_empty() {
        default
    } else {
        raw == "true"
    }
}

/// `auto_lock_idle_minutes`: `Number.parseInt`, finite, `0..=1440`.
fn desktop_auto_lock(raw: &str) -> i64 {
    if raw.is_empty() {
        return DEFAULT_AUTO_LOCK_IDLE_MINUTES;
    }
    match js_parse_int(raw) {
        Some(n) if (0..=1440).contains(&n) => n,
        _ => DEFAULT_AUTO_LOCK_IDLE_MINUTES,
    }
}

/// `theme_override`: exact, case-sensitive membership.
fn desktop_theme(raw: &str) -> String {
    match raw {
        "system" | "light" | "dark" => raw.to_string(),
        _ => DEFAULT_THEME_OVERRIDE.to_string(),
    }
}

/// `zoom_level`: `Number.parseFloat`, finite, `0.5..=3.0`. Serialised as a
/// JavaScript number — `1`, not `1.0`.
fn desktop_zoom(raw: &str) -> f64 {
    if raw.is_empty() {
        return DEFAULT_ZOOM_LEVEL;
    }
    let z = js_parse_float(raw);
    if z.is_finite() && (ZOOM_MIN..=ZOOM_MAX).contains(&z) {
        z
    } else {
        DEFAULT_ZOOM_LEVEL
    }
}

pub async fn desktop_settings(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let conn = state.conn.lock().expect("db mutex poisoned");

    // markDesktopRuntimeIfTrusted. Next's `headers.get` joins repeated
    // headers with ", "; axum's returns the first. A client sending the
    // header twice is not a case either side is written for.
    let header_says_desktop = headers
        .get("x-privacytracker-runtime")
        .and_then(|v| v.to_str().ok())
        == Some("desktop");
    let env_says_desktop = std::env::var("PRIVACYTRACKER_RUNTIME").as_deref() == Ok("desktop");
    if (header_says_desktop || env_says_desktop)
        && set_setting_with(&conn, "runtime_environment", "desktop").is_err()
    {
        return internal_error();
    }

    let body = (|| -> rusqlite::Result<DesktopBody> {
        let get = |key: &str| get_setting_with(&conn, key, "");
        let hide_dock = desktop_bool(&get("desktop_hide_dock")?, false);
        let launch_hidden = desktop_bool(&get("desktop_launch_hidden")?, false);
        let autostart = desktop_bool(&get("desktop_autostart")?, false);
        let native_notifications = desktop_bool(&get("desktop_native_notifications")?, true);
        let global_shortcut = {
            let raw = get("desktop_global_shortcut")?;
            if raw.is_empty() {
                DEFAULT_GLOBAL_SHORTCUT.to_string()
            } else {
                raw
            }
        };
        let require_unlock = desktop_bool(&get("desktop_require_unlock")?, false);
        let auto_lock_idle_minutes = desktop_auto_lock(&get("desktop_auto_lock_idle_minutes")?);
        let theme_override = desktop_theme(&get("desktop_theme_override")?);
        let devtools_open = desktop_bool(&get("desktop_devtools_open")?, false);
        let tray_visible = desktop_bool(&get("desktop_tray_visible")?, true);
        let zoom_level = js_number(desktop_zoom(&get("desktop_zoom_level")?));
        Ok(DesktopBody {
            hide_dock,
            launch_hidden,
            autostart,
            native_notifications,
            global_shortcut: global_shortcut.clone(),
            require_unlock,
            auto_lock_idle_minutes,
            theme_override: theme_override.clone(),
            devtools_open,
            tray_visible,
            zoom_level: zoom_level.clone(),
            desktop_hide_dock: hide_dock,
            desktop_launch_hidden: launch_hidden,
            desktop_autostart: autostart,
            desktop_native_notifications: native_notifications,
            desktop_global_shortcut: global_shortcut,
            desktop_require_unlock: require_unlock,
            desktop_auto_lock_idle_minutes: auto_lock_idle_minutes,
            desktop_theme_override: theme_override,
            desktop_devtools_open: devtools_open,
            desktop_tray_visible: tray_visible,
            desktop_zoom_level: zoom_level,
        })
    })();
    match body {
        Ok(body) => json_ok(&body),
        Err(_) => internal_error(),
    }
}

// ── /api/dashboard/layout ────────────────────────────────────────────

pub async fn dashboard_layout(State(state): State<AppState>) -> Response {
    let conn = state.conn.lock().expect("db mutex poisoned");
    match read_layout_with_match(&conn) {
        Ok(body) => json_ok(&body),
        Err(_) => internal_error(),
    }
}

// ── /api/feature-flags ───────────────────────────────────────────────
// The one route here with a try/catch of its own: any failure — a database
// error or the resolver throwing on a garbage audience — is a 500 with
// this exact body, not Next's generic one.

#[derive(Serialize)]
struct FlagsBody {
    flags: Vec<FlagRow>,
}

pub async fn feature_flags(State(state): State<AppState>) -> Response {
    let conn = state.conn.lock().expect("db mutex poisoned");
    let rows = context_from_db(&conn)
        .ok()
        .and_then(|ctx| build_rows(&ctx).ok());
    match rows {
        Some(flags) => json_ok(&FlagsBody { flags }),
        None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to list flags"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_booleans_are_exact_lowercase_true() {
        assert!(!desktop_bool("TRUE", true));
        assert!(!desktop_bool("TRUE", false));
        assert!(!desktop_bool("1", true));
        assert!(desktop_bool("true", false));
        // Empty falls back to the default, whichever way it points.
        assert!(desktop_bool("", true));
        assert!(!desktop_bool("", false));
    }

    #[test]
    fn desktop_auto_lock_is_parse_int_with_a_range() {
        assert_eq!(desktop_auto_lock(""), 15);
        assert_eq!(desktop_auto_lock("0"), 0);
        assert_eq!(desktop_auto_lock("1440"), 1440);
        assert_eq!(desktop_auto_lock("1441"), 15);
        assert_eq!(desktop_auto_lock("2000"), 15);
        assert_eq!(desktop_auto_lock("-1"), 15);
        assert_eq!(desktop_auto_lock("abc"), 15);
        // parseInt leniency: the prefix wins.
        assert_eq!(desktop_auto_lock("30 minutes"), 30);
        assert_eq!(desktop_auto_lock("12.9"), 12);
    }

    #[test]
    fn desktop_theme_is_case_sensitive() {
        assert_eq!(desktop_theme("dark"), "dark");
        assert_eq!(desktop_theme("DARK"), "system");
        assert_eq!(desktop_theme(""), "system");
        assert_eq!(desktop_theme("light "), "system");
    }

    #[test]
    fn desktop_zoom_is_parse_float_with_a_range_and_prints_like_javascript() {
        assert_eq!(desktop_zoom(""), 1.0);
        assert_eq!(desktop_zoom("1.5abc"), 1.5);
        assert_eq!(desktop_zoom("3"), 3.0);
        assert_eq!(desktop_zoom("3.01"), 1.0);
        assert_eq!(desktop_zoom("0.25"), 1.0);
        assert_eq!(desktop_zoom("1e400"), 1.0);
        assert_eq!(desktop_zoom("-0"), 1.0);
        // On the wire: JSON.stringify(1) is `1`, JSON.stringify(1.5) is `1.5`.
        assert_eq!(js_number(desktop_zoom("")).to_string(), "1");
        assert_eq!(js_number(desktop_zoom("1.50")).to_string(), "1.5");
        assert_eq!(js_number(desktop_zoom("3.0")).to_string(), "3");
    }
}

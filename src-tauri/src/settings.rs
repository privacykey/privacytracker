// Fetch the whole desktop-settings bundle from the Node side in one round
// trip. The Node side is the source of truth for every persisted
// preference; Rust just reads on boot (and on demand when something needs
// to reconcile state, e.g. after the user toggles native notifications).
//
// Matches /api/settings/desktop (GET). The route returns every
// desktop_* key with a sensible default so we can deserialize without
// per-field Option<> juggling here.

use std::time::Duration;

use serde::Deserialize;

/// Mirror of the JSON shape returned by `GET /api/settings/desktop`.
///
/// Several fields here are deserialized eagerly even though the Rust shell
/// doesn't act on them yet — `autostart`, `auto_lock_idle_minutes`, and
/// `theme_override` are read by other call sites (the autostart plugin, the
/// idle-lock timer, the webview appearance picker) but those pipes haven't
/// been wired up in this binary. We keep the fields populated so the struct
/// stays a faithful round-trip with the API; dead-code analysis is silenced
/// at the struct level rather than per-field so the file stays compact.
/// Drop the attribute (and individual fields) when each feature lands.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct DesktopSettings {
    #[serde(default)]
    pub hide_dock: bool,
    #[serde(default)]
    pub launch_hidden: bool,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default = "default_true")]
    pub native_notifications: bool,
    #[serde(default = "default_shortcut")]
    pub global_shortcut: String,
    #[serde(default)]
    pub require_unlock: bool,
    #[serde(default = "default_auto_lock")]
    pub auto_lock_idle_minutes: u32,
    #[serde(default = "default_theme")]
    pub theme_override: String, // "system" | "light" | "dark"
    /// Whether the user had the Web Inspector open last time the app
    /// quit. main.rs reads this on boot and re-opens devtools if true,
    /// so a developer who had the inspector open doesn't have to re-
    /// open it every launch. commands::toggle_devtools writes the new
    /// state via a POST to /api/settings/desktop after toggling.
    #[serde(default)]
    pub devtools_open: bool,
    /// Whether the menu-bar tray icon should be visible. The tray
    /// itself is always *installed* by tray::install — toggling this
    /// flag flips the icon's visibility via tray.set_visible at
    /// runtime, so the user can hide/show the menu-bar affordance
    /// from Settings without restarting. Defaults to true so a fresh
    /// install gets the tray icon by default.
    #[serde(default = "default_true")]
    pub tray_visible: bool,
    /// Persisted webview page-zoom level (1.0 = 100%). The View-menu
    /// zoom items step it (see zoom.rs) and main.rs re-applies it on
    /// boot so a user's chosen zoom survives quit/relaunch. zoom.rs
    /// clamps whatever arrives here into its 0.5–3.0 ladder range.
    #[serde(default = "default_zoom")]
    pub zoom_level: f64,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            hide_dock: false,
            launch_hidden: false,
            autostart: false,
            native_notifications: true,
            global_shortcut: default_shortcut(),
            require_unlock: false,
            auto_lock_idle_minutes: default_auto_lock(),
            theme_override: default_theme(),
            devtools_open: false,
            tray_visible: true,
            zoom_level: default_zoom(),
        }
    }
}

fn default_true() -> bool { true }
fn default_shortcut() -> String { "CmdOrCtrl+Shift+P".to_string() }
fn default_auto_lock() -> u32 { 15 }
fn default_theme() -> String { "system".to_string() }
fn default_zoom() -> f64 { 1.0 }

pub fn fetch(base_url: &str) -> Result<DesktopSettings, Box<dyn std::error::Error>> {
    // The /api/settings/desktop route maps the persisted key-value shape
    // (desktop_hide_dock, desktop_launch_hidden, …) onto this camel-cased
    // bundle. Keeping the snake_case → camelCase conversion server-side
    // means Rust has exactly one shape to parse.
    let resp: DesktopSettings = ureq::get(&format!("{base_url}/api/settings/desktop"))
        // Production sidecars also get PRIVACYTRACKER_RUNTIME=desktop, but
        // `tauri dev` can point at an already-running Next server via
        // PRIVACYTRACKER_DEV_URL. This header lets that server persist the
        // same desktop runtime signal once the Tauri shell connects.
        .set("x-privacytracker-runtime", "desktop")
        .timeout(Duration::from_secs(3))
        .call()?
        .into_json()?;
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_settings_deserializes_defaults_for_missing_fields() {
        let parsed: DesktopSettings = serde_json::from_str("{}").expect("settings JSON");

        assert!(!parsed.hide_dock);
        assert!(!parsed.launch_hidden);
        assert!(parsed.native_notifications);
        assert_eq!(parsed.global_shortcut, "CmdOrCtrl+Shift+P");
        assert_eq!(parsed.auto_lock_idle_minutes, 15);
        assert_eq!(parsed.theme_override, "system");
        assert!(parsed.tray_visible);
        assert_eq!(parsed.zoom_level, 1.0);
    }

    #[test]
    fn desktop_settings_honours_explicit_values() {
        let parsed: DesktopSettings = serde_json::from_str(
            r#"{
              "hide_dock": true,
              "launch_hidden": true,
              "native_notifications": false,
              "global_shortcut": "CmdOrCtrl+Alt+P",
              "require_unlock": true,
              "auto_lock_idle_minutes": 30,
              "theme_override": "dark",
              "devtools_open": true,
              "tray_visible": false,
              "zoom_level": 1.5
            }"#,
        )
        .expect("settings JSON");

        assert!(parsed.hide_dock);
        assert!(parsed.launch_hidden);
        assert!(!parsed.native_notifications);
        assert_eq!(parsed.global_shortcut, "CmdOrCtrl+Alt+P");
        assert!(parsed.require_unlock);
        assert_eq!(parsed.auto_lock_idle_minutes, 30);
        assert_eq!(parsed.theme_override, "dark");
        assert!(parsed.devtools_open);
        assert!(!parsed.tray_visible);
        assert_eq!(parsed.zoom_level, 1.5);
    }
}

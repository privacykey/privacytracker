// Global keyboard shortcut registration.
//
// The shortcut string uses Tauri's accelerator syntax
// (https://tauri.app/plugin/global-shortcut/): "CmdOrCtrl+Shift+P",
// "Alt+Space", etc. Default is CmdOrCtrl+Shift+P. Persisted in
// app_settings as `desktop_global_shortcut` on the Node side; the UI
// writes to /api/settings/desktop and then calls the
// register_global_shortcut command so the new binding takes effect
// immediately (no restart).
//
// The handler reveals the main window — same as clicking the tray icon —
// and shifts focus to it. If desktop_require_unlock is on, Touch ID
// prompting happens inside reveal_main_window, not here.

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Register the shortcut from its string form. If anything about the
/// string is malformed, log and fall through — a bad stored shortcut
/// shouldn't crash the app or block boot.
pub fn register_from_settings(app: &AppHandle, shortcut_str: &str) {
    // Unregister any existing binding first so a re-register (e.g. user
    // changed the shortcut in settings) doesn't leave an orphan.
    let _ = app.global_shortcut().unregister_all();

    // Reject system-reserved combinations and single-key shortcuts up
    // front. A compromised webview could otherwise re-bind Cmd+Q,
    // Cmd+W, accessibility F-keys, etc. and consume those for the
    // duration of the session.
    if !is_safe_shortcut(shortcut_str) {
        log::warn!(
            "desktop_global_shortcut='{shortcut_str}' is a reserved or unsafe combination; skipping"
        );
        return;
    }

    let shortcut: Shortcut = match shortcut_str.parse() {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                "desktop_global_shortcut='{shortcut_str}' is not a valid accelerator ({e}); skipping"
            );
            return;
        }
    };

    let app_for_handler = app.clone();
    let res = app.global_shortcut().on_shortcut(shortcut, move |_, _, event| {
        // Fire on key-down only; otherwise the window would pop-hide-pop
        // in a single keypress.
        if event.state != ShortcutState::Pressed {
            return;
        }
        let _ = crate::commands::reveal_main_window(app_for_handler.clone());
    });

    match res {
        Ok(_) => log::info!("Registered global shortcut: {shortcut_str}"),
        Err(e) => log::warn!("Failed to register global shortcut '{shortcut_str}': {e}"),
    }
}

/// Conservative allow-rule for the accelerator string. Requires at
/// least one non-Shift modifier so single-key bindings can't be
/// registered, and denylists combinations the OS reserves for system
/// functions (quit, hide, minimise, app-switcher, accessibility
/// F-keys). Keeps the customisation flexibility users expect while
/// shutting the obvious abuse-vector.
fn is_safe_shortcut(s: &str) -> bool {
    let parts: Vec<String> = s
        .split('+')
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 2 {
        return false;
    }
    let key = parts.last().unwrap().clone();
    let modifiers: Vec<&str> = parts[..parts.len() - 1].iter().map(|s| s.as_str()).collect();

    let is_cmd_like = |m: &&str| {
        matches!(
            *m,
            "cmd" | "command" | "super" | "meta" | "ctrl" | "control" | "cmdorctrl" | "alt" | "option"
        )
    };
    if !modifiers.iter().any(is_cmd_like) {
        return false;
    }

    let has_cmd = modifiers
        .iter()
        .any(|m| matches!(*m, "cmd" | "command" | "super" | "meta" | "cmdorctrl"));
    if has_cmd {
        const RESERVED_WITH_CMD: &[&str] = &[
            "q", "w", "h", "m", "tab", "space", ",", "comma", "`",
        ];
        if RESERVED_WITH_CMD.contains(&key.as_str()) {
            return false;
        }
    }

    // Accessibility F-keys (macOS VoiceOver, Zoom, etc.).
    if matches!(key.as_str(), "f1" | "f2" | "f3" | "f4" | "f5" | "f6") {
        return false;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::is_safe_shortcut;

    #[test]
    fn accepts_default_and_common_summons() {
        assert!(is_safe_shortcut("CmdOrCtrl+Shift+P"));
        assert!(is_safe_shortcut("Alt+Space"));
        assert!(is_safe_shortcut("Ctrl+Shift+T"));
    }

    #[test]
    fn rejects_system_reserved() {
        assert!(!is_safe_shortcut("Cmd+Q"));
        assert!(!is_safe_shortcut("Cmd+W"));
        assert!(!is_safe_shortcut("Cmd+H"));
        assert!(!is_safe_shortcut("Cmd+M"));
        assert!(!is_safe_shortcut("Cmd+Tab"));
        assert!(!is_safe_shortcut("Cmd+Space"));
    }

    #[test]
    fn rejects_single_key_and_shift_only() {
        assert!(!is_safe_shortcut("F5"));
        assert!(!is_safe_shortcut("Shift+P"));
        assert!(!is_safe_shortcut(""));
    }

    #[test]
    fn rejects_accessibility_fkeys() {
        assert!(!is_safe_shortcut("Cmd+F1"));
        assert!(!is_safe_shortcut("Ctrl+F5"));
    }
}

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

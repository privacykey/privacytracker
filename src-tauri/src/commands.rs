// Tauri commands exposed to the webview via `@tauri-apps/api`'s `invoke`.
//
// Kept intentionally thin — every command either tweaks OS-level state that
// the Node sidecar can't touch (Dock policy, Touch ID, global shortcuts,
// devtools, native notifications badge) or hands back data the webview
// needs (sidecar base URL, diagnostics report).
//
// Every command that mutates persisted settings trusts the Node side to be
// the source of truth: the UI writes to /api/settings/desktop first, then
// invokes the command. That way a crash between "UI told Rust to apply"
// and "reboot" doesn't leave a drift between Node and Rust state.

use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Returns the base URL the Node sidecar is listening on. The SettingsView
/// uses this to build links to /api/... endpoints that the webview is
/// already pointed at — but it's handy for debug / "open in browser" flows.
#[tauri::command]
pub fn sidecar_base_url() -> String {
    crate::state().sidecar_base_url.clone()
}

/// Reveals the per-user data directory in the OS file manager. Hooked up
/// from Settings → "Show data folder" so users can back up privacy.db
/// themselves without digging through Library/Application Support.
#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = dirs::data_dir()
        .ok_or_else(|| "could not resolve data dir".to_string())?
        .join("privacytracker");

    open_path(&dir)?;
    let _ = app;
    Ok(())
}

/// Reveals the app log directory. Tauri's log plugin writes to the OS
/// convention (macOS: ~/Library/Logs/privacytracker; Windows:
/// %LOCALAPPDATA%\privacytracker\logs) which is distinct from the data dir
/// above — data is user content, logs are diagnostic breadcrumbs.
#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())?;
    open_path(&dir)
}

fn open_path(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle the webview devtools. The tauri crate's `devtools` Cargo feature
/// is enabled (see src-tauri/Cargo.toml), which keeps the inspector
/// available in release builds — same affordance as `View > Toggle
/// Developer Tools` in the menu bar. Without that feature flag the
/// `is_devtools_open()` / `open_devtools()` / `close_devtools()` methods
/// would compile out and this command would silently do nothing.
///
/// After flipping the state we POST the new value to /api/settings/desktop
/// so it survives a quit/relaunch — main.rs::setup re-opens devtools on
/// boot if the persisted flag is true. Without this round-trip a developer
/// would have to re-open the inspector every launch.
#[tauri::command]
pub fn toggle_devtools(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let next_open = !window.is_devtools_open();
        if next_open {
            window.open_devtools();
        } else {
            window.close_devtools();
        }
        persist_devtools_open(next_open);
    }
    Ok(())
}

/// Toggle the menu-bar tray icon's visibility live. Driven by the
/// switch in DesktopAppSection. The tray itself is always installed
/// (see tray::install) — flipping this just calls `set_visible` on
/// the existing TrayIcon, which is far cheaper than tearing it down
/// and rebuilding. Persistence happens server-side via the same POST
/// to /api/settings/desktop the UI fires before invoking us.
#[tauri::command]
pub fn set_tray_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(visible)
            .map_err(|e| format!("set_visible failed: {e}"))?;
    }
    Ok(())
}

/// Fire-and-forget POST to /api/settings/desktop with the new
/// `devtools_open` value. Spawned on a background thread so the
/// toggle returns immediately — the user's flip shouldn't block on a
/// HTTP round-trip to the Node sidecar.
///
/// `pub(crate)` so app_menu.rs's "View > Toggle Developer Tools"
/// handler can call it after running its own toggle inline (the menu
/// handler can't delegate to the `#[tauri::command]` `toggle_devtools`
/// directly because the menu is generic over `Runtime` while the
/// command takes the default Wry-typed AppHandle).
pub(crate) fn persist_devtools_open(open: bool) {
    let base_url = crate::state().sidecar_base_url.clone();
    std::thread::spawn(move || {
        let url = format!("{base_url}/api/settings/desktop");
        let body = format!("{{\"devtools_open\":{}}}", open);
        match ureq::post(&url)
            .timeout(Duration::from_secs(3))
            .set("content-type", "application/json")
            .send_string(&body)
        {
            Ok(_) => log::info!("persisted devtools_open={open}"),
            Err(e) => log::warn!("failed to persist devtools_open={open}: {e}"),
        }
    });
}

/// Re-register the global shortcut after the UI changes it in settings.
/// The UI is expected to have already POSTed the new value to
/// /api/settings/desktop; this command just re-reads it and rebinds.
#[tauri::command]
pub fn register_global_shortcut(shortcut: String, app: AppHandle) -> Result<(), String> {
    crate::shortcuts::register_from_settings(&app, &shortcut);
    Ok(())
}

/// Build the diagnostics report string. The UI then copies it to the
/// clipboard — we don't do clipboard I/O from Rust because Tauri v2's
/// clipboard plugin is the blessed path and calling it from Rust vs. the
/// webview is the same user-visible outcome either way.
#[tauri::command]
pub fn get_diagnostics_report() -> String {
    let base = &crate::state().sidecar_base_url;
    crate::diagnostics::build_report(base)
}

/// Prompt for Touch ID / device password. Returns `true` on success,
/// `false` on user-cancel, or rejects the promise with a message on
/// "authentication isn't set up on this machine" (so the UI can surface a
/// helpful error rather than looking like the prompt was dismissed).
///
/// Non-macOS hosts always return `true` — the feature is macOS-only for v1.
/// Callers that want to gate on "Touch ID is actually on" should first
/// check desktop_require_unlock in settings.
#[tauri::command]
pub fn authenticate_touch_id(reason: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        crate::touch_id::prompt(
            if reason.is_empty() { "unlock privacytracker" } else { &reason },
            Duration::from_secs(60),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = reason;
        Ok(true)
    }
}

/// Set the Dock tile badge manually. Normally the notifications watcher
/// updates this every 15s — this command exists so the webview can force
/// an immediate refresh after the user clears notifications in the bell
/// UI (otherwise the badge would stick around until the next poll).
#[tauri::command]
pub fn set_dock_badge(count: u32) -> Result<(), String> {
    crate::notifications::set_dock_badge(count as usize);
    Ok(())
}

/// Reveal the main window. Shared helper for:
///   - Tray "Open" menu item
///   - Global shortcut handler
///   - Deep-link handler (privacytracker://...)
///   - Webview button "Bring to front" (rarely useful, but convenient for testing)
///
/// Respects desktop_require_unlock: if it's on and we haven't cleared Touch
/// ID this session, we prompt before revealing. The unlock state is stored
/// in-process only; killing the tray forces a re-auth on next reveal.
#[tauri::command]
pub fn reveal_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    // NOTE: For v1 we always reveal immediately and let the webview itself
    // draw a lock overlay if desktop_require_unlock is on + the session
    // hasn't authenticated yet. That keeps Touch ID prompting off the
    // critical path of "click tray → see something" and lets the UI
    // handle the retry UX. The command is still on the Rust side so the
    // webview can invoke it on the user's Touch ID success to re-reveal.
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().ok();
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Show/hide the Dock icon on macOS. No-op on Windows/Linux.
///
/// `visible=true` → NSApplicationActivationPolicyRegular (full app, Dock + Cmd-Tab).
/// `visible=false` → NSApplicationActivationPolicyAccessory (menu bar agent, no Dock).
///
/// Called from Settings > Desktop app > "Hide Dock icon (menu bar only)".
/// The Node side persists the choice in app_settings so instrumentation.ts
/// can re-apply on boot via apply_dock_visibility.
#[tauri::command]
pub fn set_dock_visibility(visible: bool, app: AppHandle) -> Result<(), String> {
    apply_dock_visibility(visible, &app);
    Ok(())
}

/// Shared entry point used by both the Tauri command (user toggled the
/// setting) and the boot path in main.rs (re-applying the persisted choice).
pub fn apply_dock_visibility(visible: bool, _app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};

        // We talk to NSApplication through the obj-c runtime via objc2's
        // `class!` + `msg_send!` macros, NOT the objc2-app-kit wrapper
        // crate. objc2-app-kit's 0.x line keeps reshuffling its public
        // re-export surface — types appear at the crate root in one patch
        // and move into private submodules the next, breaking our import
        // path on every dep refresh. Calling AppKit through the runtime
        // sidesteps that entire fragility (AppKit is dynamically loaded
        // by macOS already; we don't need a typed wrapper to send a
        // single selector).
        //
        // NSApplicationActivationPolicy enum values are stable: Regular=0,
        // Accessory=1, Prohibited=2. We pass the raw i64 directly.
        //
        // Return-type encoding matters here. Apple changed
        // `-[NSApplication setActivationPolicy:]` to return `BOOL` rather
        // than `void` years ago (the BOOL is true when the policy was
        // accepted, false if the runtime rejected it — e.g. when trying
        // to demote an already-running app from Regular to Prohibited).
        // objc2's `msg_send!` macro inspects the runtime's method
        // signature on dispatch and aborts the process if the declared
        // return type doesn't match: the panic looks like:
        //
        //   invalid message send to -[NSKVONotifying_TaoApp
        //   setActivationPolicy:]: expected return to have type code
        //   'B', but found 'v'
        //
        // Older code that declared the return as `()` happens to work
        // on some SDK combinations and aborts on newer ones; declaring
        // as `bool` (which objc2 encodes as 'B' on Apple platforms,
        // matching the BOOL definition since 64-bit macOS) makes the
        // dispatch valid on every supported macOS version. We discard
        // the BOOL because a false return only matters in the
        // already-Prohibited edge case, which we don't expose.
        //
        // SAFETY: NSApplication::sharedApplication is thread-safe and the
        // setActivationPolicy: selector is documented as runtime-safe.
        unsafe {
            let cls = class!(NSApplication);
            let app: *mut AnyObject = msg_send![cls, sharedApplication];
            if app.is_null() {
                return;
            }
            let policy: i64 = if visible { 0 /* Regular */ } else { 1 /* Accessory */ };
            let _accepted: bool = msg_send![app, setActivationPolicy: policy];
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = visible;
    }
}

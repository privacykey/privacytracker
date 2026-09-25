// Menu-bar tray icon + menu. Tauri v2 ships native tray support, but
// without an explicit `.icon()` call the tray builds successfully yet
// renders nothing visible in the macOS menu bar (a tooltip+menu but no
// glyph to click). We attach the app's default window icon so users
// running the app in the background — close-to-tray is wired up in
// main.rs via WindowEvent::CloseRequested → window_lock::hide — have a
// reliable affordance to bring the window back.
//
// Menu items:
//   - Show / Hide privacytracker  (toggles the main window's visibility)
//   - Sync now                    (POST /api/sync/trigger)
//   - Import Wayback history      (POST /api/wayback/import-all?stream=1)
//   - ─────────
//   - Quit privacytracker         (clean app.exit(0))
//
// "Sync now" and "Wayback import" fire POSTs against the sidecar so the
// tray does the same thing the Settings buttons do. Both go through
// backend::post, which adds the Origin header the server's CSRF gate
// requires. Without it every tray POST was refused with a 403.
//
// Showing and hiding the window goes through window_lock, which asks for
// Touch ID / password before a locked window opens. The Show / Hide label
// follows the gate, so it stays right however the window was opened or
// hidden, and when an unlock is cancelled.

use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::window_lock;

const SHOW_LABEL: &str = "Show privacytracker";
const HIDE_LABEL: &str = "Hide privacytracker";

fn show_hide_label(open: bool) -> &'static str {
    if open {
        HIDE_LABEL
    } else {
        SHOW_LABEL
    }
}

pub fn install(app: &AppHandle, base_url: String, initial_visible: bool) -> tauri::Result<()> {
    // The show/hide item's label tracks the gate: "Hide" while the window
    // is open, "Show" while it is hidden or locked. The callback is
    // registered before the current state is read, so an open or hide
    // that lands in between still reaches the label.
    let show_hide = MenuItem::with_id(app, "show_hide", SHOW_LABEL, true, None::<&str>)?;
    let label_item = show_hide.clone();
    window_lock::on_open_changed(move |open| {
        let _ = label_item.set_text(show_hide_label(open));
    });
    let _ = show_hide.set_text(show_hide_label(window_lock::is_open()));

    let sync_now = MenuItem::with_id(app, "sync_now", "Sync now", true, None::<&str>)?;
    let wayback = MenuItem::with_id(app, "wayback", "Import Wayback history", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit privacytracker", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_hide, &sync_now, &wayback, &sep1, &quit])?;

    // Pull the app's default icon out of the bundle (set by Tauri's
    // build pipeline from src-tauri/icons/). On macOS the tray
    // automatically adapts the icon's pixel size to the menu bar's
    // current height, so we don't need to ship a tray-specific size.
    // We don't enable `icon_as_template` here because the default
    // icon is full-colour artwork, not a black/transparent template;
    // setting template=true would render it entirely black and lose
    // the magnifying-glass detail. If we ship a dedicated 22×22
    // template-style icon later, flip the flag to true here.
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("privacytracker")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show_hide" => {
                if window_lock::is_open() {
                    // Hide to the tray, which locks the window. The
                    // backend and scheduler keep running in the
                    // background; this same item brings the window back.
                    window_lock::hide(app);
                } else {
                    window_lock::reveal(app);
                }
            }
            "sync_now" => {
                let base_url = base_url.clone();
                std::thread::spawn(move || {
                    // No timeout. The route answers only once the whole
                    // sync has finished, which takes minutes on a large
                    // library, and the Settings button waits for it the
                    // same way. Hanging up early would log a failure for a
                    // sync that is still running: both backends finish a
                    // sync whose client has gone.
                    match crate::backend::post(&base_url, "/api/sync/trigger").call() {
                        Ok(resp) => log::info!(
                            "Tray: sync finished: {}",
                            resp.into_string().unwrap_or_default(),
                        ),
                        Err(e) => log::warn!("Tray: sync failed: {e}"),
                    }
                });
            }
            "wayback" => {
                let base_url = base_url.clone();
                std::thread::spawn(move || {
                    // A run can take hours, so ask for the NDJSON stream:
                    // its headers arrive as soon as the run has started,
                    // and dropping the response then leaves the run going.
                    // Both backends treat that like the Settings page
                    // being closed mid-import. A refusal (409 already
                    // running, 429 throttled) comes back as an error, and
                    // "no apps to import" as a plain JSON 200.
                    match crate::backend::post(&base_url, "/api/wayback/import-all?stream=1")
                        .timeout(Duration::from_secs(10))
                        .call()
                    {
                        Ok(resp) if resp.content_type() == "application/x-ndjson" => {
                            log::info!("Tray: Wayback import started");
                        }
                        Ok(resp) => log::info!(
                            "Tray: Wayback import did not start: {}",
                            resp.into_string().unwrap_or_default(),
                        ),
                        Err(e) => log::warn!("Tray: Wayback import failed: {e}"),
                    }
                });
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click on the icon itself (not the menu) surfaces the main
            // window. The same click also opens the tray menu
            // (show_menu_on_left_click), so a locked window is left for the
            // menu's "Show privacytracker" to unlock, rather than asking for
            // Touch ID each time someone opens the menu.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Down,
                ..
            } = event
            {
                window_lock::reveal_if_unlocked(tray.app_handle());
            }
        })
        .build(app)?;

    // Honour the persisted visibility from the desktop settings.
    // TrayIconBuilder doesn't expose a `.visible()` method (Tauri's
    // 2.x TrayIconBuilder has no such builder method), so we apply
    // the initial state after the tray is built. The tray is still
    // *always installed* — set_tray_visible (commands.rs) flips this
    // live when the user toggles the switch in DesktopAppSection,
    // and a returning user who hid the icon last quit doesn't see
    // it briefly flash on at boot because we apply this before the
    // event loop starts pumping draws.
    if !initial_visible {
        if let Err(e) = tray.set_visible(false) {
            log::warn!("tray.set_visible(false) at boot failed: {e}");
        }
    }

    Ok(())
}

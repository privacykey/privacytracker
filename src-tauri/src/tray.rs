// Menu-bar tray icon + menu. Tauri v2 ships native tray support, but
// without an explicit `.icon()` call the tray builds successfully yet
// renders nothing visible in the macOS menu bar (a tooltip+menu but no
// glyph to click). We attach the app's default window icon so users
// running the app in the background — close-to-tray is wired up in
// main.rs via WindowEvent::CloseRequested → window.hide() — have a
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

use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub fn install(app: &AppHandle, base_url: String, initial_visible: bool) -> tauri::Result<()> {
    // Two flavours of the show/hide item — built upfront so the menu
    // event handler can swap the visible label after each click. We
    // start with the "hide" copy because the window is visible at
    // boot (unless launched hidden via the autostart plugin, which
    // is its own narrow path).
    let show_hide = MenuItem::with_id(
        app,
        "show_hide",
        "Hide privacytracker",
        true,
        None::<&str>,
    )?;
    let sync_now = MenuItem::with_id(app, "sync_now", "Sync now", true, None::<&str>)?;
    let wayback = MenuItem::with_id(app, "wayback", "Import Wayback history", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit privacytracker", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_hide, &sync_now, &wayback, &sep1, &quit])?;

    // Capture a clone of the show/hide item so the menu-event closure
    // can re-label it after each click. MenuItem in Tauri 2.x is
    // internally Arc-shared, so the clone points at the same OS-side
    // menu entry — `set_text` on the clone updates the visible label
    // for everyone. We can't go via `tray.menu()` after-the-fact
    // because TrayIcon doesn't expose a `.menu()` getter (only
    // `set_menu`); cloning the item upfront is the canonical pattern.
    let show_hide_for_handler = show_hide.clone();

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
                if let Some(w) = app.get_webview_window("main") {
                    let visible = w.is_visible().unwrap_or(true);
                    if visible {
                        // Hide to the tray. The sidecar / scheduler
                        // keeps running in the background; the user
                        // can bring the window back via this same
                        // menu item or by clicking the tray icon.
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    // Re-label via the cloned MenuItem captured above
                    // — the Arc-shared inner state means this call
                    // updates the same OS menu entry.
                    let _ = show_hide_for_handler.set_text(if visible {
                        "Show privacytracker"
                    } else {
                        "Hide privacytracker"
                    });
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
            // window. On macOS the menu shows automatically via
            // show_menu_on_left_click, so this branch is mostly Windows /
            // Linux. We only act on a Click event (not Enter / Leave / etc)
            // and only with the left button.
            if let TrayIconEvent::Click { .. } = event {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
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

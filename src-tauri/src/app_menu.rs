// Native macOS / Windows / Linux menu bar.
//
// Tauri 2 doesn't add a menu bar by default — we have to build one in
// Rust and call `App::set_menu()` from the setup hook. Without this,
// the focused-window menu bar on macOS shows only the auto-generated
// "privacytracker > Quit" entry, which means standard text-edit
// shortcuts (Cmd+C / Cmd+V / Cmd+X / Cmd+A / Cmd+Z) don't fire inside
// inputs and textareas. That's a non-negotiable usability bug for any
// app with form fields, so we ship the standard set.
//
// Structure mirrors what every well-behaved macOS app provides:
//   App > [About] [Hide] [Hide Others] [Show All] [sep] [Quit]
//   Edit > [Undo Redo] [sep] [Cut Copy Paste Select All]
//   View > [Reload] [Force Reload] [Toggle Developer Tools]
//   Window > [Minimize] [Zoom] [sep] [Bring All to Front]
//   Help > [Open GitHub Repo]
//
// `View > Toggle Developer Tools` reuses the existing
// `commands::toggle_devtools` Tauri command so the keyboard shortcut
// (Cmd+Opt+I) and the menu hit the same code path. `View > Reload`
// uses `webview.reload()` directly from the menu handler.
//
// The `Help > GitHub` entry uses `tauri-plugin-shell` to open the URL
// in the user's default browser. That plugin is already initialised
// in main.rs and the `shell:allow-open` permission is already in
// capabilities/main.json.

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Manager, Runtime};

const GITHUB_REPO_URL: &str = "https://github.com/privacykey/privacytracker";

/// Build the full menu tree and return it for the caller to apply via
/// `App::set_menu()`. Constructed inside the setup hook so we can pass
/// the live `AppHandle` to each `PredefinedMenuItem` constructor —
/// every item the OS draws needs to know which app owns it.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ── App menu ─────────────────────────────────────────────────────
    // The first submenu's *title* on macOS is replaced by the bundle's
    // CFBundleName at runtime, so the literal string we pass here is a
    // fallback that should rarely show. We use "privacytracker" rather
    // than the bundle's lowercase `productName` so the menu reads
    // properly during dev runs / on Linux + Windows.
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("privacytracker"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("© 2026 privacykey"))
        .website(Some(GITHUB_REPO_URL))
        .website_label(Some("GitHub"))
        .build();

    // Settings sits between About and the Services / Hide cluster — that's
    // where macOS users instinctively look for it. Cmd+, is the OS-wide
    // convention; users with custom keyboard layouts can hit `,` from any
    // language since macOS treats it as a stable command shortcut.
    let settings_item = MenuItem::with_id(
        app,
        "menu.app.settings",
        "Settings...",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    // Custom About item that fires the same `about-modal:open` window
    // event the footer's About link uses (see app/components/AboutModal.tsx).
    // The standard `PredefinedMenuItem::about` opens macOS's tiny built-in
    // about-panel widget — we want the in-app modal instead so the menu
    // and footer entry-points open the same UI. The AboutMetadataBuilder
    // result above is now unused; suppress the dead-binding warning by
    // dropping it with `let _`.
    let _ = about_metadata;
    let about_item = MenuItem::with_id(
        app,
        "menu.app.about",
        "About privacytracker",
        true,
        None::<&str>,
    )?;

    let app_menu = Submenu::with_items(
        app,
        "privacytracker",
        true,
        &[
            &about_item,
            &PredefinedMenuItem::separator(app)?,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // ── Edit menu ────────────────────────────────────────────────────
    // All predefined — Tauri lets the OS handle these at the responder
    // level, so they fire even on inputs the webview owns. This is the
    // single most important reason the menu bar exists at all.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // ── View menu ────────────────────────────────────────────────────
    // Custom items handled in `handle_event` below. Reload and the
    // dev-tools toggle are the two web-style shortcuts every user
    // expects from a Chromium-shaped surface.
    let reload = MenuItem::with_id(
        app,
        "menu.view.reload",
        "Reload",
        true,
        Some("CmdOrCtrl+R"),
    )?;
    let force_reload = MenuItem::with_id(
        app,
        "menu.view.force_reload",
        "Force Reload",
        true,
        Some("CmdOrCtrl+Shift+R"),
    )?;
    // Always enabled because the `devtools` Cargo feature on the tauri
    // crate is on (see src-tauri/Cargo.toml). Without that feature, the
    // `is_devtools_open()` / `open_devtools()` / `close_devtools()`
    // methods compile out and the menu item silently does nothing — which
    // is exactly the bug we hit before. With the feature enabled,
    // production builds get the same Web Inspector affordance as dev
    // builds.
    let toggle_devtools = MenuItem::with_id(
        app,
        "menu.view.toggle_devtools",
        "Toggle Developer Tools",
        true,
        Some("CmdOrCtrl+Alt+I"),
    )?;
    // "Hide to Menu Bar" — discoverable surface for the same hide-to-
    // tray behaviour the close button (see main.rs's
    // WindowEvent::CloseRequested handler) already does silently.
    // Cmd+Shift+H since macOS uses Cmd+H for "Hide app entirely"
    // (which dock-hides the whole process); we want a distinct
    // shortcut for "shrink to menu bar but keep running". Users
    // running the app in the background — most relevant for the
    // 30-min scheduled sync — get a clear menu affordance to do so.
    let hide_to_tray = MenuItem::with_id(
        app,
        "menu.view.hide_to_tray",
        "Hide to Menu Bar",
        true,
        Some("CmdOrCtrl+Shift+H"),
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &reload,
            &force_reload,
            &toggle_devtools,
            &PredefinedMenuItem::separator(app)?,
            &hide_to_tray,
        ],
    )?;

    // ── Window menu ──────────────────────────────────────────────────
    // No `bring_all_to_front` — Tauri 2.10.x dropped it from the
    // predefined-item set. The other Window-menu standards (Minimize /
    // Maximize / Close) are still here and Cmd+M / Cmd+W / fullscreen
    // continue to work via the OS responder chain.
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // ── Help menu ────────────────────────────────────────────────────
    let github = MenuItem::with_id(
        app,
        "menu.help.github",
        "privacytracker on GitHub",
        true,
        None::<&str>,
    )?;
    let help_menu = Submenu::with_items(app, "Help", true, &[&github])?;

    Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

/// Route custom menu events. The `PredefinedMenuItem` entries don't
/// reach this handler — Tauri passes them straight to the OS responder
/// chain. We only see the items we declared with our own id strings.
pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        "menu.app.about" => {
            // Surface the main window if it was idling in the tray, then
            // dispatch the same `about-modal:open` window event the
            // footer About link fires (see app/components/AboutModal.tsx).
            // The modal mounts globally via app/layout.tsx, so any page
            // the user happens to be on can show the dialog without us
            // needing to navigate away first.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.eval(
                    "window.dispatchEvent(new CustomEvent('about-modal:open'))",
                );
            }
        }
        "menu.app.settings" => {
            // Show the window if it was hidden / minimized — macOS users
            // expect Cmd+, to surface the Settings page even if the app
            // was idling in the tray. Then navigate the webview to the
            // settings route. Using a relative path means we don't need
            // to thread the dynamic sidecar port through the menu
            // module — the webview is already on the localhost origin
            // by the time the menu can fire.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.eval(
                    "window.location.assign('/dashboard/settings')",
                );
            }
        }
        "menu.view.reload" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.reload()");
            }
        }
        "menu.view.force_reload" => {
            // Force-reload bypasses the HTTP cache. We send the
            // `location.reload(true)` form even though modern browsers
            // ignore the boolean — paired with a cache-busting query
            // string so the next request actually re-fetches from the
            // sidecar rather than ServiceWorker / disk cache.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(
                    "(() => { \
                       const u = new URL(window.location.href); \
                       u.searchParams.set('_force', String(Date.now())); \
                       window.location.replace(u.toString()); \
                     })()",
                );
            }
        }
        "menu.view.hide_to_tray" => {
            // Hide the main window without quitting the app. The tray
            // icon (see src/tray.rs) stays visible in the menu bar so
            // the user can re-show the window via tray click or the
            // "Show privacytracker" tray menu item. The Node sidecar
            // and the 30-min scheduler keep ticking in the
            // background — this is the polite alternative to Cmd+Q
            // for users who want background syncing without a Dock
            // icon hanging around.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        "menu.view.toggle_devtools" => {
            // Toggle the inspector inline (same as the
            // commands::toggle_devtools IPC command body), then
            // persist the new state via /api/settings/desktop so
            // the next launch can re-open or stay-closed
            // appropriately. We don't delegate to the IPC command
            // directly because the menu's `handle_event` is generic
            // over `Runtime` and the command takes the concrete
            // `AppHandle<Wry>` — calling it here would fail to
            // resolve. The persist helper itself is non-generic and
            // safe to call from this scope.
            if let Some(window) = app.get_webview_window("main") {
                let next_open = !window.is_devtools_open();
                if next_open {
                    window.open_devtools();
                } else {
                    window.close_devtools();
                }
                crate::commands::persist_devtools_open(next_open);
            }
        }
        "menu.help.github" => {
            // Open the GitHub repo in the user's default browser. Goes
            // through tauri-plugin-shell — it's deprecated in favour of
            // `tauri-plugin-opener` in Tauri 2.10+, but still ships and
            // works correctly. Switching plugins is a separate cleanup;
            // for now we silence the warning and keep the existing
            // capability grant (`shell:allow-open`) doing its job.
            #[allow(deprecated)]
            {
                use tauri_plugin_shell::ShellExt;
                let _ = app.shell().open(GITHUB_REPO_URL, None);
            }
        }
        _ => {
            // Unhandled custom id — log and move on. Predefined items
            // never reach this branch.
            log::debug!("[menu] unhandled menu event: {:?}", event.id());
        }
    }
}

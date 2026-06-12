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
//   App  > [About] [Hide] [Hide Others] [Show All] [sep] [Quit]
//   Edit > [Undo Redo] [sep] [Cut Copy Paste Select All]
//   View > [Reload] [Force Reload] [Toggle Developer Tools]
//   Go   > [Back] [Forward] [sep] [Dashboard] [Add apps] [Stats] …
//   Window > [Minimize] [Zoom] [sep] [Bring All to Front]
//   Help > [Open GitHub Repo]
//
// The Go submenu is the routing entry-point — Back/Forward (Cmd+[ /
// Cmd+]) follow the WebView history stack via `window.history.back()`,
// while the page jumps (Cmd+1…Cmd+6) call `window.location.assign`
// against in-app routes. Both shortcuts match Safari/Chrome's
// conventions so users don't have to learn anything new.
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

use crate::zoom;

const GITHUB_REPO_URL: &str = "https://github.com/privacykey/privacytracker";
const DOCS_URL: &str = "https://privacytracker-docs.privacykey.org/quickstart";
const ISSUE_URL: &str =
    "https://github.com/privacykey/privacytracker/issues/new?template=bug_report.yml";

/// Build the full menu tree and return it for the caller to apply via
/// `App::set_menu()`. Constructed inside the setup hook so we can pass
/// the live `AppHandle` to each `PredefinedMenuItem` constructor —
/// every item the OS draws needs to know which app owns it.
///
/// `dev_menu_enabled` controls whether the Dev submenu is included.
/// main.rs reads `dev_menu_enabled` from the sidecar's app_settings
/// once at boot and threads it here; flipping the toggle at runtime
/// requires an app restart to see the change (acceptable UX for a
/// dev-mode-on flag — it's not a frequently-flipped switch).
pub fn build<R: Runtime>(app: &AppHandle<R>, dev_menu_enabled: bool) -> tauri::Result<Menu<R>> {
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
    // Cmd+, is the canonical macOS Settings shortcut; the `(g s)`
    // suffix mirrors the in-app keyboard sequence so users learn the
    // chord without needing the help overlay.
    let settings_item = MenuItem::with_id(
        app,
        "menu.app.settings",
        "Settings…    (g s)",
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

    // ── File menu ────────────────────────────────────────────────────
    // Hosts the cross-page action shortcuts the user expects to find
    // in "File" on every other macOS app. Import / Export of backups
    // and audit bundles intentionally stay in Settings — they're
    // destructive enough that a deliberate journey through the
    // Settings UI is the right friction. The two items here are
    // power-user accelerators that don't open a dialog.
    let sync_now = MenuItem::with_id(
        app,
        "menu.file.sync_now",
        "Sync Now",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let mark_all_read = MenuItem::with_id(
        app,
        "menu.file.mark_all_read",
        "Mark All Notifications as Read",
        true,
        None::<&str>,
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&sync_now, &PredefinedMenuItem::separator(app)?, &mark_all_read],
    )?;

    // ── Edit menu ────────────────────────────────────────────────────
    // The predefined undo/redo/cut/copy/paste/select-all entries — the
    // OS handles them at the responder level so they fire inside any
    // input the webview owns. The lone custom item is Find (Cmd+F);
    // it dispatches a `search:focus` window event that the dashboard
    // search bar listens for. Same browser convention every user
    // already knows.
    let find_item = MenuItem::with_id(
        app,
        "menu.edit.find",
        "Find…",
        true,
        Some("CmdOrCtrl+F"),
    )?;
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
            &PredefinedMenuItem::separator(app)?,
            &find_item,
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
    // Only enabled when the local `devtools` cargo feature is on.
    // Production release builds omit the feature so the inspector
    // can't be attached to the running webview; dev builds keep it.
    let toggle_devtools = MenuItem::with_id(
        app,
        "menu.view.toggle_devtools",
        "Toggle Developer Tools",
        cfg!(feature = "devtools"),
        Some("CmdOrCtrl+Alt+I"),
    )?;
    // Page-zoom trio — Safari's ordering and accelerators (Actual Size
    // ⌘0, Zoom In ⌘=, Zoom Out ⌘−). This is the desktop stand-in for
    // browser Cmd/Ctrl+± zoom and the only way the Tauri build reaches
    // WCAG 1.4.4's 200% text size: the in-app text-size stepper
    // (AccessibilityQuickToggles) caps at 1.3× because CSS zoom doesn't
    // reflow responsive breakpoints, while real page zoom does. The
    // ladder, persistence and boot-restore all live in zoom.rs.
    // "CmdOrCtrl+=" rather than "+" because = is the unshifted key —
    // the same binding browsers use for Zoom In; macOS renders the
    // accelerator as ⌘= in the menu.
    let zoom_actual_size = MenuItem::with_id(
        app,
        "menu.view.zoom_reset",
        "Actual Size",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let zoom_in = MenuItem::with_id(
        app,
        "menu.view.zoom_in",
        "Zoom In",
        true,
        Some("CmdOrCtrl+="),
    )?;
    let zoom_out = MenuItem::with_id(
        app,
        "menu.view.zoom_out",
        "Zoom Out",
        true,
        Some("CmdOrCtrl+-"),
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
            &zoom_actual_size,
            &zoom_in,
            &zoom_out,
            &PredefinedMenuItem::separator(app)?,
            &hide_to_tray,
        ],
    )?;

    // ── Go menu ──────────────────────────────────────────────────────
    // Navigation entry-points. Only the back/forward items carry a
    // native macOS accelerator — Cmd+[ / Cmd+] follow Safari + Chrome.
    //
    // The per-section jumps reuse the app's existing in-app `g`-sequence
    // shortcuts (defined in app/components/KeyboardShortcuts.tsx):
    // `g d` Dashboard, `g s` Settings, `g t` Stats, `g n` Add Apps, etc.
    // Tauri's accelerator parser doesn't support chord shortcuts so we
    // can't bind those literally — the hint is surfaced in the label
    // text instead, and the actual keypress is handled globally by the
    // in-app handler.
    let go_back = MenuItem::with_id(
        app,
        "menu.go.back",
        "Back",
        true,
        Some("CmdOrCtrl+["),
    )?;
    let go_forward = MenuItem::with_id(
        app,
        "menu.go.forward",
        "Forward",
        true,
        Some("CmdOrCtrl+]"),
    )?;
    let go_dashboard = MenuItem::with_id(
        app,
        "menu.go.dashboard",
        "Dashboard    (g d)",
        true,
        None::<&str>,
    )?;
    let go_add_apps = MenuItem::with_id(
        app,
        "menu.go.add_apps",
        "Add Apps…    (g n)",
        true,
        None::<&str>,
    )?;
    let go_stats = MenuItem::with_id(
        app,
        "menu.go.stats",
        "Stats    (g t)",
        true,
        None::<&str>,
    )?;
    let go_manual_apps = MenuItem::with_id(
        app,
        "menu.go.manual_apps",
        "Manual Apps",
        true,
        None::<&str>,
    )?;
    let go_activity = MenuItem::with_id(
        app,
        "menu.go.activity",
        "Activity",
        true,
        None::<&str>,
    )?;
    let go_diagnostics = MenuItem::with_id(
        app,
        "menu.go.diagnostics",
        "Diagnostics",
        true,
        None::<&str>,
    )?;
    let go_menu = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &go_back,
            &go_forward,
            &PredefinedMenuItem::separator(app)?,
            &go_dashboard,
            &go_add_apps,
            &go_stats,
            &go_manual_apps,
            &go_activity,
            &go_diagnostics,
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
    let user_guide = MenuItem::with_id(
        app,
        "menu.help.user_guide",
        "User Guide",
        true,
        None::<&str>,
    )?;
    let report_issue = MenuItem::with_id(
        app,
        "menu.help.report_issue",
        "Report Issue…",
        true,
        None::<&str>,
    )?;
    let copy_diagnostics = MenuItem::with_id(
        app,
        "menu.help.copy_diagnostics",
        "Copy Diagnostics Report",
        true,
        None::<&str>,
    )?;
    let github = MenuItem::with_id(
        app,
        "menu.help.github",
        "privacytracker on GitHub",
        true,
        None::<&str>,
    )?;
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &user_guide,
            &report_issue,
            &PredefinedMenuItem::separator(app)?,
            &copy_diagnostics,
            &PredefinedMenuItem::separator(app)?,
            &github,
        ],
    )?;

    // ── Dev submenu (gated) ──────────────────────────────────────────
    // Quick-access affordances for developers and power users with
    // the dev-options flag on. Hidden entirely when `dev_menu_enabled`
    // is false so the menu bar stays clean for everyone else.
    let dev_menu = if dev_menu_enabled {
        let dev_data_folder = MenuItem::with_id(
            app,
            "menu.dev.open_data_folder",
            "Open Data Folder",
            true,
            None::<&str>,
        )?;
        let dev_log_folder = MenuItem::with_id(
            app,
            "menu.dev.open_log_folder",
            "Open Log Folder",
            true,
            None::<&str>,
        )?;
        let dev_diagnostics = MenuItem::with_id(
            app,
            "menu.dev.diagnostics",
            "Diagnostics Page",
            true,
            None::<&str>,
        )?;
        let dev_ai_debug = MenuItem::with_id(
            app,
            "menu.dev.ai_debug_log",
            "AI Debug Log",
            true,
            None::<&str>,
        )?;
        let dev_feature_flags = MenuItem::with_id(
            app,
            "menu.dev.feature_flags",
            "Feature Flags",
            true,
            None::<&str>,
        )?;
        Some(Submenu::with_items(
            app,
            "Dev",
            true,
            &[
                &dev_data_folder,
                &dev_log_folder,
                &PredefinedMenuItem::separator(app)?,
                &dev_diagnostics,
                &dev_ai_debug,
                &dev_feature_flags,
            ],
        )?)
    } else {
        None
    };

    // Assemble the top-level menu. The Dev submenu slots between Go
    // and Window when enabled, mirroring how Safari's "Develop" menu
    // is placed in its menu bar.
    let mut tabs: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![
        &app_menu,
        &file_menu,
        &edit_menu,
        &view_menu,
        &go_menu,
    ];
    if let Some(ref dev) = dev_menu {
        tabs.push(dev);
    }
    tabs.push(&window_menu);
    tabs.push(&help_menu);
    Menu::with_items(app, &tabs)
}

/// Reveal a filesystem path in the OS file manager. Used by the
/// Dev-menu "Open data/log folder" items. Best-effort — silently
/// no-ops on failure since the user gets an obvious error from the
/// shell helper if the path is unreachable.
fn open_path_in_file_manager(dir: &std::path::Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(dir).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(dir).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    }
}

/// Reveal the main window if hidden and navigate it to a relative
/// path inside the Next sidecar. Shared by every "Go" menu entry so
/// the surface + navigate behaviour stays consistent. `path` is
/// passed through `JSON.stringify` so the JS literal it lands in
/// can't be broken by an embedded quote — even though we control
/// the routes today, this keeps the dispatch structurally safe if
/// a future caller threads a query string through.
fn navigate<R: Runtime>(app: &AppHandle<R>, path: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let encoded = serde_json::to_string(path).unwrap_or_else(|_| "\"/\"".into());
        let _ = window.eval(&format!("window.location.assign({encoded})"));
    }
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
        // Page zoom. zoom.rs owns the ladder + clamped stepping, applies
        // the level via WebviewWindow::set_zoom, and debounce-persists it
        // to /api/settings/desktop so the next launch restores it.
        "menu.view.zoom_in" => zoom::zoom_in(app),
        "menu.view.zoom_out" => zoom::zoom_out(app),
        "menu.view.zoom_reset" => zoom::reset(app),
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
            // appropriately. No-op when the `devtools` cargo feature
            // is off (production release builds): the methods
            // compile out and the menu item itself is disabled
            // when built without `--features devtools`.
            #[cfg(feature = "devtools")]
            if let Some(window) = app.get_webview_window("main") {
                let next_open = !window.is_devtools_open();
                if next_open {
                    window.open_devtools();
                } else {
                    window.close_devtools();
                }
                crate::commands::persist_devtools_open(next_open);
            }
            #[cfg(not(feature = "devtools"))]
            {
                let _ = app;
            }
        }
        "menu.go.back" => {
            // history.back() walks the browser's session history. When
            // there's nothing to go back to (just landed on the first
            // route) this is a no-op — the OS still consumes the
            // shortcut so it doesn't bubble to a default handler.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.history.back()");
            }
        }
        "menu.go.forward" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.history.forward()");
            }
        }
        // Page jumps. Each one shows the window first (in case the user
        // had hidden it to the menu bar) and then assigns the route.
        // Relative paths so we don't need to thread the sidecar port
        // through the menu module.
        "menu.go.dashboard" => navigate(app, "/dashboard"),
        "menu.go.add_apps" => navigate(app, "/onboard"),
        "menu.go.stats" => navigate(app, "/dashboard/stats"),
        "menu.go.manual_apps" => navigate(app, "/dashboard/manual-apps"),
        "menu.go.activity" => navigate(app, "/changelog"),
        "menu.go.diagnostics" => navigate(app, "/dashboard/diagnostics"),
        "menu.file.sync_now" => {
            // Fire a same-origin POST against the sidecar's manual-sync
            // endpoint. The endpoint is rate-limited (10/10min) and
            // surfaces a toast / activity-log row on completion, so
            // there's nothing for us to render here. The IIFE swallows
            // network failures silently — the user sees the result via
            // the Task Center.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.eval(
                    "fetch('/api/sync/trigger', { method: 'POST' }).catch(() => {})",
                );
            }
        }
        "menu.file.mark_all_read" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(
                    "fetch('/api/notifications', { \
                       method: 'POST', \
                       headers: { 'content-type': 'application/json' }, \
                       body: JSON.stringify({ action: 'mark_read' }), \
                     }).then(() => window.dispatchEvent(new CustomEvent('notifications:refresh'))).catch(() => {})",
                );
            }
        }
        "menu.edit.find" => {
            // Dispatch a window event the dashboard's search bar
            // listens for. Pages without a search bar just no-op.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(
                    "window.dispatchEvent(new CustomEvent('search:focus'))",
                );
            }
        }
        "menu.help.user_guide" => {
            #[allow(deprecated)]
            {
                use tauri_plugin_shell::ShellExt;
                let _ = app.shell().open(DOCS_URL, None);
            }
        }
        "menu.help.report_issue" => {
            #[allow(deprecated)]
            {
                use tauri_plugin_shell::ShellExt;
                let _ = app.shell().open(ISSUE_URL, None);
            }
        }
        "menu.help.copy_diagnostics" => {
            // Dispatch a window event; a tiny client-side listener
            // invokes `get_diagnostics_report` and writes the result
            // to the clipboard. Routing it through JS keeps the
            // clipboard-permission story simple — we don't need to
            // add a Rust clipboard plugin just for this menu item.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(
                    "window.dispatchEvent(new CustomEvent('diagnostics:copy-report'))",
                );
            }
        }
        "menu.dev.open_data_folder" => {
            // Inlined rather than delegated to `commands::open_data_dir`
            // because that fn takes a concrete `AppHandle` (= `AppHandle<Wry>`)
            // while this handler is generic over `R: Runtime`.
            if let Some(dir) = dirs::data_dir() {
                let path = dir.join("privacytracker");
                open_path_in_file_manager(&path);
            }
        }
        "menu.dev.open_log_folder" => {
            if let Ok(dir) = app.path().app_log_dir() {
                open_path_in_file_manager(&dir);
            }
        }
        "menu.dev.diagnostics" => navigate(app, "/dashboard/diagnostics"),
        "menu.dev.ai_debug_log" => navigate(app, "/dashboard/settings#ai-summaries"),
        "menu.dev.feature_flags" => navigate(app, "/dashboard/settings#developer"),
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

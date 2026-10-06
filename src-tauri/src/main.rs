// privacytracker — Tauri desktop shell.
//
// Boot sequence:
//   1-3. Start the backend (backend.rs): the Rust core serves the app from
//      this process, over the per-user data directory, on the loopback
//      port this install used last. The rest of the shell only sees a base
//      URL. (Releases up to v0.1.2 spawned a bundled Node process here
//      instead; that sidecar was retired ahead of v0.3.0.)
//   4. The embedded server is listening before it reports its address, so
//      there is nothing to wait for.
//   5. Point the main window at 127.0.0.1:<port> and show it — unless the
//      process was started with --hidden (the LaunchAgent that starts it at
//      login passes this) or "launch hidden in tray" is on. Showing goes
//      through window_lock, which asks for Touch ID / password first when
//      desktop_require_unlock is set, as it does on every later reveal.
//   6. Install the tray icon + menu.
//   7. Start the notification watcher thread (polls /api/notifications,
//      updates the Dock badge, fires native notifications for new rows).
//   8. Register the global shortcut (default ⌘⇧P).
//   9. Wire up the privacytracker:// deep-link handler.
//
// Closing the window hides it instead of exiting — the tray keeps the
// server (and therefore the 30-min background scheduler + crash-safe
// wayback/sync/policy resume loops) alive until the user explicitly quits
// from the tray.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod backend;
mod embedded;
mod tray;
mod commands;
mod settings;
mod notifications;
mod shortcuts;
mod deep_link;
mod diagnostics;
mod cfgutil;
mod usb_watcher;
mod app_menu;
mod zoom;
#[cfg(target_os = "macos")]
mod touch_id;
mod window_lock;
mod update_guard;
mod autostart;

use std::sync::Mutex;

use once_cell::sync::OnceCell;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;

/// State that outlives any one window: the handle that stops the backend
/// and the port it's listening on. Wrapped in a Mutex so the tray menu and
/// commands can cooperate with the boot path without racing each other.
pub struct AppState {
    pub backend_port: u16,
    pub backend_base_url: String,
    /// `None` in `tauri dev` when the user is pointing at their own
    /// `next dev` server via the PRIVACYTRACKER_DEV_URL env var. `Some`
    /// in every shipped build.
    pub backend: Mutex<Option<backend::Running>>,
}

static STATE: OnceCell<AppState> = OnceCell::new();

pub fn state() -> &'static AppState {
    STATE.get().expect("AppState not initialised")
}

/// True when the process was started with `--hidden`, which the autostart
/// LaunchAgent always passes: a launch at login starts in the menu bar. The
/// plugin writes the flag into the plist's ProgramArguments (see the
/// `.plugin(tauri_plugin_autostart::init(...))` call below).
fn launched_hidden() -> bool {
    std::env::args().any(|a| a == "--hidden")
}

/// `--smoke-server <dir>`: the hidden mode the release verifier drives
/// against a packaged app (see `embedded::smoke`). The directory comes on
/// the command line, never from the environment, so a shipped app can
/// never be pointed at a user's data this way. The flag without a
/// directory exits rather than falling through to a window nobody asked
/// for.
fn smoke_server_dir() -> Option<std::path::PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--smoke-server" {
            return match args.next() {
                Some(dir) => Some(std::path::PathBuf::from(dir)),
                None => {
                    eprintln!("--smoke-server needs a directory to serve over");
                    std::process::exit(2);
                }
            };
        }
    }
    None
}

fn main() {
    // The release verifier's hidden mode, before anything else starts: it
    // serves over the directory it was given and waits, with no window and
    // no tray. Never returns.
    if let Some(dir) = smoke_server_dir() {
        embedded::smoke(&dir);
    }

    // NOTE: do NOT call `env_logger::init()` here. `tauri-plugin-log` (added
    // below) installs the global `log` facade subscriber for us, and Rust's
    // `log` facade rejects a second registration with
    //   "attempted to set a logger after the logging system was already
    //    initialized"
    // which manifests as a `PluginInitialization("log", ...)` panic at
    // app boot. The plugin is configured below to write to stdout AND the
    // app's log dir, so we don't lose Terminal-launched diagnostics by
    // dropping env_logger.

    tauri::Builder::default()
        // Route every custom menu-bar event (Reload / Force Reload /
        // Toggle DevTools / Help → GitHub) through one handler so the
        // menu wiring lives in app_menu.rs alongside its definition.
        // Predefined items (Cut / Copy / Paste / Quit / About / etc.)
        // never reach this — the OS responder chain handles them
        // directly, which is why they work even on inputs the webview
        // owns.
        .on_menu_event(app_menu::handle_event)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // relaunch() after an update installs (lib/tauri-updater.ts). The
        // restart goes through RunEvent::ExitRequested below, so the
        // server is shut down before the new version starts.
        .plugin(tauri_plugin_process::init())
        // "Start at login" writes a LaunchAgent,
        // ~/Library/LaunchAgents/privacytracker.plist, whose
        // ProgramArguments carry "--hidden" so a login launch skips the
        // boot reveal below. A LaunchAgent needs no permission. The
        // AppleScript launcher used before drove System Events, which the
        // signed app is not entitled to do, so it most likely never worked;
        // autostart::migrate registers the LaunchAgent for users who had
        // the setting on.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        // Remembers size and position, but not visibility: restoring a
        // window that was open at quit would show it before window_lock
        // could ask to unlock it, and would ignore "launch hidden".
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        // tauri-plugin-log owns the global `log` facade. We point it at
        // three targets so you get the same visibility env_logger gave us
        // before:
        //   - Stdout: visible when the user runs the binary from Terminal
        //     (`/Applications/privacytracker.app/Contents/MacOS/privacytracker`),
        //     which is the diagnostic mode we lean on when boot fails.
        //   - LogDir: a rolling file in
        //     ~/Library/Logs/<bundle-id>/ on macOS, covering the
        //     Finder-launched case where stdout is swallowed.
        //   - Webview: dev-only, so log::info!() shows up in the inspector.
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::set_dock_visibility,
            commands::backend_base_url,
            commands::open_data_dir,
            commands::open_log_dir,
            commands::toggle_devtools,
            commands::register_global_shortcut,
            commands::get_diagnostics_report,
            commands::authenticate_touch_id,
            commands::set_dock_badge,
            commands::set_tray_visible,
            commands::reveal_main_window,
            update_guard::install_verified_update,
            cfgutil::check_cfgutil,
            cfgutil::run_cfgutil_export,
            cfgutil::list_connected_devices,
            cfgutil::run_cfgutil_backup,
            cfgutil::run_cfgutil_remove_app,
        ])
        .setup(|app| {
            // 1-3. Start the server (or accept the dev-server URL).
            //
            // Catch errors here rather than returning them: Tauri's
            // setup hook turns Err into a panic inside obj-c
            // `did_finish_launching`, which can't unwind across the
            // C ABI and aborts with a 100-line stack trace that
            // hides the real cause. Exiting cleanly keeps the
            // failure message to the actionable bit (the boot path's
            // own error string, e.g. which directory could not be
            // opened).
            let boot = match backend::boot(&app.handle()) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("\n[privacytracker] FATAL: failed to start the backend: {e}\n");
                    std::process::exit(1);
                }
            };

            STATE
                .set(AppState {
                    backend_port: boot.port,
                    backend_base_url: boot.base_url.clone(),
                    backend: Mutex::new(boot.running),
                })
                .ok()
                .expect("AppState already initialised");

            // 4. Nothing to wait for: the embedded server's listener is
            // bound and its router built before `boot` returns.

            // Fetch the full desktop settings bundle in one round-trip. Used
            // by the boot path to decide whether to show the window, whether
            // to register the shortcut, whether to require Touch ID, etc.
            let desktop_settings = settings::fetch(&boot.base_url).unwrap_or_default();
            log::info!("Desktop settings on boot: {desktop_settings:?}");

            // Point the main window at the live server regardless — we may
            // still reveal it later via the tray, a deep link, or the global
            // shortcut. Loading now means that first reveal is instant.
            //
            // We use `WebviewWindow::navigate()` rather than evaluating
            // `window.location.replace(...)` from inside the webview. The
            // window's initial URL is `about:blank`, and JS navigation away
            // from `about:blank` to a different origin (here: 127.0.0.1:<port>)
            // is silently blocked in some webview engines as a security
            // measure. The Rust-side navigate() bypasses that — it tells the
            // wry webview to load the URL directly, like clicking a link.
            //
            // On the Rust backend the first stop is a one-time sign-in link
            // (backend::entry_url) that gives the webview this launch's
            // credential as an HttpOnly cookie and redirects to the start
            // page; every other navigation stays on that origin and keeps it.
            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;
            let url: tauri::Url = backend::entry_url(&boot.base_url).parse()?;
            window.navigate(url)?;

            let hidden_boot = launched_hidden() || desktop_settings.launch_hidden;

            // 5. Reveal the window unless we're on a hidden-boot path. The
            //    reveal runs on its own thread, so a Touch ID prompt (when
            //    desktop_require_unlock is on) doesn't hold up the tray and
            //    menu set up below. Every later reveal goes through the same
            //    gate, and auto-lock hides the window again after the idle
            //    time the user chose.
            window_lock::init(
                desktop_settings.require_unlock,
                desktop_settings.auto_lock_idle_minutes,
            );
            if !hidden_boot {
                window_lock::reveal(app.handle());
            }
            window_lock::spawn_auto_lock(app.handle().clone());

            // 5a. Restore the Web Inspector if the user had it open
            //     last quit. desktop_settings.devtools_open is read from
            //     the same /api/settings/desktop bundle settings::fetch
            //     pulls above; commands::toggle_devtools persists the
            //     new state every time the user flips the inspector.
            //     Without this, devs lose their inspector state every
            //     launch. No-op in release builds — the `devtools`
            //     cargo feature is off, so `open_devtools()` compiles out.
            #[cfg(feature = "devtools")]
            if desktop_settings.devtools_open {
                window.open_devtools();
            }

            // 5a-bis. Restore the persisted webview zoom level (WCAG
            //     1.4.4 — the View-menu ⌘±/⌘0 items step it, zoom.rs
            //     persists it through the same /api/settings/desktop
            //     bundle as devtools_open). Page zoom is a webview
            //     property, so applying it once here survives every
            //     subsequent in-app navigation.
            zoom::init(&app.handle(), desktop_settings.zoom_level);

            // 5b. Install the native menu bar (App / File / Edit /
            //     View / Go / [Dev] / Window / Help). Must run after
            //     the window is created because the predefined menu
            //     items take an &AppHandle and the OS attaches them to
            //     the responder chain on focus, but it doesn't have to
            //     wait on the server — putting it here keeps the boot
            //     ordering readable (window first, then chrome that
            //     decorates it).
            //
            //     The Dev submenu is gated on the `dev_menu_enabled`
            //     persisted setting. Read it via ureq up front (one
            //     tiny GET to the loopback server) so the menu tree
            //     reflects the user's choice from launch. Flipping
            //     the flag at runtime requires an app restart.
            let dev_menu_enabled = {
                backend::get(&boot.base_url, "/api/dev-menu-state")
                    .timeout(std::time::Duration::from_secs(2))
                    .call()
                    .ok()
                    .and_then(|r| r.into_json::<serde_json::Value>().ok())
                    .and_then(|v| v.get("enabled").and_then(|x| x.as_bool()))
                    .unwrap_or(false)
            };
            let menu = app_menu::build(app.handle(), dev_menu_enabled)?;
            app.set_menu(menu)?;

            // 6. Install the tray. We pass the user's persisted
            //    `tray_visible` toggle so a returning user who hid
            //    the menu-bar icon last quit doesn't see it briefly
            //    flash on at boot. The tray itself is always
            //    *installed* — set_tray_visible (commands.rs) flips
            //    the icon's visibility live without needing a tear-
            //    down/rebuild.
            tray::install(
                app.handle(),
                boot.base_url.clone(),
                desktop_settings.tray_visible,
            )?;

            // 7. Start the notifications watcher (dock badge + native toasts).
            notifications::spawn_watcher(
                app.handle().clone(),
                boot.base_url.clone(),
                desktop_settings.native_notifications,
            );

            // 8. Register the persisted global shortcut (defaults to ⌘⇧P).
            shortcuts::register_from_settings(app.handle(), &desktop_settings.global_shortcut);

            // 9. Wire up the deep-link handler so privacytracker://app/<id>
            //    routes to the right detail page inside the webview.
            deep_link::install(app.handle(), boot.base_url.clone());

            // 10. Start the IOKit USB watcher. Emits `cfgutil:device-connected`
            //     events whenever an iPhone/iPad attaches. The toast on
            //     /onboard subscribes and is gated behind the
            //     `cfgutil_imported_at` flag so users who never used cfgutil
            //     never see it. Replaces the previous 5s-poll loop in
            //     DeviceConnectedToast that was blocking the apps-page
            //     navigation. No-op outside macOS.
            usb_watcher::start(app.handle().clone());

            // 11. Move "Start at login" to the LaunchAgent for users who
            //     turned it on under the old AppleScript launcher. Runs once.
            autostart::migrate(app.handle());

            // Restore persisted Dock visibility choice. Read from the same
            // /api/settings endpoint the UI uses, so the source of truth
            // stays on the Node side.
            #[cfg(target_os = "macos")]
            {
                commands::apply_dock_visibility(!desktop_settings.hide_dock, app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Intercept the close button: hide instead of exit so the
            // background scheduler keeps ticking from the tray. Hiding
            // locks the window again when unlock is required.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                window_lock::hide(window);
            }
            // Focus changes count as use of the window, for auto-lock.
            WindowEvent::Focused(_) => window_lock::note_activity(),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Graceful server shutdown.
            //
            // We can't put this in `impl Drop for EmbeddedServer` because
            // `AppState` lives inside a `static OnceCell<AppState>` and
            // Rust doesn't run destructors of statics at process exit —
            // so a Drop impl would be unreachable (which is how the Node
            // helper of releases up to v0.1.2 used to survive a quit).
            //
            // `RunEvent::ExitRequested` fires for every quit path —
            // tray "Quit" (`app.exit(0)`), Cmd+Q on macOS, the menu-bar
            // Quit, the autoupdater's restart — so handling it here
            // covers all of them. We don't `prevent_exit()`, so the
            // runtime proceeds to tear down windows after our handler
            // returns.
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Some(state) = STATE.get() {
                    if let Ok(mut guard) = state.backend.lock() {
                        if let Some(handle) = guard.take() {
                            log::info!("ExitRequested — stopping the backend");
                            handle.shutdown();
                        }
                    }
                }
            }
        });
}

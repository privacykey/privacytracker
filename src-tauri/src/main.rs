// privacytracker — Tauri desktop shell.
//
// Boot sequence:
//   1. Pick a free localhost port.
//   2. Resolve the per-user data directory (PRIVACYTRACKER_DATA_DIR).
//   3. Spawn the bundled Node sidecar running Next.js standalone's server.js
//      with PORT / HOSTNAME / PRIVACYTRACKER_DATA_DIR env set.
//   4. Poll http://127.0.0.1:<port>/api/apps until it responds (Next.js is
//      live). The existing endpoint is used by the Docker healthcheck for
//      the same reason — it's the cheapest round-trip that proves lib/db.ts
//      initialised cleanly.
//   5. Point the main window at 127.0.0.1:<port> and show it — unless the
//      process was started with --hidden (the autostart plugin passes this
//      when "launch hidden in tray" is enabled) or desktop_require_unlock
//      is set and Touch ID hasn't been cleared yet.
//   6. Install the tray icon + menu.
//   7. Start the notification watcher thread (polls /api/notifications,
//      updates the Dock badge, fires native notifications for new rows).
//   8. Register the global shortcut (default ⌘⇧P).
//   9. Wire up the privacytracker:// deep-link handler.
//
// Closing the window hides it instead of exiting — the tray keeps the
// sidecar (and therefore the 30-min background scheduler + crash-safe
// wayback/sync/policy resume loops) alive until the user explicitly quits
// from the tray.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod sidecar;
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

use std::sync::Mutex;

use once_cell::sync::OnceCell;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

/// State that outlives any one window: the sidecar child process handle and
/// the port it's listening on. Wrapped in a Mutex so the tray menu and
/// commands can cooperate with the boot path without racing each other.
pub struct AppState {
    pub sidecar_port: u16,
    pub sidecar_base_url: String,
    /// `None` in `tauri dev` when the user is pointing at their own
    /// `next dev` server via the PRIVACYTRACKER_DEV_URL env var (see
    /// sidecar::resolve_base_url). `Some` in every shipped build.
    pub sidecar: Mutex<Option<sidecar::SidecarHandle>>,
}

static STATE: OnceCell<AppState> = OnceCell::new();

pub fn state() -> &'static AppState {
    STATE.get().expect("AppState not initialised")
}

/// True when the process was started by the autostart LaunchAgent with
/// `--hidden` (i.e. the user enabled "launch hidden in tray"). The
/// autostart plugin appends this flag to its launch plist when we call
/// `autostart().enable_with_args(["--hidden"])`.
fn launched_hidden() -> bool {
    std::env::args().any(|a| a == "--hidden")
}

fn main() {
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
        // Passing Some(vec!["--hidden"]) means the LaunchAgent plist we
        // generate when autostart is enabled will spawn us with that flag —
        // letting the boot path below skip window.show().
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::AppleScript,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
            commands::sidecar_base_url,
            commands::open_data_dir,
            commands::open_log_dir,
            commands::toggle_devtools,
            commands::register_global_shortcut,
            commands::get_diagnostics_report,
            commands::authenticate_touch_id,
            commands::set_dock_badge,
            commands::set_tray_visible,
            commands::reveal_main_window,
            cfgutil::check_cfgutil,
            cfgutil::run_cfgutil_export,
            cfgutil::list_connected_devices,
            cfgutil::run_cfgutil_backup,
            cfgutil::run_cfgutil_remove_app,
        ])
        .setup(|app| {
            // 1-3. Spawn sidecar (or accept the dev-server URL).
            //
            // Catch errors here for the same reason as the
            // wait_until_ready check below — Tauri's setup hook
            // turns Err into a panic inside obj-c
            // `did_finish_launching`, which can't unwind across the
            // C ABI and aborts with a 100-line stack trace that
            // hides the real cause. Exiting cleanly keeps the
            // failure message to the actionable bit (sidecar boot
            // path's own error string, e.g. "Bundled standalone
            // tarball is incomplete… delete it and re-run").
            let boot = match sidecar::boot(&app.handle()) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("\n[privacytracker] FATAL: failed to spawn the Node sidecar: {e}\n");
                    std::process::exit(1);
                }
            };

            STATE
                .set(AppState {
                    sidecar_port: boot.port,
                    sidecar_base_url: boot.base_url.clone(),
                    sidecar: Mutex::new(boot.child),
                })
                .ok()
                .expect("AppState already initialised");

            // 4. Wait for /api/apps to respond before we reveal the window.
            //
            // Exit cleanly on timeout instead of returning the error up
            // through Tauri's setup hook. A returned Err from the setup
            // closure becomes a Rust panic inside `did_finish_launching`
            // (an Objective-C callback the app delegate fires), and
            // panics can't unwind across the C ABI → the process aborts
            // with a noisy "panic in a function that cannot unwind"
            // stack trace from tao's macos/app_delegate.rs:125. That
            // hides the actual cause (sidecar didn't boot) behind a
            // wall of Rust internals.
            //
            // Doing process::exit(1) here keeps the visible failure
            // crisp: a single log line saying exactly what went wrong
            // and how to recover, no obj-c boundary panic, no stack
            // trace. The user sees the actionable message and we exit
            // with a non-zero status that any wrapper script (CI,
            // make, etc.) treats as a failure normally.
            if let Err(e) = sidecar::wait_until_ready(&boot.base_url) {
                eprintln!("\n[privacytracker] FATAL: {e}\n");
                eprintln!(
                    "The Node sidecar at {} didn't respond before the readiness deadline.\n\
                     \n\
                     Most common cause: the bundled standalone tarball at\n\
                       src-tauri/resources/standalone.tar\n\
                     is incomplete (left over from a previous `pnpm tauri:dev` that was\n\
                     killed before stage-standalone.mjs finished writing it). Recover with:\n\
                     \n\
                       rm src-tauri/resources/standalone.tar\n\
                       pnpm tauri:dev\n\
                     \n\
                     The next BeforeDevCommand will write a fresh tarball and the sidecar\n\
                     will extract it cleanly.\n",
                    boot.base_url,
                );
                std::process::exit(1);
            }

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
            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;
            let url: tauri::Url = boot.base_url.parse()?;
            window.navigate(url)?;

            let hidden_boot = launched_hidden() || desktop_settings.launch_hidden;
            let needs_unlock = desktop_settings.require_unlock;

            // 5. Reveal the window iff we're not in a hidden-boot path.
            //    Touch ID prompting happens lazily in reveal_main_window so
            //    the tray icon and tray menu are interactive first.
            if !hidden_boot && !needs_unlock {
                window.show()?;
                window.set_focus().ok();
            }

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
            //     wait on the sidecar — putting it here keeps the boot
            //     ordering readable (window first, then chrome that
            //     decorates it).
            //
            //     The Dev submenu is gated on the `dev_menu_enabled`
            //     persisted setting. Read it via ureq up front (one
            //     tiny GET to the loopback sidecar) so the menu tree
            //     reflects the user's choice from launch. Flipping
            //     the flag at runtime requires an app restart.
            let dev_menu_enabled = {
                let url = format!("{}/api/dev-menu-state", boot.base_url);
                ureq::get(&url)
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

            // Restore persisted Dock visibility choice. Read from the same
            // /api/settings endpoint the UI uses, so the source of truth
            // stays on the Node side.
            #[cfg(target_os = "macos")]
            {
                commands::apply_dock_visibility(!desktop_settings.hide_dock, app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Intercept the close button: hide instead of exit so the
            // background scheduler keeps ticking from the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.hide().ok();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Graceful sidecar shutdown.
            //
            // We can't put this in `impl Drop for SidecarHandle` because
            // `AppState` lives inside a `static OnceCell<AppState>` and
            // Rust doesn't run destructors of statics at process exit —
            // so the Drop impl was unreachable, which is why the Node
            // helper used to survive a Tauri quit.
            //
            // We also can't rely on SIGHUP from the parent dying:
            // `sidecar::boot` calls `setsid()` in pre_exec to detach the
            // child from our Cocoa session (keeps the Dock clean), and
            // that same detachment means the kernel won't deliver SIGHUP
            // when we go away. The signal has to come from us.
            //
            // `RunEvent::ExitRequested` fires for every quit path —
            // tray "Quit" (`app.exit(0)`), Cmd+Q on macOS, the menu-bar
            // Quit, the autoupdater's restart — so handling it here
            // covers all of them. We don't `prevent_exit()`, so the
            // runtime proceeds to tear down windows after our handler
            // returns.
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Some(state) = STATE.get() {
                    if let Ok(mut guard) = state.sidecar.lock() {
                        if let Some(handle) = guard.take() {
                            log::info!("ExitRequested — shutting down sidecar");
                            handle.shutdown();
                        }
                    }
                }
            }
        });
}

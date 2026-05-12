// Declare every app-level `#[tauri::command]` as an inlined "appcmd"
// plugin so `tauri-build` generates `allow-<command>` permission manifests
// for them at build time. Tauri 2's ACL otherwise refuses to dispatch IPC
// calls for any command that lacks a permission entry — the failure mode
// is the runtime returning "<command> not allowed. Plugin not found",
// which is what the Configurator import hit before this was wired up.
//
// The plugin name MUST NOT be `"app"` — that collides with Tauri's
// built-in `core:app` plugin and the generated permissions silently
// overwrite each other (most of ours disappear, only `set_dock_visibility`
// survives by coincidence). `"appcmd"` is short, distinct, and won't
// match any future Tauri core plugin name.
//
// Register our `#[tauri::command]` functions as APP-level commands via
// `AppManifest`, not as an inlined plugin. The distinction matters at
// runtime: commands registered via `generate_handler!` in main.rs land
// in Tauri's APP command table, not in a plugin's command table. Their
// permissions live under the special `__app-acl__` namespace (see
// tauri_utils::acl::APP_ACL_KEY) and are referenced in capabilities
// WITHOUT a prefix — just `"allow-check-cfgutil"` or `"default"`.
//
// We tried `InlinedPlugin` first and it generated the right-looking
// manifest, but capability references like `appcmd:default` resolve
// against the `appcmd` plugin's command table, which doesn't contain
// our commands. The runtime correctly rejected every invoke. The fix
// is `AppManifest`, which is what tauri-build exposes for exactly
// this case.
//
// `commands(&[...])` here auto-generates `allow-<x>` / `deny-<x>`
// permissions for each listed command. Keep the list in sync with
// `invoke_handler!` in main.rs. The capability in
// `capabilities/main.json` references the resulting permissions via
// bare identifiers (`"allow-check-cfgutil"`, etc.).
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "set_dock_visibility",
                "sidecar_base_url",
                "open_data_dir",
                "open_log_dir",
                "toggle_devtools",
                "register_global_shortcut",
                "get_diagnostics_report",
                "authenticate_touch_id",
                "set_dock_badge",
                "set_tray_visible",
                "reveal_main_window",
                "check_cfgutil",
                "run_cfgutil_export",
                "list_connected_devices",
                "run_cfgutil_backup",
                "run_cfgutil_remove_app",
            ]),
        ),
    )
    .expect("tauri-build failed");
}

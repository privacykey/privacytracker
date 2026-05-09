// privacytracker:// URL scheme handler.
//
// Routes we understand:
//   privacytracker://app/<id>     → /apps/<id>
//   privacytracker://settings     → /dashboard/settings
//   privacytracker://             → /dashboard (reveal the window, no nav)
//
// Anything we don't recognise just reveals the window without navigating.
//
// The scheme is declared in tauri.conf.json under plugins.deep-link.desktop.schemes,
// which causes the bundler to inject a CFBundleURLTypes entry into Info.plist
// on macOS and a registry key on Windows. On macOS the system then routes
// `open privacytracker://foo` calls to the running app (or launches us if
// we're not running).

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

pub fn install(app: &AppHandle, base_url: String) {
    let app_for_handler = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle(&app_for_handler, &base_url, &url);
        }
    });
}

fn handle(app: &AppHandle, base_url: &str, url: &Url) {
    log::info!("Deep link received: {url}");

    // Always reveal — users who pasted a URL want the app to come forward,
    // even if they pasted a malformed one.
    let _ = crate::commands::reveal_main_window(app.clone());

    // Figure out the in-app path to navigate to.
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let path = url.path().trim_start_matches('/').to_string();

    let nav_path: Option<String> = match host.as_str() {
        "" => None,
        "app" => {
            // privacytracker://app/<id>
            if path.is_empty() {
                Some("/dashboard".to_string())
            } else {
                // Defensive: accept only [0-9]+ — the ids are Apple track IDs
                // and a scheme caller trying to smuggle `../` or a query
                // string into the nav target shouldn't get to touch the URL.
                if path.chars().all(|c| c.is_ascii_digit()) {
                    Some(format!("/apps/{path}"))
                } else {
                    log::warn!("Rejecting deep-link with non-numeric app id: {path}");
                    None
                }
            }
        }
        "settings" => Some("/dashboard/settings".to_string()),
        "dashboard" => Some("/dashboard".to_string()),
        _ => {
            log::warn!("Unknown deep-link host: {host}");
            None
        }
    };

    if let Some(nav) = nav_path {
        if let Some(window) = app.get_webview_window("main") {
            let target = format!("{base_url}{nav}");
            let _ = window.eval(&format!("window.location.assign('{target}')"));
        }
    }
}

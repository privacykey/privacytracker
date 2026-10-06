// Dock-badge + native-notification watcher.
//
// Polls /api/notifications every 15s. On every tick:
//   1. Reads unreadCount from the top-level response → pushes to the macOS
//      Dock tile badge (setBadgeLabel). Windows / Linux badge calls are
//      no-ops; native toasts still fire.
//   2. For any row whose created_at > last_seen_ts (tracked in AppState),
//      fire a native Notification Center / Windows toast via
//      tauri-plugin-notification. This is additive to the in-app bell — users
//      who turn off "Native notifications" in settings see the bell but no OS
//      toast. The dock badge is always on when the app is running.
//
// The poll is intentionally generous (15s). The scheduler inside the backend
// runs every 30 minutes, so we're not going to miss anything — the badge
// exists so users can see "there's something new" without opening the window.
//
// We do *not* mark notifications as read from here. Read-state belongs to
// the user interacting with the bell UI, not to an OS toast popping up.
//
// The /api/notifications response shape (see lib/notifications.ts):
//   { notifications: [{ id, app_name, change_summary: [...], created_at, read, ... }], unreadCount }
//
// Watermarks are created_at (monotonic ms since epoch), not id (UUIDs aren't
// orderable). On cold start we set the watermark to the current max so the
// first tick never toasts — users who restart the app don't want a flood of
// "New changes detected" toasts for notifications they already saw yesterday.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

const POLL_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
struct NotificationRow {
    #[allow(dead_code)]
    id: String,
    #[serde(default)]
    app_name: String,
    #[serde(default)]
    change_summary: serde_json::Value,
    #[serde(default)]
    created_at: i64,
}

#[derive(Deserialize)]
struct NotificationsResponse {
    #[serde(default)]
    notifications: Vec<NotificationRow>,
    #[serde(default, rename = "unreadCount")]
    unread_count: i64,
}

pub fn spawn_watcher(app: AppHandle, base_url: String, native_notifications: bool) {
    let native_on = Arc::new(AtomicBool::new(native_notifications));
    // Per-session watermark. Seeded to i64::MAX on first tick so we don't
    // backfill-toast; the tick below will reset it to the actual max
    // created_at once the first response lands. That pattern also means the
    // first tick sets the badge correctly without firing any toasts.
    let watermark = Arc::new(AtomicI64::new(i64::MAX));
    let first_tick = Arc::new(AtomicBool::new(true));

    let app_clone = app.clone();
    thread::spawn(move || {
        loop {
            if let Err(e) = tick(&app_clone, &base_url, &native_on, &watermark, &first_tick) {
                log::warn!("notifications watcher tick failed: {e}");
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
}

fn tick(
    app: &AppHandle,
    base_url: &str,
    native_on: &Arc<AtomicBool>,
    watermark: &Arc<AtomicI64>,
    first_tick: &Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error>> {
    let resp: NotificationsResponse = crate::backend::get(base_url, "/api/notifications")
        .timeout(Duration::from_secs(5))
        .call()?
        .into_json()?;

    // Unread count drives the Dock badge — trust the server's count, it's
    // the same query the bell UI uses.
    let unread = resp.unread_count.max(0) as usize;
    set_dock_badge(unread);

    // Compute the new watermark.
    let max_ts = resp
        .notifications
        .iter()
        .map(|n| n.created_at)
        .max()
        .unwrap_or(0);

    if first_tick.swap(false, Ordering::Relaxed) {
        // Seed watermark to the current max so we never toast on the first
        // poll after a restart.
        watermark.store(max_ts, Ordering::Relaxed);
        return Ok(());
    }

    let prev_watermark = watermark.load(Ordering::Relaxed);

    // Toast anything newer than the last watermark. Bounded to 3 per tick
    // so a burst doesn't spam the user.
    if native_on.load(Ordering::Relaxed) {
        let mut fresh: Vec<&NotificationRow> = resp
            .notifications
            .iter()
            .filter(|n| n.created_at > prev_watermark)
            .collect();
        fresh.sort_by_key(|n| n.created_at);
        for row in fresh.iter().take(3) {
            let title = if row.app_name.is_empty() {
                "privacytracker".to_string()
            } else {
                row.app_name.clone()
            };
            let body = summary_body(&row.change_summary);
            let _ = app
                .notification()
                .builder()
                .title(&title)
                .body(&body)
                .show();
        }
    }

    if max_ts > prev_watermark {
        watermark.store(max_ts, Ordering::Relaxed);
    }

    Ok(())
}

/// Turn the change_summary JSON blob into one line for an OS toast. The
/// server stores it as an array of ChangeEntry objects. A row whose first
/// entry is not a privacy-label diff (an app update, a policy event, a
/// system notice) describes itself in its `description`, so that is the
/// body: it used to read "1 privacy change detected" for an app that had
/// merely shipped a new version. Label diffs are counted rather than
/// re-rendered in Rust.
fn summary_body(change_summary: &serde_json::Value) -> String {
    use serde_json::Value;
    const DIFF_TYPES: [&str; 5] = ["added", "removed", "modified", "policy", "wayback"];
    match change_summary {
        Value::Array(rows) => {
            let first = rows.first();
            let kind = first
                .and_then(|r| r.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !DIFF_TYPES.contains(&kind) {
                if let Some(text) = first
                    .and_then(|r| r.get("description"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                {
                    return text.to_string();
                }
            }
            let all_policy = !rows.is_empty()
                && rows
                    .iter()
                    .all(|r| r.get("category").and_then(Value::as_str) == Some("privacy-policy"));
            if all_policy {
                return "Privacy policy text changed".to_string();
            }
            match rows.len() {
                0 => "New notification".to_string(),
                1 => "1 privacy label change detected".to_string(),
                n => format!("{n} privacy label changes detected"),
            }
        }
        Value::String(s) => s.clone(),
        _ => "Privacy changes detected".to_string(),
    }
}

#[cfg(test)]
mod summary_body_tests {
    use super::summary_body;
    use serde_json::json;

    #[test]
    fn an_app_update_reads_as_its_own_description() {
        let body = summary_body(&json!([{
            "type": "version_update",
            "description": "Maps updated from v1.2 to v1.3 (released 15 Sept 2026).",
            "previousVersion": "1.2",
            "currentVersion": "1.3"
        }]));
        assert_eq!(
            body,
            "Maps updated from v1.2 to v1.3 (released 15 Sept 2026)."
        );
    }

    #[test]
    fn system_notices_read_as_their_description() {
        let body = summary_body(&json!([{
            "type": "import_completed",
            "description": "Imported 42 of 50 from ios-apps.csv."
        }]));
        assert_eq!(body, "Imported 42 of 50 from ios-apps.csv.");
    }

    #[test]
    fn label_diffs_are_counted() {
        let one = summary_body(&json!([{ "type": "added", "description": "x" }]));
        assert_eq!(one, "1 privacy label change detected");
        let three = summary_body(&json!([
            { "type": "added", "description": "a" },
            { "type": "removed", "description": "b" },
            { "type": "modified", "description": "c" }
        ]));
        assert_eq!(three, "3 privacy label changes detected");
    }

    #[test]
    fn a_policy_change_is_named_not_counted() {
        let body = summary_body(&json!([{
            "type": "policy",
            "category": "privacy-policy",
            "description": "Privacy policy text changed at example.com."
        }]));
        assert_eq!(body, "Privacy policy text changed");
    }

    #[test]
    fn other_shapes_keep_their_fallbacks() {
        assert_eq!(summary_body(&json!([])), "New notification");
        assert_eq!(summary_body(&json!("as stored")), "as stored");
        assert_eq!(summary_body(&json!(null)), "Privacy changes detected");
        // A non-diff entry with no usable description still gets a line.
        assert_eq!(
            summary_body(&json!([{ "type": "version_update", "description": "  " }])),
            "1 privacy label change detected"
        );
    }
}

/// Set the Dock tile badge on macOS. No-op elsewhere.
pub fn set_dock_badge(count: usize) {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        // See commands.rs — we reach AppKit through the obj-c runtime
        // directly so we don't have to chase objc2-app-kit's reshuffled
        // export paths every dep update. objc2-foundation::NSString stays
        // a typed import because touch_id.rs uses it the same way and it
        // hasn't shown the same instability.
        // SAFETY: -[NSApplication sharedApplication] and -[NSDockTile
        // setBadgeLabel:] are both runtime-safe; nil clears the badge.
        unsafe {
            let cls = class!(NSApplication);
            let app: *mut AnyObject = msg_send![cls, sharedApplication];
            if app.is_null() {
                return;
            }
            // NSApplication.dockTile is an NSDockTile * — we just need to
            // call setBadgeLabel: with an NSString* (or nil to clear).
            let dock_tile: *mut AnyObject = msg_send![app, dockTile];
            if dock_tile.is_null() {
                return;
            }
            if count == 0 {
                let _: () = msg_send![dock_tile, setBadgeLabel: std::ptr::null::<AnyObject>()];
            } else {
                let label = NSString::from_str(&count.to_string());
                let _: () = msg_send![dock_tile, setBadgeLabel: &*label];
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = count;
    }
}

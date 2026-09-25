// Start at login, moved to a LaunchAgent.
//
// Earlier builds registered "Start at login" as a login item through System
// Events (tauri-plugin-autostart's AppleScript launcher). That sends Apple
// Events, which the signed, hardened app has neither the entitlement nor the
// usage description for, so macOS most likely refused it without a word:
// the setting read "on" and nothing started at login. The plugin now writes
// a LaunchAgent instead (~/Library/LaunchAgents/privacytracker.plist), which
// needs no permission (main.rs).
//
// Users who turned the setting on before this change have it stored as on
// but no LaunchAgent. On the first launch of this build, `migrate`
// registers one for them. It runs once: a marker file in the app's config
// directory records that it has, so a LaunchAgent the user removes later is
// not put back. If the settings can't be read, or registering fails, no
// marker is written and the next launch tries again.
//
// A login item an earlier build did manage to add is left alone: removing
// it would need the same Apple Events permission. If one exists, it shows
// under System Settings → General → Login Items and can be removed there.

use std::path::Path;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;

const MARKER: &str = "autostart-launch-agent";

/// What the first launch of this build does about start at login.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Migration {
    /// Already done on an earlier launch.
    Done,
    /// The setting is on and no LaunchAgent exists: register one, then
    /// write the marker.
    Register,
    /// Nothing to register: write the marker.
    MarkDone,
}

pub(crate) fn plan(marker_exists: bool, autostart_setting: bool, launch_agent_exists: bool) -> Migration {
    if marker_exists {
        Migration::Done
    } else if autostart_setting && !launch_agent_exists {
        Migration::Register
    } else {
        Migration::MarkDone
    }
}

/// Run the one-time migration on a background thread.
pub fn migrate<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("autostart-migration".into())
        .spawn(move || {
            if let Err(e) = run(&app) {
                log::warn!("autostart: couldn't move start at login to a LaunchAgent, will retry next launch: {e}");
            }
        });
    if let Err(e) = spawned {
        log::warn!("autostart: couldn't start the migration: {e}");
    }
}

fn run<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let marker = dir.join(MARKER);
    if marker.exists() {
        return Ok(());
    }
    let state = crate::STATE.get().ok_or("the backend isn't running")?;
    let settings = crate::settings::fetch(&state.sidecar_base_url).map_err(|e| e.to_string())?;
    let manager = app.autolaunch();
    let launch_agent_exists = manager.is_enabled().map_err(|e| e.to_string())?;

    match plan(false, settings.autostart, launch_agent_exists) {
        Migration::Done => return Ok(()),
        Migration::Register => {
            manager.enable().map_err(|e| e.to_string())?;
            log::info!("autostart: start at login is now a LaunchAgent");
        }
        Migration::MarkDone => {}
    }
    write_marker(&dir, &marker)
}

fn write_marker(dir: &Path, marker: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(
        marker,
        "Start at login uses a LaunchAgent. Delete this file to re-register it on the next launch.\n",
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_a_launch_agent_for_users_who_had_the_setting_on() {
        assert_eq!(plan(false, true, false), Migration::Register);
    }

    #[test]
    fn leaves_an_existing_launch_agent_and_an_off_setting_alone() {
        assert_eq!(plan(false, true, true), Migration::MarkDone);
        assert_eq!(plan(false, false, false), Migration::MarkDone);
        // A LaunchAgent with the setting off is the page's to remove, not
        // the migration's.
        assert_eq!(plan(false, false, true), Migration::MarkDone);
    }

    #[test]
    fn runs_once() {
        for setting in [true, false] {
            for agent in [true, false] {
                assert_eq!(plan(true, setting, agent), Migration::Done);
            }
        }
    }
}

//! The notification writers a scrape reaches (lib/notifications.ts): the
//! parser-fallthrough alert before the commit, the version-update and
//! profile-mismatch bells after it, each with its own settings-backed
//! dedupe window, plus `computeNotBefore` for the change notification the
//! commit itself inserts. Every function here is called best-effort by the
//! scraper: a failure is logged and the scrape still succeeds.
use super::{
    js::js_regex,
    persist::{message, Ids, Writer},
};
use crate::{
    jsdate::{at_local_time, en_au_short_date, local_time},
    jsnum::{js_parse_int, js_to_number},
    server::{flags, grid_meta::Mismatch, settings::get_setting_with},
};
use serde_json::{json, Value};

const INSERT_NOTIFICATION: &str = "\n    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)\n    VALUES (?, ?, ?, ?, ?, 0)\n  ";
const PRUNE_NOTIFICATIONS: &str = "DELETE FROM notifications\n          WHERE id IN (\n            SELECT id FROM notifications\n            WHERE read = 1\n            ORDER BY created_at ASC\n            LIMIT ?\n          )";
const NOTIFICATION_RETENTION: i64 = 5000;
const PARSER_FALLTHROUGH_APP_ID: &str = "__parser_fallthrough__";
const PARSER_FALLTHROUGH_LAST_NOTIFIED_KEY: &str = "parser_fallthrough_last_notified_at";
const PARSER_FALLTHROUGH_COOLDOWN_MS: i64 = 24 * 60 * 60 * 1000;
const VERSION_UPDATE_NOTIFY_WINDOW_MS: f64 = 60.0 * 60_000.0;
const PROFILE_MISMATCH_NOTIFY_WINDOW_MS: f64 = 24.0 * 60.0 * 60_000.0;

/// `pruneNotifications`: read rows past the retention cap go, oldest first.
/// Its own failures are swallowed, as in Node.
pub(crate) fn prune_notifications(w: &mut Writer) {
    let count: Result<i64, _> =
        w.conn
            .query_row("SELECT COUNT(*) AS n FROM notifications", [], |r| r.get(0));
    if let Ok(count) = count {
        if count > NOTIFICATION_RETENTION {
            let _ = w.run(
                PRUNE_NOTIFICATIONS,
                vec![json!(count - NOTIFICATION_RETENTION)],
            );
        }
    }
}

/// `Number(getSetting(key, "0")) || 0`.
fn last_fired(w: &Writer, key: &str) -> Result<f64, String> {
    let raw = get_setting_with(w.conn, key, "0").map_err(message)?;
    let n = js_to_number(&Value::String(raw));
    Ok(if n.is_nan() || n == 0.0 { 0.0 } else { n })
}

/// `createParserFallthroughNotification({ appName, appsAffected: 1 })`.
pub(super) fn parser_fallthrough(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    app_name: &str,
) -> Result<bool, String> {
    let last_raw =
        get_setting_with(w.conn, PARSER_FALLTHROUGH_LAST_NOTIFIED_KEY, "0").map_err(message)?;
    if let Some(last) = js_parse_int(&last_raw) {
        if last > 0 && now - last < PARSER_FALLTHROUGH_COOLDOWN_MS {
            return Ok(false);
        }
    }
    let example_part = if app_name.is_empty() {
        String::new()
    } else {
        format!("most recently {app_name}")
    };
    let scope_part = format!(
        "at least one app{}",
        if example_part.is_empty() {
            String::new()
        } else {
            format!(" ({example_part})")
        }
    );
    let description = format!(
        "Privacy labels couldn't be parsed for {scope_part}. Apple may have changed the App Store HTML format. The history pages will keep working, but no fresh privacy-label data will land until the parser catches up. If this persists, please open a GitHub issue."
    );
    let summary = json!([{
        "type": "parser_fallthrough",
        "description": description,
        "appsAffected": 1,
        "exampleAppName": app_name,
    }]);
    let id = ids.uuid(w.conn)?;
    w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!(PARSER_FALLTHROUGH_APP_ID),
            json!("Privacy-label parser"),
            json!(summary.to_string()),
            json!(now),
        ],
    )?;
    prune_notifications(w);
    w.set_setting(PARSER_FALLTHROUGH_LAST_NOTIFIED_KEY, &now.to_string())?;
    Ok(true)
}

/// `createVersionUpdateNotification`.
#[allow(clippy::too_many_arguments)]
pub(super) fn version_update(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    app_id: &str,
    app_name: &str,
    previous_version: &str,
    current_version: &str,
    previous_version_updated_at: &Value,
    current_version_updated_at: Option<i64>,
) -> Result<bool, String> {
    if app_id.is_empty() || previous_version.is_empty() || current_version.is_empty() {
        return Ok(false);
    }
    if previous_version == current_version {
        return Ok(false);
    }
    let dedupe_key = format!("version_update_notified_{app_id}_at");
    if (now as f64) - last_fired(w, &dedupe_key)? < VERSION_UPDATE_NOTIFY_WINDOW_MS {
        return Ok(false);
    }
    let released_suffix = match current_version_updated_at {
        Some(ms) if ms != 0 => format!(" (released {})", en_au_short_date(ms).unwrap_or_default()),
        _ => String::new(),
    };
    let description = format!(
        "{app_name} updated from v{previous_version} to v{current_version}{released_suffix}."
    );
    let summary = json!([{
        "type": "version_update",
        "description": description,
        "previousVersion": previous_version,
        "currentVersion": current_version,
        "previousVersionUpdatedAt": previous_version_updated_at,
        "currentVersionUpdatedAt": current_version_updated_at,
    }]);
    let id = ids.uuid(w.conn)?;
    w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!(app_id),
            json!(app_name),
            json!(summary.to_string()),
            json!(now),
        ],
    )?;
    prune_notifications(w);
    w.set_setting(&dedupe_key, &now.to_string())?;
    Ok(true)
}

/// `createProfileMismatchNotification`.
pub(super) fn profile_mismatch(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    app_id: &str,
    app_name: &str,
    new_mismatches: &[&Mismatch],
    is_new: bool,
) -> Result<bool, String> {
    if app_id.is_empty() || new_mismatches.is_empty() {
        return Ok(false);
    }
    let dedupe_key = format!("profile_mismatch_notified_{app_id}_at");
    if (now as f64) - last_fired(w, &dedupe_key)? < PROFILE_MISMATCH_NOTIFY_WINDOW_MS {
        return Ok(false);
    }
    let top = new_mismatches[0];
    let total = new_mismatches.len();
    let word = if total == 1 { "mismatch" } else { "mismatches" };
    let description = if is_new {
        format!("App imported · {total} {word} for {app_name}")
    } else {
        format!("{total} new {word} for {app_name}")
    };
    let summary = json!([{
        "type": "profile_mismatch",
        "description": description,
        "newCategoryCount": total,
        "topCategory": top.category,
        "topObserved": top.observed,
        "topAllowed": top.allowed,
    }]);
    let id = ids.uuid(w.conn)?;
    w.run(
        INSERT_NOTIFICATION,
        vec![
            json!(id),
            json!(app_id),
            json!(app_name),
            json!(summary.to_string()),
            json!(now),
        ],
    )?;
    prune_notifications(w);
    w.set_setting(&dedupe_key, &now.to_string())?;
    Ok(true)
}

/// `parseHHMM`.
fn parse_hhmm(value: &str) -> Option<(u32, u32)> {
    let re = js_regex(r"^([0-9]{2}):([0-9]{2})$");
    let c = re.captures(value)?;
    let hour: u32 = c[1].parse().ok()?;
    let minute: u32 = c[2].parse().ok()?;
    (hour <= 23 && minute <= 59).then_some((hour, minute))
}

/// `computeNotBefore(new Date(now))`: `None` unless quiet hours are on and
/// `now` falls inside the window, else the window's end (next day when it
/// wraps midnight), in the process timezone.
pub(crate) fn compute_not_before(conn: &rusqlite::Connection, now: i64) -> Option<i64> {
    let quiet_hours_on = flags::context_from_db(conn)
        .ok()
        .and_then(|ctx| flags::resolve_flag("flag.notifications.quiet_hours", &ctx).ok())
        .is_some_and(|value| value == "on");
    if !quiet_hours_on {
        return None;
    }
    let start = parse_hhmm(&get_setting_with(conn, "notification_quiet_hours_start", "").ok()?)?;
    let end = parse_hhmm(&get_setting_with(conn, "notification_quiet_hours_end", "").ok()?)?;
    let local = local_time(now)?;
    let minutes_now = local.hour * 60 + local.minute;
    let minutes_start = start.0 * 60 + start.1;
    let minutes_end = end.0 * 60 + end.1;
    if minutes_start == minutes_end {
        return None;
    }
    let inside = if minutes_start < minutes_end {
        minutes_now >= minutes_start && minutes_now < minutes_end
    } else {
        minutes_now >= minutes_start || minutes_now < minutes_end
    };
    if !inside {
        return None;
    }
    let days_ahead = i64::from(minutes_start > minutes_end && minutes_now >= minutes_start);
    at_local_time(now, end.0, end.1, days_ahead)
}

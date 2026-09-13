//! Port of `lib/scheduler.ts`'s `getSetting` — the key/value read every
//! settings-backed route goes through.
//!
//! Returns a `Result` rather than swallowing errors, because the Node routes
//! do NOT agree on what a failure means: `/api/date-format` wraps the read in
//! a try/catch and answers 200 with the default, while others let it
//! propagate. Each handler decides, exactly as its Node counterpart does.

use rusqlite::OptionalExtension;

use super::AppState;

pub fn get_setting(state: &AppState, key: &str, default: &str) -> rusqlite::Result<String> {
    let conn = state.conn.lock().expect("db mutex poisoned");
    get_setting_with(&conn, key, default)
}

/// Port of `setSetting` — `INSERT OR REPLACE`, so the row is rewritten
/// rather than updated in place. Lock-held variant only: the single caller
/// so far (`/api/settings/desktop` marking the runtime) already holds it.
pub fn set_setting_with(
    conn: &rusqlite::Connection,
    key: &str,
    value: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
        [key, value],
    )?;
    Ok(())
}

/// The same read for a handler that already holds the connection lock —
/// calling `get_setting` there would deadlock on the mutex.
pub fn get_setting_with(
    conn: &rusqlite::Connection,
    key: &str,
    default: &str,
) -> rusqlite::Result<String> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.unwrap_or_else(|| default.to_string()))
}

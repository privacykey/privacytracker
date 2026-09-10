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
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.unwrap_or_else(|| default.to_string()))
}

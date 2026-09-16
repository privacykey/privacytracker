//! `fetchAndParseApp`'s catch block: the diagnostics it derives from the
//! error message, and `recordActivity` from lib/activity.ts, which writes
//! the error row and prunes past the retention cap. Best effort: Node
//! swallows a failure here, so this never returns one.
use super::{
    js::js_regex,
    persist::{Ids, Writer},
};
use crate::jsstr::js_slice_prefix;
use serde_json::{json, Value};

const INSERT_ACTIVITY: &str = "INSERT INTO activity_log\n         (id, type, status, app_id, app_name, summary, detail,\n          started_at, ended_at, duration_ms)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const PRUNE_ACTIVITY: &str = "DELETE FROM activity_log\n          WHERE id IN (\n            SELECT id FROM activity_log\n            ORDER BY started_at ASC\n            LIMIT ?\n          )";
const ACTIVITY_RETENTION: i64 = 2000;

/// The `fetchDiagnostics` object the catch block builds from the message.
fn diagnostics(url: &str, message: &str) -> Value {
    let mut out = json!({ "requestedUrl": url });
    let http = js_regex(r"(?i)HTTP\s+([0-9]{3})");
    if let Some(c) = http.captures(message) {
        let status: i64 = c[1].parse().expect("three digits");
        out["httpStatus"] = json!(status);
        let hints: Vec<&str> = if status == 403 {
            vec![
                "Apple's App Store HTML endpoint refused the request.",
                "This is often a transient rate-limit — retry in a few minutes before assuming the scraper is broken.",
            ]
        } else if status == 404 {
            vec!["The App Store URL returned Not Found. The app may have been removed from the store."]
        } else if status == 429 {
            vec!["Apple is rate-limiting us. Stagger re-syncs with a longer delay, or wait a few minutes and retry."]
        } else if status >= 500 {
            vec!["App Store is returning an upstream error. Usually transient."]
        } else {
            vec![]
        };
        if !hints.is_empty() {
            out["troubleshoot"] = json!(hints);
        }
    } else if js_regex(r"(?i)timeout|aborted|ETIMEDOUT").is_match(message) {
        out["networkHint"] = json!("timeout");
        out["troubleshoot"] = json!([
            "Request timed out. Retry later; the App Store HTML endpoint occasionally hangs."
        ]);
    } else if js_regex(r"(?i)ENOTFOUND|EAI_AGAIN|network|fetch failed").is_match(message) {
        out["networkHint"] = json!("network");
        out["troubleshoot"] = json!([
            "Network error reaching apps.apple.com. Check the container has outbound internet access."
        ]);
    }
    out
}

/// The error activity row, then the retention prune.
pub(super) fn record_error(
    w: &mut Writer,
    ids: &mut dyn Ids,
    url: &str,
    now: i64,
    activity_type: &str,
    error: &str,
) {
    let Ok(id) = ids.uuid(w.conn) else {
        return;
    };
    let detail = json!({
        "url": url,
        "errorMessage": error,
        "fetchDiagnostics": diagnostics(url, error),
    });
    if w.run(
        INSERT_ACTIVITY,
        vec![
            json!(id),
            json!(activity_type),
            json!("error"),
            Value::Null,
            Value::Null,
            json!(js_slice_prefix(error, 200)),
            json!(detail.to_string()),
            json!(now),
            json!(now),
            json!(0),
        ],
    )
    .is_err()
    {
        return;
    }
    let count: Result<i64, _> =
        w.conn
            .query_row("SELECT COUNT(*) AS n FROM activity_log", [], |r| r.get(0));
    if let Ok(count) = count {
        if count > ACTIVITY_RETENTION {
            let _ = w.run(PRUNE_ACTIVITY, vec![json!(count - ACTIVITY_RETENTION)]);
        }
    }
}

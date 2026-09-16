//! `recordActivity` from lib/activity.ts: one row, then the retention cap
//! enforced with a count and a bounded delete. Failures are logged, never
//! raised — the operation the row describes has already happened.
use crate::{scrape::persist::Writer, scrape::Ids};
use serde_json::{json, Value};

const INSERT: &str = "INSERT INTO activity_log\n         (id, type, status, app_id, app_name, summary, detail,\n          started_at, ended_at, duration_ms)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const PRUNE: &str = "DELETE FROM activity_log\n          WHERE id IN (\n            SELECT id FROM activity_log\n            ORDER BY started_at ASC\n            LIMIT ?\n          )";
const RETENTION: i64 = 2000;

#[allow(clippy::too_many_arguments)]
pub fn record_activity(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    kind: &str,
    status: &str,
    app_id: Option<&str>,
    summary: Option<&str>,
    detail: Option<&Value>,
    started_at: i64,
) {
    // The id is minted before the try, so a failed insert still consumes it.
    let id = match ids.uuid(w.conn) {
        Ok(id) => id,
        Err(e) => {
            super::diag::log_warn(format!("[activity] recordActivity failed: {e}"));
            return;
        }
    };
    let ended_at = now;
    let duration_ms = (ended_at - started_at).max(0);
    let outcome = (|| -> Result<(), String> {
        w.run(
            INSERT,
            vec![
                json!(id),
                json!(kind),
                json!(status),
                app_id.map_or(Value::Null, |a| json!(a)),
                Value::Null,
                summary.map_or(Value::Null, |s| json!(s)),
                detail.map_or(Value::Null, |d| json!(d.to_string())),
                json!(started_at),
                json!(ended_at),
                json!(duration_ms),
            ],
        )?;
        let count: i64 = w
            .conn
            .query_row("SELECT COUNT(*) AS n FROM activity_log", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if count > RETENTION {
            w.run(PRUNE, vec![json!(count - RETENTION)])?;
        }
        Ok(())
    })();
    if let Err(e) = outcome {
        super::diag::log_warn(format!("[activity] recordActivity failed: {e}"));
    }
}

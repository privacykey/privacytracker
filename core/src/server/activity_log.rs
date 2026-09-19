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
    record_activity_named(
        w, ids, now, kind, status, app_id, None, summary, detail, started_at,
    );
}

/// `recordActivity` with an `appName`, which the wayback rows carry.
#[allow(clippy::too_many_arguments)]
pub fn record_activity_named(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    kind: &str,
    status: &str,
    app_id: Option<&str>,
    app_name: Option<&str>,
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
                app_name.map_or(Value::Null, |a| json!(a)),
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

/// `recordActivity` for a row whose `appId` and `detail` a client supplied
/// (the uninstall log). The id is bound as better-sqlite3 binds it: text,
/// a number as a double, NULL for null — and a boolean or an object is
/// refused at bind time, after the INSERT was entered, so the attempt is
/// in the stream, no row is written, and the failure is swallowed as
/// Node's try/catch swallows it. The detail takes `JSON.stringify`'s
/// number spelling, which a client's numbers can reach (`1e+300`).
#[allow(clippy::too_many_arguments)]
pub fn record_activity_client(
    w: &mut Writer,
    ids: &mut dyn Ids,
    now: i64,
    kind: &str,
    status: &str,
    app_id: Option<&Value>,
    summary: &str,
    detail: &Value,
    started_at: i64,
) {
    let id = match ids.uuid(w.conn) {
        Ok(id) => id,
        Err(e) => {
            super::diag::log_warn(format!("[activity] recordActivity failed: {e}"));
            return;
        }
    };
    let ended_at = now;
    let duration_ms = (ended_at - started_at).max(0);
    let detail = super::json::js_json_vec(detail)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map_or(Value::Null, Value::String);
    let (app, refused) = match super::audit_bundle::bind(app_id) {
        Ok(bound) => (bound, None),
        Err(why) => (app_id.cloned().unwrap_or(Value::Null), Some(why)),
    };
    let params = vec![
        json!(id),
        json!(kind),
        json!(status),
        app,
        Value::Null,
        json!(summary),
        detail,
        json!(started_at),
        json!(ended_at),
        json!(duration_ms),
    ];
    if let Some(why) = refused {
        w.refuse(INSERT, params);
        super::diag::log_warn(format!("[activity] recordActivity failed: {why}"));
        return;
    }
    let outcome = (|| -> Result<(), String> {
        w.run(INSERT, params)?;
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

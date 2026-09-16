//! Stored operational state. Reading it never resumes, heals or starts a job.
use super::{
    settings::get_setting_with,
    stats::{query, text, truthy, Result},
    user_content::{integer, parse},
};
use crate::jsnum::js_number;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

#[derive(Clone, Copy)]
pub(super) enum Job {
    Wayback,
    Sync,
    Policy,
}

struct Run {
    running: bool,
    mutex_held: bool,
    stale: bool,
    status: String,
    state: Option<Value>,
    summary: Value,
    current_app_name: Value,
}

fn describe(conn: &Connection, job: Job) -> Result<Run> {
    let (key, mutex) = match job {
        Job::Wayback => ("wayback_bulk_state", "wayback_import_running"),
        Job::Sync => ("sync_bulk_state", "sync_running"),
        Job::Policy => ("policy_bulk_state", "policy_sync_running"),
    };
    let wayback = matches!(job, Job::Wayback);
    let mut state = parse(&get_setting_with(conn, key, "")?).ok().filter(|v| {
        v.is_object()
            && (v["version"] == 1 || (wayback && v["version"] == 2))
            && v["runId"].is_string()
            && v["queue"].is_array()
    });
    if wayback {
        if let Some(v) = state.as_mut() {
            let status = match text(&v["status"]) {
                s @ ("running" | "paused" | "pause_requested" | "cancel_requested") => s,
                _ => "running",
            }
            .to_owned();
            v["version"] = json!(2);
            v["status"] = json!(status);
        }
    }
    let mutex_held = get_setting_with(conn, mutex, "")? == "true";
    let mut summary = Value::Null;
    let mut current_app_name = Value::Null;
    let mut remaining = 0;
    if let Some(v) = &state {
        let queue = v["queue"].as_array().expect("validated queue");
        let (mut pending, mut in_progress, mut done, mut failed) = (0, 0, 0, 0);
        for entry in queue {
            // The Node reader only validates the outer blob. A null queue
            // entry throws in summariseState; primitive entries are ignored.
            if entry.is_null() {
                return Err("null bulk queue entry".into());
            }
            match text(&entry["status"]) {
                "pending" => pending += 1,
                "in_progress" => in_progress += 1,
                "done" => done += 1,
                "failed" => failed += 1,
                _ => (),
            }
        }
        remaining = pending + in_progress;
        summary = json!({"total":queue.len(),"pending":pending,"inProgress":in_progress,"done":done,"failed":failed,"remaining":remaining});
        if truthy(&v["currentAppId"]) {
            // JS === compares object/array identities, not their contents.
            if !v["currentAppId"].is_object() && !v["currentAppId"].is_array() {
                current_app_name = queue
                    .iter()
                    .find(|e| e.get("appId") == v.get("currentAppId"))
                    .map(|e| e["appName"].clone())
                    .unwrap_or(Value::Null);
            }
        }
    }
    let stale = mutex_held && remaining == 0;
    let status = if stale {
        "stale"
    } else {
        state
            .as_ref()
            .and_then(|v| v["status"].as_str())
            .unwrap_or(if mutex_held { "running" } else { "idle" })
    }
    .to_owned();
    let running = if wayback {
        mutex_held && !stale && status != "paused"
    } else {
        state.is_some() || mutex_held
    };
    Ok(Run {
        running,
        mutex_held,
        stale,
        status,
        state,
        summary,
        current_app_name,
    })
}

/// Property reads without `?? null` omit missing fields, preserving literal order.
fn copy_fields(out: &mut Map<String, Value>, state: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(value) = state.get(*key) {
            out.insert((*key).into(), value.clone());
        }
    }
}

pub(super) fn job_status(conn: &Connection, job: Job) -> Result<Value> {
    let info = describe(conn, job)?;
    let wayback = matches!(job, Job::Wayback);
    let mut out = Map::new();
    out.insert("running".into(), json!(info.running));
    out.insert("mutexHeld".into(), json!(info.mutex_held));
    if wayback {
        out.insert("status".into(), json!(info.status));
    }
    out.insert("stale".into(), json!(info.stale));
    out.insert("currentAppName".into(), info.current_app_name);
    out.insert("summary".into(), info.summary);
    let projected = info
        .state
        .map(|s| {
            let mut m = Map::new();
            copy_fields(
                &mut m,
                &s,
                &["runId", "startedAt", "updatedAt", "initiator"],
            );
            if wayback {
                copy_fields(&mut m, &s, &["status"]);
                for k in [
                    "pausedAt",
                    "pauseCause",
                    "pauseRequestedAt",
                    "cancelRequestedAt",
                ] {
                    m.insert(k.into(), s[k].clone());
                }
            } else {
                copy_fields(&mut m, &s, &["phase", "force"]);
            }
            copy_fields(&mut m, &s, &["currentAppId", "totals"]);
            Value::Object(m)
        })
        .unwrap_or(Value::Null);
    out.insert("state".into(), projected);
    Ok(Value::Object(out))
}

fn active_job(conn: &Connection, job: Job) -> Result<Value> {
    let r = describe(conn, job)?;
    let mut out = Map::new();
    out.insert("running".into(), json!(r.running));
    out.insert("mutexHeld".into(), json!(r.mutex_held));
    out.insert("stale".into(), json!(r.stale));
    if matches!(job, Job::Wayback) {
        out.insert("status".into(), json!(r.status));
    }
    let s = r.state.unwrap_or(Value::Null);
    out.insert("initiator".into(), s["initiator"].clone());
    out.insert("currentAppName".into(), r.current_app_name);
    out.insert("summary".into(), r.summary);
    for key in ["totals", "runId", "startedAt", "updatedAt"] {
        out.insert(key.into(), s[key].clone());
    }
    Ok(Value::Object(out))
}

pub(super) fn active_tasks(conn: &Connection) -> Result<Value> {
    let wayback = active_job(conn, Job::Wayback)?;
    let sync = active_job(conn, Job::Sync)?;
    let policy = active_job(conn, Job::Policy)?;
    let rows = query(conn, "SELECT p.app_id, p.run_started_at, p.updated_at, p.last_run_log, a.name AS app_name FROM privacy_policy_analyses p LEFT JOIN apps a ON a.id=p.app_id WHERE p.run_status='running' ORDER BY COALESCE(p.run_started_at,p.updated_at) ASC LIMIT 10", &[])?;
    let runs = rows.into_iter().map(|r| {
        let log = parse(text(&r["last_run_log"])).unwrap_or(Value::Null);
        let tail = log.as_array().and_then(|a| a.last()).unwrap_or(&Value::Null);
        json!({"appId":r["app_id"],"appName":r["app_name"],"runStartedAt":r["run_started_at"],"updatedAt":r["updated_at"],"lastPhase":tail["phase"].as_str(),"lastPhaseNote":tail["note"].as_str()})
    }).collect::<Vec<_>>();
    Ok(json!({"wayback":wayback,"sync":sync,"policy":policy,"policyRuns":runs}))
}

pub(super) fn cooldowns(conn: &Connection, now: i64) -> Result<Value> {
    let read = |category| -> Result<Value> {
        let until = integer(&get_setting_with(
            conn,
            &format!("rate_limit_{category}_until"),
            "0",
        )?)
        .unwrap_or(0.0);
        let active = until > now as f64;
        let reason = if active {
            get_setting_with(conn, &format!("rate_limit_{category}_reason"), "")?
        } else {
            String::new()
        };
        Ok(
            json!({"category":category,"active":active,"resumeAt":js_number(if active { until } else { 0.0 }),"reason":reason}),
        )
    };
    Ok(json!({"search":read("search")?,"scrape":read("scrape")?,"serverNow":now}))
}

pub(super) fn ai_debug_log(conn: &Connection) -> Result<Value> {
    let rows = query(conn, "SELECT id, created_at AS createdAt, app_id AS appId, app_name AS appName, provider, model, phase, prompt, response, duration_ms AS durationMs, error FROM ai_debug_log ORDER BY created_at DESC LIMIT 50", &[])?;
    let rows = rows
        .into_iter()
        .map(|mut r| {
            r.as_object_mut()
                .unwrap()
                .retain(|k, v| k == "id" || k == "createdAt" || !v.is_null());
            r
        })
        .collect::<Vec<_>>();
    Ok(json!({"rows":rows}))
}

pub(super) fn manual_detail(conn: &Connection, id: &str) -> Result<Option<Value>> {
    let params = [id.to_owned().into()];
    let Some(mut app) = query(conn, "SELECT id,name,source,developer,privacy_policy_url AS privacyPolicyUrl,source_url AS sourceUrl,notes,first_seen AS firstSeen,updated_at AS updatedAt FROM manual_apps WHERE id=?", &params)?.into_iter().next() else { return Ok(None); };
    let meta = super::routes_manual::source_metadata(text(&app["source"]));
    app["source"] = meta["value"].clone();
    let events = query(conn, "SELECT id,manual_app_id AS manualAppId,event_type AS type,occurred_at AS occurredAt,detail FROM manual_app_events WHERE manual_app_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 200", &params)?
        .into_iter().map(|mut e| {
            if e["type"].is_null() { e["type"] = json!("scrape"); }
            e["detail"] = parse(text(&e["detail"])).unwrap_or(Value::Null); e
        }).collect::<Vec<_>>();
    let current = query(conn, "SELECT id,manual_app_id AS manualAppId,content_hash AS contentHash,first_fetched_at AS firstFetchedAt,last_fetched_at AS lastFetchedAt,policy_url AS policyUrl,source_final_url AS sourceFinalUrl,source_title AS sourceTitle,source_content_type AS sourceContentType,source_origin AS sourceOrigin,source_word_count AS sourceWordCount,source_text AS sourceText FROM manual_app_policy_versions WHERE manual_app_id=? ORDER BY last_fetched_at DESC LIMIT 1", &params)?.into_iter().next().unwrap_or(Value::Null);
    Ok(Some(
        json!({"app":app,"events":events,"currentVersion":current,"meta":meta}),
    ))
}

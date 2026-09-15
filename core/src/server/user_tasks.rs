//! Server checklist resolution; completion comes from existing stored facts.
use super::{
    flags, grid_meta,
    settings::get_setting_with,
    stats::{query, text, truthy, Result},
    user_content::{integer, metadata, parse},
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;

pub(super) fn read(conn: &Connection, now: i64) -> Result<Value> {
    let setting = |key: &str| get_setting_with(conn, key, "");
    let positive =
        |key: &str| -> Result<bool> { Ok(integer(&setting(key)?).is_some_and(|n| n > 0.0)) };
    let mut audience = setting("flag.focus.audience")?;
    if audience.is_empty() {
        audience = "self".into();
    }
    let minimal = setting("flag.focus.goal.minimal")? == "true";
    let monitor = !minimal && setting("flag.focus.goal.monitor")? == "true";
    let cleanup = !minimal && setting("flag.focus.goal.cleanup")? == "true";
    // Only the explicit handoff workflow includes the export opt-in task.
    let handoff = setting("flag.focus.workflow")? == "other_handoff";
    let profile = grid_meta::get_privacy_profile(conn)
        .ok()
        .flatten()
        .is_some_and(|p| !p.is_empty());
    let verdict = query(conn, "SELECT COUNT(*) AS total, SUM(CASE WHEN verdict = 'uninstall' THEN 1 ELSE 0 END) AS uninstall FROM app_verdicts WHERE source = 'user'", &[]).ok().and_then(|r|r.into_iter().next()).unwrap_or(Value::Null);
    let schedule = setting("sync_schedule")?;
    let history = query(
        conn,
        "SELECT 1 FROM privacy_snapshots WHERE source = 'wayback' LIMIT 1",
        &[],
    )
    .is_ok_and(|r| !r.is_empty());
    let preview = flags::context_from_db(conn)
        .ok()
        .and_then(|ctx| flags::resolve_flag("flag.devopts.tasks_preview_default", &ctx).ok())
        .is_some_and(|v| v == "on");
    let completion: HashMap<&str, bool> = [
        ("view_privacy_map", positive("task_visit.privacy_map_at")?),
        ("open_any_app_detail", positive("task_visit.app_detail_at")?),
        ("create_privacy_profile", profile),
        (
            "review_mismatches",
            verdict["total"].as_f64().unwrap_or(0.0) >= 1.0,
        ),
        ("compare_two_apps", positive("task_visit.compare_at")?),
        ("import_label_history", history),
        (
            "setup_background_mode",
            positive("background_wizard_completed_at")?
                || (!schedule.is_empty() && schedule != "manual"),
        ),
        (
            "remove_apps_from_phone",
            verdict["uninstall"].as_f64().unwrap_or(0.0) >= 1.0,
        ),
        (
            "resync_apps_from_device",
            positive("device_resync.last_committed_at")?,
        ),
        (
            "export_audit_bundle",
            positive("audit_bundle_last_exported_at")?,
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k, v && !preview))
    .collect();
    let blob = if preview {
        Value::Null
    } else {
        parse(&setting("user_tasks_state")?).unwrap_or(Value::Null)
    };
    let mut tasks = Vec::new();
    let mut candidates = Vec::new();
    for def in metadata()["tasks"].as_array().unwrap() {
        let id = text(&def["id"]);
        let included = match id {
            "review_mismatches" => cleanup || minimal,
            "compare_two_apps" => monitor || cleanup,
            "import_label_history" => audience == "self" && monitor,
            "export_audit_bundle" => handoff,
            _ => true,
        };
        if !included {
            continue;
        }
        let saved = if blob["version"] == 1 {
            &blob["tasks"][id]
        } else {
            &Value::Null
        };
        let stamp = |k: &str| {
            saved[k]
                .as_f64()
                .filter(|n| n.is_finite())
                .map(crate::jsnum::js_number)
                .unwrap_or(Value::Null)
        };
        let started = stamp("started_at");
        let dismissed = stamp("dismissed_at");
        let opted = stamp("opted_in_at");
        let completed = completion.get(id).copied().unwrap_or(false);
        if def["optInOnly"] == true && !truthy(&opted) {
            if !completed {
                candidates.push(json!({"id":def["id"],"i18nKey":def["i18nKey"]}));
            }
            continue;
        }
        let blocked = def["prerequisites"]
            .as_array()
            .unwrap()
            .iter()
            .any(|k| completion.get(text(k)) == Some(&false));
        let state = if completed {
            "completed"
        } else if truthy(&dismissed) {
            "dismissed"
        } else if blocked {
            "blocked"
        } else if truthy(&started) && (now as f64 - started.as_f64().unwrap()) < 14.0 * 86_400_000.0
        {
            "in_progress"
        } else {
            "ready"
        };
        tasks.push(json!({"id":def["id"],"route":def["route"],"prerequisites":def["prerequisites"],"i18nKey":def["i18nKey"],"state":state,"startedAt":started,"dismissedAt":dismissed,"optedInAt":opted,"audience":audience}));
    }
    Ok(json!({"tasks":tasks,"candidates":candidates}))
}

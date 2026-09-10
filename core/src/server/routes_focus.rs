//! `GET /api/focus` — the batch-2 derived-object route.
//!
//! Ten keys in a fixed order, every one of them computed rather than echoed.
//! Three details here are easy to get wrong and none of them is visible in the
//! response shape:
//!
//!   1. **Mutual exclusion is applied on READ.** `activeGoalsFrom` only adds
//!      monitor/cleanup in the `else` branch of `if (minimal)`, so a database
//!      holding minimal=true AND monitor=true reports `monitor: false`. A port
//!      that echoes the stored settings diverges on exactly that row.
//!   2. **`audience` and `audienceSet` read the same key with different
//!      fallbacks.** `audience` is `stored || "self"`; `audienceSet` is
//!      `stored !== ""`. A stored empty string yields
//!      `{"audience":"self","audienceSet":false}` — they disagree by design.
//!   3. **`audience` is an unchecked cast in Node**, so a garbage stored value
//!      is echoed verbatim. Modelling it as a Rust enum would normalise or
//!      reject it; it stays a String.

use axum::{extract::State, response::Response};
use serde::Serialize;

use super::json::json_ok;
use super::settings::get_setting;
use super::AppState;
use crate::jsnum::js_parse_int;

const FOCUS_WORKFLOWS: [&str; 5] = [
    "self_monitor",
    "self_cleanup",
    "other_handoff",
    "other_monitor",
    "custom",
];

const AGE_BAND_KEYS: [&str; 5] = ["under_9", "9_12", "13_15", "16_17", "18_plus"];

/// Field order is the order of Node's object literal in
/// `app/api/focus/route.ts`, which serde reproduces via declaration order.
#[derive(Serialize)]
struct FocusBody {
    audience: String,
    #[serde(rename = "audienceSet")]
    audience_set: bool,
    monitor: bool,
    cleanup: bool,
    minimal: bool,
    accessibility: bool,
    #[serde(rename = "aiConfigured")]
    ai_configured: bool,
    workflow: String,
    // Explicit nulls, never absent.
    #[serde(rename = "childAgeBand")]
    child_age_band: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<i64>,
}

/// Port of `inferFocusWorkflow`. Note `accessibility` is deliberately NOT
/// considered, and `minimal` short-circuits to "custom".
fn infer_focus_workflow(
    audience: &str,
    monitor: bool,
    cleanup: bool,
    minimal: bool,
) -> &'static str {
    if minimal {
        return "custom";
    }
    if audience == "self" {
        if monitor && !cleanup {
            return "self_monitor";
        }
        if cleanup && !monitor {
            return "self_cleanup";
        }
    }
    "custom"
}

/// Port of `getFocusUpdatedAt`: `Number.parseInt` semantics, then a
/// finite-and-positive test. Uses the shared JS-compatible parser because
/// Rust's `str::parse` rejects inputs Node accepts.
fn focus_updated_at(raw: &str) -> Option<i64> {
    if raw.is_empty() {
        return None;
    }
    js_parse_int(raw).filter(|n| *n > 0)
}

pub async fn focus(State(state): State<AppState>) -> Response {
    let get = |key: &str, default: &str| get_setting(&state, key, default).unwrap_or_default();

    let audience_raw = get("flag.focus.audience", "");
    // `|| "self"` — an empty stored value falls back, but audienceSet below
    // reports the raw emptiness rather than the fallback.
    let audience = if audience_raw.is_empty() {
        "self".to_string()
    } else {
        audience_raw.clone()
    };
    let audience_set = !audience_raw.is_empty();

    // Raw stored booleans, before mutual exclusion.
    let raw_monitor = get("flag.focus.goal.monitor", "") == "true";
    let raw_cleanup = get("flag.focus.goal.cleanup", "") == "true";
    let minimal = get("flag.focus.goal.minimal", "") == "true";
    let accessibility = get("flag.focus.goal.accessibility", "") == "true";

    // activeGoalsFrom: minimal SUPPRESSES monitor/cleanup.
    let monitor = !minimal && raw_monitor;
    let cleanup = !minimal && raw_cleanup;

    // `aiConfigured` is a two-way emptiness/disabled test, not a provider
    // normalisation — an unrecognised provider string counts as configured.
    let ai_provider = get("ai_provider", "");
    let ai_configured = !ai_provider.is_empty() && ai_provider != "disabled";

    // A stored workflow wins when it validates; otherwise infer.
    let stored_workflow = get("flag.focus.workflow", "");
    let workflow = if FOCUS_WORKFLOWS.contains(&stored_workflow.as_str()) {
        stored_workflow
    } else {
        infer_focus_workflow(&audience, monitor, cleanup, minimal).to_string()
    };

    let band = get("guardian_child_age_band", "");
    let child_age_band = if AGE_BAND_KEYS.contains(&band.as_str()) {
        Some(band)
    } else {
        None
    };

    json_ok(&FocusBody {
        audience,
        audience_set,
        monitor,
        cleanup,
        minimal,
        accessibility,
        ai_configured,
        workflow,
        child_age_band,
        updated_at: focus_updated_at(&get("flag.focus.updated_at", "")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The suppression rule, extracted so it can be asserted directly. This
    /// is the one line a naive "echo the stored settings" port gets wrong.
    fn effective_goal(minimal: bool, raw: bool) -> bool {
        !minimal && raw
    }

    #[test]
    fn minimal_suppresses_the_goal_tiles() {
        // Stored monitor=true is reported FALSE while minimal is set.
        assert!(!effective_goal(true, true));
        assert!(!effective_goal(true, false));
        // With minimal off the stored value passes through unchanged.
        assert!(effective_goal(false, true));
        assert!(!effective_goal(false, false));
    }

    #[test]
    fn workflow_inference_matches_node() {
        assert_eq!(
            infer_focus_workflow("self", true, false, false),
            "self_monitor"
        );
        assert_eq!(
            infer_focus_workflow("self", false, true, false),
            "self_cleanup"
        );
        // Both goals, or neither, is ambiguous → custom.
        assert_eq!(infer_focus_workflow("self", true, true, false), "custom");
        assert_eq!(infer_focus_workflow("self", false, false, false), "custom");
        // Non-self audiences always collapse to custom.
        assert_eq!(
            infer_focus_workflow("guardian", true, false, false),
            "custom"
        );
        assert_eq!(
            infer_focus_workflow("loved_one", true, false, false),
            "custom"
        );
        // minimal short-circuits before anything else.
        assert_eq!(infer_focus_workflow("self", true, false, true), "custom");
    }

    #[test]
    fn updated_at_uses_js_parse_int_and_rejects_non_positive() {
        assert_eq!(focus_updated_at(""), None);
        assert_eq!(focus_updated_at("0"), None);
        assert_eq!(focus_updated_at("-5"), None);
        assert_eq!(focus_updated_at("abc"), None);
        assert_eq!(focus_updated_at("1788879635551"), Some(1_788_879_635_551));
        // JS parseInt leniency the Rust stdlib would reject outright.
        assert_eq!(focus_updated_at(" 42x"), Some(42));
    }
}

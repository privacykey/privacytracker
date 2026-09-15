//! HTTP wrappers for the nine database-backed analysis reads. Repeated
//! query keys keep their FIRST value, as URLSearchParams.get does.
use super::{
    analysis, grid_meta,
    json::{json_error, json_ok},
    review,
    routes_manual::rate_gate,
    scope::Scope,
    stats, AppState,
};
use crate::jsstr::is_js_whitespace;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde_json::{json, Value};
pub(super) type Params = Vec<(String, String)>;
pub(super) fn get<'a>(q: &'a Params, key: &str) -> Option<&'a str> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}
/// Prefix-tolerant parseInt as an f64: a finite value past i64::MAX is
/// still valid input to these routes (unlike bounded pagination routes).
pub(super) fn nonnegative_int(raw: Option<&str>) -> Option<f64> {
    let s = raw?.trim_start_matches(is_js_whitespace);
    let start = usize::from(s.starts_with('+') || s.starts_with('-'));
    let len = s
        .as_bytes()
        .iter()
        .skip(start)
        .take_while(|b| b.is_ascii_digit())
        .count();
    if len == 0 {
        return None;
    }
    s[..start + len]
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n >= 0.0)
}
fn respond(result: stats::Result<Value>, label: &str, fallback: Option<Value>) -> Response {
    match result {
        Ok(v) => json_ok(&v),
        Err(e) => {
            if let Some(v) = fallback {
                super::diag::log_warn(format!("{label} failed: {e}"));
                json_ok(&v)
            } else {
                super::diag::log_error(format!("{label} error: {e}"));
                json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
            }
        }
    }
}
macro_rules! scoped_route {
    ($name:ident,$prefix:literal,$read:expr,$fallback:expr) => {
        pub async fn $name(
            State(state): State<AppState>,
            headers: HeaderMap,
            Query(q): Query<Params>,
        ) -> Response {
            if let Some(r) = rate_gate(&state, &headers, $prefix, 120, 60_000) {
                return r;
            }
            let result = {
                let conn = state.db();
                let scope = Scope::from_request(&conn, get(&q, "devices"));
                ($read)(&conn, &scope, &q, super::now_ms())
            };
            respond(result, concat!("/api/", stringify!($name)), $fallback)
        }
    };
}
scoped_route!(
    summary,
    "stats.read",
    |c, s, _q, _now| stats::summary(c, s, _now),
    None
);
scoped_route!(
    triage,
    "triage.read",
    |c, s, _q, now| analysis::triage(c, s, now),
    Some(analysis::empty_triage())
);
scoped_route!(
    review_queue,
    "review-queue.list",
    |c, s, q, now| review::queue(c, s, get(q, "count") == Some("1"), now),
    None
);
scoped_route!(
    mismatches,
    "privacy-profile.mismatches",
    |c, s, _q, _now| Ok(json!({"apps":grid_meta::mismatched_apps(c,s)?})),
    Some(json!({"apps":[]}))
);
pub async fn age_summary(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(r) = rate_gate(&state, &headers, "age-rating.summary", 120, 60_000) {
        return r;
    }
    let result = analysis::age_summary(&state.db());
    respond(
        result,
        "[age-rating/summary]",
        Some(json!({"band":null,"count":0})),
    )
}
pub async fn matrix(State(state): State<AppState>) -> Response {
    let result = stats::matrix(&state.db());
    respond(result, "/api/stats/matrix", None)
}
pub async fn radar(State(state): State<AppState>, Query(q): Query<Params>) -> Response {
    let ids: Vec<_> = get(&q, "apps")
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim_matches(is_js_whitespace))
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if ids.len() > 20 {
        return json_error(StatusCode::BAD_REQUEST, "Too many app IDs (max 20)");
    }
    let result = stats::radar(&state.db(), &ids);
    respond(result, "/api/stats/radar", None)
}
pub async fn timeline(State(state): State<AppState>, Query(q): Query<Params>) -> Response {
    let now = super::now_ms() as f64;
    let from = nonnegative_int(get(&q, "from"))
        .filter(|n| *n > 0.0)
        .unwrap_or(now - 90.0 * stats::DAY as f64);
    let to = nonnegative_int(get(&q, "to"))
        .filter(|n| *n > 0.0)
        .unwrap_or(now);
    if from > to {
        return json_error(StatusCode::BAD_REQUEST, "from must be <= to");
    }
    let bucket = get(&q, "bucket").filter(|s| ["day", "week", "month"].contains(s));
    let id = get(&q, "appId").filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    let result = stats::timeline(&state.db(), from, to, bucket, id);
    respond(result, "/api/stats/timeline", None)
}
pub async fn changelog(State(state): State<AppState>, Query(q): Query<Params>) -> Response {
    let result = analysis::universal_changelog(&state.db(), &q);
    respond(result, "[/api/changelog]", None)
}

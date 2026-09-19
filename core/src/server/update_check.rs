//! Phase 4, batch 6: update detection (lib/update-check.ts) and `GET
//! /api/update-status`. One GET to GitHub's `releases/latest`, cached in
//! `app_settings` for a day; a 6-hour tick asks whether it is due, and the
//! Settings page's "Check now" forces it, five minutes apart at most. A
//! failed check backs off — fifteen minutes, doubling, capped at the day —
//! so an offline install is not on the network at every surface that
//! reads the status; the forced path skips the backoff and keeps only its
//! own throttle, because a person clicking is entitled to an attempt.
//!
//! GitHub is fetched with a plain `fetch` on Node — no host allowlist —
//! and through the same transport as everything else here, with the
//! allowlist empty. `api.github.com` is public and the request carries no
//! user input, so the two agree on every request the route can make.
//! Gated by `core/tests/fixtures/leftovers-cases.json`.
use super::{
    audit_bundle::app_version,
    backup::utf16_cmp,
    json::json_ok,
    routes_stats::{get, Params},
    settings::get_setting_with,
    writes::Cx,
    AppState,
};
use crate::{
    jsnum::js_parse_int,
    jsstr::{js_slice_prefix, js_trim},
    outbound::{Fetcher, PublicHttp, Request},
    scrape::persist::{DbAccess, Ids, RandomIds},
};
use axum::{
    extract::{Query, State},
    response::Response,
};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

const RELEASES_URL: &str = "https://api.github.com/repos/privacykey/privacytracker/releases/latest";
const CACHE_TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const FORCE_REFRESH_MIN_GAP_MS: i64 = 5 * 60 * 1000;
const FAIL_BACKOFF_BASE_MS: f64 = 15.0 * 60.0 * 1000.0;
const FETCH_TIMEOUT_MS: u64 = 8000;
const NOTES_PREVIEW_MAX_CHARS: usize = 4000;

const KEY_ENABLED: &str = "update_check_enabled";
const KEY_LAST_CHECKED: &str = "update_last_checked";
const KEY_LATEST_VERSION: &str = "update_latest_version";
const KEY_LATEST_NOTES: &str = "update_latest_notes";
const KEY_LATEST_URL: &str = "update_latest_url";
const KEY_LATEST_PUBDATE: &str = "update_latest_pub_date";
const KEY_LAST_ERROR: &str = "update_last_error";
const KEY_LAST_FORCED: &str = "update_last_forced_check";
const KEY_LAST_FAILED: &str = "update_last_failed";
const KEY_FAIL_COUNT: &str = "update_fail_count";

/// `failureBackoffMs`: fifteen minutes after the first failure, doubling,
/// capped at the success TTL; nothing for a count that is not positive.
pub(super) fn failure_backoff_ms(fail_count: i64) -> f64 {
    if fail_count <= 0 {
        return 0.0;
    }
    CACHE_TTL_MS.min(FAIL_BACKOFF_BASE_MS * 2f64.powi((fail_count - 1).min(i32::MAX as i64) as i32))
}

fn user_agent() -> String {
    format!(
        "privacytracker-update-check/{} (+{})",
        app_version(),
        RELEASES_URL.trim_end_matches("/releases/latest")
    )
}

// ── Version helpers (lib/semver-compare.ts) ─────────────────────────

/// `stripBuild`: everything before the first `+`.
fn strip_build(v: &str) -> &str {
    v.split('+').next().unwrap_or(v)
}

/// `"a-b-c".split("-", 2)`: at most two pieces, the rest dropped.
fn split_pre(v: &str) -> (&str, Option<&str>) {
    let mut parts = v.splitn(3, '-');
    let core = parts.next().unwrap_or("");
    (core, parts.next())
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `compareVersions`: `MAJOR.MINOR.PATCH[-pre][+build]`, permissively.
/// Numeric fields as `parseInt` reads them, a pre-release below none,
/// build metadata ignored. Returns the sign of the JavaScript result.
pub(super) fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (a_core, a_pre) = split_pre(strip_build(a));
    let (b_core, b_pre) = split_pre(strip_build(b));
    let part = |core: &str, i: usize| -> f64 {
        core.split('.')
            .nth(i)
            .map_or(0.0, |n| js_parse_int(n).unwrap_or(0) as f64)
    };
    for i in 0..3 {
        let diff = part(a_core, i) - part(b_core, i);
        if diff != 0.0 {
            return if diff > 0.0 {
                Ordering::Greater
            } else {
                Ordering::Less
            };
        }
    }
    // An empty pre-release is falsy: `1.0.0-` compares as `1.0.0`.
    let a_pre = a_pre.filter(|p| !p.is_empty());
    let b_pre = b_pre.filter(|p| !p.is_empty());
    let (a_pre, b_pre) = match (a_pre, b_pre) {
        (None, None) => return Ordering::Equal,
        (None, Some(_)) => return Ordering::Greater,
        (Some(_), None) => return Ordering::Less,
        (Some(a), Some(b)) => (a, b),
    };
    let a_ids: Vec<&str> = a_pre.split('.').collect();
    let b_ids: Vec<&str> = b_pre.split('.').collect();
    for i in 0..a_ids.len().max(b_ids.len()) {
        let (Some(x), Some(y)) = (a_ids.get(i), b_ids.get(i)) else {
            return if a_ids.get(i).is_none() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        };
        let xn = is_digits(x).then(|| js_parse_int(x).unwrap_or(0));
        let yn = is_digits(y).then(|| js_parse_int(y).unwrap_or(0));
        match (xn, yn) {
            (Some(xn), Some(yn)) => {
                if xn != yn {
                    return xn.cmp(&yn);
                }
            }
            (Some(_), None) => return Ordering::Less,
            (None, None) => {
                let cmp = utf16_cmp(x, y);
                if cmp != Ordering::Equal {
                    return cmp;
                }
            }
            (None, Some(_)) => return Ordering::Greater,
        }
    }
    Ordering::Equal
}

/// `stripVPrefix`: one leading `v` or `V`.
fn strip_v_prefix(tag: &str) -> &str {
    tag.strip_prefix(['v', 'V']).unwrap_or(tag)
}

/// `isValidSemver`: `MAJOR.MINOR.PATCH` with optional pre-release and
/// build, ASCII digits and word characters as JavaScript's `\d` and `\w`.
fn is_valid_semver(v: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9_.-]+)?(?:\+[A-Za-z0-9_.-]+)?$").unwrap()
    })
    .is_match(v)
}

// ── Runtime detection ────────────────────────────────────────────────

/// `getDeploymentRuntime`: `DEPLOYMENT` when it names one; else Docker by
/// `/.dockerenv` or the init cgroup; else Homebrew by its shell variables;
/// else plain Node. Tauri is detected client-side and never here.
pub(super) fn deployment_runtime() -> &'static str {
    let explicit = crate::host_env::var("DEPLOYMENT").unwrap_or_default();
    let explicit = js_trim(&explicit.to_lowercase()).to_string();
    for known in ["docker", "tauri", "homebrew", "node"] {
        if explicit == known {
            return known;
        }
    }
    if std::path::Path::new("/.dockerenv").exists() {
        return "docker";
    }
    if let Ok(cgroup) = std::fs::read_to_string("/proc/1/cgroup") {
        if ["docker", "containerd", "kubepods"]
            .iter()
            .any(|needle| cgroup.contains(needle))
        {
            return "docker";
        }
    }
    let set = |name: &str| crate::host_env::var(name).is_ok_and(|v| !v.is_empty());
    if set("HOMEBREW_PREFIX") || set("HOMEBREW_FORMULA_PATH") {
        return "homebrew";
    }
    "node"
}

// ── The cache ────────────────────────────────────────────────────────

fn setting(conn: &rusqlite::Connection, key: &str, default: &str) -> String {
    get_setting_with(conn, key, default).unwrap_or_else(|_| default.to_string())
}

/// `Number.parseInt(getSetting(key, "0"), 10) || 0`.
fn int_setting(conn: &rusqlite::Connection, key: &str) -> i64 {
    js_parse_int(&setting(conn, key, "0")).unwrap_or(0)
}

/// `getSetting(key, "") || null`.
fn text_or_null(conn: &rusqlite::Connection, key: &str) -> Value {
    let v = setting(conn, key, "");
    if v.is_empty() {
        Value::Null
    } else {
        json!(v)
    }
}

/// `getCachedUpdateStatus`: what every consumer reads, keys in its order.
/// `runtime` is detected on every call so a moved database sees where it
/// now runs.
pub(super) fn cached_status(conn: &rusqlite::Connection) -> Value {
    let current = app_version();
    let latest = text_or_null(conn, KEY_LATEST_VERSION);
    let update_available = latest
        .as_str()
        .is_some_and(|l| compare_versions(l, &current) == std::cmp::Ordering::Greater);
    let mut out = Map::new();
    out.insert("currentVersion".into(), json!(current));
    out.insert("latestVersion".into(), latest);
    out.insert("updateAvailable".into(), json!(update_available));
    out.insert(
        "lastChecked".into(),
        json!(int_setting(conn, KEY_LAST_CHECKED)),
    );
    out.insert(
        "latestPublishedAt".into(),
        text_or_null(conn, KEY_LATEST_PUBDATE),
    );
    out.insert("latestNotes".into(), text_or_null(conn, KEY_LATEST_NOTES));
    out.insert("latestUrl".into(), text_or_null(conn, KEY_LATEST_URL));
    out.insert("lastError".into(), text_or_null(conn, KEY_LAST_ERROR));
    out.insert(
        "enabled".into(),
        json!(setting(conn, KEY_ENABLED, "true") != "false"),
    );
    out.insert("runtime".into(), json!(deployment_runtime()));
    Value::Object(out)
}

/// `CheckResult`.
pub(super) struct CheckResult {
    pub performed: bool,
    pub skip_reason: Option<&'static str>,
    pub error: Option<String>,
    pub status: Value,
}

fn skipped(reason: &'static str, status: Value) -> CheckResult {
    CheckResult {
        performed: false,
        skip_reason: Some(reason),
        error: None,
        status,
    }
}

// ── The check ────────────────────────────────────────────────────────

/// `fetchLatestRelease`: the release object, `{}` when there is none.
async fn fetch_latest_release(fetcher: &dyn Fetcher) -> Result<Value, String> {
    let mut request = Request::public(RELEASES_URL.to_string(), 4 * 1024 * 1024, FETCH_TIMEOUT_MS);
    // A plain `fetch` follows redirects on its own.
    request.max_redirects = 20;
    request.headers = vec![
        (
            "Accept".to_string(),
            "application/vnd.github+json".to_string(),
        ),
        ("X-GitHub-Api-Version".to_string(), "2022-11-28".to_string()),
        ("User-Agent".to_string(), user_agent()),
    ];
    let reply = fetcher.fetch(request).await?;
    if reply.status == 404 {
        return Ok(json!({}));
    }
    let text = String::from_utf8_lossy(&reply.body).into_owned();
    if !reply.ok() {
        return Err(format!("GitHub API {}: {text}", reply.status));
    }
    // `res.json()` — its failure is worded by the engine on Node, and in
    // plain words here.
    serde_json::from_str(&text)
        .map_err(|_| "GitHub API returned a body that is not JSON".to_string())
}

/// `writeReleaseToSettings`. A draft or a pre-release writes nothing —
/// GitHub already excludes them from `releases/latest`, this is belt and
/// braces — and an empty tag marks the check done and leaves the cached
/// version alone.
fn write_release(cx: &mut Cx, release: &Value) -> Result<(), String> {
    if release["draft"].as_bool() == Some(true) || release["prerelease"].as_bool() == Some(true) {
        return Ok(());
    }
    let tag = match &release["tag_name"] {
        Value::Null => "".to_string(),
        Value::String(s) => js_trim(s).to_string(),
        other => return Err(format!("Latest release tag is not text: {other}")),
    };
    let now = cx.now.to_string();
    if tag.is_empty() {
        cx.set(KEY_LAST_CHECKED, &now)?;
        cx.set(KEY_LAST_ERROR, "")?;
        return Ok(());
    }
    let version = strip_v_prefix(&tag);
    if !is_valid_semver(version) {
        return Err(format!("Latest release tag is not valid semver: {tag}"));
    }
    let text = |v: &Value| -> String {
        match v {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            other => super::preview::string(other),
        }
    };
    cx.set(KEY_LATEST_VERSION, version)?;
    cx.set(
        KEY_LATEST_NOTES,
        &js_slice_prefix(&text(&release["body"]), NOTES_PREVIEW_MAX_CHARS),
    )?;
    cx.set(KEY_LATEST_URL, &text(&release["html_url"]))?;
    cx.set(KEY_LATEST_PUBDATE, &text(&release["published_at"]))?;
    cx.set(KEY_LAST_CHECKED, &now)?;
    cx.set(KEY_LAST_ERROR, "")?;
    Ok(())
}

/// One check in flight at a time. Node shares the in-flight promise with
/// a second caller; here the second caller waits for it and answers from
/// what it wrote.
fn in_flight() -> &'static tokio::sync::Mutex<()> {
    static IN_FLIGHT: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// `checkForUpdate`: the cache TTL unless forced; the failure backoff
/// unless forced; the five-minute throttle when forced. The database is
/// updated in place, the connection released around the request.
pub(super) async fn check_for_update(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    now: i64,
    force: bool,
) -> CheckResult {
    enum Gate {
        Skip(CheckResult),
        Go,
        Failed(String, Value),
    }
    let gate = db.with(|w| {
        let status0 = cached_status(w.conn);
        if status0["enabled"] != true {
            return Gate::Skip(skipped("disabled", status0));
        }
        let last_checked = int_setting(w.conn, KEY_LAST_CHECKED);
        let cache_fresh = last_checked > 0 && ((now - last_checked) as f64) < CACHE_TTL_MS;
        if !force && cache_fresh {
            return Gate::Skip(skipped("cache_fresh", status0));
        }
        if !force {
            let last_failed = int_setting(w.conn, KEY_LAST_FAILED);
            let fail_count = int_setting(w.conn, KEY_FAIL_COUNT);
            if last_failed > 0 && ((now - last_failed) as f64) < failure_backoff_ms(fail_count) {
                return Gate::Skip(skipped("backoff", status0));
            }
        }
        if force {
            let last_forced = int_setting(w.conn, KEY_LAST_FORCED);
            if now - last_forced < FORCE_REFRESH_MIN_GAP_MS {
                return Gate::Skip(skipped("force_throttled", status0));
            }
            let mut cx = Cx { w, ids, now };
            if let Err(e) = cx.set(KEY_LAST_FORCED, &now.to_string()) {
                return Gate::Failed(e, status0);
            }
        }
        Gate::Go
    });
    match gate {
        Gate::Skip(result) => return result,
        Gate::Failed(e, status) => {
            return CheckResult {
                performed: true,
                skip_reason: None,
                error: Some(e),
                status,
            }
        }
        Gate::Go => {}
    }
    let Ok(_guard) = in_flight().try_lock() else {
        let _guard = in_flight().lock().await;
        let status = db.with(|w| cached_status(w.conn));
        return CheckResult {
            performed: true,
            skip_reason: Some("in_progress"),
            error: None,
            status,
        };
    };
    let fetched = fetch_latest_release(fetcher).await;
    db.with(|w| {
        let mut cx = Cx { w, ids, now };
        let outcome = fetched.and_then(|release| write_release(&mut cx, &release));
        match outcome {
            Ok(()) => {
                let _ = cx.set(KEY_LAST_FAILED, "0");
                let _ = cx.set(KEY_FAIL_COUNT, "0");
                CheckResult {
                    performed: true,
                    skip_reason: None,
                    error: None,
                    status: cached_status(cx.w.conn),
                }
            }
            Err(message) => {
                // The error is kept for the UI; the cache is not clobbered.
                let _ = cx.set(KEY_LAST_ERROR, &js_slice_prefix(&message, 500));
                let _ = cx.set(KEY_LAST_FAILED, &now.to_string());
                let previous = int_setting(cx.w.conn, KEY_FAIL_COUNT);
                let _ = cx.set(KEY_FAIL_COUNT, &(previous + 1).to_string());
                CheckResult {
                    performed: true,
                    skip_reason: None,
                    error: Some(message),
                    status: cached_status(cx.w.conn),
                }
            }
        }
    })
}

/// The 25 s, then 6-hour, tick: never forced, so the day's cache and the
/// failure backoff both hold, and a failure is logged and nothing more.
pub(crate) async fn tick_update_check(db: &mut dyn DbAccess, fetcher: &dyn Fetcher, now: i64) {
    let mut ids = RandomIds;
    let result = check_for_update(db, &mut ids, fetcher, now, false).await;
    if result.performed {
        if let Some(error) = result.error {
            super::diag::log_warn(format!("[UpdateCheck] Check failed: {error}"));
        } else if result.status["updateAvailable"] == true {
            log::info!(
                "[UpdateCheck] Update available — {} → {}",
                super::preview::string(&result.status["currentVersion"]),
                super::preview::string(&result.status["latestVersion"])
            );
        }
    }
}

// ── GET /api/update-status ───────────────────────────────────────────

/// The cached status plus `meta` for this request; `?refresh=1` forces a
/// live check first.
pub(super) async fn update_status_with(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    q: &Params,
    now: i64,
) -> Response {
    let mut out = Map::new();
    if get(q, "refresh") == Some("1") {
        let result = check_for_update(db, ids, fetcher, now, true).await;
        if let Value::Object(status) = result.status {
            out.extend(status);
        }
        out.insert(
            "meta".into(),
            json!({
                "refreshed": result.performed,
                "skipReason": result.skip_reason,
                "error": result.error,
            }),
        );
        return json_ok(&Value::Object(out));
    }
    let status = db.with(|w| cached_status(w.conn));
    let last_error = status["lastError"].clone();
    if let Value::Object(status) = status {
        out.extend(status);
    }
    out.insert(
        "meta".into(),
        json!({ "refreshed": false, "skipReason": "cache_only", "error": last_error }),
    );
    json_ok(&Value::Object(out))
}

pub async fn update_status(State(state): State<AppState>, Query(q): Query<Params>) -> Response {
    let mut ids = RandomIds;
    let mut db = state.db_access();
    update_status_with(&mut db, &mut ids, &PublicHttp, &q, super::now_ms()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::{Equal, Greater, Less};

    #[test]
    fn versions_compare_as_the_typescript_helper_compares_them() {
        assert_eq!(compare_versions("0.2.0", "0.1.9"), Greater);
        assert_eq!(compare_versions("0.2.0", "0.2.0"), Equal);
        assert_eq!(compare_versions("0.2.0-beta.1", "0.2.0"), Less);
        assert_eq!(compare_versions("0.2.0", "0.2.0-rc.1"), Greater);
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-alpha.1"), Less);
        assert_eq!(compare_versions("1.0.0-alpha.2", "1.0.0-alpha.10"), Less);
        assert_eq!(
            compare_versions("1.0.0-alpha.beta", "1.0.0-alpha.1"),
            Greater
        );
        assert_eq!(compare_versions("1.0.0-beta", "1.0.0-alpha"), Greater);
        // Build metadata is ignored; a third `-` piece is dropped by
        // `split("-", 2)`; a missing field reads as zero.
        assert_eq!(compare_versions("1.0.0+build.9", "1.0.0"), Equal);
        assert_eq!(compare_versions("1.0.0-beta-2", "1.0.0-beta"), Equal);
        assert_eq!(compare_versions("1.2", "1.2.0"), Equal);
        assert_eq!(compare_versions("1.x.3", "1.0.3"), Equal);
    }

    #[test]
    fn backoff_doubles_and_caps_at_the_day() {
        let min15 = 15.0 * 60.0 * 1000.0;
        assert_eq!(failure_backoff_ms(0), 0.0);
        assert_eq!(failure_backoff_ms(1), min15);
        assert_eq!(failure_backoff_ms(3), 4.0 * min15);
        assert_eq!(failure_backoff_ms(11), CACHE_TTL_MS);
        assert_eq!(failure_backoff_ms(-3), 0.0);
        assert_eq!(failure_backoff_ms(i64::MAX), CACHE_TTL_MS);
    }

    #[test]
    fn tags_are_read_as_semver_after_one_v() {
        assert!(is_valid_semver(strip_v_prefix("v1.2.3")));
        assert!(is_valid_semver(strip_v_prefix("V1.2.3-rc.1+build.7")));
        assert!(!is_valid_semver(strip_v_prefix("vv1.2.3")));
        assert!(!is_valid_semver("1.2"));
        assert!(!is_valid_semver("1.2.3-"));
        assert!(!is_valid_semver("１.2.3"));
    }
}

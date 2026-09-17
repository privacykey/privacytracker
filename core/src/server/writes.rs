//! Phase 4, batch 1: the twenty settings-style writes — the `POST`, `PUT`
//! and `DELETE` exports of seventeen route files, from `/api/date-format`
//! to `/api/migration-flow/consume`. Each handler is the Node source in
//! order: its guard, its body read with the route's own cap and 400
//! phrasing, its validation branches (some of which write before they
//! refuse), its writes with Node's SQL byte for byte, and its response
//! literal. Gated by `core/tests/fixtures/writes-cases.json`, which
//! `writes_tests.rs` replays through `precheck` and `perform` exactly as
//! the axum wrappers in `routes_writes.rs` call them.
//!
//! The bodies are `any` in Node, so much of this is JavaScript semantics
//! over `serde_json::Value`: `body.x !== undefined` is a present key
//! (`prop`), truthiness, `String()`, `Number()`, `Object.keys` order, and
//! which property reads throw on a `null` body (the routes that do are the
//! 500s below).
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use super::{
    activity_log::record_activity,
    auth::{admin_token_configured, request_has_valid_admin_token},
    body::{body_error_response, BodyOutcome},
    flags::{context_from_db, resolve_flag},
    guard::{actor_from, record_audit, require_mutation_guard, Actor, AdminRule, GuardOptions},
    json::{json_error, json_ok, json_response},
    layout::{match_dashboard_preset, presets, read_layout, reconcile_layout, Layout},
    preview::string as js_string,
    ratelimit::{self, RateLimiter},
    routes::{
        is_supported_locale, normalise_date_format, parse_stored_profile, A11Y_FEATURE_KEYS,
        A11Y_PREFERENCES, PROFILE_CATEGORY_KEYS, PROFILE_TIERS,
    },
    routes_detail::normalize_ai_provider,
    routes_focus::infer_focus_workflow,
    routes_settings::read_desktop,
    settings::get_setting_with,
    stats::truthy,
    trust::is_network_exposed,
    webhook::mask_webhook_url,
};
use crate::{
    jsdate::js_utc_string,
    jsnum::{js_number_spelling, js_parse_float, js_parse_int, js_to_number},
    jsstr::{js_length, js_trim},
    outbound,
    scrape::{
        persist::{DbAccess, Writer},
        region::normalize_country,
        Ids,
    },
};
use axum::{
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::Response,
};
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

const SET_SETTING: &str = "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)";
const SET_OVERRIDE: &str = "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, previous_focus, quarantined)\n     VALUES (?, ?, ?, 'user', ?, 0)\n     ON CONFLICT(flag_key) DO UPDATE SET\n       override_value = excluded.override_value,\n       set_at = excluded.set_at,\n       set_by = excluded.set_by,\n       previous_focus = excluded.previous_focus,\n       quarantined = 0";
const CLEAR_OVERRIDE: &str = "DELETE FROM feature_flag_overrides WHERE flag_key = ?";
const CLEAR_ALL_OVERRIDES: &str = "DELETE FROM feature_flag_overrides WHERE quarantined = 0";
const CLEAR_SURFACE_OVERRIDES: &str =
    "DELETE FROM feature_flag_overrides\n     WHERE quarantined = 0\n       AND flag_key LIKE ?";

const AUDIENCES: [&str; 3] = ["self", "loved_one", "guardian"];
const FOCUS_WORKFLOWS: [&str; 5] = [
    "self_monitor",
    "self_cleanup",
    "other_handoff",
    "other_monitor",
    "custom",
];
const AGE_BAND_KEYS: [&str; 5] = ["under_9", "9_12", "13_15", "16_17", "18_plus"];
const SUPPORTED_LOCALES: [&str; 2] = ["en", "zh"];
const FLAG_VALUES: [&str; 3] = ["on", "off", "collapsed"];
const AI_PROVIDERS: [&str; 4] = ["disabled", "openai", "anthropic", "custom"];
const AI_TIMEOUT_PHASES: [&str; 3] = ["direct", "chunk", "merge"];
const AI_TIMEOUT_MIN_MS: f64 = 10_000.0;
const AI_TIMEOUT_MAX_MS: f64 = 900_000.0;
const MASKED_SECRET_VALUE: &str = "__SET__";
const WEBHOOK_FORMATS: [&str; 4] = ["slack", "discord", "teams", "generic"];
const WEBHOOK_FREQUENCIES: [&str; 4] = ["immediate", "daily_summary", "weekly_summary", "off"];
const NOTIFICATION_TYPE_KEYS: [&str; 7] = [
    "labelChanges",
    "profileMismatch",
    "policyUpdates",
    "versionUpdates",
    "importCompleted",
    "manualAppsPrompt",
    "aiTimeout",
];
const NOTIFICATION_FLAGS: [(&str, &str); 4] = [
    ("label_changes", "flag.notifications.types.label_changes"),
    ("policy_updates", "flag.notifications.types.policy_updates"),
    (
        "accessibility_changes",
        "flag.notifications.types.accessibility_changes",
    ),
    (
        "new_privacy_types",
        "flag.notifications.types.new_privacy_types",
    ),
];
const PROFILE_PRESETS: [(&str, &str, [&str; 14]); 4] = [
    (
        "strict",
        "Strict",
        [
            "not_linked",
            "not_collected",
            "not_linked",
            "not_collected",
            "not_collected",
            "not_collected",
            "not_linked",
            "not_collected",
            "not_linked",
            "not_linked",
            "not_linked",
            "not_linked",
            "not_linked",
            "not_collected",
        ],
    ),
    (
        "balanced",
        "Balanced",
        [
            "linked",
            "not_linked",
            "linked",
            "not_linked",
            "not_collected",
            "not_linked",
            "linked",
            "not_linked",
            "not_linked",
            "not_linked",
            "linked",
            "linked",
            "linked",
            "linked",
        ],
    ),
    ("anti_tracking", "Anti-tracking only", ["linked"; 14]),
    (
        "permissive",
        "Permissive",
        [
            "tracking",
            "linked",
            "linked",
            "linked",
            "not_linked",
            "tracking",
            "tracking",
            "tracking",
            "tracking",
            "tracking",
            "tracking",
            "tracking",
            "tracking",
            "tracking",
        ],
    ),
];
const LAYOUT_PRESET_LABELS: [(&str, &str); 5] = [
    ("default", "Default"),
    ("minimal", "Minimal"),
    ("caretaker", "Caretaker"),
    ("watchdog", "Watchdog"),
    ("at_a_glance", "At a glance"),
];
const DESKTOP_KEYS: [(&str, &str); 11] = [
    ("hide_dock", "desktop_hide_dock"),
    ("launch_hidden", "desktop_launch_hidden"),
    ("autostart", "desktop_autostart"),
    ("native_notifications", "desktop_native_notifications"),
    ("global_shortcut", "desktop_global_shortcut"),
    ("require_unlock", "desktop_require_unlock"),
    ("auto_lock_idle_minutes", "desktop_auto_lock_idle_minutes"),
    ("theme_override", "desktop_theme_override"),
    ("devtools_open", "desktop_devtools_open"),
    ("tray_visible", "desktop_tray_visible"),
    ("zoom_level", "desktop_zoom_level"),
];

// ── The route table ──────────────────────────────────────────────────

/// What the axum wrapper and the replay both need before the body: the
/// cap, and the guard that runs ahead of the read.
pub struct RouteSpec {
    pub path: &'static str,
    pub method: Method,
    /// `None` for the one route that never reads its body.
    pub body_limit: Option<usize>,
    guard: Guard,
}

enum Guard {
    None,
    /// The routes that inline their own guard: the rate limit first, then
    /// the admin token with an audit row named by the route.
    Inline(InlineGuard),
    Mutation(GuardOptions),
    /// `checkRateLimit` inline with the route's own phrasing and a
    /// `Retry-After`, and no admin check at all. `per_param` appends the
    /// path id to the key, as the wayback import does.
    Rate {
        prefix: &'static str,
        limit: i64,
        message: &'static str,
        per_param: bool,
    },
}

/// An inlined `checkRateLimit` + `adminTokenRequiredForRequest` pair, in
/// the route's own words: a 429 with `message` (and an audit row when the
/// route records one), then a 401 whose audit row is `unauthorised` with
/// `unauthorised_detail`. Neither carries a `Retry-After`.
pub struct InlineGuard {
    pub prefix: &'static str,
    pub limit: i64,
    pub window_ms: i64,
    pub message: &'static str,
    pub rate_audit: Option<&'static str>,
    pub unauthorised: &'static str,
    pub unauthorised_detail: Option<&'static str>,
}

/// The batch-1 shape: a bare `Rate limit exceeded` a minute wide, no audit
/// on the 429 and none of the detail on the 401.
const fn inline(prefix: &'static str, limit: i64, unauthorised: &'static str) -> Guard {
    Guard::Inline(InlineGuard {
        prefix,
        limit,
        window_ms: 60_000,
        message: "Rate limit exceeded",
        rate_audit: None,
        unauthorised,
        unauthorised_detail: None,
    })
}

const fn guarded(action: &'static str, limit: i64, admin: AdminRule) -> Guard {
    Guard::Mutation(GuardOptions {
        action,
        key_prefix: action,
        limit,
        window_ms: 60_000,
        message: None,
        admin,
    })
}

pub fn routes() -> &'static [RouteSpec] {
    static ROUTES: OnceLock<Vec<RouteSpec>> = OnceLock::new();
    ROUTES.get_or_init(|| {
        let mut routes = vec![
            RouteSpec {
                path: "/api/date-format",
                method: Method::POST,
                body_limit: Some(1024),
                guard: Guard::None,
            },
            RouteSpec {
                path: "/api/locale",
                method: Method::POST,
                body_limit: Some(1024),
                guard: Guard::None,
            },
            RouteSpec {
                path: "/api/preferences",
                method: Method::PUT,
                body_limit: Some(4 * 1024),
                guard: Guard::None,
            },
            RouteSpec {
                path: "/api/settings",
                method: Method::POST,
                body_limit: Some(16 * 1024),
                guard: inline("settings.write", 30, "settings.write.unauthorised"),
            },
            RouteSpec {
                path: "/api/settings/desktop",
                method: Method::POST,
                body_limit: Some(16 * 1024),
                guard: guarded("settings.desktop.write", 20, AdminRule::Required),
            },
            RouteSpec {
                path: "/api/notification-prefs",
                method: Method::PUT,
                body_limit: Some(8 * 1024),
                guard: Guard::None,
            },
            RouteSpec {
                path: "/api/focus",
                method: Method::POST,
                body_limit: Some(4 * 1024),
                guard: Guard::None,
            },
            RouteSpec {
                path: "/api/privacy-profile",
                method: Method::PUT,
                body_limit: Some(16 * 1024),
                guard: Guard::None,
            },
            RouteSpec {
                path: "/api/accessibility-profile",
                method: Method::PUT,
                body_limit: Some(16 * 1024),
                guard: Guard::None,
            },
            RouteSpec {
                path: "/api/feature-flags/overrides",
                method: Method::POST,
                body_limit: Some(64 * 1024),
                guard: guarded("feature_flag.override", 30, AdminRule::Required),
            },
            RouteSpec {
                path: "/api/feature-flags/overrides",
                method: Method::DELETE,
                body_limit: None,
                guard: guarded("feature_flag.override.clear", 10, AdminRule::Required),
            },
            RouteSpec {
                path: "/api/feature-flags/overrides/[key]",
                method: Method::DELETE,
                body_limit: None,
                guard: guarded("feature_flag.override.clear_one", 30, AdminRule::Required),
            },
            RouteSpec {
                path: "/api/dashboard/layout",
                method: Method::PUT,
                body_limit: Some(8 * 1024),
                guard: guarded("dashboard.layout.save", 60, AdminRule::NotRequired),
            },
            RouteSpec {
                path: "/api/dashboard/layout",
                method: Method::DELETE,
                body_limit: None,
                guard: guarded("dashboard.layout.reset", 20, AdminRule::NotRequired),
            },
            RouteSpec {
                path: "/api/dashboard/layout/preset",
                method: Method::POST,
                body_limit: Some(1024),
                guard: guarded("dashboard.layout.preset", 30, AdminRule::NotRequired),
            },
            RouteSpec {
                path: "/api/coachmark-state",
                method: Method::POST,
                body_limit: Some(4 * 1024),
                guard: guarded("coachmark.write", 30, AdminRule::NotRequired),
            },
            RouteSpec {
                path: "/api/dev-menu-state",
                method: Method::POST,
                body_limit: Some(4 * 1024),
                guard: guarded("dev_menu.write", 30, AdminRule::NotRequired),
            },
            RouteSpec {
                path: "/api/welcomed-at",
                method: Method::POST,
                body_limit: Some(1024),
                guard: guarded("welcomed-at.set", 60, AdminRule::NotRequired),
            },
            RouteSpec {
                path: "/api/migration-flow/consume",
                method: Method::POST,
                body_limit: None,
                guard: guarded("migration-flow.consume", 60, AdminRule::NotRequired),
            },
        ];
        routes.extend(library_routes());
        routes.extend(imports_routes());
        routes.extend(runner_routes());
        routes.extend(maintenance_routes());
        routes
    })
}

/// Phase 4, batch 4a — see `runner_writes.rs`.
fn runner_routes() -> Vec<RouteSpec> {
    let spec =
        |path: &'static str, method: Method, body_limit: Option<usize>, guard: Guard| RouteSpec {
            path,
            method,
            body_limit,
            guard,
        };
    vec![
        spec(
            "/api/sync/trigger",
            Method::POST,
            None,
            Guard::Mutation(GuardOptions {
                action: "sync.trigger",
                key_prefix: "sync.trigger",
                limit: 10,
                window_ms: 10 * 60_000,
                message: Some("Rate limit exceeded for manual sync. Try again later."),
                admin: AdminRule::NotRequired,
            }),
        ),
        spec(
            "/api/dev/sync-stop",
            Method::POST,
            None,
            Guard::Mutation(GuardOptions {
                action: "dev.sync_stop",
                key_prefix: "dev.sync_stop",
                limit: 10,
                window_ms: 10 * 60_000,
                message: Some("Rate limit exceeded for sync stop. Try again later."),
                admin: AdminRule::Configured,
            }),
        ),
        spec(
            "/api/rate-limit/status",
            Method::DELETE,
            Some(1024),
            guarded("rate_limit.clear", 10, AdminRule::NotRequired),
        ),
        spec(
            "/api/apps",
            Method::DELETE,
            None,
            inline("apps.delete", 60, "app.delete.unauthorised"),
        ),
        // Phase 4, batch 4b — see `wayback_runner.rs`.
        spec(
            "/api/wayback/import-all",
            Method::POST,
            None,
            Guard::Rate {
                prefix: "wayback.import-all",
                limit: 2,
                message: "Bulk import throttled — wait before retrying.",
                per_param: false,
            },
        ),
        spec(
            "/api/wayback/import-all",
            Method::PATCH,
            Some(4 * 1024),
            Guard::Rate {
                prefix: "wayback.import-all.control",
                limit: 20,
                message: "Wayback import controls are throttled — wait before retrying.",
                per_param: false,
            },
        ),
        spec("/api/wayback/import-all", Method::DELETE, None, Guard::None),
    ]
}

/// Phase 4, batch 5a — see `maintenance_writes.rs`. The diagnostics
/// routes, the reset and the AI log inline their guards in their own
/// words; the CSP report, the login and the logout run theirs in
/// `precheck`, where the headers are.
fn maintenance_routes() -> Vec<RouteSpec> {
    const SHORTLY: &str = "Rate limit exceeded. Try again shortly.";
    const fn diagnostics(
        prefix: &'static str,
        limit: i64,
        unauthorised: &'static str,
        unauthorised_detail: Option<&'static str>,
    ) -> Guard {
        Guard::Inline(InlineGuard {
            prefix,
            limit,
            window_ms: 60_000,
            message: SHORTLY,
            rate_audit: None,
            unauthorised,
            unauthorised_detail,
        })
    }
    const fn dev(action: &'static str, limit: i64, message: &'static str) -> Guard {
        Guard::Mutation(GuardOptions {
            action,
            key_prefix: action,
            limit,
            window_ms: 10 * 60_000,
            message: Some(message),
            admin: AdminRule::Configured,
        })
    }
    let spec =
        |path: &'static str, method: Method, body_limit: Option<usize>, guard: Guard| RouteSpec {
            path,
            method,
            body_limit,
            guard,
        };
    vec![
        spec(
            "/api/diagnostics/health",
            Method::POST,
            None,
            diagnostics(
                "diagnostics.health.run",
                4,
                "diagnostics.health.run.unauthorised",
                None,
            ),
        ),
        spec(
            "/api/diagnostics/database",
            Method::POST,
            Some(1024),
            diagnostics(
                "diagnostics.database.check",
                4,
                "diagnostics.database.check.unauthorised",
                None,
            ),
        ),
        spec(
            "/api/diagnostics/errors",
            Method::DELETE,
            None,
            diagnostics(
                "diagnostics.errors.clear",
                10,
                "diagnostics.errors.clear.unauthorised",
                None,
            ),
        ),
        spec(
            "/api/diagnostics/runtime",
            Method::DELETE,
            None,
            diagnostics(
                "diagnostics.runtime.clear",
                10,
                "diagnostics.runtime.clear.unauthorised",
                Some("admin token required but missing or invalid"),
            ),
        ),
        spec(
            "/api/diagnostics/runtime",
            Method::POST,
            Some(1024),
            diagnostics(
                "diagnostics.runtime.config",
                10,
                "diagnostics.runtime.config.unauthorised",
                None,
            ),
        ),
        spec(
            "/api/ai/debug-log",
            Method::DELETE,
            None,
            inline("ai_debug_log.clear", 10, "ai_debug_log.unauthorised"),
        ),
        spec(
            "/api/reset",
            Method::POST,
            None,
            Guard::Inline(InlineGuard {
                prefix: "reset",
                limit: 30,
                window_ms: 10 * 60_000,
                message: "Rate limit exceeded for reset. Try again later.",
                rate_audit: Some("reset.rate_limited"),
                unauthorised: "reset.unauthorised",
                unauthorised_detail: Some("admin token required but missing or invalid"),
            }),
        ),
        spec(
            "/api/auth/admin-token/login",
            Method::POST,
            Some(4 * 1024),
            Guard::None,
        ),
        spec(
            "/api/auth/admin-token/logout",
            Method::POST,
            None,
            Guard::None,
        ),
        spec(
            "/api/csp-report",
            Method::POST,
            Some(16 * 1024),
            Guard::None,
        ),
        spec(
            "/api/dev/reset-changelog",
            Method::POST,
            None,
            dev(
                "dev.reset_changelog",
                6,
                "Rate limit exceeded for dev changelog reset. Try again later.",
            ),
        ),
        spec(
            "/api/dev/seed-notification",
            Method::POST,
            Some(16 * 1024),
            dev(
                "dev.seed_notification",
                30,
                "Rate limit exceeded for dev notification seeding. Try again later.",
            ),
        ),
        spec(
            "/api/dev/wipe-apps",
            Method::POST,
            None,
            dev(
                "dev.wipe_apps",
                6,
                "Rate limit exceeded for dev wipe. Try again later.",
            ),
        ),
        spec(
            "/api/admin/start-over",
            Method::POST,
            None,
            Guard::Mutation(GuardOptions {
                action: "admin.start_over",
                key_prefix: "admin.start_over",
                limit: 3,
                window_ms: 10 * 60_000,
                message: Some("Rate limit exceeded for Start Over. Try again later."),
                admin: AdminRule::Required,
            }),
        ),
    ]
}

/// Phase 4, batch 3 — see `imports_writes.rs`.
fn imports_routes() -> Vec<RouteSpec> {
    const fn rate(prefix: &'static str, limit: i64, message: &'static str) -> Guard {
        Guard::Rate {
            prefix,
            limit,
            message,
            per_param: false,
        }
    }
    let spec =
        |path: &'static str, method: Method, body_limit: Option<usize>, guard: Guard| RouteSpec {
            path,
            method,
            body_limit,
            guard,
        };
    vec![
        spec("/api/imports", Method::POST, Some(8 * 1024), Guard::None),
        spec("/api/imports", Method::DELETE, None, Guard::None),
        spec(
            "/api/imports/items",
            Method::POST,
            Some(512 * 1024),
            guarded("imports.items.add", 30, AdminRule::NotRequired),
        ),
        spec(
            "/api/imports/items/update",
            Method::POST,
            Some(32 * 1024),
            Guard::None,
        ),
        spec("/api/imports/queue", Method::POST, None, Guard::None),
        spec(
            "/api/imports/complete",
            Method::POST,
            Some(4 * 1024),
            Guard::None,
        ),
        spec(
            "/api/imports/items/retry",
            Method::POST,
            Some(4 * 1024),
            rate(
                "imports-retry-item",
                30,
                "Rate limit exceeded for /api/imports/items/retry. Try again shortly.",
            ),
        ),
        spec(
            "/api/imports/items/change-match",
            Method::POST,
            Some(16 * 1024),
            Guard::None,
        ),
        spec(
            "/api/search",
            Method::POST,
            Some(256 * 1024),
            rate(
                "search",
                60,
                "Rate limit exceeded for /api/search. Try again shortly.",
            ),
        ),
        spec(
            "/api/scrape",
            Method::POST,
            Some(256 * 1024),
            rate(
                "scrape",
                30,
                "Rate limit exceeded for /api/scrape. Try again shortly.",
            ),
        ),
        spec(
            "/api/apps/[id]/import-history",
            Method::POST,
            Some(4 * 1024),
            Guard::Rate {
                prefix: "wayback.import",
                limit: 3,
                message: "Import throttled — wait before retrying.",
                per_param: true,
            },
        ),
        spec(
            "/api/apps/[id]/import-history",
            Method::DELETE,
            None,
            Guard::None,
        ),
    ]
}

/// The routes whose handlers await the network; `perform_async` runs them.
pub fn is_async(spec: &RouteSpec) -> bool {
    super::imports_writes::handles(spec) || super::runner_writes::handles(spec)
}

/// Phase 4, batch 2 — see `library_writes.rs`.
fn library_routes() -> Vec<RouteSpec> {
    let spec =
        |path: &'static str, method: Method, body_limit: Option<usize>, guard: Guard| RouteSpec {
            path,
            method,
            body_limit,
            guard,
        };
    vec![
        spec(
            "/api/shortlist",
            Method::POST,
            Some(8 * 1024),
            inline("shortlist.write", 60, "shortlist.create.unauthorised"),
        ),
        spec(
            "/api/shortlist",
            Method::DELETE,
            None,
            inline("shortlist.write", 60, "shortlist.delete.unauthorised"),
        ),
        spec("/api/verdicts", Method::POST, Some(8 * 1024), Guard::None),
        spec("/api/verdicts", Method::DELETE, None, Guard::None),
        spec(
            "/api/verdicts/bulk",
            Method::POST,
            Some(64 * 1024),
            Guard::None,
        ),
        spec(
            "/api/notifications",
            Method::POST,
            Some(32 * 1024),
            Guard::None,
        ),
        spec(
            "/api/annotations",
            Method::POST,
            Some(8 * 1024),
            Guard::None,
        ),
        spec(
            "/api/annotations/[id]",
            Method::PATCH,
            Some(8 * 1024),
            Guard::None,
        ),
        spec("/api/annotations/[id]", Method::DELETE, None, Guard::None),
        spec("/api/annotations/[id]", Method::PUT, None, Guard::None),
        spec(
            "/api/apps/[id]/acknowledge",
            Method::POST,
            Some(2 * 1024),
            Guard::None,
        ),
        spec(
            "/api/apps/[id]/acknowledge/undo",
            Method::POST,
            Some(4 * 1024),
            Guard::None,
        ),
        spec(
            "/api/user-tasks",
            Method::POST,
            Some(4 * 1024),
            guarded("user-tasks.write", 60, AdminRule::NotRequired),
        ),
        spec(
            "/api/user-tasks/visit",
            Method::POST,
            Some(1024),
            guarded("user-tasks.visit", 60, AdminRule::NotRequired),
        ),
        spec(
            "/api/activity/queue-session",
            Method::POST,
            Some(4 * 1024),
            Guard::None,
        ),
        spec(
            "/api/devices",
            Method::POST,
            Some(4 * 1024),
            guarded("devices.create", 20, AdminRule::NotRequired),
        ),
        spec(
            "/api/devices/[id]",
            Method::PATCH,
            Some(4 * 1024),
            guarded("devices.update", 30, AdminRule::NotRequired),
        ),
        spec(
            "/api/devices/[id]",
            Method::DELETE,
            None,
            guarded("devices.delete", 15, AdminRule::NotRequired),
        ),
        spec(
            "/api/device-scope",
            Method::PUT,
            Some(8 * 1024),
            guarded("device.scope.save", 60, AdminRule::NotRequired),
        ),
        spec(
            "/api/device-scope",
            Method::DELETE,
            None,
            guarded("device.scope.reset", 20, AdminRule::NotRequired),
        ),
        spec(
            "/api/manual-apps",
            Method::POST,
            Some(8 * 1024),
            inline("manual-apps.write", 30, "manual-apps.create.unauthorised"),
        ),
        spec(
            "/api/manual-apps/[id]",
            Method::PUT,
            Some(8 * 1024),
            inline("manual-apps.write", 30, "manual-apps.update.unauthorised"),
        ),
        spec(
            "/api/manual-apps/[id]",
            Method::DELETE,
            None,
            inline("manual-apps.write", 30, "manual-apps.delete.unauthorised"),
        ),
        spec(
            "/api/manual-apps/bulk",
            Method::POST,
            Some(256 * 1024),
            inline("manual-apps.bulk", 10, "manual-apps.bulk.unauthorised"),
        ),
        spec(
            "/api/manual-apps/[id]/restore",
            Method::POST,
            Some(8 * 1024),
            inline("manual-apps.write", 30, "manual-apps.restore.unauthorised"),
        ),
    ]
}

pub fn lookup(path: &str, method: &Method) -> Option<&'static RouteSpec> {
    routes()
        .iter()
        .find(|r| r.path == path && r.method == *method)
}

/// Everything a handler sees after the body has been read.
pub struct WriteRequest<'a> {
    pub spec: &'static RouteSpec,
    /// The `[key]` segment, already percent-decoded.
    pub param: Option<&'a str>,
    /// The query in wire order; the first occurrence of a name wins.
    pub query: &'a [(String, String)],
    pub body: BodyOutcome,
    /// The request headers, for the handlers that read them after the
    /// body: the login's cookie takes the scheme the request arrived on.
    pub headers: &'a HeaderMap,
    /// The process, for the two runtime-diagnostics writes whose response
    /// is this server's own envelope. `None` in a replay that never asks.
    pub state: Option<&'a super::AppState>,
}

/// The guard, ahead of the body read, exactly where Node runs it.
pub fn precheck(
    w: &mut Writer,
    ids: &mut dyn Ids,
    limiter: &RateLimiter,
    headers: &HeaderMap,
    spec: &RouteSpec,
    param: Option<&str>,
    now: i64,
) -> Result<Actor, Response> {
    let actor = guard_only(w, ids, limiter, headers, spec, param, now)?;
    // The checks a route makes after its guard and BEFORE reading the body.
    match (spec.path, &spec.method) {
        ("/api/apps/[id]/import-history", &Method::POST) => {
            let id = param.unwrap_or("");
            if id.is_empty() {
                return Err(json_error(StatusCode::BAD_REQUEST, "Missing id"));
            }
            let app = super::stats::query(
                w.conn,
                "SELECT id, url, name FROM apps WHERE id = ?",
                &[rusqlite::types::Value::Text(id.to_string())],
            )
            .map(|rows| rows.into_iter().next());
            match app {
                Ok(None) => return Err(json_error(StatusCode::NOT_FOUND, "App not found")),
                Ok(Some(row)) if !truthy(&row["url"]) => {
                    return Err(json_error(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "App has no App Store URL to import history from.",
                    ))
                }
                Ok(Some(_)) => {}
                Err(_) => return Err(internal_error()),
            }
        }
        ("/api/devices/[id]", &Method::PATCH) | ("/api/devices/[id]", &Method::DELETE) => {
            let exists = super::routes_devices::by_id(w.conn, param.unwrap_or(""))
                .map_err(|e| e.to_string())
                .map(|d| d.is_some());
            match exists {
                Ok(true) => {}
                Ok(false) => return Err(json_error(StatusCode::NOT_FOUND, "device not found")),
                Err(_) => return Err(json_error(StatusCode::BAD_REQUEST, "device lookup failed")),
            }
        }
        ("/api/manual-apps/[id]", _) | ("/api/manual-apps/[id]/restore", _) => {
            let id = param.unwrap_or("");
            if id.is_empty() || js_length(id) > 128 {
                return Err(json_error(StatusCode::BAD_REQUEST, "Invalid id"));
            }
        }
        // Phase 4, batch 5a: the guards that read the headers, ahead of
        // the body as Node runs them.
        ("/api/csp-report", &Method::POST) => {
            super::maintenance_writes::csp_report_precheck(limiter, headers, now)?;
        }
        ("/api/auth/admin-token/login", &Method::POST) => {
            super::maintenance_writes::login_precheck(w, ids, limiter, headers, &actor, now)?;
        }
        ("/api/auth/admin-token/logout", &Method::POST) => {
            super::maintenance_writes::logout_precheck(headers)?;
        }
        _ => {}
    }
    Ok(actor)
}

fn guard_only(
    w: &mut Writer,
    ids: &mut dyn Ids,
    limiter: &RateLimiter,
    headers: &HeaderMap,
    spec: &RouteSpec,
    param: Option<&str>,
    now: i64,
) -> Result<Actor, Response> {
    match &spec.guard {
        Guard::None => Ok(actor_from(headers)),
        Guard::Mutation(opts) => require_mutation_guard(w, ids, limiter, headers, opts, now),
        Guard::Rate {
            prefix,
            limit,
            message,
            per_param,
        } => {
            let head = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
            let prefix = if *per_param {
                format!("{prefix}.{}", param.unwrap_or(""))
            } else {
                prefix.to_string()
            };
            let key =
                ratelimit::key_for_request(head("x-forwarded-for"), head("x-real-ip"), &prefix);
            let rate = limiter.check(&key, *limit, 60_000, now);
            if !rate.allowed {
                let mut response =
                    json_response(StatusCode::TOO_MANY_REQUESTS, &json!({ "error": message }));
                // `String(Math.ceil(rate.retryAfterMs / 1000))`.
                let seconds = (rate.retry_after_ms.max(0) + 999) / 1000;
                if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                    response.headers_mut().insert(header::RETRY_AFTER, value);
                }
                return Err(response);
            }
            Ok(actor_from(headers))
        }
        Guard::Inline(g) => {
            let actor = actor_from(headers);
            let head = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
            let key =
                ratelimit::key_for_request(head("x-forwarded-for"), head("x-real-ip"), g.prefix);
            let rate = limiter.check(&key, g.limit, g.window_ms, now);
            if !rate.allowed {
                if let Some(action) = g.rate_audit {
                    record_audit(
                        w,
                        ids,
                        now,
                        action,
                        &actor,
                        Some(&format!("retryAfterMs={}", rate.retry_after_ms)),
                        false,
                    );
                }
                return Err(json_error(StatusCode::TOO_MANY_REQUESTS, g.message));
            }
            if (admin_token_configured() || is_network_exposed())
                && !request_has_valid_admin_token(
                    head("x-auditor-admin-token"),
                    head(header::COOKIE.as_str()),
                )
            {
                record_audit(
                    w,
                    ids,
                    now,
                    g.unauthorised,
                    &actor,
                    g.unauthorised_detail,
                    false,
                );
                return Err(json_error(StatusCode::UNAUTHORIZED, "Admin token required"));
            }
            Ok(actor)
        }
    }
}

/// The handler body, after the guard and the body read.
pub fn perform(
    w: &mut Writer,
    ids: &mut dyn Ids,
    req: WriteRequest,
    actor: &Actor,
    now: i64,
) -> Response {
    let mut cx = Cx { w, ids, now };
    let spec = req.spec;
    if super::maintenance_writes::handles(spec) {
        return super::maintenance_writes::perform(&mut cx, req, actor);
    }
    match (spec.path, &spec.method) {
        ("/api/date-format", &Method::POST) => date_format(&mut cx, req.body),
        ("/api/locale", &Method::POST) => locale(req.body, now),
        ("/api/preferences", &Method::PUT) => preferences(&mut cx, req.body),
        ("/api/settings", &Method::POST) => settings(&mut cx, req.body, actor),
        ("/api/settings/desktop", &Method::POST) => desktop(&mut cx, req.body),
        ("/api/notification-prefs", &Method::PUT) => notification_prefs(&mut cx, req.body),
        ("/api/focus", &Method::POST) => focus(&mut cx, req.body),
        ("/api/privacy-profile", &Method::PUT) => privacy_profile(&mut cx, req.body),
        ("/api/accessibility-profile", &Method::PUT) => accessibility_profile(&mut cx, req.body),
        ("/api/feature-flags/overrides", &Method::POST) => overrides_post(&mut cx, req.body),
        ("/api/feature-flags/overrides", &Method::DELETE) => overrides_delete(&mut cx, req.query),
        ("/api/feature-flags/overrides/[key]", &Method::DELETE) => {
            override_delete_one(&mut cx, req.param.unwrap_or(""))
        }
        ("/api/dashboard/layout", &Method::PUT) => layout_put(&mut cx, req.body),
        ("/api/dashboard/layout", &Method::DELETE) => layout_delete(&mut cx),
        ("/api/dashboard/layout/preset", &Method::POST) => layout_preset(&mut cx, req.body),
        ("/api/coachmark-state", &Method::POST) => {
            boolean_state(&mut cx, req.body, "coachmark_tour_done", "completed")
        }
        ("/api/dev-menu-state", &Method::POST) => {
            boolean_state(&mut cx, req.body, "dev_menu_enabled", "enabled")
        }
        ("/api/welcomed-at", &Method::POST) => welcomed_at(&mut cx, req.body),
        ("/api/migration-flow/consume", &Method::POST) => migration_flow_consume(&mut cx),
        _ => super::library_writes::perform(&mut cx, req, actor)
            .unwrap_or_else(|| json_error(StatusCode::NOT_FOUND, "Not Found")),
    }
}

/// `perform` for every route, through the accessor: one section for a
/// handler that never fetches (the lock for exactly the handler, as
/// `perform` under the route's own guard), and the batch-3 handlers'
/// own sections around their network calls.
pub async fn perform_async(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn crate::outbound::Fetcher,
    req: WriteRequest<'_>,
    actor: &Actor,
    now: i64,
) -> Response {
    if super::runner_writes::handles(req.spec) {
        return super::runner_writes::perform(db, ids, now, fetcher, req, actor).await;
    }
    if is_async(req.spec) {
        return super::imports_writes::perform(db, ids, now, fetcher, req, actor).await;
    }
    db.with(|w| perform(w, ids, req, actor, now))
}

pub(super) struct Cx<'a, 'b> {
    pub(super) w: &'a mut Writer<'b>,
    pub(super) ids: &'a mut dyn Ids,
    pub(super) now: i64,
}

impl Cx<'_, '_> {
    pub(super) fn get(&self, key: &str, default: &str) -> String {
        get_setting_with(self.w.conn, key, default).unwrap_or_else(|_| default.to_string())
    }
    pub(super) fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        self.w
            .run(SET_SETTING, vec![json!(key), json!(value)])
            .map(drop)
    }
}

// ── JavaScript over Value ────────────────────────────────────────────

/// `body.key`, distinguishing `undefined` (`None`) from `null`. A
/// non-object body has no named properties, so every read is undefined.
pub(super) fn prop<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(key))
}

/// `!body || typeof body !== "object"`, negated: an object or an array.
pub(super) fn is_object_like(v: &Value) -> bool {
    matches!(v, Value::Object(_) | Value::Array(_))
}

/// Canonical array-index keys, which `Object.keys` lists first, ascending.
fn array_index(key: &str) -> Option<u32> {
    if key == "0" {
        return Some(0);
    }
    if key.is_empty() || key.starts_with('0') || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// `Object.entries(o)` in JavaScript's property order.
pub(super) fn js_entries(o: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indices: Vec<(u32, &String, &Value)> = Vec::new();
    let mut named: Vec<(&String, &Value)> = Vec::new();
    for (k, v) in o {
        match array_index(k) {
            Some(i) => indices.push((i, k, v)),
            None => named.push((k, v)),
        }
    }
    indices.sort_by_key(|(i, _, _)| *i);
    indices
        .into_iter()
        .map(|(_, k, v)| (k, v))
        .chain(named)
        .collect()
}

/// `Object.keys(v)` for any value: a string lists its indices, an array
/// its indices, an object its property order, and everything else nothing.
fn js_object_keys(v: &Value) -> Vec<String> {
    match v {
        Value::Object(o) => js_entries(o).into_iter().map(|(k, _)| k.clone()).collect(),
        Value::Array(a) => (0..a.len()).map(|i| i.to_string()).collect(),
        Value::String(s) => (0..js_length(s)).map(|i| i.to_string()).collect(),
        _ => vec![],
    }
}

/// `String(v ?? fallback)`.
pub(super) fn string_or(v: &Value, fallback: &str) -> String {
    if v.is_null() {
        fallback.to_string()
    } else {
        js_string(v)
    }
}

pub(super) fn internal_error() -> Response {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// The body read's outcome as the route phrases it: `invalid` for both the
/// empty and the unparseable body (they share a catch), the 413 and 408
/// shared.
pub(super) fn body_json(outcome: BodyOutcome, invalid: &str) -> Result<Value, Response> {
    if let Some(response) = body_error_response(&outcome) {
        return Err(response);
    }
    match outcome {
        BodyOutcome::Json(v) => Ok(v),
        _ => Err(json_error(StatusCode::BAD_REQUEST, invalid)),
    }
}

// ── /api/date-format ─────────────────────────────────────────────────

fn date_format(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON body.") {
        Ok(v) => v,
        Err(r) => return r,
    };
    // `body.mode` on a null body throws.
    if body.is_null() {
        return internal_error();
    }
    let mode = prop(&body, "mode").and_then(Value::as_str).unwrap_or("");
    let safe = normalise_date_format(mode);
    if cx.set("date_format", safe).is_err() {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not save the date-format preference.",
        );
    }
    json_ok(&json!({ "mode": safe }))
}

// ── /api/locale ──────────────────────────────────────────────────────

fn locale(body: BodyOutcome, now: i64) -> Response {
    let body = match body_json(body, "Invalid JSON body") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let requested = prop(&body, "locale").and_then(Value::as_str);
    if !is_supported_locale(requested) {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({
                "accepted": false,
                "locale": "en",
                "supported": SUPPORTED_LOCALES,
                "error": "locale must be one of: en, zh",
            }),
        );
    }
    let requested = requested.unwrap_or("en");
    let mut response = json_ok(&json!({
        "accepted": true,
        "locale": requested,
        "supported": SUPPORTED_LOCALES,
    }));
    // Next serialises the 365-day cookie with both Expires and Max-Age.
    let cookie = format!(
        "NEXT_LOCALE={requested}; Path=/; Expires={}; Max-Age=31536000; SameSite=lax",
        js_utc_string(now + 365 * 24 * 60 * 60 * 1000)
    );
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

// ── /api/preferences ─────────────────────────────────────────────────

fn preferences(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON body") {
        Ok(v) => v,
        Err(r) => return r,
    };
    // `body && Object.hasOwn(body, …)`: only an object can own the key.
    if let Some(value) = body
        .as_object()
        .and_then(|o| o.get("dismissManualAppsBanner"))
    {
        if !(value.is_boolean() || value.is_null()) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "dismissManualAppsBanner must be a boolean or null",
            );
        }
        let dismissed = *value == Value::Bool(true);
        let stamp = if dismissed {
            cx.now.to_string()
        } else {
            String::new()
        };
        if cx.set("manual_apps_banner_dismissed_at", &stamp).is_err() {
            return internal_error();
        }
    }
    let raw = cx.get("manual_apps_banner_dismissed_at", "");
    json_ok(&json!({ "manualAppsBannerDismissed": !js_trim(&raw).is_empty() }))
}

// ── /api/settings ────────────────────────────────────────────────────

/// `isMaskedWebhookRoundTrip`.
fn is_masked_webhook_round_trip(raw: &str, stored: &str) -> bool {
    if raw == MASKED_SECRET_VALUE {
        return true;
    }
    if stored.is_empty() {
        return false;
    }
    raw == mask_webhook_url(stored) || raw == "configured"
}

fn quiet_hours_ok(raw: &str) -> bool {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^([01][0-9]|2[0-3]):[0-5][0-9]$").expect("static regex"))
        .is_match(raw)
}

/// `String(Math.floor(n))` for a finite number.
fn floored(n: f64) -> String {
    js_number_spelling(n.floor())
}

fn settings(cx: &mut Cx, body: BodyOutcome, actor: &Actor) -> Response {
    let body = match body {
        BodyOutcome::Json(v) => v,
        BodyOutcome::Empty => return json_error(StatusCode::BAD_REQUEST, "Request body is empty"),
        BodyOutcome::Invalid => return json_error(StatusCode::BAD_REQUEST, "Invalid JSON body"),
        other => return body_error_response(&other).unwrap_or_else(internal_error),
    };
    if body.is_null() {
        return internal_error();
    }
    let bad = |message: &str| json_error(StatusCode::BAD_REQUEST, message);
    // Every `setSetting` failure surfaces as Next's 500; `?` on a String
    // error inside this closure is that.
    let outcome = (|| -> Result<Result<(), Response>, String> {
        macro_rules! refuse {
            ($msg:expr) => {
                return Ok(Err(bad($msg)))
            };
        }
        if let Some(v) = prop(&body, "sync_schedule") {
            let Some(s) = v
                .as_str()
                .filter(|s| ["manual", "daily", "weekly"].contains(s))
            else {
                refuse!("Invalid schedule");
            };
            cx.set("sync_schedule", s)?;
        }
        if let Some(v) = prop(&body, "app_country") {
            cx.set("app_country", &normalize_country(v.as_str()))?;
        }
        if let Some(v) = prop(&body, "ai_provider") {
            let Some(s) = v.as_str().filter(|s| AI_PROVIDERS.contains(s)) else {
                refuse!("Invalid AI provider");
            };
            let provider = normalize_ai_provider(s);
            let previous = normalize_ai_provider(&cx.get("ai_provider", "disabled"));
            cx.set("ai_provider", provider)?;
            if provider != previous {
                cx.set("ai_api_key", "")?;
            }
        }
        if let Some(v) = prop(&body, "ai_api_key") {
            let raw = string_or(v, "");
            if raw != MASKED_SECRET_VALUE {
                if js_length(&raw) > 512 {
                    refuse!("API key too long");
                }
                cx.set("ai_api_key", js_trim(&raw))?;
            }
        }
        if let Some(v) = prop(&body, "ai_base_url") {
            let raw = js_trim(&string_or(v, "")).to_string();
            if raw.is_empty() {
                cx.set("ai_base_url", "")?;
            } else {
                match outbound::validate_with(&raw, &[], 512, true) {
                    Err(e) => refuse!(&format!("Invalid ai_base_url: {}", e.detail)),
                    Ok(url) => cx.set("ai_base_url", url.as_str())?,
                }
            }
        }
        if let Some(v) = prop(&body, "ai_model") {
            let raw = js_trim(&string_or(v, "")).to_string();
            if js_length(&raw) > 200 {
                refuse!("ai_model too long");
            }
            cx.set("ai_model", &raw)?;
        }
        for key in ["ai_summarize_on_import", "ai_debug_logging"] {
            if let Some(v) = prop(&body, key) {
                cx.set(key, if truthy(v) { "true" } else { "false" })?;
            }
        }
        for phase in AI_TIMEOUT_PHASES {
            let key = format!("ai_timeout_{phase}_ms");
            let Some(v) = prop(&body, &key) else { continue };
            if v.is_null() || v.as_str() == Some("") {
                cx.set(&key, "")?;
                continue;
            }
            let parsed = js_to_number(v);
            if !parsed.is_finite() || !(AI_TIMEOUT_MIN_MS..=AI_TIMEOUT_MAX_MS).contains(&parsed) {
                refuse!(&format!(
                    "{key} must be between {} and {} ms",
                    AI_TIMEOUT_MIN_MS as i64, AI_TIMEOUT_MAX_MS as i64
                ));
            }
            cx.set(&key, &floored(parsed))?;
        }
        if let Some(v) = prop(&body, "policy_diff_alert_days") {
            let raw = js_to_number(v);
            if !raw.is_finite() || !(0.0..=3650.0).contains(&raw) {
                refuse!("policy_diff_alert_days must be 0–3650");
            }
            cx.set("policy_diff_alert_days", &floored(raw))?;
        }
        for key in [
            "policy_scrape_throttle_enabled",
            "policy_scrape_disabled",
            "wayback_show_imported",
            "track_accessibility_labels",
            "queue_show_progress_bar",
        ] {
            if let Some(v) = prop(&body, key) {
                cx.set(key, if truthy(v) { "true" } else { "false" })?;
            }
        }
        if let Some(v) = prop(&body, "cfgutil_imported_at") {
            if v.is_null() || v.as_str() == Some("") {
                cx.set("cfgutil_imported_at", "")?;
            } else {
                let parsed = js_to_number(v);
                if !parsed.is_finite() || parsed < 0.0 || parsed > (cx.now + 60_000) as f64 {
                    refuse!("cfgutil_imported_at must be a recent epoch ms timestamp or empty");
                }
                cx.set("cfgutil_imported_at", &floored(parsed))?;
            }
        }
        if let Some(v) = prop(&body, "policy_scrape_throttle_minutes") {
            let raw = js_to_number(v);
            if !raw.is_finite() || !(0.0..=10_080.0).contains(&raw) {
                refuse!("policy_scrape_throttle_minutes must be 0–10080");
            }
            cx.set("policy_scrape_throttle_minutes", &floored(raw))?;
        }
        if let Some(v) = prop(&body, "notification_webhook_url") {
            let raw = js_trim(&string_or(v, "")).to_string();
            let stored = cx.get("notification_webhook_url", "");
            if is_masked_webhook_round_trip(&raw, &stored) {
                // A masked value came back untouched: keep the real URL.
            } else if raw.is_empty() {
                cx.set("notification_webhook_url", "")?;
            } else {
                match outbound::validate_with(&raw, &[], 512, false) {
                    Err(e) => refuse!(&format!("Invalid notification_webhook_url: {}", e.detail)),
                    Ok(url) => cx.set("notification_webhook_url", url.as_str())?,
                }
            }
        }
        if let Some(v) = prop(&body, "notification_webhook_format") {
            let raw = string_or(v, "generic");
            if !WEBHOOK_FORMATS.contains(&raw.as_str()) {
                refuse!(
                    "notification_webhook_format must be one of: slack, discord, teams, generic"
                );
            }
            cx.set("notification_webhook_format", &raw)?;
        }
        if let Some(v) = prop(&body, "notification_webhook_frequency") {
            let raw = string_or(v, "immediate");
            if !WEBHOOK_FREQUENCIES.contains(&raw.as_str()) {
                refuse!("notification_webhook_frequency must be one of: immediate, daily_summary, weekly_summary, off");
            }
            cx.set("notification_webhook_frequency", &raw)?;
        }
        for key in [
            "notification_quiet_hours_start",
            "notification_quiet_hours_end",
        ] {
            if let Some(v) = prop(&body, key) {
                let raw = js_trim(&string_or(v, "")).to_string();
                if !raw.is_empty() && !quiet_hours_ok(&raw) {
                    refuse!(&format!("{key} must be HH:MM or empty"));
                }
                cx.set(key, &raw)?;
            }
        }
        for key in [
            "background_wizard_completed_at",
            "background_wizard_dismissed_at",
        ] {
            if let Some(v) = prop(&body, key) {
                if v.is_null() || v.as_str() == Some("") {
                    cx.set(key, "")?;
                } else {
                    let parsed = js_to_number(v);
                    if !parsed.is_finite() || parsed < 0.0 {
                        refuse!(&format!("{key} must be an epoch ms timestamp or empty"));
                    }
                    cx.set(key, &floored(parsed))?;
                }
            }
        }
        Ok(Ok(()))
    })();
    match outcome {
        Err(_) => internal_error(),
        Ok(Err(refused)) => refused,
        Ok(Ok(())) => {
            let detail = js_object_keys(&body).join(",");
            record_audit(
                cx.w,
                cx.ids,
                cx.now,
                "settings.write.success",
                actor,
                Some(&detail),
                true,
            );
            json_ok(&json!({ "success": true }))
        }
    }
}

// ── /api/settings/desktop ────────────────────────────────────────────

/// `writeSetting(key, value)`: each key's own coercion, silently skipping
/// a value it will not store.
fn desktop_write(cx: &mut Cx, key: &str, stored: &str, value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    match key {
        "auto_lock_idle_minutes" => {
            let n = match value {
                Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                other => js_parse_int(&js_string(other)).map_or(f64::NAN, |n| n as f64),
            };
            if !n.is_finite() || !(0.0..=1440.0).contains(&n) {
                return Ok(());
            }
            cx.set(stored, &floored(n))
        }
        "global_shortcut" => {
            let Some(s) = value.as_str() else {
                return Ok(());
            };
            let len = js_length(s);
            if len == 0 || len > 64 {
                return Ok(());
            }
            cx.set(stored, s)
        }
        "theme_override" => match value.as_str() {
            Some(s @ ("system" | "light" | "dark")) => cx.set(stored, s),
            _ => Ok(()),
        },
        "zoom_level" => {
            let z = match value {
                Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                other => js_parse_float(&js_string(other)),
            };
            if !z.is_finite() || !(0.5..=3.0).contains(&z) {
                return Ok(());
            }
            cx.set(stored, &js_number_spelling(z))
        }
        _ => cx.set(stored, if truthy(value) { "true" } else { "false" }),
    }
}

fn desktop(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "invalid json") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return json_error(StatusCode::BAD_REQUEST, "expected object body");
    }
    // `key in obj` on an array is false for every named key.
    let obj = body.as_object();
    for (key, stored) in DESKTOP_KEYS {
        let Some(obj) = obj else { break };
        if let Some(v) = obj.get(key) {
            if desktop_write(cx, key, stored, v).is_err() {
                return internal_error();
            }
        }
        if let Some(v) = obj.get(stored) {
            if desktop_write(cx, key, stored, v).is_err() {
                return internal_error();
            }
        }
    }
    match read_desktop(cx.w.conn) {
        Ok(bundle) => json_ok(&bundle),
        Err(_) => internal_error(),
    }
}

// ── feature-flag overrides (shared by three routes) ──────────────────

/// `JSON.stringify(getActiveFocus())`: the goals Set stringifies to `{}`.
fn active_focus_json(cx: &Cx) -> String {
    let audience_raw = cx.get("flag.focus.audience", "");
    let audience = if audience_raw.is_empty() {
        "self".to_string()
    } else {
        audience_raw
    };
    let ai_provider = cx.get("ai_provider", "");
    json!({
        "audience": audience,
        "goals": {},
        "aiConfigured": !ai_provider.is_empty() && ai_provider != "disabled",
    })
    .to_string()
}

fn set_override(cx: &mut Cx, key: &str, value: &str) -> Result<(), String> {
    let previous_focus = active_focus_json(cx);
    cx.w.run(
        SET_OVERRIDE,
        vec![
            json!(key),
            json!(value),
            json!(cx.now),
            json!(previous_focus),
        ],
    )
    .map(drop)
}

fn clear_override(cx: &mut Cx, key: &str) -> Result<(), String> {
    cx.w.run(CLEAR_OVERRIDE, vec![json!(key)]).map(drop)
}

fn known_flag(key: &str) -> bool {
    super::flags::rules().knows(key)
}

// ── /api/notification-prefs ──────────────────────────────────────────

/// `sanitizePrefs` / `parseStoredPrefs`' filter: known legacy keys with
/// boolean values, in property order.
fn sanitize_prefs(input: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Value::Object(o) = input {
        for (k, v) in js_entries(o) {
            if NOTIFICATION_TYPE_KEYS.contains(&k.as_str()) && v.is_boolean() {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

/// `readResolvedPrefs`: the four flags through the resolver, or the
/// legacy blob when the resolver throws.
fn resolved_prefs(cx: &Cx) -> Value {
    let resolved = context_from_db(cx.w.conn).ok().and_then(|ctx| {
        let mut out = Map::new();
        for (kind, flag) in NOTIFICATION_FLAGS {
            out.insert(
                kind.to_string(),
                json!(resolve_flag(flag, &ctx).ok()? == "on"),
            );
        }
        Some(Value::Object(out))
    });
    resolved.unwrap_or_else(|| {
        let raw = cx.get("notification_prefs", "");
        let parsed = if raw.is_empty() {
            Value::Null
        } else {
            serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)
        };
        Value::Object(sanitize_prefs(&parsed))
    })
}

fn prefs_response(cx: &Cx) -> Response {
    let prefs = resolved_prefs(cx);
    let mut defaults = Map::new();
    for key in NOTIFICATION_TYPE_KEYS {
        defaults.insert(key.to_string(), json!(true));
    }
    json_ok(&json!({ "prefs": prefs, "stored": prefs, "defaults": defaults }))
}

fn notification_prefs(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON body") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return json_error(StatusCode::BAD_REQUEST, "Body must be an object");
    }
    let Some(raw) = prop(&body, "prefs") else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Missing `prefs` key. Pass null to clear, or an object of booleans to save.",
        );
    };
    let outcome = (|| -> Result<(), String> {
        if raw.is_null() {
            cx.set("notification_prefs", "")?;
            for (_, flag) in NOTIFICATION_FLAGS {
                clear_override(cx, flag)?;
            }
            return Ok(());
        }
        let clean = sanitize_prefs(raw);
        for (kind, flag) in NOTIFICATION_FLAGS {
            match raw.as_object().and_then(|o| o.get(kind)) {
                Some(Value::Bool(true)) => set_override(cx, flag, "on")?,
                Some(Value::Bool(false)) => set_override(cx, flag, "off")?,
                _ => clear_override(cx, flag)?,
            }
        }
        cx.set("notification_prefs", &Value::Object(clean).to_string())
    })();
    match outcome {
        Ok(()) => prefs_response(cx),
        Err(_) => internal_error(),
    }
}

// ── /api/focus ───────────────────────────────────────────────────────

fn focus(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if body.is_null() {
        return internal_error();
    }
    let bad = |message: &str| json_error(StatusCode::BAD_REQUEST, message);
    let Some(audience) = prop(&body, "audience")
        .and_then(Value::as_str)
        .filter(|a| AUDIENCES.contains(a))
    else {
        return bad("audience must be one of: self, loved_one, guardian");
    };
    let flag = |key: &str| prop(&body, key).is_some_and(truthy);
    let mut monitor = flag("monitor");
    let mut cleanup = flag("cleanup");
    let minimal = flag("minimal");
    let accessibility = flag("accessibility");
    let workflow = match prop(&body, "workflow") {
        None => None,
        Some(v) => match v.as_str().filter(|w| FOCUS_WORKFLOWS.contains(w)) {
            Some(w) => Some(w),
            None => {
                return bad("workflow must be one of: self_monitor, self_cleanup, other_handoff, other_monitor, custom")
            }
        },
    };
    if minimal {
        monitor = false;
        cleanup = false;
    }
    let final_workflow =
        workflow.unwrap_or_else(|| infer_focus_workflow(audience, monitor, cleanup, minimal));
    let child_age_band = prop(&body, "childAgeBand");
    if let Some(band) = child_age_band {
        let explicit_clear = band.is_null() || band.as_str() == Some("");
        if !explicit_clear && !band.as_str().is_some_and(|b| AGE_BAND_KEYS.contains(&b)) {
            return bad("childAgeBand must be a known age band key");
        }
    }
    let written = (|| -> Result<(), String> {
        let tx =
            cx.w.conn
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
        cx.w.mark("BEGIN");
        let body = (|| -> Result<(), String> {
            cx.set("flag.focus.audience", audience)?;
            cx.set("flag.focus.goal.monitor", &monitor.to_string())?;
            cx.set("flag.focus.goal.cleanup", &cleanup.to_string())?;
            cx.set("flag.focus.goal.minimal", &minimal.to_string())?;
            cx.set("flag.focus.goal.accessibility", &accessibility.to_string())?;
            cx.set("flag.focus.workflow", final_workflow)?;
            cx.set("flag.focus.updated_at", &cx.now.to_string())
        })();
        match body {
            Ok(()) => {
                cx.w.mark("COMMIT");
                tx.commit().map_err(|e| e.to_string())?;
            }
            Err(e) => {
                cx.w.mark("ROLLBACK");
                drop(tx);
                return Err(e);
            }
        }
        if let Some(band) = child_age_band {
            // `childAgeBand ?? ""`: null clears; a string is stored as is.
            cx.set("guardian_child_age_band", band.as_str().unwrap_or(""))?;
        }
        Ok(())
    })();
    if written.is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to save focus");
    }
    let stored_band = cx.get("guardian_child_age_band", "");
    json_ok(&json!({
        "audience": audience,
        "monitor": monitor,
        "cleanup": cleanup,
        "minimal": minimal,
        "accessibility": accessibility,
        "workflow": final_workflow,
        "childAgeBand": if stored_band.is_empty() { Value::Null } else { json!(stored_band) },
    }))
}

// ── /api/privacy-profile and /api/accessibility-profile ──────────────

/// `sanitizeProfile` / `sanitizeA11yProfile`: known keys with allowed
/// string values, in property order; anything but a plain object is `{}`.
fn sanitize_profile(input: &Value, keys: &[&str], values: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    if let Value::Object(o) = input {
        for (k, v) in js_entries(o) {
            if keys.contains(&k.as_str()) && v.as_str().is_some_and(|s| values.contains(&s)) {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

/// `matchPreset`: a complete profile equal to one of the four presets.
fn match_profile_preset(profile: Option<&Map<String, Value>>) -> Option<&'static str> {
    let profile = profile?;
    let complete = profile.values().filter(|v| v.is_string()).count();
    if complete != PROFILE_CATEGORY_KEYS.len() {
        return None;
    }
    PROFILE_PRESETS
        .iter()
        .find(|(_, _, tiers)| {
            PROFILE_CATEGORY_KEYS
                .iter()
                .zip(tiers.iter())
                .all(|(cat, tier)| profile.get(*cat).and_then(Value::as_str) == Some(*tier))
        })
        .map(|(key, _, _)| *key)
}

fn preset_label(key: &str) -> &'static str {
    PROFILE_PRESETS
        .iter()
        .find(|(k, _, _)| *k == key)
        .map_or("", |(_, label, _)| *label)
}

/// `describePresetTransition`: clearing, a change onto a preset, or nothing.
fn describe_preset_transition(
    old: Option<&Map<String, Value>>,
    new: Option<&Map<String, Value>>,
) -> Option<(String, Value)> {
    let has_any =
        |p: Option<&Map<String, Value>>| p.is_some_and(|m| m.values().any(Value::is_string));
    let old_any = has_any(old);
    let new_any = has_any(new);
    if old_any && !new_any {
        return Some((
            "Privacy profile cleared".to_string(),
            json!({ "from": match_profile_preset(old), "to": Value::Null, "cleared": true }),
        ));
    }
    if !new_any {
        return None;
    }
    let from = match_profile_preset(old);
    let to = match_profile_preset(new)?;
    if Some(to) == from {
        return None;
    }
    Some((
        format!("Privacy profile changed to {}", preset_label(to)),
        json!({ "from": from, "to": to }),
    ))
}

fn stored_privacy_profile(cx: &Cx) -> Option<Map<String, Value>> {
    let raw = cx.get("privacy_profile", "");
    match parse_stored_profile(&raw, &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS)? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// `saveAndLog`.
fn save_privacy_profile(cx: &mut Cx, next: Option<&Map<String, Value>>) -> Result<(), String> {
    let started_at = cx.now;
    let previous = stored_privacy_profile(cx);
    match next {
        None => cx.set("privacy_profile", "")?,
        Some(profile) => {
            let clean = sanitize_profile(
                &Value::Object(profile.clone()),
                &PROFILE_CATEGORY_KEYS,
                &PROFILE_TIERS,
            );
            cx.set("privacy_profile", &Value::Object(clean).to_string())?;
        }
    }
    if let Some((summary, detail)) = describe_preset_transition(previous.as_ref(), next) {
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "profile_preset_applied",
            "ok",
            None,
            Some(&summary),
            Some(&detail),
            started_at,
        );
    }
    Ok(())
}

fn profile_body(body: BodyOutcome) -> Result<Option<Value>, Response> {
    let body = body_json(body, "Invalid JSON body")?;
    if !is_object_like(&body) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Body must be an object",
        ));
    }
    match prop(&body, "profile") {
        None => Err(json_error(
            StatusCode::BAD_REQUEST,
            "Missing `profile` key. Pass null to clear, or an object to save.",
        )),
        Some(Value::Null) => Ok(None),
        Some(raw) => Ok(Some(raw.clone())),
    }
}

fn privacy_profile(cx: &mut Cx, body: BodyOutcome) -> Response {
    let raw = match profile_body(body) {
        Ok(raw) => raw,
        Err(r) => return r,
    };
    let Some(raw) = raw else {
        if save_privacy_profile(cx, None).is_err() {
            return internal_error();
        }
        return json_ok(&json!({ "profile": Value::Null }));
    };
    let clean = sanitize_profile(&raw, &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS);
    if save_privacy_profile(cx, Some(&clean)).is_err() {
        return internal_error();
    }
    let stored = cx.get("privacy_profile", "");
    json_ok(
        &json!({ "profile": parse_stored_profile(&stored, &PROFILE_CATEGORY_KEYS, &PROFILE_TIERS) }),
    )
}

fn accessibility_profile(cx: &mut Cx, body: BodyOutcome) -> Response {
    let raw = match profile_body(body) {
        Ok(raw) => raw,
        Err(r) => return r,
    };
    let Some(raw) = raw else {
        if cx.set("accessibility_profile", "").is_err() {
            return internal_error();
        }
        return json_ok(&json!({ "profile": Value::Null }));
    };
    let clean = sanitize_profile(&raw, &A11Y_FEATURE_KEYS, &A11Y_PREFERENCES);
    if cx
        .set("accessibility_profile", &Value::Object(clean).to_string())
        .is_err()
    {
        return internal_error();
    }
    let stored = cx.get("accessibility_profile", "");
    json_ok(
        &json!({ "profile": parse_stored_profile(&stored, &A11Y_FEATURE_KEYS, &A11Y_PREFERENCES) }),
    )
}

// ── /api/feature-flags/overrides ─────────────────────────────────────

fn overrides_post(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON") {
        Ok(v) => v,
        Err(r) => return r,
    };
    // `body.flags` on a null body throws.
    if body.is_null() {
        return internal_error();
    }
    if let Some(Value::Array(rows)) = prop(&body, "flags") {
        let mut applied = 0;
        let mut skipped = 0;
        let mut skipped_keys: Vec<String> = vec![];
        let outcome = (|| -> Result<(), String> {
            cx.w.run(CLEAR_ALL_OVERRIDES, vec![]).map(drop)?;
            for row in rows {
                let Value::Object(row) = row else {
                    skipped += 1;
                    continue;
                };
                let key = row.get("key").and_then(Value::as_str);
                match key {
                    Some(k) if known_flag(k) => {}
                    _ => {
                        skipped += 1;
                        if let Some(k) = key {
                            skipped_keys.push(k.to_string());
                        }
                        continue;
                    }
                }
                let key = key.unwrap_or_default();
                let Some(value) = row.get("override").filter(|v| !v.is_null()) else {
                    continue;
                };
                let Some(value) = value.as_str().filter(|v| FLAG_VALUES.contains(v)) else {
                    skipped += 1;
                    continue;
                };
                set_override(cx, key, value)?;
                applied += 1;
            }
            Ok(())
        })();
        if outcome.is_err() {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to import overrides",
            );
        }
        skipped_keys.truncate(20);
        return json_ok(&json!({
            "ok": true,
            "applied": applied,
            "skipped": skipped,
            "skippedKeys": skipped_keys,
        }));
    }
    // `!body.key || typeof body.key !== "string" || !(body.key in HARD_DEFAULTS)`.
    let Some(key) = prop(&body, "key")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty() && known_flag(k))
    else {
        return json_error(StatusCode::BAD_REQUEST, "unknown flag key");
    };
    // `!(body.value && VALID_VALUES.includes(body.value))`.
    let Some(value) = prop(&body, "value")
        .and_then(Value::as_str)
        .filter(|v| FLAG_VALUES.contains(v))
    else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "value must be one of: on, off, collapsed",
        );
    };
    if set_override(cx, key, value).is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to set override");
    }
    json_ok(&json!({ "ok": true, "key": key, "value": value }))
}

fn overrides_delete(cx: &mut Cx, query: &[(String, String)]) -> Response {
    let surface = query
        .iter()
        .find(|(k, _)| k == "surface")
        .map(|(_, v)| v.as_str());
    let cleared = match surface {
        Some(s) if !s.is_empty() => {
            cx.w.run(CLEAR_SURFACE_OVERRIDES, vec![json!(format!("flag.{s}.%"))])
        }
        _ => cx.w.run(CLEAR_ALL_OVERRIDES, vec![]),
    };
    if cleared.is_err() {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to clear overrides",
        );
    }
    json_ok(&json!({ "ok": true, "scope": surface.unwrap_or("all") }))
}

fn override_delete_one(cx: &mut Cx, key: &str) -> Response {
    if !known_flag(key) {
        return json_error(StatusCode::BAD_REQUEST, "unknown flag key");
    }
    if clear_override(cx, key).is_err() {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to clear override",
        );
    }
    json_ok(&json!({ "ok": true, "key": key }))
}

// ── /api/dashboard/layout and /preset ────────────────────────────────

/// `saveDashboardLayoutWithLog`.
fn save_layout_with_log(cx: &mut Cx, next: &Layout) -> Result<(), String> {
    let started_at = cx.now;
    let previous = read_layout(cx.w.conn).map_err(|e| e.to_string())?;
    cx.set(
        "dashboard.layout",
        &serde_json::to_string(next).map_err(|e| e.to_string())?,
    )?;
    let from = match_dashboard_preset(&previous);
    if let Some(to) = match_dashboard_preset(next).filter(|to| Some(*to) != from) {
        let label = LAYOUT_PRESET_LABELS
            .iter()
            .find(|(k, _)| *k == to)
            .map_or("", |(_, l)| *l);
        record_activity(
            cx.w,
            cx.ids,
            cx.now,
            "dashboard_layout_applied",
            "ok",
            None,
            Some(&format!("Dashboard layout set to {label}")),
            Some(&json!({ "from": from, "to": to })),
            started_at,
        );
    }
    Ok(())
}

fn layout_response(layout: &Layout) -> Response {
    json_ok(&json!({ "layout": layout, "matchedPreset": match_dashboard_preset(layout) }))
}

fn apply_layout_preset(cx: &mut Cx, key: &str) -> Response {
    let Some((_, layout)) = presets().into_iter().find(|(k, _)| *k == key) else {
        return internal_error();
    };
    if save_layout_with_log(cx, &layout).is_err() {
        return internal_error();
    }
    layout_response(&layout)
}

fn layout_put(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON body") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return json_error(StatusCode::BAD_REQUEST, "Body must be an object");
    }
    let Some(raw) = prop(&body, "layout").filter(|r| is_object_like(r)) else {
        return json_error(StatusCode::BAD_REQUEST, "Missing or invalid `layout` field");
    };
    let reconciled = reconcile_layout(raw);
    if save_layout_with_log(cx, &reconciled).is_err() {
        return internal_error();
    }
    layout_response(&reconciled)
}

fn layout_delete(cx: &mut Cx) -> Response {
    apply_layout_preset(cx, "default")
}

fn layout_preset(cx: &mut Cx, body: BodyOutcome) -> Response {
    let body = match body_json(body, "Invalid JSON body") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return json_error(StatusCode::BAD_REQUEST, "Body must be an object");
    }
    let Some(preset) = prop(&body, "preset")
        .and_then(Value::as_str)
        .filter(|p| LAYOUT_PRESET_LABELS.iter().any(|(k, _)| k == p))
    else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "`preset` must be one of: default, minimal, caretaker, watchdog, at_a_glance",
        );
    };
    apply_layout_preset(cx, preset)
}

// ── /api/coachmark-state and /api/dev-menu-state ─────────────────────

fn boolean_state(cx: &mut Cx, body: BodyOutcome, key: &str, field: &str) -> Response {
    let body = match body_json(body, "invalid json") {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_object_like(&body) {
        return json_error(StatusCode::BAD_REQUEST, "expected object body");
    }
    let Some(next) = prop(&body, field).and_then(Value::as_bool) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!("expected {{ {field}: boolean }}"),
        );
    };
    if cx.set(key, if next { "true" } else { "false" }).is_err() {
        return internal_error();
    }
    let stored = cx.get(key, "false") == "true";
    json_ok(&json!({ field: stored }))
}

// ── /api/welcomed-at ─────────────────────────────────────────────────

fn welcomed_at(cx: &mut Cx, body: BodyOutcome) -> Response {
    // Every body failure — including the caps — is swallowed to `false`.
    let if_unset = match body {
        BodyOutcome::Json(v) => prop(&v, "ifUnset") == Some(&Value::Bool(true)),
        _ => false,
    };
    let now = cx.now;
    let written = if if_unset {
        // `setSettingIfUnset`: a present, non-empty row wins.
        let existing = get_setting_with(cx.w.conn, "welcomed_at", "").unwrap_or_default();
        if existing.is_empty() {
            cx.set("welcomed_at", &now.to_string())
        } else {
            Ok(())
        }
    } else {
        cx.set("welcomed_at", &now.to_string())
    };
    if written.is_err() {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to mark onboarding complete",
        );
    }
    json_ok(&json!({ "welcomedAt": now, "ifUnset": if_unset }))
}

// ── /api/migration-flow/consume ──────────────────────────────────────

fn migration_flow_consume(cx: &mut Cx) -> Response {
    let pending = json!({ "pending": false });
    let raw = cx.get("migration_flow_pending", "");
    if raw.is_empty() {
        return json_ok(&pending);
    }
    let parsed = match serde_json::from_str::<Value>(&raw) {
        Ok(v) => v,
        Err(_) => {
            // Corrupt: cleared and reported as nothing pending.
            let _ = cx.set("migration_flow_pending", "");
            return json_ok(&pending);
        }
    };
    // Always cleared after the read; the marker is one-shot.
    let _ = cx.set("migration_flow_pending", "");
    let target = prop(&parsed, "targetPath")
        .and_then(Value::as_str)
        .filter(|p| p.starts_with('/'))
        .unwrap_or("/dashboard/review-recommendations");
    let recommender = prop(&parsed, "recommenderName")
        .and_then(Value::as_str)
        .map_or(Value::Null, |s| json!(s));
    json_ok(&json!({ "targetPath": target, "recommenderName": recommender }))
}

#[cfg(test)]
mod tests {
    use super::{array_index, js_entries, js_object_keys, match_profile_preset};
    use serde_json::json;

    #[test]
    fn object_keys_follow_javascript_property_order() {
        // From node -e: integer-like keys first, ascending, then insertion order.
        let v = json!({"b": 1, "2": 1, "a": 1, "1": 1, "01": 1});
        assert_eq!(js_object_keys(&v), ["1", "2", "b", "a", "01"]);
        assert_eq!(js_object_keys(&json!("ab")), ["0", "1"]);
        assert_eq!(js_object_keys(&json!([7])), ["0"]);
        assert!(js_object_keys(&json!(5)).is_empty());
        assert_eq!(array_index("4294967295"), None);
        assert_eq!(array_index("4294967294"), Some(4_294_967_294));
        let o = json!({"z": 1, "0": 2});
        let entries = js_entries(o.as_object().unwrap());
        assert_eq!(entries[0].0, "0");
    }

    #[test]
    fn preset_matching_needs_all_fourteen_categories() {
        let strict = json!({
            "CONTACT_INFO": "not_linked", "HEALTH_AND_FITNESS": "not_collected",
            "FINANCIAL_INFO": "not_linked", "LOCATION": "not_collected",
            "SENSITIVE_INFO": "not_collected", "CONTACTS": "not_collected",
            "USER_CONTENT": "not_linked", "BROWSING_HISTORY": "not_collected",
            "SEARCH_HISTORY": "not_linked", "IDENTIFIERS": "not_linked",
            "PURCHASES": "not_linked", "USAGE_DATA": "not_linked",
            "DIAGNOSTICS": "not_linked", "OTHER": "not_collected"
        });
        assert_eq!(match_profile_preset(strict.as_object()), Some("strict"));
        let mut partial = strict.as_object().unwrap().clone();
        partial.remove("OTHER");
        assert_eq!(match_profile_preset(Some(&partial)), None);
        assert_eq!(match_profile_preset(None), None);
    }
}

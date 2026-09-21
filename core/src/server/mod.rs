//! The read-only HTTP API — Phase 2 of the Rust core.
//!
//! Replaces `next start` for the routes it implements. HTTP stays the only
//! data interface (see `core/README.md`), so the same static frontend bundle
//! can be served by either backend and the parity harness can point at both.
//!
//! **Connection model.** Node uses ONE synchronous `better-sqlite3` singleton
//! and every route call is synchronous. That is reproduced here as a single
//! `Mutex<Connection>`, not a pool — deliberately. A pool would give each
//! connection its own WAL read snapshot, so two queries inside one handler
//! could observe different database states, which the Node server is
//! structurally incapable of doing. Matching the weaker model is the point.

mod activity_log;
mod analysis;
mod apps;
mod audit_bundle;
pub mod auth;
pub(crate) mod backup;
mod backup_snapshots;
#[cfg(test)]
mod backup_tests;
mod backup_writes;
mod body;
mod bundle_writes;
#[cfg(test)]
mod bundles_tests;
mod changelog;
#[cfg(test)]
mod content_tests;
mod csp_policy;
mod csp_reports;
mod deployment;
mod device_writes;
#[cfg(test)]
mod device_writes_tests;
#[cfg(test)]
mod devices_tests;
pub(crate) mod diag;
mod diagnostics;
pub mod diff;
#[cfg(test)]
mod discovery_tests;
mod export;
mod favicon;
mod flag_migration;
#[cfg(test)]
mod flag_migration_tests;
pub mod flags;
mod forwarded;
mod frontdoor;
mod gate;
pub(crate) mod grid_meta;
mod guard;
mod health_check;
mod histogram;
#[cfg(test)]
mod imports_tests;
mod imports_writes;
mod json;
pub mod layout;
#[cfg(test)]
mod leftovers_tests;
#[cfg(test)]
mod library_tests;
mod library_writes;
pub(crate) mod lifecycle;
#[cfg(test)]
mod maintenance_tests;
mod maintenance_writes;
mod multipart;
mod nexthttp;
mod operations;
#[cfg(test)]
mod operations_tests;
mod osinfo;
mod policy;
mod policy_ai;
mod policy_runner;
#[cfg(test)]
mod policy_runner_tests;
mod policy_store;
#[cfg(test)]
mod policy_store_tests;
mod policy_summary;
#[cfg(test)]
mod policy_summary_tests;
pub(crate) mod policy_triggers;
#[cfg(test)]
mod policy_triggers_tests;
mod preview;
mod ratelimit;
mod review;
mod routes;
mod routes_ai;
#[cfg(test)]
mod routes_ai_tests;
mod routes_app;
mod routes_apps;
mod routes_content;
mod routes_detail;
mod routes_devices;
mod routes_diag;
mod routes_discovery;
mod routes_focus;
mod routes_imports;
mod routes_manual;
mod routes_operations;
mod routes_policy;
mod routes_runtime;
mod routes_settings;
mod routes_stats;
mod routes_status;
mod routes_writes;
mod row;
mod runner_writes;
#[cfg(test)]
mod runners_tests;
mod runtime_diag;
mod scope;
#[cfg(test)]
mod seed_tests;
mod seed_writes;
pub(crate) mod settings;
mod shortlist;
pub mod site;
#[cfg(test)]
mod site_tests;
mod stats;
#[cfg(test)]
mod stats_tests;
mod sync_runner;
mod sysproc;
mod timing;
mod trend;
pub mod trust;
mod unread_count;
mod update_check;
mod user_content;
mod user_tasks;
mod wayback_runner;
#[cfg(test)]
mod wayback_runner_tests;
pub mod webhook;
pub(crate) mod webhook_writes;
mod writes;
#[cfg(test)]
mod writes_tests;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    routing::{delete, get, patch, post},
    Router,
};
use rusqlite::Connection;

use crate::scrape::persist::Locked;
pub use lifecycle::{serve_with, ServeConfig, ServerHandle};

/// Wall-clock milliseconds since the epoch — `Date.now()`.
///
/// Shared so the routes that need it cannot drift into two different
/// clocks; a saturating 0 on a pre-epoch system clock matches nothing in
/// particular, but neither does any other answer.
pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct AppState {
    pub conn: Arc<Mutex<Connection>>,
    /// The inbound request limiter. Per-process and in-memory, exactly as in
    /// Node — a restart forgets the window there too.
    pub rate_limiter: Arc<ratelimit::RateLimiter>,
    /// `process.uptime()`'s origin.
    pub started_at: Instant,
    /// The port the listener actually bound — `next start` puts it in
    /// `x-forwarded-port` on every request (see `forwarded.rs`).
    pub bound_port: u16,
}

impl AppState {
    /// Acquire the single connection, timing the wait. Every handler goes
    /// through here rather than `conn.lock()` directly so the wait is
    /// observed: with one connection behind one mutex, this is the
    /// server's contention signal (`sqlite.lockWait` in the diagnostics).
    pub fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        let started = Instant::now();
        let guard = lifecycle::lock_db(&self.conn);
        diag::record_lock_wait(started.elapsed());
        guard
    }

    /// The same connection for a handler that fetches: one lock per
    /// section, each wait observed exactly as [`AppState::db`] observes it,
    /// and nothing held across an await.
    pub(crate) fn db_access(&self) -> Locked<'_> {
        Locked {
            conn: &self.conn,
            log: None,
            on_wait: Some(diag::record_lock_wait),
        }
    }
}

/// Where the database lives: `lib/db.ts`'s `dataDir` / `dbPath`, plus the
/// `dataDirSource` label the deployment diagnostics report.
pub struct DataLayout {
    /// `PRIVACYTRACKER_DATA_DIR` resolved the way `path.resolve` does
    /// (absolute, dots folded, symlinks kept), else `<cwd>/data`.
    pub data_dir: PathBuf,
    /// `<data_dir>/privacy.db` — the filename is fixed, as in Node.
    pub db_path: PathBuf,
    /// `"env"` or `"cwd"`. Node's third value, `"memory"`, is its build-phase
    /// case and has no counterpart here.
    pub source: &'static str,
}

/// Resolve the data directory exactly as `lib/db.ts` does:
/// `PRIVACYTRACKER_DATA_DIR` when set (honoured unconditionally — the Tauri
/// shell injects it), else `<cwd>/data`.
fn resolve_data_dir() -> (PathBuf, &'static str) {
    match crate::host_env::var("PRIVACYTRACKER_DATA_DIR") {
        Ok(v) if !v.is_empty() => (deployment::resolve_path(Path::new(&v)), "env"),
        // Node cannot boot with an unreadable cwd (`process.cwd()` throws at
        // module load); fall back to the root, as `resolve_path` does, so
        // the reported path is at least absolute.
        _ => (
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("/"))
                .join("data"),
            "cwd",
        ),
    }
}

static DATA_LAYOUT: OnceLock<DataLayout> = OnceLock::new();

/// The process's data layout, resolved once on first use — the shape
/// `lib/db.ts` has, where `dataDir` and `dbPath` are module-scope constants
/// evaluated from the environment when the module loads.
///
/// Deliberately NOT a field of `AppState`. It is process configuration,
/// not request state; and CodeQL's Rust model treats every axum extractor
/// argument — `State<AppState>` included — as user-provided input, so a
/// data directory that reached `fs::metadata` or `read_dir` through
/// `State` was reported as path injection on each of the four deployment
/// reads that stat the database or its directory. Kept out of the
/// request's reach, there is no flow to report and nothing to suppress.
///
/// Resolved ONCE per process, like the module-scope constant it mirrors.
/// A test that needs a different directory must set
/// `PRIVACYTRACKER_DATA_DIR` before the first call; the static is never
/// re-read, and the unit-test binary is one process.
pub fn data_layout() -> &'static DataLayout {
    DATA_LAYOUT.get_or_init(|| {
        let (data_dir, source) = resolve_data_dir();
        DataLayout {
            db_path: data_dir.join("privacy.db"),
            data_dir,
            source,
        }
    })
}

/// Build the router. Split out from `serve` so tests can exercise routes
/// without binding a port.
///
/// The deployment reads report [`data_layout`], not the file behind
/// `state.conn`: a caller that opens a temporary database and passes it
/// here gets `/api/diagnostics/database` describing the configured data
/// directory instead. `serve_with` is the one constructor of `AppState` and
/// keeps the two aligned.
pub fn app(state: AppState) -> Router {
    front_door(layered(routes(), state))
}

/// Every route, before the layers.
fn routes() -> Router<AppState> {
    Router::new()
        // Batch 1. Each of these is a GET the client shell fetches on first
        // paint, a container/auth probe, or both.
        .route("/api/health", get(routes::health))
        // Final Phase 2 reads: public network access without persistence.
        .route("/api/compare", get(routes_discovery::compare))
        .route("/api/related-apps", get(routes_discovery::related))
        // Phase 4, batch 6: the outbound leftovers — a transient App Store
        // preview, the favicon proxy, the update check, and the webhook
        // test the wizard fires at a URL it has not saved yet.
        .route("/api/preview", get(routes_discovery::preview_route))
        .route("/api/favicon", get(favicon::favicon))
        .route("/api/update-status", get(update_check::update_status))
        .route(
            "/api/notifications/webhook-test",
            post(routes_writes::notifications_webhook_test_post),
        )
        // Operational reads project durable job state without starting or
        // healing jobs; exports stay whole-install and CSP remains a GET.
        .route("/api/tasks/active", get(routes_operations::tasks))
        .route(
            "/api/wayback/import-all",
            get(routes_operations::wayback)
                .post(routes_writes::wayback_import_all_post)
                .patch(routes_writes::wayback_import_all_patch)
                .delete(routes_writes::wayback_import_all_delete),
        )
        .route(
            "/api/policy/sync-all",
            get(routes_operations::policy).post(routes_writes::policy_sync_all_post),
        )
        // Phase 4, batch 5b: the backup routes. The export is a GET that
        // guards itself and writes an audit row, so it runs through the
        // write framework; the download reads one file and nothing else.
        .route(
            "/api/backup/snapshots",
            get(routes_operations::backups)
                .put(routes_writes::backup_snapshots_put)
                .post(routes_writes::backup_snapshots_post),
        )
        .route(
            "/api/backup/snapshots/{filename}",
            get(routes_operations::backup_snapshot_download),
        )
        .route("/api/backup/export", get(routes_writes::backup_export_get))
        .route(
            "/api/backup/preview",
            post(routes_writes::backup_preview_post),
        )
        .route(
            "/api/backup/restore",
            post(routes_writes::backup_restore_post),
        )
        // Phase 4, batch 5c: the audit bundle out and in, and the two
        // support bundles, which are reads over snapshots served above.
        .route(
            "/api/export/audit-bundle",
            post(routes_writes::export_audit_bundle_post),
        )
        .route(
            "/api/import/audit-bundle",
            post(routes_writes::import_audit_bundle_post),
        )
        .route(
            "/api/diagnostics/bundle",
            get(routes_operations::diagnostics_bundle),
        )
        .route(
            "/api/deployment/support-bundle",
            get(routes_operations::support_bundle),
        )
        // Phase 4, batch 5d: the dev seed — the canned demo set, or a
        // live walk of the top-free chart.
        .route(
            "/api/dev/seed-sample-data",
            post(routes_writes::seed_sample_data_post),
        )
        .route(
            "/api/rate-limit/status",
            get(routes_operations::cooldowns).delete(routes_writes::rate_limit_status_delete),
        )
        // Phase 4, batch 4a: the sync runner's routes.
        .route("/api/sync/trigger", post(routes_writes::sync_trigger_post))
        .route(
            "/api/dev/sync-stop",
            post(routes_writes::dev_sync_stop_post),
        )
        // Phase 4, batch 5a: the maintenance writes.
        .route(
            "/api/auth/admin-token/login",
            post(routes_writes::admin_token_login_post),
        )
        .route(
            "/api/auth/admin-token/logout",
            post(routes_writes::admin_token_logout_post),
        )
        .route(
            "/api/dev/reset-changelog",
            post(routes_writes::dev_reset_changelog_post),
        )
        .route(
            "/api/dev/seed-notification",
            post(routes_writes::dev_seed_notification_post),
        )
        .route(
            "/api/dev/wipe-apps",
            post(routes_writes::dev_wipe_apps_post),
        )
        .route("/api/reset", post(routes_writes::reset_post))
        .route(
            "/api/admin/start-over",
            post(routes_writes::admin_start_over_post),
        )
        .route(
            "/api/ai/debug-log",
            get(routes_operations::ai_debug).delete(routes_writes::ai_debug_log_delete),
        )
        .route(
            "/api/csp-report",
            get(routes_operations::csp).post(routes_writes::csp_report_post),
        )
        .route("/api/export", get(routes_operations::export))
        .route(
            "/api/manual-apps/{id}",
            get(routes_operations::manual)
                .put(routes_writes::manual_put)
                .delete(routes_writes::manual_delete),
        )
        // Fleet analysis: scoped summaries, UTC buckets and entry-level filters.
        .route("/api/stats", get(routes_stats::summary))
        .route("/api/stats/matrix", get(routes_stats::matrix))
        .route("/api/stats/radar", get(routes_stats::radar))
        .route("/api/stats/timeline", get(routes_stats::timeline))
        .route("/api/triage", get(routes_stats::triage))
        .route("/api/review-queue", get(routes_stats::review_queue))
        .route("/api/age-rating/summary", get(routes_stats::age_summary))
        .route(
            "/api/privacy-profile/mismatches",
            get(routes_stats::mismatches),
        )
        .route("/api/changelog", get(routes_stats::changelog))
        // Stored device reads: ownership, exact ECID lookup, import history
        // and app links. cfgutil itself runs in the Tauri shell; the device
        // actions below record what it did and gate what it may do next.
        .route(
            "/api/devices",
            get(routes_devices::devices).post(routes_writes::devices_post),
        )
        .route(
            "/api/device-scope",
            get(routes_devices::device_scope)
                .put(routes_writes::device_scope_put)
                .delete(routes_writes::device_scope_delete),
        )
        .route(
            "/api/devices/{id}",
            get(routes_devices::detail)
                .patch(routes_writes::device_patch)
                .delete(routes_writes::device_delete),
        )
        .route("/api/devices/{id}/bundles", get(routes_devices::bundles))
        .route(
            "/api/devices/{id}/tracked-apps",
            get(routes_devices::tracked_apps),
        )
        .route("/api/devices/for-app/{appId}", get(routes_devices::for_app))
        // Phase 6, batch 2a: the device actions and the device re-sync.
        .route(
            "/api/device-actions/backup",
            post(routes_writes::device_backup_post),
        )
        .route(
            "/api/device-actions/uninstall",
            get(device_writes::uninstall_get).post(routes_writes::device_uninstall_post),
        )
        .route(
            "/api/device-sync/preview",
            post(routes_writes::device_sync_preview_post),
        )
        .route(
            "/api/device-sync/commit",
            post(routes_writes::device_sync_commit_post),
        )
        .route("/api/activity", get(routes_content::activity))
        .route(
            "/api/notifications",
            get(routes_content::notifications).post(routes_writes::notifications_post),
        )
        .route(
            "/api/notification-prefs",
            get(routes_content::notification_prefs).put(routes_writes::notification_prefs_put),
        )
        .route(
            "/api/user-tasks",
            get(routes_content::user_tasks).post(routes_writes::user_tasks_post),
        )
        .route(
            "/api/annotations",
            get(routes_content::annotations).post(routes_writes::annotations_post),
        )
        .route(
            "/api/shortlist",
            get(routes_content::shortlist)
                .post(routes_writes::shortlist_post)
                .delete(routes_writes::shortlist_delete),
        )
        .route(
            "/api/shortlist/export",
            get(routes_content::shortlist_export),
        )
        .route(
            "/api/auth/admin-token/status",
            get(routes::admin_token_status),
        )
        .route(
            "/api/locale",
            get(routes::locale).post(routes_writes::locale_post),
        )
        .route(
            "/api/date-format",
            get(routes::date_format).post(routes_writes::date_format_post),
        )
        .route(
            "/api/preferences",
            get(routes::preferences).put(routes_writes::preferences_put),
        )
        .route(
            "/api/coachmark-state",
            get(routes::coachmark_state).post(routes_writes::coachmark_state_post),
        )
        .route(
            "/api/dev-menu-state",
            get(routes::dev_menu_state).post(routes_writes::dev_menu_state_post),
        )
        .route(
            "/api/privacy-profile",
            get(routes::privacy_profile).put(routes_writes::privacy_profile_put),
        )
        .route(
            "/api/accessibility-profile",
            get(routes::accessibility_profile).put(routes_writes::accessibility_profile_put),
        )
        // Batch 2. Adds the two shapes batch 1 did not cover: a derived
        // multi-key object, and a bare array with a 404 branch.
        // One path, five responses, all-or-nothing: axum routes by path, so
        // this lands only once every branch exists. See routes_apps.rs.
        .route(
            "/api/apps",
            get(routes_apps::apps).delete(routes_writes::apps_delete),
        )
        .route(
            "/api/focus",
            get(routes_focus::focus).post(routes_writes::focus_post),
        )
        .route(
            "/api/imports",
            get(routes_imports::imports)
                .post(routes_writes::imports_post)
                .delete(routes_writes::imports_delete),
        )
        // The first PER-APP route, and the first whose body is computed
        // rather than read: it ports `diffSnapshots`. Axum 0.8 spells a path
        // parameter `{id}`, not `:id`.
        .route(
            "/api/apps/{id}/since-install",
            get(routes_app::since_install),
        )
        // Quarterly aggregates over the snapshot table. Shares the guard
        // chain above; the arithmetic lives in `trend.rs` so it can be
        // tested against a fixed clock, which the differ cannot do — it
        // masks every bucket boundary as `~epoch`.
        .route(
            "/api/apps/{id}/history-stats",
            get(routes_app::history_stats),
        )
        // The per-app timeline. Its kernel (`changelog.rs`) is what
        // `/api/apps?id=X&changelog=true` and `/api/apps/{id}/detail` will
        // both be built from, which is why it lands before either of them.
        .route("/api/apps/{id}/changelog", get(routes_app::app_changelog))
        // Batch 3. Adds a query-scoped read with a 400 branch, a nested list
        // inside an envelope, and interval arithmetic over stored epochs.
        .route("/api/sync/status", get(routes_status::sync_status))
        .route(
            "/api/verdicts",
            get(routes_status::verdicts)
                .post(routes_writes::verdicts_post)
                .delete(routes_writes::verdicts_delete),
        )
        .route(
            "/api/imports/queue",
            get(routes_status::imports_queue).post(routes_writes::import_queue_post),
        )
        // Phase 4, batch 3: the rest of the import pipeline.
        .route("/api/imports/items", post(routes_writes::import_items_post))
        .route(
            "/api/imports/items/update",
            post(routes_writes::import_item_update_post),
        )
        .route(
            "/api/imports/complete",
            post(routes_writes::import_complete_post),
        )
        .route(
            "/api/imports/items/retry",
            post(routes_writes::import_item_retry_post),
        )
        .route(
            "/api/imports/items/change-match",
            post(routes_writes::import_item_change_match_post),
        )
        .route("/api/search", post(routes_writes::search_post))
        .route("/api/scrape", post(routes_writes::scrape_post))
        .route(
            "/api/apps/{id}/import-history",
            post(routes_writes::import_history_post).delete(routes_writes::import_history_delete),
        )
        // Unblocked by the inbound rate-limiter port: both of these call
        // checkRateLimit before doing any work, so porting them without the
        // limiter would have meant shipping a route with its gate removed.
        .route(
            "/api/manual-apps",
            get(routes_manual::manual_apps).post(routes_writes::manual_apps_post),
        )
        .route(
            "/api/import/audit-bundle/recent",
            get(routes_manual::audit_bundle_recent),
        )
        // Fourteen keys assembled from reads that are almost all already
        // ported; every one but the app row degrades to a fallback rather
        // than failing the request. See routes_detail.rs.
        .route("/api/apps/{id}/detail", get(routes_detail::detail))
        // The settings-backed reads. Three coercion-heavy app_settings
        // views and the feature-flag resolver, whose rule tables are
        // generated from the Node source (flag_rules.json) rather than
        // transcribed. /api/settings/desktop is the first GET here that can
        // WRITE — the runtime marker Node also writes on this request.
        .route(
            "/api/settings",
            get(routes_settings::settings).post(routes_writes::settings_post),
        )
        .route(
            "/api/settings/desktop",
            get(routes_settings::desktop_settings).post(routes_writes::desktop_settings_post),
        )
        .route(
            "/api/dashboard/layout",
            get(routes_settings::dashboard_layout)
                .put(routes_writes::dashboard_layout_put)
                .delete(routes_writes::dashboard_layout_delete),
        )
        .route("/api/feature-flags", get(routes_settings::feature_flags))
        .route(
            "/api/feature-flags/overrides",
            post(routes_writes::overrides_post).delete(routes_writes::overrides_delete),
        )
        .route(
            "/api/feature-flags/overrides/{key}",
            delete(routes_writes::override_delete_one),
        )
        .route(
            "/api/dashboard/layout/preset",
            post(routes_writes::dashboard_layout_preset_post),
        )
        .route("/api/welcomed-at", post(routes_writes::welcomed_at_post))
        .route(
            "/api/verdicts/bulk",
            post(routes_writes::verdicts_bulk_post),
        )
        .route(
            "/api/annotations/{id}",
            patch(routes_writes::annotation_patch)
                .delete(routes_writes::annotation_delete)
                .put(routes_writes::annotation_put),
        )
        .route(
            "/api/apps/{id}/acknowledge",
            post(routes_writes::acknowledge_post),
        )
        .route(
            "/api/apps/{id}/acknowledge/undo",
            post(routes_writes::acknowledge_undo_post),
        )
        .route(
            "/api/user-tasks/visit",
            post(routes_writes::user_tasks_visit_post),
        )
        .route(
            "/api/activity/queue-session",
            post(routes_writes::queue_session_post),
        )
        .route(
            "/api/manual-apps/bulk",
            post(routes_writes::manual_bulk_post),
        )
        .route(
            "/api/manual-apps/{id}/restore",
            post(routes_writes::manual_restore_post),
        )
        // Phase 5, batch 2: the policy reads and the manual-app scrape.
        .route(
            "/api/manual-apps/{id}/scrape",
            post(routes_writes::manual_scrape_post),
        )
        .route(
            "/api/manual-apps/{id}/policy-version/{version_id}",
            get(routes_policy::manual_version),
        )
        .route("/api/policy/status/{app_id}", get(routes_policy::status))
        // Phase 5, batch 3b: the AI routes.
        .route(
            "/api/policy/regenerate",
            post(routes_writes::policy_regenerate_post),
        )
        .route(
            "/api/ai/policy-sample",
            post(routes_writes::ai_policy_sample_post),
        )
        .route("/api/ai/test", post(routes_writes::ai_test_post))
        .route("/api/ai/models", post(routes_writes::ai_models_post))
        .route("/api/policy/version/{id}", get(routes_policy::version))
        .route(
            "/api/policy/version/{id}/diff",
            get(routes_policy::version_diff),
        )
        .route(
            "/api/migration-flow/consume",
            post(routes_writes::migration_flow_consume_post),
        )
        // The deployment-facing reads: facts about the database file, its
        // directory, the env and the request — portable exactly, unlike the
        // process-introspection diagnostics. See routes_diag.rs.
        .route("/api/ready", get(routes_diag::ready))
        .route(
            "/api/deployment/diagnostics",
            get(routes_diag::deployment_diagnostics),
        )
        .route(
            "/api/diagnostics/database",
            get(routes_diag::diagnostics_database).post(routes_writes::diagnostics_database_post),
        )
        .route("/api/diagnostics/disk", get(routes_diag::diagnostics_disk))
        .route(
            "/api/diagnostics/health",
            get(routes_diag::diagnostics_health).post(routes_writes::diagnostics_health_post),
        )
        // The process-introspection reads, re-specified as one backend-
        // tagged envelope rather than ported (see routes_runtime.rs).
        .route(
            "/api/diagnostics/runtime",
            get(routes_runtime::runtime)
                .delete(routes_writes::diagnostics_runtime_delete)
                .post(routes_writes::diagnostics_runtime_post),
        )
        .route(
            "/api/desktop/diagnostics",
            get(routes_runtime::desktop_diagnostics),
        )
        .route(
            "/api/diagnostics/errors",
            get(routes_runtime::errors).delete(routes_writes::diagnostics_errors_delete),
        )
        // Phase 6, batch 3a: every route above is a route handler in Node,
        // which the compression middleware never sees (see frontdoor.rs).
        .route_layer(axum::middleware::from_fn(frontdoor::app_route))
        // Everything else is the frontend's: the build's pages and files
        // when a site is installed, the empty 404 when not (site.rs).
        .fallback(site::fallback)
}

/// The layers every route runs under, innermost first. Split from the route
/// list so a test can put a route of its own under exactly these layers.
fn layered(routes: Router<AppState>, state: AppState) -> Router {
    routes
        // Innermost: a handler that panics answers Next's bare 500, and the
        // layers outside see an ordinary response (see lifecycle.rs).
        .layer(axum::middleware::from_fn(lifecycle::catch_panic))
        // Request timing, INSIDE the gate: a request the gate refuses never
        // reaches Node's ring either. Runs after routing, so the matched
        // path pattern is available as the route label.
        .layer(axum::middleware::from_fn(timing::http_timing))
        // The gate wraps every route, including the 404 fallback, mirroring
        // proxy.ts's matcher which runs before the router.
        .layer(axum::middleware::from_fn(gate::gate))
        // Outermost, so it runs first: the x-forwarded-* synthesis `next
        // start` performs on every request before anything reads the
        // headers. See forwarded.rs for why this is safe ahead of the gate.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            forwarded::inject,
        ))
        .with_state(state)
}

/// Phase 6, batch 3a: what `next start` does before and around its router
/// (frontdoor.rs), outermost last: the compression middleware, next.config's
/// security headers, and the repeated-slash redirect and dot-segment
/// resolution. `Router::layer` wraps each route on its own, after routing,
/// so these wrap the whole router instead, as the fallback of an outer one:
/// a dot-segment path is resolved before it is routed, and axum's own
/// answers (the `Allow` on a 405) pass through them.
fn front_door(inner: Router) -> Router {
    Router::new()
        .fallback_service(inner)
        .layer(axum::middleware::from_fn(frontdoor::compress))
        .layer(axum::middleware::from_fn(frontdoor::security_headers))
        .layer(axum::middleware::from_fn(frontdoor::normalize))
}

/// How long requests in flight get once the server is told to stop: the
/// three seconds the Tauri shell gave the Node sidecar between SIGTERM and
/// SIGKILL.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// `pt-core serve`: bind `addr`, serve the database the process environment
/// names (`serve_with`), and stop on SIGINT or SIGTERM, Docker's stop
/// signal, within [`SHUTDOWN_GRACE`].
///
/// The database is opened by `db::open_and_migrate`, so the pragmas are
/// byte-identical to the Node server's: `busy_timeout` and `foreign_keys`
/// are CONNECTION-scoped, not stored in the file, so a server that opened
/// the database differently would report different values from
/// `/api/diagnostics/database`.
///
/// The listener is bound BEFORE the state is built because the bound port
/// is part of the state (`x-forwarded-port`), and the service is built with
/// connect info so the peer address can stand in for `socket.remoteAddress`.
pub async fn serve(
    addr: SocketAddr,
    site: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    let server = serve_with(
        listener,
        ServeConfig {
            site,
            ..ServeConfig::default()
        },
    )
    .await?;
    // Printed so a supervising script can wait for readiness on stdout
    // rather than polling a port it only assumes is right. The boot writes
    // have landed by now.
    println!("pt-core: listening on http://{bound}");
    stop_signal().await;
    server.shutdown(SHUTDOWN_GRACE).await?;
    Ok(())
}

/// SIGINT, or on Unix SIGTERM too.
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

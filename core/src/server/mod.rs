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

mod analysis;
mod apps;
pub mod auth;
mod backup_snapshots;
mod changelog;
#[cfg(test)]
mod content_tests;
mod csp_reports;
mod deployment;
#[cfg(test)]
mod devices_tests;
pub(crate) mod diag;
mod diagnostics;
pub mod diff;
#[cfg(test)]
mod discovery_tests;
mod export;
pub mod flags;
mod forwarded;
mod gate;
mod grid_meta;
mod histogram;
mod json;
pub mod layout;
mod operations;
#[cfg(test)]
mod operations_tests;
mod osinfo;
mod policy;
mod preview;
mod ratelimit;
mod review;
mod routes;
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
mod routes_runtime;
mod routes_settings;
mod routes_stats;
mod routes_status;
mod row;
mod runtime_diag;
mod scope;
mod settings;
mod shortlist;
mod snapshot_time;
mod stats;
#[cfg(test)]
mod stats_tests;
mod sysproc;
mod timing;
mod trend;
pub mod trust;
mod user_content;
mod user_tasks;
pub mod webhook;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use axum::{routing::get, Router};
use rusqlite::Connection;

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
        let guard = self.conn.lock().expect("db mutex poisoned");
        diag::record_lock_wait(started.elapsed());
        guard
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
    match std::env::var("PRIVACYTRACKER_DATA_DIR") {
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
/// directory instead. `serve` is the one constructor of `AppState` and
/// keeps the two aligned.
pub fn app(state: AppState) -> Router {
    Router::new()
        // Batch 1. Each of these is a GET the client shell fetches on first
        // paint, a container/auth probe, or both.
        .route("/api/health", get(routes::health))
        // Final Phase 2 reads: public network access without persistence.
        .route("/api/compare", get(routes_discovery::compare))
        .route("/api/related-apps", get(routes_discovery::related))
        // Operational reads project durable job state without starting or
        // healing jobs; exports stay whole-install and CSP remains a GET.
        .route("/api/tasks/active", get(routes_operations::tasks))
        .route("/api/wayback/import-all", get(routes_operations::wayback))
        .route("/api/policy/sync-all", get(routes_operations::policy))
        .route("/api/backup/snapshots", get(routes_operations::backups))
        .route("/api/rate-limit/status", get(routes_operations::cooldowns))
        .route("/api/ai/debug-log", get(routes_operations::ai_debug))
        .route("/api/csp-report", get(routes_operations::csp))
        .route("/api/export", get(routes_operations::export))
        .route("/api/manual-apps/{id}", get(routes_operations::manual))
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
        // and app links. No cfgutil calls or mutation handlers are enabled.
        .route("/api/devices", get(routes_devices::devices))
        .route("/api/device-scope", get(routes_devices::device_scope))
        .route("/api/devices/{id}", get(routes_devices::detail))
        .route("/api/devices/{id}/bundles", get(routes_devices::bundles))
        .route(
            "/api/devices/{id}/tracked-apps",
            get(routes_devices::tracked_apps),
        )
        .route("/api/devices/for-app/{appId}", get(routes_devices::for_app))
        .route("/api/activity", get(routes_content::activity))
        .route("/api/notifications", get(routes_content::notifications))
        .route(
            "/api/notification-prefs",
            get(routes_content::notification_prefs),
        )
        .route("/api/user-tasks", get(routes_content::user_tasks))
        .route("/api/annotations", get(routes_content::annotations))
        .route("/api/shortlist", get(routes_content::shortlist))
        .route(
            "/api/shortlist/export",
            get(routes_content::shortlist_export),
        )
        .route(
            "/api/auth/admin-token/status",
            get(routes::admin_token_status),
        )
        .route("/api/locale", get(routes::locale))
        .route("/api/date-format", get(routes::date_format))
        .route("/api/preferences", get(routes::preferences))
        .route("/api/coachmark-state", get(routes::coachmark_state))
        .route("/api/dev-menu-state", get(routes::dev_menu_state))
        .route("/api/privacy-profile", get(routes::privacy_profile))
        .route(
            "/api/accessibility-profile",
            get(routes::accessibility_profile),
        )
        // Batch 2. Adds the two shapes batch 1 did not cover: a derived
        // multi-key object, and a bare array with a 404 branch.
        // One path, five responses, all-or-nothing: axum routes by path, so
        // this lands only once every branch exists. See routes_apps.rs.
        .route("/api/apps", get(routes_apps::apps))
        .route("/api/focus", get(routes_focus::focus))
        .route("/api/imports", get(routes_imports::imports))
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
        .route("/api/verdicts", get(routes_status::verdicts))
        .route("/api/imports/queue", get(routes_status::imports_queue))
        // Unblocked by the inbound rate-limiter port: both of these call
        // checkRateLimit before doing any work, so porting them without the
        // limiter would have meant shipping a route with its gate removed.
        .route("/api/manual-apps", get(routes_manual::manual_apps))
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
        .route("/api/settings", get(routes_settings::settings))
        .route(
            "/api/settings/desktop",
            get(routes_settings::desktop_settings),
        )
        .route(
            "/api/dashboard/layout",
            get(routes_settings::dashboard_layout),
        )
        .route("/api/feature-flags", get(routes_settings::feature_flags))
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
            get(routes_diag::diagnostics_database),
        )
        .route("/api/diagnostics/disk", get(routes_diag::diagnostics_disk))
        .route(
            "/api/diagnostics/health",
            get(routes_diag::diagnostics_health),
        )
        // The process-introspection reads, re-specified as one backend-
        // tagged envelope rather than ported (see routes_runtime.rs).
        .route("/api/diagnostics/runtime", get(routes_runtime::runtime))
        .route(
            "/api/desktop/diagnostics",
            get(routes_runtime::desktop_diagnostics),
        )
        .route("/api/diagnostics/errors", get(routes_runtime::errors))
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

/// Open + migrate the database at [`data_layout`], then serve on `addr`.
///
/// Reuses `db::open_and_migrate` so the pragmas are byte-identical to the
/// Node server's: `busy_timeout` and `foreign_keys` are CONNECTION-scoped,
/// not stored in the file, so a server that opened the database differently
/// would report different values from `/api/diagnostics/database`.
///
/// The listener is bound BEFORE the state is built because the bound port
/// is part of the state (`x-forwarded-port`), and the service is built with
/// connect info so the peer address can stand in for `socket.remoteAddress`.
pub async fn serve(addr: SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
    let layout = data_layout();
    let mut conn = crate::db::open_and_migrate(&layout.db_path)?;
    // SQLite's per-statement profile hook feeds the slow-query ring for
    // every statement this connection runs, with no call-site wrapping.
    conn.profile(Some(diag::on_statement_profiled));
    // The scheduler-lag sampler needs the runtime, which `serve` is on.
    diag::start_scheduler_sampler();

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;

    let state = AppState {
        conn: Arc::new(Mutex::new(conn)),
        rate_limiter: Arc::new(ratelimit::RateLimiter::new()),
        started_at: Instant::now(),
        bound_port: bound.port(),
    };

    // Printed so a supervising script can wait for readiness on stdout
    // rather than polling a port it only assumes is right.
    println!("pt-core: listening on http://{bound}");

    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

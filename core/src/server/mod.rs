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

pub mod auth;
pub mod diff;
mod gate;
mod json;
mod ratelimit;
mod routes;
mod routes_app;
mod routes_focus;
mod routes_imports;
mod routes_manual;
mod routes_status;
mod settings;
pub mod trust;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::{routing::get, Router};
use rusqlite::Connection;

#[derive(Clone)]
pub struct AppState {
    pub conn: Arc<Mutex<Connection>>,
    /// The inbound request limiter. Per-process and in-memory, exactly as in
    /// Node — a restart forgets the window there too.
    pub rate_limiter: Arc<ratelimit::RateLimiter>,
}

/// Build the router. Split out from `serve` so tests can exercise routes
/// without binding a port.
pub fn app(state: AppState) -> Router {
    Router::new()
        // Batch 1. Each of these is a GET the client shell fetches on first
        // paint, a container/auth probe, or both.
        .route("/api/health", get(routes::health))
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
        .route("/api/focus", get(routes_focus::focus))
        .route("/api/imports", get(routes_imports::imports))
        // The first PER-APP route, and the first whose body is computed
        // rather than read: it ports `diffSnapshots`. Axum 0.8 spells a path
        // parameter `{id}`, not `:id`.
        .route(
            "/api/apps/{id}/since-install",
            get(routes_app::since_install),
        )
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
        // The gate wraps every route, including the 404 fallback, mirroring
        // proxy.ts's matcher which runs before the router.
        .layer(axum::middleware::from_fn(gate::gate))
        .with_state(state)
}

/// Open + migrate the database at `db_path`, then serve on `addr`.
///
/// Reuses `db::open_and_migrate` so the pragmas are byte-identical to the
/// Node server's: `busy_timeout` and `foreign_keys` are CONNECTION-scoped,
/// not stored in the file, so a server that opened the database differently
/// would report different values from `/api/diagnostics/database` later.
pub async fn serve(db_path: &Path, addr: SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
    let conn = crate::db::open_and_migrate(db_path)?;
    let state = AppState {
        conn: Arc::new(Mutex::new(conn)),
        rate_limiter: Arc::new(ratelimit::RateLimiter::new()),
    };

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    // Printed so a supervising script can wait for readiness on stdout
    // rather than polling a port it only assumes is right.
    println!("pt-core: listening on http://{bound}");

    axum::serve(listener, app(state)).await?;
    Ok(())
}

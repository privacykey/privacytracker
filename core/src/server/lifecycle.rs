//! Running the server inside another process: the entry point a host calls
//! ([`serve_with`]), a shutdown that finishes within a bound, and the panic
//! policy an embedded server needs.
//!
//! As the Node sidecar, a crash took down one child process and nothing
//! else. In process, the same bug would leave the app open with a backend
//! that fails every request, so:
//!
//! - a handler that panics answers Next's bare 500 ([`catch_panic`]) and the
//!   next request is served as usual;
//! - a panic while a section holds the database connection no longer
//!   poisons it for good ([`lock_db`]);
//! - a timer tick that panics is logged, and its loop carries on
//!   ([`isolate`]).
//!
//! One server per process: the data directory and the host environment are
//! process state, set once (`data_layout`, `host_env`).

use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::{body::Body, extract::Request, http::StatusCode, middleware::Next, response::Response};
use futures_util::FutureExt;
use rusqlite::Connection;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{app, data_layout, diag, ratelimit, resolve_data_dir, sync_runner, AppState};

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// How the host wants the server run.
#[derive(Debug, Clone, Default)]
pub struct ServeConfig {
    /// The environment the server reads its settings from. `None` reads the
    /// process environment, as `pt-core` does. `Some` makes the map the
    /// server's whole environment for the rest of the process, as the Tauri
    /// shell's `env_clear()` did for the Node sidecar; see `host_env`.
    pub env: Option<HashMap<String, String>>,
    /// The directory `next start` would run in, holding `.next/` and
    /// `public/`. When set, the server answers for the frontend too, from
    /// that build (`site.rs`). One per process, like the environment.
    pub site: Option<std::path::PathBuf>,
    /// How long a client gets to send a request's headers, and how long an
    /// idle keep-alive connection waits for the next request, before the
    /// connection is closed. `None` is [`HEADER_READ_TIMEOUT`]; tests pass
    /// something short.
    pub header_read_timeout: Option<Duration>,
}

/// Node's `server.headersTimeout` default, which `next start` leaves alone.
/// Without one, a client could hold a connection open indefinitely by
/// sending its headers a byte at a time: harmless on loopback, not once the
/// server faces a network (Docker).
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// What Node's `instrumentation.ts` prints at boot when the instance is
/// network-exposed with no admin token, word for word, so the line an
/// operator searches for is the same whichever server they run.
const EXPOSED_WITHOUT_TOKEN: &str = "[security] This instance is declared network-exposed but no \
AUDITOR_ADMIN_TOKEN is set — private pages and API calls will be \
REFUSED until you set one. See docker-compose.yml for setup.";

/// proxy.ts's line for a build with no readable `csp-hashes.json`, word for
/// word.
const CSP_HASHES_MISSING: &str = "[proxy] csp-hashes.json not found — was `next build` run \
without scripts/generate-csp-hashes.mjs? Failing closed (script-src 'self').";

/// A running server. Dropping the handle leaves the server running; call
/// [`ServerHandle::shutdown`] to stop it.
pub struct ServerHandle {
    addr: SocketAddr,
    stop: CancellationToken,
    served: JoinHandle<std::io::Result<()>>,
}

impl ServerHandle {
    /// The address the server listens on.
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stop the server: stop accepting, stop the timers, and give requests
    /// in flight up to `grace` to finish before their connections are
    /// dropped. Returns once the listener is closed, never much later than
    /// `grace`, so quitting the app cannot hang on a stuck connection.
    ///
    /// A bulk run cut off here resumes on the next start, as it does after
    /// a crash; a write is either committed or rolled back, never torn.
    pub async fn shutdown(mut self, grace: Duration) -> std::io::Result<()> {
        self.stop.cancel();
        match tokio::time::timeout(grace, &mut self.served).await {
            Ok(Ok(result)) => result,
            Ok(Err(joined)) => Err(std::io::Error::other(joined)),
            Err(_) => {
                self.served.abort();
                // Wait for the abort to land so the port is free on return.
                let _ = (&mut self.served).await;
                Ok(())
            }
        }
    }
}

/// Serve on a listener the host bound, with the host's environment.
///
/// Opens and migrates the database the environment names, runs the boot
/// writes and starts the timers `instrumentation.ts` registers, then
/// serves. Call from within a tokio runtime; the server runs on it.
///
/// Binding is the host's job so it can choose the address: the Tauri shell
/// binds loopback (on the port it used last when that is free, so the
/// page's origin and its local storage survive a relaunch), `pt-core`
/// binds the port it was given.
pub async fn serve_with(
    listener: tokio::net::TcpListener,
    config: ServeConfig,
) -> Result<ServerHandle, BoxError> {
    if let Some(env) = config.env {
        crate::host_env::fix(env)?;
    }
    // The layout is read once per process. If anything read it before the
    // environment was fixed, it names another directory; refuse to serve
    // that one rather than report one database and open another.
    let layout = data_layout();
    let (expected, _) = resolve_data_dir();
    if layout.data_dir != expected {
        return Err(format!(
            "the data directory was resolved as {} before the host environment named {}",
            layout.data_dir.display(),
            expected.display()
        )
        .into());
    }

    // instrumentation.ts's deployment-trust warning: once, at boot, and into
    // the diagnostics tail as well as the log. It warns and does not
    // refuse: requests fail closed on their own.
    if let Some(warning) = posture_warning(
        crate::host_env::var("NODE_ENV").ok().as_deref(),
        super::auth::admin_token_configured(),
        super::trust::is_network_exposed(),
    ) {
        diag::log_warn(warning);
    }

    // The build is indexed before anything is served, as `next start`
    // reads its manifests before it listens.
    if let Some(dir) = &config.site {
        let site = super::site::Site::load(dir)?;
        // Pages still serve without the hashes, under `script-src 'self'`,
        // which (enforced) blocks their inline scripts and leaves them
        // blank. proxy.ts says so the first time it looks; this, at boot.
        if site.csp.is_none() {
            diag::log_error(CSP_HASHES_MISSING);
        }
        super::site::install(site)?;
    }

    let mut conn = crate::db::open_and_migrate(&layout.db_path)?;
    // SQLite's per-statement profile hook feeds the slow-query ring for
    // every statement this connection runs, with no call-site wrapping.
    conn.profile(Some(diag::on_statement_profiled));
    // The scheduler-lag sampler needs the runtime, which this runs on.
    diag::start_scheduler_sampler();

    let addr = listener.local_addr()?;
    let state = AppState {
        conn: Arc::new(Mutex::new(conn)),
        rate_limiter: Arc::new(ratelimit::RateLimiter::new()),
        started_at: Instant::now(),
        bound_port: addr.port(),
    };

    let stop = CancellationToken::new();
    // instrumentation.ts's boot writes and tickers. The boot writes land
    // before the first request is served, as they do in Node.
    sync_runner::start_background(state.clone(), stop.clone());

    let header_read_timeout = config.header_read_timeout.unwrap_or(HEADER_READ_TIMEOUT);
    let served = tokio::spawn(accept_loop(
        listener,
        app(state),
        stop.clone(),
        header_read_timeout,
    ));
    Ok(ServerHandle { addr, stop, served })
}

/// instrumentation.ts's condition: production only (localhost development
/// does not need it), no admin token, and an instance declared
/// network-exposed.
fn posture_warning(
    node_env: Option<&str>,
    token_configured: bool,
    network_exposed: bool,
) -> Option<&'static str> {
    (node_env == Some("production") && !token_configured && network_exposed)
        .then_some(EXPOSED_WITHOUT_TOKEN)
}

/// `axum::serve(..).with_graceful_shutdown(..)`, with one difference: each
/// connection gets hyper's header-read timeout, which needs a timer that
/// axum's own loop never sets. The rest is axum 0.8's loop, step for step:
/// the same accept-error handling, the peer address handed to handlers as
/// `ConnectInfo`, and on stop no new connections, each open one finishing
/// the request in flight, and a return once every one has closed.
async fn accept_loop(
    listener: tokio::net::TcpListener,
    router: axum::Router,
    stop: CancellationToken,
    header_read_timeout: Duration,
) -> std::io::Result<()> {
    use axum::extract::ConnectInfo;
    use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
    use hyper_util::server::conn::auto::Builder;
    use hyper_util::service::TowerToHyperService;
    use tower::ServiceExt;

    // Dropping `signal_rx` tells every connection to shut down gracefully;
    // `close_tx.closed()` resolves once every connection has dropped its
    // `close_rx`.
    let (signal_tx, signal_rx) = tokio::sync::watch::channel(());
    let (close_tx, close_rx) = tokio::sync::watch::channel(());
    loop {
        let (stream, remote) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                Err(e) => {
                    accept_error(e).await;
                    continue;
                }
            },
            () = stop.cancelled() => break,
        };
        let service = TowerToHyperService::new(router.clone().map_request(
            move |mut req: axum::http::Request<hyper::body::Incoming>| {
                req.extensions_mut().insert(ConnectInfo(remote));
                req.map(Body::new)
            },
        ));
        let signal_tx = signal_tx.clone();
        let close_rx = close_rx.clone();
        tokio::spawn(async move {
            let mut builder = Builder::new(TokioExecutor::new());
            builder
                .http1()
                .timer(TokioTimer::new())
                .header_read_timeout(header_read_timeout);
            let mut conn = std::pin::pin!(
                builder.serve_connection_with_upgrades(TokioIo::new(stream), service)
            );
            // Fused, so once it has fired the loop polls only the connection.
            let mut signalled = std::pin::pin!(signal_tx.closed().fuse());
            loop {
                tokio::select! {
                    result = conn.as_mut() => {
                        if let Err(e) = result {
                            log::debug!("connection from {remote} ended: {e}");
                        }
                        break;
                    }
                    () = &mut signalled => conn.as_mut().graceful_shutdown(),
                }
            }
            drop(close_rx);
        });
    }
    drop(listener);
    drop(signal_rx);
    drop(close_rx);
    close_tx.closed().await;
    Ok(())
}

/// What axum does with an accept error. A connection that failed before it
/// was accepted is the client's problem; anything else (running out of
/// file descriptors, typically) is logged, and the loop waits a second
/// before trying again rather than spinning on it.
async fn accept_error(e: std::io::Error) {
    use std::io::ErrorKind::{ConnectionAborted, ConnectionRefused, ConnectionReset};
    if matches!(
        e.kind(),
        ConnectionRefused | ConnectionAborted | ConnectionReset
    ) {
        return;
    }
    log::error!("accept error: {e}");
    tokio::time::sleep(Duration::from_secs(1)).await;
}

/// The single connection, taken even when a panic poisoned its mutex.
///
/// A section that panics unwinds through its `Transaction` guard, whose drop
/// rolls the transaction back, so the connection is left consistent; the
/// poison flag only says that a panic happened. Keeping it would make every
/// later request panic in turn. The check for an open transaction is the
/// belt to that brace: a statement that opened one outside a guard would
/// otherwise leave the next section inside it.
pub(crate) fn lock_db(conn: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    match conn.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            let guard = poisoned.into_inner();
            if !guard.is_autocommit() {
                let _ = guard.execute_batch("ROLLBACK");
            }
            conn.clear_poison();
            diag::log_warn("[db] Recovered the connection after a panic");
            guard
        }
    }
}

/// A lock on in-memory state (a ring, a cache, a registry), taken even when
/// a panic poisoned it. What these hold stays usable after a panic: at
/// worst an entry is missing.
pub(crate) fn lock_state<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Sleep for `duration`, or until the server stops. True when it stopped.
pub(crate) async fn sleep_or_stop(stop: &CancellationToken, duration: Duration) -> bool {
    tokio::select! {
        () = stop.cancelled() => true,
        () = tokio::time::sleep(duration) => false,
    }
}

/// Run one timer tick. A panic in it is logged to the error ring instead of
/// ending the loop that runs the tick, as a thrown error in a Node
/// `setInterval` callback ends that call and not the interval.
pub(crate) async fn isolate(name: &str, tick: impl Future<Output = ()>) {
    if let Err(payload) = AssertUnwindSafe(tick).catch_unwind().await {
        diag::log_error(format!(
            "[{name}] Tick panicked: {}",
            panic_message(&*payload)
        ));
    }
}

/// The innermost layer: a handler that panics answers the bare 500 Next
/// sends when a route handler throws, and the panic is logged to the error
/// ring. The layers outside it (timing, the gate) see an ordinary response.
pub(crate) async fn catch_panic(request: Request, next: Next) -> Response {
    match AssertUnwindSafe(next.run(request)).catch_unwind().await {
        Ok(response) => response,
        Err(payload) => {
            diag::log_error(format!(
                "[server] Handler panicked: {}",
                panic_message(&*payload)
            ));
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
            response
        }
    }
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "a panic without a message".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use tower::ServiceExt;

    /// Every combination: only production, no token and network-exposed
    /// together warn, as in instrumentation.ts.
    #[test]
    fn the_posture_warning_needs_production_no_token_and_exposure() {
        for node_env in [Some("production"), Some("development"), None] {
            for token in [false, true] {
                for exposed in [false, true] {
                    let expected = node_env == Some("production") && !token && exposed;
                    assert_eq!(
                        posture_warning(node_env, token, exposed).is_some(),
                        expected,
                        "NODE_ENV={node_env:?} token={token} exposed={exposed}"
                    );
                }
            }
        }
    }

    fn memory_state() -> AppState {
        let conn = crate::db::open_and_migrate(std::path::Path::new(":memory:")).unwrap();
        AppState {
            conn: Arc::new(Mutex::new(conn)),
            rate_limiter: Arc::new(ratelimit::RateLimiter::new()),
            started_at: Instant::now(),
            bound_port: 0,
        }
    }

    /// A panic inside a transaction poisons the mutex; the next section gets
    /// the connection, with the transaction rolled back and the poison
    /// cleared, rather than a panic of its own.
    #[test]
    fn a_panic_holding_the_connection_does_not_poison_it_for_good() {
        let state = memory_state();
        let conn = state.conn.clone();
        let panicked = std::thread::spawn(move || {
            let guard = conn.lock().unwrap();
            let tx = guard.unchecked_transaction().unwrap();
            tx.execute(
                "INSERT INTO app_settings (key, value) VALUES ('lifecycle_probe', 'x')",
                [],
            )
            .unwrap();
            panic!("mid-transaction");
        })
        .join();
        assert!(panicked.is_err(), "the section panicked");
        assert!(state.conn.is_poisoned(), "the panic poisoned the mutex");

        let guard = state.db();
        assert!(guard.is_autocommit(), "no transaction left open");
        let kept: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'lifecycle_probe'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 0, "the write inside the transaction was rolled back");
        drop(guard);
        assert!(!state.conn.is_poisoned(), "the poison was cleared");
    }

    /// The belt: a transaction opened outside a guard is rolled back when the
    /// poisoned connection is recovered.
    #[test]
    fn recovery_rolls_back_a_transaction_left_open() {
        let conn = Mutex::new(Connection::open_in_memory().unwrap());
        {
            let guard = conn.lock().unwrap();
            guard
                .execute_batch("CREATE TABLE t (v INTEGER); BEGIN; INSERT INTO t VALUES (1);")
                .unwrap();
        }
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _guard = conn.lock().unwrap();
            panic!("left open");
        }));
        let guard = lock_db(&conn);
        assert!(guard.is_autocommit());
        let rows: i64 = guard
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn a_poisoned_state_lock_is_still_usable() {
        let ring = Mutex::new(vec![1]);
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let mut guard = ring.lock().unwrap();
            guard.push(2);
            panic!("mid-push");
        }));
        assert!(ring.is_poisoned());
        assert_eq!(*lock_state(&ring), vec![1, 2]);
    }

    /// A tick that panics returns to its loop, and the next tick runs.
    #[tokio::test]
    async fn a_panicking_tick_does_not_end_its_loop() {
        let mut ran = vec![];
        for n in 0..3 {
            isolate("LifecycleTest", async {
                if n == 1 {
                    panic!("tick {n}");
                }
                ran.push(n);
            })
            .await;
        }
        assert_eq!(ran, vec![0, 2]);
    }

    #[tokio::test]
    async fn a_stopped_server_wakes_its_sleeping_timers() {
        let stop = CancellationToken::new();
        assert!(!sleep_or_stop(&stop, Duration::from_millis(5)).await);
        let sleeper = {
            let stop = stop.clone();
            tokio::spawn(async move { sleep_or_stop(&stop, Duration::from_secs(3600)).await })
        };
        stop.cancel();
        assert!(sleeper.await.unwrap(), "woken by the stop, not the hour");
    }

    /// The layers exactly as `app` applies them, over a route that panics
    /// and one that does not: the panic is Next's bare 500, and the server
    /// keeps serving. Under the env lock with the bind host set to loopback
    /// and no token, as the write replays run, so the gate lets both through.
    #[test]
    fn a_handler_panic_is_a_bare_500_and_the_server_carries_on() {
        let _env = super::super::trust::env_lock();
        std::env::set_var("PRIVACYTRACKER_BIND_HOST", "127.0.0.1");
        std::env::remove_var("AUDITOR_ADMIN_TOKEN");
        let router: Router = super::super::layered(
            Router::new()
                .route(
                    "/api/lifecycle-probe/panic",
                    get(|| async {
                        panic!("probe");
                        #[allow(unreachable_code)]
                        ""
                    }),
                )
                .route("/api/lifecycle-probe/ok", get(|| async { "ok" })),
            memory_state(),
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let send = |uri: &str| {
            let request = Request::builder()
                .uri(uri)
                .header("host", "127.0.0.1:3000")
                .body(Body::empty())
                .unwrap();
            rt.block_on(router.clone().oneshot(request)).unwrap()
        };
        let panicked = send("/api/lifecycle-probe/panic");
        let ok = send("/api/lifecycle-probe/ok");
        std::env::remove_var("PRIVACYTRACKER_BIND_HOST");

        assert_eq!(panicked.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = rt
            .block_on(axum::body::to_bytes(panicked.into_body(), usize::MAX))
            .unwrap();
        assert!(body.is_empty(), "Next's thrown 500 has no body");
        assert_eq!(ok.status(), StatusCode::OK);
    }
}

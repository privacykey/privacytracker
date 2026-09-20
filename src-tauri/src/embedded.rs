#![cfg(feature = "rust-backend")]
//! The Rust backend: this process serves the app itself.
//!
//! Compiled only with `--features rust-backend`, which is off by default,
//! so a shipped build still spawns the Node sidecar (`sidecar.rs`) until
//! the cutover release. Everything above this module is unchanged either
//! way: the shell talks to a base URL, and this one is its own.
//!
//! What the sidecar does with a process and an environment, this does with
//! a call:
//!
//! - the data directory is the same one (`backend::resolve_data_dir`), so
//!   either build opens the same database;
//! - the environment is passed as a map rather than set on this process,
//!   because setting variables inside a running GUI process is unsound and
//!   because the server must see exactly what the sidecar's `env_clear()`
//!   gave Node: the data directory, a loopback bind, the desktop runtime,
//!   and no admin token;
//! - the site is the same `next build` output the Node path serves, staged
//!   beside the binary rather than extracted into the data directory;
//! - shutdown gets the same three seconds requests in flight had before
//!   the sidecar was killed.
//!
//! **The port is remembered.** The sidecar takes a fresh random port every
//! launch, and a page's origin includes its port, so everything the app
//! keeps in local storage (the accessibility quick toggles, among others)
//! is lost on every relaunch. Here the last port is reused when it is
//! still free, so the origin survives.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use privacytracker_core::server::{serve_with, ServeConfig, ServerHandle};
use tauri::{AppHandle, Manager};

use crate::backend::Boot;

type BoxError = Box<dyn std::error::Error>;

/// What requests in flight get when the app quits, matching the grace the
/// sidecar had between SIGTERM and SIGKILL.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// The file under the data directory holding the port to try first.
const PORT_FILE: &str = ".desktop-port";

/// A running server, stopped from main.rs's `ExitRequested` handler.
pub struct EmbeddedServer {
    handle: ServerHandle,
}

impl EmbeddedServer {
    /// Stop accepting, stop the timers, and give requests in flight
    /// [`SHUTDOWN_GRACE`] before their connections are dropped. Returns
    /// once the listener is closed, so quitting cannot hang on a stuck
    /// connection; a bulk run cut off here resumes on the next start, as
    /// it does after a crash.
    pub fn shutdown(self) {
        match tauri::async_runtime::block_on(self.handle.shutdown(SHUTDOWN_GRACE)) {
            Ok(()) => log::info!("Embedded server stopped"),
            Err(e) => log::warn!("Embedded server did not stop cleanly: {e}"),
        }
    }
}

/// Serve the app from this process and report where.
pub fn boot(app: &AppHandle) -> Result<Boot, BoxError> {
    // The same dev escape hatch the sidecar has: point at a server the
    // developer is already running and own nothing. Debug builds only, so
    // a release build cannot be redirected by an environment variable.
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("PRIVACYTRACKER_DEV_URL") {
        log::info!("Using PRIVACYTRACKER_DEV_URL={url} — not starting the embedded server");
        let port = url
            .rsplit(':')
            .next()
            .and_then(|p| p.trim_end_matches('/').parse().ok())
            .unwrap_or(3000);
        return Ok(Boot {
            port,
            base_url: url,
            running: None,
        });
    }

    let data_dir = crate::backend::resolve_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    // Private before anything is written, as on the sidecar path. The
    // core tightens the database files themselves when it opens them.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700));
    }

    let site = resolve_site_dir(app)?;
    log::info!(
        "Serving from this process: data {} site {}",
        data_dir.display(),
        site.display(),
    );

    let (handle, addr) = start(&data_dir, &site)?;
    let port = addr.port();
    remember_port(&data_dir, port);
    log::info!("Embedded server listening on {addr}");

    Ok(Boot {
        port,
        base_url: format!("http://127.0.0.1:{port}"),
        running: Some(EmbeddedServer { handle }),
    })
}

/// Bind and serve. Separate from [`boot`] so the boot test can run the
/// real thing over a temporary data directory and site, with no app.
///
/// One server per process: the data directory and the environment are
/// process state in the core, set once.
pub fn start(data_dir: &Path, site: &Path) -> Result<(ServerHandle, SocketAddr), BoxError> {
    let env = environment(data_dir)?;
    let preferred = remembered_port(data_dir);
    let site = site.to_path_buf();
    tauri::async_runtime::block_on(async move {
        let listener = bind(preferred).await?;
        let addr = listener.local_addr()?;
        let handle = serve_with(
            listener,
            ServeConfig {
                env: Some(env),
                site: Some(site),
            },
        )
        .await
        .map_err(|e| -> BoxError { e.to_string().into() })?;
        Ok((handle, addr))
    })
}

/// The server's whole environment, as `env_clear()` plus a handful of
/// variables was the sidecar's. No `AUDITOR_ADMIN_TOKEN`: the desktop
/// relies on the loopback bind, and a token here would be one more secret
/// on disk. No `PRIVACYTRACKER_NETWORK_EXPOSED` either, which is what
/// keeps the server from demanding one.
fn environment(data_dir: &Path) -> Result<HashMap<String, String>, BoxError> {
    let dir = data_dir
        .to_str()
        .ok_or("the data directory's path is not valid UTF-8")?;
    let mut env = HashMap::from([
        ("PRIVACYTRACKER_DATA_DIR".to_string(), dir.to_string()),
        (
            "PRIVACYTRACKER_BIND_HOST".to_string(),
            "127.0.0.1".to_string(),
        ),
        ("PRIVACYTRACKER_RUNTIME".to_string(), "desktop".to_string()),
        ("NODE_ENV".to_string(), "production".to_string()),
    ]);
    // The one variable read from this process: the core resolves Apple's
    // MobileSync folder under it.
    if let Ok(home) = std::env::var("HOME") {
        env.insert("HOME".to_string(), home);
    }
    Ok(env)
}

/// Bind loopback on `preferred`, or on whatever is free when that port is
/// taken (by another copy of the app, or by anything else since last
/// launch).
async fn bind(preferred: Option<u16>) -> std::io::Result<tokio::net::TcpListener> {
    if let Some(port) = preferred {
        match tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => return Ok(listener),
            Err(e) => log::info!("port {port} is not available ({e}); taking a free one"),
        }
    }
    tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await
}

/// The port this install used last, if it still looks like one. Anything
/// unparseable, or in the range a privileged service would hold, is
/// ignored rather than repaired: the fallback is a free port.
fn remembered_port(data_dir: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(data_dir.join(PORT_FILE)).ok()?;
    raw.trim().parse().ok().filter(|port| *port >= 1024)
}

/// Best effort: a launch that cannot write the file simply takes a new
/// port next time, which is what the Node build does every launch.
fn remember_port(data_dir: &Path, port: u16) {
    if let Err(e) = std::fs::write(data_dir.join(PORT_FILE), port.to_string()) {
        log::info!("could not remember the port ({e}); the next launch will pick a free one");
    }
}

/// The directory `next start` would run in: it holds `.next/` and
/// `public/`.
///
/// A shipped build stages it beside the binary, inside the signed bundle,
/// so nothing is extracted into the data directory and nothing writable
/// is ever served. A dev build falls back to the repository's own build,
/// which is what `just tauri-dev-rust` produces.
fn resolve_site_dir(app: &AppHandle) -> Result<PathBuf, BoxError> {
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("PRIVACYTRACKER_DEV_SITE") {
        let explicit = PathBuf::from(dir);
        if is_site(&explicit) {
            log::info!("Using PRIVACYTRACKER_DEV_SITE={}", explicit.display());
            return Ok(explicit);
        }
        log::warn!(
            "PRIVACYTRACKER_DEV_SITE={} has no .next build — falling through",
            explicit.display(),
        );
    }

    let staged = app.path().resource_dir()?.join("site");
    if is_site(&staged) {
        return Ok(staged);
    }

    // `tauri dev` runs the binary from src-tauri/, plain `cargo run` from
    // the repository root, and a nested workspace deeper still: walk up as
    // the sidecar's standalone probe does.
    let mut probe = std::env::current_dir()?;
    for _ in 0..4 {
        if is_site(&probe) {
            log::info!("Using the repository's own build at {}", probe.display());
            return Ok(probe);
        }
        match probe.parent() {
            Some(parent) => probe = parent.to_path_buf(),
            None => break,
        }
    }

    Err(format!(
        "Could not find a built frontend. A shipped build expects one staged at {}; \
         a dev build uses the repository's own, so run `pnpm build` first (or point \
         PRIVACYTRACKER_DEV_SITE at a directory holding .next/ and public/).",
        staged.display(),
    )
    .into())
}

/// A directory `next build` has written a servable app into. The pages
/// live under `.next/server/app`, which is what the core indexes.
fn is_site(dir: &Path) -> bool {
    dir.join(".next").join("server").join("app").is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_environment_is_the_sidecars_without_a_token() {
        let env = environment(Path::new("/tmp/pt")).expect("utf-8 path");
        assert_eq!(env.get("PRIVACYTRACKER_DATA_DIR").unwrap(), "/tmp/pt");
        assert_eq!(env.get("PRIVACYTRACKER_BIND_HOST").unwrap(), "127.0.0.1");
        assert_eq!(env.get("PRIVACYTRACKER_RUNTIME").unwrap(), "desktop");
        assert!(
            !env.contains_key("AUDITOR_ADMIN_TOKEN"),
            "a token would be a secret on disk the loopback bind makes unnecessary",
        );
        assert!(
            !env.contains_key("PRIVACYTRACKER_NETWORK_EXPOSED"),
            "exposing the server would make it demand the token it has not got",
        );
    }

    #[test]
    fn a_remembered_port_is_read_back_and_nonsense_is_ignored() {
        let dir = std::env::temp_dir().join(format!("pt-port-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        assert_eq!(remembered_port(&dir), None, "nothing remembered yet");

        remember_port(&dir, 49_152);
        assert_eq!(remembered_port(&dir), Some(49_152));

        for bad in ["", "   ", "0", "80", "not-a-port", "70000"] {
            std::fs::write(dir.join(PORT_FILE), bad).expect("write");
            assert_eq!(
                remembered_port(&dir),
                None,
                "{bad:?} is not a port to reuse"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The backend, booted the way [`boot`] boots it: a real database in a
    /// temporary directory, a small build as the site, and the server
    /// asked for a page and an API read before it is stopped.
    ///
    /// One per test binary: the core fixes the data directory and the
    /// environment once per process.
    #[test]
    fn the_server_serves_the_api_and_the_site_over_a_temporary_directory() {
        let root = std::env::temp_dir().join(format!("pt-boot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (data, site) = (root.join("data"), root.join("site"));
        std::fs::create_dir_all(&data).expect("data dir");
        write_site(&site);

        let (handle, addr) = start(&data, &site).expect("the server starts");
        let base = format!("http://{addr}");

        let health = ureq::get(&format!("{base}/api/health"))
            .call()
            .expect("the API answers");
        assert_eq!(health.status(), 200);

        let page = ureq::get(&base).call().expect("the site answers");
        assert_eq!(page.status(), 200);
        // The desktop runtime reached the server through the environment
        // map: its CSP is the one that lets the page talk to Tauri.
        assert!(
            page.header("content-security-policy")
                .is_some_and(|csp| csp.contains("ipc: http://ipc.localhost")),
            "the page should carry the desktop CSP",
        );
        assert!(page.into_string().expect("body").contains("home"));

        assert!(
            data.join("privacy.db").is_file(),
            "the database is in the directory we named, not the process's own",
        );

        tauri::async_runtime::block_on(handle.shutdown(SHUTDOWN_GRACE)).expect("stops");
        assert!(
            std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, addr.port())).is_ok(),
            "the port is free once shutdown returns, so a relaunch can reuse it",
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// The smallest thing the core will serve as a site: the home page,
    /// the not-found page it insists on (every unknown path is answered
    /// with it), and the CSP hashes. CI's Rust job has no `next build`,
    /// so the test writes its own.
    fn write_site(root: &Path) {
        let app = root.join(".next").join("server").join("app");
        std::fs::create_dir_all(&app).expect("site dirs");
        for (stem, html, meta) in [
            (
                "index",
                "<html>home</html>",
                r#"{"headers":{"x-nextjs-prerender":"1"}}"#,
            ),
            (
                "_not-found",
                "<html>404</html>",
                r#"{"status":404,"headers":{"x-nextjs-prerender":"1"}}"#,
            ),
        ] {
            std::fs::write(app.join(format!("{stem}.html")), html).expect("page");
            std::fs::write(app.join(format!("{stem}.meta")), meta).expect("page metadata");
            std::fs::write(app.join(format!("{stem}.rsc")), format!("RSC {stem}"))
                .expect("page payload");
        }
        std::fs::write(
            root.join(".next").join("csp-hashes.json"),
            br#"{"all":["sha256-a"],"routes":{"/":["sha256-a"]}}"#,
        )
        .expect("csp hashes");
    }

    #[test]
    fn a_site_is_a_directory_with_a_built_app() {
        let dir = std::env::temp_dir().join(format!("pt-site-{}", std::process::id()));
        let pages = dir.join(".next").join("server").join("app");
        std::fs::create_dir_all(&pages).expect("temp site");
        assert!(is_site(&dir));
        assert!(
            !is_site(&dir.join(".next")),
            "the build root, not a part of it"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

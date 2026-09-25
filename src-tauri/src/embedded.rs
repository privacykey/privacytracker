#![cfg(feature = "rust-backend")]
//! The Rust backend: this process serves the app itself.
//!
//! Compiled only with `--features rust-backend`. The desktop release and
//! `just tauri-dev` pass it; a build without it spawns the Node sidecar
//! (`sidecar.rs`) instead, which stays buildable for rollback until v0.3.0 has shipped.
//! Everything above this module is unchanged either way: the shell talks
//! to a base URL, and this one is its own.
//!
//! **An upgraded install is tidied.** The Node build extracted its server
//! into the data directory; once this backend is serving, that goes
//! ([`remove_node_leftovers`]).
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

/// What the Node sidecar extracts into the data directory (`sidecar.rs`):
/// its server, about 200 MB, and the markers recording which tarball that
/// came from. Nothing on this path reads any of it.
const NODE_TREE: &str = "standalone";
const NODE_MARKERS: [&str; 2] = [
    ".standalone-extracted-from-size-mtime",
    ".standalone-extracted-from-size",
];

/// Where [`remove_node_leftovers`] moves the tree before deleting it, so a
/// removal cut short leaves something only this module ever names.
const NODE_TREE_REMOVING: &str = ".standalone-removing";

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

    let site = resolve_site_dir(Some(app.path().resource_dir()?))?;
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

/// Bind and serve, then tidy what a Node build left in the data directory.
/// Separate from [`boot`] so the boot test can run the real thing over a
/// temporary data directory and site, with no app.
///
/// One server per process: the data directory and the environment are
/// process state in the core, set once.
pub fn start(data_dir: &Path, site: &Path) -> Result<(ServerHandle, SocketAddr), BoxError> {
    let env = environment(data_dir)?;
    let preferred = remembered_port(data_dir);
    let site = site.to_path_buf();
    let served = tauri::async_runtime::block_on(async move {
        let listener = bind(preferred).await?;
        let addr = listener.local_addr()?;
        let handle = serve_with(
            listener,
            ServeConfig {
                env: Some(env),
                site: Some(site),
                ..ServeConfig::default()
            },
        )
        .await
        .map_err(|e| -> BoxError { e.to_string().into() })?;
        Ok::<_, BoxError>((handle, addr))
    })?;

    // An install upgraded from a Node build still holds the server that
    // build extracted. It goes once this backend is serving: a rollback
    // build extracts its own again when it finds none. Off this thread,
    // because it is tens of thousands of files and the window is waiting.
    let leftovers = data_dir.to_path_buf();
    std::thread::spawn(move || remove_node_leftovers(&leftovers));

    Ok(served)
}

/// `--smoke-server <dir>`: serve over that directory and wait, with no
/// window, no tray and nothing else. The release verifier drives a
/// PACKAGED app through this, which is the only way to prove that what was
/// signed and notarised opens a database and answers: `pt-core` is not in
/// the bundle, and a window would need someone to look at it.
///
/// The directory is a command-line argument, never the environment and
/// never the user's own: a release build ignores `PRIVACYTRACKER_DATA_DIR`,
/// and this mode touches only the directory it was handed.
pub fn smoke(data_dir: &Path) -> ! {
    let site = match resolve_site_dir(resources_beside_executable()) {
        Ok(site) => site,
        Err(e) => {
            eprintln!("smoke server: {e}");
            std::process::exit(1);
        }
    };
    match start(data_dir, &site) {
        Ok((_handle, addr)) => {
            // The verifier reads these two lines: where to talk to it, and
            // which frontend it is serving.
            println!("smoke server listening on http://{addr}");
            println!("smoke server site {}", site.display());
            // Serve until killed. The handle lives as long as this thread.
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        Err(e) => {
            eprintln!("smoke server: {e}");
            std::process::exit(1);
        }
    }
}

/// `Contents/Resources` of the bundle this executable sits in, if it sits
/// in one. `tauri::path` answers this for the running app; the smoke mode
/// has no app, so it walks up from the executable instead.
fn resources_beside_executable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // <app>/Contents/MacOS/<exe> → <app>/Contents/Resources
    Some(exe.parent()?.parent()?.join("Resources"))
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

/// Remove what the Node sidecar extracted into `data_dir`. Best effort: a
/// failure is logged and costs disk space, nothing more.
///
/// It touches only the names above, and the tree only when it is a real
/// directory that looks like the sidecar's: a symlink is left alone, and
/// so is wherever it points.
///
/// The tree is renamed before it is deleted, so `standalone` is only ever
/// whole or gone. An interrupted delete leaves [`NODE_TREE_REMOVING`] for
/// the next launch to finish, and a rollback build that finds no
/// `standalone/server.js` extracts its tarball again whatever its marker
/// says (`sidecar.rs`), so neither build ever runs from a half-deleted tree.
fn remove_node_leftovers(data_dir: &Path) {
    remove_tree(&data_dir.join(NODE_TREE_REMOVING));

    let tree = data_dir.join(NODE_TREE);
    match std::fs::symlink_metadata(&tree) {
        // No tree, so any marker left is stale.
        Err(_) => remove_markers(data_dir),
        // `symlink_metadata` does not follow links: a symlink is not a dir.
        Ok(meta) if meta.is_dir() && looks_like_node_tree(&tree) => {
            remove_markers(data_dir);
            let doomed = data_dir.join(NODE_TREE_REMOVING);
            match std::fs::rename(&tree, &doomed) {
                Ok(()) => {
                    if remove_tree(&doomed) {
                        log::info!("Removed the Node build's server from {}", tree.display());
                    }
                }
                Err(e) => log::warn!(
                    "could not remove the Node build's server at {} ({e})",
                    tree.display()
                ),
            }
        }
        Ok(_) => log::info!(
            "{} is not the Node build's server; leaving it",
            tree.display()
        ),
    }
}

/// The sidecar's tree holds its server and that server's modules; a
/// directory that merely shares the name does not.
fn looks_like_node_tree(dir: &Path) -> bool {
    dir.join("server.js").is_file() || dir.join("node_modules").is_dir()
}

fn remove_markers(data_dir: &Path) {
    for marker in NODE_MARKERS {
        let path = data_dir.join(marker);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("could not remove {} ({e})", path.display()),
        }
    }
}

/// Delete `dir` if it is a real directory (not a symlink). True when it was
/// there and is gone.
fn remove_tree(dir: &Path) -> bool {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => match std::fs::remove_dir_all(dir) {
            Ok(()) => true,
            Err(e) => {
                log::warn!("could not finish removing {} ({e})", dir.display());
                false
            }
        },
        _ => false,
    }
}

/// The directory `next start` would run in: it holds `.next/` and
/// `public/`.
///
/// A shipped build stages it beside the binary, inside the signed bundle,
/// so nothing is extracted into the data directory and nothing writable
/// is ever served. A binary run from target/ uses the repository's own
/// build, which is what `just tauri-dev` produces.
fn resolve_site_dir(resources: Option<PathBuf>) -> Result<PathBuf, BoxError> {
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

    let staged = resources.unwrap_or_default().join("site");
    let exe = std::env::current_exe().ok();
    let cwd = std::env::current_dir()?;
    choose_site(&staged, exe.as_deref(), &cwd).ok_or_else(|| {
        format!(
            "Could not find a built frontend. A shipped build expects one staged at {}; \
             a dev build uses the repository's own, so run `pnpm build` first (or point \
             PRIVACYTRACKER_DEV_SITE at a directory holding .next/ and public/).",
            staged.display(),
        )
        .into()
    })
}

/// Which build to serve: the one staged beside the binary, or the
/// repository's own found from `cwd`.
///
/// A binary inside an app bundle serves the site staged in that bundle. One
/// run straight from target/ (`cargo run`, `just tauri-dev`) serves the
/// repository's build first: a site under target/<profile>/ is only ever a
/// copy an earlier bundle build left there, and preferring it served a
/// stale frontend after every `pnpm build`.
fn choose_site(staged: &Path, exe: Option<&Path>, cwd: &Path) -> Option<PathBuf> {
    if exe.is_some_and(in_app_bundle) && is_site(staged) {
        return Some(staged.to_path_buf());
    }
    if let Some(repository) = repository_build(cwd) {
        return Some(repository);
    }
    is_site(staged).then(|| staged.to_path_buf())
}

/// The repository's own build, walking up from `cwd` as the sidecar's
/// standalone probe does: `tauri dev` runs the binary from src-tauri/,
/// plain `cargo run` from the repository root, and a nested workspace
/// deeper still.
fn repository_build(cwd: &Path) -> Option<PathBuf> {
    let mut probe = cwd.to_path_buf();
    for _ in 0..4 {
        if is_site(&probe) {
            log::info!("Using the repository's own build at {}", probe.display());
            return Some(probe);
        }
        probe = probe.parent()?.to_path_buf();
    }
    None
}

/// Is this executable inside a macOS app bundle
/// (`<name>.app/Contents/MacOS/<exe>`), as every shipped build is?
fn in_app_bundle(exe: &Path) -> bool {
    let macos = exe.parent();
    let contents = macos.and_then(Path::parent);
    let app = contents.and_then(Path::parent);
    macos.and_then(Path::file_name).is_some_and(|name| name == "MacOS")
        && contents.and_then(Path::file_name).is_some_and(|name| name == "Contents")
        && app.and_then(Path::extension).is_some_and(|ext| ext == "app")
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
        // As an install upgraded from the Node build finds it.
        write_node_tree(&data.join(NODE_TREE));

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

        // Starting is what tidies the Node build's server away, on its own
        // thread, so give it a moment.
        let tidied = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(100));
            !data.join(NODE_TREE).exists()
        });
        assert!(
            tidied,
            "the Node build's server should be gone once the backend serves"
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

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// What the sidecar extracts: a server and the modules it requires.
    fn write_node_tree(tree: &Path) {
        let next = tree.join("node_modules").join("next");
        std::fs::create_dir_all(&next).expect("tree");
        std::fs::write(tree.join("server.js"), "require('next')").expect("server");
        std::fs::write(next.join("package.json"), "{}").expect("module");
    }

    #[test]
    fn the_node_builds_server_goes_and_nothing_else_does() {
        let dir = temp("leftovers");
        write_node_tree(&dir.join(NODE_TREE));
        for marker in NODE_MARKERS {
            std::fs::write(dir.join(marker), "196904960:1700000000").expect("marker");
        }
        std::fs::write(dir.join("privacy.db"), "db").expect("database");
        std::fs::write(dir.join(PORT_FILE), "49152").expect("port");

        remove_node_leftovers(&dir);

        assert!(!dir.join(NODE_TREE).exists(), "the tree is gone");
        assert!(
            !dir.join(NODE_TREE_REMOVING).exists(),
            "and so is the name it was moved to"
        );
        for marker in NODE_MARKERS {
            assert!(!dir.join(marker).exists(), "{marker} is gone");
        }
        assert!(dir.join("privacy.db").is_file(), "the database is untouched");
        assert!(dir.join(PORT_FILE).is_file(), "the port file is untouched");

        remove_node_leftovers(&dir);
        assert!(
            dir.join("privacy.db").is_file(),
            "a second launch has nothing to do"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_directory_that_only_shares_the_name_is_left_alone() {
        let dir = temp("not-node");
        std::fs::create_dir_all(dir.join(NODE_TREE)).expect("dir");
        std::fs::write(dir.join(NODE_TREE).join("notes.txt"), "mine").expect("file");

        remove_node_leftovers(&dir);

        assert!(dir.join(NODE_TREE).join("notes.txt").is_file());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_tree_and_what_it_points_at_are_left_alone() {
        let dir = temp("linked");
        let elsewhere = temp("linked-target");
        write_node_tree(&elsewhere);
        std::os::unix::fs::symlink(&elsewhere, dir.join(NODE_TREE)).expect("symlink");
        std::fs::write(dir.join(NODE_MARKERS[0]), "1:1").expect("marker");

        remove_node_leftovers(&dir);

        let link = std::fs::symlink_metadata(dir.join(NODE_TREE)).expect("still there");
        assert!(link.file_type().is_symlink(), "the link itself stays");
        assert!(elsewhere.join("server.js").is_file(), "and so does its target");
        assert!(
            dir.join(NODE_MARKERS[0]).is_file(),
            "nothing is touched in a layout this module did not make"
        );
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&elsewhere).ok();
    }

    #[test]
    fn a_removal_cut_short_is_finished_by_the_next_launch() {
        let dir = temp("interrupted");
        let half_gone = dir.join(NODE_TREE_REMOVING).join("node_modules").join("left");
        std::fs::create_dir_all(&half_gone).expect("half-removed tree");
        std::fs::write(half_gone.join("index.js"), "").expect("file");

        remove_node_leftovers(&dir);

        assert!(!dir.join(NODE_TREE_REMOVING).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn markers_without_a_tree_are_stale_and_go() {
        let dir = temp("markers");
        for marker in NODE_MARKERS {
            std::fs::write(dir.join(marker), "1:1").expect("marker");
        }

        remove_node_leftovers(&dir);

        for marker in NODE_MARKERS {
            assert!(!dir.join(marker).exists(), "{marker} is gone");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bundle_serves_its_own_site_and_a_dev_binary_the_repositorys() {
        let root = temp("choose-site");
        let staged = root.join("target").join("debug").join("site");
        let repository = root.join("repo");
        for site in [&staged, &repository] {
            std::fs::create_dir_all(site.join(".next").join("server").join("app"))
                .expect("site");
        }
        let cwd = repository.join("src-tauri");
        std::fs::create_dir_all(&cwd).expect("cwd");
        let bundled = Path::new("/Applications/privacytracker.app/Contents/MacOS/privacytracker");
        let dev = root.join("target").join("debug").join("privacytracker");
        let elsewhere = root.join("elsewhere");

        assert_eq!(
            choose_site(&staged, Some(bundled), &cwd),
            Some(staged.clone()),
            "a bundle serves the site it carries"
        );
        assert_eq!(
            choose_site(&staged, Some(&dev), &cwd),
            Some(repository.clone()),
            "a dev binary serves the build just made, not a copy left in target/"
        );
        assert_eq!(
            choose_site(&staged, Some(&dev), &elsewhere),
            Some(staged.clone()),
            "with no repository build in reach, the staged copy still serves"
        );
        assert_eq!(
            choose_site(&root.join("missing"), Some(bundled), &elsewhere),
            None,
            "nothing to serve is an error, not a guess"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn only_a_binary_inside_an_app_bundle_counts_as_bundled() {
        assert!(in_app_bundle(Path::new(
            "/Applications/privacytracker.app/Contents/MacOS/privacytracker"
        )));
        for dev in [
            "/repo/src-tauri/target/debug/privacytracker",
            "/repo/src-tauri/target/release/privacytracker",
            "/x/Contents/MacOS/privacytracker",
            "/x/privacytracker.app/MacOS/privacytracker",
            "privacytracker",
        ] {
            assert!(!in_app_bundle(Path::new(dev)), "{dev} is not in a bundle");
        }
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

// Sidecar process management: spawn Node, wait for readiness, resolve URLs.
//
// In a shipped build, the "standalone" Next.js output lives at
// <resources>/standalone/ and the bundled Node binary at
// <resources>/binaries/node(.exe). We set PORT, HOSTNAME=127.0.0.1, and
// PRIVACYTRACKER_DATA_DIR (which lib/db.ts now honours) before exec'ing.
//
// In `tauri dev`, the developer is usually running `npm run dev` themselves
// on a known port. Set PRIVACYTRACKER_DEV_URL=http://127.0.0.1:3000 and we'll
// skip the sidecar spawn and just point the webview at that URL.

use std::fs::{self, File};
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub struct SidecarHandle {
    pub child: Child,
}

impl SidecarHandle {
    /// Gracefully terminate the Node sidecar.
    ///
    /// Called explicitly from main.rs's `RunEvent::ExitRequested` handler.
    /// We can't rely on `Drop` because two things conspire against it:
    ///
    /// 1. `AppState` lives in a `static OnceCell<AppState>`. Rust doesn't
    ///    run destructors on statics at process exit, so the old
    ///    `impl Drop for SidecarHandle` was unreachable in practice —
    ///    which is why the Node binary survived a Tauri quit.
    /// 2. The child was `setsid()`'d in `pre_exec` so it lives in its own
    ///    session. That keeps it out of the macOS Dock, but it also means
    ///    Node does NOT inherit the parent's `SIGHUP` when we exit, so
    ///    the kernel won't reap it for us either.
    ///
    /// Sequence:
    /// 1. `SIGTERM` the entire sidecar process group. The negative-PID
    ///    pattern works because `setsid()` in `pre_exec` made the child
    ///    its own process-group leader (PGID == PID), and `kill(-pgid,
    ///    sig)` signals every process in the group — so any worker
    ///    thread / helper Next.js spawned goes down with it.
    /// 2. Poll `try_wait()` for up to 3 seconds. In practice the Next.js
    ///    HTTP server tears down in well under a second when there are
    ///    no in-flight requests; 3s is the upper bound for Apple-fetch
    ///    requests already in flight.
    /// 3. `SIGKILL` fallback if it's still alive. SQLite WAL is safe
    ///    either way — crash recovery handles SIGKILL.
    ///
    /// Windows has no SIGTERM equivalent that Node's default signal
    /// handling will respect for an offscreen process, so we fall straight
    /// through to `Child::kill` (`TerminateProcess`).
    pub fn shutdown(mut self) {
        #[cfg(unix)]
        {
            let pid = self.child.id() as i32;
            // SAFETY: `kill` is async-signal-safe. The child PID is still
            // valid because we haven't called `wait()` yet, so the OS
            // hasn't recycled it.
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
            log::info!("Sidecar SIGTERM sent to process group {pid}");

            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match self.child.try_wait() {
                    Ok(Some(status)) => {
                        log::info!("Sidecar exited gracefully ({status})");
                        // Skip the Drop safety-net below — we're done.
                        std::mem::forget(self);
                        return;
                    }
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            log::warn!(
                                "Sidecar did not exit within 3s of SIGTERM; sending SIGKILL"
                            );
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(e) => {
                        log::warn!(
                            "try_wait on sidecar failed: {e}; falling back to SIGKILL"
                        );
                        break;
                    }
                }
            }
        }

        // SIGKILL fallback (Unix) / TerminateProcess (Windows).
        let _ = self.child.kill();
        let _ = self.child.wait();
        std::mem::forget(self);
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        // Last-ditch fallback. In normal operation main.rs's
        // `RunEvent::ExitRequested` handler calls `shutdown()` which
        // moves the handle out of state and `mem::forget`s it — so this
        // Drop is unreachable on a clean quit. It only runs if the
        // handle is dropped through a panic-unwind or a future code
        // path we forgot to wire up; better to SIGKILL than orphan.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Boot {
    pub port: u16,
    pub base_url: String,
    pub child: Option<SidecarHandle>,
}

pub fn boot(app: &AppHandle) -> Result<Boot, Box<dyn std::error::Error>> {
    // Dev escape hatch: point at an already-running `npm run dev` so the
    // developer keeps hot reload. Nothing to spawn, nothing to kill.
    if let Ok(url) = std::env::var("PRIVACYTRACKER_DEV_URL") {
        log::info!("Using PRIVACYTRACKER_DEV_URL={url} — skipping sidecar spawn");
        let port = url
            .rsplit(':')
            .next()
            .and_then(|p| p.trim_end_matches('/').parse().ok())
            .unwrap_or(3000);
        return Ok(Boot {
            port,
            base_url: url,
            child: None,
        });
    }

    let port = pick_free_port()?;
    let data_dir = resolve_data_dir(app)?;
    std::fs::create_dir_all(&data_dir)?;

    let server_js = resolve_server_js(app, &data_dir)?;
    let node = resolve_node_binary(&server_js)?;

    log::info!("Spawning sidecar: {} {}", node.display(), server_js.display());
    log::info!("  PORT={port} PRIVACYTRACKER_DATA_DIR={}", data_dir.display());

    let mut cmd = Command::new(&node);
    cmd.arg(&server_js)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("PRIVACYTRACKER_DATA_DIR", &data_dir)
        .env("PRIVACYTRACKER_RUNTIME", "desktop")
        // Parent-watchdog handshake. The Node sidecar polls this PID for
        // liveness on a slow timer (see lib/parent-watchdog.ts) and
        // self-exits if the parent is gone. Belt-and-braces for the
        // SIGTERM path in shutdown(): that path only fires when Tauri's
        // RunEvent::ExitRequested handler runs, which doesn't happen on
        // force-quit (Activity Monitor → Force Quit, `kill -9`, system
        // shutdown, parent panic). Combined with `setsid()` below — which
        // detaches the child from our session so the kernel won't deliver
        // SIGHUP either — an unclean parent exit would otherwise leave
        // the Node process running indefinitely. The watchdog closes
        // that gap.
        .env("PRIVACYTRACKER_PARENT_PID", std::process::id().to_string())
        // Make sure the Node process's cwd is the standalone dir so relative
        // paths Next.js emits (e.g. .next/server/...) resolve correctly.
        .current_dir(server_js.parent().unwrap_or(&PathBuf::from(".")))
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    // Detach the sidecar from our Cocoa app's GUI Services session so it
    // doesn't show up in the macOS Dock as a "node" / "exec" icon. When a
    // Cocoa app (Tauri's wry webview) spawns a subprocess, the child
    // inherits the parent's bind to WindowServer + Dock by default, and
    // any binary with passive AppKit linkage (Node has some, via V8's
    // thread management) gets registered with WindowServer the moment
    // it starts. Calling `setsid()` between fork() and exec() puts the
    // child in its own session — no controlling terminal, no inherited
    // WindowServer connection — so Dock + Activity Monitor stop treating
    // it as a foreground GUI app.
    //
    // SAFETY: `setsid()` is async-signal-safe and explicitly documented
    // as legal between fork() and exec(). The pre_exec closure runs in
    // the child only, after fork but before exec, which is the exact
    // window where this is permitted.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // libc::setsid returns -1 on failure with errno set; we
                // ignore the error because the only way it can fail is
                // "already a process group leader", which means we
                // already have what we want.
                libc::setsid();
                Ok(())
            });
        }
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

    let base_url = format!("http://127.0.0.1:{port}");
    Ok(Boot {
        port,
        base_url,
        child: Some(SidecarHandle { child }),
    })
}

fn pick_free_port() -> io::Result<u16> {
    // Bind to :0, read back the kernel-assigned port, close the socket.
    // There is a theoretical window where another process could grab the
    // port before Node does — in practice this is the standard pattern
    // used by Tauri / Electron / pkg-based apps and the race is fine.
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn resolve_data_dir(_app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Dev override: let developers point at a dedicated sandbox dir without
    // mucking about with their real profile.
    if let Ok(dir) = std::env::var("PRIVACYTRACKER_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }

    // macOS: ~/Library/Application Support/privacytracker
    // Windows: %APPDATA%\privacytracker
    // Linux: $XDG_DATA_HOME/privacytracker or ~/.local/share/privacytracker
    let base = dirs::data_dir().ok_or("could not resolve user data dir")?;
    Ok(base.join("privacytracker"))
}

/// Resolve the standalone Next.js server entry point.
///
/// Shipped builds ship the standalone tree as a single uncompressed
/// tarball at `<resource_dir>/standalone.tar` (see scripts/stage-
/// standalone.mjs). Bundling a tarball rather than a directory tree
/// sidesteps Tauri's resource-glob matcher silently dropping files
/// inside dotfile-prefixed dirs like `.next/server/` — every patch
/// to "make the glob more permissive" left a different file behind.
/// The tarball is extracted into the user's writable data dir on
/// first run, then re-extracted whenever the bundled tarball's size
/// changes (i.e. after an app upgrade) so updates land cleanly.
///
/// Dev runs (`tauri dev`) skip the tarball path and point straight
/// at `.next/standalone/server.js` in the repo, so contributors get
/// fast iteration without paying the extract cost.
fn resolve_server_js(
    app: &AppHandle,
    data_dir: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Explicit dev override. Power users / CI can point at a specific
    // standalone tree (e.g. a sibling worktree) without relying on the
    // cwd-based discovery below. When set, we trust it and never fall
    // through to the production tarball path.
    if let Ok(explicit) = std::env::var("PRIVACYTRACKER_DEV_STANDALONE") {
        let p = PathBuf::from(&explicit);
        if p.exists() {
            log::info!("Using PRIVACYTRACKER_DEV_STANDALONE={}", p.display());
            return Ok(p);
        }
        log::warn!(
            "PRIVACYTRACKER_DEV_STANDALONE={} does not exist — falling through",
            p.display(),
        );
    }

    // Dev fallback — when a freshly-built `.next/standalone/server.js`
    // is reachable from the binary's cwd we use it directly, so a
    // `tauri dev` cycle picks up the latest webpack output without
    // having to round-trip through the bundled tarball + extraction
    // (which would be cached by size and silently miss code changes).
    //
    // `cargo run` invoked by `tauri dev` typically launches the binary
    // with cwd = `<repo>/src-tauri/`, so the freshly-built tree at
    // `<repo>/.next/standalone/server.js` sits ONE directory up. Plain
    // `cargo run` from the repo root puts the cwd at the repo root,
    // which is the historical assumption. We probe both paths so either
    // invocation works — and we walk up to three parent directories so
    // a deeper workspace layout (e.g. `target/debug/foo`) still finds
    // the tree without manual env-var tweaks.
    let cwd = std::env::current_dir()?;
    let mut probe = cwd.clone();
    for _ in 0..4 {
        let candidate = probe.join(".next").join("standalone").join("server.js");
        if candidate.exists() {
            log::info!(
                "Using freshly-built standalone tree at {}",
                candidate.display(),
            );
            return Ok(candidate);
        }
        match probe.parent() {
            Some(parent) => probe = parent.to_path_buf(),
            None => break,
        }
    }

    // Production path: bundled tarball → extract to data_dir on demand.
    let resource_dir = app.path().resource_dir()?;
    let bundled_tar = resource_dir.join("standalone.tar");
    if !bundled_tar.exists() {
        return Err(format!(
            "Could not find the bundled Next.js standalone tarball at {}. \
             A shipped build expects scripts/stage-standalone.mjs to have produced \
             it before `tauri build` ran.",
            bundled_tar.display(),
        ).into());
    }

    // Wait for BeforeDevCommand to finish writing a real tarball.
    //
    // `pnpm tauri:dev` writes a 0-byte stub at `standalone.tar` BEFORE
    // tauri starts (see scripts/ensure-standalone-stub.mjs). The stub
    // exists so cargo's resource-path validator passes during the
    // parallel cargo+BeforeDevCommand phase. But cargo is much faster
    // than BeforeDevCommand (`next build --webpack` + tar = ~30-60s),
    // so without this wait, the Rust binary boots, sees a 0-byte
    // tarball, and tries to extract from emptiness — producing the
    // "server.js still missing" error.
    //
    // Strategy: poll the file size up to 90s. As soon as we see a
    // non-zero file (BeforeDevCommand finished its `tar` AND the
    // atomic rename committed), we proceed. 90s matches the
    // READY_TIMEOUT below — if BeforeDevCommand can't finish in 90s,
    // something else is wrong and the user should see a clean error.
    {
        let wait_start = Instant::now();
        let wait_deadline = wait_start + Duration::from_secs(90);
        let mut last_log = wait_start;
        loop {
            let size = fs::metadata(&bundled_tar).map(|m| m.len()).unwrap_or(0);
            if size > 0 {
                if wait_start.elapsed() > Duration::from_secs(2) {
                    log::info!(
                        "Bundled tarball ready ({} bytes) after waiting {}s",
                        size,
                        wait_start.elapsed().as_secs(),
                    );
                }
                break;
            }
            if Instant::now() >= wait_deadline {
                return Err(format!(
                    "Bundled tarball at {} stayed at 0 bytes for 90s. \
                     `npm run build:standalone:dev` (BeforeDevCommand) appears stuck — \
                     check its log output above for compile errors.",
                    bundled_tar.display(),
                ).into());
            }
            // Log every ~10s while we're still waiting so the dev
            // console doesn't look hung. Helps diagnose whether the
            // wait or the network probe is the slow step.
            if last_log.elapsed() >= Duration::from_secs(10) {
                log::info!(
                    "Waiting for BeforeDevCommand to finish writing standalone.tar… ({}s elapsed)",
                    wait_start.elapsed().as_secs(),
                );
                last_log = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    let extracted_dir = data_dir.join("standalone");
    let server_js = extracted_dir.join("server.js");
    // The marker filename was historically `.standalone-extracted-from-size`
    // when freshness was decided on size alone. We've since added mtime to
    // the comparison (see below) and bumped the marker name accordingly so
    // an in-place upgrade from an older app version triggers a re-extract
    // exactly once — the new code reads the size+mtime marker, doesn't
    // find it, falls back to "no marker" and re-extracts. The legacy
    // marker is also cleaned up below to avoid leaving cruft on disk.
    let marker = data_dir.join(".standalone-extracted-from-size-mtime");
    let legacy_marker = data_dir.join(".standalone-extracted-from-size");

    // Compose a freshness key from BOTH the bundled tar's size and its
    // mtime. The original implementation used size alone, which is
    // resistant to small dev changes (a one-byte diff in any tarred
    // file changes total size) but vulnerable to a specific failure:
    //   1. v1.0 ships a 196904960-byte tarball; user installs.
    //   2. v1.0.1 ships a tarball that happens to also be 196904960
    //      bytes (rare but possible — Next.js standalone trees from
    //      similar releases can land within a single byte of each
    //      other if the diff balances out).
    //   3. Marker matches → reuse stale extraction → broken app.
    //
    // The `Cannot find module 'next'` crash users hit during the dev
    // workflow was the same pattern in disguise: the dev tarball had
    // been written, then partially overwritten, and the size that
    // happened to be on disk when boot raced past it matched the
    // marker. Adding mtime closes this window — a freshly-written
    // tarball gets a new mtime regardless of whether its byte count
    // matches.
    //
    // We don't go all the way to a content hash here because hashing
    // a 100-200MB file on every launch would add noticeable startup
    // latency, and (size, mtime) is what every package manager and
    // backup tool uses for fast-path freshness checks for the same
    // reason. If we ever see a real-world collision, a hash fallback
    // is one extra read away.
    fn freshness_key(meta: &fs::Metadata) -> String {
        // mtime is a best-effort field — some filesystems (FAT32 USB,
        // network mounts) report a coarse-grained value, and the tar
        // crate's `unpack` doesn't preserve mtime on extraction. Both
        // are fine for our purposes: we read mtime off the BUNDLED
        // tarball (a regular ext4/APFS/NTFS file the OS rewrites on
        // every app upgrade) and store the key as opaque text.
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("{}:{}", meta.len(), mtime)
    }

    let bundled_meta = fs::metadata(&bundled_tar)?;
    let bundled_key = freshness_key(&bundled_meta);
    let stored_key = fs::read_to_string(&marker).ok().map(|s| s.trim().to_string());
    let needs_extract = !server_js.exists() || stored_key.as_deref() != Some(&bundled_key);

    if needs_extract {
        log::info!(
            "Extracting bundled standalone tree (key {}) to {}",
            bundled_key,
            extracted_dir.display(),
        );
        // Wipe any stale prior extraction so removed files from the
        // last app version don't linger and confuse server.js.
        if extracted_dir.exists() {
            fs::remove_dir_all(&extracted_dir)
                .map_err(|e| format!("failed to clean stale standalone dir: {e}"))?;
        }
        fs::create_dir_all(&extracted_dir)?;
        let file = File::open(&bundled_tar)
            .map_err(|e| format!("failed to open bundled tarball: {e}"))?;
        let mut archive = tar::Archive::new(file);
        archive
            .unpack(&extracted_dir)
            .map_err(|e| format!("failed to unpack bundled tarball: {e}"))?;
        // Write the marker LAST. If extraction crashes / panics / is
        // SIGKILL'd partway through, the marker stays at its previous
        // value (or absent), so the next boot detects "no marker" or
        // "stale marker" and re-extracts cleanly. Critically, we
        // never write the marker BEFORE the unpack completes — that
        // was the latent class of bug behind partial-extraction
        // states being silently reused on the next boot.
        fs::write(&marker, &bundled_key)
            .map_err(|e| format!("failed to write extraction marker: {e}"))?;
        // Best-effort cleanup of the legacy size-only marker. Failure
        // here is harmless (the file just sits on disk) so we ignore
        // any error to avoid spamming logs after every successful
        // upgrade.
        let _ = fs::remove_file(&legacy_marker);
        log::info!("Standalone extraction complete.");
    } else {
        log::info!(
            "Reusing previously-extracted standalone at {} (key {} unchanged)",
            extracted_dir.display(),
            bundled_key,
        );
    }

    if !server_js.exists() {
        return Err(format!(
            "After extraction, server.js was still missing at {}. \
             Did the tarball end up empty?",
            server_js.display(),
        ).into());
    }

    // Sanity check: server.js boots with `require('next')` at line 1, so
    // a tarball missing `node_modules/next/package.json` produces an
    // immediate "Cannot find module 'next'" crash with no useful
    // diagnostic context. We verify the file is present BEFORE handing
    // control to the spawn path — if it's missing, we delete the stale
    // extraction marker AND the resource tarball, then return an error
    // describing exactly why and how to recover. The Tauri file
    // watcher will pick up the next tarball update (from a freshly-
    // completing BeforeDevCommand) and restart the binary cleanly.
    //
    // This guards against the scenario where a prior `pnpm tauri:dev`
    // session was killed mid-build (Cmd-C, OOM, debugger detach) before
    // stage-standalone.mjs's atomic rename committed, leaving a
    // corrupt resource tarball that an otherwise-happy freshness check
    // would keep blindly reusing.
    let next_pkg = extracted_dir.join("node_modules").join("next").join("package.json");
    if !next_pkg.exists() {
        let _ = fs::remove_file(&marker);
        return Err(format!(
            "Bundled standalone tarball is incomplete — `node_modules/next/package.json` \
             is missing after extraction at {}. This usually means a previous \
             `tauri dev` / `tauri build` was killed before the BeforeDevCommand \
             (`npm run build:standalone:dev`) finished writing the tarball, \
             leaving an unusable copy on disk.\n\
             \n\
             Fix: delete the stale resource tarball and re-run:\n\
               rm {}\n\
               pnpm tauri:dev\n\
             \n\
             The next BeforeDevCommand will write a fresh tarball and the \
             sidecar will extract it cleanly.",
            next_pkg.display(),
            bundled_tar.display(),
        ).into());
    }

    Ok(server_js)
}

/// Resolve the bundled Node binary.
///
/// In a shipped build, Node lives inside a fake `.app` bundle next to
/// the standalone server.js — at `<extracted>/.node-helper.app/Contents/
/// MacOS/node`. The `.app` wrapper is what keeps the Node process out
/// of the macOS Dock: LaunchServices reads the helper bundle's
/// Info.plist (with `LSUIElement=true`) when launching the binary,
/// applying the activation policy *before* CoreFoundation auto-
/// registers the process with WindowServer. Trying to do this with a
/// bare Mach-O binary plus an embedded `__info_plist` section, or with
/// a wrapper that calls `TransformProcessType` after the fact, didn't
/// reliably keep the Dock clean — by the time those mechanisms ran,
/// the process had already been picked up. The .app bundle layout is
/// what Electron / Chrome use for their helper processes for the
/// same reason.
///
/// Dev runs (`tauri dev`) point at `.next/standalone/server.js` in the
/// repo and don't have the helper bundle staged, so we fall through to
/// the host's `node` on PATH. The Dock-icon issue still appears in dev
/// — that's an accepted trade-off for fast iteration.
fn resolve_node_binary(server_js: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };

    // (1) Production path: <server.js's parent>/.node-helper.app/
    //     Contents/MacOS/node. The helper bundle was created at
    //     stage-standalone time and tarballed into the .app bundle,
    //     and sidecar.rs's resolve_server_js extracted the whole tree
    //     into `<data_dir>/standalone/` before we got here. So
    //     server.js's parent dir is the same dir that contains
    //     `.node-helper.app/`.
    if let Some(parent) = server_js.parent() {
        let helper = parent
            .join(".node-helper.app")
            .join("Contents")
            .join("MacOS")
            .join(exe);
        if helper.exists() {
            return Ok(helper);
        }
    }

    // (2) Dev fallback. `tauri dev` doesn't extract a helper bundle,
    //     so we use whatever `node` is on PATH. Ensure its major
    //     version matches what better-sqlite3 was compiled against
    //     (Node 24 LTS, pinned via NODE_VERSION in the macOS-release
    //     workflow). The Dock icon may briefly appear in this path —
    //     accepted for dev-iteration speed.
    Ok(PathBuf::from(exe))
}

/// How long we're willing to wait for the spawned Node sidecar to come
/// up before declaring it dead. Was 30s, bumped to 60s because:
///   1. The standalone tree extraction can take 5-10s on a slow disk
///      (the bundle is ~200MB after the echarts 6.0 bump).
///   2. Next.js's first-request cold-start adds another 5-15s after
///      the HTTP server binds — we probe /api/apps which actually
///      compiles a route on first hit.
///   3. On `tauri dev` cold boot, BeforeDevCommand and DevCommand run
///      in parallel; if BeforeDevCommand is mid-`tar` while the Rust
///      binary is mid-extraction, we want headroom for the file
///      watcher to catch the new tarball and restart cleanly.
/// 60s is generous in the happy path (the success log usually fires
/// in <5s) but eliminates spurious failures during cold starts.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

pub fn wait_until_ready(base_url: &str) -> Result<(), Box<dyn std::error::Error>> {
    let target = format!("{base_url}/api/apps");
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut attempt = 0u32;
    while Instant::now() < deadline {
        attempt += 1;
        match ureq::get(&target).timeout(Duration::from_secs(2)).call() {
            Ok(resp) if resp.status() < 500 => {
                log::info!("Sidecar ready after {attempt} probes");
                return Ok(());
            }
            Ok(_) | Err(_) => {
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
    Err(format!(
        "sidecar did not become ready within {}s at {base_url}",
        READY_TIMEOUT.as_secs(),
    ).into())
}

// Note: an earlier `read_desktop_hide_dock` helper used to live here, hitting
// /api/settings/desktop just to extract the single `desktop_hide_dock` field.
// It was superseded by `settings::fetch()` (returns the full
// `DesktopSettings` bundle including `hide_dock`), which is what main.rs
// actually calls on boot. Kept this comment as a breadcrumb so anyone hunting
// for the helper finds the new entry point.

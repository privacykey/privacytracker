//! The shell's view of its backend: where it is, how it stops, and the one
//! way the shell sends it a mutating request.
//!
//! Which backend that is, is decided when the shell is compiled:
//!
//! - by default, the bundled Node sidecar (`sidecar.rs`), a second process
//!   running Next.js;
//! - with `--features rust-backend`, the Rust core served from this
//!   process (`embedded.rs`).
//!
//! Everything else in the shell is written against this module and does
//! not know which one it got. Shipped builds stay on Node until the
//! cutover release, so the feature is off by default and CI compiles both.

use std::path::PathBuf;

/// Where the backend is, and the handle that stops it.
pub struct Boot {
    pub port: u16,
    pub base_url: String,
    /// `None` when the shell attached to a server it does not own: a
    /// developer's own dev server behind `PRIVACYTRACKER_DEV_URL`.
    pub running: Option<Running>,
}

#[cfg(not(feature = "rust-backend"))]
pub use crate::sidecar::{boot, SidecarHandle as Running};

#[cfg(feature = "rust-backend")]
pub use crate::embedded::{boot, EmbeddedServer as Running};

/// The per-user data directory, and therefore the database. The same path
/// on both backends, so either build opens what the other wrote.
///
/// macOS: `~/Library/Application Support/privacytracker`.
/// Windows: `%APPDATA%\privacytracker`.
/// Linux: `$XDG_DATA_HOME/privacytracker` or `~/.local/share/privacytracker`.
pub fn resolve_data_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Dev override: a sandbox directory instead of the real profile.
    // Debug builds only, as a release build that honoured it could be
    // pointed elsewhere by anyone who can write the user's environment.
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("PRIVACYTRACKER_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }

    let base = dirs::data_dir().ok_or("could not resolve user data dir")?;
    Ok(base.join("privacytracker"))
}

/// Start a POST to the backend at `base_url` + `path`. Every mutating
/// request the shell sends goes through here (a test below fails on a
/// bare ureq mutation anywhere else in the shell), because the CSRF gate
/// answers a mutating `/api` request with 403 "Cross-origin mutation
/// rejected" unless its `Origin` matches the Host it was sent to or it
/// carries the admin token. The webview's own fetches get an Origin from
/// the browser. ureq sends none, and the desktop has no admin token:
/// neither backend is given one.
///
/// The Origin is serialised from the same parsed URL that ureq writes
/// `Host` from, so the two agree whatever the base URL looks like: a
/// trailing slash, `localhost` from `PRIVACYTRACKER_DEV_URL`, or a default
/// port that ureq leaves off Host.
pub fn post(base_url: &str, path: &str) -> ureq::Request {
    let url = format!("{}{path}", base_url.trim_end_matches('/'));
    let request = ureq::post(&url);
    match origin_of(&url) {
        Some(origin) => request.set("Origin", &origin),
        // Not an http(s) URL. ureq refuses it when the request is sent.
        None => request,
    }
}

/// `scheme://host[:port]` of `url`: what a page served from that origin
/// sends as `Origin`.
fn origin_of(url: &str) -> Option<String> {
    let origin = tauri::Url::parse(url).ok()?.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn origin_is_what_ureq_sends_as_host() {
        assert_eq!(
            origin_of("http://127.0.0.1:49152/api/settings/desktop").as_deref(),
            Some("http://127.0.0.1:49152"),
        );
        // A PRIVACYTRACKER_DEV_URL (debug builds only) can name localhost.
        assert_eq!(
            origin_of("http://localhost:3000/api/sync/trigger").as_deref(),
            Some("http://localhost:3000"),
        );
        // ureq leaves a scheme's default port off Host; so does the origin.
        assert_eq!(
            origin_of("http://127.0.0.1:80/api/sync/trigger").as_deref(),
            Some("http://127.0.0.1"),
        );
        assert_eq!(origin_of("127.0.0.1:3000/api/sync/trigger"), None);
    }

    #[test]
    fn post_joins_the_path_and_sets_origin() {
        let request = post(
            "http://127.0.0.1:49152/",
            "/api/wayback/import-all?stream=1",
        );
        assert_eq!(request.method(), "POST");
        assert_eq!(
            request.url(),
            "http://127.0.0.1:49152/api/wayback/import-all?stream=1",
        );
        assert_eq!(request.header("Origin"), Some("http://127.0.0.1:49152"));
    }

    /// A ureq mutation that bypasses `post` goes out with no Origin and
    /// is refused with a 403, so the helper's own call must be the only
    /// one in the shell.
    #[test]
    fn every_shell_mutation_goes_through_post() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut helper_calls = 0;
        let mut offenders = Vec::new();
        for (path, text) in rust_sources(&src) {
            for method in ["post", "put", "patch", "delete", "request"] {
                // Assembled at runtime so this test doesn't match itself.
                let needle = format!("ureq::{method}(");
                let count = text.matches(needle.as_str()).count();
                if method == "post" && path.ends_with("backend.rs") {
                    helper_calls = count;
                } else if count > 0 {
                    offenders.push(format!("{} calls {needle}", path.display()));
                }
            }
        }
        // Proves the scan read the shell's sources rather than nothing.
        assert_eq!(
            helper_calls, 1,
            "expected backend::post's own call in backend.rs"
        );
        assert!(
            offenders.is_empty(),
            "send shell mutations through backend::post so they carry an Origin: {offenders:?}",
        );
    }

    fn rust_sources(dir: &Path) -> Vec<(PathBuf, String)> {
        let mut sources = Vec::new();
        for entry in fs::read_dir(dir).expect("read source dir") {
            let path = entry.expect("source dir entry").path();
            if path.is_dir() {
                sources.extend(rust_sources(&path));
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let text = fs::read_to_string(&path).expect("read source file");
                sources.push((path, text));
            }
        }
        sources
    }
}

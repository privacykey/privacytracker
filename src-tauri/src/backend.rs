//! The shell's view of its backend: where it is, how it stops, where the
//! window goes first, and the one way the shell sends it a request.
//!
//! Which backend that is, is decided when the shell is compiled:
//!
//! - by default, the bundled Node sidecar (`sidecar.rs`), a second process
//!   running Next.js;
//! - with `--features rust-backend`, the Rust core served from this
//!   process (`embedded.rs`).
//!
//! Everything else in the shell is written against this module and does
//! not know which one it got. The feature is off in Cargo's default set so
//! a build without it stays the pure Node rollback, and CI compiles both.
//!
//! **The launch credential.** The Rust backend answers `/api` only to a
//! caller holding the credential it was started with, which is minted
//! afresh every launch (`embedded.rs`). The shell's own requests carry it
//! in [`CREDENTIAL_HEADER`] because they go through [`get`] and [`post`];
//! a test below fails on a request built anywhere else. The Node sidecar
//! is started without one, and nothing is sent to it.

use std::path::PathBuf;
use std::sync::OnceLock;

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

/// The header the shell's requests carry the launch credential in. The
/// Rust backend reads the same name; a test in `embedded.rs` holds the two
/// together.
pub const CREDENTIAL_HEADER: &str = "x-privacytracker-desktop-token";

/// This launch's credential, once the embedded backend has minted it.
/// Unset on the Node path and when attached to a developer's own server.
static CREDENTIAL: OnceLock<String> = OnceLock::new();

/// Record the credential the embedded backend was started with. Once per
/// process, like the backend itself.
#[cfg(feature = "rust-backend")]
pub(crate) fn set_credential(credential: String) {
    if CREDENTIAL.set(credential).is_err() {
        log::warn!("the launch credential was already set; keeping the first");
    }
}

#[cfg(feature = "rust-backend")]
pub(crate) fn has_credential() -> bool {
    CREDENTIAL.get().is_some()
}

fn with_credential(request: ureq::Request) -> ureq::Request {
    attach(request, CREDENTIAL.get().map(String::as_str))
}

fn attach(request: ureq::Request, credential: Option<&str>) -> ureq::Request {
    match credential {
        Some(credential) => request.set(CREDENTIAL_HEADER, credential),
        None => request,
    }
}

fn join(base_url: &str, path: &str) -> String {
    format!("{}{path}", base_url.trim_end_matches('/'))
}

/// Where the window is pointed at boot. On the Rust backend that is a
/// one-time sign-in link, which hands the webview this launch's
/// credential as an HttpOnly cookie and redirects to the start page, so
/// page scripts never see it. Otherwise it is the base URL itself.
pub fn entry_url(base_url: &str) -> String {
    #[cfg(feature = "rust-backend")]
    {
        crate::embedded::entry_url(base_url)
    }
    #[cfg(not(feature = "rust-backend"))]
    {
        base_url.to_string()
    }
}

/// Start a GET to the backend at `base_url` + `path`, carrying the launch
/// credential. Every read the shell sends goes through here.
pub fn get(base_url: &str, path: &str) -> ureq::Request {
    with_credential(ureq::get(&join(base_url, path)))
}

/// Start a POST to the backend at `base_url` + `path`. Every mutating
/// request the shell sends goes through here (a test below fails on a
/// bare ureq request anywhere else in the shell). It carries the launch
/// credential, and an `Origin` as well: the CSRF gate answers a mutating
/// `/api` request with 403 "Cross-origin mutation rejected" unless its
/// `Origin` matches the Host it was sent to or it carries a token header,
/// and the Node sidecar, which has no launch credential, still needs the
/// Origin. The webview's own fetches get an Origin from the browser. ureq
/// sends none, and the desktop has no admin token: neither backend is
/// given one.
///
/// The Origin is serialised from the same parsed URL that ureq writes
/// `Host` from, so the two agree whatever the base URL looks like: a
/// trailing slash, `localhost` from `PRIVACYTRACKER_DEV_URL`, or a default
/// port that ureq leaves off Host.
pub fn post(base_url: &str, path: &str) -> ureq::Request {
    let url = join(base_url, path);
    let request = with_credential(ureq::post(&url));
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

    #[test]
    fn get_joins_the_path() {
        let request = get("http://127.0.0.1:49152/", "/api/notifications");
        assert_eq!(request.method(), "GET");
        assert_eq!(request.url(), "http://127.0.0.1:49152/api/notifications");
    }

    /// With a credential, a request carries it; with none (the Node
    /// sidecar, a developer's own server) nothing extra is sent. The
    /// process-wide credential is left alone here: the embedded boot test
    /// sets the real one, and proves both helpers send it by being let in.
    #[test]
    fn a_request_carries_the_credential_only_when_there_is_one() {
        let with = attach(ureq::agent().get("http://127.0.0.1:1/"), Some("abc"));
        assert_eq!(with.header(CREDENTIAL_HEADER), Some("abc"));
        let without = attach(ureq::agent().get("http://127.0.0.1:1/"), None);
        assert_eq!(without.header(CREDENTIAL_HEADER), None);

        // Nothing on the Node path ever sets one.
        #[cfg(not(feature = "rust-backend"))]
        for request in [
            get("http://127.0.0.1:49152", "/api/apps"),
            post("http://127.0.0.1:49152", "/api/sync/trigger"),
        ] {
            assert_eq!(request.header(CREDENTIAL_HEADER), None);
        }
    }

    /// A ureq request that bypasses `get` and `post` goes out with no
    /// launch credential (and, for a mutation, no Origin) and is refused,
    /// so the helpers' own calls must be the only ones in the shell's
    /// production code. Test modules are left out: they speak to the
    /// server without the credential on purpose, to prove it is refused.
    #[test]
    fn every_shell_request_goes_through_the_helpers() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let (mut get_calls, mut post_calls) = (0, 0);
        let mut offenders = Vec::new();
        for (path, text) in rust_sources(&src) {
            let code = production_code(&text);
            for method in ["get", "post", "put", "patch", "delete", "head", "request"] {
                // Assembled at runtime so this test doesn't match itself.
                let needle = format!("ureq::{method}(");
                let count = code.matches(needle.as_str()).count();
                match (method, path.ends_with("backend.rs")) {
                    ("get", true) => get_calls = count,
                    ("post", true) => post_calls = count,
                    _ if count > 0 => {
                        offenders.push(format!("{} calls {needle}", path.display()));
                    }
                    _ => {}
                }
            }
        }
        // Proves the scan read the shell's sources rather than nothing.
        assert_eq!(
            get_calls, 1,
            "expected backend::get's own call in backend.rs"
        );
        assert_eq!(
            post_calls, 1,
            "expected backend::post's own call in backend.rs"
        );
        assert!(
            offenders.is_empty(),
            "send shell requests through backend::get or backend::post so they carry the \
             launch credential (and an Origin): {offenders:?}",
        );
    }

    /// A source file up to its test module.
    fn production_code(text: &str) -> &str {
        // Assembled at runtime so this file's own marker is found, not
        // this line.
        let marker = format!("#[cfg(test)]\n{}", "mod tests");
        text.find(&marker).map_or(text, |at| &text[..at])
    }

    #[test]
    fn the_scan_stops_at_the_test_module() {
        let marker = format!("#[cfg(test)]\n{}", "mod tests {");
        let text = format!("fn a() {{ ureq::x(); }}\n{marker}\n fn b() {{ ureq::y(); }}\n}}");
        assert_eq!(production_code(&text), "fn a() { ureq::x(); }\n");
        assert_eq!(production_code("fn a() {}"), "fn a() {}");
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

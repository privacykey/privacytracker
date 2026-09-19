//! The environment the server reads its settings from.
//!
//! `pt-core` reads the process environment, as `next start` does. A host
//! that embeds the server (the Tauri shell, from Phase 6) hands it an
//! environment instead, and from then on the server sees exactly that map
//! and nothing else — what the shell's `env_clear()` gave the Node sidecar.
//! Without it an embedded server would read the desktop app's own
//! environment: a stray `AUDITOR_ADMIN_TOKEN` or
//! `PRIVACYTRACKER_NETWORK_EXPOSED` there would change who may call the API,
//! and the missing `PRIVACYTRACKER_BIND_HOST` would make it demand a token
//! (see `server::trust`, which fails closed).
//!
//! Every setting the crate reads goes through [`var`]. `std::env::var` is
//! left to tests, which set and restore variables around a case, and to
//! `TZ`, which the C library reads for itself.

use std::collections::HashMap;
use std::env::VarError;
use std::sync::OnceLock;

static HOST_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// `std::env::var`, or the host's environment once [`fix`] has set one.
pub fn var(name: &str) -> Result<String, VarError> {
    lookup(HOST_ENV.get(), name)
}

fn lookup(host: Option<&HashMap<String, String>>, name: &str) -> Result<String, VarError> {
    match host {
        Some(env) => env.get(name).cloned().ok_or(VarError::NotPresent),
        None => std::env::var(name),
    }
}

/// Fix the environment for the rest of the process. Some settings are read
/// once and kept (the data directory is), so a second, different
/// environment could never take effect: asking for one is an error, and
/// asking for the same one again is not.
pub(crate) fn fix(env: HashMap<String, String>) -> Result<(), String> {
    let fixed = HOST_ENV.get_or_init(|| env.clone());
    if *fixed == env {
        Ok(())
    } else {
        Err(
            "the server's environment is already fixed to a different set of \
             variables; run one embedded server per process"
                .to_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed environment answers from the map alone: a variable the
    /// process has is absent unless the host passed it. `PATH` is set in
    /// every environment `cargo test` runs in.
    #[test]
    fn a_fixed_environment_hides_the_process_environment() {
        assert!(std::env::var("PATH").is_ok(), "the test needs PATH set");
        let host: HashMap<String, String> =
            [("PRIVACYTRACKER_RUNTIME".to_string(), "desktop".to_string())].into();
        assert_eq!(lookup(Some(&host), "PATH"), Err(VarError::NotPresent));
        assert_eq!(
            lookup(Some(&host), "PRIVACYTRACKER_RUNTIME").as_deref(),
            Ok("desktop")
        );
        assert_eq!(
            lookup(Some(&HashMap::new()), "PATH"),
            Err(VarError::NotPresent)
        );
    }

    /// With no host environment, reads fall through to the process, so
    /// `pt-core` and every test that sets a variable behave as before.
    #[test]
    fn without_a_host_environment_the_process_environment_is_read() {
        assert_eq!(lookup(None, "PATH"), std::env::var("PATH"));
        assert_eq!(
            lookup(None, "PRIVACYTRACKER_SURELY_NEVER_SET_1B6E7D6"),
            Err(VarError::NotPresent)
        );
    }
}

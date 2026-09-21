//! `pt-core` — the Phase 1 command-line entry.
//!
//! One job for now: open a `privacy.db` and bring its schema up to the
//! current contract, exactly as `lib/db.ts` would. The schema-parity
//! harness drives this against fresh, legacy and current fixtures and then
//! dumps the result with the same Node dumper it uses for the TypeScript
//! side, so only the migrator differs between the two.
//!
//!   pt-core migrate <path/to/privacy.db>   open + migrate in place
//!   pt-core serve [--host IP] [--port N] [--site DIR]
//!                                           serve <PRIVACYTRACKER_DATA_DIR|cwd/data>/privacy.db (and DIR's build)
//!   pt-core version                         print crate + SQLite versions
//!
//! `serve` stops on SIGINT or SIGTERM, giving requests in flight three
//! seconds (`server::SHUTDOWN_GRACE`).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;

use privacytracker_core::server::ServeConfig;

const SERVE_USAGE: &str = "usage: pt-core serve [--host IP] [--port N] [--site DIR]   \
(set PRIVACYTRACKER_DATA_DIR, else <cwd>/data is used)";

/// `pt-core serve`'s options, and nothing else: an option this does not know
/// is refused, where it used to be ignored, which left a
/// `--hostname 0.0.0.0` server quietly listening on loopback only.
#[derive(Debug, PartialEq)]
struct ServeArgs {
    /// `--host`: the address to listen on. Unset is loopback.
    host: Option<IpAddr>,
    /// `--port`, else `PORT` as `next start` reads it, else 0 (any free
    /// port; the bound address is printed for a supervising script).
    port: u16,
    /// `--site`: the directory `next start` would run in. With it, the
    /// frontend is served from its `.next` build and `public/` too.
    site: Option<PathBuf>,
}

impl ServeArgs {
    /// The data directory is not an argument: it comes from the environment
    /// exactly as in lib/db.ts (PRIVACYTRACKER_DATA_DIR, else <cwd>/data),
    /// so the deployment diagnostics report `dataDirSource` with the same
    /// two answers Node has.
    fn parse(args: &[String], port_env: Option<&str>) -> Result<Self, String> {
        fn value<'a>(
            rest: &mut std::slice::Iter<'a, String>,
            option: &str,
        ) -> Result<&'a String, String> {
            rest.next().ok_or_else(|| format!("{option} needs a value"))
        }

        let (mut host, mut port, mut site) = (None, None, None);
        let mut rest = args.iter();
        while let Some(arg) = rest.next() {
            match arg.as_str() {
                "--host" => {
                    let raw = value(&mut rest, "--host")?;
                    host = Some(raw.parse::<IpAddr>().map_err(|_| {
                        format!(
                            "--host needs an IP address, like 0.0.0.0 or 127.0.0.1, not {raw:?}"
                        )
                    })?);
                }
                "--port" => {
                    let raw = value(&mut rest, "--port")?;
                    port = Some(
                        raw.parse::<u16>()
                            .map_err(|_| format!("--port needs a port number, not {raw:?}"))?,
                    );
                }
                "--site" => site = Some(PathBuf::from(value(&mut rest, "--site")?)),
                other if other.starts_with('-') => {
                    return Err(format!("unknown option {other:?}"));
                }
                other => {
                    return Err(format!(
                        "unexpected argument {other:?}: the data directory comes from \
                         PRIVACYTRACKER_DATA_DIR, not the command line"
                    ));
                }
            }
        }

        let port = match (port, port_env.map(str::trim).filter(|p| !p.is_empty())) {
            (Some(port), _) => port,
            (None, Some(env)) => env
                .parse()
                .map_err(|_| format!("PORT is not a port number: {env:?}"))?,
            (None, None) => 0,
        };
        Ok(Self { host, port, site })
    }

    fn addr(&self) -> SocketAddr {
        SocketAddr::new(
            self.host.unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            self.port,
        )
    }
}

/// With `--host`, the server's environment is this process's own with
/// `PRIVACYTRACKER_BIND_HOST` set to that host, as `scripts/start-next.mjs`
/// hands Node its `-H`: the security checks classify the bind from that
/// variable, so it must say where the server really listens. Without
/// `--host` the process environment is read as it always was.
fn environment_bound_to(
    host: IpAddr,
    process: impl Iterator<Item = (String, String)>,
) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = process.collect();
    env.insert("PRIVACYTRACKER_BIND_HOST".to_string(), host.to_string());
    env
}

/// The process environment as strings. A variable whose name or value is not
/// UTF-8 is one `std::env::var` would not return either.
fn process_environment() -> impl Iterator<Item = (String, String)> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
}

/// Where `pt-core` sends the library's log lines: warnings and errors to
/// stderr, the rest to stdout, as the prints they replaced did. Only this
/// crate's lines; the HTTP stack logs through the same facade.
struct Console;

impl log::Log for Console {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info && metadata.target().starts_with("privacytracker_core")
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        match record.level() {
            log::Level::Error | log::Level::Warn => eprintln!("{}", record.args()),
            _ => println!("{}", record.args()),
        }
    }

    fn flush(&self) {}
}

static CONSOLE: Console = Console;

fn main() -> ExitCode {
    if log::set_logger(&CONSOLE).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("migrate") => {
            let Some(path) = args.get(2) else {
                eprintln!("usage: pt-core migrate <path/to/privacy.db>");
                return ExitCode::from(2);
            };
            match privacytracker_core::migrate_file(path) {
                Ok(()) => {
                    println!("pt-core: migrated {path}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("pt-core: migrate failed for {path}: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("serve") => {
            let port_env = std::env::var("PORT").ok();
            let serve = match ServeArgs::parse(&args[2..], port_env.as_deref()) {
                Ok(serve) => serve,
                Err(problem) => {
                    eprintln!("pt-core: {problem}\n{SERVE_USAGE}");
                    return ExitCode::from(2);
                }
            };
            let addr = serve.addr();
            let config = ServeConfig {
                env: serve
                    .host
                    .map(|host| environment_bound_to(host, process_environment())),
                site: serve.site,
                ..ServeConfig::default()
            };
            let rt = match tokio::runtime::Runtime::new() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("pt-core: could not start the async runtime: {e}");
                    return ExitCode::FAILURE;
                }
            };
            match rt.block_on(privacytracker_core::server::serve(addr, config)) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("pt-core: serve failed: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("version") => {
            let conn = rusqlite::Connection::open_in_memory().expect("open in-memory");
            let sqlite: String = conn
                .query_row("SELECT sqlite_version()", [], |r| r.get(0))
                .unwrap_or_else(|_| "unknown".into());
            println!(
                "pt-core {} (rusqlite bundled SQLite {})",
                env!("CARGO_PKG_VERSION"),
                sqlite
            );
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: pt-core <migrate|serve|version> [args]");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str], port_env: Option<&str>) -> Result<ServeArgs, String> {
        let args: Vec<String> = args.iter().map(ToString::to_string).collect();
        ServeArgs::parse(&args, port_env)
    }

    #[test]
    fn the_defaults_are_loopback_on_any_free_port() {
        let serve = parse(&[], None).expect("no options");
        assert_eq!(
            serve,
            ServeArgs {
                host: None,
                port: 0,
                site: None
            }
        );
        assert_eq!(serve.addr(), "127.0.0.1:0".parse().unwrap());
    }

    #[test]
    fn the_host_the_port_and_the_site_are_read() {
        let serve = parse(
            &["--host", "0.0.0.0", "--port", "3000", "--site", "/app/site"],
            None,
        )
        .expect("options");
        assert_eq!(serve.addr(), "0.0.0.0:3000".parse().unwrap());
        assert_eq!(serve.site, Some(PathBuf::from("/app/site")));
        assert_eq!(
            parse(&["--host", "::"], None).expect("ipv6").addr(),
            "[::]:0".parse().unwrap()
        );
    }

    #[test]
    fn the_port_falls_back_to_the_port_variable_as_next_start_does() {
        assert_eq!(parse(&[], Some("8080")).unwrap().port, 8080);
        assert_eq!(
            parse(&["--port", "3000"], Some("8080")).unwrap().port,
            3000,
            "the option wins over the variable"
        );
        assert_eq!(
            parse(&[], Some("  ")).unwrap().port,
            0,
            "a blank variable is unset"
        );
        assert!(parse(&[], Some("eighty")).is_err());
    }

    #[test]
    fn anything_unknown_is_refused_rather_than_ignored() {
        let refused = |args: &[&str]| parse(args, None).expect_err("refused");
        // The case that used to leave the server on loopback, silently.
        assert!(refused(&["--hostname", "0.0.0.0"]).contains("unknown option"));
        assert!(refused(&["-H", "0.0.0.0"]).contains("unknown option"));
        assert!(refused(&["data"]).contains("PRIVACYTRACKER_DATA_DIR"));
        assert!(refused(&["--host"]).contains("needs a value"));
        assert!(refused(&["--host", "localhost"]).contains("IP address"));
        assert!(refused(&["--port", "70000"]).contains("port number"));
    }

    #[test]
    fn a_chosen_host_is_what_the_security_checks_see() {
        let process = [
            ("PRIVACYTRACKER_BIND_HOST", "127.0.0.1"),
            ("AUDITOR_ADMIN_TOKEN", "secret"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let env = environment_bound_to("0.0.0.0".parse().unwrap(), process);
        assert_eq!(
            env["PRIVACYTRACKER_BIND_HOST"], "0.0.0.0",
            "the listener wins over a stale variable"
        );
        assert_eq!(
            env["AUDITOR_ADMIN_TOKEN"], "secret",
            "everything else is the process's own"
        );
    }
}

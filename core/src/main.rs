//! `pt-core` — the Phase 1 command-line entry.
//!
//! One job for now: open a `privacy.db` and bring its schema up to the
//! current contract, exactly as `lib/db.ts` would. The schema-parity
//! harness drives this against fresh, legacy and current fixtures and then
//! dumps the result with the same Node dumper it uses for the TypeScript
//! side, so only the migrator differs between the two.
//!
//!   pt-core migrate <path/to/privacy.db>   open + migrate in place
//!   pt-core serve [--port N]                serve <PRIVACYTRACKER_DATA_DIR|cwd/data>/privacy.db
//!   pt-core version                         print crate + SQLite versions

use std::process::ExitCode;

fn main() -> ExitCode {
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
            // The data directory comes from the environment, exactly as in
            // lib/db.ts: PRIVACYTRACKER_DATA_DIR, else <cwd>/data. A path
            // argument used to be accepted here; it went away so that the
            // deployment diagnostics can report `dataDirSource` with the
            // same two answers Node has.
            if args.get(2).map(|a| !a.starts_with("--")).unwrap_or(false) {
                eprintln!(
                    "usage: pt-core serve [--port N]   (set PRIVACYTRACKER_DATA_DIR, else <cwd>/data is used)"
                );
                return ExitCode::from(2);
            }
            // Default 0 = let the OS pick; the bound address is printed so a
            // supervising script reads it rather than guessing.
            let port: u16 = match args.iter().position(|a| a == "--port") {
                Some(i) => match args.get(i + 1).and_then(|p| p.parse().ok()) {
                    Some(p) => p,
                    None => {
                        eprintln!("pt-core: --port needs a number");
                        return ExitCode::from(2);
                    }
                },
                None => 0,
            };
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            let rt = match tokio::runtime::Runtime::new() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("pt-core: could not start the async runtime: {e}");
                    return ExitCode::FAILURE;
                }
            };
            match rt.block_on(privacytracker_core::server::serve(addr)) {
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

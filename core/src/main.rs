//! `pt-core` — the Phase 1 command-line entry.
//!
//! One job for now: open a `privacy.db` and bring its schema up to the
//! current contract, exactly as `lib/db.ts` would. The schema-parity
//! harness drives this against fresh, legacy and current fixtures and then
//! dumps the result with the same Node dumper it uses for the TypeScript
//! side, so only the migrator differs between the two.
//!
//!   pt-core migrate <path/to/privacy.db>   open + migrate in place
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
            eprintln!("usage: pt-core <migrate|version> [args]");
            ExitCode::from(2)
        }
    }
}

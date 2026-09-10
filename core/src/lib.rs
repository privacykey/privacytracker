//! privacytracker Rust core.
//!
//! Phase 1 of the Rust-core migration (see `core/README.md`): reproduce the
//! `lib/db.ts` SQLite schema + migration contract exactly, so an existing
//! `privacy.db` opens and migrates to a state byte-for-byte identical to
//! what the Node/Next server produces. Nothing else is ported yet — no API,
//! no scraper. The correctness gate is `scripts/parity/schema-parity.mjs`,
//! which diffs a Rust-migrated DB against a TypeScript-migrated one from the
//! same starting point.
//!
//! Phase 2 adds the read-only HTTP API in `server`, gated by the dual-live
//! parity harness (`scripts/parity/read-parity.mjs`), which byte-compares
//! this server's responses against the running Node server's.

pub mod db;
pub mod jsnum;
mod schema_sql;
pub mod server;

pub use db::{migrate_file, open_and_migrate};

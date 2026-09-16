//! Phase 3, batch 1: the App Store page parser.
//!
//! `fetchAndParseApp` in lib/scraper.ts runs from a URL to a committed row
//! set. This module is the middle of it — HTML in, the pre-commit parse
//! out — and nothing else yet: no fetch (batch 3), no statements, no
//! snapshot diff, no notifications (batch 2). It is pure, and the oracle
//! that gates it is `core/tests/fixtures/scrape-cases.json`: the real
//! Node handler run over synthetic pages by
//! `core/scripts/extract-scrape-cases.mjs`, with what the page alone
//! determined projected out of the rows Node wrote. `tests.rs` replays
//! every case.
//!
//! The Node parser is written against `any`, so most of the port is
//! JavaScript semantics rather than App Store knowledge: truthiness,
//! `?.length`, what `for…of` accepts, and — the part that bites — which
//! failures are swallowed by a `try` and which escape. `js.rs` carries
//! those; each module notes the swallow/escape boundary it sits on.

pub mod accessibility;
mod activity;
pub mod fetch;
#[cfg(test)]
pub(crate) mod fetch_tests;
pub mod flags;
pub mod history;
#[cfg(test)]
mod history_tests;
mod js;
pub(crate) mod notify;
pub mod page;
pub mod persist;
#[cfg(test)]
pub(crate) mod persist_tests;
pub mod plan;
pub mod ratelimit;
pub mod region;
pub mod related;
pub mod search;
#[cfg(test)]
mod search_tests;
pub mod shoebox;
#[cfg(test)]
mod tests;
pub mod wayback;

pub use fetch::{
    complete, fetch_and_parse_app, fetch_version_info, perform, prepare, scrape_initial_urls,
    Fetched, Prepared, ScrapeError,
};
pub use history::{
    import_app_history, AppRow, HistoryError, HistoryOptions, APP_STORE_HISTORICAL_FLOOR_MS,
};
pub use page::{parse_page, ParsedPage};
pub use persist::{
    scrape_and_persist, Ids, Outcome, RandomIds, ScrapeInput, Statement, VersionInfo,
};
pub use plan::{Category, PrivacyItem, SnapshotCategory, SnapshotType, WritePlan};
pub use search::{lookup_apps_by_bundle_id, search_apps_by_name, SearchQuery};

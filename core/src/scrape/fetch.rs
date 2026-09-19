//! The fetch layer of `fetchAndParseApp` (Phase 3, batch 3), and
//! `scrapeInitialUrls` over it. With this the whole function runs here:
//! validation, the cooldown, the pacer, the page fetch through the outbound
//! transport, Apple's rate-limit signal, the parse, the iTunes lookup, and
//! the persist path.
//!
//! Three stages, because a rusqlite connection must not be held across an
//! await in a `Send` future: [`prepare`] (validation, the cooldown check,
//! the storefront read), [`perform`] (no database: pacer, fetch, status
//! checks, parse, lookup) and [`complete`] (the cooldown record, the
//! persist, the error row). [`fetch_and_parse_app`] chains them through a
//! [`DbAccess`]: the connection for `prepare`, released for `perform`,
//! taken again for `complete` — the two synchronous runs Node makes either
//! side of its awaits, so the lock never crosses one.
use super::{
    activity,
    js::{at, truthy},
    page::{parse_page, ParsedPage},
    persist::{self, DbAccess, Ids, Outcome, ScrapeInput, VersionInfo, Writer},
    ratelimit::{self, Category},
    region,
};
use crate::{
    jsdate::{self, js_iso_string},
    jsstr::js_trim,
    outbound::{self, Fetcher, Request},
    server::{
        settings::get_setting_with,
        webhook_writes::{self, Immediate},
    },
};
use rusqlite::Connection;
use serde_json::{json, Value};

/// The User-Agent the page fetch sends.
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";

/// What `fetchAndParseApp` throws: an `AppleRateLimitError` carries the
/// retry delay, a plain `Error` does not.
#[derive(Debug, Clone, PartialEq)]
pub struct ScrapeError {
    pub message: String,
    pub retry_after_ms: Option<i64>,
}

impl ScrapeError {
    pub fn other(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retry_after_ms: None,
        }
    }

    /// `new AppleRateLimitError(retryAfterMs)` with its default message —
    /// which says 429 whatever status Apple actually sent.
    pub fn rate_limited(retry_after_ms: i64) -> Self {
        Self {
            message: format!(
                "Apple App Store rate-limited (HTTP 429); retry after {}s",
                (retry_after_ms as f64 / 1000.0).round() as i64
            ),
            retry_after_ms: Some(retry_after_ms),
        }
    }

    pub fn is_rate_limited(&self) -> bool {
        self.retry_after_ms.is_some()
    }
}

impl std::fmt::Display for ScrapeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Everything the database contributes before the fetch.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub url: String,
    pub country: String,
    pub cooldown_remaining_ms: i64,
}

/// Validation, the cooldown check and the storefront read. A refusal here
/// is thrown before Node's activity boundary, so nothing is recorded.
pub fn prepare(conn: &Connection, url: &str, now: i64) -> Result<Prepared, ScrapeError> {
    outbound::app_store_url(url).map_err(|e| {
        ScrapeError::other(format!(
            "Refusing to scrape untrusted URL: {} ({})",
            e.error, e.detail
        ))
    })?;
    let country = region::normalize_country(
        get_setting_with(conn, "app_country", region::DEFAULT_COUNTRY)
            .ok()
            .as_deref(),
    );
    let cooldown_remaining_ms =
        ratelimit::remaining_cooldown_ms(conn, Category::Scrape, now).unwrap_or(0);
    Ok(Prepared {
        url: url.to_string(),
        country,
        cooldown_remaining_ms,
    })
}

/// What the network stage hands the database stage.
#[derive(Debug)]
pub enum Fetched {
    Ready {
        page: Box<ParsedPage>,
        version: VersionInfo,
    },
    Failed {
        error: ScrapeError,
        /// The cooldown Apple's signal asks for, to be recorded before the
        /// error row: `(retryAfterMs, reason)`.
        rate_limit: Option<(i64, String)>,
        /// Whether the page body was in hand when it failed. Node mints the
        /// throwaway `appleId` UUID as soon as it has the HTML, before the
        /// parse can throw, so an id is consumed ahead of the error row.
        after_fetch: bool,
    },
}

/// The pacer, the page fetch, the status checks, the parse and the lookup.
/// No database.
pub async fn perform(fetcher: &dyn Fetcher, prepared: &Prepared, now: i64) -> Fetched {
    let failed = |error: ScrapeError| Fetched::Failed {
        error,
        rate_limit: None,
        after_fetch: false,
    };
    // Hard-cooldown short-circuit: the typed error carries the REMAINING
    // window, so every caller sees one resume time.
    if prepared.cooldown_remaining_ms > 0 {
        return failed(ScrapeError::rate_limited(prepared.cooldown_remaining_ms));
    }
    ratelimit::acquire_token(Category::Scrape).await;
    let mut request = Request::apple(
        prepared.url.clone(),
        outbound::APPLE_HOSTS,
        4 * 1024 * 1024,
        15_000,
    );
    request.headers = vec![
        ("User-Agent".to_string(), USER_AGENT.to_string()),
        ("Accept-Language".to_string(), "en-US,en;q=0.9".to_string()),
    ];
    let reply = match fetcher.fetch(request).await {
        Ok(reply) => reply,
        Err(error) => return failed(ScrapeError::other(error)),
    };
    // 429 is Apple's explicit rate limit; 403 is its soft throttle in
    // practice, and treated the same.
    if reply.status == 429 || reply.status == 403 {
        let retry_after = ratelimit::parse_retry_after_ms(reply.header("retry-after"), now);
        let retry_after_ms = retry_after.unwrap_or(ratelimit::APP_STORE_RATE_LIMIT_COOLDOWN_MS);
        let reason = format!(
            "HTTP {} from App Store HTML at {}{}",
            reply.status,
            js_iso_string(now),
            if retry_after.is_some() {
                " (Retry-After honoured)"
            } else {
                ""
            }
        );
        return Fetched::Failed {
            error: ScrapeError::rate_limited(retry_after_ms),
            rate_limit: Some((retry_after_ms, reason)),
            after_fetch: false,
        };
    }
    if !reply.ok() {
        return failed(ScrapeError::other(format!(
            "HTTP {} fetching App Store page",
            reply.status
        )));
    }
    let html = String::from_utf8_lossy(&reply.body).into_owned();
    let page = match parse_page(&prepared.url, &html) {
        Ok(page) => page,
        Err(error) => {
            return Fetched::Failed {
                error: ScrapeError::other(error),
                rate_limit: None,
                after_fetch: true,
            }
        }
    };
    let version = fetch_version_info(fetcher, &page.apple_id, &prepared.country).await;
    Fetched::Ready {
        page: Box::new(page),
        version,
    }
}

/// `fetchVersionInfo`: version, price, genre and age rating from the iTunes
/// lookup. Best effort — every miss is the empty record.
pub async fn fetch_version_info(
    fetcher: &dyn Fetcher,
    apple_id: &str,
    country: &str,
) -> VersionInfo {
    if apple_id.is_empty() || !apple_id.bytes().all(|b| b.is_ascii_digit()) {
        return VersionInfo::default();
    }
    let mut request = Request::apple(
        format!("https://itunes.apple.com/lookup?id={apple_id}&country={country}"),
        outbound::APPLE_HOSTS,
        1024 * 1024,
        8000,
    );
    request.headers = vec![("Accept".to_string(), "application/json".to_string())];
    let Ok(reply) = fetcher.fetch(request).await else {
        return VersionInfo::default();
    };
    if !reply.ok() {
        return VersionInfo::default();
    }
    let Ok(payload) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&reply.body)) else {
        return VersionInfo::default();
    };
    let entry = at(&payload["results"], 0);
    if !truthy(&entry) {
        return VersionInfo::default();
    }
    let text = |v: &Value| match v {
        Value::String(s) if !js_trim(s).is_empty() => Some(js_trim(s).to_string()),
        _ => None,
    };
    let number = |v: &Value| v.as_f64().filter(|f| f.is_finite());
    let rating_raw = if entry["contentAdvisoryRating"].is_null() {
        &entry["trackContentRating"]
    } else {
        &entry["contentAdvisoryRating"]
    };
    VersionInfo {
        age_rating: text(rating_raw),
        current_version: text(&entry["version"]),
        genre_id: number(&entry["primaryGenreId"]),
        genre_name: text(&entry["primaryGenreName"]),
        price_amount: number(&entry["price"]),
        price_currency: text(&entry["currency"]),
        price_formatted: text(&entry["formattedPrice"]),
        version_updated_at: match &entry["currentVersionReleaseDate"] {
            Value::String(s) => jsdate::parse(s),
            _ => None,
        },
        whats_new: text(&entry["releaseNotes"]),
    }
}

/// The database stage: record Apple's cooldown if it sent one, then either
/// persist the page or write the error row — the same catch block for both.
/// One section: the caller holds the connection for exactly this.
pub(crate) fn complete(
    w: &mut Writer<'_>,
    url: &str,
    resync: bool,
    trigger: &str,
    now: i64,
    fetched: Fetched,
    ids: &mut dyn Ids,
) -> Result<Outcome, ScrapeError> {
    let activity_type = if resync { "resync" } else { "scrape" };
    match fetched {
        Fetched::Failed {
            error,
            rate_limit,
            after_fetch,
        } => {
            if let Some((retry_after_ms, reason)) = rate_limit {
                let _ = ratelimit::record(w, Category::Scrape, retry_after_ms, &reason, now);
            }
            if after_fetch {
                if let Err(error) = ids.uuid(w.conn) {
                    return Err(ScrapeError::other(error));
                }
            }
            activity::record_error(w, ids, url, now, activity_type, &error.message);
            Err(error)
        }
        Fetched::Ready { page, version } => {
            // `let appleId: string = crypto.randomUUID();` — minted once the
            // page is in hand, then replaced by the URL's id segment.
            if let Err(error) = ids.uuid(w.conn) {
                return Err(ScrapeError::other(error));
            }
            let input = ScrapeInput {
                url,
                resync,
                trigger,
                version: &version,
                now,
            };
            match persist::persist_page(w, &input, *page, ids, activity_type) {
                Ok(outcome) => Ok(outcome),
                Err(message) => {
                    activity::record_error(w, ids, url, now, activity_type, &message);
                    Err(ScrapeError::other(message))
                }
            }
        }
    }
}

/// `fetchAndParseApp(url, resync, false, trigger)`, end to end: one section
/// for `prepare`, the network with the connection released, one section
/// for `complete`, then the immediate webhook a label change owes. Node
/// awaits nothing between its validation and cooldown read and its first
/// pacer wait, nor between the parse and its commit, so these are exactly
/// its interleaving points.
pub(crate) async fn fetch_and_parse_app(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    url: &str,
    resync: bool,
    trigger: Option<&str>,
    now: i64,
    ids: &mut dyn Ids,
) -> Result<Outcome, ScrapeError> {
    let trigger = trigger.unwrap_or(if resync { "manual" } else { "import" });
    let prepared = db.with(|w| prepare(w.conn, url, now))?;
    let fetched = perform(fetcher, &prepared, now).await;
    let mut outcome = db.with(|w| complete(w, url, resync, trigger, now, fetched, ids))?;
    fire_change_webhook(db, fetcher, now, outcome.immediate.take()).await;
    Ok(outcome)
}

/// The immediate webhook for the label changes a scrape committed:
/// `commitScrapedAppToDb`'s `void fireWebhookIfConfigured(name, changes)`
/// once its write has landed, with no quiet-hours wait (quiet hours defer
/// the bell row's `not_before`, never the post). Every caller commits in a
/// section of its own, sometimes with its own writes after the scrape's
/// (an import row, the sync state), so this runs as that section closes:
/// later than Node's fire point only by writes the POST neither reads nor
/// makes, and before the caller's next request, as in Node. Awaiting it
/// never holds the caller for the webhook: `fire_immediate` detaches the
/// POST on the server, and the replay's canned hop answers at once.
pub(crate) async fn fire_change_webhook(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    now: i64,
    immediate: Option<Immediate>,
) {
    if let Some(immediate) = immediate {
        webhook_writes::fire_immediate(db, fetcher, now, immediate).await;
    }
}

/// `scrapeInitialUrls`: each URL in turn; a rate limit either stops the
/// batch (the rest are reported as queued) or, when told to continue, is
/// recorded and the loop carries on — into the cooldown it just started.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn scrape_initial_urls(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    urls: &[String],
    resync: bool,
    trigger: Option<&str>,
    stop_on_rate_limit: bool,
    now: i64,
    ids: &mut dyn Ids,
) -> Vec<Value> {
    let trigger = trigger.unwrap_or(if resync { "manual" } else { "import" });
    let mut results = vec![];
    for url in urls {
        match fetch_and_parse_app(db, fetcher, url, resync, Some(trigger), now, ids).await {
            Ok(outcome) => results.push(outcome.to_json()),
            Err(error) => match error.retry_after_ms {
                Some(retry_after_ms) => {
                    results.push(json!({
                        "url": url,
                        "status": "rate_limited",
                        "retryAfterMs": retry_after_ms,
                        "error": error.message,
                    }));
                    if stop_on_rate_limit {
                        // `urls.indexOf(url) + 1`: the first occurrence.
                        let from = urls.iter().position(|u| u == url).map_or(0, |i| i + 1);
                        for tail in &urls[from..] {
                            results.push(json!({
                                "url": tail,
                                "status": "rate_limited",
                                "retryAfterMs": retry_after_ms,
                                "error": "Queued behind an earlier rate-limited request",
                            }));
                        }
                        return results;
                    }
                }
                None => results.push(json!({
                    "url": url,
                    "status": "error",
                    "error": error.message,
                })),
            },
        }
    }
    results
}

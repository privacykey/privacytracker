//! `searchAppsByName` and `lookupAppsByBundleId` (Phase 3, batch 3b): the
//! two iTunes API calls the import flow makes, with the "search" cooldown
//! they share. Neither throws: a query or chunk that fails in any way —
//! transport, status, malformed JSON, a `TypeError` inside the candidate
//! mapping — collapses to empty candidates or null matches, exactly where
//! Node's per-query and per-chunk `try` sits. Both return the batch object
//! as JSON, because the candidate shape follows JavaScript: a field Apple
//! did not send is absent, a `null` one stays null, and `String(trackId)`
//! spells whatever was there.
//!
//! Gated by `core/tests/fixtures/search-cases.json` (see
//! `search_tests.rs`). The connection comes through a [`DbAccess`] and is
//! taken for one section at a time — the storefront read, a cooldown
//! read, a cooldown record — and released for the pacer and the fetch
//! between them, which is where Node awaits.
use super::{
    js::truthy,
    persist::DbAccess,
    ratelimit::{self, Category},
    region,
};
use crate::{
    jsdate::js_iso_string,
    jsnum::js_parse_int,
    jsstr::{js_encode_uri_component, js_string, js_trim},
    outbound::{self, Fetcher, Request},
    server::settings::get_setting_with,
};
use regex::Regex;
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::{cmp::Reverse, collections::HashSet, sync::OnceLock, time::Duration};

const ITUNES_RATE_LIMIT_COOLDOWN_MS: i64 = 70_000;
const ITUNES_RETRY_DELAY_MS: u64 = 1200;
const ITUNES_LOOKUP_BATCH_SIZE: usize = 100;

/// `options.country ?? getSetting("app_country", DEFAULT_COUNTRY)`, normalised.
fn storefront(conn: &Connection, country: Option<&str>) -> String {
    match country {
        Some(country) => region::normalize_country(Some(country)),
        None => region::normalize_country(
            get_setting_with(conn, "app_country", region::DEFAULT_COUNTRY)
                .ok()
                .as_deref(),
        ),
    }
}

/// `data.results || []`, then what iterating it does: `null` data throws
/// on `.results`, a falsy `results` is empty, an array is itself, and any
/// other truthy value throws once mapped or walked.
fn results_of(data: &Value) -> Result<Vec<Value>, ()> {
    if data.is_null() {
        return Err(());
    }
    match data.get("results") {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(v) if truthy(v) => Err(()),
        _ => Ok(vec![]),
    }
}

/// One iTunes result as an `AppCandidate`, in Node's key order with absent
/// fields absent. `Err` is the `TypeError` a `null` entry or a non-string
/// `artworkUrl100` / `trackViewUrl` raises inside the mapping.
fn candidate(r: &Value, search_query: &str, bundle: Option<&str>) -> Result<Value, ()> {
    if r.is_null() {
        return Err(());
    }
    let mut out = Map::new();
    out.insert(
        "appleId".into(),
        Value::String(r.get("trackId").map_or("undefined".to_string(), js_string)),
    );
    if let Some(name) = r.get("trackName") {
        out.insert("name".into(), name.clone());
    }
    if let Some(developer) = r.get("artistName") {
        out.insert("developer".into(), developer.clone());
    }
    let icon_url = match r.get("artworkUrl100") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.replacen("100x100bb", "200x200bb", 1),
        Some(_) => return Err(()),
    };
    out.insert("iconUrl".into(), Value::String(icon_url));
    let url = match r.get("trackViewUrl") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.split('?').next().unwrap_or("").to_string(),
        Some(_) => return Err(()),
    };
    out.insert("url".into(), Value::String(url));
    match (bundle, r.get("bundleId")) {
        (Some(bundle), _) => {
            out.insert("bundleId".into(), Value::String(bundle.to_string()));
        }
        (None, Some(v)) => {
            out.insert("bundleId".into(), v.clone());
        }
        (None, None) => {}
    }
    let rating = match r.get("contentAdvisoryRating") {
        Some(v) if !v.is_null() => v.clone(),
        _ => match r.get("trackContentRating") {
            Some(v) if !v.is_null() => v.clone(),
            _ => Value::String(String::new()),
        },
    };
    out.insert("contentAdvisoryRating".into(), rating);
    out.insert(
        "searchQuery".into(),
        Value::String(search_query.to_string()),
    );
    Ok(Value::Object(out))
}

/// `Number.parseInt(header, 10) * 1000`, kept only when positive and under
/// ten minutes; the raw header goes into the recorded reason.
fn itunes_retry_after(header: Option<&str>) -> (i64, String) {
    let header = header.filter(|h| !h.is_empty());
    let parsed = header
        .and_then(js_parse_int)
        .map(|secs| secs.saturating_mul(1000));
    let ms = parsed
        .filter(|ms| *ms > 0 && *ms < 600_000)
        .unwrap_or(ITUNES_RATE_LIMIT_COOLDOWN_MS);
    let suffix = header.map_or(String::new(), |h| format!(" (Retry-After: {h})"));
    (ms, suffix)
}

fn accept_json(mut request: Request) -> Request {
    request.headers = vec![("Accept".to_string(), "application/json".to_string())];
    request
}

/// A normalised search query: `{ name, developer? }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchQuery {
    pub name: String,
    pub developer: Option<String>,
}

impl SearchQuery {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("name".into(), Value::String(self.name.clone()));
        if let Some(developer) = &self.developer {
            out.insert("developer".into(), Value::String(developer.clone()));
        }
        Value::Object(out)
    }
}

enum SearchOutcome {
    RateLimited(i64),
    Null,
    Candidates(Vec<Value>),
}

/// `runItunesSearch`: `Err` is a throw the caller's `try` catches.
async fn run_itunes_search(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    name: &str,
    country: &str,
    now: i64,
) -> Result<SearchOutcome, ()> {
    let cooldown = db
        .with(|w| ratelimit::remaining_cooldown_ms(w.conn, Category::Search, now))
        .map_err(drop)?;
    if cooldown > 0 {
        return Ok(SearchOutcome::RateLimited(cooldown));
    }
    ratelimit::acquire_token(Category::Search).await;
    let request = accept_json(Request::apple(
        format!(
            "https://itunes.apple.com/search?term={}&entity=software&country={country}&limit=5",
            js_encode_uri_component(name)
        ),
        outbound::APPLE_HOSTS,
        1024 * 1024,
        8000,
    ));
    let reply = fetcher.fetch(request).await.map_err(drop)?;
    if reply.status == 429 {
        let (ms, suffix) = itunes_retry_after(reply.header("retry-after"));
        let reason = format!(
            "HTTP 429 from iTunes Search at {}{suffix}",
            js_iso_string(now)
        );
        db.with(|w| ratelimit::record(w, Category::Search, ms, &reason, now))
            .map_err(drop)?;
        return Ok(SearchOutcome::RateLimited(ms));
    }
    if !reply.ok() {
        return Ok(SearchOutcome::Null);
    }
    let Ok(data) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&reply.body)) else {
        return Ok(SearchOutcome::Null);
    };
    let candidates = results_of(&data)?
        .iter()
        .map(|r| candidate(r, name, None))
        .collect::<Result<Vec<_>, ()>>()?;
    Ok(SearchOutcome::Candidates(candidates))
}

/// `scoreDeveloperMatch`: exact 100, containment 50, else twelve per shared
/// ASCII word up to 40. A non-string candidate developer is `.toLowerCase`
/// on a non-string — a throw.
fn score_developer_match(candidate_dev: Option<&Value>, hint: &str) -> Result<i64, ()> {
    let Some(dev) = candidate_dev.filter(|v| truthy(v)) else {
        return Ok(0);
    };
    let Value::String(dev) = dev else {
        return Err(());
    };
    let a = dev.to_lowercase();
    let b = hint.to_lowercase();
    if a == b {
        return Ok(100);
    }
    if a.contains(&b) || b.contains(&a) {
        return Ok(50);
    }
    static NON_WORD: OnceLock<Regex> = OnceLock::new();
    let non_word = NON_WORD.get_or_init(|| Regex::new("[^A-Za-z0-9_]+").expect("static regex"));
    let tokens = |s: &str| -> HashSet<String> {
        non_word
            .split(s)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect()
    };
    let a_tokens = tokens(&a);
    let overlap = tokens(&b).iter().filter(|t| a_tokens.contains(*t)).count() as i64;
    Ok(if overlap == 0 {
        0
    } else {
        (overlap * 12).min(40)
    })
}

/// `searchAppsByName(input, { country })`. The batch object as JSON.
pub(crate) async fn search_apps_by_name(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    input: &[Value],
    country: Option<&str>,
    now: i64,
) -> Result<Value, String> {
    let country = db.with(|w| storefront(w.conn, country));
    let mut queries: Vec<SearchQuery> = vec![];
    for raw in input {
        let q = match raw {
            Value::String(s) => json!({ "name": s }),
            other => other.clone(),
        };
        if !truthy(&q) {
            continue;
        }
        let Value::String(name) = &q["name"] else {
            continue;
        };
        if js_trim(name).is_empty() {
            continue;
        }
        // `q.developer?.trim() || undefined`: a non-string, non-null
        // developer is a TypeError out of the whole call.
        let developer = match &q["developer"] {
            Value::Null => None,
            Value::String(d) => Some(js_trim(d).to_string()).filter(|d| !d.is_empty()),
            _ => return Err("q.developer?.trim is not a function".to_string()),
        };
        queries.push(SearchQuery {
            name: js_trim(name).to_string(),
            developer,
        });
    }
    let rate_limited = |results: &[Value], retry_after_ms: i64, queued: &[SearchQuery]| {
        json!({
            "results": results,
            "rateLimited": {
                "retryAfterMs": retry_after_ms,
                "queued": queued.iter().map(SearchQuery::to_json).collect::<Vec<_>>(),
            },
        })
    };
    let mut results: Vec<Value> = vec![];
    for (i, query) in queries.iter().enumerate() {
        let empty = json!({ "query": query.name, "candidates": [] });
        let mut candidates = match run_itunes_search(db, fetcher, &query.name, &country, now).await
        {
            Err(()) => {
                results.push(empty);
                continue;
            }
            Ok(SearchOutcome::RateLimited(ms)) => {
                return Ok(rate_limited(&results, ms, &queries[i..]))
            }
            Ok(SearchOutcome::Null) => {
                results.push(empty);
                continue;
            }
            Ok(SearchOutcome::Candidates(candidates)) => candidates,
        };
        if candidates.is_empty() {
            tokio::time::sleep(Duration::from_millis(ITUNES_RETRY_DELAY_MS)).await;
            match run_itunes_search(db, fetcher, &query.name, &country, now).await {
                Err(()) => {
                    results.push(empty);
                    continue;
                }
                Ok(SearchOutcome::RateLimited(ms)) => {
                    return Ok(rate_limited(&results, ms, &queries[i..]))
                }
                Ok(SearchOutcome::Candidates(retry)) if !retry.is_empty() => candidates = retry,
                Ok(_) => {}
            }
        }
        if let Some(developer) = &query.developer {
            if candidates.len() > 1 {
                let mut scored: Vec<(usize, i64, Value)> = vec![];
                let mut threw = false;
                for (idx, cand) in candidates.iter().enumerate() {
                    match score_developer_match(cand.get("developer"), developer) {
                        Ok(score) => scored.push((idx, score, cand.clone())),
                        Err(()) => {
                            threw = true;
                            break;
                        }
                    }
                }
                if threw {
                    results.push(empty);
                    continue;
                }
                scored.sort_by_key(|(idx, score, _)| (Reverse(*score), *idx));
                candidates = scored.into_iter().map(|(_, _, cand)| cand).collect();
            }
        }
        results.push(json!({ "query": query.name, "candidates": candidates }));
    }
    Ok(json!({ "results": results }))
}

/// `lookupAppsByBundleId(bundleIds, { country })`. The batch object as JSON.
pub(crate) async fn lookup_apps_by_bundle_id(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    bundle_ids: &[Value],
    country: Option<&str>,
    now: i64,
) -> Value {
    let mut seen = HashSet::new();
    let cleaned: Vec<String> = bundle_ids
        .iter()
        .map(|v| match v {
            Value::String(s) => js_trim(s).to_string(),
            _ => String::new(),
        })
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect();
    if cleaned.is_empty() {
        return json!({ "results": [] });
    }
    let country = db.with(|w| storefront(w.conn, country));
    lookup_chunks(db, fetcher, &cleaned, &country, now).await
}

/// The chunk loop, re-entered by the split retry with a half chunk (which
/// is already clean and unique, so re-cleaning is the identity).
async fn lookup_chunks(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    cleaned: &[String],
    country: &str,
    now: i64,
) -> Value {
    let mut results: Vec<Value> = vec![];
    let mut i = 0;
    while i < cleaned.len() {
        let chunk = &cleaned[i..(i + ITUNES_LOOKUP_BATCH_SIZE).min(cleaned.len())];
        let cooldown = db
            .with(|w| ratelimit::remaining_cooldown_ms(w.conn, Category::Search, now))
            .unwrap_or(0);
        if cooldown > 0 {
            return json!({
                "results": results,
                "rateLimited": { "retryAfterMs": cooldown, "queued": &cleaned[i..] },
            });
        }
        ratelimit::acquire_token(Category::Search).await;
        let mut request = accept_json(Request::apple(
            format!(
                "https://itunes.apple.com/lookup?bundleId={}&country={country}&limit={ITUNES_LOOKUP_BATCH_SIZE}",
                js_encode_uri_component(&chunk.join(","))
            ),
            outbound::APPLE_HOSTS,
            4 * 1024 * 1024,
            12_000,
        ));
        request.max_url_length = 16 * 1024;
        let nulls = |results: &mut Vec<Value>| {
            for id in chunk {
                results.push(json!({ "bundleId": id, "match": null }));
            }
        };
        let Ok(reply) = fetcher.fetch(request).await else {
            nulls(&mut results);
            i += ITUNES_LOOKUP_BATCH_SIZE;
            continue;
        };
        if reply.status == 429 {
            let (ms, suffix) = itunes_retry_after(reply.header("retry-after"));
            let reason = format!(
                "HTTP 429 from iTunes Lookup at {}{suffix}",
                js_iso_string(now)
            );
            if db
                .with(|w| ratelimit::record(w, Category::Search, ms, &reason, now))
                .is_err()
            {
                nulls(&mut results);
                i += ITUNES_LOOKUP_BATCH_SIZE;
                continue;
            }
            return json!({
                "results": results,
                "rateLimited": { "retryAfterMs": ms, "queued": &cleaned[i..] },
            });
        }
        if !reply.ok() {
            if matches!(reply.status, 502..=504) && chunk.len() > 1 {
                let half = chunk.len().div_ceil(2);
                let a = Box::pin(lookup_chunks(db, fetcher, &chunk[..half], country, now)).await;
                let b = Box::pin(lookup_chunks(db, fetcher, &chunk[half..], country, now)).await;
                for part in [&a, &b] {
                    if let Some(items) = part["results"].as_array() {
                        results.extend(items.iter().cloned());
                    }
                }
                let rate_limited = [&a, &b]
                    .into_iter()
                    .find_map(|part| part.get("rateLimited").filter(|v| !v.is_null()).cloned());
                if let Some(rate_limited) = rate_limited {
                    return json!({ "results": results, "rateLimited": rate_limited });
                }
            } else {
                nulls(&mut results);
            }
            i += ITUNES_LOOKUP_BATCH_SIZE;
            continue;
        }
        let Ok(data) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&reply.body)) else {
            nulls(&mut results);
            i += ITUNES_LOOKUP_BATCH_SIZE;
            continue;
        };
        let matched: Result<Vec<(String, Value)>, ()> = results_of(&data).and_then(|items| {
            let mut by_bundle: Vec<(String, Value)> = vec![];
            for r in &items {
                if r.is_null() {
                    return Err(());
                }
                let Some(Value::String(bundle)) = r.get("bundleId") else {
                    continue;
                };
                if bundle.is_empty() {
                    continue;
                }
                let cand = candidate(r, bundle, Some(bundle))?;
                let key = bundle.to_lowercase();
                match by_bundle.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, existing)) => *existing = cand,
                    None => by_bundle.push((key, cand)),
                }
            }
            Ok(by_bundle)
        });
        match matched {
            Ok(by_bundle) => {
                for id in chunk {
                    let key = id.to_lowercase();
                    let found = by_bundle
                        .iter()
                        .find(|(k, _)| *k == key)
                        .map(|(_, v)| v.clone());
                    results.push(json!({ "bundleId": id, "match": found.unwrap_or(Value::Null) }));
                }
            }
            Err(()) => nulls(&mut results),
        }
        i += ITUNES_LOOKUP_BATCH_SIZE;
    }
    json!({ "results": results })
}

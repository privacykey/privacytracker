//! lib/wayback.ts: the archive.org client the historical import drives —
//! the CDX index listing, the availability API, Save Page Now, and the
//! timestamp arithmetic between them. A 429 or 5xx from the index, the
//! availability API or a replay is `Unavailable`, and so is a request that
//! fails below HTTP ([`Unavailable::transport`]); the import surfaces it to
//! its caller. Every other failure is a quiet `None`.
use super::js::truthy;
use crate::{
    jsdate::{self, civil_from_days, days_from_civil},
    jsnum::js_to_number,
    jsstr::{js_encode_uri_component, js_form_encode, js_trim},
    outbound::{self, Fetcher, Reply, Request},
};
use regex::Regex;
use serde_json::Value;
use std::{collections::HashSet, sync::OnceLock};
use url::Url;

pub const WAYBACK_HOSTS: &[&str] = &["archive.org", "web.archive.org", "www.web.archive.org"];
pub const USER_AGENT: &str = "privacytracker/1.0 (+privacy-history archiver)";
const AVAILABILITY_MAX_BYTES: usize = 64 * 1024;
const AVAILABILITY_TIMEOUT_MS: u64 = 8000;
const SAVE_NOW_TIMEOUT_MS: u64 = 25_000;
const CDX_MAX_BYTES: usize = 1024 * 1024;
const CDX_TIMEOUT_MS: u64 = 20_000;
const CDX_ROW_LIMIT: usize = 5000;

/// `WaybackUnavailableError`: archive.org throttling or failing. `status`
/// is 0 when no response came.
#[derive(Debug, Clone, PartialEq)]
pub struct Unavailable {
    pub status: u16,
    pub retry_after_ms: Option<i64>,
    pub message: String,
}

impl Unavailable {
    pub fn new(status: u16, retry_after_ms: Option<i64>, endpoint: &str) -> Self {
        let label = if status == 429 {
            "rate-limited".to_string()
        } else {
            format!("unavailable (HTTP {status})")
        };
        Self::labelled(status, retry_after_ms, endpoint, &label)
    }

    fn labelled(status: u16, retry_after_ms: Option<i64>, endpoint: &str, label: &str) -> Self {
        let retry = retry_after_ms.map_or(String::new(), |ms| {
            format!(" — retry after {}s", (ms as f64 / 1000.0).ceil() as i64)
        });
        Self {
            status,
            retry_after_ms,
            message: format!("archive.org {label} for {endpoint}{retry}"),
        }
    }

    /// `waybackTransportFailure`: a fetch error that means archive.org
    /// would not talk to us — the connection refused or reset (`fetch
    /// failed`), dropped mid-body (`terminated`), timed out, or the host
    /// not resolving. After throttling a client for long enough it stops
    /// answering 429 and refuses the connection, so reading this as "no
    /// capture" would record an empty quarter for every target. Any other
    /// error (a blocked URL, a body over the cap, a redirect loop) is not
    /// archive.org refusing us and is `None`.
    pub fn transport(error: &str, endpoint: &str) -> Option<Self> {
        static DNS: OnceLock<Regex> = OnceLock::new();
        let dns = DNS.get_or_init(|| {
            Regex::new(r"^Blocked URL: host \S+ did not resolve to a public address$")
                .expect("static regex")
        });
        let label = match error {
            "fetch failed" => "refused the connection",
            "terminated" => "dropped the connection",
            outbound::TIMEOUT_MESSAGE => "timed out",
            _ if dns.is_match(error) => "could not be resolved",
            _ => return None,
        };
        Some(Self::labelled(0, None, endpoint, label))
    }
}

/// wayback.ts `parseRetryAfterMs`: `Number(raw)` first — so `"0"` is zero,
/// not junk — then an HTTP date measured from `now`.
pub fn parse_retry_after_ms(raw: Option<&str>, now: i64) -> Option<i64> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let seconds = js_to_number(&Value::String(raw.to_string()));
    if seconds.is_finite() && seconds >= 0.0 {
        return Some((seconds * 1000.0).round() as i64);
    }
    let when = jsdate::parse(raw)?;
    Some((when - now).max(0))
}

fn unavailable_if(reply: &Reply, endpoint: &str, now: i64) -> Result<(), Unavailable> {
    if reply.status == 429 || reply.status >= 500 {
        return Err(Unavailable::new(
            reply.status,
            parse_retry_after_ms(reply.header("retry-after"), now),
            endpoint,
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub url: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capture {
    pub ms: i64,
    pub timestamp: String,
    pub url: String,
}

/// `formatWaybackTimestamp`: the UTC date as `yyyymmdd`.
pub fn format_timestamp(ms: i64) -> String {
    let (year, month, day) = civil_from_days(ms.div_euclid(86_400_000));
    format!("{year:0>4}{month:02}{day:02}")
}

/// `Date.UTC(y, mo, d, h, mi, s)`: JavaScript's field overflow rules
/// (a month past December rolls the year, a day past the month's end rolls
/// the month), two-digit years in 1900, and `TimeClip`.
pub(super) fn date_utc(y: i64, mo0: i64, d: i64, h: i64, mi: i64, s: i64) -> Option<i64> {
    let y = if (0..=99).contains(&y) { y + 1900 } else { y };
    let year = y.checked_add(mo0.div_euclid(12))?;
    let month = mo0.rem_euclid(12) + 1;
    let day = days_from_civil(year, month, 1).checked_add(d.checked_sub(1)?)?;
    let t = day
        .checked_mul(86_400_000)?
        .checked_add(h.checked_mul(3_600_000)?)?
        .checked_add(mi.checked_mul(60_000)?)?
        .checked_add(s.checked_mul(1000)?)?;
    (t.abs() <= 8_640_000_000_000_000).then_some(t)
}

/// `parseWaybackTimestampMs`: a 4–14 digit Wayback timestamp, padded to
/// noon, as epoch milliseconds.
pub fn parse_timestamp_ms(raw: Option<&str>) -> Option<i64> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let padded: String = format!("{raw}120000000000").chars().take(14).collect();
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})$")
            .expect("static regex")
    });
    let c = re.captures(&padded)?;
    let n = |i: usize| c[i].parse::<i64>().expect("digits");
    date_utc(n(1), n(2) - 1, n(3), n(4), n(5), n(6))
}

/// `extractWaybackTimestamp` / `timestampFromWaybackUrl`.
pub fn extract_timestamp(url: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r"(?i)/web/([0-9]{4,14})(?:[a-z_]+)?/").expect("static regex"));
    re.captures(url).map(|c| c[1].to_string())
}

fn request(
    url: String,
    hosts: &[&str],
    max_bytes: usize,
    timeout_ms: u64,
    headers: &[(&str, &str)],
) -> Request {
    let mut request = Request::apple(url, hosts, max_bytes, timeout_ms);
    request.headers = headers
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    request
}

/// `listWaybackCaptures(url, { from })`: `None` when the index answers
/// with something unusable and the import must probe instead,
/// `Some(vec![])` for an empty index, `Unavailable` for throttling or a
/// transport failure. Rows are the CDX JSON form, header row included, filtered to
/// unique fourteen-digit timestamps and sorted.
pub async fn list_captures(
    fetcher: &dyn Fetcher,
    target_url: &str,
    from_ms: Option<i64>,
    now: i64,
) -> Result<Option<Vec<Capture>>, Unavailable> {
    if target_url.is_empty() {
        return Ok(None);
    }
    let mut params = vec![
        ("url", target_url.to_string()),
        ("output", "json".to_string()),
        ("fl", "timestamp,statuscode".to_string()),
        ("filter", "statuscode:200".to_string()),
        ("collapse", "timestamp:8".to_string()),
        ("limit", CDX_ROW_LIMIT.to_string()),
    ];
    if let Some(from) = from_ms {
        params.push(("from", format_timestamp(from)));
    }
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={}", js_form_encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let endpoint = format!("https://web.archive.org/cdx/search/cdx?{query}");
    let req = request(
        endpoint,
        WAYBACK_HOSTS,
        CDX_MAX_BYTES,
        CDX_TIMEOUT_MS,
        &[("Accept", "application/json"), ("User-Agent", USER_AGENT)],
    );
    // Falling back to availability probes on a refused connection would
    // turn it into up to seven more per target.
    let reply = match fetcher.fetch(req).await {
        Ok(reply) => reply,
        Err(error) => return Unavailable::transport(&error, "CDX index").map_or(Ok(None), Err),
    };
    unavailable_if(&reply, "CDX index", now)?;
    if reply.status != 200 {
        return Ok(None);
    }
    let body = String::from_utf8_lossy(&reply.body);
    let text = js_trim(&body);
    if text.is_empty() {
        return Ok(Some(vec![]));
    }
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(text) else {
        return Ok(None);
    };
    let mut captures = vec![];
    let mut seen = HashSet::new();
    for row in rows {
        let Value::Array(cells) = row else {
            continue;
        };
        let Some(Value::String(timestamp)) = cells.first() else {
            continue;
        };
        let well_formed = timestamp.len() == 14 && timestamp.bytes().all(|b| b.is_ascii_digit());
        if !well_formed || seen.contains(timestamp) {
            continue;
        }
        let Some(ms) = parse_timestamp_ms(Some(timestamp)) else {
            continue;
        };
        seen.insert(timestamp.clone());
        captures.push(Capture {
            ms,
            timestamp: timestamp.clone(),
            url: format!("https://web.archive.org/web/{timestamp}/{target_url}"),
        });
    }
    captures.sort_by_key(|c| c.ms);
    Ok(Some(captures))
}

fn is_storefront(segment: &str) -> bool {
    segment.len() == 2 && segment.bytes().all(|b| b.is_ascii_alphabetic())
}

/// `id<digits>`, the track id as App Store paths carry it.
fn track_id_segment(segment: &str) -> Option<&str> {
    let digits = segment
        .strip_prefix("id")
        .or_else(|| segment.strip_prefix("ID"))?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
}

/// The same App Store page on the US storefront. Privacy labels belong to
/// the app, not the storefront, and archive.org crawls US pages far more
/// often than any other, so an import lists this address first. `None` for
/// anything that is not an apps.apple.com app page; a path with no
/// storefront is the US one. The query and fragment are dropped: they do
/// not change the page, and the index matches addresses exactly.
pub fn us_storefront_url(url: &str) -> Option<String> {
    let parsed = Url::parse(js_trim(url)).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str()? != "apps.apple.com"
        || parsed.port().is_some()
    {
        return None;
    }
    let segments: Vec<&str> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();
    let rest = match segments.as_slice() {
        [storefront, "app", rest @ ..] if is_storefront(storefront) => rest,
        ["app", rest @ ..] => rest,
        _ => return None,
    };
    let (id, slug) = match rest {
        [id] => (track_id_segment(id)?, None),
        [slug, id] => (track_id_segment(id)?, Some(*slug)),
        _ => return None,
    };
    Some(match slug {
        Some(slug) => format!("https://apps.apple.com/us/app/{slug}/id{id}"),
        None => format!("https://apps.apple.com/us/app/id{id}"),
    })
}

/// An older App Store address a user added for app `app_id`, as it is
/// stored: `https://apps.apple.com/<cc>/app/<slug>/id<app_id>` with a
/// lowercase storefront. Surrounding spaces, a trailing slash, a query and
/// a fragment are forgiven and dropped; anything else is refused, the
/// address of another app included.
pub fn canonical_app_store_address(raw: &str, app_id: &str) -> Option<String> {
    let raw = js_trim(raw);
    if raw.len() > 2048 {
        return None;
    }
    let parsed = Url::parse(raw).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str()? != "apps.apple.com"
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    let mut segments: Vec<&str> = parsed.path_segments()?.collect();
    if segments.last() == Some(&"") {
        segments.pop();
    }
    let [storefront, "app", slug, id] = segments.as_slice() else {
        return None;
    };
    if !is_storefront(storefront) || slug.is_empty() || track_id_segment(id)? != app_id {
        return None;
    }
    Some(format!(
        "https://apps.apple.com/{}/app/{slug}/id{app_id}",
        storefront.to_ascii_lowercase()
    ))
}

/// The address inside a `/web/<timestamp>/<address>` capture URL: what a
/// capture is a capture of, and so what its replay asks for.
pub fn capture_address(capture_url: &str) -> Option<&str> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"(?i)^https?://(?:www\.)?web\.archive\.org/web/[0-9]{4,14}(?:[a-z_]+)?/(https?://.+)$",
        )
        .expect("static regex")
    });
    re.captures(capture_url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
}

/// Every capture the index holds of an app, across its addresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppListing {
    /// The address whose listing leads: the US page, or the stored address
    /// when the US index holds nothing.
    pub lookup_url: String,
    /// The older addresses asked about, whatever their index held.
    pub alternate_urls: Vec<String>,
    /// Oldest first, one per timestamp; each capture's `url` names the
    /// address it is a capture of.
    pub captures: Vec<Capture>,
}

/// [`list_captures`] for an app: the US-storefront address first, then the
/// stored address when the US index is empty or unusable, then every older
/// address the user added, merged in with the first listing of a timestamp
/// kept. A US index that is merely smaller than the stored address's still
/// wins: comparing would cost every non-US app a second listing, and an
/// address with more history can be added as an older address. `None` when
/// no address answered with a usable index; throttling anywhere is the
/// error, at once.
pub async fn list_app_captures(
    fetcher: &dyn Fetcher,
    stored_url: &str,
    alternates: &[String],
    from_ms: Option<i64>,
    now: i64,
) -> Result<Option<AppListing>, Unavailable> {
    let us = us_storefront_url(stored_url).filter(|us| us != stored_url);
    let mut lookups: Vec<&str> = us.iter().map(String::as_str).collect();
    lookups.push(stored_url);
    let mut found: Option<(String, Vec<Capture>)> = None;
    let mut first_empty: Option<&str> = None;
    for address in lookups.iter().copied() {
        match list_captures(fetcher, address, from_ms, now).await? {
            Some(captures) if !captures.is_empty() => {
                found = Some((address.to_string(), captures));
                break;
            }
            Some(_) => {
                first_empty.get_or_insert(address);
            }
            None => {}
        }
    }
    let (lookup_url, mut captures) = match (found, first_empty) {
        (Some(found), _) => found,
        (None, Some(address)) => (address.to_string(), vec![]),
        (None, None) => return Ok(None),
    };
    let mut seen: HashSet<String> = captures.iter().map(|c| c.timestamp.clone()).collect();
    let mut alternate_urls = vec![];
    for address in alternates {
        if lookups.contains(&address.as_str()) || alternate_urls.contains(address) {
            continue;
        }
        alternate_urls.push(address.clone());
        let Some(listed) = list_captures(fetcher, address, from_ms, now).await? else {
            continue;
        };
        for capture in listed {
            if seen.insert(capture.timestamp.clone()) {
                captures.push(capture);
            }
        }
    }
    captures.sort_by_key(|c| c.ms);
    Ok(Some(AppListing {
        lookup_url,
        alternate_urls,
        captures,
    }))
}

/// `lookupLatestWaybackSnapshot`: the availability API's newest capture of
/// a URL, or `None` for anything it cannot answer. Unlike the dated
/// lookup it never looks at the status: a throttled or failing API reads
/// as "no capture" through whatever body it sent, and a timeout is not an
/// abort, so no failure escapes it. The policy store links the version it
/// has just stored to this capture.
pub async fn lookup_latest(fetcher: &dyn Fetcher, target_url: &str) -> Option<Snapshot> {
    if target_url.is_empty() {
        return None;
    }
    let endpoint = format!(
        "https://archive.org/wayback/available?url={}",
        js_encode_uri_component(target_url)
    );
    let req = request(
        endpoint,
        WAYBACK_HOSTS,
        AVAILABILITY_MAX_BYTES,
        AVAILABILITY_TIMEOUT_MS,
        &[("Accept", "application/json"), ("User-Agent", USER_AGENT)],
    );
    let reply = fetcher.fetch(req).await.ok()?;
    let parsed: Value = serde_json::from_str(&String::from_utf8_lossy(&reply.body)).ok()?;
    let closest = &parsed["archived_snapshots"]["closest"];
    if !truthy(closest) || closest["available"] == Value::Bool(false) {
        return None;
    }
    let Value::String(url) = &closest["url"] else {
        return None;
    };
    if !url.starts_with("http") {
        return None;
    }
    Some(Snapshot {
        url: url.clone(),
        timestamp: closest["timestamp"].as_str().map(str::to_string),
    })
}

/// `lookupWaybackSnapshotNear`: the availability API's closest capture to
/// a date, `None` for an answer without one, or `Unavailable` for
/// throttling or a transport failure.
pub async fn lookup_near(
    fetcher: &dyn Fetcher,
    target_url: &str,
    target_ms: i64,
    now: i64,
) -> Result<Option<Snapshot>, Unavailable> {
    if target_url.is_empty() {
        return Ok(None);
    }
    let endpoint = format!(
        "https://archive.org/wayback/available?url={}&timestamp={}",
        js_encode_uri_component(target_url),
        format_timestamp(target_ms)
    );
    let req = request(
        endpoint,
        WAYBACK_HOSTS,
        AVAILABILITY_MAX_BYTES,
        AVAILABILITY_TIMEOUT_MS,
        &[("Accept", "application/json"), ("User-Agent", USER_AGENT)],
    );
    let reply = match fetcher.fetch(req).await {
        Ok(reply) => reply,
        Err(error) => {
            return Unavailable::transport(&error, "availability API").map_or(Ok(None), Err)
        }
    };
    unavailable_if(&reply, "availability API", now)?;
    let Ok(parsed) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&reply.body)) else {
        return Ok(None);
    };
    let closest = &parsed["archived_snapshots"]["closest"];
    if !truthy(closest) || closest["available"] == Value::Bool(false) {
        return Ok(None);
    }
    let Value::String(url) = &closest["url"] else {
        return Ok(None);
    };
    if !url.starts_with("http") {
        return Ok(None);
    }
    Ok(Some(Snapshot {
        url: url.clone(),
        timestamp: closest["timestamp"].as_str().map(str::to_string),
    }))
}

/// `WaybackSaveResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveResult {
    Saved(Snapshot),
    Failed(String),
}

/// `submitToWaybackSaveNow`: a raw GET with manual redirects whose
/// Location or Content-Location names the capture; the body is never read.
pub async fn save_now(fetcher: &dyn Fetcher, target_url: &str) -> SaveResult {
    if target_url.is_empty() {
        return SaveResult::Failed("missing target url".to_string());
    }
    let endpoint = format!("https://web.archive.org/save/{target_url}");
    if let Err(e) = outbound::validate(&endpoint, WAYBACK_HOSTS, 2048) {
        return SaveResult::Failed(format!("Save Page Now URL rejected: {}", e.detail));
    }
    let mut req = request(
        endpoint.clone(),
        WAYBACK_HOSTS,
        4 * 1024 * 1024,
        SAVE_NOW_TIMEOUT_MS,
        &[
            ("Accept", "text/html,application/xhtml+xml"),
            ("User-Agent", USER_AGENT),
        ],
    );
    req.follow_redirects = false;
    req.read_body = false;
    let reply = match fetcher.fetch(req).await {
        Ok(reply) => reply,
        Err(message) => {
            return SaveResult::Failed(if message.is_empty() {
                "save now request failed".to_string()
            } else {
                message
            })
        }
    };
    if let Some(snapshot) = snapshot_from_header(reply.header("location"), &endpoint)
        .or_else(|| snapshot_from_header(reply.header("content-location"), &endpoint))
    {
        return SaveResult::Saved(snapshot);
    }
    if reply.status == 429 {
        return SaveResult::Failed(
            match reply.header("retry-after").filter(|h| !h.is_empty()) {
                Some(header) => format!("Save Page Now rate-limited; retry after {header}s"),
                None => "Save Page Now rate-limited".to_string(),
            },
        );
    }
    if reply.status >= 400 {
        return SaveResult::Failed(format!("Save Page Now returned HTTP {}", reply.status));
    }
    SaveResult::Failed(format!(
        "Save Page Now returned {} without a snapshot URL",
        reply.status
    ))
}

/// `snapshotFromWaybackHeader`: a Location resolved against the request,
/// accepted only on the replay host with a `/web/<timestamp>/` path.
fn snapshot_from_header(raw: Option<&str>, base: &str) -> Option<Snapshot> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let url = Url::parse(base).ok()?.join(raw).ok()?;
    let resolved = outbound::validate(url.as_str(), WAYBACK_HOSTS, 2048).ok()?;
    let host = resolved.host_str()?.to_lowercase();
    if host != "web.archive.org" && host != "www.web.archive.org" {
        return None;
    }
    static PATH: OnceLock<Regex> = OnceLock::new();
    let path = PATH
        .get_or_init(|| Regex::new(r"(?i)^/web/[0-9]{4,14}(?:[a-z_]+)?/").expect("static regex"));
    if !path.is_match(resolved.path()) {
        return None;
    }
    let snapshot_url = resolved.to_string();
    Some(Snapshot {
        timestamp: extract_timestamp(&snapshot_url),
        url: snapshot_url,
    })
}

#[cfg(test)]
mod tests {
    use super::{format_timestamp, parse_retry_after_ms, parse_timestamp_ms, Unavailable};

    #[test]
    fn transport_failures_are_unavailable_and_nothing_else_is() {
        // What the transport reports for each, as Node's undici does.
        for (error, message) in [
            ("fetch failed", "archive.org refused the connection for CDX index"),
            ("terminated", "archive.org dropped the connection for CDX index"),
            (
                "The operation was aborted due to timeout",
                "archive.org timed out for CDX index",
            ),
            (
                "Blocked URL: host web.archive.org did not resolve to a public address",
                "archive.org could not be resolved for CDX index",
            ),
        ] {
            let unavailable = Unavailable::transport(error, "CDX index").expect(error);
            assert_eq!(unavailable.message, message);
            assert_eq!((unavailable.status, unavailable.retry_after_ms), (0, None));
        }
        // Not archive.org refusing us: a policy block, a body over the cap,
        // a redirect loop, a cancelled run.
        for error in [
            "Blocked URL: invalid_url — https://example.com",
            "safeFetch: response exceeded 1048576 bytes",
            "safeFetch: declared content-length 2000000 exceeds cap 1048576",
            "safeFetch: too many redirects (6)",
            "This operation was aborted",
            "",
        ] {
            assert_eq!(Unavailable::transport(error, "CDX index"), None, "{error}");
        }
    }

    #[test]
    fn timestamps_and_retry_after_follow_node() {
        // Every pair is from node -e.
        assert_eq!(
            parse_timestamp_ms(Some("20210215120000")),
            Some(1_613_390_400_000)
        );
        // "2021" pads to December 00, which rolls back to 30 November.
        assert_eq!(parse_timestamp_ms(Some("2021")), Some(1_638_230_400_000));
        assert_eq!(
            parse_timestamp_ms(Some("20210230")),
            Some(1_614_686_400_000)
        );
        assert_eq!(parse_timestamp_ms(Some("abc")), None);
        assert_eq!(parse_timestamp_ms(None), None);
        assert_eq!(format_timestamp(1_613_390_400_000), "20210215");
        let now = 1_635_768_000_000; // 2021-11-01T12:00:00Z
        assert_eq!(parse_retry_after_ms(Some("120"), now), Some(120_000));
        assert_eq!(parse_retry_after_ms(Some("0"), now), Some(0));
        assert_eq!(parse_retry_after_ms(Some("1.5"), now), Some(1500));
        assert_eq!(
            parse_retry_after_ms(Some("Mon, 01 Nov 2021 12:02:00 GMT"), now),
            Some(120_000)
        );
        assert_eq!(
            parse_retry_after_ms(Some("Mon, 01 Nov 2021 11:00:00 GMT"), now),
            Some(0)
        );
        assert_eq!(parse_retry_after_ms(Some("soon"), now), None);
    }
}

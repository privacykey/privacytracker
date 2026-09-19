//! Phase 6, batch 3a: the HTTP details of `next start` that serving the
//! build depends on. Each is a port of the code Next runs, named after it:
//! Next's ETag (`server/lib/etag.js`), the `fresh`, `range-parser`,
//! `negotiator` and `mime` modules Next vendors, the `_rsc` cache-busting
//! parameter (`cache-busting-search-param.js`) and the repeated-slash
//! redirect (`normalizeRepeatedSlashes`). Pure functions, so each is pinned
//! by a unit test against values Node produced.
use crate::jsnum::js_parse_int;

// ── next/dist/server/lib/etag.js ─────────────────────────────────────

/// `fnv1a52` over a string's UTF-16 code units, in the four 16-bit lanes
/// the JavaScript uses (every intermediate fits a double exactly).
pub(crate) fn fnv1a52(text: &str) -> u64 {
    let (mut v0, mut v1, mut v2, mut v3): (u64, u64, u64, u64) = (0x2325, 0x8422, 0x9ce4, 0xcbf2);
    for unit in text.encode_utf16() {
        v0 ^= u64::from(unit);
        let t0 = v0 * 435;
        let mut t1 = v1 * 435;
        let mut t2 = v2 * 435;
        let t3 = v3 * 435 + (v1 << 8);
        t2 += v0 << 8;
        t1 += t0 >> 16;
        v0 = t0 & 65535;
        t2 += t1 >> 16;
        v1 = t1 & 65535;
        v3 = (t3 + (t2 >> 16)) & 65535;
        v2 = t2 & 65535;
    }
    (v3 & 15) * 281_474_976_710_656 + v2 * 4_294_967_296 + v1 * 65536 + (v0 ^ (v3 >> 4))
}

/// `Number.prototype.toString(36)` for a non-negative integer.
pub(crate) fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = vec![];
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `generateETag(payload)`: the hash, then the length in UTF-16 units.
pub(crate) fn generate_etag(text: &str) -> String {
    let units = text.encode_utf16().count() as u64;
    format!("\"{}{}\"", base36(fnv1a52(text)), base36(units))
}

/// The `etag` module's weak tag for a file, as `send` sets it:
/// `W/"<size hex>-<mtime ms hex>"`.
pub(crate) fn file_etag(size: u64, mtime_ms: i64) -> String {
    format!("W/\"{size:x}-{mtime_ms:x}\"")
}

// ── fresh ────────────────────────────────────────────────────────────

/// `parseTokenList` from `fresh`: split on commas, dropping the spaces
/// around each token.
pub(crate) fn parse_token_list(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let (mut start, mut end) = (0usize, 0usize);
    let mut list = vec![];
    for (i, b) in bytes.iter().enumerate() {
        match b {
            b' ' => {
                if start == end {
                    start = i + 1;
                    end = i + 1;
                }
            }
            b',' => {
                list.push(&s[start..end]);
                start = i + 1;
                end = i + 1;
            }
            _ => end = i + 1,
        }
    }
    list.push(&s[start..end]);
    list
}

/// Whether one tag in an `If-None-Match` or `If-Match` list names `etag`,
/// weakly: `W/` on either side is ignored.
pub(crate) fn tag_matches(token: &str, etag: &str) -> bool {
    token == etag || format!("W/{etag}") == token || format!("W/{token}") == etag
}

/// `Date.parse` for a header value; `None` is JavaScript's `NaN`.
pub(crate) fn parse_http_date(value: &str) -> Option<i64> {
    crate::jsdate::parse(value)
}

/// The request's validators, as `fresh` reads them.
#[derive(Default, Clone, Copy)]
pub(crate) struct Conditional<'a> {
    pub if_none_match: Option<&'a str>,
    pub if_modified_since: Option<&'a str>,
    pub cache_control: Option<&'a str>,
}

/// `fresh(req.headers, res)`. `honour_no_cache` is false on the page path,
/// where a request's `Cache-Control: no-cache` never reaches the check:
/// Node answers 304 to it there.
pub(crate) fn fresh(
    req: Conditional<'_>,
    etag: Option<&str>,
    last_modified: Option<&str>,
    honour_no_cache: bool,
) -> bool {
    let (none_match, modified_since) = (
        req.if_none_match.filter(|v| !v.is_empty()),
        req.if_modified_since.filter(|v| !v.is_empty()),
    );
    if none_match.is_none() && modified_since.is_none() {
        return false;
    }
    if honour_no_cache && req.cache_control.is_some_and(has_no_cache) {
        return false;
    }
    if let Some(none_match) = none_match.filter(|v| *v != "*") {
        let Some(etag) = etag else {
            return false;
        };
        if !parse_token_list(none_match)
            .iter()
            .any(|token| tag_matches(token, etag))
        {
            return false;
        }
    }
    if let Some(since) = modified_since {
        let stale = match (
            last_modified.and_then(parse_http_date),
            parse_http_date(since),
        ) {
            (Some(modified), Some(since)) => modified > since,
            _ => true,
        };
        if stale {
            return false;
        }
    }
    true
}

/// `/(?:^|,)\s*?no-cache\s*?(?:,|$)/`.
fn has_no_cache(value: &str) -> bool {
    value
        .split(',')
        .any(|part| part.trim_matches(crate::jsstr::is_js_whitespace) == "no-cache")
}

// ── range-parser, with `combine: true` ───────────────────────────────

/// `rangeParser(size, header, { combine: true })`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Ranges {
    /// `-2`: no `=`.
    Malformed,
    /// `-1`: nothing satisfiable.
    Unsatisfiable,
    /// Inclusive byte ranges, merged and back in request order.
    Satisfiable(Vec<(u64, u64)>),
}

pub(crate) fn parse_ranges(size: u64, header: &str) -> Ranges {
    let Some(eq) = header.find('=') else {
        return Ranges::Malformed;
    };
    let size = size as i64;
    let mut ranges: Vec<(i64, i64, usize)> = vec![];
    for (index, part) in header[eq + 1..].split(',').enumerate() {
        let mut halves = part.split('-');
        let start = js_parse_int(halves.next().unwrap_or(""));
        let end = js_parse_int(halves.next().unwrap_or(""));
        let (start, end) = match (start, end) {
            (None, Some(end)) => (Some(size - end), Some(size - 1)),
            (Some(start), None) => (Some(start), Some(size - 1)),
            other => other,
        };
        let (Some(start), Some(mut end)) = (start, end) else {
            continue;
        };
        if end > size - 1 {
            end = size - 1;
        }
        if start > end || start < 0 {
            continue;
        }
        ranges.push((start, end, index));
    }
    if ranges.is_empty() {
        return Ranges::Unsatisfiable;
    }
    // `combineRanges`: by start, overlapping or adjacent ones merged, each
    // keeping the earliest index, then back in index order.
    ranges.sort_by_key(|r| r.0);
    let mut merged: Vec<(i64, i64, usize)> = vec![ranges[0]];
    for &(start, end, index) in &ranges[1..] {
        let current = merged.last_mut().expect("seeded with the first range");
        if start > current.1 + 1 {
            merged.push((start, end, index));
        } else if end > current.1 {
            current.1 = end;
            current.2 = current.2.min(index);
        }
    }
    merged.sort_by_key(|r| r.2);
    Ranges::Satisfiable(
        merged
            .into_iter()
            .map(|(start, end, _)| (start as u64, end as u64))
            .collect(),
    )
}

// ── mime (the table Next's bundled `send` answers with) ─────────────

/// `mime.lookup` and `mime.charsets.lookup` for a file name, as the
/// `Content-Type` `send` writes.
pub(crate) fn content_type_for(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "js" | "mjs" => "application/javascript; charset=UTF-8",
        "css" => "text/css; charset=UTF-8",
        "html" | "htm" => "text/html; charset=UTF-8",
        "txt" => "text/plain; charset=UTF-8",
        "csv" => "text/csv; charset=UTF-8",
        "md" => "text/markdown; charset=UTF-8",
        "json" | "map" => "application/json; charset=UTF-8",
        "webmanifest" => "application/manifest+json",
        "xml" => "application/xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

/// The `compression` middleware's filter, `compressible(type)`, for the
/// types this server can answer with.
pub(crate) fn compressible(content_type: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if essence.starts_with("text/") {
        return true;
    }
    matches!(
        essence.as_str(),
        "application/javascript"
            | "application/json"
            | "application/manifest+json"
            | "application/xml"
            | "application/wasm"
            | "image/x-icon"
            | "image/svg+xml"
            | "application/vnd.ms-fontobject"
            | "font/ttf"
            | "font/otf"
    )
}

// ── negotiator, as `compression` asks it ─────────────────────────────

struct Spec {
    encoding: String,
    q: f64,
    index: usize,
}

/// `parseAcceptEncoding`: each entry with its `q`, and `identity` added at
/// the lowest quality given when no entry covers it.
fn parse_accept_encoding(header: &str) -> Vec<Spec> {
    let mut specs = vec![];
    let mut has_identity = false;
    let mut min_quality: f64 = 1.0;
    let parts: Vec<&str> = header.split(',').collect();
    for (index, part) in parts.iter().enumerate() {
        let trimmed = part.trim();
        let (name, params) = match trimmed.split_once(';') {
            Some((name, params)) => (name.trim(), Some(params)),
            None => (trimmed, None),
        };
        if name.is_empty() || name.contains(char::is_whitespace) {
            continue;
        }
        let mut q = 1.0;
        if let Some(params) = params {
            for param in params.split(';') {
                let mut kv = param.trim().splitn(2, '=');
                if kv.next() == Some("q") {
                    q = js_parse_float(kv.next().unwrap_or(""));
                    break;
                }
            }
        }
        has_identity = has_identity || name == "*" || name.eq_ignore_ascii_case("identity");
        min_quality = min_quality.min(if q == 0.0 || q.is_nan() { 1.0 } else { q });
        specs.push(Spec {
            encoding: name.to_string(),
            q,
            index,
        });
    }
    if !has_identity {
        specs.push(Spec {
            encoding: "identity".into(),
            q: min_quality,
            index: parts.len(),
        });
    }
    specs
}

/// `parseFloat`: the longest decimal prefix, NaN when there is none.
fn js_parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(crate::jsstr::is_js_whitespace);
    let mut end = 0;
    let bytes = t.as_bytes();
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    let mut seen_digit = false;
    let mut seen_dot = false;
    while end < bytes.len() {
        match bytes[end] {
            b'0'..=b'9' => seen_digit = true,
            b'.' if !seen_dot => seen_dot = true,
            _ => break,
        }
        end += 1;
    }
    if !seen_digit {
        return f64::NAN;
    }
    t[..end].parse().unwrap_or(f64::NAN)
}

/// `accepts(req).encoding(available)`: the preferred one, or `None`.
fn preferred(specs: &[Spec], available: &[&'static str]) -> Option<&'static str> {
    // (q, s, o, i) per available encoding: its best matching spec.
    let mut priorities: Vec<(f64, u8, i64, usize)> = vec![];
    for (i, encoding) in available.iter().enumerate() {
        let mut best: (f64, u8, i64, usize) = (0.0, 0, -1, i);
        for spec in specs {
            let s = if spec.encoding.eq_ignore_ascii_case(encoding) {
                1
            } else if spec.encoding == "*" {
                0
            } else {
                continue;
            };
            let candidate = (spec.q, s, spec.index as i64, i);
            let better = (best.1 as i64 - s as i64) < 0
                || (best.1 == s && best.0 - candidate.0 < 0.0)
                || (best.1 == s && best.0 == candidate.0 && best.2 - candidate.2 < 0);
            if better {
                best = candidate;
            }
        }
        priorities.push(best);
    }
    let mut ranked: Vec<&(f64, u8, i64, usize)> = priorities.iter().filter(|p| p.0 > 0.0).collect();
    ranked.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.cmp(&a.1))
            .then(a.2.cmp(&b.2))
            .then(a.3.cmp(&b.3))
    });
    ranked.first().map(|p| available[p.3])
}

/// The encoding the `compression` middleware picks: gzip or deflate (it
/// never offers brotli), gzip over deflate when both are acceptable, and
/// `None` for identity.
pub(crate) fn negotiate_encoding(accept_encoding: Option<&str>) -> Option<&'static str> {
    let specs = parse_accept_encoding(accept_encoding.unwrap_or(""));
    let mut method = preferred(&specs, &["gzip", "deflate", "identity"]);
    if method == Some("deflate") && preferred(&specs, &["gzip"]).is_some() {
        method = preferred(&specs, &["gzip", "identity"]);
    }
    method.filter(|m| *m != "identity")
}

// ── the `_rsc` cache-busting search parameter ────────────────────────

/// The four request headers the parameter is a hash of.
#[derive(Default, Clone, Copy)]
pub(crate) struct RouterHeaders<'a> {
    pub prefetch: Option<&'a str>,
    pub segment_prefetch: Option<&'a str>,
    pub state_tree: Option<&'a str>,
    pub next_url: Option<&'a str>,
}

/// `createCacheBustingSearchParamInput`, `None` meaning no parameter value.
fn cache_busting_input(h: RouterHeaders<'_>) -> Option<String> {
    if matches!(h.prefetch, None | Some("0"))
        && h.segment_prefetch.is_none()
        && h.state_tree.is_none()
        && h.next_url.is_none()
    {
        return None;
    }
    Some(
        [
            h.prefetch.unwrap_or("0"),
            h.segment_prefetch.unwrap_or("0"),
            h.state_tree.unwrap_or("0"),
            h.next_url.unwrap_or("0"),
        ]
        .join(","),
    )
}

/// `computeCacheBustingSearchParam`: SHA-256 cut to 96 bits, base64url.
pub(crate) fn cache_busting_param(h: RouterHeaders<'_>) -> String {
    cache_busting_input(h).map_or_else(String::new, |input| {
        let digest = ring::digest::digest(&ring::digest::SHA256, input.as_bytes());
        crate::scrape::persist::base64url(&digest.as_ref()[..12])
    })
}

/// `computeLegacyCacheBustingSearchParam`: djb2 in base 36, five digits,
/// which clients without a secure context still send.
pub(crate) fn legacy_cache_busting_param(h: RouterHeaders<'_>) -> String {
    cache_busting_input(h).map_or_else(String::new, |input| {
        let mut hash: i32 = 5381;
        for unit in input.encode_utf16() {
            hash = (i64::from(hash.wrapping_shl(5)) + i64::from(hash) + i64::from(unit)) as i32;
        }
        let mut digits = base36(u64::from(hash as u32));
        digits.truncate(5);
        digits
    })
}

/// `setCacheBustingSearchParamWithHash` over a raw query: every `_rsc=`
/// pair dropped (a bare `_rsc` survives), then `_rsc=<hash>`, or a bare
/// `_rsc` for an empty hash.
pub(crate) fn with_cache_busting_param(query: Option<&str>, hash: &str) -> String {
    let mut pairs: Vec<String> = query
        .unwrap_or("")
        .split('&')
        .filter(|pair| !pair.is_empty() && !pair.starts_with("_rsc="))
        .map(str::to_string)
        .collect();
    pairs.push(if hash.is_empty() {
        "_rsc".into()
    } else {
        format!("_rsc={hash}")
    });
    pairs.join("&")
}

// ── the repeated-slash redirect ──────────────────────────────────────

/// `normalizeRepeatedSlashes` when the path holds `//` or a backslash:
/// backslashes become slashes, runs of slashes collapse, and a non-empty
/// query is kept as it was.
pub(crate) fn repeated_slash_target(path: &str, query: Option<&str>) -> Option<String> {
    if !(path.contains("//") || path.contains('\\')) {
        return None;
    }
    let forward = path.replace('\\', "/");
    let mut out = String::with_capacity(forward.len());
    for c in forward.chars() {
        if c == '/' && out.ends_with('/') {
            continue;
        }
        out.push(c);
    }
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        out.push('?');
        out.push_str(q);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etags_match_next() {
        // Node: generateETag("Internal Server Error"), and `etag(stat)` for
        // the recorded brand-icon.png.
        assert_eq!(generate_etag("Internal Server Error"), "\"66fci67lppl\"");
        // Over UTF-16: `λ` is one code unit, two UTF-8 bytes.
        assert_eq!(generate_etag("<html>home λ</html>"), "\"3xdgpnl4hej\"");
        assert_eq!(
            file_etag(54615, 1_789_633_728_912),
            "W/\"d557-1a0ae7b9190\""
        );
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
    }

    #[test]
    fn freshness_follows_fresh() {
        let req =
            |inm: Option<&'static str>, ims: Option<&'static str>, cc: Option<&'static str>| {
                Conditional {
                    if_none_match: inm,
                    if_modified_since: ims,
                    cache_control: cc,
                }
            };
        let etag = Some("\"abc\"");
        assert!(fresh(req(Some("\"abc\""), None, None), etag, None, true));
        assert!(fresh(req(Some("W/\"abc\""), None, None), etag, None, true));
        assert!(fresh(
            req(Some("\"x\", \"abc\""), None, None),
            etag,
            None,
            true
        ));
        assert!(fresh(req(Some("*"), None, None), etag, None, true));
        assert!(!fresh(req(Some("\"x\""), None, None), etag, None, true));
        assert!(!fresh(
            req(Some("\"abc\""), None, Some("no-cache")),
            etag,
            None,
            true
        ));
        assert!(fresh(
            req(Some("\"abc\""), None, Some("no-cache")),
            etag,
            None,
            false
        ));
        // An If-Modified-Since with no Last-Modified is stale.
        assert!(!fresh(
            req(Some("\"abc\""), Some("Thu, 17 Sep 2099 08:28:48 GMT"), None),
            etag,
            None,
            true
        ));
        let lm = Some("Thu, 17 Sep 2026 08:28:48 GMT");
        assert!(fresh(
            req(None, Some("Thu, 17 Sep 2026 08:28:48 GMT"), None),
            None,
            lm,
            true
        ));
        assert!(!fresh(
            req(None, Some("Thu, 01 Jan 2000 00:00:00 GMT"), None),
            None,
            lm,
            true
        ));
        assert!(!fresh(req(None, None, None), etag, lm, true));
    }

    #[test]
    fn ranges_parse_like_range_parser() {
        use Ranges::*;
        assert_eq!(parse_ranges(100, "bytes=0-9"), Satisfiable(vec![(0, 9)]));
        assert_eq!(parse_ranges(100, "bytes=-5"), Satisfiable(vec![(95, 99)]));
        assert_eq!(parse_ranges(100, "bytes=95-"), Satisfiable(vec![(95, 99)]));
        assert_eq!(
            parse_ranges(100, "bytes=90-200"),
            Satisfiable(vec![(90, 99)])
        );
        assert_eq!(
            parse_ranges(100, "bytes=0-5,3-9"),
            Satisfiable(vec![(0, 9)])
        );
        assert_eq!(
            parse_ranges(100, "bytes=0-1,10-11"),
            Satisfiable(vec![(0, 1), (10, 11)])
        );
        assert_eq!(
            parse_ranges(100, "bytes=20-29,0-9,10-19"),
            Satisfiable(vec![(0, 29)])
        );
        assert_eq!(parse_ranges(100, "bytes=999-"), Unsatisfiable);
        assert_eq!(parse_ranges(100, "bytes"), Malformed);
        assert_eq!(parse_ranges(100, "items=0-5"), Satisfiable(vec![(0, 5)]));
    }

    #[test]
    fn encodings_negotiate_like_compression() {
        assert_eq!(negotiate_encoding(None), None);
        assert_eq!(negotiate_encoding(Some("gzip")), Some("gzip"));
        assert_eq!(negotiate_encoding(Some("br")), None);
        assert_eq!(negotiate_encoding(Some("br, gzip")), Some("gzip"));
        assert_eq!(negotiate_encoding(Some("deflate")), Some("deflate"));
        assert_eq!(negotiate_encoding(Some("*")), Some("gzip"));
        assert_eq!(negotiate_encoding(Some("gzip;q=0")), None);
        assert_eq!(negotiate_encoding(Some("identity")), None);
        assert_eq!(negotiate_encoding(Some("*;q=0")), None);
        assert_eq!(
            negotiate_encoding(Some("gzip;q=0.5, deflate;q=0.8")),
            Some("gzip")
        );
        assert_eq!(negotiate_encoding(Some("gzip, deflate, br")), Some("gzip"));
    }

    #[test]
    fn cache_busting_params_match_next() {
        // Recorded from `next start`: the `_rsc` a prefetch of /dashboard is
        // redirected to, a `_tree` segment prefetch's, and the bare form.
        let prefetch = RouterHeaders {
            prefetch: Some("1"),
            ..Default::default()
        };
        assert_eq!(cache_busting_param(prefetch), "HEAvJdHAQJrUAe2K");
        let tree = RouterHeaders {
            prefetch: Some("1"),
            segment_prefetch: Some("/_tree"),
            ..Default::default()
        };
        assert_eq!(cache_busting_param(tree), "_i_aeImnuN6u1u1r");
        assert_eq!(cache_busting_param(RouterHeaders::default()), "");
        let zero = RouterHeaders {
            prefetch: Some("0"),
            ..Default::default()
        };
        assert_eq!(cache_busting_param(zero), "");
        assert_eq!(
            with_cache_busting_param(Some("_rsc&x=%20y"), "HEAvJdHAQJrUAe2K"),
            "_rsc&x=%20y&_rsc=HEAvJdHAQJrUAe2K"
        );
        assert_eq!(with_cache_busting_param(Some("_rsc=abc12"), ""), "_rsc");
        assert_eq!(with_cache_busting_param(None, ""), "_rsc");
    }

    #[test]
    fn repeated_slashes_collapse() {
        assert_eq!(
            repeated_slash_target("//dashboard", None).as_deref(),
            Some("/dashboard")
        );
        assert_eq!(
            repeated_slash_target("//dashboard", Some("x=1&y")).as_deref(),
            Some("/dashboard?x=1&y")
        );
        assert_eq!(
            repeated_slash_target("/dashboard//", None).as_deref(),
            Some("/dashboard/")
        );
        assert_eq!(
            repeated_slash_target("/a\\b", None).as_deref(),
            Some("/a/b")
        );
        assert_eq!(repeated_slash_target("/a/b", None), None);
    }
}

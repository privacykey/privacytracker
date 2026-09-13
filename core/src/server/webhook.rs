//! Port of `maskWebhookUrl` from `app/api/settings/route.ts` — the read
//! side of the notification-webhook secret.
//!
//! Node parses the stored value with `new URL`, blanks credentials, query
//! and fragment, and rebuilds from `origin` + the path segments: no segments
//! → `origin/***`; a Slack incoming webhook (`hooks.slack.com/services/T/B/X`)
//! → `origin/services/T***/B***/***`; otherwise the first segment survives
//! only when it looks like a plain route name (`/^[a-z][a-z0-9._-]{0,24}$/i`)
//! and everything after it is `***`. A value `new URL` refuses is reported as
//! the word `configured`.
//!
//! **The URL parser here is a subset of WHATWG, not the `url` crate**, for
//! the reason `trust.rs` gives: that crate brings IDNA and ICU4X with it.
//! The subset is chosen against what the row can hold. On write,
//! `validateExternalUrl` stores `new URL(raw).toString()` — an http(s) URL
//! already in canonical form: lowercase scheme and host, default port
//! dropped, dot segments resolved, path percent-encoded, no credentials.
//! Re-parsing that is the realistic case and is exact. Beyond it, this
//! handles what a hand-edited row plausibly holds — uppercase, tabs and
//! newlines, a default port spelled out (`:443`, `:0443`), credentials,
//! query and fragment, backslashes, `.`/`..`/`%2e` segments, missing or
//! extra slashes after the scheme, and the special-vs-non-special scheme
//! split that makes `origin` the string `"null"` — and is pinned on all of
//! it by `tests/settings_cases.rs`, whose expected values come from running
//! the real function.
//!
//! What it does NOT reproduce, each unreachable from an app-written row:
//! IDNA (a non-ASCII host is kept as typed, lowercased; Node would
//! Punycode it), IPv4 shorthand (`127.1` stays `127.1`; Node expands it),
//! IPv6 compression (`[0:0:0:0:0:0:0:1]` stays long), percent-escapes in a
//! host (kept; Node decodes), and `file:` hosts beyond the `file:///` form.
//! Every one of these changes only the spelling of the host inside an
//! otherwise identical mask.

use crate::jsstr::is_js_whitespace;

const MASK: &str = "***";

/// What `maskWebhookUrl` reads off the parsed URL.
#[derive(Debug, PartialEq, Eq)]
struct ParsedUrl {
    /// `url.origin` — `scheme://host[:port]` for special schemes other than
    /// `file`, the literal `null` otherwise (and for `blob:`, the inner
    /// URL's origin when that is http(s)).
    origin: String,
    /// `url.hostname` — empty for a non-special or opaque-path URL.
    hostname: String,
    /// `url.pathname` after `search` and `hash` were blanked.
    pathname: String,
}

fn default_port(scheme: &str) -> Option<u32> {
    match scheme {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        "ftp" => Some(21),
        _ => None,
    }
}

/// The path percent-encode set: C0 controls, DEL, space, `"`, `#`, `<`,
/// `>`, `?`, `` ` ``, `{`, `}` and every non-ASCII byte. `%` is NOT
/// re-encoded — WHATWG leaves an existing escape alone whether or not it
/// is well-formed.
fn percent_encode_path_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for b in seg.bytes() {
        let plain = b > 0x20
            && b < 0x7F
            && !matches!(b, b'"' | b'#' | b'<' | b'>' | b'?' | b'`' | b'{' | b'}');
        if plain {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn is_single_dot(seg: &str) -> bool {
    seg == "." || seg.eq_ignore_ascii_case("%2e")
}

fn is_double_dot(seg: &str) -> bool {
    seg == ".."
        || seg.eq_ignore_ascii_case(".%2e")
        || seg.eq_ignore_ascii_case("%2e.")
        || seg.eq_ignore_ascii_case("%2e%2e")
}

/// The path state of the WHATWG parser for a hierarchical path: split on
/// `/` (and `\` for special schemes), resolve dot segments — a trailing `.`
/// or `..` leaves a trailing slash — and percent-encode what remains.
fn normalise_hierarchical_path(raw: &str, special: bool) -> String {
    let raw = if special {
        raw.replace('\\', "/")
    } else {
        raw.to_string()
    };
    let raw = raw.strip_prefix('/').unwrap_or(&raw);
    if raw.is_empty() {
        return "/".to_string();
    }
    let parts: Vec<&str> = raw.split('/').collect();
    let mut segments: Vec<String> = Vec::with_capacity(parts.len());
    for (i, seg) in parts.iter().enumerate() {
        let is_last = i == parts.len() - 1;
        if is_double_dot(seg) {
            segments.pop();
            if is_last {
                segments.push(String::new());
            }
        } else if is_single_dot(seg) {
            if is_last {
                segments.push(String::new());
            }
        } else {
            segments.push(percent_encode_path_segment(seg));
        }
    }
    format!("/{}", segments.join("/"))
}

/// Whether a host is admissible: a bracketed IPv6 literal (hex digits,
/// colons and dots inside the brackets — not compressed or validated
/// further, see the module docs), or a domain free of the forbidden host
/// code points. `%` is not in the list, for the reason the module docs give.
fn host_is_admissible(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .chars()
                .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.'));
    }
    !host.chars().any(|c| {
        matches!(
            c,
            '\0' | '\t'
                | '\n'
                | '\r'
                | ' '
                | '#'
                | '/'
                | ':'
                | '<'
                | '>'
                | '?'
                | '@'
                | '['
                | '\\'
                | ']'
                | '^'
                | '|'
        )
    })
}

/// `host[:port]` → (host, port text). An IPv6 literal keeps its brackets.
fn split_host_port(hostport: &str) -> Option<(&str, &str)> {
    if let Some(rest) = hostport.strip_prefix('[') {
        let close = rest.find(']')?;
        let host = &hostport[..close + 2];
        let after = &hostport[close + 2..];
        return match after.strip_prefix(':') {
            Some(port) => Some((host, port)),
            None if after.is_empty() => Some((host, "")),
            None => None,
        };
    }
    match hostport.rfind(':') {
        Some(i) => Some((&hostport[..i], &hostport[i + 1..])),
        None => Some((hostport, "")),
    }
}

/// Port text → `Some(port)` to print, `None` when absent or default; the
/// outer `None` is a parse failure (non-digits, or above 65535).
fn parse_port(text: &str, default: Option<u32>) -> Option<Option<u32>> {
    if text.is_empty() {
        return Some(None);
    }
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = text.trim_start_matches('0').parse().unwrap_or(0);
    if n > 65_535 {
        return None;
    }
    Some(if Some(n) == default { None } else { Some(n) })
}

fn parse_url(input: &str) -> Option<ParsedUrl> {
    // The parser's own pre-processing: strip leading and trailing C0
    // controls and spaces, remove every tab and newline.
    let s: String = input
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();

    let colon = s.find(':')?;
    let scheme_raw = &s[..colon];
    let mut scheme_chars = scheme_raw.chars();
    if !scheme_chars.next()?.is_ascii_alphabetic() {
        return None;
    }
    if !scheme_chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return None;
    }
    let scheme = scheme_raw.to_ascii_lowercase();
    let rest = &s[colon + 1..];

    if scheme == "file" {
        // `file:///p`, `file://host/p`, `file:/p`, `file:p` — the path is
        // what follows the (optional) host; origin is opaque.
        let body = rest.replace('\\', "/");
        let path = if let Some(after) = body.strip_prefix("//") {
            let host_end = after.find('/').unwrap_or(after.len());
            &after[host_end..]
        } else {
            body.as_str()
        };
        let path = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        };
        let path_end = path.find(['?', '#']).unwrap_or(path.len());
        return Some(ParsedUrl {
            origin: "null".to_string(),
            hostname: String::new(),
            pathname: normalise_hierarchical_path(&path[..path_end], true),
        });
    }

    if let Some(default) = default_port(&scheme) {
        // Special scheme: any run of slashes (either kind) after the colon
        // is the authority marker, including none at all.
        let rest = rest.trim_start_matches(['/', '\\']);
        let end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..end];
        let after = &rest[end..];
        let hostport = match authority.rfind('@') {
            Some(i) => &authority[i + 1..],
            None => authority,
        };
        let (host, port) = split_host_port(hostport)?;
        if host.is_empty() {
            return None;
        }
        if !host_is_admissible(host) {
            return None;
        }
        let host = host.to_lowercase();
        let port = parse_port(port, Some(default))?;
        let origin = match port {
            Some(p) => format!("{scheme}://{host}:{p}"),
            None => format!("{scheme}://{host}"),
        };
        let path_end = after.find(['?', '#']).unwrap_or(after.len());
        return Some(ParsedUrl {
            origin,
            hostname: host,
            pathname: normalise_hierarchical_path(&after[..path_end], true),
        });
    }

    // Non-special scheme. `//` introduces an opaque host and a hierarchical
    // path; anything else is an opaque path taken verbatim up to `?`/`#`.
    if let Some(after_slashes) = rest.strip_prefix("//") {
        let end = after_slashes
            .find(['/', '?', '#'])
            .unwrap_or(after_slashes.len());
        let authority = &after_slashes[..end];
        let after = &after_slashes[end..];
        let hostport = match authority.rfind('@') {
            Some(i) => &authority[i + 1..],
            None => authority,
        };
        let (host, port) = split_host_port(hostport)?;
        if !host_is_admissible(host) {
            return None;
        }
        parse_port(port, None)?;
        let path_end = after.find(['?', '#']).unwrap_or(after.len());
        let pathname = if after[..path_end].is_empty() {
            String::new()
        } else {
            normalise_hierarchical_path(&after[..path_end], false)
        };
        return Some(ParsedUrl {
            origin: "null".to_string(),
            // Opaque hosts keep their case.
            hostname: host.to_string(),
            pathname,
        });
    }

    let path_end = rest.find(['?', '#']).unwrap_or(rest.len());
    let pathname = rest[..path_end].to_string();
    // A blob URL's origin is its inner URL's, when that inner URL is
    // http(s); the path is still the opaque inner string.
    let origin = if scheme == "blob" {
        match parse_url(&pathname) {
            Some(inner)
                if inner.origin.starts_with("http://") || inner.origin.starts_with("https://") =>
            {
                inner.origin
            }
            _ => "null".to_string(),
        }
    } else {
        "null".to_string()
    };
    Some(ParsedUrl {
        origin,
        hostname: String::new(),
        pathname,
    })
}

/// `maskWebhookPathSegment`: the first character, then the mask. Node's
/// `.at(0)` is a UTF-16 unit, so an astral first character would give it a
/// lone surrogate; a Rust `char` is the whole character. Unreachable — the
/// segment is a Slack team id.
fn mask_segment(seg: &str) -> String {
    match seg.chars().next() {
        Some(c) => format!("{c}{MASK}"),
        None => MASK.to_string(),
    }
}

/// `/^[a-z][a-z0-9._-]{0,24}$/i`
fn looks_like_route_name(seg: &str) -> bool {
    let mut chars = seg.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    let rest: Vec<char> = chars.collect();
    rest.len() <= 24
        && rest
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `maskWebhookUrl(raw)`.
pub fn mask_webhook_url(raw: &str) -> String {
    let trimmed = raw.trim_matches(is_js_whitespace);
    if trimmed.is_empty() {
        return String::new();
    }
    let Some(url) = parse_url(trimmed) else {
        return "configured".to_string();
    };

    let parts: Vec<&str> = url.pathname.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return format!("{}/{MASK}", url.origin);
    }

    if url.hostname == "hooks.slack.com" && parts[0] == "services" && parts.len() >= 4 {
        return format!(
            "{}/services/{}/{}/{MASK}",
            url.origin,
            mask_segment(parts[1]),
            mask_segment(parts[2])
        );
    }

    let prefix = if looks_like_route_name(parts[0]) {
        format!("{}/", parts[0])
    } else {
        String::new()
    };
    format!("{}/{prefix}{MASK}", url.origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The full table lives in tests/settings_cases.rs, generated from the
    // real function. These pin the parser pieces on their own.

    #[test]
    fn origin_drops_default_ports_and_lowercases() {
        let u = parse_url("HTTPS://Example.COM:0443/Hook").unwrap();
        assert_eq!(u.origin, "https://example.com");
        assert_eq!(u.pathname, "/Hook");
        let u = parse_url("http://example.com:8080/x").unwrap();
        assert_eq!(u.origin, "http://example.com:8080");
        assert!(parse_url("https://example.com:99999/x").is_none());
        assert!(parse_url("https://example.com:abc/x").is_none());
        // An empty port after the colon is allowed and means none.
        assert_eq!(
            parse_url("https://example.com:/x").unwrap().origin,
            "https://example.com"
        );
    }

    #[test]
    fn path_state_resolves_dots_and_encodes() {
        assert_eq!(normalise_hierarchical_path("/./a/../b/c", true), "/b/c");
        assert_eq!(normalise_hierarchical_path("/a/%2e%2E/b", true), "/b");
        assert_eq!(normalise_hierarchical_path("/a/b/..", true), "/a/");
        assert_eq!(normalise_hierarchical_path("/a/.", true), "/a/");
        assert_eq!(normalise_hierarchical_path("\\a\\b", true), "/a/b");
        assert_eq!(
            normalise_hierarchical_path("//double//slash", true),
            "//double//slash"
        );
        assert_eq!(normalise_hierarchical_path("/a b/x", true), "/a%20b/x");
        assert_eq!(
            normalise_hierarchical_path("/caf\u{e9}", true),
            "/caf%C3%A9"
        );
        assert_eq!(normalise_hierarchical_path("", true), "/");
    }

    #[test]
    fn special_schemes_tolerate_missing_or_extra_slashes() {
        for input in [
            "https:example.com/hook",
            "https:/example.com/hook",
            "https:////example.com/hook",
        ] {
            let u = parse_url(input).unwrap();
            assert_eq!(u.origin, "https://example.com", "{input}");
            assert_eq!(u.pathname, "/hook", "{input}");
        }
    }

    #[test]
    fn non_special_schemes_have_a_null_origin() {
        assert_eq!(parse_url("foo://bar/baz").unwrap().pathname, "/baz");
        assert_eq!(parse_url("foo://bar/baz").unwrap().origin, "null");
        assert_eq!(parse_url("mailto:x@y").unwrap().pathname, "x@y");
        assert_eq!(
            parse_url("blob:https://example.com/uuid").unwrap().origin,
            "https://example.com"
        );
        assert_eq!(parse_url("file:///tmp/hook").unwrap().pathname, "/tmp/hook");
    }

    #[test]
    fn refusals_match_new_url() {
        for input in [
            "not a url",
            "example.com/hook",
            "https://",
            "https://exa mple.com/x",
            "//example.com/hook",
            "/hook",
            "1https://example.com",
            "http://[::1",
        ] {
            assert!(parse_url(input).is_none(), "{input}");
        }
    }

    #[test]
    fn route_name_regex() {
        assert!(looks_like_route_name("hook"));
        assert!(looks_like_route_name("Ab_c.d-e"));
        assert!(looks_like_route_name("hooks.slack.com"));
        assert!(looks_like_route_name("a".repeat(25).as_str()));
        assert!(!looks_like_route_name("a".repeat(26).as_str()));
        assert!(!looks_like_route_name("9abc"));
        assert!(!looks_like_route_name("a%20b"));
        assert!(!looks_like_route_name(""));
    }
}

//! The URL rewrites the source layer applies before it fetches:
//! `normalizePolicyUrlLanguage`, `pinGoogleLocale` and `safeUrlLabel` from
//! `lib/privacy-policy.ts`.
//!
//! Both rewrites go through the WHATWG URL parser on either side (`URL` in
//! Node, the `url` crate here), and `URLSearchParams.set` re-serialises the
//! whole query as `application/x-www-form-urlencoded` the moment it
//! changes one pair — `?q=a%20b&lang=fr` comes back as `?q=a+b&lang=en` —
//! so the query is only rewritten when a locale pair actually changed,
//! exactly as Node's setter fires.
use regex::Regex;
use std::sync::OnceLock;
use url::Url;

const PREFERRED_POLICY_LANGUAGE: &str = "en";

/// The curated ISO 639 codes Node rewrites, and no others: an incidental
/// two-letter directory (`/ok/`) is left alone because it is not listed.
const KNOWN_LANGUAGE_CODES: &[&str] = &[
    "af", "am", "ar", "az", "be", "bg", "bn", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "es",
    "et", "eu", "fa", "fi", "fil", "fr", "ga", "gl", "gu", "he", "hi", "hr", "hu", "hy", "id",
    "is", "it", "iw", "ja", "ka", "kk", "km", "kn", "ko", "ky", "lo", "lt", "lv", "mk", "ml", "mn",
    "mr", "ms", "my", "ne", "nl", "nn", "no", "pa", "pl", "ps", "pt", "ro", "ru", "si", "sk", "sl",
    "sq", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk", "ur", "uz", "vi", "zh", "zu",
];

const LOCALE_QUERY_KEYS: [&str; 5] = ["lang", "language", "locale", "hl", "l"];

/// `URLSearchParams.get(key)`: the first pair's decoded value, `None` when
/// the key is absent.
pub(crate) fn search_param_get(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

/// `URLSearchParams.set(key, value)`: the first pair of that name takes the
/// value and the others go, or the pair is appended; then the whole query
/// is re-serialised.
pub(crate) fn search_param_set(url: &mut Url, key: &str, value: &str) {
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut out: Vec<(String, String)> = Vec::with_capacity(pairs.len() + 1);
    let mut seen = false;
    for (k, v) in pairs {
        if k == key {
            if !seen {
                out.push((k, value.to_string()));
                seen = true;
            }
        } else {
            out.push((k, v));
        }
    }
    if !seen {
        out.push((key.to_string(), value.to_string()));
    }
    url.query_pairs_mut().clear().extend_pairs(out);
}

/// `normalizePolicyUrlLanguage`: known language segments in the path and
/// known language values under the locale query keys become `en`; anything
/// unparseable or already English is returned as it came.
pub fn normalize_policy_url_language(url_string: &str) -> String {
    let Ok(mut parsed) = Url::parse(url_string) else {
        return url_string.to_string();
    };
    static SEGMENT: OnceLock<Regex> = OnceLock::new();
    let segment =
        SEGMENT.get_or_init(|| Regex::new(r"^([A-Za-z]{2,3})(?:[-_][A-Za-z]{2,4})?$").unwrap());
    let mut changed = false;

    let segments: Vec<String> = parsed.path().split('/').map(str::to_string).collect();
    let mut rewritten = segments.clone();
    for (i, seg) in segments.iter().enumerate() {
        if seg.is_empty() {
            continue;
        }
        let Some(m) = segment.captures(seg) else {
            continue;
        };
        let base = m[1].to_lowercase();
        if !KNOWN_LANGUAGE_CODES.contains(&base.as_str()) || base == PREFERRED_POLICY_LANGUAGE {
            continue;
        }
        rewritten[i] = PREFERRED_POLICY_LANGUAGE.to_string();
        changed = true;
    }
    if changed {
        parsed.set_path(&rewritten.join("/"));
    }

    for key in LOCALE_QUERY_KEYS {
        let Some(current) = search_param_get(&parsed, key) else {
            continue;
        };
        if current.is_empty() {
            continue;
        }
        let primary = current
            .split(['-', '_'])
            .next()
            .unwrap_or("")
            .to_lowercase();
        if !KNOWN_LANGUAGE_CODES.contains(&primary.as_str()) || primary == PREFERRED_POLICY_LANGUAGE
        {
            continue;
        }
        search_param_set(&mut parsed, key, PREFERRED_POLICY_LANGUAGE);
        changed = true;
    }

    if changed {
        parsed.to_string()
    } else {
        url_string.to_string()
    }
}

/// `pinGoogleLocale`: `hl=en&gl=us` on any Google host, unless both are
/// already pinned; `None` for every other host and for an unparseable URL.
pub fn pin_google_locale(url_string: &str) -> Option<String> {
    let mut parsed = Url::parse(url_string).ok()?;
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let is_google_host = host == "policies.google.com"
        || host == "www.google.com"
        || host == "google.com"
        || host.ends_with(".google.com");
    if !is_google_host {
        return None;
    }
    let has_hl =
        search_param_get(&parsed, "hl").is_some_and(|v| v.to_lowercase().starts_with("en"));
    let has_gl = search_param_get(&parsed, "gl").is_some_and(|v| v.to_lowercase() == "us");
    if has_hl && has_gl {
        return None;
    }
    search_param_set(&mut parsed, "hl", "en");
    search_param_set(&mut parsed, "gl", "us");
    Some(parsed.to_string())
}

/// `safeUrlLabel`: the hostname without a leading `www.`, or "Privacy
/// Policy" when the string is not a URL at all.
pub fn safe_url_label(url: &str) -> String {
    match Url::parse(url) {
        Ok(parsed) => {
            let host = parsed.host_str().unwrap_or("");
            host.strip_prefix("www.").unwrap_or(host).to_string()
        }
        Err(_) => "Privacy Policy".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_known_segments_and_query_pins() {
        assert_eq!(
            normalize_policy_url_language("https://example.com/zh-CN/privacy"),
            "https://example.com/en/privacy"
        );
        assert_eq!(
            normalize_policy_url_language("https://example.com/privacy?q=a%20b&lang=fr"),
            "https://example.com/privacy?q=a+b&lang=en"
        );
        assert_eq!(
            normalize_policy_url_language("https://example.com/xx/privacy?lang=shortform"),
            "https://example.com/xx/privacy?lang=shortform"
        );
        assert_eq!(normalize_policy_url_language("not a url"), "not a url");
    }

    #[test]
    fn pins_google_and_labels_hosts() {
        assert_eq!(
            pin_google_locale("https://policies.google.com/privacy").as_deref(),
            Some("https://policies.google.com/privacy?hl=en&gl=us")
        );
        assert_eq!(
            pin_google_locale("https://policies.google.com/privacy?hl=en-GB&gl=US"),
            None
        );
        assert_eq!(pin_google_locale("https://example.com/"), None);
        assert_eq!(safe_url_label("https://www.example.com/x"), "example.com");
        assert_eq!(safe_url_label("nope"), "Privacy Policy");
    }
}

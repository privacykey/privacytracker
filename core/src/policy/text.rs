//! HTML to policy text, as `lib/privacy-policy.ts` does it with regular
//! expressions: the chrome strip, the block-to-newline pass, entity
//! decoding, whitespace normalisation, the word count and the topic check.
//!
//! Two of Node's patterns use a backreference (`</\1>`) to pair a container
//! with its own closing tag, which the `regex` crate does not support.
//! Those two are scanners here — the opening tag is matched by regex, then
//! the first closing tag of the same name is searched from the end of the
//! opening tag, and on a miss the scan resumes one character after the
//! opening `<`, which is precisely what a backtracking engine does with a
//! global regex — so nested, unclosed and oddly closed containers behave as
//! they do on Node.
//!
//! JavaScript's `i` flag folds case through `toUpperCase`; Rust's `(?i)`
//! through Unicode simple case folding. They agree on every ASCII tag and
//! attribute these patterns look for.
use crate::{
    jsnum::js_number_spelling,
    jsstr::{is_js_whitespace, js_length, js_trim},
};
use regex::Regex;
use std::{cmp::Reverse, sync::OnceLock};

pub const POLICY_MIN_WORDS: usize = 400;
pub const POLICY_MIN_CHARS: usize = 2000;
pub const POLICY_MIN_TOPIC_HITS: usize = 1;

/// JavaScript's `\s` without the `u` flag, as the body of a character
/// class, for the patterns that put it inside one (`[^"'>\s]`).
pub(crate) const WS_CHARS: &str = r"\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

/// A regex written in JavaScript's dialect: `\s` outside a class and
/// `[\s\S]` take their JavaScript meanings. Write `\b` as `(?-u:\b)`.
pub(crate) fn js(source: &str) -> Regex {
    let ws = format!("[{WS_CHARS}]");
    Regex::new(&source.replace(r"[\s\S]", "(?s:.)").replace(r"\s", &ws))
        .expect("static JavaScript regex")
}

macro_rules! re {
    ($name:ident, $source:expr) => {{
        static $name: OnceLock<Regex> = OnceLock::new();
        $name.get_or_init(|| js($source))
    }};
}

/// `POLICY_TOPIC_GUIDES`: each lens's label and keywords, in Node's order.
/// The validator counts the lenses with a hit; the summariser's digest
/// quotes the text around them.
pub(crate) const TOPIC_GUIDES: [(&str, &[&str]); 8] = [
    (
        "Collection Scope",
        &[
            "collect",
            "information we collect",
            "personal information",
            "device information",
            "usage information",
            "automatically collect",
        ],
    ),
    (
        "Product Use",
        &[
            "use your information",
            "provide",
            "operate",
            "improve",
            "personalize",
            "security",
            "support",
        ],
    ),
    (
        "Ads & Marketing",
        &[
            "advertising",
            "marketing",
            "promotional",
            "remarketing",
            "newsletter",
            "interest-based",
        ],
    ),
    (
        "Third-Party Sharing",
        &[
            "share",
            "disclose",
            "service providers",
            "vendors",
            "partners",
            "affiliates",
            "law enforcement",
        ],
    ),
    (
        "Tracking & Analytics",
        &[
            "analytics",
            "cookies",
            "sdk",
            "tracking",
            "identifier",
            "advertising id",
            "pixel",
        ],
    ),
    (
        "User Controls",
        &[
            "access", "delete", "deletion", "opt out", "opt-out", "choices", "rights", "request",
        ],
    ),
    (
        "Data Retention",
        &[
            "retain",
            "retention",
            "store your information",
            "keep your information",
            "as long as necessary",
        ],
    ),
    (
        "Children & Minors",
        &["children", "child", "under 13", "under 16", "minor", "age"],
    ),
];

/// `countWords`: `text.split(/\s+/).filter(Boolean).length`.
pub fn count_words(text: &str) -> usize {
    text.split(is_js_whitespace)
        .filter(|w| !w.is_empty())
        .count()
}

/// `countPolicyTopicHits`: how many of the eight lens groups have at least
/// one keyword in the lowercased text.
pub fn count_policy_topic_hits(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let lower = text.to_lowercase();
    TOPIC_GUIDES
        .iter()
        .filter(|(_, keywords)| keywords.iter().any(|k| lower.contains(&k.to_lowercase())))
        .count()
}

/// `normalizeExtractedText`.
pub fn normalize_extracted_text(text: &str) -> String {
    let s = text.replace('\r', "").replace('\u{a0}', " ");
    let s = re!(TABS, r"[\t\x0c\x0b]+").replace_all(&s, " ");
    let s = re!(SPACES, r" {2,}").replace_all(&s, " ");
    let s = re!(NL_SP, r"\n +").replace_all(&s, "\n");
    let s = re!(SP_NL, r" +\n").replace_all(&s, "\n");
    let s = re!(NL3, r"\n{3,}").replace_all(&s, "\n\n");
    js_trim(&s).to_string()
}

/// `Number.parseInt(s, radix)` for the digit run an entity regex has
/// already constrained: the leading digits valid in the radix, or `None`
/// for none at all (`NaN`). Decimal goes through a correctly rounded
/// parse; hex accumulates, which agrees up to 2^53.
fn parse_int_prefix(s: &str, radix: u32) -> Option<f64> {
    let digits: &str = {
        let end = s
            .char_indices()
            .find(|(_, c)| !c.is_digit(radix))
            .map_or(s.len(), |(i, _)| i);
        &s[..end]
    };
    if digits.is_empty() {
        return None;
    }
    if radix == 10 {
        return digits.parse::<f64>().ok();
    }
    Some(digits.chars().fold(0f64, |acc, c| {
        acc * radix as f64 + c.to_digit(radix).unwrap() as f64
    }))
}

/// `decodeHtmlEntities`. `String.fromCodePoint` throws a `RangeError` for
/// a code point past U+10FFFF, spelled as Node spells it; that is the one
/// way this returns `Err`. A surrogate code point, which JavaScript keeps
/// as a lone surrogate no Rust string can hold, decodes to U+FFFD instead —
/// a divergence no fixture can even record, since JSON cannot carry it.
pub fn decode_html_entities(value: &str) -> Result<String, String> {
    const NAMED: [(&str, &str); 16] = [
        ("amp", "&"),
        ("lt", "<"),
        ("gt", ">"),
        ("quot", "\""),
        ("apos", "'"),
        ("nbsp", " "),
        ("ndash", "-"),
        ("mdash", "-"),
        ("rsquo", "'"),
        ("lsquo", "'"),
        ("ldquo", "\""),
        ("rdquo", "\""),
        ("hellip", "..."),
        ("copy", "(c)"),
        ("reg", "(R)"),
        ("trade", "(TM)"),
    ];
    let entity = re!(ENTITY, r"(?i)&(#x?[0-9a-f]+|[a-z]+);");
    let mut out = String::with_capacity(value.len());
    let mut last = 0;
    for m in entity.captures_iter(value) {
        let full = m.get(0).unwrap();
        let body = &m[1];
        out.push_str(&value[last..full.start()]);
        last = full.end();
        let numeric = body
            .strip_prefix("#x")
            .or_else(|| body.strip_prefix("#X"))
            .map(|hex| parse_int_prefix(hex, 16))
            .or_else(|| body.strip_prefix('#').map(|dec| parse_int_prefix(dec, 10)));
        match numeric {
            Some(Some(code)) if code.is_finite() => {
                if code > 0x10FFFF as f64 {
                    return Err(format!("Invalid code point {}", js_number_spelling(code)));
                }
                out.push(char::from_u32(code as u32).unwrap_or('\u{fffd}'));
            }
            Some(_) => out.push_str(full.as_str()),
            None => match NAMED.iter().find(|(name, _)| *name == body.to_lowercase()) {
                Some((_, replacement)) => out.push_str(replacement),
                None => out.push_str(full.as_str()),
            },
        }
    }
    out.push_str(&value[last..]);
    Ok(out)
}

/// `CHROME_CLASS_PATTERN`.
fn chrome_class() -> &'static Regex {
    re!(
        CHROME,
        r"(?i)(cookie|consent|banner|navbar|nav-|menu|footer|subscribe|signup|breadcrumb|hero-|cta-|sidebar|social|related|share|toolbar|modal|popup)"
    )
}

/// One `<tag …>…</tag …>` block, closing tag tolerant of attributes and
/// whitespace, as every strip pattern spells it.
fn tag_block(name: &str) -> Regex {
    js(&format!(
        r"(?i)<{name}(?-u:\b)[^>]*>[\s\S]*?</{name}(?-u:\b)[^>]*>"
    ))
}

/// Node's `<(div|section|aside|header|footer|ul|ol)\b[^>]*\sclass="[^"]*"[^>]*>[\s\S]*?<\/\1\b[^>]*>`
/// with its callback: a container whose class matches the chrome pattern
/// becomes a space, any other stays. See the module note on scanners.
fn strip_class_containers(html: &str) -> String {
    let open = re!(
        OPEN,
        r#"(?i)<(div|section|aside|header|footer|ul|ol)(?-u:\b)[^>]*\sclass="[^"]*"[^>]*>"#
    );
    let class_attr = re!(CLASS_ATTR, r#"(?i)\sclass="([^"]*)""#);
    static CLOSERS: OnceLock<Vec<(String, Regex)>> = OnceLock::new();
    let closers = CLOSERS.get_or_init(|| {
        ["div", "section", "aside", "header", "footer", "ul", "ol"]
            .iter()
            .map(|t| (t.to_string(), js(&format!(r"(?i)</{t}(?-u:\b)[^>]*>"))))
            .collect()
    });
    let mut out = String::with_capacity(html.len());
    let mut copied = 0;
    let mut search_from = 0;
    while let Some(m) = open.captures_at(html, search_from) {
        let whole = m.get(0).unwrap();
        let tag = m[1].to_lowercase();
        let closer = &closers.iter().find(|(t, _)| *t == tag).unwrap().1;
        match closer.find_at(html, whole.end()) {
            Some(close) => {
                out.push_str(&html[copied..whole.start()]);
                let full = &html[whole.start()..close.end()];
                let chrome = class_attr
                    .captures(full)
                    .is_some_and(|c| chrome_class().is_match(&c[1]));
                if chrome {
                    out.push(' ');
                } else {
                    out.push_str(full);
                }
                copied = close.end();
                search_from = close.end();
            }
            None => search_from = whole.start() + 1,
        }
    }
    out.push_str(&html[copied..]);
    out
}

/// `stripChromeTags`.
pub fn strip_chrome_tags(html: &str) -> String {
    static BLOCKS: OnceLock<Vec<Regex>> = OnceLock::new();
    let blocks = BLOCKS.get_or_init(|| {
        [
            "script", "style", "noscript", "svg", "nav", "header", "aside", "footer", "form",
        ]
        .iter()
        .map(|t| tag_block(t))
        .collect()
    });
    let mut s = html.to_string();
    for block in blocks {
        s = block.replace_all(&s, " ").into_owned();
    }
    let role = re!(
        ROLE,
        r#"(?i)<[^>]+\srole="(navigation|banner|contentinfo|complementary|search)"[^>]*>[\s\S]*?</[^>]+\s*>"#
    );
    let s = role.replace_all(&s, " ").into_owned();
    strip_class_containers(&s)
}

/// `htmlBlockToText`.
pub fn html_block_to_text(html: &str) -> Result<String, String> {
    let s = re!(BR, r"(?i)<br\s*/?>").replace_all(html, "\n");
    let s = re!(
        BLOCK_CLOSE,
        r"(?i)</(p|div|li|section|article|main|header|h[1-6]|tr|td|blockquote|ul|ol)>"
    )
    .replace_all(&s, "\n");
    let s = re!(
        BLOCK_OPEN,
        r"(?i)<(p|div|li|section|article|main|header|h[1-6]|tr|td|blockquote|ul|ol)[^>]*>"
    )
    .replace_all(&s, "\n");
    let s = re!(ANY_TAG, r"<[^>]+>").replace_all(&s, " ");
    Ok(normalize_extracted_text(&decode_html_entities(&s)?))
}

fn first_group<'a>(regex: &Regex, html: &'a str) -> Option<&'a str> {
    regex.captures(html).map(|c| c.get(1).unwrap().as_str())
}

/// `extractPolicyTextFromHtml`: the title, then the `<main>`, `<article>`
/// or `<body>` text if it is long enough, else the longest policy-looking
/// container in the whole document, else the short first pass for the
/// validator to flag.
pub fn extract_policy_text_from_html(
    html: &str,
    fallback_title: &str,
) -> Result<(String, String), String> {
    let raw_title = first_group(
        re!(
            TITLE,
            r"(?i)<title(?-u:\b)[^>]*>([\s\S]*?)</title(?-u:\b)[^>]*>"
        ),
        html,
    )
    .unwrap_or("");
    let decoded_title = decode_html_entities(raw_title)?;
    let trimmed = js_trim(&decoded_title);
    let title = if trimmed.is_empty() {
        fallback_title.to_string()
    } else {
        trimmed.to_string()
    };

    let primary = first_group(
        re!(
            MAIN,
            r"(?i)<main(?-u:\b)[^>]*>([\s\S]*?)</main(?-u:\b)[^>]*>"
        ),
        html,
    )
    .or_else(|| {
        first_group(
            re!(
                ARTICLE,
                r"(?i)<article(?-u:\b)[^>]*>([\s\S]*?)</article(?-u:\b)[^>]*>"
            ),
            html,
        )
    })
    .or_else(|| {
        first_group(
            re!(
                BODY,
                r"(?i)<body(?-u:\b)[^>]*>([\s\S]*?)</body(?-u:\b)[^>]*>"
            ),
            html,
        )
    })
    .unwrap_or(html);

    let first_pass = html_block_to_text(&strip_chrome_tags(primary))?;
    if js_length(&first_pass) >= POLICY_MIN_CHARS {
        return Ok((title, first_pass));
    }

    // Second pass: Node's
    // `<(div|section|article|main)\b[^>]*\s(?:id|class)="([^"]*(?:policy|…)[^"]*)"[^>]*>([\s\S]*?)<\/\1>`
    // in an `exec` loop, as a scanner (see the module note).
    let open = re!(
        CONTAINER,
        r#"(?i)<(div|section|article|main)(?-u:\b)[^>]*\s(?:id|class)="([^"]*(?:policy|privacy|legal|terms|content|main|body|document)[^"]*)"[^>]*>"#
    );
    static CLOSERS: OnceLock<Vec<(String, Regex)>> = OnceLock::new();
    let closers = CLOSERS.get_or_init(|| {
        ["div", "section", "article", "main"]
            .iter()
            .map(|t| (t.to_string(), Regex::new(&format!("(?i)</{t}>")).unwrap()))
            .collect()
    });
    let mut candidates: Vec<String> = Vec::new();
    let mut search_from = 0;
    while let Some(m) = open.captures_at(html, search_from) {
        let whole = m.get(0).unwrap();
        let tag = m[1].to_lowercase();
        let attr = &m[2];
        let closer = &closers.iter().find(|(t, _)| *t == tag).unwrap().1;
        let Some(close) = closer.find_at(html, whole.end()) else {
            search_from = whole.start() + 1;
            continue;
        };
        let inner = &html[whole.end()..close.start()];
        search_from = close.end();
        if chrome_class().is_match(attr) {
            continue;
        }
        let inner_text = html_block_to_text(&strip_chrome_tags(inner))?;
        if js_length(&inner_text) >= POLICY_MIN_CHARS {
            candidates.push(inner_text);
        }
    }
    if !candidates.is_empty() {
        // A stable sort, as `Array.prototype.sort` is: equal lengths keep
        // document order.
        candidates.sort_by_key(|c| Reverse(js_length(c)));
        return Ok((title, candidates.swap_remove(0)));
    }
    Ok((title, first_pass))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_decode_and_overflow_throws() {
        assert_eq!(
            decode_html_entities("A &amp; B &#x27;c&#39; &hellip; &unknown; &#8212;").unwrap(),
            "A & B 'c' ... &unknown; \u{2014}"
        );
        assert_eq!(
            decode_html_entities("&#1114112;").unwrap_err(),
            "Invalid code point 1114112"
        );
        // Decimal parsing stops at the first non-digit, as parseInt does.
        assert_eq!(decode_html_entities("&#65a;").unwrap(), "A");
    }

    #[test]
    fn class_container_scanner_matches_backtracking() {
        // The outer chrome container ends at the FIRST closing div, as a
        // lazy `[\s\S]*?` with a backreference does; the tail survives.
        let html = r#"<div class="sidebar-wrap"><div class="content">INNER</div>OUTER TAIL</div>"#;
        assert_eq!(strip_class_containers(html), " OUTER TAIL</div>");
        // An unclosed container is not a match; scanning moves on.
        assert_eq!(
            strip_class_containers(r#"<div class="menu"><span>Unclosed"#),
            r#"<div class="menu"><span>Unclosed"#
        );
        // A closing tag with attributes still closes.
        assert_eq!(
            strip_class_containers(r#"<ul class="navbar"><li>x</li></ul foo="y">rest"#),
            " rest"
        );
    }

    #[test]
    fn words_and_topics() {
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("  a\u{a0}b\n c "), 3);
        assert_eq!(count_policy_topic_hits("We collect data and share it."), 2);
        assert_eq!(count_policy_topic_hits("lorem ipsum"), 0);
    }
}

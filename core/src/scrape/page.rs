//! The page-level reads of `fetchAndParseApp`: the metadata regexes, the
//! `serialized-server-data` extraction and the name rules, then the flags
//! and the write plan. The two extraction failures and a truthy non-string
//! JSON title are the errors that escape; everything else is a value.
use super::{
    flags,
    js::{at, js_regex, truthy, DOT},
    plan::{self, WritePlan},
};
use crate::{jsstr::js_trim, outbound::sanitize_policy};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

/// Everything the page determines before the commit.
#[derive(Debug)]
pub struct ParsedPage {
    /// From the URL's `/id<digits>` segment.
    pub apple_id: String,
    pub name: String,
    pub icon_url: String,
    pub developer: String,
    /// Already through `sanitizePolicyUrl`, so `""` for anything unsafe.
    pub privacy_policy_url: String,
    /// `1` labels declared, `0` Apple's "No Details Provided" copy, `None`
    /// undecidable.
    pub has_privacy_details: Option<i64>,
    /// `1` / `0` / `None` on the same three-state contract.
    pub has_iap: Option<i64>,
    pub plan: WritePlan,
}

struct Patterns {
    og_title: Regex,
    og_image: Regex,
    author: Regex,
    aria_label_first: Regex,
    aria_label_second: Regex,
    section: Regex,
    final_link: Regex,
    script: Regex,
    on_the_app_store: Regex,
    app_dash_app_store: Regex,
    dash_app_store: Regex,
    on_the_app_store_any: Regex,
    apple_id: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        og_title: js_regex(r#"(?i)<meta\s+property="og:title"\s+content="([^"]+)""#),
        og_image: js_regex(r#"(?i)<meta\s+property="og:image"\s+content="([^"]+)""#),
        // The one case-sensitive match in the set.
        author: js_regex(r#""author"\s*:\s*\{\s*"@type"[^}]*"name"\s*:\s*"([^"]+)""#),
        aria_label_first: js_regex(
            r#"(?i)<a\s+[^<>]{0,2048}?aria-label="Developer[’']s Privacy Policy"[\s\S]{0,2048}?href="([^"]+)""#,
        ),
        aria_label_second: js_regex(
            r#"(?i)<a\s+[\s\S]{0,2048}?href="([^"]+)"[\s\S]{0,2048}?aria-label="Developer[’']s Privacy Policy""#,
        ),
        section: js_regex(
            r#"(?i)id="notPurchasedLinks"[\s\S]*?<a\s+[^>]*?href="([^"]+)"[^>]*?>\s*Privacy Policy\s*</a>"#,
        ),
        final_link: js_regex(r#"(?i)<a\s+[^>]*?href="([^"]+)"[^>]*?>\s*Privacy Policy\s*</a>"#),
        // Node: `(["'])serialized-server-data\1`. The back-reference is
        // spelled out as the two quotings it can match.
        script: js_regex(
            r#"(?i)<script(?-u:\b)[^>]*(?-u:\b)id\s*=\s*(?:"serialized-server-data"|'serialized-server-data')[^>]*>([\s\S]*?)</script(?-u:\b)[^>]*>"#,
        ),
        on_the_app_store: js_regex("(?i) on the App Store$"),
        app_dash_app_store: js_regex(&format!(r"(?i)\s+App\s*[-–]\s*App Store{DOT}*")),
        dash_app_store: js_regex(&format!(r"(?i)\s*[-–]\s*App Store{DOT}*")),
        on_the_app_store_any: js_regex(&format!(r"(?i)\s+on the App Store{DOT}*")),
        apple_id: Regex::new(r"(?i)/id([0-9]+)").expect("static regex"),
    })
}

const NO_SCRIPT: &str = "No serialized-server-data script found in App Store page";
const BAD_JSON: &str = "Failed to parse serialized-server-data JSON";

/// `fetchAndParseApp` from the fetched HTML to the write plan. `url` is the
/// validated App Store URL the caller fetched; only its `/id<digits>`
/// segment is read here.
pub fn parse_page(url: &str, html: &str) -> Result<ParsedPage, String> {
    let p = patterns();

    // ── Name / icon / id / developer ──
    let mut name = "Unknown App".to_string();
    if let Some(c) = p.og_title.captures(html) {
        name = js_trim(&p.on_the_app_store.replace(&c[1], "")).to_string();
    }
    let icon_url = p
        .og_image
        .captures(html)
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    // Node mints a random UUID when the segment is missing; the validator
    // every caller runs first guarantees it is not, so refuse instead.
    let apple_id = p
        .apple_id
        .captures(url)
        .map(|c| c[1].to_string())
        .ok_or("App Store URL must contain an /id<digits> segment")?;
    let developer = p
        .author
        .captures(html)
        .map(|c| c[1].to_string())
        .unwrap_or_default();

    // ── Privacy policy URL: aria-label (either attribute order), then the
    // notPurchasedLinks section, then any "Privacy Policy" link. ──
    let policy = p
        .aria_label_first
        .captures(html)
        .or_else(|| p.aria_label_second.captures(html))
        .or_else(|| p.section.captures(html))
        .or_else(|| p.final_link.captures(html))
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    let privacy_policy_url = sanitize_policy(&policy);

    // ── serialized-server-data ──
    let Some(script) = p.script.captures(html) else {
        return Err(NO_SCRIPT.to_string());
    };
    // `JSON.parse` then `Array.isArray(raw) ? raw : (raw.data ?? [])`, both
    // inside the same try: a `null` payload throws on `.data` and lands in
    // the same catch as malformed JSON.
    let raw: Value = serde_json::from_str(&script[1]).map_err(|_| BAD_JSON.to_string())?;
    let data = match &raw {
        Value::Array(_) => raw.clone(),
        Value::Null => return Err(BAD_JSON.to_string()),
        Value::Object(o) => match o.get("data") {
            Some(v) if !v.is_null() => v.clone(),
            _ => Value::Array(vec![]),
        },
        _ => Value::Array(vec![]),
    };

    // ── Name: prefer the JSON title; otherwise strip the og:title suffixes.
    // A truthy non-string title is `.trim()` on a non-string: a TypeError
    // nothing catches. ──
    let json_title = at(&data, 0)["data"]["title"].clone();
    if truthy(&json_title) {
        match json_title {
            Value::String(s) => name = js_trim(&s).to_string(),
            _ => return Err("jsonTitle.trim is not a function".to_string()),
        }
    } else if name != "Unknown App" {
        let stripped = p.app_dash_app_store.replace(&name, "").into_owned();
        let stripped = p.dash_app_store.replace(&stripped, "").into_owned();
        let stripped = p.on_the_app_store_any.replace(&stripped, "").into_owned();
        name = js_trim(&stripped).to_string();
    }

    let has_privacy_details = flags::detect_privacy_details(html, &data);
    let has_iap = flags::detect_iap(html, &data);
    let plan = plan::prepare(&data, html)?;

    Ok(ParsedPage {
        apple_id,
        name,
        icon_url,
        developer,
        privacy_policy_url,
        has_privacy_details,
        has_iap,
        plan,
    })
}

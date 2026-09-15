//! Final two Phase 2 reads: library/preview comparison and related candidates.
//! Copy database inputs before awaiting the public-only outbound transport.
use super::{
    json::{js_value_ok, json_error},
    preview,
    routes_stats::{get, Params},
    stats::{query, truthy},
    AppState,
};
use crate::{
    jsstr::is_js_whitespace,
    outbound::{self, Fetcher, PublicHttp, Request},
};
use axum::{
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde_json::{json, Value};

#[derive(Debug)]
enum Failure {
    Message(String),
    AppleRateLimit,
    InvalidSpec(String),
}
impl From<String> for Failure {
    fn from(s: String) -> Self {
        Self::Message(s)
    }
}
impl From<rusqlite::Error> for Failure {
    fn from(e: rusqlite::Error) -> Self {
        Self::Message(e.to_string())
    }
}

fn failed(e: Failure) -> Response {
    match e {
        Failure::AppleRateLimit => json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "App Store rate-limited us. Try again in a minute.",
        ),
        Failure::Message(s) => {
            super::diag::log_error(format!("/api/compare error {s}"));
            json_error(StatusCode::INTERNAL_SERVER_ERROR, &s)
        }
        Failure::InvalidSpec(s) => {
            // JS slice counts UTF-16 units and can end on an unpaired
            // surrogate. Preserve JSON.stringify's escaped surrogate bytes.
            let units = s.encode_utf16().take(40).collect::<Vec<_>>();
            let mut body = String::from("{\"error\":\"Invalid spec: ");
            for c in char::decode_utf16(units) {
                match c {
                    Ok(c) => {
                        let q = serde_json::to_string(&c.to_string()).unwrap();
                        body.push_str(&q[1..q.len() - 1]);
                    }
                    Err(e) => body.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
                }
            }
            body.push_str("\"}");
            Response::builder()
                .status(500)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap()
        }
    }
}
async fn slot(state: &AppState, spec: &str, fetcher: &dyn Fetcher) -> Result<Value, Failure> {
    if let Some(id) = spec.strip_prefix("id:") {
        let conn = state.db();
        let params = [id.to_string().into()];
        let app = query(
            &conn,
            "SELECT id,name,iconUrl,developer,url,privacyPolicyUrl,hasPrivacyDetails,hasAccessibilityLabels FROM apps WHERE id=?",
            &params,
        ).map_err(|e|Failure::Message(e.to_string()))?
            .into_iter().next()
            .ok_or_else(||Failure::Message(format!("App not found: {id}")))?;
        // Same SELECT * planner order as Node's buildSnapshot (no tie-break).
        let mut types = vec![];
        for t in query(&conn, "SELECT * FROM privacy_types WHERE app_id=?", &params)
            .map_err(|e| Failure::Message(e.to_string()))?
        {
            let cats = query(
                &conn,
                "SELECT * FROM privacy_categories WHERE type_id=?",
                &[super::row::to_sql_value(&t["id"])],
            )
            .map_err(|e| Failure::Message(e.to_string()))?;
            types.push(json!({"identifier":t["identifier"],"title":t["title"],"categories":cats.iter().map(|c|json!({"identifier":c["identifier"],"title":c["title"]})).collect::<Vec<_>>()}));
        }
        let policy = super::policy::get_policy_analysis(&conn, id)?;
        let features = query(
            &conn,
            "SELECT identifier,title,description,icon_template AS iconTemplate FROM accessibility_features WHERE app_id=? ORDER BY identifier",
            &params,
        ).map_err(|e|Failure::Message(e.to_string()))?;
        return Ok(json!({
            "source":"library",
            "id":app["id"],
            "name":app["name"],
            "iconUrl":app["iconUrl"],
            "developer":app["developer"],
            "privacyPolicyUrl":app["privacyPolicyUrl"],
            "url":app["url"],
            "privacyTypes":types,
            "hasPrivacyDetails":app["hasPrivacyDetails"],
            "policySummary":policy["summary"],
            "accessibilityFeatures":features,
            "hasAccessibilityLabels":app["hasAccessibilityLabels"]
        }));
    }
    if let Some(raw) = spec.strip_prefix("url:") {
        let url = outbound::app_store_url(raw)
            .map_err(|e| Failure::Message(format!("Rejected URL ({})", e.error)))?
            .to_string();
        let mut request =
            Request::apple(url.clone(), outbound::APPLE_HOSTS, 4 * 1024 * 1024, 15_000);
        request.headers=vec![("User-Agent".into(),"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15".into()),("Accept-Language".into(),"en-US,en;q=0.9".into())];
        let response = fetcher.fetch(request).await?;
        if response.status == 429 {
            return Err(Failure::AppleRateLimit);
        }
        if !response.ok() {
            return Err(Failure::Message(format!(
                "HTTP {} fetching App Store page",
                response.status
            )));
        }
        let p = preview::parse(&String::from_utf8_lossy(&response.body), &url)?;
        return Ok(json!({
            "source":"scrape",
            "id":p["appleId"],
            "name":p["name"],
            "iconUrl":p["iconUrl"],
            "developer":p["developer"],
            "privacyPolicyUrl":p["privacyPolicyUrl"],
            "url":p["url"],
            "privacyTypes":p["privacyTypes"],
            "hasPrivacyDetails":p["hasPrivacyDetails"],
            "policySummary":null,
            "accessibilityFeatures":p["accessibilityFeatures"],
            "hasAccessibilityLabels":p["hasAccessibilityLabels"]
        }));
    }
    Err(Failure::InvalidSpec(spec.into()))
}
pub(super) async fn compare_with(
    state: &AppState,
    headers: &HeaderMap,
    q: &Params,
    fetcher: &dyn Fetcher,
) -> Response {
    let a = get(q, "a").unwrap_or("");
    let b = get(q, "b").unwrap_or("");
    if a.is_empty() || b.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Both `a` and `b` are required");
    }
    if a.starts_with("url:") || b.starts_with("url:") {
        let header = |key| headers.get(key).and_then(|h| h.to_str().ok());
        let key = super::ratelimit::key_for_request(
            header("x-forwarded-for"),
            header("x-real-ip"),
            "compare",
        );
        let limit = state.rate_limiter.check(&key, 30, 60_000, super::now_ms());
        if !limit.allowed {
            let mut r = json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Rate limit exceeded for /api/compare. Try again shortly.",
            );
            r.headers_mut().insert(
                "retry-after",
                ((limit.retry_after_ms as f64 / 1000.).ceil() as i64)
                    .to_string()
                    .parse()
                    .unwrap(),
            );
            return r;
        }
    }
    match tokio::try_join!(slot(state, a, fetcher), slot(state, b, fetcher)) {
        Ok((a, b)) => js_value_ok(&json!({"a":a,"b":b})),
        Err(e) => failed(e),
    }
}
pub async fn compare(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Params>,
) -> Response {
    compare_with(&state, &headers, &q, &PublicHttp).await
}

/// Number(query), including radix prefixes and JS whitespace. Missing/null
/// becomes zero; this makes the route's actual default limit one, not five.
fn number(raw: &str) -> f64 {
    let s = raw.trim_matches(is_js_whitespace);
    if s.is_empty() {
        return 0.;
    }
    for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
        if s.to_ascii_lowercase().starts_with(prefix) {
            let digits = &s[2..];
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut n = 0.;
            for c in digits.chars() {
                let Some(d) = c.to_digit(radix) else {
                    return f64::NAN;
                };
                n = n * radix as f64 + d as f64;
            }
            return n;
        }
    }
    if matches!(s, "Infinity" | "+Infinity") {
        return f64::INFINITY;
    }
    if s == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    if s.to_ascii_lowercase().contains("inf") || s.to_ascii_lowercase().contains("nan") {
        return f64::NAN;
    }
    s.parse().unwrap_or(f64::NAN)
}
fn nullable(v: &Value, default: Value) -> Value {
    if v.is_null() {
        default
    } else {
        v.clone()
    }
}
async fn lookup(fetcher: &dyn Fetcher, id: &str, country: &str) -> Option<Value> {
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut r = Request::apple(
        format!("https://itunes.apple.com/lookup?id={id}&country={country}"),
        outbound::RELATED_HOSTS,
        1024 * 1024,
        8000,
    );
    r.headers.push(("Accept".into(), "application/json".into()));
    let reply = fetcher.fetch(r).await.ok()?;
    if !reply.ok() {
        return None;
    }
    let p = super::user_content::parse(&String::from_utf8_lossy(&reply.body)).ok()?;
    let entry = &p["results"][0];
    if !truthy(entry) {
        return None;
    }
    Some(json!({
        "genreId":if entry["primaryGenreId"].is_number(){entry["primaryGenreId"].clone()}else{Value::Null},
        "genreName":entry["primaryGenreName"].as_str(),
        "priceAmount":if entry["price"].is_number(){entry["price"].clone()}else{Value::Null}
    }))
}
fn candidates(body: &[u8], id: &str, limit: f64) -> Option<Vec<Value>> {
    let parsed = super::user_content::parse(&String::from_utf8_lossy(body)).ok()?;
    let entries = &parsed["feed"]["entry"];
    if entries.is_null() {
        return Some(vec![]);
    }
    let mut out = vec![];
    for e in entries.as_array()? {
        if e.is_null() {
            return None;
        }
        let apple_id = &e["id"]["attributes"]["im:id"];
        if !truthy(apple_id) || apple_id == id {
            continue;
        }
        let name = &e["im:name"]["label"];
        let name = if name.is_null() {
            ""
        } else {
            name.as_str()?.trim_matches(is_js_whitespace)
        };
        let developer = &e["im:artist"]["label"];
        let developer = if developer.is_null() {
            ""
        } else {
            developer.as_str()?.trim_matches(is_js_whitespace)
        };
        let icon = e["im:image"]
            .as_array()
            .and_then(|a| a.last())
            .map(|v| nullable(&v["label"], json!("")))
            .unwrap_or(json!(""));
        let link = if let Some(a) = e["link"].as_array() {
            a.first().unwrap_or(&Value::Null)
        } else {
            &e["link"]
        };
        let url = nullable(&link["attributes"]["href"], json!(""));
        if name.is_empty() || !truthy(&url) {
            continue;
        }
        out.push(
            json!({"appleId":apple_id,"name":name,"developer":developer,"iconUrl":icon,"url":url}),
        );
        if out.len() as f64 >= limit {
            break;
        }
    }
    Some(out)
}
pub(super) async fn related_with(state: &AppState, q: &Params, fetcher: &dyn Fetcher) -> Response {
    let id = get(q, "sourceAppId").unwrap_or("");
    let parsed = number(get(q, "limit").unwrap_or(""));
    let limit = (if parsed.is_finite() { parsed } else { 5. }).clamp(1., 10.);
    let mode = if get(q, "mode") == Some("may_also_like") {
        "may_also_like"
    } else {
        "top_in_category"
    };
    if id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "sourceAppId is required and must be a valid app id.",
        );
    }
    let row = {
        let conn = state.db();
        query(
            &conn,
            "SELECT id,name,genreId,genreName,priceAmount,url FROM apps WHERE id=?",
            &[id.to_string().into()],
        )
    };
    let row = match row {
        Ok(r) => r.into_iter().next(),
        Err(e) => {
            super::diag::log_error(format!("[/api/related-apps] DB read failed: {e}"));
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read source app.",
            );
        }
    };
    let Some(row) = row else {
        return json_error(StatusCode::NOT_FOUND, "Source app not found.");
    };
    if mode == "may_also_like" {
        let rows = {
            let conn = state.db();
            query(&conn,"SELECT source_app_id,related_apple_id,related_name,related_developer,related_icon_url,related_store_url,shelf_type,observed_at FROM related_apps_observed WHERE source_app_id=? AND shelf_type='may_also_like' ORDER BY observed_at DESC,related_apple_id ASC",&[id.to_string().into()])
        };
        let rows = match rows {
            Ok(r) => r,
            Err(e) => {
                super::diag::log_error(e.to_string());
                return Response::builder().status(500).body(Body::empty()).unwrap();
            }
        };
        let candidates = rows
            .into_iter()
            .take(limit as usize)
            .map(|r| {
                json!({
                    "appleId":r["related_apple_id"],
                    "name":r["related_name"],
                    "developer":nullable(&r["related_developer"],json!("")),
                    "iconUrl":nullable(&r["related_icon_url"],json!("")),
                    "url":r["related_store_url"]
                })
            })
            .collect::<Vec<_>>();
        let mut out = json!({"mode":mode,"genreId":null,"genreName":null,"free":null,"candidates":candidates});
        if candidates.is_empty() {
            out["reason"] = json!("not_scraped_yet");
        }
        out["sourceAppUrl"] = row["url"].clone();
        return js_value_ok(&out);
    }
    let country = {
        let conn = state.db();
        super::settings::get_setting_with(&conn, "app_country", "us")
    };
    let country = match country {
        Ok(c) => c.trim_matches(is_js_whitespace).to_ascii_lowercase(),
        Err(e) => {
            super::diag::log_error(e.to_string());
            return Response::builder().status(500).body(Body::empty()).unwrap();
        }
    };
    let country = if country.len() == 2 && country.bytes().all(|c| c.is_ascii_lowercase()) {
        country
    } else {
        "us".into()
    };
    let (mut genre, mut genre_name, mut price) = (
        row["genreId"].clone(),
        row["genreName"].clone(),
        row["priceAmount"].clone(),
    );
    if genre.is_null() || price.is_null() {
        if let Some(data) = lookup(fetcher, id, &country).await {
            if genre.is_null() {
                genre = data["genreId"].clone();
            }
            if genre_name.is_null() {
                genre_name = data["genreName"].clone();
            }
            if price.is_null() {
                price = data["priceAmount"].clone();
            }
        }
    }
    if genre.is_null() {
        return js_value_ok(
            &json!({"mode":mode,"genreId":null,"genreName":null,"free":null,"candidates":[],"sourceAppUrl":row["url"]}),
        );
    }
    let free = if price.is_null() {
        true
    } else if let Some(n) = price.as_f64() {
        n <= 0.
    } else {
        number(&preview::string(&price)) <= 0.
    };
    let feed = if free {
        "topfreeapplications"
    } else {
        "toppaidapplications"
    };
    let mut request = Request::apple(
        format!(
            "https://itunes.apple.com/{country}/rss/{feed}/limit=50/genre={}/json",
            preview::string(&genre)
        ),
        outbound::RELATED_HOSTS,
        2 * 1024 * 1024,
        8000,
    );
    request
        .headers
        .push(("Accept".into(), "application/json".into()));
    let candidates = match fetcher.fetch(request).await {
        Ok(r) if r.ok() => candidates(&r.body, id, limit).unwrap_or_default(),
        _ => vec![],
    };
    js_value_ok(
        &json!({"mode":mode,"genreId":genre,"genreName":genre_name,"free":free,"candidates":candidates,"sourceAppUrl":row["url"]}),
    )
}
pub async fn related(State(state): State<AppState>, Query(q): Query<Params>) -> Response {
    related_with(&state, &q, &PublicHttp).await
}

//! Phase 5, batch 3b: the AI routes. `POST /api/policy/regenerate` runs
//! `syncPrivacyPolicyAnalysis` for one app and answers with the analysis,
//! or streams the run's phase records as NDJSON and ends with it;
//! `POST /api/ai/policy-sample` summarises the built-in sample policy with
//! the model a person is trying out; `POST /api/ai/test` and
//! `POST /api/ai/models` reach the provider's model list to say whether it
//! answers and what it offers.
//!
//! Each is its Node source in order: the limit (with the route's own 429),
//! the admin token for the two that fetch a caller-supplied URL, the body
//! read with the route's own phrasing of its failures, the provider and
//! base-URL checks, then the provider. The three `/api/ai` routes allow a
//! loopback or LAN base URL (a local model is the point of the custom
//! provider); a metadata address never passes. Gated by
//! `core/tests/fixtures/ai-routes-cases.json`, which `routes_ai_tests.rs`
//! replays through `precheck` and `respond` as the axum wrapper calls them.
#![allow(clippy::result_large_err)] // `Err` is the response the route returns.
use super::{
    activity_log::record_activity_named,
    auth::{admin_token_configured, request_has_valid_admin_token},
    body::{body_error_response, BodyOutcome},
    guard::{record_audit, Actor},
    json::{js_json_vec, json_error, json_ok, json_response},
    policy_store::{self, FollowUps, Phase, PolicyRequest, SyncOptions},
    policy_summary::summarize_sample_privacy_policy,
    preview::string as js_string,
    ratelimit::{self, RateLimiter},
    settings::get_setting_with,
    stats::truthy,
    sync_runner::{clock_for, Clock},
    trust::is_network_exposed,
    writes::{prop, RouteSpec, WriteRequest},
};
use crate::{
    jsjson,
    jsstr::{js_length, js_slice_prefix, js_trim},
    outbound::{self, Fetcher, Request, ValidationError},
    policy::ai::{
        anthropic_api_root, normalize_ai_provider, normalize_base_url, provider_label,
        provider_requires_api_key, resolve_default_base_url, AiConfig,
    },
    scrape::persist::{DbAccess, Ids, Writer},
};
use axum::{
    body::Body,
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use serde_json::{json, Map, Value};
use std::sync::Arc;

const REGENERATE: &str = "/api/policy/regenerate";
const SAMPLE: &str = "/api/ai/policy-sample";
const TEST: &str = "/api/ai/test";
const MODELS: &str = "/api/ai/models";

/// `AI_RESPONSE_MAX_BYTES`: a model list is a few kilobytes even for a
/// provider with hundreds of models.
const AI_RESPONSE_MAX_BYTES: usize = 1024 * 1024;
const LIST_TIMEOUT_MS: u64 = 10_000;
const MASKED_SECRET: &str = "__SET__";
const BLOCKED_HOST: &str =
    "The base URL points at a blocked host (cloud metadata endpoints are always blocked).";
const SCRAPE_DISABLED: &str = "Policy scraping is disabled in Settings. Re-enable to fetch, or use the Summarise-only action.";
const NO_POLICY_LINK: &str =
    "This app does not expose a developer privacy-policy link on its App Store page.";

pub(super) fn handles(spec: &RouteSpec) -> bool {
    matches!(spec.path, REGENERATE | SAMPLE | TEST | MODELS)
}

// ── The guards ───────────────────────────────────────────────────────

/// The limits the three `/api/ai` routes inline ahead of the body, each
/// refused in the route's own words and with no `Retry-After`, then, for
/// the two that fetch a caller-supplied URL, the admin token wherever one
/// is needed, refused with an audit row. The regenerate route's limit is
/// the write table's `Guard::Rate`.
pub(super) fn precheck(
    w: &mut Writer,
    ids: &mut dyn Ids,
    limiter: &RateLimiter,
    headers: &HeaderMap,
    spec: &RouteSpec,
    actor: &Actor,
    now: i64,
) -> Result<(), Response> {
    let (prefix, limit, refusal, unauthorised) = match spec.path {
        TEST => (
            "ai.test",
            10,
            json!({ "ok": false, "message": "Rate limit exceeded. Try again shortly." }),
            Some("ai.test.unauthorised"),
        ),
        MODELS => (
            "ai.models",
            10,
            json!({ "ok": false, "message": "Rate limit exceeded." }),
            Some("ai.models.unauthorised"),
        ),
        SAMPLE => (
            "ai.policy_sample",
            6,
            json!({ "ok": false, "error": "Rate limit exceeded. Try again shortly." }),
            None,
        ),
        _ => return Ok(()),
    };
    let head = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let key = ratelimit::key_for_request(head("x-forwarded-for"), head("x-real-ip"), prefix);
    if !limiter.check(&key, limit, 60_000, now).allowed {
        return Err(json_response(StatusCode::TOO_MANY_REQUESTS, &refusal));
    }
    if let Some(action) = unauthorised {
        // `adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)`.
        if (admin_token_configured() || is_network_exposed())
            && !request_has_valid_admin_token(
                head("x-auditor-admin-token"),
                head(header::COOKIE.as_str()),
            )
        {
            record_audit(w, ids, now, action, actor, None, false);
            return Err(json_response(
                StatusCode::UNAUTHORIZED,
                &json!({ "ok": false, "message": "Admin token required." }),
            ));
        }
    }
    Ok(())
}

// ── The dispatch ─────────────────────────────────────────────────────

/// The write framework's entry: the live clock on the server. Anything
/// the regenerate run fired and could not finish in place (nothing, on
/// the server, where it is spawned) is finished before the response.
pub(super) async fn perform(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    fetcher: &dyn Fetcher,
    req: WriteRequest<'_>,
    actor: &Actor,
) -> Response {
    let clock = clock_for(now);
    let (response, follow_ups) = respond(
        db,
        ids,
        fetcher,
        clock.clone(),
        req.spec.path,
        req.body,
        actor,
    )
    .await;
    policy_store::run_follow_ups(db, fetcher, &*clock, follow_ups).await;
    response
}

/// The handler after the guard and the body read, with what the run left
/// to finish once the response is written.
pub(super) async fn respond(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: Arc<dyn Clock>,
    path: &str,
    body: BodyOutcome,
    actor: &Actor,
) -> (Response, FollowUps) {
    let response = match path {
        REGENERATE => return regenerate(db, ids, fetcher, clock, body, actor).await,
        SAMPLE => policy_sample(db, ids, fetcher, &*clock, body).await,
        TEST => test_connection(db, fetcher, &*clock, body).await,
        MODELS => list_models(db, fetcher, body).await,
        _ => json_error(StatusCode::NOT_FOUND, "Not Found"),
    };
    (response, FollowUps::default())
}

/// A throw inside the handler: Next answers 500 with no body.
fn thrown(message: &str) -> Response {
    super::diag::log_error(format!("[ai] {message}"));
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(Body::empty())
        .unwrap()
}

// ── Shared by the three /api/ai routes ───────────────────────────────

/// The body the three `/api/ai` routes parse, or the response they give
/// instead: the 413 and 408 as `requestBodyErrorResponse` words them,
/// anything else the route's own 400.
fn ai_body(outcome: BodyOutcome, invalid: Value) -> Result<Value, Response> {
    if let Some(response) = body_error_response(&outcome) {
        return Err(response);
    }
    match outcome {
        // `body.provider` on a null body throws.
        BodyOutcome::Json(Value::Null) => Err(thrown(
            "Cannot read properties of null (reading 'provider')",
        )),
        BodyOutcome::Json(v) => Ok(v),
        _ => Err(json_response(StatusCode::BAD_REQUEST, &invalid)),
    }
}

/// `typeof body[key] === "string" ? body[key].trim() : ""`.
fn trimmed(body: &Value, key: &str) -> String {
    prop(body, key)
        .and_then(Value::as_str)
        .map(|s| js_trim(s).to_string())
        .unwrap_or_default()
}

/// `normalizeAiProvider(body.provider)`: only the exact names count.
fn provider_of(body: &Value) -> &'static str {
    match prop(body, "provider").and_then(Value::as_str) {
        Some(name) => normalize_ai_provider(name),
        None => "disabled",
    }
}

/// `resolveSubmittedApiKey`: the key as typed, or — for the mask Settings
/// shows in place of a stored key — the stored one.
fn submitted_api_key(db: &mut dyn DbAccess, raw: Option<&Value>) -> String {
    let submitted = raw
        .and_then(Value::as_str)
        .map(|s| js_trim(s).to_string())
        .unwrap_or_default();
    if submitted == MASKED_SECRET {
        let stored = db
            .with(|w| get_setting_with(w.conn, "ai_api_key", ""))
            .unwrap_or_default();
        return js_trim(&stored).to_string();
    }
    submitted
}

/// The base URL the route normalises, from the one submitted or the
/// provider's default.
fn base_url_of(body: &Value, provider: &str) -> String {
    let raw = trimmed(body, "baseUrl");
    let value = if raw.is_empty() {
        resolve_default_base_url(provider)
    } else {
        &raw
    };
    normalize_base_url(value, provider)
}

/// `validateExternalUrl(baseUrl, { maxLength: 512, allowPrivateHosts: true })`
/// with its refusal as the routes word it.
fn check_base_url(base_url: &str) -> Result<(), String> {
    outbound::validate_with(base_url, &[], 512, true)
        .map(drop)
        .map_err(|e: ValidationError| {
            if e.error == "private_host" {
                BLOCKED_HOST.to_string()
            } else {
                format!("Invalid base URL: {}", e.detail)
            }
        })
}

/// A case-insensitive test of ASCII words, as `/…/i` makes one: JavaScript
/// never folds a non-ASCII character onto an ASCII one.
fn mentions(message: &str, words: &[&str]) -> bool {
    let lowered = message.to_ascii_lowercase();
    words.iter().any(|w| lowered.contains(w))
}

/// The words the two model-list routes put to a failed fetch. The model
/// list says less than the connection test on two of them.
fn friendly_network_message(message: &str, terse: bool) -> String {
    let text = if mentions(message, &["aborted", "timeout"]) {
        "Timed out reaching the endpoint."
    } else if mentions(message, &["econnrefused", "refused"]) {
        if terse {
            "Connection refused — is the server running?"
        } else {
            "Connection refused — is the server running at this URL?"
        }
    } else if mentions(message, &["enotfound", "getaddrinfo"]) {
        if terse {
            "Hostname not found."
        } else {
            "Hostname not found — check the base URL."
        }
    } else if mentions(message, &["certificate", "ssl", "tls"]) {
        "TLS/SSL error — check the base URL and certificates."
    } else if mentions(message, &["fetch failed"]) {
        "Could not reach the endpoint."
    } else {
        return message.to_string();
    };
    text.to_string()
}

/// A model-list request: bounded, never following a redirect, and allowed
/// onto a loopback or LAN host.
fn list_request(url: String, headers: Vec<(String, String)>) -> Request {
    Request {
        headers,
        max_bytes: AI_RESPONSE_MAX_BYTES,
        timeout_ms: LIST_TIMEOUT_MS,
        follow_redirects: false,
        allow_private_hosts: true,
        ..Request::apple(url, &[], AI_RESPONSE_MAX_BYTES, LIST_TIMEOUT_MS)
    }
}

/// `{ Accept: "application/json" }`, with the bearer key when there is one.
fn openai_headers(api_key: &str) -> Vec<(String, String)> {
    let mut headers = vec![("Accept".to_string(), "application/json".to_string())];
    if !api_key.is_empty() {
        headers.push(("Authorization".to_string(), format!("Bearer {api_key}")));
    }
    headers
}

fn anthropic_headers(api_key: &str) -> Vec<(String, String)> {
    vec![
        ("x-api-key".to_string(), api_key.to_string()),
        ("anthropic-version".to_string(), "2023-06-01".to_string()),
        ("Accept".to_string(), "application/json".to_string()),
    ]
}

/// `JSON.parse(body.toString("utf8"))`, failing in V8's words.
fn parse_body(body: &[u8]) -> Result<Value, String> {
    jsjson::parse(&String::from_utf8_lossy(body))
}

/// `payload?.[key]` when it is an array.
fn array_at<'a>(payload: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    payload.as_object()?.get(key)?.as_array()
}

/// `typeof item?.[key] === "string" ? item[key].trim() : ""`.
fn item_text(item: &Value, key: &str) -> String {
    item.as_object()
        .and_then(|o| o.get(key))
        .and_then(Value::as_str)
        .map(|s| js_trim(s).to_string())
        .unwrap_or_default()
}

// ── POST /api/ai/test ────────────────────────────────────────────────

/// `statusMessage`: status-only, never the endpoint's own words, so the
/// route cannot become a way to read an internal service.
fn status_message(status: u16) -> String {
    match status {
        401 => "Unauthorized — check your API key.".to_string(),
        403 => "Forbidden — API key does not have access to this endpoint.".to_string(),
        404 => "Not found — double-check the base URL.".to_string(),
        429 => "Rate limited — try again shortly.".to_string(),
        _ => format!("Endpoint returned HTTP {status}."),
    }
}

async fn test_connection(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    clock: &dyn Clock,
    body: BodyOutcome,
) -> Response {
    let started = clock.now();
    let body = match ai_body(
        body,
        json!({ "ok": false, "message": "Invalid JSON body." }),
    ) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let provider = provider_of(&body);
    let api_key = submitted_api_key(db, prop(&body, "apiKey"));
    if provider == "disabled" {
        return json_ok(&json!({
            "ok": false,
            "message": "Pick an AI provider before testing the connection.",
        }));
    }
    if provider_requires_api_key(provider) && api_key.is_empty() {
        return json_ok(&json!({
            "ok": false,
            "message": "An API key is required to test this provider.",
        }));
    }
    let base_url = base_url_of(&body, provider);
    if let Err(message) = check_base_url(&base_url) {
        return json_ok(&json!({
            "ok": false,
            "message": message,
            "latencyMs": clock.now() - started,
        }));
    }
    let request = if provider == "anthropic" {
        list_request(
            format!("{}/v1/models?limit=1", anthropic_api_root(&base_url)),
            anthropic_headers(&api_key),
        )
    } else {
        // openai and custom both expose an OpenAI-compatible /models.
        list_request(format!("{base_url}/models"), openai_headers(&api_key))
    };
    match fetcher.fetch(request).await {
        Ok(reply) => {
            let mut result = Map::new();
            if !(200..300).contains(&reply.status) {
                result.insert("ok".into(), json!(false));
                result.insert("status".into(), json!(reply.status));
                result.insert("message".into(), json!(status_message(reply.status)));
            } else {
                let count = parse_body(&reply.body).ok().and_then(|payload| {
                    array_at(&payload, "data")
                        .or_else(|| {
                            (provider != "anthropic")
                                .then(|| array_at(&payload, "models"))
                                .flatten()
                        })
                        .map(Vec::len)
                });
                result.insert("ok".into(), json!(true));
                result.insert("status".into(), json!(reply.status));
                let message = match count {
                    None => "Reachable.".to_string(),
                    Some(n) => {
                        // `modelsCount: undefined` is dropped by the JSON.
                        result.insert("modelsCount".into(), json!(n));
                        format!(
                            "Reachable · {n} model{} listed.",
                            if n == 1 { "" } else { "s" }
                        )
                    }
                };
                result.insert("message".into(), json!(message));
            }
            result.insert("latencyMs".into(), json!(clock.now() - started));
            json_ok(&Value::Object(result))
        }
        Err(message) => json_ok(&json!({
            "ok": false,
            "message": friendly_network_message(&message, false),
            "latencyMs": clock.now() - started,
        })),
    }
}

// ── POST /api/ai/models ──────────────────────────────────────────────

/// `isLikelyOpenAiTextModel`: no embedding, speech, image, moderation or
/// realtime model, and a name from one of the chat families.
fn is_likely_openai_text_model(id: &str) -> bool {
    let lowered = id.to_lowercase();
    const EXCLUDED: [&str; 10] = [
        "embedding",
        "embed",
        "whisper",
        "tts",
        "audio",
        "transcribe",
        "image",
        "dall-e",
        "moderation",
        "realtime",
    ];
    if EXCLUDED.iter().any(|word| lowered.contains(word)) {
        return false;
    }
    // `/^(gpt-|o\d|o[1-9]|chatgpt-|ft:(gpt-|o\d|o[1-9]))/`.
    let family = |s: &str| {
        s.starts_with("gpt-")
            || s.strip_prefix('o')
                .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
    };
    family(&lowered)
        || lowered.starts_with("chatgpt-")
        || lowered.strip_prefix("ft:").is_some_and(family)
}

/// One `DiscoveredModel`.
fn model(id: String, label: String, source: &str) -> Value {
    json!({ "id": id, "label": label, "source": source })
}

/// A 2xx reply's body, or `HTTP <status>`.
async fn list_body(fetcher: &dyn Fetcher, request: Request) -> Result<Value, String> {
    let reply = fetcher.fetch(request).await?;
    if !(200..300).contains(&reply.status) {
        return Err(format!("HTTP {}", reply.status));
    }
    parse_body(&reply.body)
}

/// `fetchOpenAiCompatibleModels`: every id for a custom endpoint, the chat
/// models for OpenAI, in order and once each.
async fn openai_compatible_models(
    fetcher: &dyn Fetcher,
    base_url: &str,
    api_key: &str,
    provider: &str,
) -> Result<Vec<Value>, String> {
    let payload = list_body(
        fetcher,
        list_request(format!("{base_url}/models"), openai_headers(api_key)),
    )
    .await?;
    let Some(data) = array_at(&payload, "data") else {
        return Ok(vec![]);
    };
    let mut seen = std::collections::HashSet::new();
    Ok(data
        .iter()
        .map(|item| item_text(item, "id"))
        .filter(|id| !id.is_empty() && (provider != "openai" || is_likely_openai_text_model(id)))
        .filter(|id| seen.insert(id.clone()))
        .map(|id| model(id.clone(), id, "openai-compat"))
        .collect())
}

/// `baseUrl.replace(/\/v1\/?$/i, "")`: Ollama's native API is on the root.
fn without_v1(base_url: &str) -> &str {
    for n in [4, 3] {
        let Some(cut) = base_url.len().checked_sub(n) else {
            continue;
        };
        if let Some(tail) = base_url.get(cut..) {
            if tail.eq_ignore_ascii_case("/v1/") || tail.eq_ignore_ascii_case("/v1") {
                return &base_url[..cut];
            }
        }
    }
    base_url
}

/// `fetchOllamaTags`.
async fn ollama_tags(fetcher: &dyn Fetcher, base_url: &str) -> Result<Vec<Value>, String> {
    let payload = list_body(
        fetcher,
        list_request(
            format!("{}/api/tags", without_v1(base_url)),
            vec![("Accept".to_string(), "application/json".to_string())],
        ),
    )
    .await?;
    let Some(models) = array_at(&payload, "models") else {
        return Ok(vec![]);
    };
    let mut seen = std::collections::HashSet::new();
    Ok(models
        .iter()
        .map(|item| item_text(item, "name"))
        .filter(|name| !name.is_empty() && seen.insert(name.clone()))
        .map(|name| model(name.clone(), name, "ollama"))
        .collect())
}

/// `url.searchParams.set(name, value)`: the first pair of that name takes
/// the value and the rest go, or the pair is appended, and the query is
/// written back in `application/x-www-form-urlencoded`.
fn set_search_param(url: &mut url::Url, name: &str, value: &str) {
    let mut pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    match pairs.iter().position(|(k, _)| k == name) {
        Some(first) => {
            pairs[first].1 = value.to_string();
            let mut index = 0;
            pairs.retain(|(k, _)| {
                let keep = index <= first || k != name;
                index += 1;
                keep
            });
        }
        None => pairs.push((name.to_string(), value.to_string())),
    }
    url.query_pairs_mut().clear().extend_pairs(pairs);
}

/// `===` between two values parsed from JSON: objects and arrays are never
/// the same object twice.
fn strictly_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        _ => false,
    }
}

/// `fetchAnthropicModels`: up to five pages of a thousand, following the
/// cursor while the reply says there is more and the cursor moves.
async fn anthropic_models(
    fetcher: &dyn Fetcher,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<Value>, String> {
    let mut seen = std::collections::HashSet::new();
    let mut models = vec![];
    let mut after_id = json!("");
    for _ in 0..5 {
        let mut url = url::Url::parse(&format!("{}/v1/models", anthropic_api_root(base_url)))
            .map_err(|_| "Invalid URL".to_string())?;
        set_search_param(&mut url, "limit", "1000");
        if truthy(&after_id) {
            set_search_param(&mut url, "after_id", &js_string(&after_id));
        }
        let payload = list_body(
            fetcher,
            list_request(url.to_string(), anthropic_headers(api_key)),
        )
        .await?;
        let Some(data) = array_at(&payload, "data") else {
            return Ok(models);
        };
        for item in data {
            let id = item_text(item, "id");
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            let label = Some(item_text(item, "display_name"))
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| id.clone());
            models.push(model(id, label, "anthropic"));
        }
        let has_more = payload.get("has_more").unwrap_or(&Value::Null);
        let last_id = payload.get("last_id").unwrap_or(&Value::Null);
        if !(truthy(has_more) && truthy(last_id)) || strictly_equal(last_id, &after_id) {
            break;
        }
        after_id = last_id.clone();
    }
    Ok(models)
}

async fn list_models(db: &mut dyn DbAccess, fetcher: &dyn Fetcher, body: BodyOutcome) -> Response {
    let body = match ai_body(
        body,
        json!({ "ok": false, "message": "Invalid JSON body." }),
    ) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let provider = provider_of(&body);
    let api_key = submitted_api_key(db, prop(&body, "apiKey"));
    if provider == "disabled" {
        return json_ok(&json!({ "ok": false, "message": "Pick an AI provider first." }));
    }
    if provider_requires_api_key(provider) && api_key.is_empty() {
        return json_ok(&json!({
            "ok": false,
            "message": "API key required for this provider.",
        }));
    }
    let base_url = base_url_of(&body, provider);
    if base_url.is_empty() {
        return json_ok(&json!({ "ok": false, "message": "Base URL is empty." }));
    }
    if let Err(message) = check_base_url(&base_url) {
        return json_ok(&json!({ "ok": false, "message": message }));
    }
    let discovered = match provider {
        "anthropic" => anthropic_models(fetcher, &base_url, &api_key).await,
        "openai" => openai_compatible_models(fetcher, &base_url, &api_key, provider).await,
        // A custom endpoint: the OpenAI-compatible list, or when that fails
        // or is empty, Ollama's own; neither failure is reported.
        _ => {
            let primary = openai_compatible_models(fetcher, &base_url, &api_key, provider)
                .await
                .unwrap_or_default();
            if primary.is_empty() {
                Ok(ollama_tags(fetcher, &base_url).await.unwrap_or_default())
            } else {
                Ok(primary)
            }
        }
    };
    match discovered {
        Ok(models) => json_ok(&json!({ "ok": true, "models": models })),
        Err(message) => json_ok(&json!({
            "ok": false,
            "message": friendly_network_message(&message, true),
        })),
    }
}

// ── POST /api/ai/policy-sample ───────────────────────────────────────

/// `friendlyAiMessage`.
fn friendly_ai_message(message: &str) -> String {
    let text = if mentions(message, &["aborted", "timeout"]) {
        "Timed out while generating the sample summary."
    } else if mentions(message, &["econnrefused", "refused"]) {
        "Connection refused — is the model server running at this URL?"
    } else if mentions(message, &["enotfound", "getaddrinfo"]) {
        "Hostname not found — check the base URL."
    } else if mentions(message, &["certificate", "ssl", "tls"]) {
        "TLS/SSL error — check the base URL and certificates."
    } else if mentions(message, &["fetch failed"]) {
        "Could not reach the model endpoint."
    } else {
        return message.to_string();
    };
    text.to_string()
}

async fn policy_sample(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: &dyn Clock,
    body: BodyOutcome,
) -> Response {
    let started = clock.now();
    let refuse = |error: &str| {
        json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "ok": false, "error": error }),
        )
    };
    let body = match ai_body(body, json!({ "ok": false, "error": "Invalid JSON body." })) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let provider = provider_of(&body);
    if provider == "disabled" {
        return refuse("Pick an AI provider before running a sample summary.");
    }
    let model = trimmed(&body, "model");
    if model.is_empty() {
        return refuse("Pick a model before running a sample summary.");
    }
    if js_length(&model) > 200 {
        return refuse("Model ID is too long.");
    }
    let api_key = submitted_api_key(db, prop(&body, "apiKey"));
    if provider_requires_api_key(provider) && api_key.is_empty() {
        return refuse("An API key is required to test this provider.");
    }
    let base_url = base_url_of(&body, provider);
    if let Err(message) = check_base_url(&base_url) {
        return refuse(&message);
    }
    let config = AiConfig {
        provider,
        api_key,
        base_url,
        model: model.clone(),
        label: provider_label(provider).to_string(),
    };
    match summarize_sample_privacy_policy(db, ids, fetcher, clock, &config, false).await {
        Ok(result) => {
            let duration = clock.now() - started;
            let detail = json!({
                "sample": true,
                "provider": provider,
                "model": model,
                "mode": result["mode"],
                "wordCount": result["sample"]["wordCount"],
            });
            db.with(|w| {
                record_activity_named(
                    w,
                    ids,
                    started + duration,
                    "policy_summary",
                    "ok",
                    None,
                    result["sample"]["appName"].as_str(),
                    Some(&format!("Sample policy model test complete ({model})")),
                    Some(&detail),
                    started,
                )
            });
            json_ok(&json!({
                "ok": true,
                "durationMs": duration,
                "provider": provider,
                "model": model,
                "mode": result["mode"],
                "summary": result["summary"],
                "sample": result["sample"],
                "phases": result["phases"],
            }))
        }
        Err(error) => {
            let message = friendly_ai_message(&error);
            let detail = json!({
                "sample": true,
                "provider": provider,
                "model": model,
                "errorMessage": message,
            });
            let ended = clock.now();
            db.with(|w| {
                record_activity_named(
                    w,
                    ids,
                    ended,
                    "policy_summary",
                    "error",
                    None,
                    Some("Sample Notes"),
                    Some(&js_slice_prefix(
                        &format!("Sample policy model test failed: {message}"),
                        200,
                    )),
                    Some(&detail),
                    started,
                )
            });
            json_response(
                StatusCode::BAD_GATEWAY,
                &json!({ "ok": false, "error": message, "durationMs": clock.now() - started }),
            )
        }
    }
}

// ── POST /api/policy/regenerate ──────────────────────────────────────

const APP_SELECT: &str = "SELECT id, name, developer, privacyPolicyUrl FROM apps WHERE id = ?";

/// `readBoundedJson`'s failures, which this route catches with everything
/// else: each is a 500 carrying the message.
fn body_message(outcome: BodyOutcome) -> Result<Value, String> {
    match outcome {
        BodyOutcome::Json(v) => Ok(v),
        BodyOutcome::Empty => Err("Request body is empty".into()),
        BodyOutcome::TooLarge(max) => Err(format!("Request body too large (limit {max} bytes)")),
        BodyOutcome::Timeout => Err("Request body timed out".into()),
        BodyOutcome::Invalid | BodyOutcome::Whitespace | BodyOutcome::Raw(_) => {
            Err("Invalid JSON body".into())
        }
    }
}

/// `/^\d{1,20}$/`.
fn plausible_app_id(id: &str) -> bool {
    (1..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// One NDJSON line: `JSON.stringify(obj) + "\n"`.
fn ndjson_line(value: &Value) -> Vec<u8> {
    let mut line = js_json_vec(value).unwrap_or_default();
    line.push(b'\n');
    line
}

fn ndjson_response(body: Body) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store, no-transform")
        .body(body)
        .unwrap()
}

/// What the route found before any run: the refusal, or the request to
/// run with its phase and whether to stream.
struct Ready {
    app_id: String,
    phase: Phase,
    stream: bool,
    request: PolicyRequest,
}

/// Everything up to the run, as the route's `try` runs it. `Err` is a
/// message the route's catch answers with a 500.
fn prepare(w: &mut Writer, body: BodyOutcome) -> Result<Result<Ready, Response>, String> {
    let body = body_message(body)?;
    // `body?.appId`: a null body is no object, not a throw.
    let app_id = trimmed(&body, "appId");
    if app_id.is_empty() {
        return Ok(Err(json_error(
            StatusCode::BAD_REQUEST,
            "appId is required",
        )));
    }
    if !plausible_app_id(&app_id) {
        return Ok(Err(json_error(StatusCode::BAD_REQUEST, "Invalid appId")));
    }
    let phase = match prop(&body, "phase").and_then(Value::as_str).map(js_trim) {
        Some("fetch") => Phase::Fetch,
        Some("summarise") => Phase::Summarise,
        _ => Phase::All,
    };
    let stream = prop(&body, "stream") == Some(&Value::Bool(true));
    if phase != Phase::Summarise
        && get_setting_with(w.conn, "policy_scrape_disabled", "false").map_err(|e| e.to_string())?
            == "true"
    {
        return Ok(Err(json_response(
            StatusCode::CONFLICT,
            &json!({ "error": SCRAPE_DISABLED, "code": "policy_scrape_disabled" }),
        )));
    }
    let app = w
        .conn
        .query_row(APP_SELECT, [&app_id], |row| {
            Ok((
                row.get::<_, rusqlite::types::Value>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;
    let Some((id, name, developer, policy_url)) = app else {
        return Ok(Err(json_error(StatusCode::NOT_FOUND, "App not found")));
    };
    let Some(policy_url) = policy_url.filter(|u| !u.is_empty()) else {
        return Ok(Err(json_error(StatusCode::CONFLICT, NO_POLICY_LINK)));
    };
    let id = match id {
        rusqlite::types::Value::Text(s) => s,
        rusqlite::types::Value::Integer(n) => n.to_string(),
        rusqlite::types::Value::Real(f) => crate::jsnum::js_number_spelling(f),
        _ => app_id.clone(),
    };
    Ok(Ok(Ready {
        app_id,
        phase,
        stream,
        request: PolicyRequest {
            app_id: id,
            app_name: name.unwrap_or_default(),
            developer,
            policy_url: Some(policy_url),
        },
    }))
}

/// The options the route runs with: an explicit regenerate always wants
/// fresh work and a fresh summary.
fn options(phase: Phase) -> SyncOptions {
    SyncOptions {
        phase,
        force_resummarise: true,
        bypass_throttle: false,
    }
}

/// The catch: an audit row with the message's first 200 units, and a 500.
fn failed(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    actor: &Actor,
    message: &str,
) -> Response {
    super::diag::log_error(format!("Policy regenerate API error {message}"));
    db.with(|w| {
        record_audit(
            w,
            ids,
            now,
            "policy.regenerate.failed",
            actor,
            Some(&js_slice_prefix(message, 200)),
            false,
        )
    });
    json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        &json!({ "error": message }),
    )
}

async fn regenerate(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: Arc<dyn Clock>,
    body: BodyOutcome,
    actor: &Actor,
) -> (Response, FollowUps) {
    let none = FollowUps::default;
    let ready = match db.with(|w| prepare(w, body)) {
        Ok(Ok(ready)) => ready,
        Ok(Err(refusal)) => return (refusal, none()),
        Err(message) => {
            let now = clock.now();
            return (failed(db, ids, now, actor, &message), none());
        }
    };
    let phase_name = ready.phase.as_str();
    if ready.stream {
        // On the server the run is spawned and its lines are written as
        // they come; a replay's accessor cannot be detached, so its run
        // goes in place and the lines are written at the end.
        if let Some(run) = Detached::take(db, ids, fetcher, &clock) {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
            let actor = Actor {
                ip: actor.ip.clone(),
                user_agent: actor.user_agent.clone(),
            };
            tokio::spawn(async move {
                let Detached {
                    mut db,
                    mut ids,
                    fetcher,
                    clock,
                } = run;
                let mut write = |line: Vec<u8>| {
                    // A closed stream (the client went away) is ignored.
                    let _ = tx.send(line);
                };
                let follow_ups = stream_run(
                    &mut *db, &mut *ids, &*fetcher, &*clock, &ready, &actor, &mut write,
                )
                .await;
                policy_store::run_follow_ups(&mut *db, &*fetcher, &*clock, follow_ups).await;
            });
            let lines = futures_util::stream::unfold(rx, |mut rx| async move {
                rx.recv()
                    .await
                    .map(|line| (Ok::<_, std::convert::Infallible>(line), rx))
            });
            return (ndjson_response(Body::from_stream(lines)), none());
        }
        let mut body = Vec::new();
        let follow_ups = stream_run(db, ids, fetcher, &*clock, &ready, actor, &mut |line| {
            body.extend(line)
        })
        .await;
        return (ndjson_response(Body::from(body)), follow_ups);
    }
    let synced = policy_store::sync_policy_analysis(
        db,
        ids,
        fetcher,
        &*clock,
        &ready.request,
        options(ready.phase),
    )
    .await;
    match synced {
        Ok(synced) => {
            let now = clock.now();
            let detail = format!("appId={} phase={phase_name}", ready.app_id);
            db.with(|w| {
                record_audit(
                    w,
                    ids,
                    now,
                    "policy.regenerate.success",
                    actor,
                    Some(&detail),
                    true,
                )
            });
            (
                json_ok(&json!({ "analysis": synced.analysis })),
                synced.follow_ups,
            )
        }
        Err(message) => {
            let now = clock.now();
            (failed(db, ids, now, actor, &message), none())
        }
    }
}

/// The stream's run: a `phase` line for each record the logger emits, then
/// `done` with the analysis and the success audit, or `error` with the
/// message and the failure audit.
async fn stream_run(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: &dyn Clock,
    ready: &Ready,
    actor: &Actor,
    write: &mut (dyn FnMut(Vec<u8>) + Send),
) -> FollowUps {
    let outcome = {
        let mut sink = |record: &Map<String, Value>| {
            write(ndjson_line(&json!({ "type": "phase", "phase": record })))
        };
        policy_store::sync_policy_analysis_streamed(
            db,
            ids,
            fetcher,
            clock,
            &ready.request,
            options(ready.phase),
            Some(&mut sink),
        )
        .await
    };
    let prefix = format!(
        "appId={} phase={} stream=1",
        ready.app_id,
        ready.phase.as_str()
    );
    let now = clock.now();
    match outcome {
        Ok(synced) => {
            write(ndjson_line(
                &json!({ "type": "done", "analysis": synced.analysis }),
            ));
            db.with(|w| {
                record_audit(
                    w,
                    ids,
                    now,
                    "policy.regenerate.success",
                    actor,
                    Some(&prefix),
                    true,
                )
            });
            synced.follow_ups
        }
        Err(message) => {
            write(ndjson_line(&json!({ "type": "error", "error": message })));
            let detail = format!("{prefix} {}", js_slice_prefix(&message, 200));
            db.with(|w| {
                record_audit(
                    w,
                    ids,
                    now,
                    "policy.regenerate.failed",
                    actor,
                    Some(&detail),
                    false,
                )
            });
            FollowUps::default()
        }
    }
}

/// The run a streamed regenerate spawns off the request: an owned
/// accessor, id source, fetcher and clock, or nothing when one of them
/// cannot be detached.
struct Detached {
    db: Box<dyn DbAccess>,
    ids: Box<dyn Ids>,
    fetcher: Arc<dyn Fetcher>,
    clock: Arc<dyn Clock>,
}

impl Detached {
    fn take(
        db: &dyn DbAccess,
        ids: &dyn Ids,
        fetcher: &dyn Fetcher,
        clock: &Arc<dyn Clock>,
    ) -> Option<Self> {
        Some(Self {
            db: db.detach()?,
            ids: ids.detach()?,
            fetcher: fetcher.shared()?,
            clock: clock.clone(),
        })
    }
}

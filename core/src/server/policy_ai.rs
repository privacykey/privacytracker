//! Phase 5, batch 3a: the AI calls in `lib/privacy-policy.ts`.
//!
//! - `getAiRuntimeConfig`: the provider, model, endpoint and key Settings
//!   stored, or nothing when a summary cannot be asked for.
//! - `callAiJson`: one call, retried once when it timed out or aborted —
//!   judged, as Node judges it, by the words of the error, so an upstream
//!   error body that mentions a timeout is retried too.
//! - `callChatCompletionsJson`: OpenAI with a strict `json_schema`; a
//!   custom endpoint with `json_object`, a skeleton of the shape appended
//!   to the prompt, and a streamed reply read frame by frame, so what
//!   arrived before a timeout still reaches the debug log.
//! - `callAnthropicJson`: the analysis as a forced tool call, its text as
//!   the fallback.
//! - The debug log (`ai_debug_logging`), and the debounced "raise the
//!   timeout" notification with its run-log line.
//!
//! Every call goes through `Fetcher::fetch_stream`: private addresses
//! allowed (a local model), metadata never, redirects refused, one deadline
//! over the request and every read of the body.
#![cfg_attr(not(test), allow(dead_code))]

use super::{
    policy_store::{setting, RunLogger},
    settings::get_setting_with,
};
use crate::{
    jsjson,
    jsnum::js_to_number,
    jsstr::{js_length, js_slice_prefix, js_string, js_trim},
    outbound::{Fetcher, Request, Streamed},
    policy::{
        ai::{
            anthropic_api_root, normalize_ai_provider, normalize_base_url, provider_label,
            provider_requires_api_key, resolve_ai_timeout_ms, resolve_default_base_url,
            resolve_default_model, AiConfig, TimeoutPhase,
        },
        prompts::{json_skeleton_for_schema, strip_json_code_fence, POLICY_SYSTEM_PROMPT},
    },
    scrape::{js::truthy, notify::prune_notifications, persist::Ids},
};
use rusqlite::Connection;
use serde_json::{json, Value};

const AI_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;
const AI_DEBUG_LOG_MAX: i64 = 50;
const AI_DEBUG_FIELD_MAX: usize = 200_000;
const AI_TIMEOUT_NOTIFY_WINDOW_MS: f64 = 10.0 * 60_000.0;
const AI_TIMEOUT_NOTIFICATION_APP_ID: &str = "__ai_timeout__";
const INSERT_DEBUG: &str = "INSERT INTO ai_debug_log (id, created_at, app_id, app_name, provider, model, phase, prompt, response, duration_ms, error)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const PRUNE_DEBUG: &str = "DELETE FROM ai_debug_log\n       WHERE id IN (\n         SELECT id FROM ai_debug_log ORDER BY created_at DESC LIMIT -1 OFFSET ?\n       )";
const INSERT_TIMEOUT_NOTIFICATION: &str = "\n    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)\n    VALUES (?, ?, ?, ?, ?, 0)\n  ";
const SET_SETTING: &str = "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)";

/// `getAiRuntimeConfig`.
pub(crate) fn get_ai_runtime_config(conn: &Connection) -> Result<Option<AiConfig>, String> {
    let read =
        |key: &str, default: &str| get_setting_with(conn, key, default).map_err(|e| e.to_string());
    let provider = normalize_ai_provider(&read("ai_provider", "disabled")?);
    if provider == "disabled" {
        return Ok(None);
    }
    // `getSetting(key, fallback) || fallback`: a stored empty string takes
    // the default too.
    let or_default = |value: String, default: &str| {
        if value.is_empty() {
            default.to_string()
        } else {
            value
        }
    };
    let default_model = resolve_default_model(provider);
    let model = js_trim(&or_default(read("ai_model", default_model)?, default_model)).to_string();
    let default_base = resolve_default_base_url(provider);
    let base_url = normalize_base_url(
        &or_default(read("ai_base_url", default_base)?, default_base),
        provider,
    );
    let api_key = js_trim(&read("ai_api_key", "")?).to_string();
    if model.is_empty() || base_url.is_empty() {
        return Ok(None);
    }
    if provider_requires_api_key(provider) && api_key.is_empty() {
        return Ok(None);
    }
    Ok(Some(AiConfig {
        provider,
        api_key,
        base_url,
        model,
        label: provider_label(provider).to_string(),
    }))
}

/// One `callAiJson` request.
pub(crate) struct AiCall<'c> {
    pub schema_name: &'c str,
    pub schema: Value,
    pub prompt: String,
    pub app_id: Option<&'c str>,
    pub app_name: Option<&'c str>,
    /// `phase`: the debug log's label; the schema name when absent.
    pub phase: Option<String>,
    pub phase_kind: TimeoutPhase,
}

/// `isAbortOrTimeoutError`, by the message: `/aborted|timeout|ETIMEDOUT/i`.
/// Every abort and timeout Node can raise here says one of those.
pub(crate) fn is_abort_or_timeout(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("aborted") || lower.contains("timeout") || lower.contains("etimedout")
}

/// `Math.round(ms / 1000)`: half-way rounds up, as JavaScript rounds.
fn seconds(ms: i64) -> i64 {
    (ms as f64 / 1000.0 + 0.5).floor() as i64
}

/// `resolveTimeoutForPhase`: read on every call, so a changed setting
/// applies without a restart.
fn resolve_timeout_for_phase(
    log: &mut RunLogger<'_>,
    config: &AiConfig,
    phase: TimeoutPhase,
) -> u64 {
    let raw = setting(log, phase.setting_key(), "");
    resolve_ai_timeout_ms(&raw, config.provider, &config.model, phase)
}

// ── The debug log ────────────────────────────────────────────────────

struct DebugCapture {
    id: String,
    created_at: i64,
    app_id: Option<String>,
    app_name: Option<String>,
    provider: String,
    model: String,
    phase: String,
    prompt: String,
}

/// `beginAiDebugCapture`: nothing unless `ai_debug_logging` is on; the id
/// is drawn now, before the request.
fn begin_debug(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    config: &AiConfig,
    call: &AiCall<'_>,
    prompt: String,
) -> Option<DebugCapture> {
    let raw = setting(log, "ai_debug_logging", "false");
    if raw != "true" && raw != "1" {
        return None;
    }
    let created_at = log.now();
    let id = log.db().with(|w| ids.uuid(w.conn)).ok()?;
    Some(DebugCapture {
        id,
        created_at,
        app_id: call.app_id.map(str::to_string),
        app_name: call.app_name.map(str::to_string),
        provider: config.provider.to_string(),
        model: config.model.clone(),
        phase: call
            .phase
            .clone()
            .unwrap_or_else(|| call.schema_name.to_string()),
        prompt,
    })
}

/// `truncateForLog`.
fn truncate_for_log(value: &str) -> String {
    if js_length(value) <= AI_DEBUG_FIELD_MAX {
        return value.to_string();
    }
    format!(
        "{}\n… [truncated at {AI_DEBUG_FIELD_MAX} chars]",
        js_slice_prefix(value, AI_DEBUG_FIELD_MAX)
    )
}

/// `finishAiDebugCapture`: the row, then the cap on the newest fifty; a
/// failure is swallowed, as Node swallows it. A call can finish twice (a
/// refusal is logged, then caught and logged again), and the second insert
/// fails on the id.
fn finish_debug(
    log: &mut RunLogger<'_>,
    capture: Option<&DebugCapture>,
    response: &str,
    duration_ms: i64,
    error: Option<&str>,
) {
    let Some(c) = capture else {
        return;
    };
    let params = vec![
        json!(c.id),
        json!(c.created_at),
        c.app_id.as_deref().map_or(Value::Null, |v| json!(v)),
        c.app_name.as_deref().map_or(Value::Null, |v| json!(v)),
        json!(c.provider),
        json!(c.model),
        json!(c.phase),
        json!(truncate_for_log(&c.prompt)),
        json!(truncate_for_log(response)),
        json!(duration_ms),
        error.map_or(Value::Null, |e| json!(e)),
    ];
    let outcome = log.db().with(|w| {
        w.run(INSERT_DEBUG, params)?;
        w.run(PRUNE_DEBUG, vec![json!(AI_DEBUG_LOG_MAX)])
    });
    if let Err(e) = outcome {
        super::diag::log_warn(format!("[AI debug] failed to persist row: {e}"));
    }
}

// ── The timeout notification ─────────────────────────────────────────

/// `createAiTimeoutNotification`: one bell row per phase every ten
/// minutes at most, with no webhook.
fn create_ai_timeout_notification(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    app_name: &str,
    phase: TimeoutPhase,
    timeout_ms: u64,
    observed_ms: i64,
    model_label: &str,
) -> Result<bool, String> {
    let now = log.now();
    log.db().with(|w| {
        let key = format!("ai_timeout_notify_{}_at", phase.as_str());
        let stored = get_setting_with(w.conn, &key, "0").map_err(|e| e.to_string())?;
        // `Number(x) || 0`: NaN and zero alike are "never".
        let last = js_to_number(&Value::String(stored));
        let last = if last.is_nan() { 0.0 } else { last };
        if (now as f64) - last < AI_TIMEOUT_NOTIFY_WINDOW_MS {
            return Ok(false);
        }
        let pretty = match phase {
            TimeoutPhase::Direct => "direct summary",
            TimeoutPhase::Chunk => "per-chunk",
            TimeoutPhase::Merge => "chunk-merge",
        };
        let observed_secs = seconds(observed_ms).max(1);
        let budget_secs = seconds(timeout_ms as i64).max(1);
        let suffix = if model_label.is_empty() {
            String::new()
        } else {
            format!(" with {model_label}")
        };
        let description = format!(
            "AI {pretty} call{suffix} aborted after {observed_secs}s (limit: {budget_secs}s). Raise the {}-phase AI timeout in Settings → AI.",
            phase.as_str()
        );
        let changes = json!([{
            "type": "ai_timeout",
            "description": description,
            "phase": phase.as_str(),
            "timeoutMs": timeout_ms,
            "observedMs": observed_ms,
            "modelLabel": model_label,
        }]);
        let id = ids.uuid(w.conn)?;
        let name = if app_name.is_empty() {
            "Privacy policy AI"
        } else {
            app_name
        };
        w.run(
            INSERT_TIMEOUT_NOTIFICATION,
            vec![
                json!(id),
                json!(AI_TIMEOUT_NOTIFICATION_APP_ID),
                json!(name),
                json!(changes.to_string()),
                json!(now),
            ],
        )?;
        prune_notifications(w);
        w.run(SET_SETTING, vec![json!(key), json!(now.to_string())])?;
        Ok(true)
    })
}

/// `surfaceAiTimeout`: the notification, then the run-log line naming the
/// setting to raise.
fn surface_ai_timeout(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    config: &AiConfig,
    call: &AiCall<'_>,
    observed_ms: i64,
) {
    let phase = call.phase_kind;
    let timeout_ms = resolve_timeout_for_phase(log, config, phase);
    if let Err(e) = create_ai_timeout_notification(
        log,
        ids,
        call.app_name.unwrap_or("Privacy policy AI"),
        phase,
        timeout_ms,
        observed_ms,
        &config.model,
    ) {
        super::diag::log_warn(format!(
            "[policy] failed to record AI timeout notification: {e}"
        ));
    }
    log.note(
        "ai-timeout",
        format!(
            "{p} phase aborted after {}s (limit {}s). Raise the {p}-phase timeout in Settings → AI.",
            seconds(observed_ms),
            seconds(timeout_ms as i64),
            p = phase.as_str()
        ),
    );
}

// ── Reading the reply ────────────────────────────────────────────────

/// `readBoundedResponseText`: the whole body, two megabytes at most,
/// decoded as `Buffer.toString("utf8")` decodes it.
async fn read_bounded_text(streamed: &mut Streamed) -> Result<String, String> {
    let mut body = Vec::new();
    loop {
        let chunk = streamed.next_chunk().await?;
        if chunk.is_empty() {
            break;
        }
        if body.len() + chunk.len() > AI_RESPONSE_MAX_BYTES {
            return Err(format!(
                "AI response exceeded {AI_RESPONSE_MAX_BYTES} bytes"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// `new TextDecoder("utf-8")` fed with `{ stream: true }` and never
/// flushed: a sequence cut by a chunk boundary waits for the next chunk,
/// one still incomplete at the end is dropped, a leading byte order mark
/// is removed, and anything invalid is U+FFFD.
#[derive(Default)]
struct StreamDecoder {
    pending: Vec<u8>,
    started: bool,
}

impl StreamDecoder {
    fn decode(&mut self, chunk: &[u8]) -> String {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(chunk);
        let mut out = String::new();
        let mut rest: &[u8] = &data;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &after[n..];
                        }
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        if !self.started && !out.is_empty() {
            self.started = true;
            if let Some(stripped) = out.strip_prefix('\u{FEFF}') {
                out = stripped.to_string();
            }
        }
        out
    }
}

/// `value?.[0]`: an array's first element, or an object's `"0"`.
fn first(value: Option<&Value>) -> Option<&Value> {
    match value? {
        Value::Array(items) => items.first(),
        Value::Object(map) => map.get("0"),
        _ => None,
    }
}

/// `value?.key` on a parsed value: only an object has named properties.
fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value? {
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

/// `part?.text ?? ""`, as `join` then spells it.
fn part_text(part: &Value) -> String {
    match get(Some(part), "text") {
        None | Some(Value::Null) => String::new(),
        Some(text) => js_string(text),
    }
}

/// `consumeEvent`: one `data:` line of the stream. A delta's content is
/// appended; a full message (some Ollama builds end with one) only when
/// the frame carried no delta; a frame that is not JSON is skipped.
fn consume_event(data_line: &str, content: &mut String) {
    let payload = js_trim(data_line);
    if payload.is_empty() || payload == "[DONE]" {
        return;
    }
    let Ok(parsed) = jsjson::parse(payload) else {
        return;
    };
    let choice = first(get(Some(&parsed), "choices"));
    let delta = get(get(choice, "delta"), "content");
    if let Some(Value::String(text)) = delta {
        content.push_str(text);
    }
    if let Some(Value::String(full)) = get(get(choice, "message"), "content") {
        if !delta.is_some_and(truthy) {
            content.push_str(full);
        }
    }
}

/// Every `data:` line of one event.
fn consume_lines(event: &str, content: &mut String) {
    for line in event.split('\n') {
        if let Some(rest) = line.strip_prefix("data:") {
            consume_event(rest, content);
        }
    }
}

/// `readStreamingChatCompletion`: the raw body for the debug log and the
/// content the frames carried. A failure hands back what arrived before it.
async fn read_streaming_chat_completion(
    streamed: &mut Streamed,
) -> Result<(String, String), (String, String)> {
    let mut decoder = StreamDecoder::default();
    let mut raw = String::new();
    let mut buffer = String::new();
    let mut content = String::new();
    let mut total = 0usize;
    loop {
        let chunk = match streamed.next_chunk().await {
            Ok(chunk) => chunk,
            Err(e) => return Err((e, raw)),
        };
        if chunk.is_empty() {
            break;
        }
        total += chunk.len();
        if total > AI_RESPONSE_MAX_BYTES {
            return Err((
                format!("AI response exceeded {AI_RESPONSE_MAX_BYTES} bytes"),
                raw,
            ));
        }
        let text = decoder.decode(&chunk);
        raw.push_str(&text);
        buffer.push_str(&text);
        while let Some(end) = buffer.find("\n\n") {
            let event = buffer[..end].to_string();
            buffer.drain(..end + 2);
            consume_lines(&event, &mut content);
        }
    }
    if !js_trim(&buffer).is_empty() {
        consume_lines(&buffer, &mut content);
    }
    Ok((raw, content))
}

// ── The calls ────────────────────────────────────────────────────────

/// The request both providers make: POST, JSON, private hosts allowed,
/// no redirect, a 1,024-character URL cap and the phase's deadline.
fn ai_request(
    url: String,
    headers: Vec<(String, String)>,
    body: &Value,
    timeout_ms: u64,
) -> Request {
    let mut request = Request::public(url, AI_RESPONSE_MAX_BYTES, timeout_ms);
    request.headers = headers;
    request.method = "POST".to_string();
    request.body = Some(body.to_string());
    request.max_url_length = 1024;
    request.follow_redirects = false;
    request.allow_private_hosts = true;
    request.reject_redirects = true;
    request
}

/// What failed before any reply: the transport's refusal, the network, or
/// the deadline.
fn request_failed(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    config: &AiConfig,
    call: &AiCall<'_>,
    debug: Option<&DebugCapture>,
    started: i64,
    error: &str,
) -> String {
    let observed = log.now() - started;
    let abort = is_abort_or_timeout(error);
    let message = if abort {
        format!(
            "{} request aborted after {}s ({}-phase timeout).",
            config.label,
            seconds(observed),
            call.phase_kind.as_str()
        )
    } else {
        format!("{} request failed: {error}", config.label)
    };
    finish_debug(log, debug, "", observed, Some(&message));
    log.fail("ai-error", message.clone());
    if abort {
        surface_ai_timeout(log, ids, config, call, observed);
    }
    message
}

/// An error status: its body, quoted to 300 characters. Reading the body
/// can itself fail, and that error goes up unwrapped, as Node's does.
async fn status_failed(
    log: &mut RunLogger<'_>,
    config: &AiConfig,
    debug: Option<&DebugCapture>,
    started: i64,
    streamed: &mut Streamed,
) -> String {
    let body = match read_bounded_text(streamed).await {
        Ok(body) => body,
        Err(e) => return e,
    };
    let message = format!(
        "{} request failed ({}): {}",
        config.label,
        streamed.status,
        js_slice_prefix(&body, 300)
    );
    let now = log.now();
    finish_debug(log, debug, &body, now - started, Some(&message));
    log.fail("ai-error", message.clone());
    message
}

/// `callChatCompletionsJson`.
async fn call_chat_completions_json(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    config: &AiConfig,
    call: &AiCall<'_>,
) -> Result<Value, String> {
    let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
    if !config.api_key.is_empty() {
        headers.push((
            "Authorization".to_string(),
            format!("Bearer {}", config.api_key),
        ));
    }
    let custom = config.provider == "custom";
    let response_format = if custom {
        json!({"type": "json_object"})
    } else {
        json!({
            "type": "json_schema",
            "json_schema": {"name": call.schema_name, "strict": true, "schema": call.schema},
        })
    };
    let user_prompt = if custom {
        let skeleton = serde_json::to_string_pretty(&json_skeleton_for_schema(&call.schema))
            .unwrap_or_default();
        format!(
            "{}\n\nRespond with a single JSON object shaped exactly like:\n{skeleton}",
            call.prompt
        )
    } else {
        call.prompt.clone()
    };
    let debug = begin_debug(
        log,
        ids,
        config,
        call,
        format!("System: {POLICY_SYSTEM_PROMPT}\n---\nUser: {user_prompt}"),
    );
    let started = log.now();
    let timeout_ms = resolve_timeout_for_phase(log, config, call.phase_kind);
    let mut body = json!({
        "model": config.model,
        "temperature": 0.1,
        "response_format": response_format,
        "messages": [
            {"role": "system", "content": POLICY_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    });
    if custom {
        body["stream"] = json!(true);
    }
    let request = ai_request(
        format!("{}/chat/completions", config.base_url),
        headers,
        &body,
        timeout_ms,
    );
    let mut streamed = match fetcher.fetch_stream(request).await {
        Ok(streamed) => streamed,
        Err(error) => {
            return Err(request_failed(
                log,
                ids,
                config,
                call,
                debug.as_ref(),
                started,
                &error,
            ));
        }
    };
    if !streamed.ok() {
        return Err(status_failed(log, config, debug.as_ref(), started, &mut streamed).await);
    }

    // The `try` around reading the reply: a refusal is thrown inside it,
    // so it is logged twice, the second time as a processing failure.
    let attempt: Result<(String, String), (String, Option<String>)> = if custom {
        read_streaming_chat_completion(&mut streamed)
            .await
            .map_err(|(e, partial)| (e, Some(partial)))
    } else {
        match read_bounded_text(&mut streamed).await {
            Err(e) => Err((e, None)),
            Ok(raw) => match jsjson::parse(&raw) {
                Err(e) => Err((e, None)),
                Ok(payload) => {
                    let message = get(first(get(Some(&payload), "choices")), "message");
                    match get(message, "refusal").filter(|r| truthy(r)) {
                        Some(refusal) => {
                            let text = format!(
                                "{} refused the request: {}",
                                config.label,
                                js_string(refusal)
                            );
                            let now = log.now();
                            finish_debug(log, debug.as_ref(), &raw, now - started, Some(&text));
                            log.fail("ai-error", text.clone());
                            Err((text, None))
                        }
                        None => {
                            let content = match get(message, "content") {
                                Some(Value::Array(parts)) => {
                                    parts.iter().map(part_text).collect::<String>()
                                }
                                Some(Value::String(text)) => text.clone(),
                                _ => String::new(),
                            };
                            Ok((raw, content))
                        }
                    }
                }
            },
        }
    };
    let (raw_body, content) = match attempt {
        Ok(read) => read,
        Err((error, partial)) => {
            let observed = log.now() - started;
            let abort = is_abort_or_timeout(&error);
            let message = if abort {
                format!(
                    "{} stream aborted after {}s ({}-phase timeout).",
                    config.label,
                    seconds(observed),
                    call.phase_kind.as_str()
                )
            } else {
                format!("{} response processing failed: {error}", config.label)
            };
            finish_debug(
                log,
                debug.as_ref(),
                partial.as_deref().unwrap_or(""),
                observed,
                Some(&message),
            );
            log.fail("ai-error", message.clone());
            if abort {
                surface_ai_timeout(log, ids, config, call, observed);
            }
            return Err(message);
        }
    };
    let duration = log.now() - started;
    if js_trim(&content).is_empty() {
        let message = format!("{} returned an empty response.", config.label);
        finish_debug(log, debug.as_ref(), &raw_body, duration, Some(&message));
        log.fail("ai-error", message.clone());
        return Err(message);
    }
    finish_debug(log, debug.as_ref(), &raw_body, duration, None);
    jsjson::parse(&strip_json_code_fence(&content))
}

/// `callAnthropicJson`.
async fn call_anthropic_json(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    config: &AiConfig,
    call: &AiCall<'_>,
) -> Result<Value, String> {
    let endpoint = anthropic_api_root(&config.base_url);
    let debug = begin_debug(
        log,
        ids,
        config,
        call,
        format!("System: {POLICY_SYSTEM_PROMPT}\n---\nUser: {}", call.prompt),
    );
    let started = log.now();
    let timeout_ms = resolve_timeout_for_phase(log, config, call.phase_kind);
    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("x-api-key".to_string(), config.api_key.clone()),
        ("anthropic-version".to_string(), "2023-06-01".to_string()),
    ];
    let body = json!({
        "model": config.model,
        "max_tokens": 2400,
        "temperature": 0.1,
        "system": POLICY_SYSTEM_PROMPT,
        "tools": [{
            "name": call.schema_name,
            "description": "Return the requested privacy-policy analysis JSON.",
            "input_schema": call.schema,
        }],
        "tool_choice": {"type": "tool", "name": call.schema_name},
        "messages": [{"role": "user", "content": call.prompt}],
    });
    let request = ai_request(
        format!("{endpoint}/v1/messages"),
        headers,
        &body,
        timeout_ms,
    );
    let mut streamed = match fetcher.fetch_stream(request).await {
        Ok(streamed) => streamed,
        Err(error) => {
            return Err(request_failed(
                log,
                ids,
                config,
                call,
                debug.as_ref(),
                started,
                &error,
            ));
        }
    };
    if !streamed.ok() {
        return Err(status_failed(log, config, debug.as_ref(), started, &mut streamed).await);
    }
    // Read outside any `try`: a timeout here goes up as it is, with no
    // debug row and no notification, and `callAiJson` retries it.
    let raw_body = read_bounded_text(&mut streamed).await?;
    let duration = log.now() - started;
    let payload = match jsjson::parse(&raw_body) {
        Ok(payload) => payload,
        Err(e) => {
            let message = format!("{} returned non-JSON response: {e}", config.label);
            finish_debug(log, debug.as_ref(), &raw_body, duration, Some(&message));
            log.fail("ai-error", message.clone());
            return Err(message);
        }
    };
    let parts = match get(Some(&payload), "content") {
        Some(Value::Array(parts)) => Some(parts),
        _ => None,
    };
    let kind_is =
        |part: &Value, kind: &str| get(Some(part), "type").and_then(Value::as_str) == Some(kind);
    let tool_input = parts
        .and_then(|parts| {
            parts.iter().find(|part| {
                kind_is(part, "tool_use")
                    && get(Some(part), "name").and_then(Value::as_str) == Some(call.schema_name)
            })
        })
        .and_then(|part| get(Some(part), "input"))
        .filter(|input| truthy(input));
    if let Some(input) = tool_input {
        finish_debug(log, debug.as_ref(), &raw_body, duration, None);
        return Ok(input.clone());
    }
    let text: String = parts
        .map(|parts| {
            parts
                .iter()
                .filter(|part| kind_is(part, "text"))
                .map(part_text)
                .collect()
        })
        .unwrap_or_default();
    if js_trim(&text).is_empty() {
        let message = format!("{} returned an empty response.", config.label);
        finish_debug(log, debug.as_ref(), &raw_body, duration, Some(&message));
        log.fail("ai-error", message.clone());
        return Err(message);
    }
    finish_debug(log, debug.as_ref(), &raw_body, duration, None);
    jsjson::parse(&strip_json_code_fence(&text))
}

async fn invoke(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    config: &AiConfig,
    call: &AiCall<'_>,
) -> Result<Value, String> {
    if config.provider == "anthropic" {
        call_anthropic_json(log, ids, fetcher, config, call).await
    } else {
        call_chat_completions_json(log, ids, fetcher, config, call).await
    }
}

/// `callAiJson`: one retry on a timeout or an abort, with the same budget.
pub(crate) async fn call_ai_json(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    config: &AiConfig,
    call: &AiCall<'_>,
) -> Result<Value, String> {
    match invoke(log, ids, fetcher, config, call).await {
        Err(error) if is_abort_or_timeout(&error) => {
            log.note(
                "ai-retry",
                format!(
                    "{} phase timed out — retrying once with the same budget.",
                    call.phase_kind.as_str()
                ),
            );
            invoke(log, ids, fetcher, config, call).await
        }
        outcome => outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stream_decoder_waits_drops_and_strips_as_text_decoder_does() {
        let mut d = StreamDecoder::default();
        assert_eq!(d.decode(&[0xEF, 0xBB]), "");
        assert_eq!(d.decode(&[0xBF, b'h', 0xC3]), "h");
        assert_eq!(d.decode(&[0xA9, 0xFF, b'!']), "é\u{FFFD}!");
        // An incomplete sequence at the end is never flushed.
        assert_eq!(d.decode(&[0xE2, 0x82]), "");
    }

    #[test]
    fn frames_follow_node() {
        let mut content = String::new();
        consume_event(r#" {"choices":[{"delta":{"content":"a"}}]} "#, &mut content);
        consume_event(
            r#"{"choices":[{"delta":{"content":""},"message":{"content":"b"}}]}"#,
            &mut content,
        );
        consume_event(
            r#"{"choices":[{"delta":{"content":"c"},"message":{"content":"x"}}]}"#,
            &mut content,
        );
        consume_event("{not json}", &mut content);
        consume_event("[DONE]", &mut content);
        assert_eq!(content, "abc");
        assert!(is_abort_or_timeout("upstream TIMEOUT"));
        assert!(is_abort_or_timeout("connect ETIMEDOUT"));
        assert!(!is_abort_or_timeout("fetch failed"));
        assert_eq!(seconds(1500), 2);
        assert_eq!(seconds(-500), 0);
    }
}

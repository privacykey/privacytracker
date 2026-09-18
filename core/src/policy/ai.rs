//! Phase 5, batch 3a: `lib/ai-config.ts` — the providers, their default
//! endpoints and models, which of them need a policy cut into chunks, and
//! the per-phase request timeouts — with the base-URL rules
//! `getAiRuntimeConfig` applies to what Settings stored.
use crate::jsnum::js_to_number;
use crate::jsstr::js_trim;
use serde_json::Value;

/// `normalizeAiProvider`: `ollama` is the custom provider, and anything
/// unknown is disabled.
pub fn normalize_ai_provider(value: &str) -> &'static str {
    match value {
        "openai" => "openai",
        "anthropic" => "anthropic",
        "custom" | "ollama" => "custom",
        _ => "disabled",
    }
}

/// `resolveDefaultBaseUrl`.
pub fn resolve_default_base_url(provider: &str) -> &'static str {
    match provider {
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com",
        "custom" => "http://127.0.0.1:11434",
        _ => "",
    }
}

/// `resolveDefaultModel`.
pub fn resolve_default_model(provider: &str) -> &'static str {
    match provider {
        "openai" => "gpt-4.1-mini",
        "anthropic" => "claude-3-5-haiku-latest",
        "custom" => "gemma3n:e4b",
        _ => "",
    }
}

/// `providerRequiresApiKey`.
pub fn provider_requires_api_key(provider: &str) -> bool {
    provider == "openai" || provider == "anthropic"
}

/// `providerLikelyNeedsChunking`: every custom endpoint, and any model
/// whose name says it is one of the small open families.
pub fn provider_likely_needs_chunking(provider: &str, model: &str) -> bool {
    if provider == "custom" {
        return true;
    }
    let lowered = model.to_lowercase();
    ["llama", "mistral", "qwen", "phi", "gemma", "mixtral"]
        .iter()
        .any(|family| lowered.contains(family))
}

/// `AiTimeoutPhase`: which budget a call spends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutPhase {
    Direct,
    Chunk,
    Merge,
}

impl TimeoutPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Chunk => "chunk",
            Self::Merge => "merge",
        }
    }
    /// `AI_TIMEOUT_SETTING_KEYS[phase]`.
    pub fn setting_key(self) -> &'static str {
        match self {
            Self::Direct => "ai_timeout_direct_ms",
            Self::Chunk => "ai_timeout_chunk_ms",
            Self::Merge => "ai_timeout_merge_ms",
        }
    }
}

pub const AI_TIMEOUT_MIN_MS: f64 = 10_000.0;
pub const AI_TIMEOUT_MAX_MS: f64 = 15.0 * 60_000.0;

/// `defaultAiTimeoutMs`: a hosted model gets ninety seconds, two minutes to
/// merge; a model that needs chunks gets three minutes, six to merge.
pub fn default_ai_timeout_ms(provider: &str, model: &str, phase: TimeoutPhase) -> u64 {
    let slow = provider_likely_needs_chunking(provider, model);
    match (slow, phase) {
        (false, TimeoutPhase::Merge) => 120_000,
        (false, _) => 90_000,
        (true, TimeoutPhase::Merge) => 6 * 60_000,
        (true, _) => 3 * 60_000,
    }
}

/// `resolveAiTimeoutMs`: the stored setting as `Number` reads it, floored
/// and clamped to ten seconds through fifteen minutes; the default when it
/// is missing, empty or not finite.
pub fn resolve_ai_timeout_ms(raw: &str, provider: &str, model: &str, phase: TimeoutPhase) -> u64 {
    let fallback = default_ai_timeout_ms(provider, model, phase);
    if raw.is_empty() {
        return fallback;
    }
    let parsed = js_to_number(&Value::String(raw.to_string()));
    if !parsed.is_finite() {
        return fallback;
    }
    parsed.floor().clamp(AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS) as u64
}

/// `AiRuntimeConfig`.
#[derive(Debug, Clone)]
pub struct AiConfig {
    /// `openai`, `anthropic` or `custom`.
    pub provider: &'static str,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub label: String,
}

/// The label `getAiRuntimeConfig` gives each provider.
pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        _ => "Custom AI endpoint",
    }
}

/// `/^https?:\/\//i`.
fn has_http_scheme(s: &str) -> bool {
    let starts = |prefix: &str| {
        s.get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
    };
    starts("http://") || starts("https://")
}

/// `/\/v1$/i`.
fn ends_with_v1(s: &str) -> bool {
    s.len() >= 3
        && s.get(s.len() - 3..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case("/v1"))
}

/// `shouldAppendOpenAiPath`: a bare origin gets `/v1`; a path, or a URL
/// that does not parse, is left alone.
pub fn should_append_openai_path(base_url: &str) -> bool {
    if ends_with_v1(base_url) {
        return false;
    }
    url::Url::parse(base_url).is_ok_and(|u| u.path() == "/" || u.path().is_empty())
}

/// `normalizeBaseUrl`: trimmed, given a scheme when it has none (plain
/// http for a custom endpoint), trailing slashes dropped, and `/v1`
/// appended to a bare OpenAI-compatible origin.
pub fn normalize_base_url(value: &str, provider: &str) -> String {
    let trimmed = js_trim(value);
    if trimmed.is_empty() {
        return String::new();
    }
    let with_protocol = if has_http_scheme(trimmed) {
        trimmed.to_string()
    } else {
        let scheme = if provider == "custom" {
            "http"
        } else {
            "https"
        };
        format!("{scheme}://{trimmed}")
    };
    let mut normalized = with_protocol.trim_end_matches('/').to_string();
    if (provider == "custom" || provider == "openai") && should_append_openai_path(&normalized) {
        normalized.push_str("/v1");
    }
    normalized
}

/// `anthropicApiRoot`: one trailing `/v1` (or `/v1/`) removed, then any
/// trailing slashes.
pub fn anthropic_api_root(base_url: &str) -> String {
    let without_version = [4, 3]
        .into_iter()
        .find_map(|n| {
            let cut = base_url.len().checked_sub(n)?;
            let tail = base_url.get(cut..)?;
            (tail.eq_ignore_ascii_case("/v1/") || tail.eq_ignore_ascii_case("/v1"))
                .then(|| &base_url[..cut])
        })
        .unwrap_or(base_url);
    without_version.trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls_follow_node() {
        assert_eq!(
            normalize_base_url("  localhost:11434///  ", "custom"),
            "http://localhost:11434/v1"
        );
        assert_eq!(
            normalize_base_url("https://llm.example.net/openai/V1", "custom"),
            "https://llm.example.net/openai/V1"
        );
        assert_eq!(
            normalize_base_url("api.openai.com", "openai"),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            normalize_base_url("https://api.anthropic.com/v1/", "anthropic"),
            "https://api.anthropic.com/v1"
        );
        assert_eq!(
            anthropic_api_root("https://api.anthropic.com/v1"),
            "https://api.anthropic.com"
        );
        assert_eq!(
            anthropic_api_root("https://proxy.test/V1/"),
            "https://proxy.test"
        );
        assert_eq!(
            anthropic_api_root("https://proxy.test//"),
            "https://proxy.test"
        );
    }

    #[test]
    fn timeouts_clamp_and_fall_back() {
        let direct = TimeoutPhase::Direct;
        assert_eq!(
            resolve_ai_timeout_ms("", "openai", "gpt-4.1", direct),
            90_000
        );
        assert_eq!(
            resolve_ai_timeout_ms("5000", "openai", "gpt-4.1", direct),
            10_000
        );
        assert_eq!(
            resolve_ai_timeout_ms("soon", "custom", "x", direct),
            180_000
        );
        assert_eq!(
            resolve_ai_timeout_ms("  ", "openai", "gpt-4.1", direct),
            10_000
        );
        assert_eq!(
            resolve_ai_timeout_ms("1e9", "openai", "gpt-4.1", TimeoutPhase::Merge),
            900_000
        );
        assert_eq!(
            resolve_ai_timeout_ms("12345.9", "openai", "gpt-4.1", direct),
            12_345
        );
        assert_eq!(
            default_ai_timeout_ms("anthropic", "mistral-large", TimeoutPhase::Merge),
            360_000
        );
    }
}

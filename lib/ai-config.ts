export const AI_PROVIDERS = ['disabled', 'openai', 'anthropic', 'custom'] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

/**
 * Provider/model option entries carry both an English `label` / `desc`
 * fallback (kept for back-compat with surfaces that compose plain-text
 * strings server-side, like activity logs) and a `descKey` slot so the
 * settings UI can resolve a localised description via
 * `useTranslations('ai_options.<descKey>')`.
 *
 * Brand names ("OpenAI", "Anthropic", "GPT-4o") stay in English in every
 * locale — they're proper nouns. Only the descriptive sentence varies
 * by locale. The "Disabled" provider label gets a localised fallback
 * via `provider_disabled_label` because it's a generic word, not a
 * brand.
 */
export const AI_PROVIDER_OPTIONS: { value: AIProvider; label: string; labelKey?: string; desc: string; descKey: string }[] = [
  { value: 'disabled', label: 'Disabled', labelKey: 'provider_disabled_label', desc: 'Do not generate AI privacy-policy summaries', descKey: 'provider_disabled_desc' },
  { value: 'openai', label: 'OpenAI', desc: 'Use OpenAI hosted models', descKey: 'provider_openai_desc' },
  { value: 'anthropic', label: 'Anthropic', desc: 'Use Claude models through Anthropic', descKey: 'provider_anthropic_desc' },
  { value: 'custom', label: 'Own Model', labelKey: 'provider_custom_label', desc: 'Use Ollama or any OpenAI-compatible endpoint', descKey: 'provider_custom_desc' },
];

export const OPENAI_MODEL_OPTIONS = [
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', desc: 'Fast and cost-efficient', descKey: 'openai_gpt_4_1_mini_desc' },
  { value: 'gpt-4.1', label: 'GPT-4.1', desc: 'Stronger reasoning and extraction', descKey: 'openai_gpt_4_1_desc' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini', desc: 'Low-cost general model', descKey: 'openai_gpt_4o_mini_desc' },
  { value: 'gpt-4o', label: 'GPT-4o', desc: 'High-quality multimodal model', descKey: 'openai_gpt_4o_desc' },
] as const;

export const ANTHROPIC_MODEL_OPTIONS = [
  { value: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku', desc: 'Fast and lightweight', descKey: 'anthropic_haiku_desc' },
  { value: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet', desc: 'Balanced quality and speed', descKey: 'anthropic_sonnet_3_7_desc' },
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', desc: 'High-quality extraction', descKey: 'anthropic_sonnet_4_desc' },
  { value: 'claude-opus-4-20250514', label: 'Claude Opus 4', desc: 'Strongest Anthropic model', descKey: 'anthropic_opus_4_desc' },
] as const;

export const CUSTOM_MODEL_OPTIONS = [
  { value: 'llama3.2', label: 'llama3.2', desc: 'Good small local default', descKey: 'custom_llama_3_2_desc' },
  { value: 'qwen2.5:7b', label: 'qwen2.5:7b', desc: 'Strong local text model', descKey: 'custom_qwen_2_5_desc' },
  { value: 'mistral', label: 'mistral', desc: 'Lightweight local model', descKey: 'custom_mistral_desc' },
  { value: 'phi4-mini', label: 'phi4-mini', desc: 'Compact local reasoning model', descKey: 'custom_phi4_desc' },
  { value: 'gpt-oss:20b', label: 'gpt-oss:20b', desc: 'Open-weight option if exposed locally', descKey: 'custom_gpt_oss_desc' },
] as const;

export function normalizeAiProvider(value: unknown): AIProvider {
  if (value === 'ollama') return 'custom';
  return AI_PROVIDERS.find(provider => provider === value) ?? 'disabled';
}

export function getAiModelOptions(provider: AIProvider) {
  if (provider === 'openai') return OPENAI_MODEL_OPTIONS;
  if (provider === 'anthropic') return ANTHROPIC_MODEL_OPTIONS;
  if (provider === 'custom') return CUSTOM_MODEL_OPTIONS;
  return [];
}

export function resolveDefaultBaseUrl(provider: AIProvider): string {
  if (provider === 'openai') return 'https://api.openai.com/v1';
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (provider === 'custom') return 'http://127.0.0.1:11434';
  return '';
}

export function resolveDefaultModel(provider: AIProvider): string {
  if (provider === 'openai') return 'gpt-4.1-mini';
  if (provider === 'anthropic') return 'claude-3-5-haiku-latest';
  // gemma3n:e4b = Google's Gemma 3n at "Effective 4B" params (~4.4 GB).
  // Small enough for common laptop GPUs, strong enough to hold up through the
  // chunk-merge step that emits the full lens schema.
  if (provider === 'custom') return 'gemma3n:e4b';
  return '';
}

export function providerRequiresApiKey(provider: AIProvider): boolean {
  return provider === 'openai' || provider === 'anthropic';
}

export function providerSupportsApiKey(provider: AIProvider): boolean {
  return provider !== 'disabled';
}

export function providerUsesChatCompletions(provider: Exclude<AIProvider, 'disabled'>): boolean {
  return provider === 'openai' || provider === 'custom';
}

export function providerLikelyNeedsChunking(provider: Exclude<AIProvider, 'disabled'>, model: string): boolean {
  if (provider === 'custom') return true;

  const lowered = model.toLowerCase();
  return /llama|mistral|qwen|phi|gemma|mixtral/.test(lowered);
}

// ── Per-phase AI request timeouts ────────────────────────────────────────
// The original implementation hardcoded 90s for every AI call. In practice
// the chunk-merge call is both larger (all chunk notes concatenated) and
// heavier (it must emit the full final-summary schema with 8 lenses), so it
// was the one consistently blowing past 90s on local models. We now expose
// three knobs so power users on slow local hardware can raise the merge
// budget without affecting the faster phases.
export type AiTimeoutPhase = 'direct' | 'chunk' | 'merge';

export const AI_TIMEOUT_PHASES: AiTimeoutPhase[] = ['direct', 'chunk', 'merge'];

export const AI_TIMEOUT_SETTING_KEYS: Record<AiTimeoutPhase, string> = {
  direct: 'ai_timeout_direct_ms',
  chunk: 'ai_timeout_chunk_ms',
  merge: 'ai_timeout_merge_ms',
};

// Bounds are deliberately generous so operators can tune for very slow CPU
// inference setups without having to patch the code, while still blocking
// nonsense values (negative / infinite / wall-clock-hostile timeouts).
export const AI_TIMEOUT_MIN_MS = 10_000;        // 10s
export const AI_TIMEOUT_MAX_MS = 15 * 60_000;   // 15 min

/**
 * Default per-phase timeout. Hosted providers (OpenAI/Anthropic) are
 * typically sub-10s per call, so 90s is plenty and we keep the legacy
 * behaviour. Local/chunkable models need materially more headroom — and
 * the merge specifically needs ~2× a chunk since it emits more tokens.
 */
export function defaultAiTimeoutMs(
  provider: Exclude<AIProvider, 'disabled'>,
  model: string,
  phase: AiTimeoutPhase,
): number {
  const slow = providerLikelyNeedsChunking(provider, model);
  if (!slow) {
    // Hosted-provider defaults. Match legacy behaviour for direct/chunk;
    // bump merge a little because even GPT-4.1 occasionally takes 60s+
    // generating all 8 lenses under strict schema mode.
    if (phase === 'merge') return 120_000;
    return 90_000;
  }

  // Local / chunkable defaults.
  if (phase === 'merge') return 6 * 60_000; // 6 min
  return 3 * 60_000;                         // 3 min
}

/**
 * Parse a stored setting string into a clamped ms value, or return the
 * appropriate default when the setting is missing / unparseable / out of
 * bounds. Keeps the call sites at the AI-call layer a single line.
 */
export function resolveAiTimeoutMs(
  rawSetting: string | null | undefined,
  provider: Exclude<AIProvider, 'disabled'>,
  model: string,
  phase: AiTimeoutPhase,
): number {
  const fallback = defaultAiTimeoutMs(provider, model, phase);
  if (!rawSetting) return fallback;

  const parsed = Number(rawSetting);
  if (!Number.isFinite(parsed)) return fallback;

  const clamped = Math.min(AI_TIMEOUT_MAX_MS, Math.max(AI_TIMEOUT_MIN_MS, Math.floor(parsed)));
  return clamped;
}

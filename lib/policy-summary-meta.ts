export const POLICY_LENSES = [
  { key: "collection_scope", label: "Collection Scope" },
  { key: "product_use", label: "Product Use" },
  { key: "ads_marketing", label: "Ads & Marketing" },
  { key: "third_party_sharing", label: "Third-Party Sharing" },
  { key: "tracking_analytics", label: "Tracking & Analytics" },
  { key: "user_controls", label: "User Controls" },
  { key: "data_retention", label: "Data Retention" },
  { key: "children_minors", label: "Children & Minors" },
] as const;

export type PolicyLensKey = (typeof POLICY_LENSES)[number]["key"];

export const POLICY_RATINGS = [
  "favorable",
  "mixed",
  "concerning",
  "unclear",
] as const;
export type PolicyRating = (typeof POLICY_RATINGS)[number];

export const POLICY_ANALYSIS_STATUSES = [
  "ready",
  "source_ready",
  "needs_ai_config",
  "fetch_error",
  "unsupported_content_type",
  "too_short",
  "analysis_error",
] as const;

export type PolicyAnalysisStatus = (typeof POLICY_ANALYSIS_STATUSES)[number];

export const POLICY_SOURCE_ORIGINS = [
  "direct",
  "browser_retry",
  "wayback",
] as const;
export type PolicySourceOrigin = (typeof POLICY_SOURCE_ORIGINS)[number];

export const POLICY_SOURCE_ORIGIN_META: Record<
  PolicySourceOrigin,
  { label: string; hint: string }
> = {
  direct: {
    label: "Direct fetch",
    hint: "Fetched straight from the developer\u2019s privacy-policy link.",
  },
  browser_retry: {
    label: "Retried as browser",
    hint: "The first fetch was blocked, so we retried with a desktop-browser header bundle.",
  },
  wayback: {
    label: "From Wayback Machine",
    hint: "The live policy page blocked us, so this summary uses the most recent archived copy.",
  },
};

export interface PolicyLensSummary {
  key: PolicyLensKey;
  rating: PolicyRating;
  summary: string;
}

export interface ExternalPolicyReference {
  label: string;
  scoreLabel?: string;
  source: "privacyspy" | "tosdr";
  summary: string;
  url: string;
}

/**
 * Guardian-tuned safety summary: 1-paragraph (~120–220 words) plus 3–5
 * bullet concerns specific to minors. Optional on the schema because
 * pre-feature summaries don't have it and only `audience === 'guardian'`
 * runs request it. See https://privacytracker-docs.privacykey.org/develop/feature-flags
 */
export interface PolicySummarySafety {
  /** 3-5 specific concerns. May be empty if the model couldn't extract any. */
  concerns: string[];
  /** Plain-English paragraph describing the policy's impact on minors. */
  paragraph: string;
}

export interface PolicySummary {
  externalReferences?: ExternalPolicyReference[];
  highlights: string[];
  lenses: PolicyLensSummary[];
  overview: string;
  /** Guardian-only safety summary; absent for other audiences. */
  safetySummary?: PolicySummarySafety;
}

/**
 * Per-chunk intermediate output from the chunked summarise path. Persisted
 * after each chunk so a failed merge can be retried without re-doing chunks.
 */
export interface PolicyChunkNote {
  highlights: string[];
  summary: string;
}

/** Single entry in the phase-by-phase log captured during a regenerate run. */
export interface PolicyRunPhase {
  /** Epoch ms timestamp when this phase *started*. */
  at: number;
  /** Populated if this phase ended in an error. */
  error?: string;
  /** Duration of this phase in ms. */
  ms?: number;
  /** Human-readable one-liner describing what this phase did. */
  note?: string;
  phase: string;
}

export interface AppPolicyAnalysis {
  analysisMode?: "direct" | "chunked";
  /** Internet Archive snapshot URL for the current stored source text.
   *  Undefined when no archive has been captured yet. */
  archiveUrl?: string;
  /** Per-chunk notes from the most recent chunked summarise. Present only
   *  when `analysisMode === 'chunked'` and the stored notes match the
   *  current `content_hash`. */
  chunkNotes?: PolicyChunkNote[];
  error?: string;
  /** Phases from the most recent regenerate run (fetch/summary), newest last. */
  lastRunLog?: PolicyRunPhase[];
  model?: string;
  /** The previous summary, populated when a regenerate replaced an older
   *  one — lets the UI diff ratings/highlights. */
  previousSummary?: PolicySummary | null;
  previousSummaryAt?: number;
  /** Epoch ms of the moment the in-flight run kicked off. */
  runStartedAt?: number;
  /** Live-run state. `'running'` means a regenerate is executing
   *  server-side; pair with `runStartedAt` for elapsed-time display. */
  runStatus?: "idle" | "running";
  /** Epoch ms when the source was most recently fetched (vs. summarised). */
  sourceFetchedAt?: number;
  sourceFinalUrl?: string;
  /** Total length of the stored source text in chars. */
  sourceLength?: number;
  sourceOrigin?: PolicySourceOrigin;
  /** First ~6000 chars of the most recently fetched source text. */
  sourcePreview?: string;
  sourceTitle?: string;
  sourceWordCount: number;
  status: PolicyAnalysisStatus;
  summary?: PolicySummary | null;
  updatedAt: number;
}

export const POLICY_RATING_META: Record<
  PolicyRating,
  { label: string; cls: string }
> = {
  favorable: { label: "Favorable", cls: "policy-rating-favorable" },
  mixed: { label: "Mixed", cls: "policy-rating-mixed" },
  concerning: { label: "Concerning", cls: "policy-rating-concerning" },
  unclear: { label: "Unclear", cls: "policy-rating-unclear" },
};

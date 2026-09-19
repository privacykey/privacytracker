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

/**
 * Whether the summarise phase will summarise an analysis from the text
 * stored on it: a clean capture whose summary is owed, or, on a forced
 * run (every run the AI Policy tab starts is one), a capture already
 * summarised. A summary is owed, forced or not, to a capture waiting for
 * one ('source_ready') and to one whose last summary run found no AI
 * provider ('needs_ai_config') or failed ('analysis_error'). A failed run
 * keeps the summary it was replacing, so an 'analysis_error' capture may
 * carry one, but its status still records a run that made no summary, and
 * declining it would log that failure again for a run that made no call.
 * Only the summarise phase writes those two, over a capture this rule
 * accepted, and any later fetch replaces them, so their text is still the
 * latest clean capture. `summariseStoredPolicy` declines everything else
 * and returns the analysis unchanged, and the tab's Summarise button reads
 * this too, so it is never offered for a run the server will decline.
 * After a failed or unusable fetch the stored text is an earlier capture,
 * not the current policy, and an audit-bundle import holds only an excerpt
 * of it.
 */
export function canSummariseStoredPolicy(analysis: {
  force: boolean;
  hasSourceText: boolean;
  model: string | null | undefined;
  status: string | null | undefined;
}): boolean {
  return (
    analysis.model !== "imported" &&
    analysis.hasSourceText &&
    (analysis.status === "source_ready" ||
      analysis.status === "needs_ai_config" ||
      analysis.status === "analysis_error" ||
      (analysis.force && analysis.status === "ready"))
  );
}

/**
 * How the AI Policy tab's task tray reports a finished run, read from the
 * status of the analysis the run returned (keys under
 * `app_detail.policy_run`). A run that summarises ('summarise', or 'all'
 * after its fetch) returns an analysis whether or not it made a summary: a
 * failed AI call, a missing AI provider, a failed fetch and a declined run
 * all return one. Only 'ready' means the summary was updated. A fetch-only
 * run returns one too: 'ready' (the text is unchanged) or 'source_ready'
 * (new text) when the page landed, 'fetch_error' when it did not, and
 * 'too_short' or 'unsupported_content_type' when it landed but its text
 * cannot be used.
 */
export function describePolicyRunCompletion(
  phase: "fetch" | "summarise" | "all",
  status: string | null | undefined
): {
  messageKey:
    | "completion_fetch"
    | "completion_fetch_failed"
    | "completion_fetch_unusable"
    | "completion_summarise"
    | "completion_summary_failed"
    | "completion_summary_not_updated";
  status: "done" | "error";
} {
  if (phase === "fetch") {
    if (status === "ready" || status === "source_ready") {
      return { status: "done", messageKey: "completion_fetch" };
    }
    if (status === "too_short" || status === "unsupported_content_type") {
      return { status: "error", messageKey: "completion_fetch_unusable" };
    }
    return { status: "error", messageKey: "completion_fetch_failed" };
  }
  if (status === "ready") {
    return { status: "done", messageKey: "completion_summarise" };
  }
  if (status === "analysis_error") {
    return { status: "error", messageKey: "completion_summary_failed" };
  }
  return { status: "error", messageKey: "completion_summary_not_updated" };
}

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
 * runs request it. See https://docs.privacytracker.privacykey.org/develop/feature-flags
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

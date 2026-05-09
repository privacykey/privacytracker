/**
 * AI prompts — versioned templates for AI-generated artefacts. Each prompt
 * is `{ version, template }`; bump `version` when revising the template.
 * AI-generated records store the `prompt_version` they were produced with
 * so older summaries can be re-run against newer prompts.
 */

// ============================================================================
// Standard policy summary — generic, audience-neutral
// ============================================================================

export const POLICY_SUMMARY_PROMPT = {
  version: 1,
  template: `You are summarising the privacy policy of an iOS app for a privacy-conscious user.

Read the policy text below and produce:

1. A concise summary in 2-3 sentences (~60 words).
2. A list of "highlights" — 3-5 short bullet points covering the most important practices (data collection, sharing, retention, user rights).
3. Per-lens ratings on these dimensions, each rated as one of: concerning, mixed, unclear, favorable.
   - collection_scope: how much data is collected
   - ads_marketing: data used for ads or marketing
   - third_party_sharing: data shared with other companies
   - retention: how long data is kept
   - user_rights: deletion, access, opt-out
   - security_posture: encryption, breach handling

Output as JSON.

Policy text:
{policy_text}`,
};

// ============================================================================
// Safety summary — guardian audience
// ============================================================================
// Triggered when audience.guardian is set; renders ABOVE the standard lens
// grid. Evaluates the policy from a "is this safe for a child or dependant?"
// angle in plain English.

export const SAFETY_SUMMARY_PROMPT = {
  version: 1,
  template: `You are evaluating the privacy policy of an iOS app for a parent or carer who is deciding whether the app is appropriate for a child or dependant under their care.

Produce two things:

1. A 1-paragraph plain-English summary (around 60 words) answering: "is this app's privacy practices appropriate for a child or dependant?" Use direct, non-technical language. No jargon, no legalese. Speak as if explaining to a thoughtful but non-technical parent. Avoid hedging that obscures the answer ("it depends" / "this is complex" — pick a clear stance).

2. A list of 3-5 specific concerns or reassurances, each one bullet point. Focus on practices that materially affect a child:
   - Whether the app shares data with third parties or advertisers
   - Whether tracking happens that could follow them across other apps
   - Whether data sales or behavioural-profiling are mentioned
   - Whether the policy specifically addresses children or has age gates
   - Whether basic security practices (encryption, breach notification) are described
   - Whether contact / location / health data is collected

Output as JSON with keys "paragraph" (string) and "concerns" (array of strings).

Avoid:
- Diagnostic / debug data unless it's clearly aggressive
- Vague risks ("data could potentially be used for...") without concrete grounding
- More than 5 concerns (parents need decisive guidance, not a wall of text)

Policy text:
{policy_text}`,
};

// ============================================================================
// Sample-data pre-baked summaries
// ============================================================================
// Hand-written summaries for the sample apps so demo mode doesn't need a
// configured AI provider.

export const SAMPLE_DATA_SUMMARIES: Record<string, {
  summary: string;
  highlights: string[];
  lenses: Record<string, 'concerning' | 'mixed' | 'unclear' | 'favorable'>;
  prompt_version: number;
}> = {};

// ============================================================================
// Helpers
// ============================================================================

/** Returns the prompt text with `{policy_text}` interpolated. */
export function buildPolicyPrompt(policyText: string): string {
  return POLICY_SUMMARY_PROMPT.template.replace('{policy_text}', policyText);
}

export function buildSafetyPrompt(policyText: string): string {
  return SAFETY_SUMMARY_PROMPT.template.replace('{policy_text}', policyText);
}

/** Returns the current prompt version for the named template. */
export function getPromptVersion(name: 'policy_summary' | 'safety_summary'): number {
  switch (name) {
    case 'policy_summary': return POLICY_SUMMARY_PROMPT.version;
    case 'safety_summary': return SAFETY_SUMMARY_PROMPT.version;
  }
}

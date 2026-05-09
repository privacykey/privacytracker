import type { ExternalPolicyReference } from './policy-summary-meta';

/**
 * External-policy-reference lookup (PrivacySpy/ToS;DR match-by-name) has
 * been disabled. The previous implementation was too noisy — the
 * short-token normaliser (e.g. "T-Mobile" → "t") produced false positives
 * such as `myID → T-Mobile`, so unrelated registry entries could win above
 * the 50-point substring threshold.
 *
 * The always-visible "Cross-check with community registries" block in
 * AppDetailView's `PolicyFallbackReferences` still deep-links the user
 * into PrivacySpy and ToS;DR search pages, which is a safer UX than an
 * auto-matched card that might be wrong.
 *
 * The exported shape is preserved so nothing needs to be re-wired if/when
 * the match logic gets a proper rewrite (likely requiring exact-name or
 * hostname match, with substring hits demoted to tie-breakers only).
 */
export async function lookupExternalPolicyReferences(input: {
  appName: string;
  developer?: string;
  policyUrl?: string;
}): Promise<ExternalPolicyReference[]> {
  void input;
  return [];
}

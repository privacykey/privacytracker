/**
 * Guardian safety-summary helper. The safety_summary is a guardian-tuned
 * policy summary that answers "is this app's privacy practices appropriate
 * for a child or dependant?" in plain English plus a list of specific
 * concerns. This file builds the rendered prompt and resolves the gate
 * (`flag.detail.policy.safety_summary`) that decides whether to render it.
 */

import { buildSafetyPrompt, getPromptVersion } from './ai-prompts';
import { resolveFlagFromDb } from './feature-flags-server';

export interface SafetySummary {
  paragraph: string;
  concerns: string[];
  promptVersion: number;
}

/**
 * True iff the safety summary should render for the current focus.
 * Server-side only — relies on the resolver context.
 */
export function shouldShowSafetySummary(): boolean {
  try {
    return resolveFlagFromDb('flag.detail.policy.safety_summary') === 'on';
  } catch (e) {
    console.warn('[safety-summary] resolver failed:', e);
    return false;
  }
}

/**
 * Build the safety-summary prompt for a given policy text. Returned as a
 * string ready to send to the configured AI provider. The caller is
 * responsible for the API call + JSON parsing.
 */
export function buildSafetySummaryPrompt(policyText: string): string {
  return buildSafetyPrompt(policyText);
}

/**
 * Parse a raw AI response into a structured SafetySummary. Tolerates
 * minor formatting variation — falls back to an empty result if the
 * shape doesn't match. The prompt asks for `{paragraph, concerns}`.
 */
export function parseSafetySummary(raw: string): SafetySummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const paragraph = typeof obj.paragraph === 'string' ? obj.paragraph.trim() : '';
  const concerns = Array.isArray(obj.concerns)
    ? obj.concerns.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter(Boolean).slice(0, 5)
    : [];

  if (!paragraph && concerns.length === 0) return null;

  return {
    paragraph,
    concerns,
    promptVersion: getPromptVersion('safety_summary'),
  };
}

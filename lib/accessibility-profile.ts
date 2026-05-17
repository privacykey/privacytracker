/**
 * Client-safe accessibility-profile module — types, constants, and pure
 * comparison helpers only. Mirrors `lib/privacy-profile.ts` structurally so
 * Settings / onboarding / Compare can lean on the same mental model:
 *
 *   Privacy profile   → "don't exceed this tier for this category"
 *   Accessibility profile → "this feature is required / nice-to-have"
 *
 * Missing keys mean "no preference" (the feature is ignored entirely when
 * computing mismatches). Server-side helpers live in
 * `lib/accessibility-profile-server.ts`.
 */

import { CANONICAL_ACCESSIBILITY_FEATURES } from "./accessibility-types";

// ─────────────────────────────────────────────────────────────────────────────
// Preference tier. "required" is strict — an app missing a required feature
// counts as a full mismatch. "nice" is a softer signal — missing nice-to-have
// features still counts, but at a lower severity so the picker can distinguish
// "I won't use an app without captions" from "I'd prefer audio descriptions
// but won't disqualify an app for lacking them".
// ─────────────────────────────────────────────────────────────────────────────

export const A11Y_PREFERENCES = ["required", "nice"] as const;
export type AccessibilityPreference = (typeof A11Y_PREFERENCES)[number];

/** Severity points used when ranking "worst offenders". */
export const A11Y_PREFERENCE_WEIGHT: Record<AccessibilityPreference, number> = {
  required: 2,
  nice: 1,
};

export interface A11yPreferenceMeta {
  description: string;
  icon: string;
  label: string;
  /** Severity class (for CSS) reused to colour the selected pill in the editor. */
  severityCls: string;
  shortLabel: string;
  value: AccessibilityPreference;
}

export const A11Y_PREFERENCE_META: Record<
  AccessibilityPreference,
  A11yPreferenceMeta
> = {
  required: {
    value: "required",
    label: "Required",
    shortLabel: "Required",
    description: "I won't use an app that doesn't declare this feature.",
    severityCls: "severity-track", // strong red — mismatch is a hard fail
    icon: "⭐",
  },
  nice: {
    value: "nice",
    label: "Nice to have",
    shortLabel: "Nice",
    description:
      "I'd prefer apps that declare this, but it's not a deal-breaker.",
    severityCls: "severity-linked", // soft orange — mismatch is a hint
    icon: "✨",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Profile shape — sparse by design. Keys the user hasn't set are treated as
// "no preference" and excluded from any mismatch comparison. All feature keys
// come from CANONICAL_ACCESSIBILITY_FEATURES.
// ─────────────────────────────────────────────────────────────────────────────

export type AccessibilityProfile = Partial<
  Record<string, AccessibilityPreference>
>;

/** Canonical feature identifiers, in the order Apple lists them. */
export const A11Y_PROFILE_FEATURE_KEYS: string[] =
  CANONICAL_ACCESSIBILITY_FEATURES.map((f) => f.identifier);

/**
 * Opinionated default profile that gives a sensible starting point when a
 * user opts in. Features that meaningfully affect one of the big four
 * accessibility needs (vision, hearing, motor, cognitive) default to
 * "required"; the rest default to "nice". Users can override any feature.
 */
export const DEFAULT_A11Y_PROFILE: AccessibilityProfile = {
  voiceover: "required",
  larger_text: "required",
  sufficient_contrast: "required",
  captions: "required",
  voice_control: "nice",
  dark_interface: "nice",
  differentiate_without_color_alone: "nice",
  reduced_motion: "nice",
  audio_descriptions: "nice",
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure comparison helpers.
// ─────────────────────────────────────────────────────────────────────────────

export interface AccessibilityFootprint {
  /** Feature identifiers the app declares. */
  declared: Set<string>;
}

export interface A11yMismatch {
  /** Feature identifier, e.g. "voiceover". */
  feature: string;
  /** What the user marked it as. */
  preference: AccessibilityPreference;
}

export interface A11yMismatchResult {
  /** Count of missing features (shortcut for list views). */
  count: number;
  /** Every preferred feature the app doesn't declare. Sorted required-first. */
  missing: A11yMismatch[];
  /** Count of required features the app is missing (convenience for badge copy). */
  missingRequired: number;
  /** `true` when the profile has at least one preference set. */
  profileActive: boolean;
  /** Sum of preference weights across missing features — ranking key for "worst offenders". */
  totalGap: number;
}

export function computeA11yMismatch(
  profile: AccessibilityProfile | null | undefined,
  footprint: AccessibilityFootprint
): A11yMismatchResult {
  if (!profile) {
    return {
      missing: [],
      count: 0,
      totalGap: 0,
      profileActive: false,
      missingRequired: 0,
    };
  }
  const preferences = Object.entries(profile).filter(
    (entry): entry is [string, AccessibilityPreference] =>
      typeof entry[1] === "string"
  );
  if (preferences.length === 0) {
    return {
      missing: [],
      count: 0,
      totalGap: 0,
      profileActive: false,
      missingRequired: 0,
    };
  }

  const missing: A11yMismatch[] = [];
  let totalGap = 0;
  let missingRequired = 0;

  for (const [feature, preference] of preferences) {
    if (footprint.declared.has(feature)) {
      continue;
    }
    missing.push({ feature, preference });
    totalGap += A11Y_PREFERENCE_WEIGHT[preference];
    if (preference === "required") {
      missingRequired += 1;
    }
  }

  // Sort required-first, then alphabetical for stability.
  missing.sort((a, b) => {
    const weightDelta =
      A11Y_PREFERENCE_WEIGHT[b.preference] -
      A11Y_PREFERENCE_WEIGHT[a.preference];
    if (weightDelta !== 0) {
      return weightDelta;
    }
    return a.feature.localeCompare(b.feature);
  });

  return {
    missing,
    count: missing.length,
    totalGap,
    profileActive: true,
    missingRequired,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Badge summary — reduces a mismatch result to the compact shape needed for
// grid / card surfaces. Mirrors `AppProfileBadge` from privacy-profile.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type A11yBadgeTone = "ok" | "warn" | "bad";

/**
 * Discriminator for client-side localisation. Mirrors the privacy-profile
 * badge `kind` field. The bell / app card / shortlist row consumes this
 * to pick the right `a11y_badge.<key>` translation rather than rendering
 * the English fallbacks below.
 *   - `no_profile`     — accessibility profile flag is off / unset
 *   - `match`          — profile on, every required + nice feature declared
 *   - `missing_required` — at least one required feature is undeclared;
 *     `missingRequired` carries the count
 *   - `missing_nice`   — only nice-to-have features missing; `count` is
 *     the total
 */
export type A11yBadgeKind =
  | "no_profile"
  | "match"
  | "missing_required"
  | "missing_nice";

export interface A11yProfileBadge {
  /** Missing features count. 0 = clean match. */
  count: number;
  /** English description fallback — same back-compat reasoning as privacy-profile. */
  description: string;
  /** Discriminator — see `A11yBadgeKind` doc above. */
  kind: A11yBadgeKind;
  /** English label fallback. Localised label is computed client-side from `kind` + `count`. */
  label: string;
  /** Number of *required* features missing (subset of `count`). */
  missingRequired: number;
  /** Tone class suffix, matches CSS variants used for the privacy badge. */
  tone: A11yBadgeTone;
  /** Total weighted gap (required = 2, nice = 1). */
  totalGap: number;
  /** Worst missing feature identifier — for deep links. */
  worstFeature: string | null;
}

export function summariseA11yBadge(
  result: A11yMismatchResult
): A11yProfileBadge {
  if (!result.profileActive) {
    return {
      count: 0,
      missingRequired: 0,
      totalGap: 0,
      tone: "ok",
      kind: "no_profile",
      label: "No a11y profile",
      description: "Set an accessibility profile to see how apps compare.",
      worstFeature: null,
    };
  }
  if (result.count === 0) {
    return {
      count: 0,
      missingRequired: 0,
      totalGap: 0,
      tone: "ok",
      kind: "match",
      label: "A11y match",
      description:
        "This app declares every accessibility feature you asked for.",
      worstFeature: null,
    };
  }

  // Tone mirrors the privacy badge ramp — "bad" kicks in once a required
  // feature is missing or the aggregate gap exceeds a couple of nice-to-haves.
  const tone: A11yBadgeTone =
    result.missingRequired > 0 || result.totalGap >= 4 ? "bad" : "warn";

  const worst = result.missing[0];
  const kind: A11yBadgeKind =
    result.missingRequired > 0 ? "missing_required" : "missing_nice";
  const label = `${result.count} missing`;
  const description =
    result.missingRequired > 0
      ? `${result.missingRequired} required feature${result.missingRequired === 1 ? "" : "s"} not declared.`
      : `${result.count} nice-to-have${result.count === 1 ? "" : "s"} not declared.`;

  return {
    count: result.count,
    missingRequired: result.missingRequired,
    totalGap: result.totalGap,
    tone,
    kind,
    label,
    description,
    worstFeature: worst?.feature ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers. Neither throws — they return an empty/null profile on
// unrecoverable shapes so the settings UI can fall back to "no profile saved".
// ─────────────────────────────────────────────────────────────────────────────

const PREFERENCE_SET: Set<string> = new Set(A11Y_PREFERENCES);
const FEATURE_KEY_SET: Set<string> = new Set(A11Y_PROFILE_FEATURE_KEYS);

export function parseStoredA11yProfile(
  raw: string | null | undefined
): AccessibilityProfile | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const out: AccessibilityProfile = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    if (!FEATURE_KEY_SET.has(key)) {
      continue;
    }
    if (typeof value !== "string" || !PREFERENCE_SET.has(value)) {
      continue;
    }
    out[key] = value as AccessibilityPreference;
  }
  return out;
}

export function sanitizeA11yProfile(input: unknown): AccessibilityProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const out: AccessibilityProfile = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!FEATURE_KEY_SET.has(key)) {
      continue;
    }
    if (typeof value !== "string" || !PREFERENCE_SET.has(value)) {
      continue;
    }
    out[key] = value as AccessibilityPreference;
  }
  return out;
}

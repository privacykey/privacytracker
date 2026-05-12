/**
 * Client-safe privacy-profile module — types, enums, labels, and pure helpers.
 * Do NOT import server-only modules here (db / scheduler / fs); browser
 * bundles import from this file. Server helpers live in `privacy-profile-server.ts`.
 *
 * Each user preference is the most invasive data-use tier they'll accept:
 *   "not_collected" < "not_linked" < "linked" < "tracking"
 * An app collecting strictly worse than that counts as a mismatch.
 * Categories without a preference are not compared.
 */
import { CATEGORY_META } from './privacy-meta';

// Data-use tiers, least invasive to most invasive — comparisons are index math.

export const PROFILE_TIERS = [
  'not_collected',
  'not_linked',
  'linked',
  'tracking',
] as const;

export type ProfileTier = (typeof PROFILE_TIERS)[number];

/** 0-indexed severity rank. Higher = more invasive. */
export const TIER_RANK: Record<ProfileTier, number> = {
  not_collected: 0,
  not_linked:    1,
  linked:        2,
  tracking:      3,
};

export interface TierMeta {
  value:       ProfileTier;
  label:       string;
  shortLabel:  string;
  description: string;
  severityCls: string; // reuse existing severity-* classes from globals.css
  icon:        string;
}

// All surfaces read the same four tier words to match Apple's category names:
// Not collected, Not linked, Linked, Tracking.
export const TIER_META: Record<ProfileTier, TierMeta> = {
  not_collected: {
    value:       'not_collected',
    label:       'Not collected',
    shortLabel:  'Not collected',
    description: 'The app cannot collect this category at all.',
    severityCls: 'severity-none',
    icon:        '🚫',
  },
  not_linked: {
    value:       'not_linked',
    label:       'Not linked',
    shortLabel:  'Not linked',
    description: 'OK if collected but not linked to your identity.',
    severityCls: 'severity-unlinked',
    icon:        '🔓',
  },
  linked: {
    value:       'linked',
    label:       'Linked',
    shortLabel:  'Linked',
    description: 'OK if linked to you, but not used for third-party tracking.',
    severityCls: 'severity-linked',
    icon:        '🔗',
  },
  tracking: {
    value:       'tracking',
    label:       'Tracking',
    shortLabel:  'Tracking',
    description: 'OK at any tier, including third-party tracking.',
    severityCls: 'severity-track',
    icon:        '👁',
  },
};

// Maps `privacy_types.identifier` to the corresponding tier.
// "not_collected" is implicit — the default when an app has no row.

export const TYPE_IDENTIFIER_TO_TIER: Record<string, ProfileTier> = {
  DATA_USED_TO_TRACK_YOU:  'tracking',
  DATA_LINKED_TO_YOU:      'linked',
  DATA_NOT_LINKED_TO_YOU:  'not_linked',
};

// Categories without a key are "no preference" and skipped during comparison.
// A sparse profile is valid.

export type PrivacyProfile = Partial<Record<string, ProfileTier>>;

/** All 14 App Store category keys, derived from CATEGORY_META. */
export const PROFILE_CATEGORY_KEYS: string[] = Object.keys(CATEGORY_META);

/** Opinionated balanced starting point; conservative on identity/health/location. */
export const DEFAULT_PROFILE: PrivacyProfile = {
  CONTACT_INFO:        'linked',
  HEALTH_AND_FITNESS:  'not_linked',
  FINANCIAL_INFO:      'linked',
  LOCATION:            'not_linked',
  SENSITIVE_INFO:      'not_collected',
  CONTACTS:            'not_linked',
  USER_CONTENT:        'linked',
  BROWSING_HISTORY:    'not_linked',
  SEARCH_HISTORY:      'not_linked',
  IDENTIFIERS:         'not_linked',
  PURCHASES:           'linked',
  USAGE_DATA:          'linked',
  DIAGNOSTICS:         'linked',
  OTHER:               'linked',
};

// Named presets — picked from the onboarding profile screen and from
// Settings → Privacy Profile. Each preset is COMPLETE (covers all 14
// categories) so applying one always produces a deterministic profile;
// matchPreset() can then round-trip the choice back to the active pill.
//
// The four presets walk the strictness axis from most → least restrictive:
//   strict:        most categories not_collected / not_linked
//   balanced:      mirrors DEFAULT_PROFILE (the historical default)
//   anti_tracking: every category 'linked' — only third-party tracking flags
//   permissive:    mostly 'tracking', but sensitive identity data pulled back

export const PROFILE_PRESET_KEYS = [
  'strict',
  'balanced',
  'anti_tracking',
  'permissive',
] as const;

export type ProfilePresetKey = (typeof PROFILE_PRESET_KEYS)[number];

export interface ProfilePresetMeta {
  key:         ProfilePresetKey;
  label:       string;
  shortLabel:  string;
  description: string;
  /** Single-character emoji shown inside the preset pill. */
  icon:        string;
  /**
   * Reused severity class for the active-pill accent colour. Walks the
   * existing palette: green → yellow → orange → red, mirroring the per-row
   * pill colours in the editor.
   */
  severityCls: string;
}

export const PROFILE_PRESET_META: Record<ProfilePresetKey, ProfilePresetMeta> = {
  strict: {
    key:         'strict',
    label:       'Strict',
    shortLabel:  'Strict',
    description: 'Restrict identity-linked data wherever possible. Many mainstream apps will mismatch.',
    icon:        '🛡️',
    severityCls: 'severity-none',
  },
  balanced: {
    key:         'balanced',
    label:       'Balanced',
    shortLabel:  'Balanced',
    description: 'A sensible default. Strict on health, sensitive, and contacts; lenient on usage and diagnostics.',
    icon:        '⚖️',
    severityCls: 'severity-unlinked',
  },
  anti_tracking: {
    key:         'anti_tracking',
    label:       'Anti-tracking only',
    shortLabel:  'Anti-tracking',
    description: "Only flag apps that share data with third-party trackers. Everything else is fine.",
    icon:        '🚫',
    severityCls: 'severity-linked',
  },
  permissive: {
    key:         'permissive',
    label:       'Permissive',
    shortLabel:  'Permissive',
    description: 'Accept almost anything, but still flag tracking on health, financial, location, and sensitive data.',
    icon:        '🌤️',
    severityCls: 'severity-track',
  },
};

/**
 * Build a complete profile by mapping every category to a single tier.
 * Used to generate the anti_tracking and permissive presets without
 * repeating the 14 category keys inline.
 */
function fillAllCategories(tier: ProfileTier): PrivacyProfile {
  const out: PrivacyProfile = {};
  for (const key of PROFILE_CATEGORY_KEYS) out[key] = tier;
  return out;
}

export const PROFILE_PRESETS: Record<ProfilePresetKey, PrivacyProfile> = {
  strict: {
    CONTACT_INFO:        'not_linked',
    HEALTH_AND_FITNESS:  'not_collected',
    FINANCIAL_INFO:      'not_linked',
    LOCATION:            'not_collected',
    SENSITIVE_INFO:      'not_collected',
    CONTACTS:            'not_collected',
    USER_CONTENT:        'not_linked',
    BROWSING_HISTORY:    'not_collected',
    SEARCH_HISTORY:      'not_linked',
    IDENTIFIERS:         'not_linked',
    PURCHASES:           'not_linked',
    USAGE_DATA:          'not_linked',
    DIAGNOSTICS:         'not_linked',
    OTHER:               'not_collected',
  },
  balanced: { ...DEFAULT_PROFILE },
  anti_tracking: fillAllCategories('linked'),
  permissive: {
    // Bulk of categories accept tracking; carve-outs for sensitive identity
    // data so the user is still warned about third-party sharing of health,
    // financial, location, and sensitive info.
    CONTACT_INFO:        'tracking',
    HEALTH_AND_FITNESS:  'linked',
    FINANCIAL_INFO:      'linked',
    LOCATION:            'linked',
    SENSITIVE_INFO:      'not_linked',
    CONTACTS:            'tracking',
    USER_CONTENT:        'tracking',
    BROWSING_HISTORY:    'tracking',
    SEARCH_HISTORY:      'tracking',
    IDENTIFIERS:         'tracking',
    PURCHASES:           'tracking',
    USAGE_DATA:          'tracking',
    DIAGNOSTICS:         'tracking',
    OTHER:               'tracking',
  },
};

/**
 * Describes a preset-boundary transition for the activity log. The
 * server records one of these (via `recordActivity`) whenever a save
 * crosses a preset boundary — picking a preset, switching presets, or
 * clearing a previously-set profile. Custom-to-custom edits (single-row
 * tweaks within a non-preset profile) intentionally don't surface here:
 * the activity log is for "noteworthy state transitions", not every
 * keystroke.
 */
export interface PresetTransitionDescription {
  /** Plain-text summary suitable for the activity feed row title. */
  summary: string;
  /** Structured payload stashed in the activity row's `detail` blob. */
  detail: {
    /** Preset key the profile matched BEFORE the save (null when none). */
    from: ProfilePresetKey | null;
    /** Preset key the profile matches AFTER the save (null when none). */
    to: ProfilePresetKey | null;
    /** Marks "previous profile had preferences, new one is empty/null". */
    cleared?: boolean;
  };
}

/**
 * Compare an old + new profile and return an activity-log-shaped
 * description when the change crosses a preset boundary. Returns null
 * for non-events (no profile before AND none after, or a custom edit
 * that stayed inside a non-preset state, or an idempotent re-save).
 *
 * Decision rules, in order:
 *   1. Old had preferences, new is empty → "Privacy profile cleared"
 *   2. New matches a preset, and that preset differs from the old's
 *      match (which may be null) → "Privacy profile changed to {Label}"
 *   3. Anything else → null
 */
export function describePresetTransition(
  oldProfile: PrivacyProfile | null | undefined,
  newProfile: PrivacyProfile | null | undefined,
): PresetTransitionDescription | null {
  const oldHasAny =
    !!oldProfile && Object.values(oldProfile).some(v => typeof v === 'string');
  const newHasAny =
    !!newProfile && Object.values(newProfile).some(v => typeof v === 'string');

  // Rule 1: clearing.
  if (oldHasAny && !newHasAny) {
    return {
      summary: 'Privacy profile cleared',
      detail: { from: matchPreset(oldProfile ?? null), to: null, cleared: true },
    };
  }

  // No-op cases: nothing-to-nothing, or new profile is empty (and old was too).
  if (!newHasAny) return null;

  const fromPreset = matchPreset(oldProfile ?? null);
  const toPreset = matchPreset(newProfile ?? null);

  // Rule 2: new state matches a preset that's different from the old.
  if (toPreset && toPreset !== fromPreset) {
    return {
      summary: `Privacy profile changed to ${PROFILE_PRESET_META[toPreset].label}`,
      detail: { from: fromPreset, to: toPreset },
    };
  }

  // Rule 3: custom edit inside a non-preset state, or re-save of the
  // same preset — nothing to log.
  return null;
}

/**
 * Returns the preset key whose tier mapping exactly matches `profile`,
 * or null if the profile is empty / sparse / customised. Used by the
 * editor to highlight the active preset pill — picking a preset and then
 * editing a single category drops the highlight, which is the right
 * affordance for "this is now custom".
 */
export function matchPreset(profile: PrivacyProfile | null | undefined): ProfilePresetKey | null {
  if (!profile) return null;
  // Bail early on empty / sparse profiles. A preset must cover all 14
  // categories, so a profile with fewer entries can never match.
  const profileKeys = Object.keys(profile).filter(k => typeof profile[k] === 'string');
  if (profileKeys.length !== PROFILE_CATEGORY_KEYS.length) return null;

  for (const presetKey of PROFILE_PRESET_KEYS) {
    const preset = PROFILE_PRESETS[presetKey];
    let allMatch = true;
    for (const cat of PROFILE_CATEGORY_KEYS) {
      if (profile[cat] !== preset[cat]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return presetKey;
  }
  return null;
}

// Pure comparison helpers — usable both client-side and server-side.

export interface AppProfileFootprint {
  /**
   * For each category the app collects, the WORST tier observed. Categories
   * the app does not collect should be omitted (implicit "not_collected").
   */
  worstByCategory: Partial<Record<string, Exclude<ProfileTier, 'not_collected'>>>;
}

export interface CategoryMismatch {
  /** Category key, e.g. "LOCATION". */
  category:     string;
  /** What the user said they'd tolerate. */
  allowed:      ProfileTier;
  /** What the app actually does at its worst. */
  observed:     Exclude<ProfileTier, 'not_collected'>;
  /** Rank delta (observed.rank - allowed.rank). Always ≥ 1 for a mismatch. */
  severityGap:  number;
}

export interface ProfileMismatchResult {
  /** All categories where `observed` is strictly worse than `allowed`. */
  mismatches:   CategoryMismatch[];
  /** Number of mismatched categories — convenience accessor. */
  count:        number;
  /** Sum of severityGap — simple ranking key for "worst offenders". */
  totalGap:     number;
  /** `true` when the profile has at least one explicit preference. */
  profileActive: boolean;
}

/**
 * Returns mismatches for categories where the user has set a preference and
 * the app's observed tier exceeds it. Unset categories and uncollected
 * categories contribute zero mismatches.
 */
export function computeProfileMismatch(
  profile: PrivacyProfile | null | undefined,
  footprint: AppProfileFootprint,
): ProfileMismatchResult {
  if (!profile) {
    return { mismatches: [], count: 0, totalGap: 0, profileActive: false };
  }
  const hasAnyPref = Object.values(profile).some(v => typeof v === 'string');
  if (!hasAnyPref) {
    return { mismatches: [], count: 0, totalGap: 0, profileActive: false };
  }

  const mismatches: CategoryMismatch[] = [];
  let totalGap = 0;

  for (const [category, observed] of Object.entries(footprint.worstByCategory)) {
    if (!observed) continue;
    const allowed = profile[category];
    if (!allowed) continue;
    const gap = TIER_RANK[observed] - TIER_RANK[allowed];
    if (gap >= 1) {
      mismatches.push({ category, allowed, observed, severityGap: gap });
      totalGap += gap;
    }
  }

  // Worst-first so callers can slice(0, N).
  mismatches.sort((a, b) => b.severityGap - a.severityGap || a.category.localeCompare(b.category));

  return { mismatches, count: mismatches.length, totalGap, profileActive: true };
}

/**
 * English sentence describing the worst-offending category, or null when
 * there are no mismatches. For localised UIs use describeWorstMismatchLocalised.
 * Retained for plain-text English call sites (notifications, audit bundles).
 */
export function describeWorstMismatch(result: ProfileMismatchResult): string | null {
  if (result.mismatches.length === 0) return null;
  const top = result.mismatches[0];
  const categoryLabel = CATEGORY_META[top.category]?.label ?? top.category;
  const observedShort = TIER_META[top.observed].shortLabel.toLowerCase();
  const allowedShort = TIER_META[top.allowed].shortLabel.toLowerCase();
  return `${categoryLabel}: ${observedShort} (you allow ${allowedShort} at most)`;
}

/**
 * Localised counterpart to describeWorstMismatch. Takes translator functions
 * for category labels, tier short words, and the surrounding sentence template
 * (with `{category}` / `{observed}` / `{allowed}` placeholders). Returns null
 * when there are no mismatches.
 */
export function describeWorstMismatchLocalised(
  result: ProfileMismatchResult,
  tCategory: (key: string) => string | undefined,
  tTier: (key: string) => string,
  tMismatch: (key: string, values?: Record<string, string | number>) => string,
): string | null {
  if (result.mismatches.length === 0) return null;
  const top = result.mismatches[0];
  // tCategory may return undefined for unknown keys; fall back to English.
  const categoryLabel =
    tCategory(top.category) ?? CATEGORY_META[top.category]?.label ?? top.category;
  const observedShort = tTier(top.observed);
  const allowedShort = tTier(top.allowed);
  return tMismatch('template', {
    category: categoryLabel,
    observed: observedShort.toLowerCase(),
    allowed: allowedShort.toLowerCase(),
  });
}

// Defensive parse for app_settings values. Never throws; returns null for
// unrecoverable shapes so callers fall back to "no profile set".

const TIER_SET: Set<string> = new Set(PROFILE_TIERS);

export function parseStoredProfile(raw: string | null | undefined): PrivacyProfile | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const out: PrivacyProfile = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORY_META, key)) continue;
    if (typeof value !== 'string' || !TIER_SET.has(value)) continue;
    out[key] = value as ProfileTier;
  }
  return out;
}

/** Keep only known categories + valid tier strings; drop the rest. */
export function sanitizeProfile(input: unknown): PrivacyProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: PrivacyProfile = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORY_META, key)) continue;
    if (typeof value !== 'string' || !TIER_SET.has(value)) continue;
    out[key] = value as ProfileTier;
  }
  return out;
}

// Cross-surface summary types — client-safe (no db / fs imports).

export interface AppMismatchSummary {
  appId:          string;
  appName:        string;
  iconUrl?:       string;
  developer?:     string;
  mismatch:       ProfileMismatchResult;
}

// Compact per-app badge data — what the grid card chip needs to render.

export type BadgeTone = 'ok' | 'warn' | 'bad';

/**
 * Discriminator for client-side localisation:
 *   - `no_profile` — no preferences set; neutral tone
 *   - `match`     — every collected category is within tolerance
 *   - `mismatches` — at least one category exceeds tolerance
 */
export type BadgeKind = 'no_profile' | 'match' | 'mismatches';

export interface AppProfileBadge {
  /** Number of mismatched categories. `0` means "clean" (match). */
  count:                 number;
  /** Sum of rank gaps — handy for sorting worst-first. */
  totalGap:              number;
  /** Tone class suffix the client uses: .app-card-profile-badge.match-{tone}. */
  tone:                  BadgeTone;
  /**
   * Discriminator for client-side localisation. With `count` and
   * `worstCategoryLabel`, clients can build a localised label + description.
   */
  kind:                  BadgeKind;
  /** English label fallback. Localised label is computed client-side. */
  label:                 string;
  /** English description fallback. Localised description is computed client-side. */
  description:           string;
  /** Worst offending category key (for deep-linking from the card). */
  worstCategory:         string | null;
  /** Pre-resolved human label for worstCategory. */
  worstCategoryLabel:    string | null;
}

/**
 * Reduce a full ProfileMismatchResult to the compact per-card shape.
 *   - `ok`   — no mismatches (green)
 *   - `warn` — 1-2 mismatches or totalGap ≤ 2 (orange)
 *   - `bad`  — anything more severe (red)
 */
export function summariseBadge(result: ProfileMismatchResult): AppProfileBadge {
  if (!result.profileActive) {
    // No profile set — neutral tone; callers usually filter these out.
    return {
      count: 0,
      totalGap: 0,
      tone: 'ok',
      kind: 'no_profile',
      label: 'No profile',
      description: 'Set a privacy profile to see how this app compares.',
      worstCategory: null,
      worstCategoryLabel: null,
    };
  }
  if (result.count === 0) {
    return {
      count: 0,
      totalGap: 0,
      tone: 'ok',
      kind: 'match',
      label: 'Matches profile',
      description: 'Every category this app collects stays within your preferences.',
      worstCategory: null,
      worstCategoryLabel: null,
    };
  }

  const tone: BadgeTone =
    result.count >= 3 || result.totalGap >= 5
      ? 'bad'
      : result.totalGap >= 3
        ? 'bad'
        : 'warn';

  const top = result.mismatches[0];
  const categoryLabel = CATEGORY_META[top.category]?.label ?? top.category;

  const label = `${result.count} mismatch${result.count === 1 ? '' : 'es'}`;
  const description =
    describeWorstMismatch(result) ??
    `${result.count} categor${result.count === 1 ? 'y' : 'ies'} exceed your profile.`;

  return {
    count: result.count,
    totalGap: result.totalGap,
    tone,
    kind: 'mismatches',
    label,
    description,
    worstCategory: top.category,
    worstCategoryLabel: categoryLabel,
  };
}

/**
 * i18n helpers for the privacy-meta data structures.
 *
 * `lib/privacy-meta.ts` keeps English labels in CATEGORY_META / SEVERITY_CONFIG
 * as the source of truth for icons / colours / fallbacks. These helpers map
 * the identifiers (`CONTACT_INFO`, `DATA_USED_TO_TRACK_YOU`, …) to the
 * matching key under `category.*` / `severity.*` in the locale bundle.
 *
 *   const tCat = useTranslations('category');
 *   <div>{categoryLabel(tCat, identifier) ?? CATEGORY_META[identifier].label}</div>
 *
 * Always pair with a `?? englishFallback` so a new identifier or missing
 * `t` argument doesn't render the raw key.
 */

/** Map CATEGORY_META identifiers to the `category.*` namespace key. */
const CATEGORY_NAMESPACE_KEY: Record<string, string> = {
  CONTACT_INFO: 'contact_info',
  HEALTH_AND_FITNESS: 'health_fitness',
  FINANCIAL_INFO: 'financial_info',
  LOCATION: 'location',
  SENSITIVE_INFO: 'sensitive_info',
  CONTACTS: 'contacts',
  USER_CONTENT: 'user_content',
  BROWSING_HISTORY: 'browsing_history',
  SEARCH_HISTORY: 'search_history',
  IDENTIFIERS: 'identifiers',
  PURCHASES: 'purchases',
  USAGE_DATA: 'usage_data',
  DIAGNOSTICS: 'diagnostics',
  OTHER: 'other',
};

/** Map SEVERITY_CONFIG identifiers to the `severity.*` namespace key. */
const SEVERITY_NAMESPACE_KEY: Record<string, string> = {
  DATA_USED_TO_TRACK_YOU: 'data_used_to_track_you',
  DATA_LINKED_TO_YOU: 'data_linked_to_you',
  DATA_NOT_LINKED_TO_YOU: 'data_not_linked_to_you',
};

/**
 * Translate a category identifier into the active locale.
 * Returns undefined for unknown identifiers; callers should fall back
 * to the English label from CATEGORY_META in that case.
 */
export function categoryLabel(
  t: (key: string) => string,
  identifier: string,
): string | undefined {
  const key = CATEGORY_NAMESPACE_KEY[identifier];
  return key ? t(key) : undefined;
}

/**
 * Translate a category description. Reads from `category_descriptions.*`
 * (keyed by the same lowercase identifier as `category.*`). Returns
 * undefined for unknown identifiers; callers should fall back to
 * `CATEGORY_META[identifier].description`.
 */
export function categoryDescription(
  t: (key: string) => string,
  identifier: string,
): string | undefined {
  const key = CATEGORY_NAMESPACE_KEY[identifier];
  return key ? t(key) : undefined;
}

/**
 * Translate a severity identifier into the active locale.
 * Pair with the `severity.*_desc` keys for descriptions.
 */
export function severityLabel(
  t: (key: string) => string,
  identifier: string,
): string | undefined {
  const key = SEVERITY_NAMESPACE_KEY[identifier];
  return key ? t(key) : undefined;
}

/**
 * Localise a severity description (e.g. tooltip body). Reads from
 * `severity.<key>_desc` in the locale bundle.
 */
export function severityDescription(
  t: (key: string) => string,
  identifier: string,
): string | undefined {
  const key = SEVERITY_NAMESPACE_KEY[identifier];
  return key ? t(`${key}_desc`) : undefined;
}

/**
 * Localise a privacy-profile badge label + description via the active
 * locale's `profile_badge.*` namespace. Accepts a minimal shape to avoid
 * a circular import with lib/privacy-profile.ts.
 */
export interface BadgeLocalisationInput {
  kind: 'no_profile' | 'match' | 'mismatches';
  count: number;
  /** English label fallback — returned when the kind isn't recognised. */
  label: string;
  /** English description fallback — same back-compat reasoning. */
  description: string;
  /** Worst-category localised label, already resolved via `categoryLabel`. */
  worstCategoryLabel: string | null;
  /**
   * Optional pre-localised worst-mismatch sentence. When present, takes
   * precedence over the generic `mismatches_description` fallback.
   */
  worstMismatchSentence?: string | null;
}

export function localiseBadgeLabel(
  t: (key: string, values?: Record<string, string | number>) => string,
  badge: BadgeLocalisationInput,
): string {
  switch (badge.kind) {
    case 'no_profile':
      return t('no_profile_label');
    case 'match':
      return t('match_label');
    case 'mismatches':
      return t('mismatches_label', { count: badge.count });
    default:
      return badge.label;
  }
}

export function localiseBadgeDescription(
  t: (key: string, values?: Record<string, string | number>) => string,
  badge: BadgeLocalisationInput,
): string {
  switch (badge.kind) {
    case 'no_profile':
      return t('no_profile_description');
    case 'match':
      return t('match_description');
    case 'mismatches':
      if (badge.worstMismatchSentence) return badge.worstMismatchSentence;
      return t('mismatches_description', { count: badge.count });
    default:
      return badge.description;
  }
}

/** Mirror of {@link BadgeLocalisationInput} for the accessibility profile badge. */
export interface A11yBadgeLocalisationInput {
  kind: 'no_profile' | 'match' | 'missing_required' | 'missing_nice';
  count: number;
  missingRequired: number;
  label: string;
  description: string;
}

export function localiseA11yBadgeLabel(
  t: (key: string, values?: Record<string, string | number>) => string,
  badge: A11yBadgeLocalisationInput,
): string {
  switch (badge.kind) {
    case 'no_profile':
      return t('no_profile_label');
    case 'match':
      return t('match_label');
    case 'missing_required':
    case 'missing_nice':
      return t('missing_label', { count: badge.count });
    default:
      return badge.label;
  }
}

export function localiseA11yBadgeDescription(
  t: (key: string, values?: Record<string, string | number>) => string,
  badge: A11yBadgeLocalisationInput,
): string {
  switch (badge.kind) {
    case 'no_profile':
      return t('no_profile_description');
    case 'match':
      return t('match_description');
    case 'missing_required':
      return t('missing_required_description', { count: badge.missingRequired });
    case 'missing_nice':
      return t('missing_nice_description', { count: badge.count });
    default:
      return badge.description;
  }
}

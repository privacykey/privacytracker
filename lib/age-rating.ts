/**
 * Client-safe age-rating module — types, band metadata, and pure helpers.
 * Do NOT import server-only modules here (db / scheduler / fs); browser
 * bundles import from this file.
 *
 * A guardian records the child's age band; each app's App Store age rating
 * is compared against the band's most permissive allowed rating. Bands are
 * conservative: the cap is the rating suitable for the YOUNGEST age in the
 * band, so a 9–12 band flags 13+ apps even though a 12-year-old is close.
 *
 * Apple's 2025 rating overhaul ships 4+ / 9+ / 13+ / 16+ / 18+. Legacy 12+
 * and 17+ strings still appear in iTunes API responses and Wayback-era data,
 * so comparisons are numeric (parse the leading digits) rather than an enum.
 */

// Canonical band order, youngest first — pickers render in this order.

export const AGE_BAND_KEYS = [
  "under_9",
  "9_12",
  "13_15",
  "16_17",
  "18_plus",
] as const;

export type AgeBandKey = (typeof AGE_BAND_KEYS)[number];

export interface AgeBandMeta {
  /** English fallback — UI reads `onboarding.guardian_age.bands.<key>`. */
  label: string;
  /**
   * Most permissive App Store rating minimum-age allowed for this band.
   * `compareRatingToBand` flags any rating whose minimum age exceeds it.
   */
  maxRatingAge: number;
}

export const AGE_BAND_META: Record<AgeBandKey, AgeBandMeta> = {
  under_9: { label: "Under 9", maxRatingAge: 4 },
  "9_12": { label: "9–12", maxRatingAge: 9 },
  "13_15": { label: "13–15", maxRatingAge: 13 },
  "16_17": { label: "16–17", maxRatingAge: 16 },
  "18_plus": { label: "18+", maxRatingAge: 99 },
};

export function isValidAgeBand(value: unknown): value is AgeBandKey {
  return (
    typeof value === "string" && AGE_BAND_KEYS.includes(value as AgeBandKey)
  );
}

/**
 * Extract the minimum age from an App Store rating string. Returns null
 * for missing/unparseable input — callers must treat null as "unknown",
 * never as a violation.
 *
 * Storefront formats (verified live against all 48 iTunes storefronts):
 * every storefront returns "N+" ("4+", "13+", legacy "12+"/"17+") except
 * Brazil, which puts the plus first ("+4", "+12", "+17"). Both orders are
 * accepted; anything else (no digits, out-of-range) is null.
 */
export function parseRatingMinAge(
  raw: string | null | undefined
): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.match(/(\d+)\s*\+/) ?? raw.match(/\+\s*(\d+)/);
  if (!match) {
    return null;
  }
  const age = Number.parseInt(match[1], 10);
  return Number.isFinite(age) && age > 0 && age < 100 ? age : null;
}

export type AgeRatingVerdict = "within" | "above" | "unknown";

/**
 * Compare an app's raw rating string against the child's band.
 * "unknown" (no rating / unparseable) is deliberately not "above" —
 * we never warn on data we don't have.
 */
export function compareRatingToBand(
  band: AgeBandKey,
  rawRating: string | null | undefined
): AgeRatingVerdict {
  const minAge = parseRatingMinAge(rawRating);
  if (minAge === null) {
    return "unknown";
  }
  return minAge > AGE_BAND_META[band].maxRatingAge ? "above" : "within";
}

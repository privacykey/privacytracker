import {
  POLICY_LENSES,
  type PolicyLensKey,
  type PolicyLensSummary,
  type PolicyRating,
} from "../../../lib/policy-summary-meta";

// ── Policy lens ordering + diff helpers ────────────────────────────────
// Surface concerning lenses first, then mixed, then unclear, then favorable.
// Within each bucket we preserve the canonical POLICY_LENSES order so readers
// still see "collection → use → ads → sharing → tracking → controls → …".
const RATING_WEIGHT: Record<PolicyRating, number> = {
  concerning: 0,
  mixed: 1,
  unclear: 2,
  favorable: 3,
};

export function orderLensesBySeverity(
  lenses: PolicyLensSummary[]
): PolicyLensSummary[] {
  const indexByKey = new Map<PolicyLensKey, number>(
    POLICY_LENSES.map((lens, index) => [lens.key, index])
  );
  return [...lenses].sort((a, b) => {
    const severityDiff = RATING_WEIGHT[a.rating] - RATING_WEIGHT[b.rating];
    if (severityDiff !== 0) {
      return severityDiff;
    }
    return (indexByKey.get(a.key) ?? 99) - (indexByKey.get(b.key) ?? 99);
  });
}

export interface LensRatingShift {
  /** Positive = got worse, negative = got better. Drives the arrow direction. */
  delta: number;
  from: PolicyRating;
  key: PolicyLensKey;
  label: string;
  to: PolicyRating;
}

export function diffLensRatings(
  current: PolicyLensSummary[],
  previous: PolicyLensSummary[]
): LensRatingShift[] {
  const prevByKey = new Map<PolicyLensKey, PolicyRating>(
    previous.map((entry) => [entry.key, entry.rating])
  );
  const labelByKey = new Map<PolicyLensKey, string>(
    POLICY_LENSES.map((lens) => [lens.key, lens.label])
  );

  const shifts: LensRatingShift[] = [];
  for (const entry of current) {
    const previousRating = prevByKey.get(entry.key);
    if (!previousRating || previousRating === entry.rating) {
      continue;
    }
    shifts.push({
      key: entry.key,
      label: labelByKey.get(entry.key) ?? entry.key,
      from: previousRating,
      to: entry.rating,
      delta: RATING_WEIGHT[entry.rating] - RATING_WEIGHT[previousRating],
    });
  }

  // Regressions (delta > 0, worse rating) rise to the top so the user sees the
  // things that got scarier first. Ties broken alphabetically for stability.
  shifts.sort((a, b) => {
    if (a.delta !== b.delta) {
      return b.delta - a.delta;
    }
    return a.label.localeCompare(b.label);
  });

  return shifts;
}

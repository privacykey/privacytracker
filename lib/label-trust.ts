/**
 * "How much to trust this label" — the pure derivation behind the App
 * Detail card of the same name (`app/components/detail/LabelTrustCard.tsx`).
 *
 * privacytracker only ever sees what a developer DECLARES: the App Store
 * privacy label and the developer's own privacy policy. Neither is
 * verified by Apple, and a four-year study of 926,240 apps (Alsahdi et
 * al., "Why App Developers Do (Not) Update Apple's Privacy Labels",
 * PoPETs 2026) found that fewer than 6% of apps ever changed their label,
 * that "Data Not Collected" is the label most often replaced later, and
 * that the gap between label and practice is mostly uncertainty about
 * third-party SDKs and organisational drift rather than intent. This
 * module turns those findings into per-app signals a user can read
 * without any data we do not hold:
 *
 *   - label AGE, from the snapshot rows the timeline already loads;
 *   - whether the label is "Data Not Collected";
 *   - a cross-check of the label against the AI policy lens ratings
 *     already stored on the app (the paper's own policy-analysis tool,
 *     at home-install scale);
 *   - the monetisation model, from the price + IAP columns.
 *
 * Every signal is "worth a look", never a verdict: the paper itself did no
 * runtime measurement and neither do we. Keep the copy that renders these
 * honest about that.
 *
 * No React, no SQLite, no fetch — the card and its tests both import this.
 */

import type {
  ChangeEntry,
  ChangelogRow,
  PrivacyTypeSnapshot,
  SnapshotChangelogRow,
} from "./changelog-types";
import { isWholeNewPrivacyType } from "./changelog-types";
import type {
  AppPolicyAnalysis,
  PolicyLensKey,
  PolicyRating,
} from "./policy-summary-meta";

export const DATA_NOT_COLLECTED = "DATA_NOT_COLLECTED";
export const DATA_USED_TO_TRACK_YOU = "DATA_USED_TO_TRACK_YOU";

/**
 * 1 December 2023 (UTC). Apple announced privacy manifests for third-party
 * SDKs in June 2023 and made them a submission requirement in the
 * December 2023 / February 2024 updates; the study saw the share of apps
 * that had ever changed their label nearly double across that window
 * (2.9% in May 2023 to 5.21% in January 2024). A label last set before
 * this date was written before developers had any structured view of
 * what their SDKs collect.
 */
export const PRIVACY_MANIFEST_ERA_MS = Date.UTC(2023, 11, 1);

/** The study every signal here is drawn from. CC BY 4.0. */
export const LABEL_TRUST_RESEARCH_URL =
  "https://petsymposium.org/popets/2026/popets-2026-0151.php";

export type LabelKind = "not_collected" | "declared" | "none";

export type LabelAge =
  | {
      kind: "changed";
      /** Epoch ms of the newest snapshot that recorded a label change. */
      at: number;
      /** Privacy types present after the change but not before. */
      addedTypes: string[];
      /** Privacy types present before the change but not after. */
      removedTypes: string[];
      /** True when `addedTypes` includes "Data Used to Track You". */
      addedTracking: boolean;
      /** The last change happened before Apple's privacy manifests. */
      predatesManifests: boolean;
    }
  | {
      kind: "unchanged";
      /** Epoch ms of the oldest snapshot on file. */
      since: number;
      /** At least one Wayback row exists, so `since` can predate install. */
      reachesArchive: boolean;
      /** The label already existed, unchanged, before privacy manifests. */
      predatesManifests: boolean;
      /** How many snapshot rows were inspected. */
      rowsInspected: number;
    }
  | {
      /**
       * No change among the rows loaded so far, but older rows exist that
       * the caller has not fetched. The card pages further; if it gives up,
       * it renders this as "unchanged across the last N syncs".
       */
      kind: "incomplete";
      rowsInspected: number;
      /** Epoch ms of the oldest row inspected, for the next `before=` page. */
      oldestInspected: number;
    }
  | { kind: "unknown" };

export type PolicyCheck =
  | { kind: "no_policy" }
  | { kind: "no_summary" }
  | { kind: "consistent" }
  | { kind: "mismatch"; lenses: PolicyLensKey[] };

export type Monetisation = "free_iap" | "free" | "paid" | "unknown";

export interface LabelTrustInput {
  /** Timeline rows, any order; review rows are ignored. */
  changelog: readonly ChangelogRow[];
  /** Whether rows older than `changelog` exist on the server. */
  changelogHasMore: boolean;
  hasIap?: number | null;
  /** `app.policyAnalysis`; undefined and null both mean "never fetched". */
  policyAnalysis?: AppPolicyAnalysis | null;
  priceAmount?: number | null;
  /** `app.privacyTypes` from the detail payload. Identifiers only matter. */
  privacyTypes: readonly { identifier: string }[];
}

export interface LabelTrustReport {
  age: LabelAge;
  labelKind: LabelKind;
  monetisation: Monetisation;
  policy: PolicyCheck;
}

// ─────────────────────────────────────────────
// Label kind
// ─────────────────────────────────────────────

export function classifyLabel(
  privacyTypes: readonly { identifier: string }[]
): LabelKind {
  if (privacyTypes.length === 0) {
    return "none";
  }
  if (privacyTypes.some((t) => t.identifier === DATA_NOT_COLLECTED)) {
    return "not_collected";
  }
  return "declared";
}

// ─────────────────────────────────────────────
// Label age
// ─────────────────────────────────────────────

/**
 * Privacy-label diffs are the untagged default; every other entry kind
 * (`privacy-policy`, `accessibility`, `age-rating`, `wayback-attempt`)
 * carries an explicit category and is not a label change. Mirrors
 * `isPrivacyLabelEntry` in lib/historical-import.ts, which is server-only.
 */
function isLabelChangeEntry(entry: ChangeEntry): boolean {
  return (
    (entry.category ?? "privacy-label") === "privacy-label" &&
    (entry.type === "added" ||
      entry.type === "removed" ||
      entry.type === "modified")
  );
}

/**
 * Whether a snapshot row recorded a change to the privacy label itself.
 * Keyed on the entries rather than `changes_detected`: the oldest live row
 * can carry a read-time `archive_bridge` diff while its stored flag is 0,
 * and a policy or accessibility event sets the flag without touching the
 * label.
 */
export function rowRecordsLabelChange(row: SnapshotChangelogRow): boolean {
  return (row.changes_summary ?? []).some(isLabelChangeEntry);
}

function snapshotRows(
  changelog: readonly ChangelogRow[]
): SnapshotChangelogRow[] {
  return changelog
    .filter((row): row is SnapshotChangelogRow => row.kind === "snapshot")
    .sort((a, b) => b.scraped_at - a.scraped_at);
}

function typeIdentifiers(row: SnapshotChangelogRow): Set<string> | null {
  if (!row.snapshot_json) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.snapshot_json) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const ids = new Set<string>();
    for (const item of parsed as PrivacyTypeSnapshot[]) {
      if (item && typeof item.identifier === "string") {
        ids.add(item.identifier);
      }
    }
    return ids;
  } catch {
    return null;
  }
}

/**
 * Which privacy TYPES the change row added and removed. Exact when both
 * the row and its predecessor carry `snapshot_json`; otherwise falls back
 * to the entry descriptions, which name a wholly new type with a fixed
 * prefix but only carry Apple's display title, so tracking is matched by
 * title text.
 */
function typeDelta(
  row: SnapshotChangelogRow,
  previous: SnapshotChangelogRow | undefined
): { addedTypes: string[]; removedTypes: string[] } {
  const after = typeIdentifiers(row);
  const before = previous ? typeIdentifiers(previous) : null;
  if (after && before) {
    return {
      addedTypes: [...after].filter((id) => !before.has(id)).sort(),
      removedTypes: [...before].filter((id) => !after.has(id)).sort(),
    };
  }
  const addedTypes: string[] = [];
  for (const entry of row.changes_summary ?? []) {
    if (isWholeNewPrivacyType(entry) && /track/i.test(entry.description)) {
      addedTypes.push(DATA_USED_TO_TRACK_YOU);
    }
  }
  return { addedTypes, removedTypes: [] };
}

export function deriveLabelAge(
  changelog: readonly ChangelogRow[],
  changelogHasMore: boolean
): LabelAge {
  const rows = snapshotRows(changelog);
  if (rows.length === 0) {
    return { kind: "unknown" };
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!rowRecordsLabelChange(row)) {
      continue;
    }
    const { addedTypes, removedTypes } = typeDelta(row, rows[i + 1]);
    return {
      kind: "changed",
      at: row.scraped_at,
      addedTypes,
      removedTypes,
      addedTracking: addedTypes.includes(DATA_USED_TO_TRACK_YOU),
      predatesManifests: row.scraped_at < PRIVACY_MANIFEST_ERA_MS,
    };
  }

  const oldest = rows[rows.length - 1];
  if (changelogHasMore) {
    return {
      kind: "incomplete",
      rowsInspected: rows.length,
      oldestInspected: oldest.scraped_at,
    };
  }
  return {
    kind: "unchanged",
    since: oldest.scraped_at,
    reachesArchive: rows.some((row) => row.source === "wayback"),
    predatesManifests: oldest.scraped_at < PRIVACY_MANIFEST_ERA_MS,
    rowsInspected: rows.length,
  };
}

// ─────────────────────────────────────────────
// Policy cross-check
// ─────────────────────────────────────────────

/**
 * Lenses whose rating contradicts a "Data Not Collected" label. A
 * `mixed` rating counts here because the label leaves no room at all:
 * a policy that even partly describes collection, tracking, advertising
 * or sharing is already saying more than the label does.
 */
const DNC_LENSES: readonly PolicyLensKey[] = [
  "collection_scope",
  "tracking_analytics",
  "ads_marketing",
  "third_party_sharing",
];
const DNC_RATINGS: ReadonlySet<PolicyRating> = new Set(["mixed", "concerning"]);

/**
 * Lenses whose rating contradicts a label that declares collection but
 * lists no "Data Used to Track You". Only `concerning` counts: a declared
 * label already admits collection, so `mixed` is agreement, not a gap.
 */
const NO_TRACKING_LENSES: readonly PolicyLensKey[] = [
  "tracking_analytics",
  "ads_marketing",
];
const NO_TRACKING_RATINGS: ReadonlySet<PolicyRating> = new Set(["concerning"]);

export function derivePolicyCheck(
  labelKind: LabelKind,
  privacyTypes: readonly { identifier: string }[],
  analysis: AppPolicyAnalysis | null | undefined
): PolicyCheck {
  const lenses = analysis?.summary?.lenses;
  if (!lenses || lenses.length === 0) {
    if (!analysis) {
      return { kind: "no_policy" };
    }
    const hasText =
      (analysis.sourceLength ?? 0) > 0 ||
      analysis.status === "source_ready" ||
      analysis.status === "needs_ai_config" ||
      analysis.status === "analysis_error";
    return hasText ? { kind: "no_summary" } : { kind: "no_policy" };
  }

  const ratingOf = new Map<PolicyLensKey, PolicyRating>();
  for (const lens of lenses) {
    ratingOf.set(lens.key, lens.rating);
  }

  let watched: readonly PolicyLensKey[];
  let flagged: ReadonlySet<PolicyRating>;
  if (labelKind === "not_collected") {
    watched = DNC_LENSES;
    flagged = DNC_RATINGS;
  } else if (
    labelKind === "declared" &&
    !privacyTypes.some((t) => t.identifier === DATA_USED_TO_TRACK_YOU)
  ) {
    watched = NO_TRACKING_LENSES;
    flagged = NO_TRACKING_RATINGS;
  } else {
    return { kind: "consistent" };
  }

  const mismatched = watched.filter((key) => {
    const rating = ratingOf.get(key);
    return rating !== undefined && flagged.has(rating);
  });
  return mismatched.length > 0
    ? { kind: "mismatch", lenses: mismatched }
    : { kind: "consistent" };
}

// ─────────────────────────────────────────────
// Monetisation
// ─────────────────────────────────────────────

export function deriveMonetisation(
  priceAmount: number | null | undefined,
  hasIap: number | null | undefined
): Monetisation {
  if (priceAmount === null || priceAmount === undefined) {
    return "unknown";
  }
  if (!Number.isFinite(priceAmount)) {
    return "unknown";
  }
  if (priceAmount > 0) {
    return "paid";
  }
  return hasIap === 1 ? "free_iap" : "free";
}

// ─────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────

export function deriveLabelTrust(input: LabelTrustInput): LabelTrustReport {
  const labelKind = classifyLabel(input.privacyTypes);
  return {
    labelKind,
    age: deriveLabelAge(input.changelog, input.changelogHasMore),
    policy: derivePolicyCheck(
      labelKind,
      input.privacyTypes,
      input.policyAnalysis
    ),
    monetisation: deriveMonetisation(input.priceAmount, input.hasIap),
  };
}

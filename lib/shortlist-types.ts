/**
 * Client-safe type declarations for the shortlist feature. Mirrors the
 * interfaces in lib/shortlist.ts with no runtime imports so client
 * components don't pull better-sqlite3 into the browser bundle.
 */

import type { PrivacyTypeSnapshot } from "./changelog-types";
import type { AppProfileBadge, ProfileMismatchResult } from "./privacy-profile";

/**
 * Which Compare-view mode the user was in when they shortlisted this entry.
 * A candidate saved from both modes carries both values; stored as a
 * comma-separated string in the `mode` column.
 */
export type ShortlistMode = "privacy" | "accessibility";

export interface ShortlistEntry {
  addedAt: number;
  candidateAppleId: string;
  candidateBundleId: string;
  candidateDeveloper: string;
  /**
   * 1 = candidate offers in-app purchases, 0 = doesn't, null = unknown.
   * Drives the "· IAP" tail on the candidate's price chip.
   */
  candidateHasIap?: number | null;
  candidateIconUrl: string;
  candidateIsTracked: boolean;
  candidateName: string;
  /** ISO currency code; companion to candidatePriceFormatted. */
  candidatePriceCurrency?: string | null;
  /**
   * Pricing snapshot for the candidate. Populated only when the candidate
   * is already tracked locally; untracked candidates land here as null and
   * the renderer hides the price chip.
   */
  candidatePriceFormatted?: string | null;
  candidateStoreUrl: string;
  id: string;
  /**
   * Which comparison lens(es) this candidate was shortlisted under. Always
   * at least one entry; clients render a coloured badge per mode.
   */
  modes: ShortlistMode[];
  note: string;
  /**
   * Pre-computed privacy-profile match for this candidate. `null` / absent
   * when the candidate isn't tracked or no profile is active.
   */
  profileBadge?: AppProfileBadge | null;
  sourceAppId: string;
}

export interface ShortlistGroup {
  entries: ShortlistEntry[];
  sourceApp: {
    id: string;
    name: string;
    iconUrl: string;
    developer: string;
    /**
     * Current privacy-label snapshot for the source app. Absent when the DB
     * has no privacy rows for the source (fresh import, scrape pending, or
     * Apple hasn't published labels for the app).
     */
    privacyTypes?: PrivacyTypeSnapshot[];
    /**
     * Mismatch between the source app and the user's saved privacy profile.
     * Present only when a profile is active and at least one category
     * exceeds the allowed tier. Drives the group-card banner.
     */
    profileMismatch?: ProfileMismatchResult;
    /** Source app's pricing snapshot. Populated when the apps row has been synced. */
    priceFormatted?: string | null;
    priceCurrency?: string | null;
    hasIap?: number | null;
  };
}

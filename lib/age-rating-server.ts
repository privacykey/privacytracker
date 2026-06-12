/**
 * Server-only helpers for the guardian age-rating feature. Reads the
 * `guardian_child_age_band` app setting and counts tracked apps whose App
 * Store rating exceeds the band.
 *
 * Client components must NOT import from this file — they pull types and
 * pure helpers from `lib/age-rating.ts` instead (same convention as
 * `lib/privacy-profile-server.ts`).
 */

import {
  type AgeBandKey,
  compareRatingToBand,
  isValidAgeBand,
} from "./age-rating";
import db from "./db";
import { getSetting } from "./scheduler";

/** The stored child age band, or null when unset / invalid. */
export function getChildAgeBand(): AgeBandKey | null {
  const raw = getSetting("guardian_child_age_band", "");
  return isValidAgeBand(raw) ? raw : null;
}

/**
 * How many tracked apps are rated above the band. Apps without a captured
 * rating are never counted — unknown is not a warning.
 */
export function countAppsAboveAgeBand(band: AgeBandKey): number {
  const rows = db
    .prepare("SELECT ageRating FROM apps WHERE ageRating IS NOT NULL")
    .all() as { ageRating: string }[];
  let count = 0;
  for (const row of rows) {
    if (compareRatingToBand(band, row.ageRating) === "above") {
      count += 1;
    }
  }
  return count;
}

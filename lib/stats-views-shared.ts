/**
 * Client-safe types and constants for the Stats visualisation layer.
 * Split from lib/stats-views.ts (which imports ./db) so client components
 * don't pull in better-sqlite3 / fs.
 *
 * Keep new exports here pure data — no `db`, no `fs`, no imports from
 * files that touch either.
 */
import type { PolicyLensKey, PolicyRating } from "./policy-summary-meta";

// ── Matrix (apps × category × severity) ───────────────────────────────
export type SeverityId =
  | "DATA_USED_TO_TRACK_YOU"
  | "DATA_LINKED_TO_YOU"
  | "DATA_NOT_LINKED_TO_YOU";

export interface MatrixApp {
  categoryCount: number;
  developer: string;
  iconUrl: string;
  id: string;
  name: string;
}

export interface MatrixCategory {
  appCount: number;
  identifier: string;
  label: string;
}

export interface MatrixData {
  apps: MatrixApp[];
  categories: MatrixCategory[];
  cells: Record<string, Record<string, SeverityId>>;
  severities: { identifier: SeverityId; label: string }[];
}

// ── Timeline ──────────────────────────────────────────────────────────
export type TimelineBucket = "day" | "week" | "month";

export interface TimelinePoint {
  /**
   * Accessibility-label additions / removals. Optional so old serialised
   * payloads deserialize cleanly — treat missing fields as 0.
   */
  accessibilityAdded?: number;
  accessibilityRemoved?: number;
  /**
   * Counts privacy-label changes only (legacy rows with no category are
   * treated as privacy-label for back-compat). Accessibility goes to the
   * dedicated buckets below.
   */
  added: number;
  bucket: string;
  modified: number;
  policy: number;
  removed: number;
  reviews?: number;
  /**
   * Contextual counters — sync snapshots and review actions in the same
   * bucket. Optional and not part of the `total` roll-up so the stats
   * chart can ignore them.
   */
  syncs?: number;
}

export interface TimelineData {
  bucketType: TimelineBucket;
  from: number;
  points: TimelinePoint[];
  to: number;
  total: number;
}

// ── Radar ─────────────────────────────────────────────────────────────
/** Upper bound on radar axes; mirrors the max in RATING_SCORE (concerning = 4). */
export const RADAR_MAX = 4;

export interface RadarLens {
  key: PolicyLensKey;
  label: string;
  rating: PolicyRating | null;
  score: number | null;
}

export interface RadarApp {
  hasPolicy: boolean;
  iconUrl: string;
  id: string;
  lenses: RadarLens[];
  name: string;
  status?: string;
}

export interface RadarData {
  apps: RadarApp[];
  axes: { key: PolicyLensKey; label: string }[];
  ratings: readonly PolicyRating[];
}

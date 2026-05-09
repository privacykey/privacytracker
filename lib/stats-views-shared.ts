/**
 * Client-safe types and constants for the Stats visualisation layer.
 * Split from lib/stats-views.ts (which imports ./db) so client components
 * don't pull in better-sqlite3 / fs.
 *
 * Keep new exports here pure data — no `db`, no `fs`, no imports from
 * files that touch either.
 */
import type { PolicyLensKey, PolicyRating } from './policy-summary-meta';

// ── Matrix (apps × category × severity) ───────────────────────────────
export type SeverityId =
  | 'DATA_USED_TO_TRACK_YOU'
  | 'DATA_LINKED_TO_YOU'
  | 'DATA_NOT_LINKED_TO_YOU';

export interface MatrixApp {
  id: string;
  name: string;
  iconUrl: string;
  developer: string;
  categoryCount: number;
}

export interface MatrixCategory {
  identifier: string;
  label: string;
  appCount: number;
}

export interface MatrixData {
  apps: MatrixApp[];
  categories: MatrixCategory[];
  severities: { identifier: SeverityId; label: string }[];
  cells: Record<string, Record<string, SeverityId>>;
}

// ── Timeline ──────────────────────────────────────────────────────────
export type TimelineBucket = 'day' | 'week' | 'month';

export interface TimelinePoint {
  bucket: string;
  /**
   * Counts privacy-label changes only (legacy rows with no category are
   * treated as privacy-label for back-compat). Accessibility goes to the
   * dedicated buckets below.
   */
  added: number;
  removed: number;
  modified: number;
  policy: number;
  /**
   * Accessibility-label additions / removals. Optional so old serialised
   * payloads deserialize cleanly — treat missing fields as 0.
   */
  accessibilityAdded?: number;
  accessibilityRemoved?: number;
  /**
   * Contextual counters — sync snapshots and review actions in the same
   * bucket. Optional and not part of the `total` roll-up so the stats
   * chart can ignore them.
   */
  syncs?: number;
  reviews?: number;
}

export interface TimelineData {
  from: number;
  to: number;
  bucketType: TimelineBucket;
  points: TimelinePoint[];
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
  id: string;
  name: string;
  iconUrl: string;
  lenses: RadarLens[];
  hasPolicy: boolean;
  status?: string;
}

export interface RadarData {
  axes: { key: PolicyLensKey; label: string }[];
  ratings: readonly PolicyRating[];
  apps: RadarApp[];
}

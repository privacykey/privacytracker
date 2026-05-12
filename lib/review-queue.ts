/**
 * Review-queue pure logic.
 *
 * The queue is a Tinder-style sequential verdict picker over the apps
 * currently visible in the AppGrid. This module owns the scope filter,
 * the sort order, and the session-split arithmetic. UI lives in
 * `app/components/ReviewQueue.tsx`.
 *
 * Design choices (per design discussion):
 *   - Scopes: undecided / all / mismatch / changed
 *   - Sorts:  mismatch_severity / risk / alphabetical / random
 *   - Splits: 10 / 25 / 50 / null (no split)
 *
 * Pure logic so it's trivially testable and reusable from
 * server-rendered surfaces (e.g. live count in preflight).
 */

import type { VerdictValue } from './verdict-types';
import type { AppProfileBadge } from './privacy-profile';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type QueueScope = 'undecided' | 'all' | 'mismatch' | 'changed';
export type QueueSort =
  | 'mismatch_severity'
  | 'risk'
  | 'alphabetical'
  | 'random';

/** `null` means "no split — one big batch". */
export type QueueSplit = 10 | 25 | 50 | null;

/** Stable, ordered lists for UI iteration. */
export const QUEUE_SCOPE_VALUES: readonly QueueScope[] = [
  'undecided',
  'all',
  'mismatch',
  'changed',
] as const;

export const QUEUE_SORT_VALUES: readonly QueueSort[] = [
  'mismatch_severity',
  'risk',
  'alphabetical',
  'random',
] as const;

export const QUEUE_SPLIT_VALUES: readonly QueueSplit[] = [10, 25, 50, null] as const;

/**
 * Minimum shape the queue needs from an app row. Matches the subset of
 * AppGrid's `App` type that the carousel card actually renders.
 */
export interface QueueAppInput {
  id: string;
  name: string;
  developer?: string;
  iconUrl?: string;
  lastSynced: number;
  changeCount: number;
  trackCount?: number;
  linkedCount?: number;
  unlinkedCount?: number;
}

export interface QueuePreflightChoices {
  scope: QueueScope;
  sort: QueueSort;
  split: QueueSplit;
}

export interface QueueComputeOptions {
  scope: QueueScope;
  sort: QueueSort;
  userVerdicts: Record<string, VerdictValue>;
  profileBadges: Record<string, AppProfileBadge>;
  /** Apps with pending changes (privacy / accessibility / policy). */
  changedAppIds?: Set<string>;
  /** Seedable RNG for stable random sort in tests. Defaults to Math.random. */
  rng?: () => number;
}

// ─────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────

export const DEFAULT_PREFLIGHT: QueuePreflightChoices = {
  scope: 'undecided',
  sort: 'mismatch_severity',
  split: null,
};

/**
 * Guardian audience override — defaults to the mismatch scope because the
 * carer use case is "show me apps that don't fit my child's profile",
 * and `undecided` floods them with stuff they haven't even reviewed yet.
 */
export const GUARDIAN_DEFAULT_PREFLIGHT: QueuePreflightChoices = {
  scope: 'mismatch',
  sort: 'mismatch_severity',
  split: null,
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Risk score using the same weights as AppGrid.computeRiskScore. */
export function computeQueueRiskScore(app: QueueAppInput): number {
  const t = app.trackCount ?? 0;
  const l = app.linkedCount ?? 0;
  const u = app.unlinkedCount ?? 0;
  return t * 10 + l * 3 + u;
}

function matchesScope(
  app: QueueAppInput,
  opts: QueueComputeOptions,
): boolean {
  switch (opts.scope) {
    case 'undecided':
      return !opts.userVerdicts[app.id];
    case 'all':
      return true;
    case 'mismatch':
      return (opts.profileBadges[app.id]?.count ?? 0) > 0;
    case 'changed':
      return opts.changedAppIds
        ? opts.changedAppIds.has(app.id)
        : app.changeCount > 0;
  }
}

function compareApps(
  a: QueueAppInput,
  b: QueueAppInput,
  opts: QueueComputeOptions,
): number {
  switch (opts.sort) {
    case 'mismatch_severity': {
      const aGap = opts.profileBadges[a.id]?.totalGap ?? -1;
      const bGap = opts.profileBadges[b.id]?.totalGap ?? -1;
      if (aGap !== bGap) return bGap - aGap;
      // No profile or equal gaps — fall back to risk so the queue still
      // surfaces the worst apps first.
      const riskDelta = computeQueueRiskScore(b) - computeQueueRiskScore(a);
      if (riskDelta !== 0) return riskDelta;
      return a.name.localeCompare(b.name);
    }
    case 'risk': {
      const riskDelta = computeQueueRiskScore(b) - computeQueueRiskScore(a);
      if (riskDelta !== 0) return riskDelta;
      return a.name.localeCompare(b.name);
    }
    case 'alphabetical':
      return a.name.localeCompare(b.name);
    case 'random':
      // Caller seeds via Fisher-Yates; this comparator is unused for
      // random. The dispatch in computeQueue branches before calling.
      return 0;
  }
}

/** Fisher-Yates shuffle. Pure given a seeded RNG. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Apply scope + sort to a list of apps. Inputs are expected to already
 * have the AppGrid filters applied (search, risk filter, mismatch
 * toggle, accessibility filter) — the queue's scope filter is *on top*
 * of those, narrowing further within the user's current view.
 */
export function computeQueueApps(
  apps: QueueAppInput[],
  opts: QueueComputeOptions,
): QueueAppInput[] {
  const scoped = apps.filter(a => matchesScope(a, opts));
  if (opts.sort === 'random') {
    return shuffle(scoped, opts.rng ?? Math.random);
  }
  return [...scoped].sort((a, b) => compareApps(a, b, opts));
}

/** Number of batches for a given total + split. */
export function countQueueBatches(total: number, split: QueueSplit): number {
  if (split === null || total <= split) return total > 0 ? 1 : 0;
  return Math.ceil(total / split);
}

/** Split a sorted app list into batches. Returns `[apps]` when no split. */
export function splitQueueIntoBatches<T>(apps: T[], split: QueueSplit): T[][] {
  if (split === null || apps.length === 0) return apps.length > 0 ? [apps] : [];
  if (apps.length <= split) return [apps];
  const out: T[][] = [];
  for (let i = 0; i < apps.length; i += split) {
    out.push(apps.slice(i, i + split));
  }
  return out;
}

// ─────────────────────────────────────────────
// Session totals — tracked client-side, written to activity log on completion
// ─────────────────────────────────────────────

export interface QueueSessionTotals {
  decided: number;
  safe: number;
  replace: number;
  uninstall: number;
  notesAdded: number;
  skipped: number;
}

export const EMPTY_SESSION_TOTALS: QueueSessionTotals = {
  decided: 0,
  safe: 0,
  replace: 0,
  uninstall: 0,
  notesAdded: 0,
  skipped: 0,
};

/** Apply a single decision to a totals object (immutable). */
export function applyDecision(
  totals: QueueSessionTotals,
  verdict: VerdictValue,
  wroteNote: boolean,
): QueueSessionTotals {
  return {
    decided: totals.decided + 1,
    safe: totals.safe + (verdict === 'safe' ? 1 : 0),
    replace: totals.replace + (verdict === 'replace' ? 1 : 0),
    uninstall: totals.uninstall + (verdict === 'uninstall' ? 1 : 0),
    notesAdded: totals.notesAdded + (wroteNote ? 1 : 0),
    skipped: totals.skipped,
  };
}

/** Reverse a decision (used by Undo). */
export function undoDecision(
  totals: QueueSessionTotals,
  verdict: VerdictValue,
  hadNote: boolean,
): QueueSessionTotals {
  return {
    decided: Math.max(0, totals.decided - 1),
    safe: Math.max(0, totals.safe - (verdict === 'safe' ? 1 : 0)),
    replace: Math.max(0, totals.replace - (verdict === 'replace' ? 1 : 0)),
    uninstall: Math.max(0, totals.uninstall - (verdict === 'uninstall' ? 1 : 0)),
    notesAdded: Math.max(0, totals.notesAdded - (hadNote ? 1 : 0)),
    skipped: totals.skipped,
  };
}

/**
 * Record a skip — advances the card without writing a verdict. `decided`
 * intentionally NOT incremented because skips aren't decisions; they're
 * "come back later." Keeps the safe/replace/uninstall buckets accurate
 * to actual user intent.
 */
export function applySkip(totals: QueueSessionTotals): QueueSessionTotals {
  return { ...totals, skipped: totals.skipped + 1 };
}

/** Reverse a skip — only the skipped counter decrements. */
export function undoSkip(totals: QueueSessionTotals): QueueSessionTotals {
  return { ...totals, skipped: Math.max(0, totals.skipped - 1) };
}

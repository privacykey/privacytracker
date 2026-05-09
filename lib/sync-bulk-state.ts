/**
 * Durable state for the bulk App Store label sync (`runScheduledSync` /
 * `POST /api/sync/trigger`). Resume granularity is at the **app** boundary;
 * the in-progress app re-starts from scratch on resume. `fetchAndParseApp`
 * is safe to re-run because its write path is a single `db.transaction`
 * and the snapshot/diff chain dedupes on identical JSON. Apple 429s are
 * not crash-state — the scheduler clears the blob and the next 30-min
 * tick picks up pending apps.
 */

import { getSetting, setSetting } from './scheduler';
import db from './db';

/** Key under which the state blob lives in `app_settings`. */
const STATE_KEY = 'sync_bulk_state';

/** Cross-request lock key. */
export const SYNC_BULK_MUTEX_KEY = 'sync_running';

/** Bump when the persisted JSON shape changes incompatibly. */
const STATE_SCHEMA_VERSION = 1;

export type SyncQueueEntryStatus = 'pending' | 'in_progress' | 'done' | 'failed';

/** One per-app outcome category, mirrored up into run totals. */
export type SyncAppOutcome =
  | 'succeeded'     // fetchAndParseApp resolved, no error
  | 'changed'       // succeeded AND changesDetected (rolled up into `changes`)
  | 'failed'        // scrape threw, non-rate-limit
  | 'rate_limited'  // Apple 429 — handled by next scheduled tick, not by resume
  | 'skipped';      // app row had no URL at dequeue time

export interface SyncQueueEntry {
  appId: string;
  appName: string;
  url: string;
  status: SyncQueueEntryStatus;
  /** Epoch-ms when we flipped to in_progress. */
  startedAt?: number;
  /** Epoch-ms when processing finished. */
  finishedAt?: number;
  /** Short error message on failure (trimmed to keep the blob small). */
  error?: string;
  /** Final per-app outcome category (mirrored up into totals). */
  outcome?: SyncAppOutcome;
  /** Whether the scrape produced a privacy-label diff. */
  changesDetected?: boolean;
}

export interface SyncBulkTotals {
  attempted: number;
  succeeded: number;
  /** Subset of succeeded that actually produced a diff. */
  changes: number;
  failed: number;
  rateLimited: number;
  skipped: number;
}

/** Exported so the runner can seed a fresh run with zeros. */
export function zeroSyncTotals(): SyncBulkTotals {
  return {
    attempted: 0,
    succeeded: 0,
    changes: 0,
    failed: 0,
    rateLimited: 0,
    skipped: 0,
  };
}

export interface SyncBulkState {
  /** Schema version of the persisted blob. */
  version: number;
  /** UUID generated at the start of the run; changes on resume. */
  runId: string;
  /** Epoch-ms when the original run started. Survives resume. */
  startedAt: number;
  /**
   * How the run started.
   *   - `manual`     — user pressed "Sync now" in Settings.
   *   - `scheduled`  — 30-min ticker fired in `instrumentation.ts`.
   *   - `resume`     — server restarted mid-run; instrumentation re-spawned.
   */
  initiator: 'manual' | 'scheduled' | 'resume';
  /** Epoch-ms when state was last persisted. */
  updatedAt: number;
  /** Id of the app currently being processed (denormalised from queue). */
  currentAppId: string | null;
  /** The full app queue with per-app status. */
  queue: SyncQueueEntry[];
  /** Rolling totals across the whole run. */
  totals: SyncBulkTotals;
}

/**
 * Read + parse + validate the persisted state blob. Returns null on absent
 * key, invalid JSON, version mismatch, or missing fields. Never throws —
 * callers treat null as "nothing to resume".
 */
export function readSyncBulkState(): SyncBulkState | null {
  const raw = getSetting(STATE_KEY, '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.runId !== 'string' ||
      !Array.isArray(parsed.queue)
    ) {
      return null;
    }
    return parsed as SyncBulkState;
  } catch {
    return null;
  }
}

/** Persist the state blob. Refreshes `updatedAt` on every write. */
export function writeSyncBulkState(
  next: Omit<SyncBulkState, 'version' | 'updatedAt'> & {
    version?: number;
    updatedAt?: number;
  },
): void {
  const payload: SyncBulkState = {
    ...next,
    version: STATE_SCHEMA_VERSION,
    updatedAt: Date.now(),
  };
  setSetting(STATE_KEY, JSON.stringify(payload));
}

/** Remove the state blob. Called on clean completion / stale-heal. */
export function clearSyncBulkState(): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(STATE_KEY);
}

/** Acquire the cross-request mutex. Returns true if we got it. */
export function acquireSyncBulkMutex(): boolean {
  if (getSetting(SYNC_BULK_MUTEX_KEY) === 'true') return false;
  setSetting(SYNC_BULK_MUTEX_KEY, 'true');
  return true;
}

/** Release the mutex unconditionally. Safe to call even when not held. */
export function releaseSyncBulkMutex(): void {
  setSetting(SYNC_BULK_MUTEX_KEY, 'false');
}

/** Is the mutex currently claimed? */
export function isSyncBulkMutexHeld(): boolean {
  return getSetting(SYNC_BULK_MUTEX_KEY) === 'true';
}

/** Convenience: per-status counts so UI callers don't walk the queue. */
export function summariseSyncState(state: SyncBulkState): {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  failed: number;
  remaining: number;
} {
  let pending = 0;
  let inProgress = 0;
  let done = 0;
  let failed = 0;
  for (const entry of state.queue) {
    switch (entry.status) {
      case 'pending':
        pending++;
        break;
      case 'in_progress':
        inProgress++;
        break;
      case 'done':
        done++;
        break;
      case 'failed':
        failed++;
        break;
    }
  }
  return {
    total: state.queue.length,
    pending,
    inProgress,
    done,
    failed,
    remaining: pending + inProgress,
  };
}

/** Has the persisted state got anything left to do? */
export function hasSyncPendingWork(state: SyncBulkState | null): boolean {
  if (!state) return false;
  return state.queue.some(
    entry => entry.status === 'pending' || entry.status === 'in_progress',
  );
}

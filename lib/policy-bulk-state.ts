/**
 * Durable state for the bulk privacy-policy sync (`POST /api/policy/sync-all`).
 * Resume granularity is at the **app** boundary; on resume the in-progress
 * app re-starts from scratch. `syncPrivacyPolicyAnalysis` is safe to re-run
 * (text-hash check skips the AI call when unchanged; throttle hits return
 * prior state). `force`/`forceResummarise` flags are preserved across resume.
 */

import { getSetting, setSetting } from './scheduler';
import db from './db';

/** Key under which the state blob lives in `app_settings`. */
const STATE_KEY = 'policy_bulk_state';

/** Cross-request lock key. */
export const POLICY_BULK_MUTEX_KEY = 'policy_sync_running';

/** Bump when the persisted JSON shape changes incompatibly. */
const STATE_SCHEMA_VERSION = 1;

export type PolicyQueueEntryStatus = 'pending' | 'in_progress' | 'done' | 'failed';

/** One per-app outcome category, mirrored up into run totals. */
export type PolicyAppOutcome =
  | 'succeeded'   // analysis.status was 'ready' or 'source_ready'
  | 'failed'      // fetch_error / analysis_error / etc.
  | 'throttled'   // per-app scrape-throttle hit; prior state returned unchanged
  | 'skipped';    // app had no privacyPolicyUrl at dequeue time

export interface PolicyQueueEntry {
  appId: string;
  appName: string;
  policyUrl: string;
  status: PolicyQueueEntryStatus;
  /** Epoch-ms when we flipped to in_progress. */
  startedAt?: number;
  /** Epoch-ms when processing finished. */
  finishedAt?: number;
  /** Short error message on failure (trimmed to keep the blob small). */
  error?: string;
  /** Final per-app outcome category (mirrored up into totals). */
  outcome?: PolicyAppOutcome;
  /** The analysis row's `status` column at the moment we finished. */
  analysisStatus?: string;
}

export interface PolicyBulkTotals {
  attempted: number;
  succeeded: number;
  failed: number;
  throttled: number;
  skipped: number;
}

/** Exported so the runner can seed a fresh run with zeros. */
export function zeroPolicyTotals(): PolicyBulkTotals {
  return { attempted: 0, succeeded: 0, failed: 0, throttled: 0, skipped: 0 };
}

export interface PolicyBulkState {
  /** Schema version of the persisted blob. */
  version: number;
  /** UUID generated at the start of the run; changes on resume. */
  runId: string;
  /** Epoch-ms when the original run started. Survives resume. */
  startedAt: number;
  /** How the run started. `resume` means the server restarted mid-run. */
  initiator: 'manual' | 'automatic' | 'resume';
  /** Epoch-ms when state was last persisted. */
  updatedAt: number;
  /**
   * Bulk-sync phase. `fetch` re-fetches HTML and only re-summarises when
   * the text hash changed. `all` forces a fresh AI summary for every app.
   */
  phase: 'fetch' | 'all';
  /** Whether to bypass the per-app 1-hour scrape throttle. */
  force: boolean;
  /** Id of the app currently being processed (denormalised from queue). */
  currentAppId: string | null;
  /** The full app queue with per-app status. */
  queue: PolicyQueueEntry[];
  /** Rolling totals across the whole run. */
  totals: PolicyBulkTotals;
  /** Informational only — a resumed run always runs in background mode
   *  because the NDJSON stream to the original caller died with the process. */
  streamRequested: boolean;
}

/**
 * Read + parse + validate the persisted state blob. Returns null on absent
 * key, invalid JSON, version mismatch, or missing fields. Never throws —
 * callers treat null as "nothing to resume".
 */
export function readPolicyBulkState(): PolicyBulkState | null {
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
    return parsed as PolicyBulkState;
  } catch {
    return null;
  }
}

/** Persist the state blob. Refreshes `updatedAt` on every write. */
export function writePolicyBulkState(
  next: Omit<PolicyBulkState, 'version' | 'updatedAt'> & {
    version?: number;
    updatedAt?: number;
  },
): void {
  const payload: PolicyBulkState = {
    ...next,
    version: STATE_SCHEMA_VERSION,
    updatedAt: Date.now(),
  };
  setSetting(STATE_KEY, JSON.stringify(payload));
}

/** Remove the state blob. Called on clean completion / stale-heal. */
export function clearPolicyBulkState(): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(STATE_KEY);
}

/** Acquire the cross-request mutex. Returns true if we got it. */
export function acquirePolicyBulkMutex(): boolean {
  if (getSetting(POLICY_BULK_MUTEX_KEY) === 'true') return false;
  setSetting(POLICY_BULK_MUTEX_KEY, 'true');
  return true;
}

/** Release the mutex unconditionally. Safe to call even when not held. */
export function releasePolicyBulkMutex(): void {
  setSetting(POLICY_BULK_MUTEX_KEY, 'false');
}

/** Is the mutex currently claimed? */
export function isPolicyBulkMutexHeld(): boolean {
  return getSetting(POLICY_BULK_MUTEX_KEY) === 'true';
}

/** Convenience: per-status counts so UI callers don't walk the queue. */
export function summarisePolicyState(state: PolicyBulkState): {
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
export function hasPolicyPendingWork(state: PolicyBulkState | null): boolean {
  if (!state) return false;
  return state.queue.some(entry => entry.status === 'pending' || entry.status === 'in_progress');
}

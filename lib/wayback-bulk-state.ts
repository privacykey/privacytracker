/**
 * Durable state for the bulk Wayback import (`POST /api/wayback/import-all`).
 *
 * Persists the queue + running totals as JSON in `app_settings` under
 * key `wayback_bulk_state`. Writes happen at app boundaries (after each
 * `importAppHistory` call), so a server restart can resume with at most
 * one app's worth of re-work. The `wayback_import_running` mutex is
 * managed alongside the blob so they stay in lockstep.
 *
 * Resume granularity is the **app** boundary — `importAppHistory` is
 * safe to re-run (per-target dedup prevents duplicate rows, and Wayback
 * Save-Page-Now is idempotent).
 */

import { getSetting, setSetting } from './scheduler';
import db from './db';

/** Key under which the state blob lives in `app_settings`. */
const STATE_KEY = 'wayback_bulk_state';

/** Cross-request mutex; cleared on clean completion, resume, or stale-mutex healing. */
export const BULK_MUTEX_KEY = 'wayback_import_running';

/**
 * Bump when the persisted JSON shape changes. `readBulkState` discards
 * blobs with mismatched versions rather than crashing.
 */
const STATE_SCHEMA_VERSION = 2;

export type QueueEntryStatus = 'pending' | 'in_progress' | 'done' | 'failed';
export type WaybackBulkRunStatus =
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'cancel_requested';

export interface QueueEntry {
  appId: string;
  appName: string;
  status: QueueEntryStatus;
  /** Epoch-ms when we started processing; set when status flips to in_progress. */
  startedAt?: number;
  /** Epoch-ms when processing finished; set on done / failed. */
  finishedAt?: number;
  /** Short error message on failure (trimmed to avoid bloating the blob). */
  error?: string;
  // Per-app totals so the UI can show running stats without hitting activity_log.
  imported?: number;
  unchanged?: number;
  skipped?: number;
  failed?: number;
  snapshotsRequested?: number;
}

export interface WaybackBulkTotals {
  appsAttempted: number;
  appsWithImports: number;
  targetsAttempted: number;
  imported: number;
  unchanged: number;
  skipped: number;
  failed: number;
  snapshotsRequested: number;
}

export interface WaybackBulkState {
  /** Schema version of the persisted blob. */
  version: number;
  /** UUID generated at the start of the run; changes on resume. */
  runId: string;
  /** Epoch-ms when the original run started. Survives resume. */
  startedAt: number;
  /** How the run started. `resume` means the server restarted mid-run. */
  initiator: 'manual' | 'resume';
  /** Epoch-ms when state was last persisted. */
  updatedAt: number;
  /** Cooperative control state for pause/cancel/resume UI. */
  status: WaybackBulkRunStatus;
  /** Epoch-ms when a pause was requested, if any. */
  pauseRequestedAt?: number;
  /** Epoch-ms when the run was paused at an app boundary, if any. */
  pausedAt?: number;
  /** Epoch-ms when cancellation was requested, if any. */
  cancelRequestedAt?: number;
  /** Id of the app currently being processed (denormalised from queue). */
  currentAppId: string | null;
  /** The full app queue with per-app status. */
  queue: QueueEntry[];
  /** Rolling totals across the whole run. */
  totals: WaybackBulkTotals;
  /**
   * Whether the original caller requested `?stream=1`. Informational —
   * resumed runs always run buffered (the NDJSON stream died with the process).
   */
  streamRequested: boolean;
}

/** All-zero totals. Exported so the bulk loop can seed a fresh run. */
export function zeroTotals(): WaybackBulkTotals {
  return {
    appsAttempted: 0,
    appsWithImports: 0,
    targetsAttempted: 0,
    imported: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    snapshotsRequested: 0,
  };
}

/**
 * Read + parse + validate the persisted state blob. Returns null when the
 * key is absent, the JSON is invalid, the schema version mismatches, or
 * required fields are missing. Never throws — treat null as "nothing to resume".
 */
export function readBulkState(): WaybackBulkState | null {
  const raw = getSetting(STATE_KEY, '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed.version !== 1 && parsed.version !== STATE_SCHEMA_VERSION) ||
      typeof parsed.runId !== 'string' ||
      !Array.isArray(parsed.queue)
    ) {
      return null;
    }
    // v1 blobs predate pause/cancel controls. Keep them resumable by treating
    // them as running until the next write upgrades the persisted version.
    const status = normaliseRunStatus(parsed.status);
    return {
      ...parsed,
      version: STATE_SCHEMA_VERSION,
      status,
    } as WaybackBulkState;
  } catch {
    return null;
  }
}

/**
 * Persist the state blob atomically (better-sqlite3 is synchronous).
 * Refreshes `updatedAt` to current wall-clock.
 */
export function writeBulkState(next: Omit<WaybackBulkState, 'version' | 'updatedAt' | 'status'> & {
  version?: number;
  status?: WaybackBulkRunStatus;
  updatedAt?: number;
}): void {
  const payload: WaybackBulkState = {
    ...next,
    version: STATE_SCHEMA_VERSION,
    status: normaliseRunStatus(next.status),
    updatedAt: Date.now(),
  };
  setSetting(STATE_KEY, JSON.stringify(payload));
}

/**
 * Remove the state blob. Called on clean completion or when the healer
 * detects a stale blob with no pending work.
 */
export function clearBulkState(): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(STATE_KEY);
}

/** Acquire the cross-request mutex. Returns true if we got it. */
export function acquireBulkMutex(): boolean {
  if (getSetting(BULK_MUTEX_KEY) === 'true') return false;
  setSetting(BULK_MUTEX_KEY, 'true');
  return true;
}

/** Release the mutex unconditionally. Safe to call even when not held. */
export function releaseBulkMutex(): void {
  setSetting(BULK_MUTEX_KEY, 'false');
}

/** Is the mutex currently claimed? */
export function isBulkMutexHeld(): boolean {
  return getSetting(BULK_MUTEX_KEY) === 'true';
}

/** Return counts so callers don't need to walk the queue manually. */
export function summariseState(state: WaybackBulkState): {
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

/**
 * Has the persisted state got anything left to do? An `in_progress` entry
 * from a previous process counts as pending on resume.
 */
export function hasPendingWork(state: WaybackBulkState | null): boolean {
  if (!state) return false;
  return state.queue.some(entry => entry.status === 'pending' || entry.status === 'in_progress');
}

/** Paused queues are user-controlled and should not auto-resume on startup. */
export function isBulkStatePaused(state: WaybackBulkState | null): boolean {
  return state?.status === 'paused' || state?.status === 'pause_requested';
}

/** Cancel-requested queues should be cleared rather than auto-resumed. */
export function isBulkStateCancellationRequested(state: WaybackBulkState | null): boolean {
  return state?.status === 'cancel_requested';
}

/** Pending work that should be resumed by the startup hook. */
export function shouldAutoResumeBulkState(state: WaybackBulkState | null): boolean {
  return hasPendingWork(state) && !isBulkStatePaused(state) && !isBulkStateCancellationRequested(state);
}

function normaliseRunStatus(raw: unknown): WaybackBulkRunStatus {
  return raw === 'pause_requested' ||
    raw === 'paused' ||
    raw === 'cancel_requested' ||
    raw === 'running'
    ? raw
    : 'running';
}

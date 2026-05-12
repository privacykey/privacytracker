/**
 * Client-side runtime diagnostics — a counterpart to lib/runtime-diagnostics.ts
 * for the renderer process.
 *
 * Captures three signals that the server-only diagnostics can't see:
 *   1. Long tasks (main-thread work >50ms — the canonical "hang" signal).
 *   2. Fetch activity (in-flight requests + completed requests above a slow
 *      threshold). Surfaces "the API call took 4 s" type hangs.
 *   3. Import-event ring — named milestone events that import code paths
 *      mark so we can correlate hangs with what the app was doing.
 *
 * Everything is in-memory and process-local. A page reload wipes the rings.
 *
 * Bootstrap: `installClientDiagnostics()` runs at most once. Read accessors
 * (`getLongTasks`, `getFetchActivity`, `getImportEvents`) are sub-ms and
 * safe to call from a polling effect.
 */

const LONG_TASK_RING_SIZE = 200;
const FETCH_ACTIVITY_RING_SIZE = 200;
const IMPORT_EVENT_RING_SIZE = 500;

/** Main-thread tasks at or above this duration are recorded. */
const LONG_TASK_THRESHOLD_MS = 50;

/** Fetches that take at least this long get recorded as "slow". */
const SLOW_FETCH_THRESHOLD_MS = 250;

/** Maximum URL length stored — protects against query-param soup. */
const URL_MAX_LEN = 256;

// ── Long-task ring ───────────────────────────────────────────────────────

export interface LongTaskRecord {
  /** Epoch ms at the END of the task (matches PerformanceEntry semantics). */
  at: number;
  /** Task duration in milliseconds. */
  durationMs: number;
  /** Source label — 'observer' when PerformanceObserver caught it, 'raf'
   *  when the rAF-gap fallback detected it. */
  source: 'observer' | 'raf';
}

const longTaskRing: Array<LongTaskRecord | undefined> = new Array(LONG_TASK_RING_SIZE);
let longTaskWriteIndex = 0;
let longTaskTotalCount = 0;

function recordLongTask(rec: LongTaskRecord): void {
  longTaskRing[longTaskWriteIndex % LONG_TASK_RING_SIZE] = rec;
  longTaskWriteIndex += 1;
  longTaskTotalCount += 1;
}

export function getLongTasks(limit = LONG_TASK_RING_SIZE): LongTaskRecord[] {
  return readRing(longTaskRing, longTaskWriteIndex, LONG_TASK_RING_SIZE, limit);
}

// ── Fetch activity ring ──────────────────────────────────────────────────

export type FetchPhase = 'inflight' | 'completed' | 'failed';

export interface FetchActivityRecord {
  /** Method + truncated URL (query string preserved up to URL_MAX_LEN). */
  method: string;
  url: string;
  /** Epoch ms at start. */
  startedAt: number;
  /** Wall-clock duration so far (in-flight) or final (completed/failed). */
  durationMs: number;
  phase: FetchPhase;
  /** HTTP status when known. 0 on network error. */
  status?: number;
  /** Truncated error message for failed fetches. */
  error?: string;
}

interface InflightEntry {
  id: number;
  method: string;
  url: string;
  startedAt: number;
}

const inflight = new Map<number, InflightEntry>();
let nextInflightId = 1;

const fetchRing: Array<FetchActivityRecord | undefined> = new Array(FETCH_ACTIVITY_RING_SIZE);
let fetchRingWriteIndex = 0;
let fetchSlowCount = 0;
let fetchFailedCount = 0;

function recordFetch(rec: FetchActivityRecord): void {
  fetchRing[fetchRingWriteIndex % FETCH_ACTIVITY_RING_SIZE] = rec;
  fetchRingWriteIndex += 1;
  if (rec.phase === 'failed') fetchFailedCount += 1;
  else if (rec.durationMs >= SLOW_FETCH_THRESHOLD_MS) fetchSlowCount += 1;
}

/**
 * Snapshot of fetch activity. Returns in-flight requests first (with
 * "live" durationMs at read time), then the most recent completed entries
 * up to the limit.
 */
export function getFetchActivity(limit = FETCH_ACTIVITY_RING_SIZE): {
  inflight: FetchActivityRecord[];
  recent: FetchActivityRecord[];
  slowCount: number;
  failedCount: number;
} {
  const now = Date.now();
  const inflightSnapshot: FetchActivityRecord[] = Array.from(inflight.values())
    .map(entry => ({
      method: entry.method,
      url: entry.url,
      startedAt: entry.startedAt,
      durationMs: now - entry.startedAt,
      phase: 'inflight' as const,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);
  const recent = readRing(fetchRing, fetchRingWriteIndex, FETCH_ACTIVITY_RING_SIZE, limit);
  return {
    inflight: inflightSnapshot,
    recent,
    slowCount: fetchSlowCount,
    failedCount: fetchFailedCount,
  };
}

// ── Import-event ring ────────────────────────────────────────────────────

export interface ImportEventRecord {
  /** Epoch ms. */
  at: number;
  /** Stable event name — e.g. 'queue.tick.start', 'scrape.done'. */
  name: string;
  /** Optional structured detail. Stringified at write time so the reader
   *  always gets a stable shape. */
  detail?: string;
}

const importEventRing: Array<ImportEventRecord | undefined> = new Array(IMPORT_EVENT_RING_SIZE);
let importEventWriteIndex = 0;

/**
 * Record a named import-flow event. Cheap (one allocation + ring write)
 * — safe to call from inside tight loops.
 */
export function recordImportEvent(name: string, detail?: Record<string, unknown> | string): void {
  if (!isClient()) return;
  importEventRing[importEventWriteIndex % IMPORT_EVENT_RING_SIZE] = {
    at: Date.now(),
    name,
    detail: detail === undefined
      ? undefined
      : typeof detail === 'string'
        ? detail.slice(0, 240)
        : safeStringify(detail).slice(0, 240),
  };
  importEventWriteIndex += 1;
}

export function getImportEvents(limit = IMPORT_EVENT_RING_SIZE): ImportEventRecord[] {
  return readRing(importEventRing, importEventWriteIndex, IMPORT_EVENT_RING_SIZE, limit);
}

// ── Aggregate snapshot ───────────────────────────────────────────────────

export interface ClientDiagnosticsSnapshot {
  generatedAt: number;
  installedAt: number | null;
  longTasks: {
    thresholdMs: number;
    totalSinceStart: number;
    recent: LongTaskRecord[];
  };
  fetches: {
    slowThresholdMs: number;
    inflight: FetchActivityRecord[];
    recent: FetchActivityRecord[];
    slowCount: number;
    failedCount: number;
  };
  importEvents: ImportEventRecord[];
  /** True when the longtask PerformanceObserver successfully attached.
   *  When false, the rAF-gap fallback is the only source of long-task data. */
  longTaskObserverActive: boolean;
}

let installedAt: number | null = null;
let longTaskObserverActive = false;

export function snapshotClientDiagnostics(): ClientDiagnosticsSnapshot {
  const fetchSnap = getFetchActivity();
  return {
    generatedAt: Date.now(),
    installedAt,
    longTasks: {
      thresholdMs: LONG_TASK_THRESHOLD_MS,
      totalSinceStart: longTaskTotalCount,
      recent: getLongTasks(),
    },
    fetches: {
      slowThresholdMs: SLOW_FETCH_THRESHOLD_MS,
      inflight: fetchSnap.inflight,
      recent: fetchSnap.recent,
      slowCount: fetchSnap.slowCount,
      failedCount: fetchSnap.failedCount,
    },
    importEvents: getImportEvents(),
    longTaskObserverActive,
  };
}

export function clearClientDiagnostics(): void {
  longTaskRing.fill(undefined);
  longTaskWriteIndex = 0;
  longTaskTotalCount = 0;
  fetchRing.fill(undefined);
  fetchRingWriteIndex = 0;
  fetchSlowCount = 0;
  fetchFailedCount = 0;
  importEventRing.fill(undefined);
  importEventWriteIndex = 0;
}

// ── Bootstrap ────────────────────────────────────────────────────────────

let installed = false;

/**
 * Install the long-task observer, wrap window.fetch, and start the rAF-gap
 * monitor. Idempotent and a no-op on the server side.
 */
export function installClientDiagnostics(): void {
  if (installed || !isClient()) return;
  installed = true;
  installedAt = Date.now();

  installLongTaskObserver();
  installFetchWrapper();
  installRafGapMonitor();
}

function installLongTaskObserver(): void {
  try {
    const PO = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver })
      .PerformanceObserver;
    if (!PO) return;
    const supported = (PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes('longtask')) return;
    const obs = new PO(list => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= LONG_TASK_THRESHOLD_MS) {
          recordLongTask({
            at: Date.now(),
            durationMs: Math.round(entry.duration * 100) / 100,
            source: 'observer',
          });
        }
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
    longTaskObserverActive = true;
  } catch {
    // WebKit before Safari 18 doesn't support 'longtask' — the rAF-gap
    // monitor is the fallback. No need to surface the error.
  }
}

function installFetchWrapper(): void {
  const original = window.fetch;
  if (typeof original !== 'function') return;
  // Mark the wrapped fn so a hot reload doesn't double-wrap.
  if ((original as unknown as { __ptDiagWrapped?: boolean }).__ptDiagWrapped) return;

  const wrapped: typeof fetch = async function (this: unknown, ...args) {
    const id = nextInflightId++;
    const [input, init] = args;
    const method = (init?.method || (typeof input !== 'string' && 'method' in input ? input.method : undefined) || 'GET')
      .toUpperCase();
    const rawUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const url = truncate(rawUrl, URL_MAX_LEN);
    const startedAt = Date.now();
    inflight.set(id, { id, method, url, startedAt });

    const t0 = performance.now();
    try {
      const res = await original.apply(this, args);
      const durationMs = Math.round(performance.now() - t0);
      const status = res.status;
      // Only persist completed fetches when they're slow or errored;
      // every fast successful call would flood the ring otherwise.
      if (durationMs >= SLOW_FETCH_THRESHOLD_MS || status >= 400) {
        recordFetch({ method, url, startedAt, durationMs, phase: 'completed', status });
      }
      return res;
    } catch (err) {
      const durationMs = Math.round(performance.now() - t0);
      recordFetch({
        method,
        url,
        startedAt,
        durationMs,
        phase: 'failed',
        status: 0,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
      throw err;
    } finally {
      inflight.delete(id);
    }
  };
  (wrapped as unknown as { __ptDiagWrapped: boolean }).__ptDiagWrapped = true;
  window.fetch = wrapped;
}

/**
 * rAF-gap monitor — measures wall-clock time between consecutive
 * requestAnimationFrame callbacks. A gap >> the display refresh interval
 * means the main thread was busy. This is the fallback for engines
 * without PerformanceObserver('longtask') support, AND it catches some
 * task types the observer misses (synchronous worker boots, etc.).
 *
 * To avoid duplicates with the observer, we only record gaps when the
 * observer is INACTIVE, OR when the gap is significantly larger than
 * the observer's last threshold-eligible task.
 */
function installRafGapMonitor(): void {
  if (typeof requestAnimationFrame !== 'function') return;
  let last = performance.now();
  const tick = (now: number) => {
    const gap = now - last;
    last = now;
    // 80ms is the rAF gap that maps to ~50ms of main-thread work after
    // subtracting the typical inter-frame gap. We only record when the
    // observer is off OR the gap is dramatically large (probable observer
    // miss).
    const threshold = longTaskObserverActive ? 200 : 80;
    if (gap >= threshold) {
      recordLongTask({
        at: Date.now(),
        durationMs: Math.round(gap * 100) / 100,
        source: 'raf',
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isClient(): boolean {
  return typeof window !== 'undefined';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '[unstringifiable]';
  }
}

/**
 * Walk a fixed-size ring buffer from oldest to newest, returning up to
 * `limit` of the most recent entries. Returns chronological order.
 */
function readRing<T>(
  ring: Array<T | undefined>,
  writeIndex: number,
  size: number,
  limit: number,
): T[] {
  const wrapped = writeIndex >= size;
  const start = wrapped ? writeIndex % size : 0;
  const liveCount = wrapped ? size : writeIndex;
  const want = Math.min(limit, liveCount);
  const out: T[] = [];
  for (let i = liveCount - want; i < liveCount; i++) {
    const slot = ring[(start + i) % size];
    if (slot !== undefined) out.push(slot);
  }
  return out;
}

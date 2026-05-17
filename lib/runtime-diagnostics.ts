/**
 * Runtime performance diagnostics. All state is in-memory and process-local
 * (a restart resets it). Provides:
 *
 *   1. snapshotRuntimeMetrics() — point-in-time read of memory, V8 heap,
 *      resource usage, and the event-loop-delay histogram. Sub-ms.
 *   2. An always-on event-loop-delay monitor (perf_hooks histogram).
 *   3. A slow-query ring buffer fed by a wrapper around better-sqlite3's
 *      `prepare()`. Records SQL (truncated), duration, and parameter count
 *      — never parameter values.
 */
import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import type Database from "better-sqlite3";

// ── Tunables ──────────────────────────────────────────────────────────

/** Queries above this duration get recorded. */
const SLOW_QUERY_THRESHOLD_MS = 50;

/** Number of slow-query records retained in the ring. */
const SLOW_QUERY_RING_SIZE = 200;

/** Max chars of SQL stored per record. */
const SLOW_QUERY_SQL_MAX_LEN = 240;

/** Event-loop-delay histogram sampling resolution (Node's recommended default). */
const EVENT_LOOP_RESOLUTION_MS = 20;

// ── Slow-query ring ──────────────────────────────────────────────────

export interface SlowQueryRecord {
  /** Epoch ms at the moment the query *finished*. */
  at: number;
  /** Wall-clock duration in milliseconds, rounded to 2 decimals. */
  durationMs: number;
  /** Truncated error message if the query threw. */
  error?: string;
  /** Statement method that produced the timing — `all` / `get` / `run` / `iterate`. */
  method: "all" | "get" | "run" | "iterate";
  /** Number of bound parameters, NOT their values. */
  paramCount: number;
  /** Truncated SQL — see {@link SLOW_QUERY_SQL_MAX_LEN}. */
  sql: string;
}

/**
 * Fixed-size ring buffer. `writeIndex` is tracked separately so
 * `getRecentSlowQueries` can return rows in chronological order regardless
 * of the ring's wrap point.
 */
const slowRing: Array<SlowQueryRecord | undefined> = new Array(
  SLOW_QUERY_RING_SIZE
);
let slowRingWriteIndex = 0;
/** Total number of slow queries observed since process start (or last clear). */
let slowQueryTotalCount = 0;

function recordSlowQuery(record: SlowQueryRecord): void {
  slowRing[slowRingWriteIndex % SLOW_QUERY_RING_SIZE] = record;
  slowRingWriteIndex += 1;
  slowQueryTotalCount += 1;
}

/** Return the most recent slow-query records, oldest first. */
export function getRecentSlowQueries(
  limit = SLOW_QUERY_RING_SIZE
): SlowQueryRecord[] {
  // Walk the ring from the oldest live slot forward.
  const wrapped = slowRingWriteIndex >= SLOW_QUERY_RING_SIZE;
  const start = wrapped ? slowRingWriteIndex % SLOW_QUERY_RING_SIZE : 0;
  const liveCount = wrapped ? SLOW_QUERY_RING_SIZE : slowRingWriteIndex;
  const want = Math.min(limit, liveCount);
  const out: SlowQueryRecord[] = [];
  for (let i = liveCount - want; i < liveCount; i++) {
    const slot = slowRing[(start + i) % SLOW_QUERY_RING_SIZE];
    if (slot) {
      out.push(slot);
    }
  }
  return out;
}

/** Clear the ring and reset the total count. */
export function clearSlowQueryRing(): void {
  slowRing.fill(undefined);
  slowRingWriteIndex = 0;
  slowQueryTotalCount = 0;
}

// ── Profiling toggle ─────────────────────────────────────────────────

/** Default ON outside tests. Overhead is one conditional per DB call. */
let profilingEnabled = process.env.NODE_ENV !== "test";

export function setProfilingEnabled(enabled: boolean): void {
  profilingEnabled = enabled;
}

export function isProfilingEnabled(): boolean {
  return profilingEnabled;
}

// ── DB instrumentation ───────────────────────────────────────────────

/**
 * Wrap a Statement so its row-returning methods record timing. Mutates the
 * Statement in place (rather than via Proxy) so chaining like
 * `db.prepare(sql).pluck()` keeps working. Calls pass straight through when
 * profiling is disabled.
 */
function wrapStatement(
  stmt: Database.Statement,
  sql: string
): Database.Statement {
  const truncatedSql =
    sql.length > SLOW_QUERY_SQL_MAX_LEN
      ? `${sql.slice(0, SLOW_QUERY_SQL_MAX_LEN - 1)}…`
      : sql;

  const wrap = <K extends "all" | "get" | "run" | "iterate">(method: K) => {
    const original = stmt[method];
    if (typeof original !== "function") {
      return;
    }
    (stmt as any)[method] = function (
      this: Database.Statement,
      ...args: unknown[]
    ) {
      if (!profilingEnabled) {
        return (original as any).apply(this, args);
      }
      const t0 = performance.now();
      try {
        const result = (original as any).apply(this, args);
        const durationMs = performance.now() - t0;
        if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
          recordSlowQuery({
            sql: truncatedSql,
            durationMs: Math.round(durationMs * 100) / 100,
            method,
            paramCount: args.length,
            at: Date.now(),
          });
        }
        return result;
      } catch (err) {
        const durationMs = performance.now() - t0;
        if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
          recordSlowQuery({
            sql: truncatedSql,
            durationMs: Math.round(durationMs * 100) / 100,
            method,
            paramCount: args.length,
            at: Date.now(),
            error:
              err instanceof Error
                ? err.message.slice(0, SLOW_QUERY_SQL_MAX_LEN)
                : String(err).slice(0, SLOW_QUERY_SQL_MAX_LEN),
          });
        }
        throw err;
      }
    };
  };

  wrap("all");
  wrap("get");
  wrap("run");
  wrap("iterate");

  return stmt;
}

let dbInstrumented = false;
/**
 * Patch `db.prepare()` so every prepared statement is wrapped at construction.
 * Idempotent — safe to call twice during dev hot reload.
 */
export function instrumentDatabase(rawDb: Database.Database): void {
  if (dbInstrumented) {
    return;
  }
  dbInstrumented = true;
  const originalPrepare = rawDb.prepare.bind(rawDb);
  const instrumentedPrepare = (sql: string): Database.Statement => {
    const stmt = originalPrepare(sql);
    return wrapStatement(stmt, sql);
  };
  (rawDb as any).prepare = instrumentedPrepare;
}

// ── Event-loop monitor ───────────────────────────────────────────────

let lagHistogram: IntervalHistogram | null = null;
/** Epoch ms when the histogram was started, so the UI can show an age. */
let lagHistogramStartedAt = 0;

/** Lazily start the event-loop-delay histogram. Idempotent. */
export function ensureEventLoopMonitor(): void {
  if (lagHistogram) {
    return;
  }
  lagHistogram = monitorEventLoopDelay({
    resolution: EVENT_LOOP_RESOLUTION_MS,
  });
  lagHistogram.enable();
  lagHistogramStartedAt = Date.now();
}

/** Reset the histogram. Re-enables collection so subsequent samples are captured. */
export function resetEventLoopMonitor(): void {
  if (!lagHistogram) {
    ensureEventLoopMonitor();
    return;
  }
  lagHistogram.reset();
  lagHistogramStartedAt = Date.now();
}

interface EventLoopSnapshot {
  maxMs: number;
  meanMs: number;
  /** All values are in milliseconds, so the UI doesn't need to scale ns. */
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Sample count over the window. */
  samples: number;
  /** p99 above 100ms is jank; above 1000ms is beach-balling. */
  severity: "ok" | "warn" | "danger";
  stddevMs: number;
  /** Wall-clock seconds the histogram has been collecting. */
  windowSeconds: number;
}

function snapshotEventLoop(): EventLoopSnapshot | null {
  if (!lagHistogram) {
    return null;
  }
  // perf_hooks histogram values are nanoseconds.
  const NS_PER_MS = 1e6;
  const p99Ms = lagHistogram.percentile(99) / NS_PER_MS;
  const severity: EventLoopSnapshot["severity"] =
    p99Ms >= 1000 ? "danger" : p99Ms >= 100 ? "warn" : "ok";
  return {
    windowSeconds: Math.max(
      0,
      Math.round((Date.now() - lagHistogramStartedAt) / 1000)
    ),
    // Older Node lacks `count`; `exceeds` is universal and a close-enough proxy.
    samples: lagHistogram.count ?? lagHistogram.exceeds ?? 0,
    minMs: lagHistogram.min / NS_PER_MS,
    meanMs: lagHistogram.mean / NS_PER_MS,
    maxMs: lagHistogram.max / NS_PER_MS,
    stddevMs: lagHistogram.stddev / NS_PER_MS,
    p50Ms: lagHistogram.percentile(50) / NS_PER_MS,
    p95Ms: lagHistogram.percentile(95) / NS_PER_MS,
    p99Ms,
    severity,
  };
}

// ── Snapshot helpers ─────────────────────────────────────────────────

export interface RuntimeMetrics {
  eventLoop: EventLoopSnapshot | null;
  generatedAt: string;
  /** Output of `process.memoryUsage()` with bytes formatted as MiB. */
  memory: {
    rssMb: number;
    heapTotalMb: number;
    heapUsedMb: number;
    externalMb: number;
    arrayBuffersMb: number;
  };
  /** `process.resourceUsage()` rolled up into the fields users care about. */
  resourceUsage: {
    userCpuSeconds: number;
    systemCpuSeconds: number;
    maxRssMb: number;
    minorPageFaults: number;
    majorPageFaults: number;
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
  };
  slowQueries: {
    thresholdMs: number;
    totalSinceStart: number;
    profilingEnabled: boolean;
    recent: SlowQueryRecord[];
  };
  uptimeSeconds: number;
  /** V8 heap statistics. `heapSizeLimit` is the V8 ceiling. */
  v8Heap: {
    totalHeapSizeMb: number;
    usedHeapSizeMb: number;
    heapSizeLimitMb: number;
    mallocedMemoryMb: number;
    externalMemoryMb: number;
    /** > 0.85 is a smell — GC of last resort. */
    heapFractionUsed: number;
  };
}

const BYTES_PER_MB = 1024 * 1024;
const toMb = (bytes: number) => Math.round((bytes / BYTES_PER_MB) * 100) / 100;

/**
 * Build the full runtime snapshot. Sub-ms — safe to poll frequently.
 * `recentSlowQueriesLimit` trims the payload for callers that don't need
 * the full ring (e.g. GitHub issue exports).
 */
export function snapshotRuntimeMetrics(
  recentSlowQueriesLimit = SLOW_QUERY_RING_SIZE
): RuntimeMetrics {
  const mem = process.memoryUsage();
  const rsrc = process.resourceUsage();
  const heap = getHeapStatistics();

  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMb: toMb(mem.rss),
      heapTotalMb: toMb(mem.heapTotal),
      heapUsedMb: toMb(mem.heapUsed),
      externalMb: toMb(mem.external),
      arrayBuffersMb: toMb(mem.arrayBuffers ?? 0),
    },
    v8Heap: {
      totalHeapSizeMb: toMb(heap.total_heap_size),
      usedHeapSizeMb: toMb(heap.used_heap_size),
      heapSizeLimitMb: toMb(heap.heap_size_limit),
      mallocedMemoryMb: toMb(heap.malloced_memory),
      externalMemoryMb: toMb(heap.external_memory),
      heapFractionUsed:
        heap.heap_size_limit > 0
          ? Math.round((heap.used_heap_size / heap.heap_size_limit) * 1000) /
            1000
          : 0,
    },
    resourceUsage: {
      // Node reports CPU times in microseconds; convert to seconds.
      userCpuSeconds: Math.round((rsrc.userCPUTime / 1_000_000) * 100) / 100,
      systemCpuSeconds:
        Math.round((rsrc.systemCPUTime / 1_000_000) * 100) / 100,
      // `maxRSS` is in kilobytes on Linux/macOS; convert to MB.
      maxRssMb: Math.round((rsrc.maxRSS / 1024) * 100) / 100,
      minorPageFaults: rsrc.minorPageFault,
      majorPageFaults: rsrc.majorPageFault,
      voluntaryContextSwitches: rsrc.voluntaryContextSwitches,
      involuntaryContextSwitches: rsrc.involuntaryContextSwitches,
    },
    eventLoop: snapshotEventLoop(),
    slowQueries: {
      thresholdMs: SLOW_QUERY_THRESHOLD_MS,
      totalSinceStart: slowQueryTotalCount,
      profilingEnabled,
      recent: getRecentSlowQueries(recentSlowQueriesLimit),
    },
  };
}

// ── Boot wiring ──────────────────────────────────────────────────────

/**
 * Single entry point for instrumentation.ts. Starts the event-loop monitor
 * and patches `db.prepare()`. Idempotent — safe to call twice.
 */
export function installRuntimeDiagnostics(rawDb: Database.Database): void {
  ensureEventLoopMonitor();
  instrumentDatabase(rawDb);
}

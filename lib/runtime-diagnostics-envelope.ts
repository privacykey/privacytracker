/**
 * The runtime-diagnostics envelope — the one wire shape behind
 * `GET /api/diagnostics/runtime`, the `runtime_diagnostics` block of
 * `GET /api/desktop/diagnostics`, the support bundle's `runtime`, and the
 * health check's `checks.runtime`.
 *
 * Why an envelope with `kind` tags rather than Node's raw shape: the Rust
 * core (`core/`) will serve this route from its own process, which has no
 * V8 heap, no event loop and no db-worker thread — but does have things
 * Node cannot measure (SQLite page-cache hit/miss, allocator stats, lock
 * wait on its single connection). Sections that exist on both backends
 * share names and units; sections that are backend-specific carry a
 * `kind` the Diagnostics page switches on; sections a backend cannot
 * provide are `null`, never zeros. The plain-JS validator in
 * `scripts/parity/diagnostics-envelope.mjs` is the executable form of this
 * contract and is what the parity harness holds BOTH backends to.
 *
 * Numbers are MiB for memory, milliseconds for durations, seconds for CPU
 * time and uptime. Every `recent` list is capped by `recentLimit`.
 */

import type { ApiTimingRecord } from "./api-timing";
import { snapshotApiTimings } from "./api-timing";
import type { DbWorkerTimingRecord } from "./db-worker-client";
import { snapshotDbWorkerTimings } from "./db-worker-client";
import type {
  LagSnapshot,
  ProcessMetrics,
  SlowQueriesSnapshot,
  V8HeapMetrics,
} from "./runtime-diagnostics";
import {
  snapshotProcess,
  snapshotSchedulerLag,
  snapshotSlowQueries,
  snapshotV8Heap,
  sqliteEngineVersion,
} from "./runtime-diagnostics";
import type { ScrapeActivitySnapshot } from "./scrape-activity";
import { snapshotScrapeActivity } from "./scrape-activity";
import { snapshotInboundRateLimiter } from "./security";

export const RUNTIME_DIAGNOSTICS_SCHEMA_VERSION = 2;

export type DiagnosticsBackend = "node" | "rust";

/** The Rust core's global-allocator counters — its answer to "how big is
 *  the heap". Never emitted by Node; typed here so the page can render it. */
export interface RustAllocatorMetrics {
  allocatedMb: number;
  kind: "rust-allocator";
  liveAllocations: number;
  peakMb: number;
}

export type HeapMetrics = V8HeapMetrics | RustAllocatorMetrics;

export interface SqliteMetrics {
  /** `sqlite3_db_status` page-cache counters — the "is it thrashing?" signal. */
  cache: {
    hits: number;
    misses: number;
    writes: number;
    spills: number;
  } | null;
  /** Node: one synchronous connection. Rust: one connection behind a mutex. */
  connectionModel: "single-sync" | "single-mutex";
  engine: "better-sqlite3" | "rusqlite";
  /** Time spent waiting for the connection. Node has nothing to wait on. */
  lockWait: LagSnapshot | null;
  /** `sqlite3_memory_used` and friends. better-sqlite3 exposes none of it. */
  memory: {
    usedMb: number;
    highwaterMb: number;
    pageCacheMb: number;
    schemaKb: number;
    statementsKb: number;
  } | null;
  /** `sqlite_version()`; null before the diagnostics were installed. */
  version: string | null;
}

export type SchedulerMetrics =
  | { kind: "event-loop"; lag: LagSnapshot | null }
  | {
      kind: "tokio";
      workers: number;
      aliveTasks: number;
      globalQueueDepth: number;
      lag: LagSnapshot | null;
    };

export interface HttpMetrics {
  /** Requests being served right now. Node's opt-in wrapper cannot know. */
  inFlight: number | null;
  recent: ApiTimingRecord[];
  slowSinceStart: number;
  thresholdMs: number;
  totalSinceStart: number;
}

export interface DbWorkerMetrics {
  failedSinceStart: number;
  inlineSinceStart: number;
  pendingRequests: number;
  recent: DbWorkerTimingRecord[];
  totalSinceStart: number;
  workerCached: boolean;
  workerDisabled: boolean;
  workerEnabled: boolean;
}

export interface RateLimiterMetrics {
  denialsSinceStart: number | null;
  trackedKeys: number;
}

export interface RuntimeDiagnostics {
  backend: DiagnosticsBackend;
  /** Node's db-worker thread. Null on a backend without one. */
  dbWorker: DbWorkerMetrics | null;
  generatedAt: string;
  heap: HeapMetrics;
  http: HttpMetrics;
  process: ProcessMetrics;
  rateLimiter: RateLimiterMetrics | null;
  scheduler: SchedulerMetrics;
  schemaVersion: typeof RUNTIME_DIAGNOSTICS_SCHEMA_VERSION;
  /** Null on a backend that has no scraper (the Rust core until Phase 3). */
  scrapeActivity: ScrapeActivitySnapshot | null;
  slowQueries: SlowQueriesSnapshot;
  sqlite: SqliteMetrics;
  uptimeSeconds: number;
}

export interface RuntimeDiagnosticsOptions {
  /** Cap on every `recent` list. 0 keeps the counters and drops the rows —
   *  what the health check and the GitHub-issue report want. */
  recentLimit?: number;
}

/**
 * Build the envelope from the Node process. Sub-ms; no DB I/O (the SQLite
 * version was read once at install). Callers that need the slow-query
 * wrapper live must have run `installRuntimeDiagnostics(db)` first —
 * instrumentation.ts does at boot.
 */
export function snapshotRuntimeDiagnostics(
  opts: RuntimeDiagnosticsOptions = {}
): RuntimeDiagnostics {
  const limit = opts.recentLimit;
  const http =
    limit === undefined ? snapshotApiTimings() : snapshotApiTimings(limit);
  const dbWorker =
    limit === undefined
      ? snapshotDbWorkerTimings()
      : snapshotDbWorkerTimings(limit);
  const scrapeActivity =
    limit === undefined
      ? snapshotScrapeActivity()
      : snapshotScrapeActivity(limit);
  return {
    backend: "node",
    schemaVersion: RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    process: snapshotProcess(),
    heap: snapshotV8Heap(),
    sqlite: {
      engine: "better-sqlite3",
      version: sqliteEngineVersion(),
      connectionModel: "single-sync",
      memory: null,
      cache: null,
      lockWait: null,
    },
    scheduler: { kind: "event-loop", lag: snapshotSchedulerLag() },
    http: { inFlight: null, ...http },
    slowQueries:
      limit === undefined ? snapshotSlowQueries() : snapshotSlowQueries(limit),
    dbWorker,
    scrapeActivity,
    rateLimiter: snapshotInboundRateLimiter(),
  };
}

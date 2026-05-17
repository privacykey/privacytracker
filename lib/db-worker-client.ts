/**
 * Main-thread client for the SQLite write worker.
 *
 * Lazily spawns a single `worker_threads` Worker on first use and forwards
 * bulk-write batches via postMessage. The worker is a singleton — it holds a
 * better-sqlite3 connection that's expensive to open, and re-spawning per
 * request would also fight with the main thread on WAL rotation. Crashes
 * trigger auto-respawn.
 *
 * The API is generic: callers build their own SQL + param arrays and post
 * them through `runBulkWrite()`. Domain logic stays close to call sites.
 *
 * Both main thread and worker hold writer connections; they serialise on
 * the WAL write lock with `busy_timeout=5000` handling contention.
 *
 * When `worker_threads` are unavailable or `WORKER_DISABLED=1`, falls back
 * transparently to inline execution on the main thread.
 */

import path from "node:path";
import db, { dbPath } from "./db";
import type {
  DbWorkerExecuteRequest,
  DbWorkerResponse,
  DbWorkerStatement,
} from "./db-worker-types";

// Lazy `worker_threads` import — top-level import would fail in build
// environments (e.g. edge runtime compile pass) that lack it.

interface WorkerLike {
  on: (
    event: "message" | "error" | "exit",
    listener: (...args: unknown[]) => void
  ) => void;
  postMessage: (msg: DbWorkerExecuteRequest) => void;
  terminate: () => Promise<number>;
  unref?: () => void;
}

interface PendingRequest {
  reject: (err: Error) => void;
  resolve: (response: DbWorkerResponse) => void;
}

export interface DbWorkerTimingRecord {
  /** Epoch ms when the batch finished or failed. */
  at: number;
  chunkSize: number | "infinity";
  /** Wall-clock duration observed by the caller, including message passing. */
  durationMs: number;
  error?: string;
  failedAtIndex?: number;
  inline: boolean;
  outcome: "ok" | "error";
  statementCount: number;
  totalChanges: number;
  /** Duration reported by the worker itself; absent for postMessage/spawn failures. */
  workerDurationMs?: number;
}

const DIAGNOSTIC_RING_SIZE = 200;
const diagnosticRing: Array<DbWorkerTimingRecord | undefined> = new Array(
  DIAGNOSTIC_RING_SIZE
);
let diagnosticWriteIndex = 0;
let diagnosticTotalCount = 0;
let diagnosticFailedCount = 0;
let diagnosticInlineCount = 0;

let cachedWorker: WorkerLike | null = null;
const pending = new Map<string, PendingRequest>();
let nextRequestId = 1;
let workerDisabled = false;

function normaliseChunkSize(chunkSize: number): number | "infinity" {
  return Number.isFinite(chunkSize) ? chunkSize : "infinity";
}

function recordDbWorkerTiming(record: DbWorkerTimingRecord): void {
  diagnosticRing[diagnosticWriteIndex % DIAGNOSTIC_RING_SIZE] = record;
  diagnosticWriteIndex += 1;
  diagnosticTotalCount += 1;
  if (record.outcome === "error") {
    diagnosticFailedCount += 1;
  }
  if (record.inline) {
    diagnosticInlineCount += 1;
  }
}

function getRecentDbWorkerTimings(
  limit = DIAGNOSTIC_RING_SIZE
): DbWorkerTimingRecord[] {
  const wrapped = diagnosticWriteIndex >= DIAGNOSTIC_RING_SIZE;
  const start = wrapped ? diagnosticWriteIndex % DIAGNOSTIC_RING_SIZE : 0;
  const liveCount = wrapped ? DIAGNOSTIC_RING_SIZE : diagnosticWriteIndex;
  const want = Math.min(limit, liveCount);
  const out: DbWorkerTimingRecord[] = [];
  for (let i = liveCount - want; i < liveCount; i += 1) {
    const slot = diagnosticRing[(start + i) % DIAGNOSTIC_RING_SIZE];
    if (slot) {
      out.push(slot);
    }
  }
  return out;
}

export function snapshotDbWorkerTimings(limit = DIAGNOSTIC_RING_SIZE): {
  totalSinceStart: number;
  failedSinceStart: number;
  inlineSinceStart: number;
  pendingRequests: number;
  workerEnabled: boolean;
  workerCached: boolean;
  workerDisabled: boolean;
  recent: DbWorkerTimingRecord[];
} {
  return {
    totalSinceStart: diagnosticTotalCount,
    failedSinceStart: diagnosticFailedCount,
    inlineSinceStart: diagnosticInlineCount,
    pendingRequests: pending.size,
    workerEnabled: isWorkerEnabled(),
    workerCached: cachedWorker !== null,
    workerDisabled,
    recent: getRecentDbWorkerTimings(limit),
  };
}

export function clearDbWorkerTimings(): void {
  diagnosticRing.fill(undefined);
  diagnosticWriteIndex = 0;
  diagnosticTotalCount = 0;
  diagnosticFailedCount = 0;
  diagnosticInlineCount = 0;
}

/**
 * Reasons to skip the worker and run inline: WORKER_DISABLED=1,
 * build-phase env (NEXT_PHASE=phase-production-build, BUILD_STANDALONE=1),
 * or a previous spawn attempt failed (re-tried on next process restart).
 */
function isWorkerEnabled(): boolean {
  if (workerDisabled) {
    return false;
  }
  if (process.env.WORKER_DISABLED === "1") {
    return false;
  }
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return false;
  }
  if (process.env.BUILD_STANDALONE === "1") {
    return false;
  }
  return true;
}

function spawnWorker(): WorkerLike | null {
  let workerThreads: typeof import("node:worker_threads");
  try {
    // Node-only API; require keeps it out of bundler static analysis.
    workerThreads = require("node:worker_threads");
  } catch {
    workerDisabled = true;
    return null;
  }
  try {
    // Resolve the worker file across dev (repo lib/) and standalone bundle
    // (lib/db-worker.cjs copied next to the standalone root by
    // scripts/stage-standalone.mjs). Webpack would rewrite a bare
    // `require.resolve()`, so probe via fs.existsSync against a small
    // closed set of well-known paths.
    //
    // Security note: a previous iteration of this code probed
    // `process.cwd()/lib/db-worker.cjs` unconditionally, which would
    // let a local attacker who could write to the launch cwd plant a
    // malicious worker before the first bulk write. We mitigate that
    // here by canonicalising every candidate via `fs.realpathSync` and
    // refusing anything outside one of two known-good base dirs:
    // `__dirname` (the running bundle) or the Tauri-sidecar cwd
    // (`process.cwd()`, set by the shell to the standalone root —
    // a read-only resource directory in shipped builds, the repo
    // root in dev). Both are server-controlled; neither is reachable
    // by a low-privilege attacker who doesn't already have write
    // access to a trusted location.
    const fs = require("node:fs");
    const candidates = [
      path.join(import.meta.dirname, "db-worker.cjs"),
      path.join(process.cwd(), "lib", "db-worker.cjs"),
      path.join(process.cwd(), "db-worker.cjs"),
    ];
    const allowedBases = [import.meta.dirname, process.cwd()].map((p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    });
    const workerPath = candidates.find((p) => {
      try {
        if (!fs.existsSync(p)) {
          return false;
        }
        const real = fs.realpathSync(p);
        return allowedBases.some(
          (base) => real.startsWith(base + path.sep) || real === base
        );
      } catch {
        return false;
      }
    });
    if (!workerPath) {
      throw new Error(
        `db-worker.cjs not found. Looked in: ${candidates.join(", ")}. ` +
          "In standalone builds, scripts/stage-standalone.mjs is responsible for " +
          "copying lib/db-worker.cjs into the bundle."
      );
    }
    const w = new workerThreads.Worker(workerPath, {
      workerData: { dbPath },
    }) as unknown as WorkerLike;
    w.on("message", (raw: unknown) => {
      const response = raw as DbWorkerResponse;
      if (
        !response ||
        typeof response !== "object" ||
        typeof response.requestId !== "string"
      ) {
        console.warn(
          "[db-worker-client] received malformed worker message",
          response
        );
        return;
      }
      const slot = pending.get(response.requestId);
      if (!slot) {
        // Stray response — request already rejected by an exit event. Drop.
        return;
      }
      pending.delete(response.requestId);
      slot.resolve(response);
    });
    w.on("error", (err: unknown) => {
      // Worker-level error — reject every in-flight request, mark worker
      // dead so the next call respawns.
      console.error("[db-worker-client] worker error event:", err);
      const error = err instanceof Error ? err : new Error(String(err));
      for (const slot of pending.values()) {
        slot.reject(error);
      }
      pending.clear();
      cachedWorker = null;
    });
    w.on("exit", (code: unknown) => {
      // Unexpected exit — same handling as `error`.
      if (code !== 0) {
        console.warn(`[db-worker-client] worker exited with code ${code}`);
      }
      const error = new Error(`db worker exited with code ${code}`);
      for (const slot of pending.values()) {
        slot.reject(error);
      }
      pending.clear();
      cachedWorker = null;
    });
    w.unref?.();
    return w;
  } catch (err) {
    console.error(
      "[db-worker-client] spawn failed, falling back to inline execution:",
      err
    );
    workerDisabled = true;
    return null;
  }
}

function getWorker(): WorkerLike | null {
  if (!isWorkerEnabled()) {
    return null;
  }
  if (cachedWorker !== null) {
    return cachedWorker;
  }
  cachedWorker = spawnWorker();
  return cachedWorker;
}

/**
 * Inline fallback executor. Mirrors the worker's chunked-transaction
 * model. Blocks the event loop — keep real bulk paths on the worker.
 */
function executeInline(
  statements: DbWorkerStatement[],
  chunkSize: number
): DbWorkerResponse {
  // `db` is statically imported at the top of this file. We used to
  // `require('./db').default` here under a "lazy load" rationale, but
  // (a) the static import of `dbPath` above already triggers the
  // module's side effects (better-sqlite3 connection, CREATE TABLE,
  // migrations) at load time, so deferral was always cosmetic, and
  // (b) the `.default` lookup occasionally yielded `undefined` under
  // Next 16's webpack CJS/ESM interop, manifesting as the runtime
  // error "Cannot read properties of undefined (reading 'prepare')"
  // when the worker had been disabled and writes fell through to
  // this inline path. Using the static import removes the
  // interop variable from the failure mode.
  if (statements.length === 0) {
    return {
      kind: "execute-ok",
      requestId: "inline",
      totalChanges: 0,
      durationMs: 0,
    };
  }
  const startedAt = Date.now();
  let totalChanges = 0;
  let cursor = 0;
  while (cursor < statements.length) {
    const end = Math.min(cursor + chunkSize, statements.length);
    const start = cursor;
    const runChunk = db.transaction(() => {
      let chunkChanges = 0;
      for (let i = start; i < end; i += 1) {
        const s = statements[i];
        try {
          const stmt = db.prepare(s.sql);
          const result = Array.isArray(s.params)
            ? stmt.run(...(s.params as unknown[]))
            : stmt.run(s.params as Record<string, unknown>);
          chunkChanges += result.changes || 0;
        } catch (e) {
          const wrapped = new Error(e instanceof Error ? e.message : String(e));
          (wrapped as Error & { failedAtIndex: number }).failedAtIndex = i;
          throw wrapped;
        }
      }
      return chunkChanges;
    });
    try {
      totalChanges += runChunk();
    } catch (e) {
      return {
        kind: "execute-error",
        requestId: "inline",
        error: e instanceof Error ? e.message : String(e),
        failedAtIndex:
          typeof (e as { failedAtIndex?: unknown })?.failedAtIndex === "number"
            ? (e as { failedAtIndex: number }).failedAtIndex
            : start,
      };
    }
    cursor = end;
  }
  return {
    kind: "execute-ok",
    requestId: "inline",
    totalChanges,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Run a batch of write statements off the main thread.
 *
 * Statements run in chunked transactions of `chunkSize` (default 200);
 * each chunk is atomic and earlier chunks remain durable if a later
 * chunk throws. Pass `chunkSize: Infinity` to force a single transaction
 * (defeats lock-time mitigation — use sparingly).
 *
 * Resolves `{ totalChanges, durationMs }` on success; rejects with the
 * first statement error (carrying `failedAtIndex`) on failure.
 */
export async function runBulkWrite(
  statements: DbWorkerStatement[],
  options: { chunkSize?: number } = {}
): Promise<{ totalChanges: number; durationMs: number }> {
  const chunkSize = options.chunkSize ?? 200;
  const startedAt = performance.now();
  const statementCount = statements.length;

  const worker = getWorker();
  if (!worker) {
    // Inline path. Wrap in a Promise so the API shape stays consistent.
    const response = executeInline(statements, chunkSize);
    const durationMs = Math.round(performance.now() - startedAt);
    if (response.kind === "execute-ok") {
      recordDbWorkerTiming({
        at: Date.now(),
        statementCount,
        chunkSize: normaliseChunkSize(chunkSize),
        durationMs,
        workerDurationMs: response.durationMs,
        totalChanges: response.totalChanges,
        inline: true,
        outcome: "ok",
      });
      return {
        totalChanges: response.totalChanges,
        durationMs: response.durationMs,
      };
    }
    recordDbWorkerTiming({
      at: Date.now(),
      statementCount,
      chunkSize: normaliseChunkSize(chunkSize),
      durationMs,
      totalChanges: 0,
      inline: true,
      outcome: "error",
      failedAtIndex: response.failedAtIndex,
      error: response.error.slice(0, 240),
    });
    const err = new Error(response.error);
    (err as Error & { failedAtIndex: number }).failedAtIndex =
      response.failedAtIndex;
    throw err;
  }

  // Worker path. Mint a unique request id and await the matching response.
  const requestId = `req-${nextRequestId++}-${Date.now().toString(36)}`;
  return new Promise((resolve, reject) => {
    const rejectWithTiming = (err: Error) => {
      recordDbWorkerTiming({
        at: Date.now(),
        statementCount,
        chunkSize: normaliseChunkSize(chunkSize),
        durationMs: Math.round(performance.now() - startedAt),
        totalChanges: 0,
        inline: false,
        outcome: "error",
        error: err.message.slice(0, 240),
      });
      reject(err);
    };
    pending.set(requestId, {
      resolve: (response) => {
        const durationMs = Math.round(performance.now() - startedAt);
        if (response.kind === "execute-ok") {
          recordDbWorkerTiming({
            at: Date.now(),
            statementCount,
            chunkSize: normaliseChunkSize(chunkSize),
            durationMs,
            workerDurationMs: response.durationMs,
            totalChanges: response.totalChanges,
            inline: false,
            outcome: "ok",
          });
          resolve({
            totalChanges: response.totalChanges,
            durationMs: response.durationMs,
          });
        } else {
          recordDbWorkerTiming({
            at: Date.now(),
            statementCount,
            chunkSize: normaliseChunkSize(chunkSize),
            durationMs,
            totalChanges: 0,
            inline: false,
            outcome: "error",
            failedAtIndex: response.failedAtIndex,
            error: response.error.slice(0, 240),
          });
          const err = new Error(response.error);
          (err as Error & { failedAtIndex: number }).failedAtIndex =
            response.failedAtIndex;
          reject(err);
        }
      },
      reject: rejectWithTiming,
    });
    try {
      worker.postMessage({
        kind: "execute",
        requestId,
        statements,
        chunkSize,
      });
    } catch (err) {
      // postMessage can throw on serialisation failures (e.g. BigInt).
      pending.delete(requestId);
      rejectWithTiming(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Test-only: tear down the cached worker so the next call respawns. */
export async function _resetDbWorker(): Promise<void> {
  if (cachedWorker !== null) {
    try {
      await cachedWorker.terminate();
    } catch {
      // ignore — best-effort cleanup
    }
    cachedWorker = null;
  }
  for (const slot of pending.values()) {
    slot.reject(new Error("db worker reset"));
  }
  pending.clear();
  workerDisabled = false;
  clearDbWorkerTimings();
}

/**
 * Shared message types for the SQLite write worker (lib/db-worker.cjs).
 * The worker runs in a `worker_threads` thread with its own better-sqlite3
 * connection. This file is the single source of truth for the wire format —
 * the CJS worker re-declares the same shapes; update both together.
 */

/**
 * One SQL statement. `params` matches better-sqlite3's bound-parameter shape:
 * positional `?` from an array, named `:foo` from an object. Mixed-shape
 * params in one batch are fine.
 */
export interface DbWorkerStatement {
  /** Bound parameters. Use [] for parameter-less statements. */
  params: readonly unknown[] | Record<string, unknown>;
  /** Prepared SQL. Cached on the worker side by exact string match. */
  sql: string;
}

/**
 * "Run these statements in a transaction" request. When `chunkSize` is set
 * and statements.length > chunkSize, the worker splits into multiple
 * transactions of `chunkSize` each to cap write-lock hold time. On any
 * statement error, rolls back the *current chunk* and replies with a typed
 * error — earlier chunks remain durable (atomic per chunk).
 */
export interface DbWorkerExecuteRequest {
  /** Rows per inner transaction. Defaults to 200 in the worker.
   *  Use Infinity to force a single transaction over all statements. */
  chunkSize?: number;
  kind: "execute";
  /** Correlation id. Must be unique per in-flight request. */
  requestId: string;
  statements: DbWorkerStatement[];
}

export type DbWorkerRequest = DbWorkerExecuteRequest;

/** Successful execution. */
export interface DbWorkerOkResponse {
  /** Wall-clock ms spent in `execute()`. Excludes message-passing latency. */
  durationMs: number;
  kind: "execute-ok";
  requestId: string;
  /** Total `changes` across all statements (summed). */
  totalChanges: number;
}

/** Failed execution. */
export interface DbWorkerErrorResponse {
  /** Stringified error message from better-sqlite3 (or 'unknown error'). */
  error: string;
  /** Index in the original `statements` array where the failure happened. */
  failedAtIndex: number;
  kind: "execute-error";
  requestId: string;
}

export type DbWorkerResponse = DbWorkerOkResponse | DbWorkerErrorResponse;

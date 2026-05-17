"use strict";

/**
 * SQLite write worker — runs in a Node `worker_threads` thread.
 *
 * Why this file exists: better-sqlite3 is synchronous by design (see
 * CLAUDE.md), and a bulk write of 200+ rows blocks the main event
 * loop for hundreds of milliseconds. While blocked, Node's HTTP
 * server (the standalone Next sidecar) can't respond to other
 * requests, which makes the Tauri webview appear frozen. This worker
 * owns its own better-sqlite3 connection to the same `privacy.db`
 * file (WAL mode supports multi-connection writers, serialised on
 * the write lock). Bulk writes happen here; the main thread stays
 * responsive.
 *
 * Wire format: a single `execute` request kind that takes an array
 * of {sql, params} and runs them inside chunked transactions. The
 * worker has no domain knowledge — call sites build their own SQL
 * and post it. See `lib/db-worker-types.ts` for the typed shape.
 *
 * Lifecycle:
 *   - Spawned lazily on first call from `lib/db-worker-client.ts`.
 *   - Kept alive for the process lifetime (avoids per-job spawn cost).
 *   - Killed automatically when the parent process exits.
 *
 * On crash: the client side restarts the worker on `exit` and rejects
 * any in-flight requests. Crashes are rare (better-sqlite3 errors
 * become rejected promises, not thread crashes), so this is a
 * defence-in-depth path rather than a hot path.
 *
 * This file is intentionally CommonJS (.cjs) so it ships as-is in
 * the standalone bundle without webpack interference. It's referenced
 * by absolute path from db-worker-client, which inlines it via
 * `new Worker(path.join(...), {...})`. The standalone build copies
 * lib/db-worker.cjs to the same lib/ folder it lives in during dev,
 * so `require.resolve('./db-worker.cjs')` works in both worlds.
 */

const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");

if (!parentPort) {
  // Defensive: module was require'd outside a Worker context. The
  // client never does this; this guard is purely to surface the
  // mistake clearly in development if someone runs the file directly.
  throw new Error(
    "lib/db-worker.cjs must be loaded as a worker_threads Worker"
  );
}

// ── Database connection (lazy) ─────────────────────────────────────
//
// Open on first use (defers the cost until we actually have work),
// reuse for the worker's lifetime. Pragmas mirror lib/db.ts EXCEPT
// we deliberately do NOT run migrations here — the main thread
// already migrated the schema before spawning us, and re-running
// CREATE TABLE IF NOT EXISTS / ALTER TABLE from a second connection
// would race with the main thread's startup path.

const dbPath = workerData?.dbPath || null;
if (typeof dbPath !== "string" || dbPath.length === 0) {
  throw new Error("db-worker spawned without a dbPath in workerData");
}

let db = null;
function getDb() {
  if (db !== null) {
    return db;
  }
  db = new Database(dbPath);
  // Same pragmas as the main thread — they're per-connection settings,
  // not file-level, so the worker has to set them on its own connection.
  // WAL: enables concurrent reads + a single writer, which is exactly
  // the topology we want (main thread reads + small writes, worker
  // does bulk writes).
  // busy_timeout: when our writer blocks behind the main thread's,
  // wait up to 5s before throwing SQLITE_BUSY.
  // foreign_keys: parity with the main thread; otherwise FK
  // constraints written through this connection would silently pass.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  // Defensive schema bootstrap. The main thread runs the full schema
  // setup in lib/db.ts and we deliberately don't re-run migrations
  // here, but real-world reports of "no such table: import_items"
  // surfaced when the worker's view of the schema was somehow out of
  // sync — possibly a stale standalone bundle whose main-thread
  // setup didn't include the table, or a connection that observed
  // the DB file before the main thread's CREATE TABLE landed.
  //
  // The safest mitigation is to run CREATE TABLE IF NOT EXISTS for
  // each table the worker writes to. It's idempotent (the main
  // thread will already have created the table 99% of the time, in
  // which case this is a no-op) and the column list MUST stay in
  // sync with lib/db.ts. Migrations (ALTER TABLE …) stay on the
  // main thread — adding columns here would race the main thread's
  // own ALTER, which is the original reason migrations were
  // centralised. If you add a new column to a table the worker
  // writes to, do it in lib/db.ts AND here.
  bootstrapWorkerSchema(db);
  return db;
}

/**
 * Mirror of the CREATE TABLE statements for every table the worker
 * writes to via `runBulkWrite`. Kept minimal — just enough to make
 * the INSERT / UPDATE / DELETE statements the worker receives
 * resolve. Migrations (ALTER TABLE) are the main thread's job, so a
 * table created here will be brought up to spec by the next main-
 * thread boot.
 *
 * Source-of-truth: lib/db.ts. Drift between the two would cause
 * "no such column" errors at runtime, so when you update the
 * schema there, update the matching block here.
 */
function bootstrapWorkerSchema(connection) {
  // The CREATE statements below combine the lib/db.ts initial CREATE
  // with all the ALTER-TABLE migration columns inline. New installs
  // would land on the same shape; existing installs already have
  // these columns via the main thread's migrations, in which case
  // CREATE TABLE IF NOT EXISTS is a no-op. If you add a migration in
  // lib/db.ts, fold the column into the corresponding CREATE here
  // so a freshly-bootstrapped worker schema accepts the same
  // INSERTs the main thread does.
  connection.exec(`
    CREATE TABLE IF NOT EXISTS imports (
      id            TEXT PRIMARY KEY,
      created_at    INTEGER NOT NULL,
      completed_at  INTEGER,
      source        TEXT NOT NULL,
      source_label  TEXT,
      total         INTEGER NOT NULL DEFAULT 0,
      matched       INTEGER NOT NULL DEFAULT 0,
      unmatched     INTEGER NOT NULL DEFAULT 0,
      imported      INTEGER NOT NULL DEFAULT 0,
      device_id     TEXT
    );

    CREATE TABLE IF NOT EXISTS import_items (
      id              TEXT PRIMARY KEY,
      import_id       TEXT NOT NULL,
      query           TEXT NOT NULL,
      edited_query    TEXT,
      status          TEXT NOT NULL,
      app_id          TEXT,
      app_name        TEXT,
      developer       TEXT,
      url             TEXT,
      icon_url        TEXT,
      country         TEXT,
      scrape_error    TEXT,
      removed_app_id  TEXT,
      next_attempt_at INTEGER,
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_import_items_import ON import_items(import_id);
    CREATE INDEX IF NOT EXISTS idx_import_items_queue
      ON import_items(status, next_attempt_at)
      WHERE status = 'queued';
  `);
}

// ── Prepared-statement cache ──────────────────────────────────────
//
// better-sqlite3's `prepare(sql)` is fast but not free; on a bulk
// import that issues the same INSERT 200 times, caching pays off.
// Capped to LRU(256) so a long-running session doesn't accumulate
// statements forever. 256 is generous — the entire app uses well
// under 100 distinct SQL strings.

const STMT_CACHE_LIMIT = 256;
const stmtCache = new Map();

function getStmt(sql) {
  const cached = stmtCache.get(sql);
  if (cached) {
    // LRU bump: re-insert to mark as recently used.
    stmtCache.delete(sql);
    stmtCache.set(sql, cached);
    return cached;
  }
  const stmt = getDb().prepare(sql);
  stmtCache.set(sql, stmt);
  if (stmtCache.size > STMT_CACHE_LIMIT) {
    // Evict oldest entry. Map iteration order is insertion order,
    // so the first key is the LRU after a delete-and-re-insert
    // pattern above.
    const oldestKey = stmtCache.keys().next().value;
    if (oldestKey !== undefined) {
      stmtCache.delete(oldestKey);
    }
  }
  return stmt;
}

// ── Execute handler ──────────────────────────────────────────────

const DEFAULT_CHUNK_SIZE = 200;

/**
 * Run an array of statements inside one or more transactions.
 *
 * Chunking strategy: we split the input into groups of chunkSize and
 * run each group inside its own `db.transaction(...)`. This caps the
 * time SQLite holds the write lock per transaction, which lets the
 * main thread's reads + small writes interleave instead of queueing
 * behind a 5000-row bulk insert. Each chunk is atomic on its own —
 * if statement N fails, chunk N's prior statements roll back, but
 * earlier chunks (N-1, N-2…) stay durable. This matches the existing
 * "chunked transactions are atomic per chunk" model used by the
 * bulk runners and is BETTER than a single big tx for our case
 * (partial progress > total loss after a crash mid-bulk).
 *
 * Returns the same shape on success or error. The caller's promise
 * resolves on success and rejects on error.
 */
function executeBatch(req) {
  const { statements, chunkSize: rawChunkSize } = req;
  const chunkSize =
    Number.isFinite(rawChunkSize) && rawChunkSize > 0
      ? rawChunkSize
      : DEFAULT_CHUNK_SIZE;
  if (!Array.isArray(statements) || statements.length === 0) {
    return {
      kind: "execute-ok",
      requestId: req.requestId,
      totalChanges: 0,
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  let totalChanges = 0;
  // Track absolute index into the original `statements` array so an
  // error reports the right offset regardless of which chunk it lived in.
  let cursor = 0;

  while (cursor < statements.length) {
    const end = Math.min(cursor + chunkSize, statements.length);
    const chunkStartIndex = cursor;

    // db.transaction wraps the function in BEGIN/COMMIT/ROLLBACK.
    // Throwing inside rolls back; returning normally commits.
    const runChunk = getDb().transaction(() => {
      let chunkChanges = 0;
      for (let i = chunkStartIndex; i < end; i += 1) {
        const stmt = statements[i];
        try {
          const prepared = getStmt(stmt.sql);
          // better-sqlite3 accepts both array and object for params.
          // We just spread arrays for the positional-? case to match
          // the (?,?,?) call style; objects are passed as-is for the
          // :name binding case.
          const result = Array.isArray(stmt.params)
            ? prepared.run(...stmt.params)
            : prepared.run(stmt.params);
          // run() returns { changes, lastInsertRowid }.
          chunkChanges += result.changes || 0;
        } catch (e) {
          // Rethrow with the original error's message so the caller
          // can pinpoint which statement broke. We attach the index
          // to a property so the outer catch can build the response.
          const wrapped = new Error(
            `db-worker statement ${i} failed: ${e?.message ? e.message : String(e)}`
          );
          wrapped.failedAtIndex = i;
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
        requestId: req.requestId,
        error: e?.message ? e.message : "unknown error",
        failedAtIndex:
          typeof e.failedAtIndex === "number"
            ? e.failedAtIndex
            : chunkStartIndex,
      };
    }

    cursor = end;
  }

  return {
    kind: "execute-ok",
    requestId: req.requestId,
    totalChanges,
    durationMs: Date.now() - startedAt,
  };
}

// ── Message dispatch ─────────────────────────────────────────────

parentPort.on("message", (msg) => {
  if (
    !msg ||
    typeof msg !== "object" ||
    msg.kind !== "execute" ||
    typeof msg.requestId !== "string"
  ) {
    // Malformed message — surface it as an error response so the
    // client's correlation map releases the awaiting promise. We
    // can't infer the requestId, so we synthesise one to avoid a
    // silent leak. The client side will log the unknown id and move on.
    parentPort.postMessage({
      kind: "execute-error",
      requestId:
        msg && typeof msg.requestId === "string" ? msg.requestId : "unknown",
      error: "malformed worker message",
      failedAtIndex: -1,
    });
    return;
  }
  const response = executeBatch(msg);
  parentPort.postMessage(response);
});

// Surface uncaught errors back to the parent. better-sqlite3 should
// throw into our try/catch above, but defence in depth — if anything
// escapes, the parent gets a clear signal instead of a silent worker.
process.on("uncaughtException", (err) => {
  parentPort.postMessage({
    kind: "execute-error",
    requestId: "uncaught",
    error: `worker uncaughtException: ${err?.message ? err.message : String(err)}`,
    failedAtIndex: -1,
  });
});

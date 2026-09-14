/**
 * The runtime-diagnostics envelope is a contract two backends emit — the
 * Node server today, the Rust core once it serves the route — so it is
 * pinned here against the same plain-JS validator the parity harness
 * uses to hold BOTH sides to it. A shape drift that only the Node side
 * knew about would otherwise surface as a Rust "bug" months later.
 */
import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import { installRuntimeDiagnostics } from "../../lib/runtime-diagnostics";
import {
  RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
  snapshotRuntimeDiagnostics,
} from "../../lib/runtime-diagnostics-envelope";
import { checkRateLimit, snapshotInboundRateLimiter } from "../../lib/security";
import {
  validateErrorLog,
  validateRuntimeDiagnostics,
} from "../../scripts/parity/diagnostics-envelope.mjs";
import { resetTestDb } from "../helpers/test-db";

test.beforeEach(() => {
  process.env.WORKER_DISABLED = "1";
  resetTestDb();
});

test("the Node envelope conforms to the shared contract", () => {
  installRuntimeDiagnostics(db);
  const env = snapshotRuntimeDiagnostics();

  assert.deepEqual(validateRuntimeDiagnostics(env), []);
  assert.equal(env.backend, "node");
  assert.equal(env.schemaVersion, RUNTIME_DIAGNOSTICS_SCHEMA_VERSION);
  assert.equal(env.heap.kind, "v8");
  assert.equal(env.scheduler.kind, "event-loop");
  assert.ok(env.scheduler.lag, "the event-loop histogram is installed");
  assert.equal(env.scheduler.lag.severity, "ok");

  // SQLite identity is read once at install, off the real connection.
  const row = db.prepare("SELECT sqlite_version() AS v").get() as {
    v: string;
  };
  assert.equal(env.sqlite.engine, "better-sqlite3");
  assert.equal(env.sqlite.version, row.v);
  assert.equal(env.sqlite.connectionModel, "single-sync");

  // What this backend cannot measure is null — never a zero the page
  // would render as a real reading.
  assert.equal(env.sqlite.memory, null);
  assert.equal(env.sqlite.cache, null);
  assert.equal(env.sqlite.lockWait, null);
  assert.equal(env.http.inFlight, null);
  assert.equal(env.process.virtualMb, null);
  assert.equal(env.process.threads, null);
  assert.equal(env.process.openFds, null);
  assert.ok(env.process.rssMb > 0);
  assert.ok(typeof env.process.peakRssMb === "number");

  // What it can, it does.
  assert.ok(env.dbWorker, "Node has a db-worker section");
  assert.ok(env.scrapeActivity, "Node has a scraper");
  assert.ok(env.rateLimiter, "Node reports its inbound limiter");
  assert.equal(env.slowQueries.thresholdMs, 50);
  assert.equal(env.http.thresholdMs, 100);
});

test("recentLimit: 0 keeps the counters and drops every ring", () => {
  installRuntimeDiagnostics(db);
  const env = snapshotRuntimeDiagnostics({ recentLimit: 0 });
  assert.deepEqual(validateRuntimeDiagnostics(env), []);
  assert.deepEqual(env.slowQueries.recent, []);
  assert.deepEqual(env.http.recent, []);
  assert.deepEqual(env.dbWorker?.recent, []);
  assert.deepEqual(env.scrapeActivity?.recent, []);
  assert.equal(typeof env.slowQueries.totalSinceStart, "number");
});

test("the validator refuses what the contract forbids and accepts a Rust envelope", () => {
  installRuntimeDiagnostics(db);
  const env = snapshotRuntimeDiagnostics();

  const broken = JSON.parse(JSON.stringify(env));
  broken.heap = {
    kind: "rust-allocator",
    allocatedMb: 1,
    peakMb: 1,
    liveAllocations: 1,
  };
  broken.process.rssMb = "12";
  broken.extra = true;
  broken.sqlite.lockWait = undefined;
  broken.scheduler.lag.severity = "meh";
  const problems = validateRuntimeDiagnostics(broken);
  assert.ok(
    problems.some((p) => p.startsWith("heap.kind")),
    problems.join("\n")
  );
  assert.ok(problems.some((p) => p.startsWith("process.rssMb")));
  assert.ok(problems.includes("extra: unexpected top-level key"));
  assert.ok(problems.some((p) => p.startsWith("sqlite.lockWait")));
  assert.ok(problems.some((p) => p.startsWith("scheduler.lag.severity")));

  // The shape the Rust core will emit — sections it can measure filled,
  // sections it has no counterpart for null.
  const lag = env.scheduler.lag;
  const rust = {
    ...JSON.parse(JSON.stringify(env)),
    backend: "rust",
    heap: {
      kind: "rust-allocator",
      allocatedMb: 3.5,
      peakMb: 4,
      liveAllocations: 120,
    },
    scheduler: {
      kind: "tokio",
      workers: 8,
      aliveTasks: 3,
      globalQueueDepth: 0,
      lag,
    },
    sqlite: {
      engine: "rusqlite",
      version: "3.46.0",
      connectionModel: "single-mutex",
      memory: {
        usedMb: 1.2,
        highwaterMb: 2.1,
        pageCacheMb: 0.5,
        schemaKb: 40,
        statementsKb: 12,
      },
      cache: { hits: 10, misses: 2, writes: 1, spills: 0 },
      lockWait: lag,
    },
    http: { ...env.http, inFlight: 1 },
    dbWorker: null,
    scrapeActivity: null,
  };
  assert.deepEqual(validateRuntimeDiagnostics(rust), []);
  // …but not a Rust backend claiming a V8 heap.
  assert.ok(
    validateRuntimeDiagnostics({ ...rust, heap: env.heap }).some((p) =>
      p.startsWith("heap.kind")
    )
  );
});

test("the error-log validator refuses what the contract forbids", () => {
  const ok = {
    entries: [
      { at: 2, level: "warn", message: "later", truncated: false },
      { at: 1, level: "error", message: "earlier", truncated: true },
    ],
    capacity: 200,
  };
  assert.deepEqual(validateErrorLog(ok), []);
  assert.deepEqual(validateErrorLog({ entries: [], capacity: 200 }), []);

  // Newest-first is part of the contract: `snapshotErrorLog` reverses the
  // ring rather than sorting, and a port that forgot would look fine.
  assert.ok(
    validateErrorLog({
      ...ok,
      entries: [...ok.entries].reverse(),
    }).some((p) => p.includes("not newest-first"))
  );
  // Level is a closed set; `console.info` is not intercepted.
  assert.ok(
    validateErrorLog({
      entries: [{ at: 1, level: "info", message: "x", truncated: false }],
      capacity: 200,
    }).some((p) => p.startsWith("entries[0].level"))
  );
  // A missing field, a wrong type, an extra key, and more entries than the
  // ring can hold.
  assert.ok(
    validateErrorLog({ entries: [{ at: 1, level: "warn" }], capacity: 200 })
      .length >= 2
  );
  assert.ok(
    validateErrorLog({ entries: [], capacity: "200" }).some((p) =>
      p.startsWith("capacity")
    )
  );
  assert.ok(
    validateErrorLog({ entries: [], capacity: 200, extra: 1 }).includes(
      "extra: unexpected top-level key"
    )
  );
  assert.ok(
    validateErrorLog({
      entries: [ok.entries[0], ok.entries[1]],
      capacity: 1,
    }).some((p) => p.includes("exceeds capacity"))
  );
  assert.ok(validateErrorLog(null).length === 1);
});

test("the inbound limiter reports its denials", () => {
  const before = snapshotInboundRateLimiter().denialsSinceStart;
  const key = `diagnostics-test:${Date.now()}`;
  assert.equal(
    checkRateLimit({ key, limit: 1, windowMs: 60_000 }).allowed,
    true
  );
  assert.equal(
    checkRateLimit({ key, limit: 1, windowMs: 60_000 }).allowed,
    false
  );
  const after = snapshotInboundRateLimiter();
  assert.equal(after.denialsSinceStart, before + 1);
  assert.ok(after.trackedKeys >= 1);
});

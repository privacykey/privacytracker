/**
 * Tests for the SQLite write worker client. We exercise the inline
 * fallback path (WORKER_DISABLED=1) rather than spawning an actual
 * worker_threads worker — the inline path uses the SAME chunked-tx
 * logic as the worker, so it covers the executor's behaviour, and
 * not spawning a thread keeps the test suite fast + portable.
 *
 * The actual worker thread is exercised end-to-end by manual testing
 * (`pnpm run tauri:dev`, kick off a 200-app import, watch the Tauri
 * webview stay responsive). That's the integration we care about;
 * unit-level we just want to know the API contract holds.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resetTestDb } from "./test-db";

// Force the inline path before any module imports so db-worker-client
// reads it at first use.
process.env.WORKER_DISABLED = "1";

// Imported AFTER the env mutation so isWorkerEnabled() reads the
// flag correctly. This isn't required because the function reads
// each call — but stays defensive against future changes.
import db from "../lib/db";
import {
  clearDbWorkerTimings,
  runBulkWrite,
  snapshotDbWorkerTimings,
} from "../lib/db-worker-client";

test.beforeEach(() => {
  resetTestDb();
  clearDbWorkerTimings();
});

test("runBulkWrite executes a single statement", async () => {
  // Prep: the apps table exists from migrations. We exercise it
  // because it has FK targets and a real shape — exercising a fake
  // throwaway table would just test the wrapper, not the integration.
  const result = await runBulkWrite([
    {
      sql: `INSERT INTO apps (id, name, url, lastSynced, firstSeen, changeCount)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        "test-1",
        "Fixture App",
        "https://apps.apple.com/us/app/x/id1",
        Date.now(),
        Date.now(),
        0,
      ],
    },
  ]);
  assert.equal(result.totalChanges, 1);
  const row = db.prepare("SELECT name FROM apps WHERE id = ?").get("test-1") as
    | { name: string }
    | undefined;
  assert.equal(row?.name, "Fixture App");
});

test("runBulkWrite chunks transactions and commits earlier chunks before failure", async () => {
  // Insert 30 rows across multiple chunks where row 25 violates a NOT
  // NULL constraint. The first chunk (rows 0-9 with chunkSize=10)
  // and the second (10-19) should commit; the third (20-29) should
  // roll back when row 25 hits.
  const baseTs = Date.now();
  const statements = [];
  for (let i = 0; i < 30; i += 1) {
    statements.push({
      sql: `INSERT INTO apps (id, name, url, lastSynced, firstSeen, changeCount)
            VALUES (?, ?, ?, ?, ?, ?)`,
      // Row 25 has a null name — apps.name is NOT NULL, so the insert fails.
      params: [
        `chunk-${i}`,
        i === 25 ? null : `App ${i}`,
        `https://apps.apple.com/us/app/x/id${i}`,
        baseTs,
        baseTs,
        0,
      ],
    });
  }
  await assert.rejects(runBulkWrite(statements, { chunkSize: 10 }));

  // Earlier chunks (0-9 and 10-19) committed before the failure.
  const earlier = db
    .prepare("SELECT COUNT(*) as count FROM apps WHERE id LIKE ?")
    .get("chunk-%") as { count: number };
  assert.equal(
    earlier.count,
    20,
    "expected 20 rows from the first two chunks to have committed"
  );

  // The bad chunk (20-29) rolled back, including rows BEFORE the bad
  // one in the same chunk (20-24).
  const inBadChunk = db
    .prepare("SELECT COUNT(*) as count FROM apps WHERE id IN (?, ?, ?, ?, ?)")
    .get("chunk-20", "chunk-21", "chunk-22", "chunk-23", "chunk-24") as {
    count: number;
  };
  assert.equal(
    inBadChunk.count,
    0,
    "rows 20-24 must roll back with the failing chunk"
  );
});

test("runBulkWrite handles empty input as a no-op", async () => {
  const result = await runBulkWrite([]);
  assert.equal(result.totalChanges, 0);
});

test("runBulkWrite records DB worker diagnostics for bulk batches", async () => {
  const baseTs = Date.now();
  await runBulkWrite([
    {
      sql: `INSERT INTO apps (id, name, url, lastSynced, firstSeen, changeCount)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        "diag-1",
        "Diagnostics App",
        "https://apps.apple.com/us/app/x/id1",
        baseTs,
        baseTs,
        0,
      ],
    },
  ]);

  const snapshot = snapshotDbWorkerTimings();
  assert.equal(snapshot.totalSinceStart, 1);
  assert.equal(snapshot.failedSinceStart, 0);
  assert.equal(snapshot.inlineSinceStart, 1);
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].statementCount, 1);
  assert.equal(snapshot.recent[0].outcome, "ok");
  assert.equal(snapshot.recent[0].inline, true);
});

test("runBulkWrite supports object-style named parameters", async () => {
  const baseTs = Date.now();
  const result = await runBulkWrite([
    {
      sql: `INSERT INTO apps (id, name, url, lastSynced, firstSeen, changeCount)
            VALUES (:id, :name, :url, :ts, :ts, 0)`,
      params: {
        id: "named-1",
        name: "Named-Param App",
        url: "https://apps.apple.com/us/app/x/id99",
        ts: baseTs,
      },
    },
  ]);
  assert.equal(result.totalChanges, 1);
  const row = db.prepare("SELECT name FROM apps WHERE id = ?").get("named-1") as
    | { name: string }
    | undefined;
  assert.equal(row?.name, "Named-Param App");
});

test("runBulkWrite reports failedAtIndex on the failing statement", async () => {
  const baseTs = Date.now();
  try {
    await runBulkWrite([
      {
        sql: `INSERT INTO apps (id, name, url, lastSynced, firstSeen, changeCount)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          "ok-row",
          "Good",
          "https://apps.apple.com/us/app/x/id1",
          baseTs,
          baseTs,
          0,
        ],
      },
      {
        sql: `INSERT INTO apps (id, name, url, lastSynced, firstSeen, changeCount)
              VALUES (?, ?, ?, ?, ?, ?)`,
        // Same primary key as the previous row → UNIQUE constraint failure.
        params: [
          "ok-row",
          "Dup",
          "https://apps.apple.com/us/app/x/id2",
          baseTs,
          baseTs,
          0,
        ],
      },
    ]);
    assert.fail("runBulkWrite should have thrown on the duplicate insert");
  } catch (err) {
    const e = err as Error & { failedAtIndex?: number };
    assert.equal(
      e.failedAtIndex,
      1,
      "failedAtIndex should point at the duplicate row"
    );
    assert.match(e.message, /UNIQUE/i);
  }
});

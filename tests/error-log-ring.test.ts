import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearErrorLog,
  installErrorLogRing,
  snapshotErrorLog,
} from "../lib/error-log-ring";

/**
 * Tests for the error-log ring buffer (lib/error-log-ring.ts).
 *
 * These run against the real `console.error` / `console.warn` patches
 * — we install them once, then use `clearErrorLog()` between tests to
 * isolate ring state. We deliberately swallow the patched output by
 * monkey-patching `process.stderr.write` for the duration of a test
 * so the test runner's output stays clean.
 */

// Install once for the whole file. Subsequent calls are no-ops thanks
// to the install guard, which is exactly the behaviour we want under
// hot-reload.
installErrorLogRing();

/** Run a function with stderr redirected to /dev/null so the patched
 *  console.error doesn't pollute test output. */
function silently(fn: () => void): void {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
}

test("captures console.error into the ring (newest first)", () => {
  clearErrorLog();
  silently(() => {
    console.error("first");
    console.error("second");
    console.error("third");
  });

  const snap = snapshotErrorLog();
  assert.equal(snap.entries.length, 3);
  assert.equal(snap.entries[0].message, "third");
  assert.equal(snap.entries[1].message, "second");
  assert.equal(snap.entries[2].message, "first");
  assert.equal(snap.entries[0].level, "error");
});

test("captures console.warn with level=warn", () => {
  clearErrorLog();
  silently(() => {
    console.warn("a warning");
    console.error("an error");
  });

  const snap = snapshotErrorLog();
  const byLevel = Object.fromEntries(
    snap.entries.map((e) => [e.message, e.level])
  );
  assert.equal(byLevel["a warning"], "warn");
  assert.equal(byLevel["an error"], "error");
});

test("serialises Error stack traces, plain strings, and objects", () => {
  clearErrorLog();
  silently(() => {
    const err = new Error("boom");
    console.error(err);
    console.error("plain string");
    console.error({ shape: "object", n: 42 });
  });

  const snap = snapshotErrorLog();
  assert.equal(snap.entries.length, 3);
  // Newest first — last call is at index 0.
  assert.match(snap.entries[0].message, /shape/);
  assert.equal(snap.entries[1].message, "plain string");
  assert.match(snap.entries[2].message, /Error: boom/);
});

test("truncates messages over 4 KB and flags `truncated: true`", () => {
  clearErrorLog();
  const huge = "x".repeat(10_000);
  silently(() => {
    console.error(huge);
  });

  const snap = snapshotErrorLog();
  const e = snap.entries[0];
  assert.equal(e.truncated, true);
  // 4 KB cap plus the "(truncated)" suffix — total length must be
  // strictly less than the original.
  assert.ok(e.message.length < huge.length);
  assert.ok(e.message.endsWith("(truncated)"));
});

test("evicts oldest entries when the ring exceeds capacity", () => {
  clearErrorLog();
  silently(() => {
    // Cap is 200; push 250 distinct messages and expect only the last
    // 200 to remain.
    for (let i = 0; i < 250; i++) {
      console.error(`entry-${i}`);
    }
  });

  const snap = snapshotErrorLog({ limit: 200 });
  assert.equal(snap.entries.length, 200);
  // Newest first → first entry should be the highest-numbered.
  assert.equal(snap.entries[0].message, "entry-249");
  // Last entry in the slice should be the oldest *surviving* one,
  // which is entry-50 (250 − 200 = 50).
  assert.equal(snap.entries[snap.entries.length - 1].message, "entry-50");
  // capacity reflects the ring's MAX_ENTRIES, not the active count.
  assert.equal(snap.capacity, 200);
});

test("clearErrorLog drops every entry", () => {
  silently(() => {
    console.error("before clear");
  });
  clearErrorLog();
  const snap = snapshotErrorLog();
  assert.equal(snap.entries.length, 0);
});

test("install is idempotent — multiple installs do not multiply entries", () => {
  // Re-installing should be a no-op. If it weren't, this single
  // console.error would land in the ring twice.
  installErrorLogRing();
  installErrorLogRing();
  installErrorLogRing();
  clearErrorLog();
  silently(() => {
    console.error("once");
  });

  const snap = snapshotErrorLog();
  assert.equal(snap.entries.length, 1);
});

test("limit option clamps to MAX_ENTRIES and rejects 0/negative", () => {
  clearErrorLog();
  silently(() => {
    for (let i = 0; i < 5; i++) {
      console.error(`m${i}`);
    }
  });

  // Asking for more than capacity returns whatever's in the ring.
  const big = snapshotErrorLog({ limit: 10_000 });
  assert.equal(big.entries.length, 5);

  // Asking for 1 returns just the newest.
  const one = snapshotErrorLog({ limit: 1 });
  assert.equal(one.entries.length, 1);
  assert.equal(one.entries[0].message, "m4");

  // Zero / negative gets clamped to at least 1 (we still want
  // something useful back).
  const zero = snapshotErrorLog({ limit: 0 });
  assert.ok(zero.entries.length >= 1);
});

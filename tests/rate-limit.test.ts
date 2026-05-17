import assert from "node:assert/strict";
import { test } from "node:test";
import {
  _resetSoftBuckets,
  acquireRateLimitToken,
  clearRateLimit,
  getAllRateLimits,
  getRateLimit,
  getRemainingCooldownMs,
  recordRateLimit,
} from "../lib/rate-limit";

/**
 * Rate-limit module smoke tests.
 *
 * These exercise the persistence + countdown shape end-to-end without
 * touching Apple's servers. Each test starts by clearing both
 * categories so it's isolated from any prior state in the SQLite file
 * the test process happens to share with development data.
 */

function resetAll() {
  clearRateLimit("search");
  clearRateLimit("scrape");
  _resetSoftBuckets();
}

test("recording a 429 sets active=true with the right resumeAt", () => {
  resetAll();
  const before = Date.now();
  const resumeAt = recordRateLimit("search", 70_000, "TEST: 429");
  const after = Date.now();

  assert.ok(resumeAt >= before + 70_000);
  assert.ok(resumeAt <= after + 70_000);

  const snap = getRateLimit("search");
  assert.equal(snap.active, true);
  assert.equal(snap.category, "search");
  assert.equal(snap.resumeAt, resumeAt);
  assert.match(snap.reason, /TEST: 429/);
});

test("clearRateLimit zeros the cooldown", () => {
  resetAll();
  recordRateLimit("search", 70_000, "TEST: 429");
  assert.equal(getRateLimit("search").active, true);
  clearRateLimit("search");
  const snap = getRateLimit("search");
  assert.equal(snap.active, false);
  assert.equal(snap.resumeAt, 0);
  assert.equal(snap.reason, "");
});

test("categories are independent — a search 429 does not gate scrape", () => {
  resetAll();
  recordRateLimit("search", 60_000, "search 429");
  assert.equal(getRateLimit("search").active, true);
  assert.equal(getRateLimit("scrape").active, false);
});

test("a longer existing cooldown is not shortened by a shorter new record", () => {
  resetAll();
  const long = recordRateLimit("scrape", 5 * 60_000, "long");
  const short = recordRateLimit("scrape", 1000, "short");
  // Apple sometimes returns a tighter Retry-After on subsequent 429s in the
  // same window. We must not let that shorten the existing cooldown — it's
  // safer to honour the longer one and let the next request's 429 (if any)
  // re-extend it. The returned resumeAt should equal the original `long`.
  assert.equal(short, long);
  assert.ok(getRemainingCooldownMs("scrape") > 4 * 60_000);
});

test("expired cooldowns surface as inactive", async () => {
  resetAll();
  // Record a cooldown of 50ms so we can wait it out without slowing the suite.
  recordRateLimit("search", 50, "tiny");
  assert.equal(getRateLimit("search").active, true);
  await new Promise((r) => setTimeout(r, 100));
  const snap = getRateLimit("search");
  assert.equal(snap.active, false);
  assert.equal(snap.resumeAt, 0);
  // Reason should be hidden from the snapshot once expired — no half-state.
  assert.equal(snap.reason, "");
});

test("getAllRateLimits includes both categories + serverNow", () => {
  resetAll();
  const start = Date.now();
  const all = getAllRateLimits();
  assert.equal(all.search.category, "search");
  assert.equal(all.scrape.category, "scrape");
  assert.ok(all.serverNow >= start);
  assert.ok(all.serverNow <= Date.now());
});

test("soft pacer: token bucket allows burst then paces", async () => {
  resetAll();
  // Burst of 4 (capacity for 'search') should resolve quickly because the
  // bucket starts full. The fifth one paces — at most 800ms cap inside
  // acquireRateLimitToken — so the total is well under one minute.
  const t0 = Date.now();
  for (let i = 0; i < 4; i += 1) {
    await acquireRateLimitToken("search");
  }
  const burstElapsed = Date.now() - t0;
  // Should be under 50ms — the bucket has 4 tokens at start, no sleep.
  assert.ok(burstElapsed < 100, `burst took ${burstElapsed}ms (expected <100)`);

  // Fifth call drains to empty and paces. Should sleep up to 800ms.
  const t1 = Date.now();
  await acquireRateLimitToken("search");
  const pacedElapsed = Date.now() - t1;
  assert.ok(pacedElapsed >= 50, `paced call returned in ${pacedElapsed}ms`);
});

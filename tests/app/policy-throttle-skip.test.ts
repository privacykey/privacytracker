/**
 * A policy fetch skipped by the throttle is reported as throttled.
 *
 * The per-app scrape throttle skips the fetch of a ready policy fetched
 * within `policy_scrape_throttle_minutes` (60 by default), and the
 * kill-switch skips every fetch. Each skip logs its own line (`throttled`,
 * `disabled`) and stores it on the analysis row, but the store returned
 * the row as it read it before the skip, carrying the previous run's log.
 * The bulk runner tells a throttled app by the last line of the returned
 * log, so it judged each skip by the app's previous run: an app skipped
 * after a fetch counted as a success, and only a second skip in a row as
 * throttled. These tests pin that both skips return the analysis as
 * stored, their own line last, and that the bulk runner and the
 * regenerate route report the throttle after a fetch.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { POST } from "../../app/api/policy/regenerate/route";
import { getRecentActivity } from "../../lib/activity";
import db from "../../lib/db";
import { runBulkPolicySync } from "../../lib/policy-bulk-runner";
import {
  getPolicyAnalysis,
  syncPrivacyPolicyAnalysis,
} from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

// Numeric, because the regenerate route only accepts an App Store id.
const APP_ID = "1000000401";
const APP_NAME = "Throttle Fixture";
const POLICY_URL = "https://example.com/privacy-throttle-test";
const REQUEST = { appId: APP_ID, appName: APP_NAME, policyUrl: POLICY_URL };

const MINUTE = 60_000;
const TEXT = "We collect your email address to run the service. "
  .repeat(60)
  .trim();
const SUMMARY = JSON.stringify({
  overview: "A summary of the stored policy.",
  highlights: [],
  lenses: [],
});
// The log of the run that fetched the stored policy. The row carries it
// until the next run writes its own.
const PREVIOUS_LOG = JSON.stringify([
  {
    phase: "fetching",
    at: 1,
    ms: 1000,
    note: "Fetched 600 words via direct from example.com.",
  },
]);

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
let fetchedUrls: string[] = [];

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  seedTrackedApp({ id: APP_ID, name: APP_NAME, privacyPolicyUrl: POLICY_URL });
  setSetting("ai_provider", "disabled");
  // Every skip under test fetches nothing, so any request is a failure.
  fetchedUrls = [];
  global.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetchedUrls.push(url);
    throw new TypeError(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
});

/** A ready, summarised policy fetched `fetchedAgoMs` ago. */
function seedReadyAnalysis(fetchedAgoMs: number): void {
  const fetchedAt = Date.now() - fetchedAgoMs;
  db.prepare(`
    INSERT INTO privacy_policy_analyses (
      app_id, policy_url, status, source_title, source_content_type,
      source_text, source_word_count, source_origin, source_final_url,
      content_hash, analysis_mode, summary_json, model, updated_at,
      last_run_log, source_fetched_at
    )
    VALUES (?, ?, 'ready', 'example.com', 'text/plain; charset=utf-8', ?, ?,
      'direct', ?, ?, 'direct', ?, 'fixture-model', ?, ?, ?)
  `).run(
    APP_ID,
    POLICY_URL,
    TEXT,
    TEXT.split(/\s+/).length,
    POLICY_URL,
    createHash("sha256").update(TEXT).digest("hex"),
    SUMMARY,
    fetchedAt,
    PREVIOUS_LOG,
    fetchedAt
  );
}

/**
 * The returned analysis is the stored one. The run marker is cleared in a
 * `finally` after the value is built, so only the returned value still
 * says the run is running.
 */
function assertReturnedAsStored(
  result: Awaited<ReturnType<typeof syncPrivacyPolicyAnalysis>>
): void {
  assert.equal(result?.runStatus, "running");
  assert.deepEqual({ ...result, runStatus: "idle" }, getPolicyAnalysis(APP_ID));
}

for (const phase of ["fetch", "all"] as const) {
  test(`a throttled ${phase} returns the stored analysis, its throttled line last`, async () => {
    seedReadyAnalysis(10 * MINUTE);

    const result = await syncPrivacyPolicyAnalysis(REQUEST, { phase });

    assert.deepEqual(fetchedUrls, []);
    assert.equal(result?.status, "ready");
    assert.deepEqual(
      result?.lastRunLog?.map((entry) => entry.phase),
      ["throttled"]
    );
    assert.match(
      result?.lastRunLog?.[0]?.note ?? "",
      /^Skipped scrape — last fetch was 10 min ago \(cooldown 60 min, 50 min remaining\)\./
    );
    assertReturnedAsStored(result);
  });
}

test("a throttled fetch whose write is refused returns the row as it stands", async () => {
  seedReadyAnalysis(10 * MINUTE);
  // Only the analysis upsert names `updated_at`, so the trigger refuses it
  // while the run log's own update lands.
  db.exec(
    "CREATE TRIGGER refuse_analysis_write BEFORE UPDATE OF updated_at ON privacy_policy_analyses BEGIN SELECT RAISE(ABORT, 'analysis write refused'); END"
  );
  try {
    const result = await syncPrivacyPolicyAnalysis(REQUEST, { phase: "fetch" });

    // A refused write is not fatal: the skip still reports itself.
    assert.deepEqual(fetchedUrls, []);
    assert.deepEqual(
      result?.lastRunLog?.map((entry) => entry.phase),
      ["throttled"]
    );
    assertReturnedAsStored(result);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS refuse_analysis_write");
  }
});

test("the kill-switch over a stored analysis returns it with its disabled line", async () => {
  seedReadyAnalysis(2 * 24 * 60 * MINUTE);
  setSetting("policy_scrape_disabled", "true");

  const result = await syncPrivacyPolicyAnalysis(REQUEST, { phase: "fetch" });

  assert.deepEqual(fetchedUrls, []);
  assert.equal(result?.status, "ready");
  assert.deepEqual(
    result?.lastRunLog?.map((entry) => entry.phase),
    ["disabled"]
  );
  assertReturnedAsStored(result);
});

for (const phase of ["fetch", "all"] as const) {
  test(`the bulk runner counts a throttled app as throttled (phase "${phase}")`, async () => {
    seedReadyAnalysis(10 * MINUTE);
    const frames: Record<string, unknown>[] = [];

    const { totals } = await runBulkPolicySync({
      initiator: "manual",
      phase,
      force: false,
      streamWriter: (frame) => frames.push(frame as Record<string, unknown>),
    });

    assert.deepEqual(fetchedUrls, []);
    assert.deepEqual(totals, {
      attempted: 1,
      succeeded: 0,
      failed: 0,
      throttled: 1,
      skipped: 0,
    });
    const done = frames.find((frame) => frame.type === "app-done");
    assert.equal(done?.status, "ready");
    assert.equal(done?.throttled, true);
    const bulkRow = getRecentActivity({ type: "policy_summary" }).find(
      (row) => row.appId === null
    );
    assert.equal(bulkRow?.status, "ok");
    assert.equal(
      bulkRow?.summary,
      `Bulk policy ${phase === "all" ? "summarise" : "scrape"}: 0 ok, 1 throttled`
    );
  });
}

test("the regenerate route answers a throttled fetch with the throttled line", async () => {
  seedReadyAnalysis(10 * MINUTE);

  const res = await POST(
    new Request("http://127.0.0.1/api/policy/regenerate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
      },
      body: JSON.stringify({ appId: APP_ID, phase: "fetch" }),
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(fetchedUrls, []);
  assert.equal(body.analysis?.status, "ready");
  assert.deepEqual(
    body.analysis?.lastRunLog?.map((entry: { phase: string }) => entry.phase),
    ["throttled"]
  );
  assert.equal(
    body.analysis?.updatedAt,
    getPolicyAnalysis(APP_ID)?.updatedAt,
    "the answer carries the update time the row now holds"
  );
});

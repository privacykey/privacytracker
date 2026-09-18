/**
 * Lock the "Disable policy scraping" kill-switch.
 *
 * The setting `policy_scrape_disabled='true'` is a global gate: every
 * code path that would fetch a privacy-policy URL must short-circuit
 * inside `fetchAndStorePolicySource` BEFORE the HTTP call. These tests
 * pin that contract by mocking `global.fetch` to track invocations and
 * asserting the network never gets touched when the kill-switch is on.
 *
 * A skipped fetch is not a failed one: an app's first run with the
 * kill-switch on must read as skipped in the activity log and the bulk
 * totals, and must not leave a row behind that the AI Policy tab would
 * render as an analysis error.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getRecentActivity } from "../../lib/activity";
import { runBulkPolicySync } from "../../lib/policy-bulk-runner";
import {
  __drainForTests,
  schedulePostAppUpdatePolicyFetch,
} from "../../lib/post-app-update-policy-fetch";
import {
  getPolicyAnalysis,
  syncPrivacyPolicyAnalysis,
} from "../../lib/privacy-policy";
import { getSetting, setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const POLICY_URL = "https://example.com/privacy-disabled-test";

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;

interface FetchTracker {
  calls: number;
  fetch: typeof fetch;
}

/**
 * Mock fetch that counts policy-URL hits. Non-policy URLs throw so a
 * stray call to (say) an AI endpoint also surfaces as a test failure.
 */
function trackingFetch(allowSuccessful: boolean): FetchTracker {
  const tracker: FetchTracker = {
    calls: 0,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === POLICY_URL) {
        tracker.calls += 1;
        if (!allowSuccessful) {
          throw new Error(
            `Unexpected fetch while policy_scrape_disabled=true: ${url}`
          );
        }
        return new Response("Privacy policy text. ".repeat(200), {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch,
  };
  return tracker;
}

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  seedTrackedApp({
    id: "scrape-disabled-app",
    name: "Disabled Scrape Fixture",
    privacyPolicyUrl: POLICY_URL,
  });
  // AI disabled so summarise can't accidentally proceed either.
  setSetting("ai_provider", "disabled");
  setSetting("policy_scrape_throttle_enabled", "false");
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
});

test("syncPrivacyPolicyAnalysis makes zero HTTP requests when policy_scrape_disabled is on", async () => {
  setSetting("policy_scrape_disabled", "true");
  const tracker = trackingFetch(false);
  global.fetch = tracker.fetch;

  await syncPrivacyPolicyAnalysis(
    {
      appId: "scrape-disabled-app",
      appName: "Disabled Scrape Fixture",
      policyUrl: POLICY_URL,
    },
    { bypassThrottle: false }
  );

  assert.equal(tracker.calls, 0, "fetch must not be invoked while disabled");
});

test("disabled kill-switch overrides the throttle gate (both off → still no fetch)", async () => {
  setSetting("policy_scrape_disabled", "true");
  setSetting("policy_scrape_throttle_enabled", "false");
  const tracker = trackingFetch(false);
  global.fetch = tracker.fetch;

  await syncPrivacyPolicyAnalysis(
    {
      appId: "scrape-disabled-app",
      appName: "Disabled Scrape Fixture",
      policyUrl: POLICY_URL,
    },
    { bypassThrottle: false }
  );

  assert.equal(
    tracker.calls,
    0,
    "throttle off does not override the kill-switch"
  );
});

test('bypassThrottle=true overrides the kill-switch (so user-initiated "Force re-scrape" still works)', async () => {
  setSetting("policy_scrape_disabled", "true");
  const tracker = trackingFetch(true);
  global.fetch = tracker.fetch;

  await syncPrivacyPolicyAnalysis(
    {
      appId: "scrape-disabled-app",
      appName: "Disabled Scrape Fixture",
      policyUrl: POLICY_URL,
    },
    { bypassThrottle: true }
  );

  assert.ok(
    tracker.calls >= 1,
    "bypassThrottle should permit the network round-trip even when disabled"
  );
});

test("default setting (missing key) is treated as enabled — the gate stays off until the user opts in", async () => {
  assert.equal(getSetting("policy_scrape_disabled", "false"), "false");
  const tracker = trackingFetch(true);
  global.fetch = tracker.fetch;

  await syncPrivacyPolicyAnalysis(
    {
      appId: "scrape-disabled-app",
      appName: "Disabled Scrape Fixture",
      policyUrl: POLICY_URL,
    },
    { bypassThrottle: false }
  );

  assert.ok(
    tracker.calls >= 1,
    "fetch should proceed when the kill-switch setting is absent"
  );
});

// The automatic policy fetch that follows every import or App Store sync
// must not start a bulk run while the kill-switch is on: Settings promises
// "no bulk runs". Such a run fetches nothing, since every app meets the
// store's gate, but it re-logs each stored analysis, a stored fetch error
// as a fresh failure.
test("the automatic fetch after an import or sync starts no bulk run while the kill-switch is on", async () => {
  // A publisher that can't be reached leaves a stored fetch error, the
  // analysis that read as a new failure on every run.
  global.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await syncPrivacyPolicyAnalysis(
    {
      appId: "scrape-disabled-app",
      appName: "Disabled Scrape Fixture",
      policyUrl: POLICY_URL,
    },
    { phase: "fetch" }
  );
  const before = getPolicyAnalysis("scrape-disabled-app");
  assert.equal(before?.status, "fetch_error", "precondition: a fetch error");
  const seen = new Set(getRecentActivity().map((row) => row.id));

  setSetting("policy_scrape_disabled", "true");
  const tracker = trackingFetch(false);
  global.fetch = tracker.fetch;

  schedulePostAppUpdatePolicyFetch("import");
  schedulePostAppUpdatePolicyFetch("sync");
  await __drainForTests();

  assert.equal(tracker.calls, 0, "fetch must not be invoked while disabled");
  assert.deepEqual(
    getRecentActivity()
      .filter((row) => !seen.has(row.id))
      .map((row) => row.summary),
    [],
    "no Activity rows: no bulk summary and no per-app rows"
  );
  assert.deepEqual(
    getPolicyAnalysis("scrape-disabled-app"),
    before,
    "the stored analysis is untouched"
  );
});

test("the automatic fetch after an import or sync still runs when scraping is enabled", async () => {
  const tracker = trackingFetch(true);
  global.fetch = tracker.fetch;

  schedulePostAppUpdatePolicyFetch("sync");
  await __drainForTests();

  // The fixture text is too thin to pass as a policy, so the run's outcome
  // is beside the point: it started, fetched and logged its summary.
  assert.ok(tracker.calls >= 1, "the deferred run should fetch the policy");
  const bulkRow = getRecentActivity({ type: "policy_summary" }).find(
    (row) => row.appId === null
  );
  assert.match(bulkRow?.summary ?? "", /^Bulk policy scrape: /);
});

test("an existing cached policy row is preserved when the kill-switch trips", async () => {
  // First, seed a successful scrape so a cached row exists.
  const seedTracker = trackingFetch(true);
  global.fetch = seedTracker.fetch;
  await syncPrivacyPolicyAnalysis(
    {
      appId: "scrape-disabled-app",
      appName: "Disabled Scrape Fixture",
      policyUrl: POLICY_URL,
    },
    { bypassThrottle: false }
  );
  const before = getPolicyAnalysis("scrape-disabled-app");
  assert.ok(before, "precondition: a cached row should exist");

  // Flip the kill-switch on. Now any further fetch should fail loudly.
  setSetting("policy_scrape_disabled", "true");
  const disabledTracker = trackingFetch(false);
  global.fetch = disabledTracker.fetch;

  await syncPrivacyPolicyAnalysis(
    {
      appId: "scrape-disabled-app",
      appName: "Disabled Scrape Fixture",
      policyUrl: POLICY_URL,
    },
    { bypassThrottle: false }
  );

  assert.equal(
    disabledTracker.calls,
    0,
    "kill-switch must block fetch on the second call"
  );

  // The cached fetch metadata must survive untouched — only the run
  // log gets a "disabled" event appended.
  const after = getPolicyAnalysis("scrape-disabled-app");
  assert.equal(after?.status, before?.status);
  assert.equal(after?.sourceFetchedAt, before?.sourceFetchedAt);
  assert.equal(after?.sourceLength, before?.sourceLength);
  assert.equal(after?.sourceWordCount, before?.sourceWordCount);
});

for (const phase of ["fetch", "all"] as const) {
  test(`a first ${phase} run with the kill-switch on reads as skipped, not failed`, async () => {
    setSetting("policy_scrape_disabled", "true");
    const tracker = trackingFetch(false);
    global.fetch = tracker.fetch;

    const result = await syncPrivacyPolicyAnalysis(
      {
        appId: "scrape-disabled-app",
        appName: "Disabled Scrape Fixture",
        policyUrl: POLICY_URL,
      },
      { phase, bypassThrottle: false }
    );

    assert.equal(tracker.calls, 0, "fetch must not be invoked while disabled");
    // Nothing was fetched, so there is no analysis to hand back. The run
    // marker's 'pending' placeholder must not outlive the run either: it
    // hydrates as `analysis_error`, which the AI Policy tab renders as
    // "the policy was fetched, but the AI summary could not be generated".
    assert.equal(result, null);
    assert.equal(getPolicyAnalysis("scrape-disabled-app"), null);

    const rows = getRecentActivity({ type: "policy_summary" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "partial");
    assert.equal(rows[0].summary, "Policy skipped: scraping disabled");
    assert.equal(rows[0].detail?.resultStatus, null);
  });
}

test("the bulk runner counts a first fetch stopped by the kill-switch as skipped, not failed", async () => {
  setSetting("policy_scrape_disabled", "true");
  const tracker = trackingFetch(false);
  global.fetch = tracker.fetch;

  // A run already under way when scraping is switched off takes this
  // path: each app after the switch meets the store's gate. No new run
  // starts while the switch is on (see the automatic-fetch tests above).
  const { totals } = await runBulkPolicySync({
    initiator: "automatic",
    phase: "fetch",
    force: false,
  });

  assert.equal(tracker.calls, 0, "fetch must not be invoked while disabled");
  assert.equal(totals.attempted, 1);
  assert.equal(totals.skipped, 1);
  assert.equal(totals.failed, 0);
  assert.equal(totals.succeeded, 0);

  const bulkRow = getRecentActivity({ type: "policy_summary" }).find(
    (row) => row.appId === null
  );
  assert.equal(bulkRow?.status, "ok");
  assert.equal(bulkRow?.summary, "Bulk policy scrape: 0 ok, 1 skipped");
});

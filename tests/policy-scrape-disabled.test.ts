/**
 * Lock the "Disable policy scraping" kill-switch.
 *
 * The setting `policy_scrape_disabled='true'` is a global gate: every
 * code path that would fetch a privacy-policy URL must short-circuit
 * inside `fetchAndStorePolicySource` BEFORE the HTTP call. These tests
 * pin that contract by mocking `global.fetch` to track invocations and
 * asserting the network never gets touched when the kill-switch is on.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getPolicyAnalysis,
  syncPrivacyPolicyAnalysis,
} from "../lib/privacy-policy";
import { getSetting, setSetting } from "../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "./test-db";

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
  assert.equal(after?.sourceFetchedAt, before?.sourceFetchedAt);
  assert.equal(after?.sourceLength, before?.sourceLength);
  assert.equal(after?.sourceWordCount, before?.sourceWordCount);
});

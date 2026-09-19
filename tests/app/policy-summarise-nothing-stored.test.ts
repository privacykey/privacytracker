/**
 * Summarise with no policy text stored.
 *
 * The summarise phase works from the policy text already stored and never
 * fetches. For an app whose policy was never fetched, the only row it
 * finds is the placeholder `markPolicyRunStart` seeds, and 'pending' is
 * not an analysis status: returned, it read back as `analysis_error`, the
 * run was logged as "Policy summary failed", and the placeholder stayed
 * behind for the AI Policy tab to render as a failed AI run. Nothing
 * failed: there was nothing to summarise yet. These tests pin that such a
 * run is a skip, and that a stored analysis is never dropped with it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../../app/api/policy/regenerate/route";
import { getRecentActivity } from "../../lib/activity";
import db from "../../lib/db";
import {
  getPolicyAnalysis,
  syncPrivacyPolicyAnalysis,
} from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

// Numeric, because the regenerate route only accepts an App Store id.
const APP_ID = "1000000301";
const APP_NAME = "Summarise Fixture";
const POLICY_URL = "https://example.com/privacy-summarise-test";
const REQUEST = { appId: APP_ID, appName: APP_NAME, policyUrl: POLICY_URL };

const originalFetch = global.fetch;
let fetches = 0;

test.beforeEach(() => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, name: APP_NAME, privacyPolicyUrl: POLICY_URL });
  // A provider is configured, so the missing text is the only thing that
  // can stop the run.
  setSetting("ai_provider", "openai");
  setSetting("ai_api_key", "sk-test-key");
  // Summarise never fetches: not the policy, and not a model.
  fetches = 0;
  global.fetch = (async (input: string | URL | Request) => {
    fetches += 1;
    throw new Error(`Unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
});

test.afterEach(() => {
  global.fetch = originalFetch;
});

function assertSkipped(): void {
  assert.equal(fetches, 0);
  // The placeholder does not outlive the run, so the AI Policy tab says
  // no analysis is stored yet instead of reporting a failed AI run.
  assert.equal(getPolicyAnalysis(APP_ID), null);
  const rows = getRecentActivity({ type: "policy_summary" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "partial");
  assert.equal(rows[0].summary, "Policy skipped: nothing fetched yet");
  assert.equal(rows[0].detail?.phase, "summarise");
  assert.equal(rows[0].detail?.resultStatus, null);
}

for (const forceResummarise of [false, true]) {
  test(`summarising a policy that was never fetched is a skip, not a failure (forceResummarise: ${forceResummarise})`, async () => {
    const events: string[] = [];
    const result = await syncPrivacyPolicyAnalysis(REQUEST, {
      phase: "summarise",
      forceResummarise,
      phaseStream: { emit: (entry) => events.push(entry.phase) },
    });

    assert.equal(result, null);
    assertSkipped();
    // The live log a watching AI Policy tab streams says why.
    assert.deepEqual(events, ["skip"]);
  });
}

test("a placeholder an earlier run left behind is dropped too", async () => {
  // A run killed mid-fetch leaves its placeholder, and boot recovery only
  // resets run_status. So did a first run with scraping disabled, before
  // that path learned to drop it.
  db.prepare(`
    INSERT INTO privacy_policy_analyses (
      app_id, policy_url, status, source_word_count, updated_at,
      run_status, run_started_at
    )
    VALUES (?, '', 'pending', 0, 1, 'idle', 1)
  `).run(APP_ID);

  const result = await syncPrivacyPolicyAnalysis(REQUEST, {
    phase: "summarise",
  });

  assert.equal(result, null);
  assertSkipped();
});

test("a stored analysis that cannot be summarised is kept", async () => {
  db.prepare(`
    INSERT INTO privacy_policy_analyses (
      app_id, policy_url, status, source_word_count, updated_at, error
    )
    VALUES (?, ?, 'fetch_error', 0, 1, 'HTTP 503')
  `).run(APP_ID, POLICY_URL);

  const result = await syncPrivacyPolicyAnalysis(REQUEST, {
    phase: "summarise",
  });

  assert.equal(fetches, 0);
  assert.equal(result?.status, "fetch_error");
  assert.equal(getPolicyAnalysis(APP_ID)?.status, "fetch_error");
});

test("the regenerate route answers a Summarise with nothing stored with no analysis", async () => {
  // The route is the one caller that can ask for this: the bulk sync only
  // runs 'fetch' and 'all', and the onboarding wizard only summarises an
  // app whose fetch landed.
  const res = await POST(
    new Request("http://127.0.0.1/api/policy/regenerate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
      },
      body: JSON.stringify({ appId: APP_ID, phase: "summarise" }),
    })
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { analysis: null });
  assertSkipped();
});

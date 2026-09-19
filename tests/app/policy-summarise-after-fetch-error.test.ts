/**
 * Summarise after a failed or unusable fetch.
 *
 * A rescrape that fails keeps the last good policy text on the row, with
 * status 'fetch_error' ('too_short' or 'unsupported_content_type' for a
 * body that is not a usable policy). That text is an earlier capture, not
 * the current policy, so the summarise phase declines it and returns the
 * stored analysis unchanged. The AI Policy tab still offered Summarise for
 * it, and the declined run was logged as a new failure, "Fetch failed:"
 * with the old error, although it fetched nothing. These tests pin that
 * such a run is a skip, that a run which does fetch still reports its own
 * failure, and that the tab offers Summarise by the server's rule.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { POST } from "../../app/api/policy/regenerate/route";
import { getRecentActivity } from "../../lib/activity";
import db from "../../lib/db";
import {
  canSummariseStoredPolicy,
  POLICY_ANALYSIS_STATUSES,
} from "../../lib/policy-summary-meta";
import {
  getPolicyAnalysis,
  syncPrivacyPolicyAnalysis,
} from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

// Numeric, because the regenerate route only accepts an App Store id.
const APP_ID = "1000000302";
const APP_NAME = "Fetch Error Fixture";
const POLICY_URL = "https://example.com/privacy-fetch-error-test";
const REQUEST = { appId: APP_ID, appName: APP_NAME, policyUrl: POLICY_URL };

// The last good capture, kept on the row by the failed rescrape.
const KEPT_TEXT = "We collect your email address to run the service. "
  .repeat(60)
  .trim();
const KEPT_SUMMARY = JSON.stringify({
  overview: "A summary of the earlier capture.",
  highlights: [],
  lenses: [],
});

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
let fetchedUrls: string[] = [];

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  seedTrackedApp({ id: APP_ID, name: APP_NAME, privacyPolicyUrl: POLICY_URL });
  // A provider is configured, so the stored status is the only thing that
  // can stop a summary.
  setSetting("ai_provider", "openai");
  setSetting("ai_api_key", "sk-test-key");
  setSetting("policy_scrape_throttle_enabled", "false");
  // Every request fails: the policy page and the model alike.
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

function seedAnalysis(input: {
  error?: string | null;
  model?: string | null;
  sourceText?: string | null;
  status: string;
  summaryJson?: string | null;
}): void {
  const text = input.sourceText === undefined ? KEPT_TEXT : input.sourceText;
  db.prepare(`
    INSERT INTO privacy_policy_analyses (
      app_id, policy_url, status, source_title, source_content_type,
      source_text, source_word_count, source_origin, source_final_url,
      content_hash, summary_json, model, error, updated_at, source_fetched_at
    )
    VALUES (?, ?, ?, 'example.com', 'text/plain; charset=utf-8', ?, ?,
      'direct', ?, ?, ?, ?, ?, 1, 1)
  `).run(
    APP_ID,
    POLICY_URL,
    input.status,
    text,
    text ? text.split(/\s+/).length : 0,
    POLICY_URL,
    text ? createHash("sha256").update(text).digest("hex") : null,
    input.summaryJson ?? null,
    input.model ?? null,
    input.error ?? null
  );
}

function storedRow(): Record<string, unknown> {
  return db
    .prepare(
      `SELECT status, source_text, content_hash, summary_json, model, error,
              source_fetched_at
         FROM privacy_policy_analyses WHERE app_id = ?`
    )
    .get(APP_ID) as Record<string, unknown>;
}

function assertSkipped(expectedStatus: string, expectedSummary: string): void {
  assert.deepEqual(fetchedUrls, []);
  const rows = getRecentActivity({ type: "policy_summary" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "partial");
  assert.equal(rows[0].summary, expectedSummary);
  assert.equal(rows[0].detail?.phase, "summarise");
  assert.equal(rows[0].detail?.resultStatus, expectedStatus);
}

for (const forceResummarise of [true, false]) {
  test(`a summarise after a failed fetch is a skip, not a new fetch failure (forceResummarise: ${forceResummarise})`, async () => {
    seedAnalysis({
      status: "fetch_error",
      error: "HTTP 503",
      summaryJson: KEPT_SUMMARY,
    });
    const before = storedRow();

    const events: string[] = [];
    const result = await syncPrivacyPolicyAnalysis(REQUEST, {
      phase: "summarise",
      forceResummarise,
      phaseStream: { emit: (entry) => events.push(entry.phase) },
    });

    // The stored analysis comes back as it was: the failure, the kept
    // text and the summary of the earlier capture.
    assert.equal(result?.status, "fetch_error");
    assert.equal(result?.error, "HTTP 503");
    assert.equal(result?.sourceLength, KEPT_TEXT.length);
    assert.equal(
      result?.summary?.overview,
      "A summary of the earlier capture."
    );
    const after = storedRow();
    for (const column of Object.keys(before)) {
      assert.equal(after[column], before[column], column);
    }
    // The live log a watching AI Policy tab streams says why.
    assert.deepEqual(events, ["skip"]);
    assertSkipped("fetch_error", "Policy skipped: latest fetch failed");
  });
}

test("a fetch error with no text kept is a skip too", async () => {
  // The first fetch failed, so there is nothing stored at all.
  seedAnalysis({ status: "fetch_error", error: "HTTP 503", sourceText: null });

  const result = await syncPrivacyPolicyAnalysis(REQUEST, {
    phase: "summarise",
    forceResummarise: true,
  });

  assert.equal(result?.status, "fetch_error");
  assertSkipped("fetch_error", "Policy skipped: latest fetch failed");
});

for (const [status, summary] of [
  ["too_short", "Policy skipped: too short"],
  ["unsupported_content_type", "Policy skipped: unsupported content type"],
] as const) {
  test(`a summarise after an unusable fetch (${status}) stays a skip`, async () => {
    seedAnalysis({ status, error: "Not a usable policy" });
    const before = storedRow();

    const result = await syncPrivacyPolicyAnalysis(REQUEST, {
      phase: "summarise",
      forceResummarise: true,
    });

    assert.equal(result?.status, status);
    assert.equal(result?.sourceLength, KEPT_TEXT.length);
    assert.deepEqual(storedRow(), before);
    assertSkipped(status, summary);
  });
}

for (const phase of ["fetch", "all"] as const) {
  test(`a run with phase "${phase}" whose own fetch fails is still logged as a failure`, async () => {
    seedAnalysis({ status: "source_ready" });

    const result = await syncPrivacyPolicyAnalysis(REQUEST, {
      phase,
      forceResummarise: true,
    });

    // This run did fetch, and the fetch failed: that is its failure.
    assert.ok(fetchedUrls.includes(POLICY_URL), fetchedUrls.join(", "));
    assert.equal(result?.status, "fetch_error");
    const rows = getRecentActivity({ type: "policy_summary" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "error");
    assert.match(rows[0].summary ?? "", /^Fetch failed: /);
    assert.equal(rows[0].detail?.phase, phase);
  });
}

test("the AI Policy tab offers Summarise exactly where the server summarises", async () => {
  const rows: Array<{
    model?: string;
    sourceText: string | null;
    status: string;
  }> = [
    ...POLICY_ANALYSIS_STATUSES.flatMap((status) => [
      { status, sourceText: KEPT_TEXT },
      { status, sourceText: null },
    ]),
    { status: "ready", sourceText: KEPT_TEXT.slice(0, 400), model: "imported" },
  ];
  const offeredRows: string[] = [];
  for (const row of rows) {
    resetTestDb();
    seedTrackedApp({
      id: APP_ID,
      name: APP_NAME,
      privacyPolicyUrl: POLICY_URL,
    });
    setSetting("ai_provider", "openai");
    setSetting("ai_api_key", "sk-test-key");
    seedAnalysis({
      status: row.status,
      sourceText: row.sourceText,
      summaryJson: row.status === "ready" ? KEPT_SUMMARY : null,
      model: row.model ?? null,
    });
    fetchedUrls = [];

    // What the tab reads, as PolicySummaryPanel computes it.
    const analysis = getPolicyAnalysis(APP_ID);
    assert.ok(analysis);
    const offered = canSummariseStoredPolicy({
      force: true,
      hasSourceText: (analysis.sourceLength ?? 0) > 0,
      model: analysis.model,
      status: analysis.status,
    });

    // What the server does with the tab's request (the regenerate route
    // forces every run). The stubbed model fails, which is enough: only
    // a run that summarises calls it.
    await syncPrivacyPolicyAnalysis(REQUEST, {
      phase: "summarise",
      forceResummarise: true,
    });
    const summarised = fetchedUrls.length > 0;

    const label = `${row.status}${row.sourceText ? "" : " (no text)"}${row.model ? ` (${row.model})` : ""}`;
    assert.equal(
      offered,
      summarised,
      `${label}: offered ${offered}, summarised ${summarised}`
    );
    // Summarise never fetches the policy itself.
    assert.ok(!fetchedUrls.includes(POLICY_URL));
    if (offered) {
      offeredRows.push(label);
    }
  }
  // Only a clean capture is summarised, including one whose last summary
  // run failed or found no AI provider: not the text kept after a failed
  // or unusable fetch, and not an imported excerpt.
  assert.deepEqual(offeredRows, [
    "ready",
    "source_ready",
    "needs_ai_config",
    "analysis_error",
  ]);
});

test("the regenerate route answers a Summarise after a failed fetch with the stored analysis", async () => {
  seedAnalysis({ status: "fetch_error", error: "HTTP 503" });

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
  const body = await res.json();
  assert.equal(body.analysis?.status, "fetch_error");
  assert.equal(body.analysis?.sourceLength, KEPT_TEXT.length);
  assertSkipped("fetch_error", "Policy skipped: latest fetch failed");
});

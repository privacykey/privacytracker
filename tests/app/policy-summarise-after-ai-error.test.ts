/**
 * Summarise after a failed AI summary, or one that found no AI provider.
 *
 * Only the summarise phase writes 'analysis_error' (the AI call failed) and
 * 'needs_ai_config' (no provider was set up), each over a clean capture it
 * accepted, and any later fetch replaces them. The text stored with them is
 * therefore still the latest clean capture, with no summary of its own. The
 * summarise phase used to decline it, log the old failure again ("Summary
 * failed: ..." or "AI not configured", even with a provider set up) and make
 * no summary, so only a rescrape could lead to one, and with policy scraping
 * disabled nothing could. These tests pin that it is summarised like a
 * capture waiting for its summary, with or without force, that a second
 * failure reports its own error, that a run with still no provider says so,
 * and that the Summarise request gets through while scraping is disabled.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { POST } from "../../app/api/policy/regenerate/route";
import { getRecentActivity } from "../../lib/activity";
import db from "../../lib/db";
import { syncPrivacyPolicyAnalysis } from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

// Numeric, because the regenerate route only accepts an App Store id.
const APP_ID = "1000000303";
const APP_NAME = "AI Error Fixture";
const POLICY_URL = "https://example.com/privacy-ai-error-test";
const REQUEST = { appId: APP_ID, appName: APP_NAME, policyUrl: POLICY_URL };
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4.1-mini";

// The latest clean capture, stored by the fetch the failed run summarised.
const STORED_TEXT = "We collect your email address to run the service. "
  .repeat(60)
  .trim();
const PREVIOUS_SUMMARY = JSON.stringify({
  overview: "A summary of an earlier version of the policy.",
  highlights: [],
  lenses: [],
});
const NEW_SUMMARY = {
  overview: "A summary of the stored policy text.",
  highlights: ["Collects email addresses."],
  lenses: [
    {
      key: "collection_scope",
      rating: "mixed",
      summary: "Collects an email address.",
    },
  ],
};
const NEEDS_CONFIG_ERROR =
  "Configure an AI provider in Settings to enable privacy-policy summaries.";

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
let calls: Array<{ body: string; url: string }> = [];
// How the stubbed model answers: a summary, or an error status.
let modelReply: "summary" | "error" = "summary";

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  seedTrackedApp({ id: APP_ID, name: APP_NAME, privacyPolicyUrl: POLICY_URL });
  setSetting("ai_provider", "openai");
  setSetting("ai_api_key", "sk-test-key");
  setSetting("ai_model", MODEL);
  setSetting("policy_scrape_throttle_enabled", "false");
  calls = [];
  modelReply = "summary";
  // The model answers; anything else, the policy page included, fails.
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (url !== OPENAI_URL) {
      throw new TypeError(`Unexpected fetch: ${url}`);
    }
    if (modelReply === "error") {
      return new Response("The model is overloaded.", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(NEW_SUMMARY) } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
});

function seedAnalysis(input: {
  error: string;
  model: string | null;
  status: string;
}): void {
  db.prepare(`
    INSERT INTO privacy_policy_analyses (
      app_id, policy_url, status, source_title, source_content_type,
      source_text, source_word_count, source_origin, source_final_url,
      content_hash, summary_json, previous_summary_json, previous_summary_at,
      model, error, updated_at, source_fetched_at
    )
    VALUES (?, ?, ?, 'example.com', 'text/plain; charset=utf-8', ?, ?,
      'direct', ?, ?, NULL, ?, 5, ?, ?, 10, 7)
  `).run(
    APP_ID,
    POLICY_URL,
    input.status,
    STORED_TEXT,
    STORED_TEXT.split(/\s+/).length,
    POLICY_URL,
    createHash("sha256").update(STORED_TEXT).digest("hex"),
    PREVIOUS_SUMMARY,
    input.model,
    input.error
  );
}

function storedRow(): Record<string, unknown> {
  return db
    .prepare(
      `SELECT status, source_text, content_hash, summary_json,
              previous_summary_json, previous_summary_at, model, error,
              source_fetched_at
         FROM privacy_policy_analyses WHERE app_id = ?`
    )
    .get(APP_ID) as Record<string, unknown>;
}

function onlyActivityRow() {
  const rows = getRecentActivity({ type: "policy_summary" });
  assert.equal(rows.length, 1);
  return rows[0];
}

const STORED_FAILURES = [
  {
    status: "analysis_error",
    error: "OpenAI request timed out after 90 seconds.",
    model: MODEL,
  },
  { status: "needs_ai_config", error: NEEDS_CONFIG_ERROR, model: null },
] as const;

for (const stored of STORED_FAILURES) {
  for (const forceResummarise of [true, false]) {
    test(`a summarise after ${stored.status} summarises the stored text (forceResummarise: ${forceResummarise})`, async () => {
      seedAnalysis(stored);

      const events: string[] = [];
      const result = await syncPrivacyPolicyAnalysis(REQUEST, {
        phase: "summarise",
        forceResummarise,
        phaseStream: { emit: (entry) => events.push(entry.phase) },
      });

      // One call, to the model, with the stored text; the policy is not
      // fetched again.
      assert.deepEqual(
        calls.map((call) => call.url),
        [OPENAI_URL]
      );
      assert.ok(calls[0].body.includes("We collect your email address"));
      assert.ok(!events.includes("skip"), events.join(", "));

      assert.equal(result?.status, "ready");
      assert.equal(result?.summary?.overview, NEW_SUMMARY.overview);
      assert.equal(result?.error, undefined);
      // The capture is the one the failed run had: same text, same hash,
      // same fetch time. The summary it replaces stays the previous one.
      assert.deepEqual(storedRow(), {
        status: "ready",
        source_text: STORED_TEXT,
        content_hash: createHash("sha256").update(STORED_TEXT).digest("hex"),
        summary_json: JSON.stringify(result?.summary),
        previous_summary_json: PREVIOUS_SUMMARY,
        previous_summary_at: 5,
        model: MODEL,
        error: null,
        source_fetched_at: 7,
      });

      const row = onlyActivityRow();
      assert.equal(row.status, "ok");
      assert.equal(row.summary, "Policy summary ready");
      assert.equal(row.detail?.phase, "summarise");
      assert.equal(row.detail?.resultStatus, "ready");
    });
  }
}

test("a failed AI summary that fails again reports its own error", async () => {
  seedAnalysis(STORED_FAILURES[0]);
  modelReply = "error";

  const result = await syncPrivacyPolicyAnalysis(REQUEST, {
    phase: "summarise",
    forceResummarise: true,
  });

  // The model was asked again, and its new answer is the error stored and
  // logged, not the one from the earlier run.
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.url === OPENAI_URL));
  assert.equal(result?.status, "analysis_error");
  assert.ok(result?.error);
  assert.notEqual(result.error, STORED_FAILURES[0].error);
  assert.match(result.error, /503/);
  const stored = storedRow();
  assert.equal(stored.status, "analysis_error");
  assert.equal(stored.error, result.error);
  assert.equal(stored.source_text, STORED_TEXT);
  assert.equal(stored.source_fetched_at, 7);

  const row = onlyActivityRow();
  assert.equal(row.status, "error");
  assert.equal(row.summary, `Summary failed: ${result.error}`.slice(0, 200));
});

test("a summarise that still finds no AI provider says so, without a call", async () => {
  seedAnalysis(STORED_FAILURES[1]);
  setSetting("ai_provider", "disabled");

  const events: string[] = [];
  const result = await syncPrivacyPolicyAnalysis(REQUEST, {
    phase: "summarise",
    forceResummarise: true,
    phaseStream: { emit: (entry) => events.push(entry.phase) },
  });

  // This run looked for a provider and found none, which is what it logs.
  assert.deepEqual(calls, []);
  assert.deepEqual(events, ["needs-config"]);
  assert.equal(result?.status, "needs_ai_config");
  assert.equal(result?.error, NEEDS_CONFIG_ERROR);
  const stored = storedRow();
  assert.equal(stored.status, "needs_ai_config");
  assert.equal(stored.source_text, STORED_TEXT);
  assert.equal(stored.source_fetched_at, 7);

  const row = onlyActivityRow();
  assert.equal(row.status, "partial");
  assert.equal(row.summary, "Policy source ready — AI not configured");
});

function regenerate(phase: string): Promise<Response> {
  return POST(
    new Request("http://127.0.0.1/api/policy/regenerate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
      },
      body: JSON.stringify({ appId: APP_ID, phase }),
    })
  );
}

test("with policy scraping disabled, Summarise is the way to a summary after a failed AI run", async () => {
  seedAnalysis(STORED_FAILURES[0]);
  setSetting("policy_scrape_disabled", "true");

  // "Rescrape + summarise" and "Retry analysis" fetch first, so they are
  // refused while scraping is disabled.
  const refused = await regenerate("all");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "policy_scrape_disabled");

  const res = await regenerate("summarise");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.analysis?.status, "ready");
  assert.equal(body.analysis?.summary?.overview, NEW_SUMMARY.overview);
  assert.deepEqual(
    calls.map((call) => call.url),
    [OPENAI_URL]
  );
  assert.equal(onlyActivityRow().summary, "Policy summary ready");
});

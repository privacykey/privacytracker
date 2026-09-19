/**
 * A summary run that finds no usable AI provider keeps the summary it was
 * replacing.
 *
 * "Summarise" on the AI Policy tab summarises a ready policy again (the
 * regenerate route forces every run). When no AI provider could be used (a
 * provider is chosen but its API key or model is blank), the
 * 'needs_ai_config' write stored no summary and kept only the older
 * previous one, so the summary on the tab was lost: the tab said AI
 * summaries were disabled, and the next summary that worked compared
 * itself with the older one. A failed AI call used to lose it the same way
 * and no longer does (policy-failed-resummarise-keeps-summary.test.ts).
 *
 * These tests pin that a run with no usable provider keeps the summary,
 * with the mode and model that made it, that a run with no summary to keep
 * still stores none, and that the next summary moves the kept one, not an
 * older one, into previous_*.
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
const APP_ID = "1000000305";
const APP_NAME = "No Provider Fixture";
const POLICY_URL = "https://example.com/privacy-no-provider-test";
const REQUEST = { appId: APP_ID, appName: APP_NAME, policyUrl: POLICY_URL };
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// The model configured once the provider is complete. The summary on the
// tab was made by another.
const MODEL = "gpt-4.1-mini";
const SUMMARY_MODEL = "gpt-4o";
const NEEDS_CONFIG_ERROR =
  "Configure an AI provider in Settings to enable privacy-policy summaries.";

const STORED_TEXT = "We collect your email address to run the service. "
  .repeat(60)
  .trim();
const STORED_HASH = createHash("sha256").update(STORED_TEXT).digest("hex");
const OLDER_SUMMARY = JSON.stringify({
  overview: "A summary from two runs ago.",
  highlights: [],
  lenses: [],
});
const CURRENT_SUMMARY = JSON.stringify({
  overview: "The summary on the tab.",
  highlights: ["Collects email addresses."],
  lenses: [],
});
const NEW_SUMMARY = {
  overview: "A new summary of the stored policy text.",
  highlights: ["Collects email addresses."],
  lenses: [
    {
      key: "collection_scope",
      rating: "mixed",
      summary: "Collects an email address.",
    },
  ],
};

// Each way a run finds no provider it can use. The tab only disables
// Summarise for the first; the other two reach the server from the tab.
const NO_PROVIDER = [
  { label: "provider disabled", apply: () => setAi({ provider: "disabled" }) },
  { label: "blank API key", apply: () => setAi({ apiKey: "   " }) },
  { label: "blank model", apply: () => setAi({ model: "   " }) },
] as const;

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
let calls: string[] = [];

function setAi({
  provider = "openai",
  apiKey = "sk-test-key",
  model = MODEL,
}: {
  provider?: string;
  apiKey?: string;
  model?: string;
}): void {
  setSetting("ai_provider", provider);
  setSetting("ai_api_key", apiKey);
  setSetting("ai_model", model);
}

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  seedTrackedApp({ id: APP_ID, name: APP_NAME, privacyPolicyUrl: POLICY_URL });
  setAi({});
  calls = [];
  // The model answers; anything else, the policy page included, fails.
  global.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url !== OPENAI_URL) {
      throw new TypeError(`Unexpected fetch: ${url}`);
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

/**
 * A policy summarised twice: the summary on the tab, made by
 * SUMMARY_MODEL at time 10, and the one before it, from time 5. Fetched at
 * time 7. Or, with `summarised: false`, the same capture waiting for its
 * first summary.
 */
function seedAnalysis({ summarised = true } = {}): void {
  db.prepare(`
    INSERT INTO privacy_policy_analyses (
      app_id, policy_url, status, source_title, source_content_type,
      source_text, source_word_count, source_origin, source_final_url,
      content_hash, analysis_mode, summary_json, previous_summary_json,
      previous_summary_at, model, error, updated_at, source_fetched_at
    )
    VALUES (?, ?, ?, 'example.com', 'text/plain; charset=utf-8', ?, ?,
      'direct', ?, ?, ?, ?, ?, ?, ?, NULL, 10, 7)
  `).run(
    APP_ID,
    POLICY_URL,
    summarised ? "ready" : "source_ready",
    STORED_TEXT,
    STORED_TEXT.split(/\s+/).length,
    POLICY_URL,
    STORED_HASH,
    summarised ? "direct" : null,
    summarised ? CURRENT_SUMMARY : null,
    summarised ? OLDER_SUMMARY : null,
    summarised ? 5 : null,
    summarised ? SUMMARY_MODEL : null
  );
}

function storedRow(): Record<string, unknown> {
  return db
    .prepare(
      `SELECT status, source_text, content_hash, analysis_mode, summary_json,
              previous_summary_json, previous_summary_at, model, error,
              updated_at, source_fetched_at
         FROM privacy_policy_analyses WHERE app_id = ?`
    )
    .get(APP_ID) as Record<string, unknown>;
}

function summarise(forceResummarise: boolean) {
  return syncPrivacyPolicyAnalysis(REQUEST, {
    phase: "summarise",
    forceResummarise,
  });
}

for (const noProvider of NO_PROVIDER) {
  test(`a forced resummarise with no usable AI provider keeps the summary (${noProvider.label})`, async () => {
    seedAnalysis();
    noProvider.apply();

    const result = await summarise(true);

    // Nothing was asked: there was no provider to ask.
    assert.deepEqual(calls, []);
    assert.equal(result?.status, "needs_ai_config");
    assert.equal(result?.error, NEEDS_CONFIG_ERROR);
    // The tab still has the summary to show, and the one before it for
    // "What changed", credited to the model that made it.
    assert.equal(result?.summary?.overview, "The summary on the tab.");
    assert.equal(
      result?.previousSummary?.overview,
      "A summary from two runs ago."
    );
    assert.equal(result?.model, SUMMARY_MODEL);

    const stored = storedRow();
    assert.equal(typeof stored.updated_at, "number");
    assert.deepEqual(
      { ...stored, updated_at: "(this run)" },
      {
        status: "needs_ai_config",
        source_text: STORED_TEXT,
        content_hash: STORED_HASH,
        analysis_mode: "direct",
        summary_json: CURRENT_SUMMARY,
        previous_summary_json: OLDER_SUMMARY,
        previous_summary_at: 5,
        model: SUMMARY_MODEL,
        error: NEEDS_CONFIG_ERROR,
        updated_at: "(this run)",
        source_fetched_at: 7,
      }
    );

    const rows = getRecentActivity({ type: "policy_summary" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "partial");
    assert.equal(rows[0].summary, "Policy source ready — AI not configured");
  });
}

test("a run with no usable AI provider and no summary to keep stores none", async () => {
  seedAnalysis({ summarised: false });
  setAi({ apiKey: "" });

  const result = await summarise(true);

  assert.deepEqual(calls, []);
  assert.equal(result?.status, "needs_ai_config");
  assert.equal(result?.summary, null);
  const stored = storedRow();
  assert.equal(stored.summary_json, null);
  assert.equal(stored.analysis_mode, null);
  assert.equal(stored.previous_summary_json, null);
  assert.equal(stored.model, null);
});

for (const forceResummarise of [true, false]) {
  test(`the summary once a provider is set up replaces the kept one (forceResummarise: ${forceResummarise})`, async () => {
    seedAnalysis();
    setAi({ apiKey: "" });
    await summarise(true);
    const keptAt = storedRow().updated_at;

    // The status still asks for a summary, so an unforced run makes one.
    setAi({});
    const result = await summarise(forceResummarise);

    assert.deepEqual(calls, [OPENAI_URL]);
    assert.equal(result?.status, "ready");
    assert.equal(result?.summary?.overview, NEW_SUMMARY.overview);
    // "What changed" compares the new summary with the one the tab
    // showed, not with the one from two runs ago.
    assert.equal(result?.previousSummary?.overview, "The summary on the tab.");
    const stored = storedRow();
    assert.equal(stored.previous_summary_json, CURRENT_SUMMARY);
    // Dated like any summary a run replaces: when the row last stood with
    // it, here the run that found no provider.
    assert.equal(stored.previous_summary_at, keptAt);
    assert.equal(stored.model, MODEL);
    assert.equal(stored.error, null);
    assert.equal(stored.source_fetched_at, 7);
  });
}

function regenerate(): Promise<Response> {
  return POST(
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
}

test("Summarise on the AI Policy tab keeps the summary when the API key is blank", async () => {
  seedAnalysis();
  setAi({ apiKey: "" });

  const kept = await regenerate();
  assert.equal(kept.status, 200);
  const keptBody = await kept.json();
  // The tab reads a needs-config status with a summary: it shows the
  // summary under the note that the AI refresh could not run.
  assert.equal(keptBody.analysis?.status, "needs_ai_config");
  assert.equal(keptBody.analysis?.summary?.overview, "The summary on the tab.");
  assert.equal(keptBody.analysis?.model, SUMMARY_MODEL);

  setAi({});
  const retried = await regenerate();
  assert.equal(retried.status, 200);
  const retriedBody = await retried.json();
  assert.equal(retriedBody.analysis?.status, "ready");
  assert.equal(retriedBody.analysis?.summary?.overview, NEW_SUMMARY.overview);
  assert.equal(
    retriedBody.analysis?.previousSummary?.overview,
    "The summary on the tab."
  );
  assert.deepEqual(calls, [OPENAI_URL]);
});

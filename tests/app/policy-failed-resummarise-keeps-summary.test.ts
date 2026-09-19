/**
 * A failed summary run keeps the summary it was replacing.
 *
 * "Summarise" on the AI Policy tab summarises a ready policy again (the
 * regenerate route forces every run). When that AI call failed, the
 * 'analysis_error' write stored no summary and kept only the older previous
 * one, so the summary on the tab was lost: the tab said the AI summary could
 * not be generated, and its "The latest AI refresh failed, so this summary
 * may be out of date." state was never reached. A resummarise that worked
 * lost it too whenever an older summary was stored as the previous one,
 * because it kept that older one as the baseline for "What changed".
 *
 * These tests pin that a failed run keeps the summary, with the mode and
 * model that made it, that a run with no summary to keep still names the
 * model that failed, and that the next summary moves the kept one, not an
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
const APP_ID = "1000000304";
const APP_NAME = "Kept Summary Fixture";
const POLICY_URL = "https://example.com/privacy-kept-summary-test";
const REQUEST = { appId: APP_ID, appName: APP_NAME, policyUrl: POLICY_URL };
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// The model configured now. The summary on the tab was made by another.
const MODEL = "gpt-4.1-mini";
const SUMMARY_MODEL = "gpt-4o";

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

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
let calls: string[] = [];
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
  calls = [];
  modelReply = "summary";
  // The model answers; anything else, the policy page included, fails.
  global.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
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

test("a failed forced resummarise keeps the summary it was replacing", async () => {
  seedAnalysis();
  modelReply = "error";

  const result = await summarise(true);

  // The model was asked, once, and failed.
  assert.deepEqual(calls, [OPENAI_URL]);
  assert.equal(result?.status, "analysis_error");
  assert.match(result?.error ?? "", /503/);
  // The tab still has the summary to show, beside the note that the
  // latest refresh failed, and the one before it for "What changed".
  assert.equal(result?.summary?.overview, "The summary on the tab.");
  assert.equal(
    result?.previousSummary?.overview,
    "A summary from two runs ago."
  );
  // The summary is still credited to the model that made it, not to the
  // configured model that failed.
  assert.equal(result?.model, SUMMARY_MODEL);

  const stored = storedRow();
  assert.equal(typeof stored.updated_at, "number");
  assert.deepEqual(
    { ...stored, updated_at: "(this run)" },
    {
      status: "analysis_error",
      source_text: STORED_TEXT,
      content_hash: STORED_HASH,
      analysis_mode: "direct",
      summary_json: CURRENT_SUMMARY,
      previous_summary_json: OLDER_SUMMARY,
      previous_summary_at: 5,
      model: SUMMARY_MODEL,
      error: result?.error,
      updated_at: "(this run)",
      source_fetched_at: 7,
    }
  );

  const rows = getRecentActivity({ type: "policy_summary" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "error");
  assert.equal(
    rows[0].summary,
    `Summary failed: ${result?.error}`.slice(0, 200)
  );
});

test("a failed first summary stores none and names the model that failed", async () => {
  seedAnalysis({ summarised: false });
  modelReply = "error";

  const result = await summarise(true);

  assert.deepEqual(calls, [OPENAI_URL]);
  assert.equal(result?.status, "analysis_error");
  assert.equal(result?.summary, null);
  const stored = storedRow();
  assert.equal(stored.summary_json, null);
  assert.equal(stored.analysis_mode, null);
  assert.equal(stored.previous_summary_json, null);
  assert.equal(stored.model, MODEL);
});

for (const forceResummarise of [true, false]) {
  test(`the summary after a failed run replaces the kept one (forceResummarise: ${forceResummarise})`, async () => {
    seedAnalysis();
    modelReply = "error";
    await summarise(true);
    const failedAt = storedRow().updated_at;

    // The failed run's status still asks for a summary, so an unforced
    // run makes one too.
    modelReply = "summary";
    const result = await summarise(forceResummarise);

    assert.deepEqual(calls, [OPENAI_URL, OPENAI_URL]);
    assert.equal(result?.status, "ready");
    assert.equal(result?.summary?.overview, NEW_SUMMARY.overview);
    // "What changed" compares the new summary with the one the tab
    // showed, not with the one from two runs ago.
    assert.equal(result?.previousSummary?.overview, "The summary on the tab.");
    const stored = storedRow();
    assert.equal(stored.previous_summary_json, CURRENT_SUMMARY);
    // Dated like any summary a run replaces: when the row last stood
    // with it, here the failed run.
    assert.equal(stored.previous_summary_at, failedAt);
    assert.equal(stored.model, MODEL);
    assert.equal(stored.error, null);
    assert.equal(stored.source_fetched_at, 7);
  });
}

test("a forced resummarise that works first time keeps the summary it replaces, not an older one", async () => {
  seedAnalysis();

  const result = await summarise(true);

  assert.deepEqual(calls, [OPENAI_URL]);
  assert.equal(result?.status, "ready");
  assert.equal(result?.previousSummary?.overview, "The summary on the tab.");
  const stored = storedRow();
  assert.equal(stored.previous_summary_json, CURRENT_SUMMARY);
  assert.equal(stored.previous_summary_at, 10);
});

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

test("Summarise on the AI Policy tab keeps the summary when the AI call fails", async () => {
  seedAnalysis();

  modelReply = "error";
  const failed = await regenerate();
  assert.equal(failed.status, 200);
  const failedBody = await failed.json();
  // The tab reads a failed status with a summary: it shows the summary
  // under "The latest AI refresh failed, so this summary may be out of
  // date.", not "the AI summary could not be generated".
  assert.equal(failedBody.analysis?.status, "analysis_error");
  assert.equal(
    failedBody.analysis?.summary?.overview,
    "The summary on the tab."
  );

  modelReply = "summary";
  const retried = await regenerate();
  assert.equal(retried.status, 200);
  const retriedBody = await retried.json();
  assert.equal(retriedBody.analysis?.status, "ready");
  assert.equal(retriedBody.analysis?.summary?.overview, NEW_SUMMARY.overview);
  assert.equal(
    retriedBody.analysis?.previousSummary?.overview,
    "The summary on the tab."
  );
  assert.deepEqual(calls, [OPENAI_URL, OPENAI_URL]);
});

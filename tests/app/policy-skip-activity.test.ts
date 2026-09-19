/**
 * A policy run the throttle or the kill-switch skipped is logged and
 * counted as a skip.
 *
 * Both gates hand back the stored analysis with their own run-log line
 * last (`throttled`, `disabled`). The activity row was built from that
 * analysis's status alone, so a throttled skip of a ready policy read
 * "Policy source fetched (cached)", or "Policy summary ready" for a fetch
 * and summary, and the kill-switch over a stored fetch error logged a
 * fresh "Fetch failed" at error status. The bulk runner counted an app the
 * kill-switch skipped by that stored status too, so switching scraping off
 * during a run counted a stored fetch error as a failure and a stored
 * summary as a success, although nothing was fetched.
 *
 * These tests pin that a skip is logged as one, read from the last line of
 * the run's own log, per app and in bulk; and that a run which went on to
 * summarise the stored text after the kill-switch is not.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { getRecentActivity } from "../../lib/activity";
import db from "../../lib/db";
import { runBulkPolicySync } from "../../lib/policy-bulk-runner";
import { syncPrivacyPolicyAnalysis } from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TEXT = "We collect your email address to run the service. "
  .repeat(60)
  .trim();
const SUMMARY = JSON.stringify({
  overview: "A summary of the stored policy.",
  highlights: [],
  lenses: [],
});

interface Fixture {
  id: string;
  name: string;
  url: string;
}
// The bulk runner queues apps by name.
const ALPHA: Fixture = {
  id: "1000000501",
  name: "Alpha Skip",
  url: "https://alpha.example.com/privacy",
};
const BRAVO: Fixture = {
  id: "1000000502",
  name: "Bravo Skip",
  url: "https://bravo.example.com/privacy",
};
const CHARLIE: Fixture = {
  id: "1000000503",
  name: "Charlie Skip",
  url: "https://charlie.example.com/privacy",
};
const request = (app: Fixture) => ({
  appId: app.id,
  appName: app.name,
  policyUrl: app.url,
});

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
let policyFetches: string[] = [];

/**
 * Policy pages answer with `TEXT` (and `onPolicyFetch` runs first); the
 * archive lookup and Save Page Now are refused, which neither treats as a
 * failure of the run. Anything else is unexpected.
 */
function stubFetch(onPolicyFetch: (url: string) => void = () => {}): void {
  global.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const host = new URL(url).hostname;
    if (host === "archive.org" || host === "web.archive.org") {
      return new Response("", { status: 503 });
    }
    if ([ALPHA, BRAVO, CHARLIE].some((app) => app.url === url)) {
      policyFetches.push(url);
      onPolicyFetch(url);
      return new Response(TEXT, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw new TypeError(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  for (const app of [ALPHA, BRAVO, CHARLIE]) {
    seedTrackedApp({ id: app.id, name: app.name, privacyPolicyUrl: app.url });
  }
  setSetting("ai_provider", "disabled");
  policyFetches = [];
  stubFetch();
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
});

/** A stored analysis of `app`'s policy, fetched `fetchedAgoMs` ago. */
function seedAnalysis(
  app: Fixture,
  fetchedAgoMs: number,
  over: { status?: string; summaryJson?: string | null; error?: string } = {}
): void {
  const fetchedAt = Date.now() - fetchedAgoMs;
  const summaryJson =
    over.summaryJson === undefined ? SUMMARY : over.summaryJson;
  db.prepare(`
    INSERT INTO privacy_policy_analyses (
      app_id, policy_url, status, source_title, source_content_type,
      source_text, source_word_count, source_origin, source_final_url,
      content_hash, analysis_mode, summary_json, model, error, updated_at,
      last_run_log, source_fetched_at
    )
    VALUES (?, ?, ?, 'example.com', 'text/plain; charset=utf-8', ?, ?,
      'direct', ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    app.id,
    app.url,
    over.status ?? "ready",
    TEXT,
    TEXT.split(/\s+/).length,
    app.url,
    createHash("sha256").update(TEXT).digest("hex"),
    summaryJson ? "direct" : null,
    summaryJson,
    summaryJson ? "fixture-model" : null,
    over.error ?? null,
    fetchedAt,
    fetchedAt
  );
}

/** The one per-app activity row logged for `app`. */
function appRow(app: Fixture) {
  const rows = getRecentActivity({ type: "policy_summary" }).filter(
    (row) => row.appId === app.id
  );
  assert.equal(rows.length, 1, `${app.name}: one activity row`);
  return rows[0];
}

function bulkRow() {
  return getRecentActivity({ type: "policy_summary" }).find(
    (row) => row.appId === null
  );
}

for (const phase of ["fetch", "all"] as const) {
  test(`a throttled ${phase} is logged as a skip, not a fetch`, async () => {
    seedAnalysis(ALPHA, 10 * MINUTE);

    const result = await syncPrivacyPolicyAnalysis(request(ALPHA), { phase });

    assert.deepEqual(policyFetches, []);
    assert.equal(result?.status, "ready");
    const row = appRow(ALPHA);
    assert.equal(row.status, "partial");
    assert.equal(row.summary, "Policy skipped: throttled");
    assert.equal(row.detail?.resultStatus, "ready");
  });

  test(`a bulk ${phase} logs the app it throttled as a skip`, async () => {
    seedAnalysis(ALPHA, 10 * MINUTE);
    seedAnalysis(BRAVO, 2 * DAY);
    db.prepare("DELETE FROM apps WHERE id = ?").run(CHARLIE.id);

    const { totals } = await runBulkPolicySync({
      initiator: "automatic",
      phase,
      force: false,
    });

    assert.deepEqual(policyFetches, [BRAVO.url]);
    assert.equal(totals.throttled, 1);
    assert.equal(appRow(ALPHA).summary, "Policy skipped: throttled");
    assert.equal(appRow(ALPHA).status, "partial");
    // The fetch that ran is logged as the fetch it was.
    assert.notEqual(appRow(BRAVO).summary, "Policy skipped: throttled");
  });
}

test("the kill-switch over a stored fetch error is logged as a skip, not a failure", async () => {
  seedAnalysis(ALPHA, 2 * DAY, {
    status: "fetch_error",
    error: "HTTP 404 Not Found",
  });
  setSetting("policy_scrape_disabled", "true");

  const result = await syncPrivacyPolicyAnalysis(request(ALPHA), {
    phase: "fetch",
  });

  assert.deepEqual(policyFetches, []);
  assert.equal(result?.status, "fetch_error");
  const row = appRow(ALPHA);
  assert.equal(row.status, "partial");
  assert.equal(row.summary, "Policy skipped: scraping disabled");
  assert.equal(row.detail?.resultStatus, "fetch_error");
});

test("scraping switched off during a bulk run skips the apps after it, whatever they stored", async () => {
  // Alpha has nothing stored and is fetched; scraping is switched off
  // while its page is on the way. Bravo's last fetch failed and Charlie's
  // policy was summarised, both two days ago, beyond the throttle.
  seedAnalysis(BRAVO, 2 * DAY, {
    status: "fetch_error",
    error: "HTTP 404 Not Found",
  });
  seedAnalysis(CHARLIE, 2 * DAY);
  stubFetch(() => setSetting("policy_scrape_disabled", "true"));

  const { totals } = await runBulkPolicySync({
    initiator: "manual",
    phase: "fetch",
    force: false,
  });

  assert.deepEqual(policyFetches, [ALPHA.url]);
  assert.deepEqual(totals, {
    attempted: 3,
    succeeded: 1,
    failed: 0,
    throttled: 0,
    skipped: 2,
  });
  assert.equal(appRow(ALPHA).summary, "Policy source fetched");
  for (const app of [BRAVO, CHARLIE]) {
    assert.equal(appRow(app).status, "partial", app.name);
    assert.equal(
      appRow(app).summary,
      "Policy skipped: scraping disabled",
      app.name
    );
  }
  assert.equal(bulkRow()?.status, "ok");
  assert.equal(bulkRow()?.summary, "Bulk policy scrape: 1 ok, 2 skipped");
});

test("a run that summarises the stored text after the kill-switch is not a skip", async () => {
  // The kill-switch stops the fetch, not a summary of the text already
  // stored, so a fetch and summary goes on to summarise it. With no AI
  // provider that summary finds none, which is what the run logs.
  seedAnalysis(ALPHA, 2 * DAY, { status: "source_ready", summaryJson: null });
  setSetting("policy_scrape_disabled", "true");

  const result = await syncPrivacyPolicyAnalysis(request(ALPHA), {
    phase: "all",
  });

  assert.deepEqual(policyFetches, []);
  assert.equal(result?.status, "needs_ai_config");
  assert.equal(result?.lastRunLog?.[0]?.phase, "disabled");
  const row = appRow(ALPHA);
  assert.equal(row.summary, "Policy source ready — AI not configured");
});

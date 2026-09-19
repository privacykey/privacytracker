/**
 * The AI Policy tab's rescrape buttons and the per-app scrape throttle.
 *
 * The throttle (on by default, 60 minutes) holds back a repeat fetch of a
 * summarised policy. It is meant for automatic, bulk and import runs,
 * onboarding's policy step among them, and it held back the tab's
 * "Rescrape policy" and "Rescrape + summarise" too: inside the window
 * those clicks fetched and summarised nothing, while the Activity log and
 * the task tray reported a fetch or a new summary. The regenerate route
 * now passes the throttle when the body's `bypassThrottle` is the boolean
 * true, which only the tab sends. These tests pin that the tab's clicks
 * fetch, that every other caller keeps the throttle, and that the scraping
 * kill-switch still refuses a fetch either way.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POST } from "../../app/api/policy/regenerate/route";
import { getRecentActivity } from "../../lib/activity";
import db from "../../lib/db";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

// Numeric, because the regenerate route only accepts an App Store id.
const APP_ID = "1000000304";
const APP_NAME = "Throttle Fixture";
const POLICY_URL = "https://example.com/privacy-throttle-test";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// The policy as fetched ten minutes ago, and as the page still serves it:
// past the 400 words a fetch needs to count as a policy.
const POLICY_TEXT = Array.from(
  { length: 16 },
  (_, i) =>
    `We collect your email address and device identifiers to run the service. We share information with service providers, and you may request deletion of your personal information at any time. Section ${i + 1}.`
).join("\n\n");
const STORED_SUMMARY = JSON.stringify({
  overview: "The summary made ten minutes ago.",
  highlights: [],
  lenses: [],
});
const NEW_SUMMARY = {
  overview: "A summary of the policy fetched just now.",
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
let fetchedUrls: string[] = [];
let fetchedAt = 0;

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  seedTrackedApp({ id: APP_ID, name: APP_NAME, privacyPolicyUrl: POLICY_URL });
  setSetting("ai_provider", "openai");
  setSetting("ai_api_key", "sk-test-key");
  // The throttle keeps its defaults: on, sixty minutes.
  fetchedAt = Date.now() - 10 * 60_000;
  db.prepare(`
    INSERT INTO privacy_policy_analyses (
      app_id, policy_url, status, source_title, source_content_type,
      source_text, source_word_count, source_origin, source_final_url,
      content_hash, summary_json, model, error, updated_at, source_fetched_at
    )
    VALUES (?, ?, 'ready', 'example.com', 'text/plain; charset=utf-8', ?, ?,
      'direct', ?, ?, ?, 'gpt-4.1-mini', NULL, ?, ?)
  `).run(
    APP_ID,
    POLICY_URL,
    POLICY_TEXT,
    POLICY_TEXT.split(/\s+/).length,
    POLICY_URL,
    createHash("sha256").update(POLICY_TEXT).digest("hex"),
    STORED_SUMMARY,
    fetchedAt,
    fetchedAt
  );
  fetchedUrls = [];
  global.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetchedUrls.push(url);
    if (url === POLICY_URL) {
      return new Response(POLICY_TEXT, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.startsWith("https://archive.org/wayback/available")) {
      return new Response(JSON.stringify({ archived_snapshots: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === OPENAI_URL) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(NEW_SUMMARY) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // Save Page Now, fired and forgotten after a capture: its failure is
    // swallowed.
    throw new TypeError(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
});

// Every route call shares one rate-limit bucket (10 a minute) with no
// trusted proxy, so this file makes seven.
function regenerate(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://127.0.0.1/api/policy/regenerate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
      },
      body: JSON.stringify({ appId: APP_ID, ...body }),
    })
  );
}

function storedRow() {
  return db
    .prepare(
      `SELECT status, summary_json, previous_summary_json, source_fetched_at
         FROM privacy_policy_analyses WHERE app_id = ?`
    )
    .get(APP_ID) as {
    previous_summary_json: string | null;
    source_fetched_at: number;
    status: string;
    summary_json: string | null;
  };
}

function onlyActivitySummary(): string | null {
  const rows = getRecentActivity({ type: "policy_summary" });
  assert.equal(rows.length, 1);
  return rows[0].summary;
}

test("a fetch that does not ask to pass the throttle is still held back", async () => {
  // What onboarding's policy step and API callers send, and values that
  // are not the boolean true.
  for (const extra of [{}, { bypassThrottle: "true" }, { bypassThrottle: 1 }]) {
    const res = await regenerate({ phase: "fetch", ...extra });
    assert.equal(res.status, 200, JSON.stringify(extra));
    const body = await res.json();
    assert.equal(body.analysis?.status, "ready", JSON.stringify(extra));
  }
  assert.deepEqual(fetchedUrls, []);
  const stored = storedRow();
  assert.equal(stored.status, "ready");
  assert.equal(stored.summary_json, STORED_SUMMARY);
  assert.equal(stored.source_fetched_at, fetchedAt);
});

test("the AI Policy tab's rescrape passes the throttle", async () => {
  const res = await regenerate({ phase: "fetch", bypassThrottle: true });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(
    fetchedUrls.some((url) => url === POLICY_URL),
    fetchedUrls.join(", ")
  );
  assert.ok(!fetchedUrls.some((url) => url === OPENAI_URL));
  // The route forces a new summary, so the fresh capture waits for one and
  // the summary it replaces becomes the previous one.
  assert.equal(body.analysis?.status, "source_ready");
  const stored = storedRow();
  assert.equal(stored.status, "source_ready");
  assert.equal(stored.previous_summary_json, STORED_SUMMARY);
  assert.ok(stored.source_fetched_at > fetchedAt);
  assert.equal(onlyActivitySummary(), "Policy source fetched");
});

test("the AI Policy tab's rescrape and summary passes the throttle", async () => {
  const res = await regenerate({ bypassThrottle: true });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(
    fetchedUrls.some((url) => url === POLICY_URL),
    fetchedUrls.join(", ")
  );
  assert.ok(
    fetchedUrls.some((url) => url === OPENAI_URL),
    fetchedUrls.join(", ")
  );
  assert.equal(body.analysis?.status, "ready");
  assert.equal(body.analysis?.summary?.overview, NEW_SUMMARY.overview);
  const stored = storedRow();
  assert.equal(stored.previous_summary_json, STORED_SUMMARY);
  assert.ok(stored.source_fetched_at > fetchedAt);
  assert.equal(onlyActivitySummary(), "Policy summary ready");
});

test("with policy scraping disabled, the tab's rescrape is still refused", async () => {
  setSetting("policy_scrape_disabled", "true");

  for (const phase of ["fetch", "all"]) {
    const res = await regenerate({ phase, bypassThrottle: true });
    assert.equal(res.status, 409, phase);
    assert.equal((await res.json()).code, "policy_scrape_disabled", phase);
  }
  assert.deepEqual(fetchedUrls, []);
  assert.equal(storedRow().summary_json, STORED_SUMMARY);
  assert.deepEqual(getRecentActivity({ type: "policy_summary" }), []);
});

test("only the AI Policy tab asks to pass the throttle", () => {
  const source = (file: string) =>
    readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  // Each call to the route, with the body it sends.
  const regenerateBodies = (text: string) =>
    [
      ...text.matchAll(
        /fetch\("\/api\/policy\/regenerate",[\s\S]*?body: JSON\.stringify\(([\s\S]*?)\),\n/g
      ),
    ].map((match) => match[1]);

  const tab = regenerateBodies(
    source("app/components/detail/PolicySummaryPanel.tsx")
  );
  assert.equal(tab.length, 1);
  assert.match(tab[0], /bypassThrottle: true/);

  // Onboarding's policy step fetches every imported app, so it keeps the
  // throttle: a re-run inside the window would otherwise fetch and
  // summarise every policy again.
  const wizard = regenerateBodies(source("lib/use-onboard-wizard.ts"));
  assert.equal(wizard.length, 2);
  for (const body of wizard) {
    assert.doesNotMatch(body, /bypassThrottle/);
  }
});

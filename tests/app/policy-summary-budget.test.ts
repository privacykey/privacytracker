import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import { POLICY_LENSES } from "../../lib/policy-summary-meta";
import {
  getPolicyAnalysis,
  MAX_POLICY_SOURCE_CHARS,
  MAX_SUMMARY_CHUNKS,
  syncPrivacyPolicyAnalysis,
} from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

// The hosted provider (no chunking hint in the model name) summarises up
// to 40,000 characters in one call and otherwise splits the text into
// 12,000-character chunks, one provider call each, plus one merge call.
const HOSTED_CHUNK_CHARS = 12_000;

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  setSetting("policy_scrape_throttle_enabled", "false");
  setSetting("ai_provider", "openai");
  setSetting("ai_model", "fixture-policy-model");
  setSetting("ai_api_key", "fixture-key");
  setSetting("ai_base_url", "https://api.openai.test/v1");
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
});

test("a fetched policy longer than the cap is stored bounded and summarised within the chunk budget", async () => {
  seedTrackedApp({
    id: "long-policy-app",
    name: "Long Policy",
    privacyPolicyUrl: "https://example.com/long",
  });
  // About 520,000 characters of keyword-rich paragraphs; the fetch cap is 6 MiB.
  const policy = policyParagraphs(1800);
  assert.ok(policy.length > MAX_POLICY_SOURCE_CHARS);

  const ai = countingAiFetch({
    "https://example.com/long": () =>
      new Response(policy, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
  });
  global.fetch = ai.fetch;

  const result = await syncPrivacyPolicyAnalysis(
    {
      appId: "long-policy-app",
      appName: "Long Policy",
      policyUrl: "https://example.com/long",
    },
    { phase: "all", forceResummarise: true, bypassThrottle: true }
  );

  assert.equal(result?.status, "ready");
  assert.ok(
    (result?.sourceLength ?? 0) <= MAX_POLICY_SOURCE_CHARS,
    `stored ${result?.sourceLength} characters`
  );
  assert.ok(
    result?.lastRunLog?.some((entry) => entry.phase === "fetch:truncated"),
    "the run log says the text was bounded"
  );
  const stored = db
    .prepare(
      "SELECT length(source_text) AS chars FROM privacy_policy_versions WHERE app_id = ?"
    )
    .get("long-policy-app") as { chars: number };
  assert.ok(stored.chars <= MAX_POLICY_SOURCE_CHARS);

  // At most one call per chunk of the bounded text, plus the merge.
  const chunkCeiling = Math.ceil(MAX_POLICY_SOURCE_CHARS / HOSTED_CHUNK_CHARS);
  assert.ok(
    ai.chunkCalls <= chunkCeiling + 1,
    `${ai.chunkCalls} chunk calls for a bounded text`
  );
  assert.equal(ai.mergeCalls, 1);
  assert.ok(ai.chunkCalls <= MAX_SUMMARY_CHUNKS);
});

test("a stored text over the chunk budget is refused before any provider call", async () => {
  seedTrackedApp({
    id: "huge-stored-app",
    name: "Huge Stored",
    privacyPolicyUrl: "https://example.com/huge",
  });
  // Paragraphs just under a chunk each, so every one is its own chunk and
  // the count passes the budget: a row written before the fetch bounded
  // its text, or by another path.
  const paragraph = policyParagraphs(1).padEnd(HOSTED_CHUNK_CHARS - 200, " x");
  const text = Array.from(
    { length: MAX_SUMMARY_CHUNKS + 10 },
    () => paragraph
  ).join("\n\n");
  seedStoredSource("huge-stored-app", "https://example.com/huge", text);

  const ai = countingAiFetch({});
  global.fetch = ai.fetch;

  const result = await syncPrivacyPolicyAnalysis(
    {
      appId: "huge-stored-app",
      appName: "Huge Stored",
      policyUrl: "https://example.com/huge",
    },
    { phase: "summarise", forceResummarise: true }
  );

  assert.equal(result?.status, "analysis_error");
  assert.match(result?.error ?? "", /chunks; one summary makes at most/);
  assert.equal(ai.chunkCalls + ai.mergeCalls, 0);
  assert.ok(
    result?.lastRunLog?.some((entry) => entry.phase === "chunk-budget"),
    "the run log names the budget"
  );
});

test("a cancelled summary stops at the next provider call and keeps its chunk notes", async () => {
  seedTrackedApp({
    id: "cancelled-app",
    name: "Cancelled",
    privacyPolicyUrl: "https://example.com/cancelled",
  });
  // Six chunks' worth of text, stored as a clean source.
  seedStoredSource(
    "cancelled-app",
    "https://example.com/cancelled",
    policyParagraphs(240)
  );

  const cancel = new AbortController();
  const ai = countingAiFetch({}, () => {
    // The user presses Stop while the first chunk is being summarised.
    cancel.abort();
  });
  global.fetch = ai.fetch;

  const result = await syncPrivacyPolicyAnalysis(
    {
      appId: "cancelled-app",
      appName: "Cancelled",
      policyUrl: "https://example.com/cancelled",
    },
    { phase: "summarise", forceResummarise: true, signal: cancel.signal }
  );

  assert.equal(result?.status, "analysis_error");
  assert.match(result?.error ?? "", /cancelled/i);
  assert.equal(ai.chunkCalls, 1);
  assert.equal(ai.mergeCalls, 0);
  // The note from the chunk that finished is kept for the next run.
  assert.equal(getPolicyAnalysis("cancelled-app")?.chunkNotes?.length, 1);
});

// ── Fixture helpers ─────────────────────────────────────────────────────

function policyParagraphs(count: number): string {
  const paragraph = [
    "This privacy policy explains how the developer collects account information, contact information, device identifiers, usage data, diagnostics, and approximate location data.",
    "We use personal information to provide the product, secure accounts, prevent fraud, personalize features, perform analytics, measure advertising, and improve services.",
    "We share data with service providers, affiliates, analytics partners, advertising partners, payment processors, and legal authorities where required.",
  ].join(" ");
  return Array.from(
    { length: count },
    (_, i) => `${paragraph} Section ${i + 1}.`
  ).join("\n\n");
}

function seedStoredSource(
  appId: string,
  policyUrl: string,
  text: string
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO privacy_policy_analyses (
       app_id, policy_url, status, source_text, source_word_count,
       content_hash, updated_at, source_fetched_at
     ) VALUES (?, ?, 'source_ready', ?, ?, ?, ?, ?)`
  ).run(
    appId,
    policyUrl,
    text,
    text.split(/\s+/).length,
    `hash-${appId}`,
    now,
    now
  );
}

/**
 * A fetch stub that answers the policy URLs given, counts the provider
 * calls by the JSON schema they ask for, and answers each with a reply of
 * the matching shape. `onChunkCall` runs when a chunk call arrives.
 */
function countingAiFetch(
  pages: Record<string, () => Response>,
  onChunkCall?: () => void
): { fetch: typeof fetch; chunkCalls: number; mergeCalls: number } {
  const counts = { chunkCalls: 0, mergeCalls: 0 };
  const stub = (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    const page = pages[url];
    if (page) {
      return page();
    }
    if (url.startsWith("https://archive.org/wayback/available")) {
      return new Response(JSON.stringify({ archived_snapshots: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://web.archive.org/save/")) {
      return new Response("", { status: 503 });
    }
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        response_format?: { json_schema?: { name?: string } };
      };
      const schema = body.response_format?.json_schema?.name ?? "";
      if (schema === "privacy_policy_chunk_note") {
        counts.chunkCalls += 1;
        onChunkCall?.();
        return openAiContentResponse({
          summary: "This chunk discloses collection, use and sharing.",
          highlights: ["Collection is disclosed.", "Sharing is disclosed."],
        });
      }
      counts.mergeCalls += 1;
      return openAiContentResponse({
        overview: "The policy discloses collection, use and sharing.",
        highlights: [
          "Collection is disclosed.",
          "Sharing is disclosed.",
          "Controls are disclosed.",
        ],
        lenses: POLICY_LENSES.map(({ key }) => ({
          key,
          rating: "favorable",
          summary: `The policy includes evidence for ${key}.`,
        })),
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  return {
    fetch: stub,
    get chunkCalls() {
      return counts.chunkCalls;
    },
    get mergeCalls() {
      return counts.mergeCalls;
    },
  };
}

function openAiContentResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

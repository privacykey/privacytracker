import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import { POLICY_LENSES } from "../../lib/policy-summary-meta";
import {
  getPolicyAnalysis,
  syncPrivacyPolicyAnalysis,
} from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const POLICY_URL = "https://example.com/privacy-clock";
const AI_BASE_URL = "http://127.0.0.1:11434/v1";

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  seedTrackedApp({
    id: "policy-app",
    name: "Policy Fixture",
    privacyPolicyUrl: POLICY_URL,
  });
  setSetting("ai_provider", "openai");
  setSetting("ai_model", "fixture-policy-model");
  setSetting("ai_api_key", "fixture-api-key");
  setSetting("ai_base_url", AI_BASE_URL);
  setSetting("policy_scrape_throttle_enabled", "false");
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
});

test("privacy policy sync fetches source text, calls AI once, and stores a normalized summary", async () => {
  const aiRequests: Record<string, any>[] = [];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === POLICY_URL) {
      return new Response(buildPolicyText(), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url === `${AI_BASE_URL}/chat/completions`) {
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer fixture-api-key"
      );
      const requestBody = JSON.parse(String(init?.body)) as Record<string, any>;
      aiRequests.push(requestBody);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(buildAiSummaryResponse()),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    if (url.startsWith("https://archive.org/wayback/available")) {
      return new Response(JSON.stringify({ archived_snapshots: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://web.archive.org/save/")) {
      return new Response("", {
        status: 200,
        headers: {
          "content-location":
            "/web/20260101000000/https://example.com/privacy-clock",
        },
      });
    }
    throw new Error(`Unexpected fetch in policy fixture test: ${url}`);
  }) as typeof fetch;

  const result = await syncPrivacyPolicyAnalysis(
    {
      appId: "policy-app",
      appName: "Policy Fixture",
      developer: "Fixture Developer",
      policyUrl: POLICY_URL,
    },
    { bypassThrottle: true }
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result?.status, "ready");
  assert.equal(result.sourceOrigin, "direct");
  assert.equal(result.analysisMode, "direct");
  assert.equal(result.model, "fixture-policy-model");
  assert.equal(result.summary?.lenses.length, POLICY_LENSES.length);
  assert.equal(result.summary?.lenses[0].key, "collection_scope");
  assert.equal(result.summary?.lenses[0].rating, "mixed");

  assert.equal(aiRequests.length, 1);
  assert.equal(aiRequests[0].model, "fixture-policy-model");
  assert.equal(
    aiRequests[0].response_format.json_schema.name,
    "privacy_policy_summary"
  );
  assert.match(aiRequests[0].messages[1].content, /SECURITY NOTICE/);
  assert.match(aiRequests[0].messages[1].content, /Policy Fixture/);

  const stored = getPolicyAnalysis("policy-app");
  assert.equal(stored?.status, "ready");
  assert.equal(stored?.summary?.highlights.length, 3);
  assert.ok((stored?.sourceWordCount ?? 0) >= 400);
  assert.ok((stored?.sourceLength ?? 0) >= 2000);

  const versionCount = db
    .prepare(
      "SELECT COUNT(*) AS count FROM privacy_policy_versions WHERE app_id = ?"
    )
    .get("policy-app") as { count: number };
  assert.equal(versionCount.count, 1);
});

function buildPolicyText(): string {
  const paragraph = [
    "This privacy policy explains how Fixture Developer collects account information, contact information, device identifiers, usage data, diagnostics, and approximate location data to provide and secure the Clock Fixture service.",
    "We use personal information for product operation, fraud prevention, support, personalization, analytics, advertising measurement, marketing communications, and service improvement.",
    "We share information with service providers, affiliates, analytics partners, advertising partners, payment processors, and legal authorities when required by law or to protect users.",
    "Cookies, SDKs, device identifiers, and similar tracking technologies help measure app performance, remember settings, understand usage, and limit repeated ads.",
    "Users may request access, correction, deletion, portability, opt out of marketing, limit certain tracking choices, and contact privacy@example.com for rights requests.",
    "We retain account records while the account is active, retain security logs for up to twenty four months, and delete or de-identify data when it is no longer needed.",
    "The service is not directed to children under thirteen, and we do not knowingly collect personal information from children without appropriate consent.",
  ].join(" ");

  return Array.from(
    { length: 12 },
    (_, index) => `${paragraph} Section ${index + 1}.`
  ).join("\n\n");
}

function buildAiSummaryResponse() {
  return {
    overview:
      "Fixture Developer collects account, device, usage, and location data to operate and improve the service.",
    highlights: [
      "Collects contact, device, usage, diagnostics, and location data.",
      "Shares information with service providers, affiliates, analytics partners, and advertising partners.",
      "Offers access, deletion, opt-out, and marketing preference controls.",
    ],
    lenses: POLICY_LENSES.map(({ key }) => ({
      key,
      rating: key === "collection_scope" ? "mixed" : "favorable",
      summary: `The fixture policy provides concrete terms for ${key}.`,
    })),
  };
}

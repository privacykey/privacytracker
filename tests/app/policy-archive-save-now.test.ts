import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentPolicyVersion } from "../../lib/policy-versions";
import { syncPrivacyPolicyAnalysis } from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  setSetting("policy_scrape_throttle_enabled", "false");
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
});

const POLICY_URL = "https://example.com/privacy";
const POLICY_TEXT = [
  "This privacy policy explains how the developer collects account information, contact information, device identifiers, usage data, diagnostics, and approximate location data.",
  "We use personal information to provide the product, secure accounts, prevent fraud, personalize features, perform analytics, measure advertising, and improve services.",
  "We share data with service providers, affiliates, analytics partners, advertising partners, payment processors, and legal authorities where required.",
  "Users may request access, correction, deletion, portability, opt out of marketing, withdraw consent, and contact privacy@example.com for rights requests.",
]
  .join(" ")
  .repeat(6);

/** A Wayback timestamp (`YYYYMMDDhhmmss`) for an instant. */
function waybackStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\D/g, "").slice(0, 14);
}

/**
 * The developer page, the availability API answering with the capture
 * given (or none), and Save Page Now answering with a capture made now.
 * Counts both archive calls.
 */
function archiveStub(captureAt: number | null) {
  const counts = { availability: 0, saves: 0 };
  const stub = (async (raw: string | URL | Request) => {
    const url = String(raw);
    if (url === POLICY_URL) {
      return new Response(POLICY_TEXT, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.startsWith("https://archive.org/wayback/available")) {
      counts.availability += 1;
      const snapshots =
        captureAt === null
          ? {}
          : {
              closest: {
                available: true,
                url: `https://web.archive.org/web/${waybackStamp(captureAt)}/${POLICY_URL}`,
                timestamp: waybackStamp(captureAt),
              },
            };
      return new Response(JSON.stringify({ archived_snapshots: snapshots }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://web.archive.org/save/")) {
      counts.saves += 1;
      return new Response("", {
        status: 302,
        headers: {
          location: `/web/${waybackStamp(Date.now())}/${POLICY_URL}`,
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetch: stub, counts };
}

async function fetchPolicy(appId: string) {
  const result = await syncPrivacyPolicyAnalysis(
    { appId, appName: "Archive App", policyUrl: POLICY_URL },
    { phase: "fetch", bypassThrottle: true }
  );
  // Save Page Now is fired and forgotten; let it land.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return result;
}

test("a recent Wayback capture means Save Page Now is not asked, fetch after fetch", async () => {
  seedTrackedApp({ id: "recent-app", privacyPolicyUrl: POLICY_URL });
  const { fetch, counts } = archiveStub(Date.now() - 3 * 24 * 60 * 60 * 1000);
  global.fetch = fetch;

  for (let i = 0; i < 3; i += 1) {
    const result = await fetchPolicy("recent-app");
    assert.equal(result?.status, "source_ready");
    assert.ok(
      result?.lastRunLog?.some((entry) => entry.phase === "archive-save"),
      "the run log says why no capture was requested"
    );
  }
  assert.equal(counts.availability, 3);
  assert.equal(counts.saves, 0);
  assert.ok(getCurrentPolicyVersion("recent-app")?.archive_url);
});

test("an old or missing capture is requested once, then the landed capture covers later fetches", async () => {
  seedTrackedApp({ id: "stale-app", privacyPolicyUrl: POLICY_URL });
  const stale = archiveStub(Date.now() - 400 * 24 * 60 * 60 * 1000);
  global.fetch = stale.fetch;

  await fetchPolicy("stale-app");
  assert.equal(stale.counts.saves, 1, "an old capture is not recent enough");
  const linked = getCurrentPolicyVersion("stale-app")?.archive_url ?? "";
  assert.match(linked, /\/web\/\d{14}\//);

  // The availability API still lists only the old capture, but the save
  // that just landed is linked to this version, so nothing is asked again.
  await fetchPolicy("stale-app");
  await fetchPolicy("stale-app");
  assert.equal(stale.counts.saves, 1);
  assert.equal(stale.counts.availability, 3);

  seedTrackedApp({ id: "none-app", privacyPolicyUrl: POLICY_URL });
  const none = archiveStub(null);
  global.fetch = none.fetch;
  await fetchPolicy("none-app");
  assert.equal(none.counts.saves, 1, "no capture at all asks for one");
  await fetchPolicy("none-app");
  assert.equal(
    none.counts.saves,
    1,
    "the landed capture covers the next fetch"
  );
});

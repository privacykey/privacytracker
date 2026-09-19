/**
 * Pin the "immediate" notification webhook for App Store label changes.
 *
 * A scrape writes its label-change bell row itself, inside the commit
 * that stores the snapshot (lib/scraper.ts), so it never reached
 * `createNotification` and never fired the immediate webhook: label
 * changes only reached a webhook through the daily and weekly digests.
 * Since 2026-09-19 the scrape posts it once the commit has landed, the
 * way a policy-text change posts through `createNotification`:
 * fire-and-forget, a failure swallowed, and never held for quiet hours,
 * which defer only the bell row.
 *
 * `global.fetch` is stubbed for the App Store page, the iTunes lookup
 * and the webhook, as tests/app/scraper-advanced.test.ts stubs the first
 * two.
 */

import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import { setOverride } from "../../lib/feature-flag-storage";
import { _resetSoftBuckets } from "../../lib/rate-limit";
import { setSetting } from "../../lib/scheduler";
import { fetchAndParseApp } from "../../lib/scraper";
import { resetTestDb } from "../helpers/test-db";

const APP_ID = "3101";
const APP_URL = `https://apps.apple.com/us/app/webhook-fixture/id${APP_ID}`;
const HOOK = "https://hooks.example.com/privacytracker";

const originalFetch = global.fetch;
const originalWarn = console.warn;

test.beforeEach(() => {
  resetTestDb();
  console.warn = () => undefined;
});
test.afterEach(() => {
  global.fetch = originalFetch;
  console.warn = originalWarn;
});

interface Post {
  /** Bell rows for the app when the POST went out. */
  bellRows: number;
  body: string;
}

type HookReply = "ok" | "500" | "throw";

const LINKED = privacyType("DATA_LINKED_TO_YOU", "Data Linked to You", [
  ["CONTACT_INFO", "Contact Info"],
]);
const TRACKING = privacyType(
  "DATA_USED_TO_TRACK_YOU",
  "Data Used to Track You",
  [["LOCATION", "Location"]]
);

/** Serve the page and lookup, and record every POST to the webhook. */
function stubFetch(
  items: unknown[],
  posts: Post[],
  hook: HookReply = "ok"
): void {
  global.fetch = (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    if (url.startsWith("https://apps.apple.com/")) {
      return new Response(appStoreHtml(items), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.startsWith("https://itunes.apple.com/lookup")) {
      return new Response(
        JSON.stringify({ resultCount: 1, results: [{ version: "1.0" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === HOOK && init?.method === "POST") {
      const { n } = db
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE app_id = ?")
        .get(APP_ID) as { n: number };
      posts.push({ body: String(init.body), bellRows: n });
      if (hook === "throw") {
        throw new Error("fetch failed");
      }
      return new Response(hook === "ok" ? "ok" : "", {
        status: hook === "ok" ? 200 : 500,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function configureWebhook(frequency = "immediate"): void {
  setSetting("notification_webhook_url", HOOK);
  setSetting("notification_webhook_format", "slack");
  setSetting("notification_webhook_frequency", frequency);
}

/** Import the app with one label type, then resync it with `items`. */
async function resyncWith(
  items: unknown[],
  hook: HookReply = "ok"
): Promise<{ posts: Post[]; changesDetected: boolean }> {
  // Two scrapes per case: keep the App Store pacer from spacing them out.
  _resetSoftBuckets();
  stubFetch([LINKED], []);
  await fetchAndParseApp(APP_URL, false, false, "import");
  const posts: Post[] = [];
  stubFetch(items, posts, hook);
  const result = await fetchAndParseApp(APP_URL, true, false, "manual");
  // Fire-and-forget: nothing awaits the POST, so give it a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { posts, changesDetected: result.changesDetected };
}

test("a label change posts the immediate webhook once its bell row has committed", async () => {
  configureWebhook();
  const { posts, changesDetected } = await resyncWith([LINKED, TRACKING]);

  assert.equal(changesDetected, true);
  assert.equal(posts.length, 1);
  const headline = 'New privacy label: "Data Used to Track You"';
  assert.deepEqual(JSON.parse(posts[0].body), {
    text: `📱 Webhook Fixture: ${headline}\n${headline}`,
  });
  // The bell row is part of the scrape's commit, which lands first.
  assert.equal(posts[0].bellRows, 1);
});

test("quiet hours defer the bell row but not the webhook", async () => {
  configureWebhook();
  setOverride("flag.notifications.quiet_hours", "on");
  // A two-hour window around now, so the scrape always falls inside it.
  const hh = (h: number) => String((h + 24) % 24).padStart(2, "0");
  const hour = new Date().getHours();
  setSetting("notification_quiet_hours_start", `${hh(hour - 1)}:00`);
  setSetting("notification_quiet_hours_end", `${hh(hour + 1)}:59`);

  const { posts } = await resyncWith([LINKED, TRACKING]);

  assert.equal(posts.length, 1);
  const bell = db
    .prepare("SELECT not_before FROM notifications WHERE app_id = ?")
    .get(APP_ID) as { not_before: number | null };
  assert.ok(
    bell.not_before !== null && bell.not_before > Date.now(),
    "the bell row waits for the end of the quiet window"
  );
});

test("no immediate webhook without a label change", async () => {
  configureWebhook();
  const { posts, changesDetected } = await resyncWith([LINKED]);

  assert.equal(changesDetected, false);
  assert.equal(posts.length, 0);
});

test("a summary frequency leaves label changes to the digest", async () => {
  configureWebhook("daily_summary");
  const { posts, changesDetected } = await resyncWith([LINKED, TRACKING]);

  assert.equal(changesDetected, true);
  assert.equal(posts.length, 0);
});

test("a failing webhook never fails the scrape", async () => {
  configureWebhook();
  for (const hook of ["500", "throw"] as const) {
    resetTestDb();
    configureWebhook();
    const { posts, changesDetected } = await resyncWith(
      [LINKED, TRACKING],
      hook
    );
    assert.equal(changesDetected, true, hook);
    assert.equal(posts.length, 1, hook);
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE app_id = ?")
      .get(APP_ID) as { n: number };
    assert.equal(n, 1, hook);
  }
});

function privacyType(
  identifier: string,
  title: string,
  categories: [string, string][]
) {
  return {
    identifier,
    title,
    detail: "",
    categories: categories.map(([categoryId, categoryTitle]) => ({
      identifier: categoryId,
      title: categoryTitle,
    })),
  };
}

function appStoreHtml(items: unknown[]): string {
  const blob = JSON.stringify({
    data: [
      {
        data: {
          title: "Webhook Fixture",
          shelfMapping: { privacyTypes: { items } },
        },
      },
    ],
  });
  return `<!doctype html><html><head><meta property="og:title" content="Webhook Fixture on the App Store"></head><body><script id="serialized-server-data" type="application/json">${blob}</script></body></html>`;
}

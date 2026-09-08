/**
 * Wayback history ingestion — the contracts a fresh install relies on to
 * see a coherent past for each app:
 *
 *   - the oldest imported row is a baseline, never a diff against today;
 *   - diffs are repaired when an older capture lands after a newer one;
 *   - a throttled archive is an error, not an empty quarter;
 *   - Save Page Now only fires when the archive has nothing recent;
 *   - the last archive → live hop is bridged at read time;
 *   - "remove imported history" takes the importer's notes with it;
 *   - the history aggregates count privacy-label entries only.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  appendWaybackAttemptEntry,
  getChangelog,
  saveSnapshot,
} from "../../lib/changelog";
import type {
  ChangeEntry,
  PrivacyTypeSnapshot,
  SnapshotChangelogRow,
} from "../../lib/changelog-types";
import db from "../../lib/db";
import {
  APP_STORE_HISTORICAL_FLOOR,
  computeCategoryTrend,
  computeHistoricalTargets,
  computeQuarterlyChanges,
  dedupeWindowForInterval,
  importAppHistory,
  removeImportedHistory,
} from "../../lib/historical-import";
import {
  listWaybackCaptures,
  parseRetryAfterMs,
  WaybackUnavailableError,
} from "../../lib/wayback";
import { runBulkWaybackImport } from "../../lib/wayback-bulk-runner";
import { isBulkMutexHeld, readBulkState } from "../../lib/wayback-bulk-state";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const APP_ID = "555000111";
const APP_URL = `https://apps.apple.com/us/app/fixture/id${APP_ID}`;
const APP = { id: APP_ID, name: "Fixture", url: APP_URL };
const DAY_MS = 24 * 60 * 60 * 1000;

const originalFetch = global.fetch;
test.afterEach(() => {
  global.fetch = originalFetch;
});

function snap(cats: string[]): PrivacyTypeSnapshot[] {
  return [
    {
      identifier: "DATA_LINKED_TO_YOU",
      title: "Data Linked to You",
      categories: cats.map((c) => ({ identifier: c, title: c })),
    },
  ];
}

/** Minimal modern App Store page carrying one privacy shelf. */
function archivedPage(cats: string[]): string {
  const blob = {
    data: [{ data: { shelfMapping: { privacyTypes: { items: snap(cats) } } } }],
  };
  return `<html><head><script id="serialized-server-data">${JSON.stringify(
    blob
  )}</script></head><body></body></html>`;
}

function cdxBody(timestamps: string[]): string {
  return JSON.stringify([
    ["timestamp", "statuscode"],
    ...timestamps.map((ts) => [ts, "200"]),
  ]);
}

interface ArchiveMock {
  availabilityStatus?: number;
  /** Capture timestamp → page labels. */
  captures: Record<string, string[]>;
  cdxBody?: string;
  cdxStatus?: number;
  retryAfter?: string;
}

function mockArchive(mock: ArchiveMock) {
  const calls = { cdx: 0, availability: 0, replay: 0, save: 0 };
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://web.archive.org/cdx/search/cdx")) {
      calls.cdx += 1;
      if (mock.cdxStatus && mock.cdxStatus !== 200) {
        return new Response("no", {
          status: mock.cdxStatus,
          headers: mock.retryAfter ? { "retry-after": mock.retryAfter } : {},
        });
      }
      return new Response(mock.cdxBody ?? cdxBody(Object.keys(mock.captures)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://archive.org/wayback/available")) {
      calls.availability += 1;
      return new Response("no", {
        status: mock.availabilityStatus ?? 200,
        headers: mock.retryAfter ? { "retry-after": mock.retryAfter } : {},
      });
    }
    const replay = url.match(
      /^https:\/\/web\.archive\.org\/web\/(\d{14})id_\//
    );
    if (replay) {
      calls.replay += 1;
      const cats = mock.captures[replay[1]];
      if (!cats) {
        return new Response("gone", { status: 404 });
      }
      return new Response(archivedPage(cats), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.startsWith("https://web.archive.org/save/")) {
      calls.save += 1;
      return new Response("archive unavailable", { status: 503 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

function waybackRows(appId = APP_ID) {
  return db
    .prepare(
      `SELECT scraped_at, changes_detected, changes_summary, wayback_snapshot_url
         FROM privacy_snapshots
        WHERE app_id = ? AND source = 'wayback'
        ORDER BY scraped_at ASC`
    )
    .all(appId) as Array<{
    scraped_at: number;
    changes_detected: number;
    changes_summary: string;
    wayback_snapshot_url: string | null;
  }>;
}

// Fixed clock: 15 Sep 2021 → grid targets 1 Feb, 15 Mar, 15 Jun 2021.
const TODAY = new Date(Date.UTC(2021, 8, 15));
const JUN_1 = "20210601000000";
const MAR_1 = "20210301000000";

test("the oldest imported capture is a baseline, not a diff against today's labels", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  // Live scrape today knows two categories; the 2021 capture only one.
  saveSnapshot(APP_ID, snap(["LOCATION", "CONTACTS"]), [], {
    scrapedAt: TODAY.getTime(),
  });
  const calls = mockArchive({ captures: { [JUN_1]: ["LOCATION"] } });

  const result = await importAppHistory(APP, { today: TODAY });

  const rows = waybackRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scraped_at, Date.UTC(2021, 5, 1));
  assert.equal(rows[0].changes_detected, 0, "baseline carries no changes");
  assert.deepEqual(JSON.parse(rows[0].changes_summary), []);
  assert.equal(
    rows[0].wayback_snapshot_url,
    `https://web.archive.org/web/${JUN_1}/${APP_URL}`
  );

  const imported = result.targets.find((t) => t.outcome === "imported");
  assert.ok(imported, "the June target imported");
  assert.equal(imported.changeCount, 0);
  // The two earlier targets saw the June capture but outside tolerance.
  assert.equal(
    result.targets.filter((t) => t.outcome === "skipped_drift").length,
    2
  );
  // Index answered → no availability probes; nothing recent → one SPN try.
  assert.equal(calls.availability, 0);
  assert.equal(calls.cdx, 1);
  assert.equal(calls.save, 1);
  assert.equal(result.targets.at(-1)?.outcome, "skipped_save_now_failed");

  const changeCount = (
    db.prepare("SELECT changeCount FROM apps WHERE id = ?").get(APP_ID) as {
      changeCount: number;
    }
  ).changeCount;
  assert.equal(changeCount, 0, "imports never bump the review badge");
});

test("an older capture landing later re-diffs the wayback row that now follows it", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  saveSnapshot(APP_ID, snap(["LOCATION", "CONTACTS"]), [], {
    scrapedAt: TODAY.getTime(),
  });

  // Run 1: only June is archived.
  mockArchive({ captures: { [JUN_1]: ["LOCATION", "CONTACTS"] } });
  await importAppHistory(APP, { today: TODAY });
  let rows = waybackRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].changes_detected, 0);

  // Run 2: a March capture has since appeared in the index.
  mockArchive({
    captures: { [MAR_1]: ["LOCATION"], [JUN_1]: ["LOCATION", "CONTACTS"] },
  });
  const second = await importAppHistory(APP, { today: TODAY });

  rows = waybackRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].scraped_at, Date.UTC(2021, 2, 1));
  assert.equal(rows[0].changes_detected, 0, "March is now the baseline");
  assert.equal(rows[1].changes_detected, 1, "June re-diffed against March");
  const juneChanges = JSON.parse(rows[1].changes_summary) as ChangeEntry[];
  assert.equal(juneChanges.length, 1);
  assert.equal(juneChanges[0].type, "added");
  assert.match(juneChanges[0].description, /CONTACTS/);
  // The June target was already covered by the row from run 1.
  assert.ok(
    second.targets.some(
      (t) =>
        t.outcome === "skipped_existing" &&
        t.targetDate === Date.UTC(2021, 5, 15)
    )
  );
});

test("dedupe window follows the cadence so monthly imports land every month", () => {
  assert.equal(dedupeWindowForInterval(3), 45 * DAY_MS);
  assert.equal(dedupeWindowForInterval(1), 15 * DAY_MS);
  assert.equal(
    dedupeWindowForInterval(6),
    45 * DAY_MS,
    "capped at drift tolerance"
  );
  assert.equal(
    dedupeWindowForInterval(0),
    15 * DAY_MS,
    "clamped to >= 1 month"
  );
});

test("a rate-limited index is an error for the app, not an empty quarter", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  const calls = mockArchive({ captures: {}, cdxStatus: 429, retryAfter: "7" });

  await assert.rejects(
    importAppHistory(APP, { today: TODAY }),
    (error: unknown) => {
      assert.ok(error instanceof WaybackUnavailableError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 7000);
      return true;
    }
  );
  assert.equal(calls.save, 0, "no Save Page Now on the strength of a 429");
  assert.equal(waybackRows().length, 0);
});

test("the availability fallback surfaces throttling the same way", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  // Malformed index → fall back to per-target probes, which are throttled.
  const calls = mockArchive({
    captures: {},
    cdxBody: "<html>not json</html>",
    availabilityStatus: 503,
  });

  await assert.rejects(
    importAppHistory(APP, { today: TODAY }),
    (error: unknown) =>
      error instanceof WaybackUnavailableError && error.status === 503
  );
  assert.equal(calls.availability, 1, "stops after the first throttled probe");
  assert.equal(calls.save, 0);
});

test("Save Page Now is skipped when the archive already has a recent capture", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  const recent = "20210901000000"; // 14 days before TODAY
  const calls = mockArchive({ captures: { [recent]: ["LOCATION"] } });

  const result = await importAppHistory(APP, { today: TODAY });
  assert.equal(calls.save, 0);
  assert.ok(
    !result.targets.some((t) => t.outcome === "skipped_save_now_failed")
  );
  assert.ok(!result.targets.some((t) => t.outcome === "requested_snapshot"));
});

test("a fresh install does not probe its own install date", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL }); // firstSeen = now
  mockArchive({ captures: {} });
  const now = new Date();

  const result = await importAppHistory(APP, { today: now });
  const grid = computeHistoricalTargets(now, APP_STORE_HISTORICAL_FLOOR);
  assert.equal(result.attempted, grid.length, "no extra anchor target");
});

test("an install anchor is still probed once the install is older than the window", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  const installed = Date.UTC(2021, 3, 20); // 20 Apr 2021 — off the grid
  db.prepare("UPDATE apps SET firstSeen = ? WHERE id = ?").run(
    installed,
    APP_ID
  );
  mockArchive({ captures: {} });

  const result = await importAppHistory(APP, { today: TODAY });
  const grid = computeHistoricalTargets(TODAY, APP_STORE_HISTORICAL_FLOOR);
  assert.equal(result.attempted, grid.length + 1);
  assert.ok(result.targets.some((t) => t.targetDate === installed));
});

test("getChangelog bridges the newest archive capture to the first live scrape", () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  const captureAt = Date.UTC(2021, 5, 1);
  const firstLiveAt = Date.UTC(2021, 8, 15);
  const laterLiveAt = Date.UTC(2021, 8, 16);
  saveSnapshot(APP_ID, snap(["LOCATION"]), [], {
    source: "wayback",
    scrapedAt: captureAt,
    waybackUrl: `https://web.archive.org/web/${JUN_1}/${APP_URL}`,
  });
  // The scraper stores an empty diff on the first scrape...
  saveSnapshot(APP_ID, snap(["LOCATION", "CONTACTS"]), [], {
    scrapedAt: firstLiveAt,
    triggeredBy: "import",
  });
  // ...and a no-change row on the next sync.
  saveSnapshot(APP_ID, snap(["LOCATION", "CONTACTS"]), [], {
    scrapedAt: laterLiveAt,
    triggeredBy: "scheduled",
  });

  const rows = getChangelog(APP_ID).filter(
    (r): r is SnapshotChangelogRow => r.kind === "snapshot"
  );
  assert.equal(rows.length, 3);
  const [later, first, capture] = rows;
  assert.equal(later.scraped_at, laterLiveAt);
  assert.equal(later.changes_detected, 0, "only the oldest live row bridges");
  assert.equal(later.archive_bridge, undefined);

  assert.equal(first.scraped_at, firstLiveAt);
  assert.equal(first.changes_detected, 1);
  assert.equal(first.changes_summary.length, 1);
  assert.match(first.changes_summary[0].description, /CONTACTS/);
  assert.deepEqual(first.archive_bridge, {
    from_scraped_at: captureAt,
    wayback_snapshot_url: `https://web.archive.org/web/${JUN_1}/${APP_URL}`,
  });
  assert.equal(capture.changes_detected, 0);

  // Read-time only: the stored row is untouched, so the review queue never
  // sees archive deltas as changes to acknowledge.
  const stored = db
    .prepare(
      "SELECT changes_detected FROM privacy_snapshots WHERE scraped_at = ?"
    )
    .get(firstLiveAt) as { changes_detected: number };
  assert.equal(stored.changes_detected, 0);
});

test("getChangelog leaves the first live scrape alone when the capture matches it", () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  saveSnapshot(APP_ID, snap(["LOCATION"]), [], {
    source: "wayback",
    scrapedAt: Date.UTC(2021, 5, 1),
    waybackUrl: `https://web.archive.org/web/${JUN_1}/${APP_URL}`,
  });
  saveSnapshot(APP_ID, snap(["LOCATION"]), [], {
    scrapedAt: Date.UTC(2021, 8, 15),
  });
  const rows = getChangelog(APP_ID).filter(
    (r): r is SnapshotChangelogRow => r.kind === "snapshot"
  );
  assert.equal(rows[0].archive_bridge, undefined);
  assert.equal(rows[0].changes_detected, 0);
  assert.equal(rows[1].matches_live_sync, true);
});

test("removing imported history also removes the importer's Save Page Now notes", () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  saveSnapshot(APP_ID, snap(["LOCATION"]), [], {
    scrapedAt: Date.UTC(2021, 8, 15),
  });
  saveSnapshot(APP_ID, snap(["LOCATION"]), [], {
    source: "wayback",
    scrapedAt: Date.UTC(2021, 5, 1),
    waybackUrl: `https://web.archive.org/web/${JUN_1}/${APP_URL}`,
  });
  appendWaybackAttemptEntry(APP_ID, {
    event: "requested_snapshot",
    description: "Requested a fresh capture.",
    saveNowUrl: "https://web.archive.org/web/20210915000000/x",
  });

  const deleted = removeImportedHistory(APP_ID);
  assert.equal(deleted, 2);
  const remaining = db
    .prepare(
      "SELECT source, triggered_by FROM privacy_snapshots WHERE app_id = ?"
    )
    .all(APP_ID) as Array<{ source: string; triggered_by: string | null }>;
  assert.deepEqual(remaining, [{ source: "live", triggered_by: null }]);
});

test("history aggregates count privacy-label entries only", () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  const q2 = Date.UTC(2021, 4, 10);
  const q3 = Date.UTC(2021, 7, 10);
  saveSnapshot(
    APP_ID,
    snap(["LOCATION"]),
    [
      {
        type: "added",
        description: '"Data Linked to You" now collects: LOCATION',
      },
      { type: "added", category: "accessibility", description: "VoiceOver" },
      { type: "removed", category: "accessibility", description: "Captions" },
    ],
    { scrapedAt: q2 }
  );
  saveSnapshot(
    APP_ID,
    snap(["LOCATION"]),
    [
      {
        type: "policy",
        category: "privacy-policy",
        description: "Policy changed",
        policy_event: "changed",
      },
    ],
    { scrapedAt: q3 }
  );

  const today = new Date(Date.UTC(2021, 8, 15));
  const trend = computeCategoryTrend(APP_ID, { today });
  assert.equal(trend.totalAdded, 1);
  assert.equal(trend.totalRemoved, 0);

  const quarterly = computeQuarterlyChanges(APP_ID, { today });
  const byLabel = Object.fromEntries(quarterly.map((q) => [q.label, q]));
  assert.equal(byLabel["Q2 2021"].changeEvents, 1);
  assert.equal(byLabel["Q2 2021"].changeEntries, 1);
  assert.equal(
    byLabel["Q3 2021"].changeEvents,
    0,
    "policy rows are not label events"
  );
});

test("listWaybackCaptures parses the CDX index and tolerates the empty/garbage cases", async () => {
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("empty")) {
      return new Response("", { status: 200 });
    }
    if (url.includes("garbage")) {
      return new Response("<html/>", { status: 200 });
    }
    return new Response(
      JSON.stringify([
        ["timestamp", "statuscode"],
        ["20220301000000", "200"],
        ["20210601000000", "200"],
        ["20210601000000", "200"],
        ["bogus", "200"],
      ]),
      { status: 200 }
    );
  }) as typeof fetch;

  const captures = await listWaybackCaptures("https://example.com/app");
  assert.ok(captures);
  assert.deepEqual(
    captures.map((c) => c.timestamp),
    ["20210601000000", "20220301000000"],
    "sorted ascending, de-duplicated, header and junk dropped"
  );
  assert.equal(captures[0].ms, Date.UTC(2021, 5, 1));
  assert.equal(
    captures[0].url,
    "https://web.archive.org/web/20210601000000/https://example.com/app"
  );

  assert.deepEqual(await listWaybackCaptures("https://example.com/empty"), []);
  assert.equal(await listWaybackCaptures("https://example.com/garbage"), null);
});

test("parseRetryAfterMs handles delta-seconds, HTTP dates, and junk", () => {
  assert.equal(parseRetryAfterMs("7"), 7000);
  assert.equal(parseRetryAfterMs("0"), 0);
  const soon = new Date(Date.now() + 60_000).toUTCString();
  const parsed = parseRetryAfterMs(soon);
  assert.ok(parsed !== null && parsed > 30_000 && parsed <= 60_000);
  assert.equal(parseRetryAfterMs("later"), null);
  assert.equal(parseRetryAfterMs(null), null);
});

test("bulk runner backs off once on throttling, then pauses with the queue intact", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, name: "Alpha", url: APP_URL });
  seedTrackedApp({
    id: "555000222",
    name: "Beta",
    url: "https://apps.apple.com/us/app/beta/id555000222",
  });
  const calls = mockArchive({ captures: {}, cdxStatus: 429, retryAfter: "1" });

  const result = await runBulkWaybackImport({ initiator: "manual" });

  // Alpha: 429 → wait ~1s → retry → 429 → pause. Beta never started.
  assert.equal(calls.cdx, 2);
  assert.equal(result.totals.appsAttempted, 0);
  assert.equal(result.totals.failed, 0, "throttling is not an app failure");
  const state = readBulkState();
  assert.ok(state);
  assert.equal(state.status, "paused");
  assert.equal(state.pauseCause, "rate_limited");
  assert.deepEqual(
    state.queue.map((e) => e.status),
    ["pending", "pending"]
  );
  assert.equal(isBulkMutexHeld(), false);

  const paused = db
    .prepare(
      "SELECT detail FROM activity_log WHERE type = 'wayback_import' ORDER BY started_at DESC"
    )
    .all() as Array<{ detail: string }>;
  const modes = paused.map((row) => JSON.parse(row.detail).mode);
  assert.ok(modes.includes("bulk-backoff"));
  assert.ok(modes.includes("bulk-paused"));

  // Resume once the archive is answering again: the queue completes cleanly.
  mockArchive({ captures: {} });
  const resumed = await runBulkWaybackImport({
    initiator: "manual",
    resumeState: { ...state, status: "running" },
  });
  assert.equal(resumed.totals.appsAttempted, 2);
  assert.equal(readBulkState(), null);
  assert.equal(isBulkMutexHeld(), false);
});

test("getChangelogPage pages backwards so imported history is never out of reach", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  const times = [
    Date.UTC(2021, 2, 1),
    Date.UTC(2021, 5, 1),
    Date.UTC(2021, 8, 1),
    Date.UTC(2021, 8, 15),
  ];
  for (const [i, ms] of times.entries()) {
    saveSnapshot(APP_ID, snap(["LOCATION"]), [], {
      scrapedAt: ms,
      source: i < 2 ? "wayback" : "live",
      waybackUrl: i < 2 ? `https://web.archive.org/web/x/${i}` : null,
    });
  }

  const { getChangelogPage } = await import("../../lib/changelog");
  const first = getChangelogPage(APP_ID, 2);
  assert.equal(first.rows.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.rows[0].scraped_at, times[3]);
  assert.equal(first.rows[1].scraped_at, times[2]);

  const second = getChangelogPage(APP_ID, 2, {
    beforeMs: first.rows[1].scraped_at,
  });
  assert.equal(second.rows.length, 2);
  assert.equal(second.hasMore, false);
  assert.deepEqual(
    second.rows.map((r) => r.scraped_at),
    [times[1], times[0]]
  );

  const { GET } = await import("../../app/api/apps/[id]/changelog/route");
  const params = Promise.resolve({ id: APP_ID });
  const ok = await GET(
    new Request(
      `http://localhost/api/apps/${APP_ID}/changelog?before=${times[2]}&limit=1`
    ),
    { params }
  );
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    rows: Array<{ scraped_at: number }>;
    hasMore: boolean;
  };
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].scraped_at, times[1]);
  assert.equal(body.hasMore, true);

  const bad = await GET(
    new Request(`http://localhost/api/apps/${APP_ID}/changelog?limit=0`),
    { params }
  );
  assert.equal(bad.status, 400);
  const missing = await GET(
    new Request("http://localhost/api/apps/nope/changelog"),
    { params: Promise.resolve({ id: "nope" }) }
  );
  assert.equal(missing.status, 404);
});

test("parses the early-2021 ember-data-store shoebox (the first pages with privacy labels)", async () => {
  const { parsePrivacyItemsFromArchivedHtml } = await import(
    "../../lib/historical-import"
  );
  // Shape observed on web.archive.org captures from Feb–Oct 2021: keyed by
  // app id, single `data` record, `privacyType` / `dataCategory` field names.
  const store = {
    "389801252": {
      data: {
        id: "389801252",
        type: "media/app",
        attributes: {
          name: "Instagram",
          privacy: {
            privacyTypes: [
              {
                privacyType: "Data Used to Track You",
                identifier: "DATA_USED_TO_TRACK_YOU",
                dataCategories: [
                  { dataCategory: "Identifiers", identifier: "IDENTIFIERS" },
                ],
              },
              {
                privacyType: "Data Linked to You",
                identifier: "DATA_LINKED_TO_YOU",
                dataCategories: [
                  { dataCategory: "Location", identifier: "LOCATION" },
                  { dataCategory: "Contacts", identifier: "CONTACTS" },
                ],
              },
            ],
          },
        },
      },
    },
  };
  const html = `<html><head>
    <script type="fastboot/shoebox" id="shoebox-ember-localizer">{"x":1}</script>
    <script type="fastboot/shoebox" id="shoebox-ember-data-store">${JSON.stringify(store)}</script>
  </head><body></body></html>`;

  const parsed = parsePrivacyItemsFromArchivedHtml(html);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.map((t) => [
      t.identifier,
      t.title,
      t.categories.map((c) => c.identifier),
    ]),
    [
      ["DATA_USED_TO_TRACK_YOU", "Data Used to Track You", ["IDENTIFIERS"]],
      ["DATA_LINKED_TO_YOU", "Data Linked to You", ["LOCATION", "CONTACTS"]],
    ]
  );
});

test("a product page with no privacy section is skipped, not failed", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  const feb2021 = "20210210083535";
  const pageWithoutLabels = `<html><head>
    <script type="fastboot/shoebox" id="shoebox-ember-data-store">${JSON.stringify(
      {
        [APP_ID]: {
          data: {
            id: APP_ID,
            type: "media/app",
            attributes: { name: "Fixture" },
          },
        },
      }
    )}</script>
  </head><body>App Privacy</body></html>`;
  let replays = 0;
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://web.archive.org/cdx/search/cdx")) {
      return new Response(cdxBody([feb2021]), { status: 200 });
    }
    if (/^https:\/\/web\.archive\.org\/web\/\d{14}id_\//.test(url)) {
      replays += 1;
      return new Response(pageWithoutLabels, { status: 200 });
    }
    if (url.startsWith("https://web.archive.org/save/")) {
      return new Response("busy", { status: 503 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const result = await importAppHistory(APP, { today: TODAY });
  const noLabels = result.targets.filter(
    (t) => t.outcome === "skipped_no_labels"
  );
  // The capture is the closest one for two targets (1 Feb and 15 Mar) —
  // both report it, but the page is fetched once.
  assert.equal(noLabels.length, 2);
  assert.equal(replays, 1);
  assert.equal(result.failed, 0);
  // 2 × no-labels + the June target's drift skip + the failed SPN attempt.
  assert.equal(result.skipped, 4);
  assert.equal(waybackRows().length, 0);

  // Unrecognisable HTML is still a parse failure.
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://web.archive.org/cdx/search/cdx")) {
      return new Response(cdxBody([feb2021]), { status: 200 });
    }
    if (/^https:\/\/web\.archive\.org\/web\/\d{14}id_\//.test(url)) {
      return new Response("<html><body>Wayback error shell</body></html>", {
        status: 200,
      });
    }
    if (url.startsWith("https://web.archive.org/save/")) {
      return new Response("busy", { status: 503 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  const again = await importAppHistory(APP, { today: TODAY });
  assert.equal(again.failed, 2);
  assert.ok(again.targets.some((t) => t.outcome === "skipped_parse_failure"));
});

test("force re-probes a target a neighbouring row already covers", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  saveSnapshot(APP_ID, snap(["LOCATION"]), [], {
    scrapedAt: TODAY.getTime(),
  });

  // Run 1: the only capture is 1 Jun, which lands on the 15 Jun target.
  mockArchive({ captures: { [JUN_1]: ["LOCATION"] } });
  await importAppHistory(APP, { today: TODAY });
  assert.equal(waybackRows().length, 1);
  assert.equal(waybackRows()[0].scraped_at, Date.UTC(2021, 5, 1));

  // The archive has since gained a 20 Jun capture — closer to the 15 Jun
  // target, and showing a label the 1 Jun one didn't. A plain re-run never
  // asks: the 1 Jun row is inside the target's 45-day dedupe window.
  const later = "20210620000000";
  const captures = {
    [JUN_1]: ["LOCATION"],
    [later]: ["LOCATION", "CONTACTS"],
  };
  const plain = mockArchive({ captures });
  const unforced = await importAppHistory(APP, { today: TODAY });
  assert.equal(plain.replay, 0, "no capture fetched");
  assert.equal(unforced.imported, 0);
  assert.ok(
    unforced.targets.some((t) => t.outcome === "skipped_existing"),
    "the covered target is skipped without asking the archive"
  );
  assert.equal(waybackRows().length, 1);

  // Forcing probes it anyway, picks the closer capture, and stores it.
  const forced = mockArchive({ captures });
  const result = await importAppHistory(APP, { today: TODAY, force: true });
  assert.equal(result.imported, 1);
  assert.equal(forced.replay, 1, "only the capture we don't have is fetched");
  const rows = waybackRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].scraped_at, Date.UTC(2021, 5, 20));
  assert.equal(rows[1].changes_detected, 1);
  assert.match(
    (JSON.parse(rows[1].changes_summary) as ChangeEntry[])[0].description,
    /now collects: CONTACTS/
  );

  // Forcing again is idempotent — both captures are already stored.
  mockArchive({ captures });
  const again = await importAppHistory(APP, { today: TODAY, force: true });
  assert.equal(again.imported, 0);
  assert.equal(waybackRows().length, 2);
});

test("the per-app route accepts force and records it", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, name: "Fixture", url: APP_URL });
  mockArchive({ captures: { [JUN_1]: ["LOCATION"] } });

  const { POST } = await import("../../app/api/apps/[id]/import-history/route");
  const params = Promise.resolve({ id: APP_ID });
  const res = await POST(
    new Request(`http://localhost/api/apps/${APP_ID}/import-history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    }),
    { params }
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { imported: number } };
  assert.equal(body.result.imported, 1);

  const activity = db
    .prepare(
      "SELECT summary, detail FROM activity_log WHERE type = 'wayback_import' ORDER BY started_at DESC LIMIT 1"
    )
    .get() as { summary: string; detail: string };
  assert.match(activity.summary, /^Forced Wayback import for Fixture/);
  assert.equal(JSON.parse(activity.detail).force, true);

  const audit = db
    .prepare(
      "SELECT detail FROM audit_log WHERE action = 'wayback.import.app.success' ORDER BY created_at DESC LIMIT 1"
    )
    .get() as { detail: string } | undefined;
  assert.ok(audit?.detail.includes("force=1"));
});

test("a bodyless per-app POST still runs an unforced import", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, name: "Fixture", url: APP_URL });
  mockArchive({ captures: { [JUN_1]: ["LOCATION"] } });

  const { POST } = await import("../../app/api/apps/[id]/import-history/route");
  const res = await POST(
    new Request(`http://localhost/api/apps/${APP_ID}/import-history`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: APP_ID }) }
  );
  assert.equal(res.status, 200);
  const activity = db
    .prepare(
      "SELECT summary, detail FROM activity_log WHERE type = 'wayback_import' ORDER BY started_at DESC LIMIT 1"
    )
    .get() as { summary: string; detail: string };
  assert.match(activity.summary, /^Wayback import for Fixture/);
  assert.equal(JSON.parse(activity.detail).force, false);
});

test("the per-app route answers 503 with a code when archive.org throttles", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, name: "Fixture", url: APP_URL });
  mockArchive({ captures: {}, cdxStatus: 429, retryAfter: "9" });

  const { POST } = await import("../../app/api/apps/[id]/import-history/route");
  const res = await POST(
    new Request(`http://localhost/api/apps/${APP_ID}/import-history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    }),
    { params: Promise.resolve({ id: APP_ID }) }
  );
  // Not a 500: our server is fine, the archive is busy. The code lets the
  // UI say "wait and retry" instead of showing the raw error.
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "9");
  const body = (await res.json()) as { code: string; retryAfterMs: number };
  assert.equal(body.code, "archive_unavailable");
  assert.equal(body.retryAfterMs, 9000);

  const activity = db
    .prepare(
      "SELECT status, summary, detail FROM activity_log WHERE type = 'wayback_import' ORDER BY started_at DESC LIMIT 1"
    )
    .get() as { status: string; summary: string; detail: string };
  assert.equal(activity.status, "partial", "not an app-level failure");
  assert.match(activity.summary, /rate-limiting/);
  assert.equal(JSON.parse(activity.detail).archiveUnavailable, true);
});

test("rows written = imported + unchanged, so `imported` alone understates a reconstruction", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  // Three quarters, same labels throughout — a stable app, the common case.
  mockArchive({
    captures: {
      [MAR_1]: ["LOCATION"],
      [JUN_1]: ["LOCATION"],
      "20210901000000": ["LOCATION"],
    },
  });

  const result = await importAppHistory(APP, { today: TODAY });
  const written = waybackRows().length;
  // Two rows: the 1 Feb and 15 Mar targets both resolve to the 1 Mar
  // capture (stored once), and the 15 Jun target takes the 1 Jun one.
  assert.equal(written, 2);
  // Only the oldest row counts as `imported` (it is the baseline); one that
  // matches its predecessor is `unchanged`. Any UI reporting "added N" must
  // sum both — AppHistoryImportCard does, and said "Added 1 snapshot" after
  // adding 21 when it didn't.
  assert.equal(result.imported, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.imported + result.unchanged, written);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addImportItems,
  claimQueuedBatch,
  createImport,
  getImport,
} from '../lib/imports';
import {
  getImportQueueStatus,
  runImportQueueTick,
} from '../lib/import-queue';
import { getSetting, setSetting } from '../lib/scheduler';
import db from '../lib/db';
import { resetTestDb } from './test-db';

const originalFetch = global.fetch;
const originalConsoleWarn = console.warn;

test.beforeEach(() => {
  resetTestDb();
  console.warn = () => {};
});
test.afterEach(() => {
  global.fetch = originalFetch;
  console.warn = originalConsoleWarn;
});

test('import queue retries due items and completes the import when all items settle', async () => {
  installQueueFetchMock({ appStatus: 200 });
  const batch = createImport({ source: 'file', sourceLabel: 'fixture.csv', total: 1 });
  addImportItems(batch.id, [{
    query: 'Queued Fixture',
    status: 'queued',
    url: 'https://apps.apple.com/us/app/queued-fixture/id3001',
    appName: 'Queued Fixture',
    nextAttemptAt: 0,
  }]);

  const result = await runImportQueueTick();

  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  const after = getImport(batch.id);
  assert.equal(after?.import.completedAt === null, false);
  assert.equal(after?.import.imported, 1);
  assert.equal(after?.items[0].status, 'imported');
  assert.equal(after?.items[0].appId, '3001');
});

test('import queue parks items and sets a pause fence when Apple rate-limits', async () => {
  installQueueFetchMock({ appStatus: 429, retryAfter: '2' });
  const batch = createImport({ source: 'manual', total: 1 });
  addImportItems(batch.id, [{
    query: 'Rate Limited Fixture',
    status: 'queued',
    url: 'https://apps.apple.com/us/app/rate-limited-fixture/id3002',
    appName: 'Rate Limited Fixture',
    nextAttemptAt: 0,
  }]);

  const result = await runImportQueueTick();

  assert.equal(result.processed, 1);
  assert.equal(result.rateLimited, 1);
  assert.ok(result.pausedUntil && result.pausedUntil > Date.now());

  const status = getImportQueueStatus();
  assert.equal(status.queued, 1);
  assert.ok(status.pausedUntil && status.pausedUntil > Date.now());

  const after = getImport(batch.id);
  assert.equal(after?.items[0].status, 'queued');
  assert.equal(after?.items[0].attemptCount, 1);
  assert.match(after?.items[0].scrapeError ?? '', /rate-limited/i);
});

test('import queue claims untracked apps before already-tracked rescrapes', async () => {
  // When a bulk import mixes net-new apps with apps the user is
  // already tracking, the new ones should land in the dashboard first
  // — they're the reason the user ran the import. Already-tracked
  // rows are effectively just a sync; tail-of-batch is fine for them.
  installQueueFetchMock({ appStatus: 200 });
  const batch = createImport({ source: 'manual', total: 2 });
  // Seed a tracked app so resolveSafeAppId keeps the appId.
  db.prepare(
    "INSERT INTO apps (id, name, url, lastSynced) VALUES ('3001', 'Already Tracked', 'https://apps.apple.com/us/app/already-tracked/id3001', 0)",
  ).run();
  // Insert in tracked-then-new order; the claim query should flip them.
  addImportItems(batch.id, [
    {
      query: 'Already Tracked',
      status: 'queued',
      appId: '3001',
      url: 'https://apps.apple.com/us/app/already-tracked/id3001',
      appName: 'Already Tracked',
      nextAttemptAt: 0,
    },
    {
      query: 'Brand New',
      status: 'queued',
      // No appId — caller didn't have one yet, or resolveSafeAppId nulled
      // it because the apps row doesn't exist. Either way: untracked.
      url: 'https://apps.apple.com/us/app/brand-new/id4001',
      appName: 'Brand New',
      nextAttemptAt: 0,
    },
  ]);

  const claimed = claimQueuedBatch(2);
  assert.equal(claimed.length, 2);
  assert.equal(claimed[0].query, 'Brand New', 'untracked row must be claimed first');
  assert.equal(claimed[1].query, 'Already Tracked', 'tracked rescrape must come last');
});

test('import queue ignores pending_search rows even when they are past their next_attempt_at', async () => {
  // pending_search rows are URL-less; they're owned by the client-side
  // QueuedSearchProvider (iTunes Search retries), not the server worker.
  // The worker must not claim them, otherwise it would mass-error every
  // URL-less row in the batch — the bug that motivated the status split.
  installQueueFetchMock({ appStatus: 200 });
  const batch = createImport({ source: 'manual', total: 2 });
  addImportItems(batch.id, [
    {
      query: 'Pending Search Fixture',
      status: 'pending_search',
      // No URL — this is the whole point. nextAttemptAt is in the past so
      // a non-status-aware claim query would scoop this up.
      nextAttemptAt: 0,
    },
    {
      query: 'Real Queued Fixture',
      status: 'queued',
      url: 'https://apps.apple.com/us/app/queued-fixture/id3001',
      appName: 'Real Queued Fixture',
      nextAttemptAt: 0,
    },
  ]);

  const result = await runImportQueueTick();

  // Only the real queued row should have been processed.
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);

  const after = getImport(batch.id);
  const pending = after?.items.find(i => i.query === 'Pending Search Fixture');
  const queued = after?.items.find(i => i.query === 'Real Queued Fixture');
  assert.equal(pending?.status, 'pending_search', 'pending_search row must not be flipped to error');
  assert.equal(pending?.attemptCount, 0, 'pending_search row must not have its attempt counter bumped');
  assert.equal(queued?.status, 'imported');
});

test('import queue clears stale running locks before checking for due work', async () => {
  setSetting('import_queue_running', 'true');
  setSetting('import_queue_running_since', String(Date.now() - 25 * 60 * 1000));

  const result = await runImportQueueTick();

  assert.equal(result.skipped, 'empty');
  assert.equal(getSetting('import_queue_running'), 'false');
});

function installQueueFetchMock(input: { appStatus: number; retryAfter?: string }) {
  global.fetch = (async (raw: string | URL | Request) => {
    const url = String(raw);
    if (url.startsWith('https://apps.apple.com/')) {
      return new Response(input.appStatus === 200 ? appStoreHtml() : 'rate limited', {
        status: input.appStatus,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          ...(input.retryAfter ? { 'retry-after': input.retryAfter } : {}),
        },
      });
    }
    if (url.startsWith('https://itunes.apple.com/lookup')) {
      return new Response(JSON.stringify({ resultCount: 1, results: [{ version: '1.0' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function appStoreHtml(): string {
  const payload = {
    data: [{
      data: {
        title: 'Queued Fixture',
        shelfMapping: {
          privacyTypes: {
            items: [{
              identifier: 'DATA_NOT_LINKED_TO_YOU',
              title: 'Data Not Linked to You',
              categories: [{ identifier: 'DIAGNOSTICS', title: 'Diagnostics' }],
            }],
          },
        },
      },
    }],
  };
  return `<meta property="og:title" content="Queued Fixture on the App Store">
    <script id="serialized-server-data">${JSON.stringify(payload)}</script>`;
}

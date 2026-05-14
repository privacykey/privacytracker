import assert from 'node:assert/strict';
import test from 'node:test';
import db from '../lib/db';
import { importAppHistory } from '../lib/historical-import';
import {
  requestActiveBulkWaybackCancel,
  runBulkWaybackImport,
} from '../lib/wayback-bulk-runner';
import {
  readBulkState,
  writeBulkState,
} from '../lib/wayback-bulk-state';
import { submitToWaybackSaveNow } from '../lib/wayback';
import { resetTestDb, seedTrackedApp } from './test-db';

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('Save Page Now resolves redirect metadata without downloading the archived page', async () => {
  const calls: string[] = [];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.redirect, 'manual');
    assert.ok(url.startsWith('https://web.archive.org/save/'));
    return new Response('x'.repeat(512 * 1024), {
      status: 302,
      headers: {
        location: '/web/20260512010203/https://apps.apple.com/au/app/tiktok/id835599320',
        'content-type': 'text/html; charset=utf-8',
      },
    });
  }) as typeof fetch;

  const result = await submitToWaybackSaveNow('https://apps.apple.com/au/app/tiktok/id835599320');

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['https://web.archive.org/save/https://apps.apple.com/au/app/tiktok/id835599320']);
  if (result.ok) {
    assert.equal(
      result.snapshot.url,
      'https://web.archive.org/web/20260512010203/https://apps.apple.com/au/app/tiktok/id835599320',
    );
    assert.equal(result.snapshot.timestamp, '20260512010203');
  }
});

test('Save Page Now accepts Content-Location without following the archive page', async () => {
  global.fetch = (async () => new Response('', {
    status: 200,
    headers: {
      'content-location': '/web/20260512040506/https://example.com/privacy',
    },
  })) as typeof fetch;

  const result = await submitToWaybackSaveNow('https://example.com/privacy');

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(
      result.snapshot.url,
      'https://web.archive.org/web/20260512040506/https://example.com/privacy',
    );
  }
});

test('historical import attempts Save Page Now once per app when multiple quarters are empty', async () => {
  resetTestDb();
  seedTrackedApp({
    id: '835599320',
    name: 'TikTok',
    url: 'https://apps.apple.com/au/app/tiktok/id835599320',
  });

  let saveCalls = 0;
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://archive.org/wayback/available')) {
      return new Response(JSON.stringify({ archived_snapshots: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://web.archive.org/save/')) {
      saveCalls += 1;
      return new Response('archive unavailable', { status: 503 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const result = await importAppHistory({
    id: '835599320',
    name: 'TikTok',
    url: 'https://apps.apple.com/au/app/tiktok/id835599320',
  }, {
    today: new Date(Date.UTC(2021, 7, 15)),
  });

  assert.equal(result.attempted, 3);
  assert.equal(saveCalls, 1);
  assert.equal(result.targets[0].outcome, 'skipped_save_now_failed');
  assert.equal(result.targets[1].outcome, 'skipped_no_capture');
  assert.equal(result.targets[2].outcome, 'skipped_no_capture');

  // We deliberately suppress synthetic changelog rows for the
  // `save_now_failed` and `no_capture` outcomes — they were turning
  // routine quarters-with-no-archive into a wall of "⚠ Wayback snapshot
  // request failed" entries. Only `requested_snapshot` (a success)
  // writes a row. Failures still surface in the bulk activity log and
  // on `ImportTargetResult.errorMessage` for the API caller.
  const attempts = db.prepare(`
    SELECT changes_summary
      FROM privacy_snapshots
     WHERE app_id = ? AND triggered_by = 'wayback'
     ORDER BY scraped_at ASC
  `).all('835599320') as Array<{ changes_summary: string }>;
  assert.equal(attempts.length, 0);
});

test('bulk Wayback cancel aborts the active archive request immediately', async () => {
  resetTestDb();
  seedTrackedApp({
    id: '835599320',
    name: 'TikTok',
    url: 'https://apps.apple.com/au/app/tiktok/id835599320',
  });

  let fetchStarted!: () => void;
  const started = new Promise<void>(resolve => {
    fetchStarted = resolve;
  });

  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchStarted();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }) as typeof fetch;

  const run = runBulkWaybackImport({ initiator: 'manual' });
  await started;

  const state = readBulkState();
  assert.ok(state);
  writeBulkState({
    ...state,
    status: 'cancel_requested',
    cancelRequestedAt: Date.now(),
  });

  assert.equal(requestActiveBulkWaybackCancel(state.runId), true);

  const result = await run;
  assert.equal(result.totals.imported, 0);
  assert.equal(readBulkState(), null);
});

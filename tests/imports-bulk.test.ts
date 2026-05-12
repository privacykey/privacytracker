import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../lib/db';
import {
  addImportItemsAsync,
  createImport,
  getImport,
} from '../lib/imports';
import { installRuntimeDiagnostics, snapshotRuntimeMetrics } from '../lib/runtime-diagnostics';
import { snapshotDbWorkerTimings } from '../lib/db-worker-client';
import { resetTestDb, seedTrackedApp } from './test-db';

test.beforeEach(() => {
  process.env.WORKER_DISABLED = '1';
  resetTestDb();
});

test('addImportItemsAsync bulk-upserts large onboarding batches and recomputes counters once', async () => {
  seedTrackedApp({ id: '4242', name: 'Shared Existing App' });
  const batch = createImport({ source: 'manual', sourceLabel: 'bulk fixture', total: 150 });

  const originalPrepare = db.prepare.bind(db);
  let safeAppIdLookups = 0;
  (db as any).prepare = function instrumentedPrepare(sql: string) {
    if (/SELECT 1 FROM apps WHERE id = \?/.test(sql)) {
      safeAppIdLookups += 1;
    }
    return originalPrepare(sql);
  };
  try {
    const rows = await addImportItemsAsync(
      batch.id,
      Array.from({ length: 150 }, (_, index) => ({
        query: `Bulk App ${index + 1}`,
        status: 'matched' as const,
        appId: '4242',
        appName: `Bulk App ${index + 1}`,
        developer: 'Bulk Dev',
        url: `https://apps.apple.com/us/app/bulk-app-${index + 1}/id${1_000_000 + index}`,
        iconUrl: `https://example.invalid/icon-${index + 1}.png`,
        country: 'us',
      })),
    );

    assert.equal(rows.length, 150);
    assert.equal(safeAppIdLookups, 1, 'repeated app ids should be FK-checked once per bulk call');
  } finally {
    (db as any).prepare = originalPrepare;
  }

  const stored = getImport(batch.id);
  assert.ok(stored);
  assert.equal(stored.import.total, 150);
  assert.equal(stored.import.matched, 150);
  assert.equal(stored.import.itemCount, 150);
  assert.equal(stored.items.length, 150);
  assert.equal(stored.items[0].appId, '4242');
});

test('runtime diagnostics can expose event-loop and DB worker snapshots on demand', () => {
  installRuntimeDiagnostics(db);
  const runtime = snapshotRuntimeMetrics();
  const worker = snapshotDbWorkerTimings();

  assert.ok(runtime.eventLoop, 'event-loop monitor should be installed before snapshot');
  assert.ok(Array.isArray(worker.recent));
  assert.equal(typeof worker.totalSinceStart, 'number');
});

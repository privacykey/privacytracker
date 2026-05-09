import assert from 'node:assert/strict';
import test from 'node:test';
import { setSetting } from '../lib/scheduler';
import {
  BULK_MUTEX_KEY,
  hasPendingWork,
  readBulkState,
  writeBulkState,
  zeroTotals,
} from '../lib/wayback-bulk-state';
import {
  SYNC_BULK_MUTEX_KEY,
  hasSyncPendingWork,
  readSyncBulkState,
  writeSyncBulkState,
  zeroSyncTotals,
} from '../lib/sync-bulk-state';
import {
  POLICY_BULK_MUTEX_KEY,
  hasPolicyPendingWork,
  readPolicyBulkState,
  writePolicyBulkState,
  zeroPolicyTotals,
} from '../lib/policy-bulk-state';
import { resetTestDb } from './test-db';

test.beforeEach(resetTestDb);

test('bulk state helpers preserve pending and in-progress work for startup resume', () => {
  writeBulkState({
    runId: 'wayback-run',
    startedAt: 1,
    initiator: 'resume',
    currentAppId: 'app-wayback',
    queue: [
      { appId: 'app-wayback', appName: 'Wayback App', status: 'in_progress' },
      { appId: 'done-wayback', appName: 'Done App', status: 'done' },
    ],
    totals: zeroTotals(),
    streamRequested: true,
  });
  writeSyncBulkState({
    runId: 'sync-run',
    startedAt: 2,
    initiator: 'resume',
    currentAppId: 'app-sync',
    queue: [
      { appId: 'app-sync', appName: 'Sync App', url: 'https://apps.apple.com/us/app/sync/id4001', status: 'pending' },
    ],
    totals: zeroSyncTotals(),
  });
  writePolicyBulkState({
    runId: 'policy-run',
    startedAt: 3,
    initiator: 'resume',
    phase: 'all',
    force: true,
    currentAppId: 'app-policy',
    queue: [
      { appId: 'app-policy', appName: 'Policy App', policyUrl: 'https://example.com/privacy', status: 'in_progress' },
    ],
    totals: zeroPolicyTotals(),
    streamRequested: true,
  });

  assert.equal(hasPendingWork(readBulkState()), true);
  assert.equal(hasSyncPendingWork(readSyncBulkState()), true);
  assert.equal(hasPolicyPendingWork(readPolicyBulkState()), true);
});

test('tasks active route reports resumed bulk jobs and stale mutexes', async () => {
  writeBulkState({
    runId: 'wayback-route-run',
    startedAt: 10,
    initiator: 'resume',
    currentAppId: 'wayback-current',
    queue: [{ appId: 'wayback-current', appName: 'Wayback Current', status: 'pending' }],
    totals: zeroTotals(),
    streamRequested: false,
  });
  writeSyncBulkState({
    runId: 'sync-route-run',
    startedAt: 20,
    initiator: 'resume',
    currentAppId: 'sync-current',
    queue: [{ appId: 'sync-current', appName: 'Sync Current', url: 'https://apps.apple.com/us/app/sync/id4002', status: 'in_progress' }],
    totals: zeroSyncTotals(),
  });
  writePolicyBulkState({
    runId: 'policy-route-run',
    startedAt: 30,
    initiator: 'resume',
    phase: 'fetch',
    force: false,
    currentAppId: 'policy-current',
    queue: [{ appId: 'policy-current', appName: 'Policy Current', policyUrl: 'https://example.com/privacy', status: 'pending' }],
    totals: zeroPolicyTotals(),
    streamRequested: false,
  });
  setSetting(BULK_MUTEX_KEY, 'true');
  setSetting(SYNC_BULK_MUTEX_KEY, 'true');
  setSetting(POLICY_BULK_MUTEX_KEY, 'true');

  const route = await import('../app/api/tasks/active/route');
  const response = await route.GET();
  const body = await response.json() as {
    wayback: { running: boolean; initiator: string | null; currentAppName: string | null; runId: string | null; stale: boolean };
    sync: { running: boolean; initiator: string | null; currentAppName: string | null; runId: string | null; stale: boolean };
    policy: { running: boolean; initiator: string | null; currentAppName: string | null; runId: string | null; stale: boolean };
  };

  assert.deepEqual({
    running: body.wayback.running,
    initiator: body.wayback.initiator,
    currentAppName: body.wayback.currentAppName,
    runId: body.wayback.runId,
    stale: body.wayback.stale,
  }, {
    running: true,
    initiator: 'resume',
    currentAppName: 'Wayback Current',
    runId: 'wayback-route-run',
    stale: false,
  });
  assert.equal(body.sync.currentAppName, 'Sync Current');
  assert.equal(body.sync.initiator, 'resume');
  assert.equal(body.policy.currentAppName, 'Policy Current');
  assert.equal(body.policy.initiator, 'resume');

  resetTestDb();
  setSetting(SYNC_BULK_MUTEX_KEY, 'true');
  const staleResponse = await route.GET();
  const staleBody = await staleResponse.json() as { sync: { running: boolean; stale: boolean; summary: unknown } };
  assert.equal(staleBody.sync.running, true);
  assert.equal(staleBody.sync.stale, true);
  assert.equal(staleBody.sync.summary, null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { exportBackup, restoreBackup } from '../lib/backup';
import { buildSnapshot, saveSnapshot } from '../lib/changelog';
import { getAppWithPrivacy } from '../lib/scraper';
import { resetTestDb, seedPrivacyCategory, seedTrackedApp } from './test-db';

test.beforeEach(resetTestDb);

test('release smoke: ready endpoint, backup round-trip, and privacy snapshot stay healthy', async () => {
  const ready = await import('../app/api/ready/route');
  const readyResponse = await ready.GET(new Request('http://127.0.0.1/api/ready'));
  assert.equal(readyResponse.status, 200);

  seedTrackedApp({
    id: 'release-smoke-app',
    name: 'Release Smoke',
    developer: 'privacykey',
    privacyPolicyUrl: 'https://example.com/privacy',
  });
  seedPrivacyCategory({
    appId: 'release-smoke-app',
    typeIdentifier: 'DATA_NOT_LINKED_TO_YOU',
    typeTitle: 'Data Not Linked to You',
    categoryIdentifier: 'DIAGNOSTICS',
    categoryTitle: 'Diagnostics',
  });

  const snapshot = buildSnapshot('release-smoke-app');
  assert.equal(snapshot.length, 1);
  saveSnapshot('release-smoke-app', snapshot, [], {
    triggeredBy: 'manual',
    skipChangeCountBump: true,
  });

  const exported = exportBackup();
  resetTestDb();
  const restored = restoreBackup(exported, { actorIp: 'release-smoke' });
  assert.ok(restored.totalRows > 0);

  const app = getAppWithPrivacy('release-smoke-app') as {
    privacyTypes: Array<{ categories: Array<{ identifier: string }> }>;
  } | null;
  assert.equal(app?.privacyTypes[0].categories[0].identifier, 'DIAGNOSTICS');
});

test('release smoke: backup restore can roll back bad imported state', () => {
  seedTrackedApp({
    id: 'known-good-app',
    name: 'Known Good',
    developer: 'privacykey',
  });
  seedPrivacyCategory({
    appId: 'known-good-app',
    typeIdentifier: 'DATA_NOT_LINKED_TO_YOU',
    typeTitle: 'Data Not Linked to You',
    categoryIdentifier: 'DIAGNOSTICS',
    categoryTitle: 'Diagnostics',
  });

  const knownGoodBackup = exportBackup();

  seedTrackedApp({
    id: 'bad-release-app',
    name: 'Bad Release',
    developer: 'Regression Lab',
  });
  seedPrivacyCategory({
    appId: 'bad-release-app',
    typeIdentifier: 'DATA_USED_TO_TRACK_YOU',
    typeTitle: 'Data Used to Track You',
    categoryIdentifier: 'IDENTIFIERS',
    categoryTitle: 'Identifiers',
  });

  assert.ok(getAppWithPrivacy('bad-release-app'));

  const restored = restoreBackup(knownGoodBackup, { actorIp: 'rollback-drill' });
  assert.ok(restored.totalRows > 0);

  const good = getAppWithPrivacy('known-good-app') as {
    privacyTypes: Array<{ categories: Array<{ identifier: string }> }>;
  } | null;
  assert.equal(good?.privacyTypes[0].categories[0].identifier, 'DIAGNOSTICS');
  assert.equal(getAppWithPrivacy('bad-release-app'), null);
});

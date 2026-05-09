import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotDatabaseHealth, runIntegrityCheck } from '../lib/db-health';
import db from '../lib/db';

/**
 * Tests for the db-health snapshot helper (lib/db-health.ts).
 *
 * `snapshotDatabaseHealth` runs against the real per-test SQLite file
 * created by tests/setup-env.ts (PRIVACYTRACKER_DATA_DIR is a temp
 * directory). The CREATE TABLE statements in lib/db.ts run on import,
 * so by the time this file executes there's a real schema for the
 * pragmas to read against.
 */

test('snapshot returns structurally sane defaults', () => {
  const snap = snapshotDatabaseHealth();
  assert.ok(snap.path.length > 0, 'path should be populated');
  assert.ok(snap.fileBytes >= 0);
  assert.ok(snap.pageCount >= 0);
  assert.ok(snap.pageSize >= 512); // SQLite minimum is 512
  assert.ok(snap.freelistCount >= 0);
  assert.ok(snap.utilisationPct >= 0 && snap.utilisationPct <= 100);
  assert.equal(snap.journalMode, 'wal'); // lib/db.ts pins this
  assert.equal(snap.foreignKeysEnabled, 1); // lib/db.ts enables FKs
});

test('utilisationPct = 100% when freelist is empty', () => {
  const snap = snapshotDatabaseHealth();
  // A fresh test DB has no freed pages.
  assert.equal(snap.freelistCount, 0);
  assert.equal(snap.utilisationPct, 100);
});

test('utilisationPct drops after pages get freed', () => {
  // Allocate a chunk, drop it, force a checkpoint to flush WAL into
  // the main file so freelist_count actually reflects the freed
  // pages.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _dbhealth_throwaway (id INTEGER PRIMARY KEY, blob TEXT);
    INSERT INTO _dbhealth_throwaway (blob) SELECT randomblob(2000) FROM (
      WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x<200) SELECT x FROM cnt
    );
  `);
  db.exec('DROP TABLE _dbhealth_throwaway');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  const snap = snapshotDatabaseHealth();
  assert.ok(snap.freelistCount >= 1, `expected freelist ≥ 1, got ${snap.freelistCount}`);
  assert.ok(snap.utilisationPct < 100);
});

test('runIntegrityCheck returns ok and caches the result', () => {
  const result = runIntegrityCheck();
  assert.equal(result.status, 'ok');
  assert.ok(typeof result.checkedAt === 'number');
  assert.ok(result.durationMs >= 0);

  // The next snapshot should embed the cached result.
  const snap = snapshotDatabaseHealth();
  assert.ok(snap.integrityCheck);
  assert.equal(snap.integrityCheck!.status, 'ok');
  assert.equal(snap.integrityCheck!.checkedAt, result.checkedAt);
});

test('snapshot exposes WAL + SHM byte sizes (may be zero on a quiet DB)', () => {
  const snap = snapshotDatabaseHealth();
  // We don't assert non-zero — a freshly-checkpointed WAL can shrink
  // to a header. The contract is just that the values are present
  // and non-negative.
  assert.ok(snap.walBytes >= 0);
  assert.ok(snap.shmBytes >= 0);
});

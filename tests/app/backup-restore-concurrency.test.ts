import assert from "node:assert/strict";
import test from "node:test";
import { POST as importHistory } from "../../app/api/apps/[id]/import-history/route";
import { POST } from "../../app/api/backup/restore/route";
import { BackupBusyError, exportBackup, restoreBackup } from "../../lib/backup";
import { isDatabaseWorkLive, withDatabaseWork } from "../../lib/database-work";
import db from "../../lib/db";
import { syncPrivacyPolicyAnalysis } from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

test.beforeEach(resetTestDb);

function names(): unknown[] {
  return db.prepare("SELECT name FROM apps ORDER BY id").all();
}

function backupBeforeNewData() {
  const backup = exportBackup();
  seedTrackedApp({ id: "910000001", name: "Keep until idle" });
  return backup;
}

test("restore refuses every persisted background mutex without replacing data", () => {
  const backup = backupBeforeNewData();
  for (const key of [
    "sync_running",
    "wayback_import_running",
    "policy_sync_running",
    "import_queue_running",
  ]) {
    setSetting(key, "true");
    assert.throws(() => restoreBackup(backup), BackupBusyError, key);
    assert.deepEqual(names(), [{ name: "Keep until idle" }]);
    setSetting(key, "false");
  }
  restoreBackup(backup);
  assert.deepEqual(names(), []);
});

test("restore rechecks work that starts while its body is uploading", async () => {
  const backup = backupBeforeNewData();
  const reading = Promise.withResolvers<void>();
  const upload = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading.resolve();
        await upload.promise;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(backup)));
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  const response = POST(
    new Request("http://localhost/api/backup/restore", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit)
  );
  await reading.promise;
  const finish = Promise.withResolvers<void>();
  const writer = withDatabaseWork(() => finish.promise);
  try {
    upload.resolve();
    assert.equal((await response).status, 409);
    assert.deepEqual(names(), [{ name: "Keep until idle" }]);
  } finally {
    finish.resolve();
    await writer;
  }
  const retry = await POST(
    new Request("http://localhost/api/backup/restore", {
      method: "POST",
      body: JSON.stringify(backup),
    })
  );
  assert.equal(retry.status, 200);
  assert.deepEqual(names(), []);
});

test("overlapping writers remain live through a failure until the last settles", async () => {
  const backup = backupBeforeNewData();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const one = withDatabaseWork(() => first.promise);
  const two = withDatabaseWork(() => second.promise);
  const rejected = assert.rejects(one, /failed writer/);
  first.reject(new Error("failed writer"));
  await rejected;
  try {
    assert.throws(() => restoreBackup(backup), BackupBusyError);
    assert.deepEqual(names(), [{ name: "Keep until idle" }]);
  } finally {
    second.resolve();
    await two;
  }
  assert.equal(isDatabaseWorkLive(), false);
  restoreBackup(backup);
});

test("a per-app policy fetch excludes restore even without a bulk mutex", async () => {
  const backup = backupBeforeNewData();
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = global.fetch;
  global.fetch = async () => {
    arrived.resolve();
    await release.promise;
    return new Response("Unavailable", { status: 503 });
  };
  const policy = syncPrivacyPolicyAnalysis(
    {
      appId: "910000001",
      appName: "Keep until idle",
      developer: "Fixture",
      policyUrl: "https://example.com/privacy",
    },
    { phase: "fetch", bypassThrottle: true }
  );
  try {
    await arrived.promise;
    assert.throws(() => restoreBackup(backup), BackupBusyError);
    assert.deepEqual(names(), [{ name: "Keep until idle" }]);
  } finally {
    release.resolve();
    await policy;
    global.fetch = original;
  }
  assert.equal(isDatabaseWorkLive(), false);
  restoreBackup(backup);
});

// The legacy Node importer reads its app before the optional request body.
// Keep that remembered row protected until the entire handler finishes.
test("restore cannot replace an app while its history request uploads", async () => {
  const backup = backupBeforeNewData();
  const reading = Promise.withResolvers<void>();
  const upload = Promise.withResolvers<void>();
  const original = global.fetch;
  global.fetch = async () => new Response("Archive busy", { status: 429 });
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading.resolve();
        await upload.promise;
        controller.enqueue(new TextEncoder().encode('{"force":true}'));
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  const importing = importHistory(
    new Request("http://localhost/api/apps/910000001/import-history", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit),
    { params: Promise.resolve({ id: "910000001" }) }
  );
  try {
    await reading.promise;
    assert.throws(() => restoreBackup(backup), BackupBusyError);
    assert.deepEqual(names(), [{ name: "Keep until idle" }]);
  } finally {
    upload.resolve();
    try {
      assert.equal((await importing).status, 503);
    } finally {
      global.fetch = original;
    }
  }
  assert.equal(isDatabaseWorkLive(), false);
  restoreBackup(backup);
});

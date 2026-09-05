import assert from "node:assert/strict";
import { realpathSync, statSync, utimesSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as recordBackupRoute } from "../../app/api/device-actions/backup/route";
import {
  GET as getUninstallGate,
  POST as recordUninstallRoute,
} from "../../app/api/device-actions/uninstall/route";
import { setActiveFocus, setOverride } from "../../lib/feature-flag-storage";
import { resetTestDb } from "../helpers/test-db";
import { createVerifiedTestBackup } from "../helpers/test-device-backup";

const ECID = "ABCDEF1234567890";

function setSelfFocus(): void {
  setActiveFocus({
    audience: "self",
    monitor: false,
    cleanup: false,
    minimal: false,
    accessibility: false,
  });
}

test("device action routes preserve upload-limit responses", async () => {
  resetTestDb();
  setSelfFocus();
  for (const handler of [recordBackupRoute, recordUninstallRoute]) {
    const response = await handler(
      new NextRequest("http://127.0.0.1/api/device-actions/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ecid: ECID, path: "x".repeat(8 * 1024) }),
      })
    );
    assert.equal(response.status, 413);
  }
});

test("backup route verifies the artifact and owns the completion time", async () => {
  resetTestDb();
  setSelfFocus();
  const path = createVerifiedTestBackup("route");
  const modifiedAt = Math.floor(statSync(`${path}/Manifest.db`).mtimeMs);
  const response = await recordBackupRoute(
    new Request("http://127.0.0.1/api/device-actions/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ecid: ECID,
        path,
        finishedAt: Date.now() + 86400000,
        deviceName: "Test iPhone",
      }),
    }) as Parameters<typeof recordBackupRoute>[0]
  );
  const body = (await response.json()) as {
    lastBackup?: { finishedAt: number; manifestBytes: number; path: string };
    ok?: boolean;
  };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.lastBackup?.path, realpathSync(path));
  assert.ok((body.lastBackup?.manifestBytes ?? 0) > 0);
  assert.equal(body.lastBackup?.finishedAt, modifiedAt);
});

test("backup route refuses a claimed path without a valid manifest", async () => {
  resetTestDb();
  setSelfFocus();
  const response = await recordBackupRoute(
    new Request("http://127.0.0.1/api/device-actions/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ecid: ECID,
        path: "/tmp/not-a-real-privacytracker-backup",
      }),
    }) as Parameters<typeof recordBackupRoute>[0]
  );

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "backup_not_verified");
});

test("uninstall gate GET includes the authoritative backup stamp", async () => {
  resetTestDb();
  setSelfFocus();
  setOverride("flag.devopts.cfgutil_uninstall", "on");
  const path = createVerifiedTestBackup("gate-route");
  await recordBackupRoute(
    new Request("http://127.0.0.1/api/device-actions/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ecid: ECID, path }),
    }) as Parameters<typeof recordBackupRoute>[0]
  );

  const response = await getUninstallGate(
    new NextRequest(
      `http://127.0.0.1/api/device-actions/uninstall?ecid=${ECID}`
    )
  );
  const body = (await response.json()) as {
    allowed?: boolean;
    lastBackup?: { path: string } | null;
  };
  assert.equal(body.allowed, true);
  assert.equal(body.lastBackup?.path, realpathSync(path));
});

test("re-recording an old backup cannot refresh its completion time", async () => {
  resetTestDb();
  setSelfFocus();
  setOverride("flag.devopts.cfgutil_uninstall", "on");
  const path = createVerifiedTestBackup("old-route");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(`${path}/Manifest.db`, old, old);
  const response = await recordBackupRoute(
    new NextRequest("http://127.0.0.1/api/device-actions/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ecid: ECID, path, finishedAt: Date.now() }),
    })
  );
  assert.equal(response.status, 200);
  const stamp = (await response.json()).lastBackup;
  assert.ok(stamp.finishedAt <= old.getTime());
  const gate = await getUninstallGate(
    new NextRequest(
      `http://127.0.0.1/api/device-actions/uninstall?ecid=${ECID}`
    )
  );
  assert.equal((await gate.json()).reason, "backup_stale");
});

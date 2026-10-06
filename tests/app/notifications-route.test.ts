/**
 * Two contracts of the bell's server side that the type-filter and prefs
 * tests do not cover.
 *
 * 1. An App Store version update writes a bell row only while the
 *    `versionUpdates` type is on, and it is off by default. The writer's
 *    comment had promised this since the type existed, but nothing read the
 *    preference: every app update raised a row that the bell, the Dock
 *    badge and the desktop toast all presented as "1 privacy change
 *    detected". The gate is on the write, not the read, so off means no
 *    row and no dedupe stamp rather than a hidden row.
 * 2. `POST /api/notifications { action: "clear" }` deletes every row, read
 *    or not, and says how many went. The Rust mirror is replayed from the
 *    "notifications clear all" cases of core/tests/fixtures/library-cases.json.
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { GET, POST } from "../../app/api/notifications/route";
import db from "../../lib/db";
import {
  createNotification,
  createVersionUpdateNotification,
  versionUpdateNotificationsEnabled,
} from "../../lib/notifications";
import { getSetting, setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const VERSION_INPUT = {
  appId: "123",
  appName: "Fixture App",
  previousVersion: "1.0",
  currentVersion: "2.0",
  previousVersionUpdatedAt: null,
  currentVersionUpdatedAt: null,
};

function rowCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }
  ).n;
}

async function post(body: unknown): Promise<Response> {
  return await POST(
    new Request("http://127.0.0.1/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  resetTestDb();
  seedTrackedApp({ id: "123", name: "Fixture App" });
  setSetting("notification_prefs", "");
});

test("a version update writes no bell row while the type is off, which it is by default", () => {
  assert.equal(versionUpdateNotificationsEnabled(), false);
  assert.equal(createVersionUpdateNotification(VERSION_INPUT), false);
  assert.equal(rowCount(), 0);
  // No dedupe stamp either: turning the type on later must not find a
  // window already running from a row that was never written.
  assert.equal(getSetting("version_update_notified_123_at", ""), "");
});

test("a version update writes its bell row once the type is on", () => {
  setSetting("notification_prefs", JSON.stringify({ versionUpdates: true }));
  assert.equal(versionUpdateNotificationsEnabled(), true);
  assert.equal(createVersionUpdateNotification(VERSION_INPUT), true);
  assert.equal(rowCount(), 1);
  const row = db.prepare("SELECT change_summary FROM notifications").get() as {
    change_summary: string;
  };
  const [entry] = JSON.parse(row.change_summary) as Array<{
    type: string;
    previousVersion: string;
    currentVersion: string;
  }>;
  assert.equal(entry.type, "version_update");
  assert.equal(entry.previousVersion, "1.0");
  assert.equal(entry.currentVersion, "2.0");
  assert.notEqual(getSetting("version_update_notified_123_at", ""), "");
});

test("the stored preference is read the way Settings stores it", () => {
  // Only a boolean counts; an unparseable blob or a wrong type keeps the
  // default, as parseStoredPrefs reads them for the bell.
  setSetting("notification_prefs", '{"versionUpdates":"yes"}');
  assert.equal(versionUpdateNotificationsEnabled(), false);
  setSetting("notification_prefs", "{nope");
  assert.equal(versionUpdateNotificationsEnabled(), false);
  setSetting("notification_prefs", '{"aiTimeout":false,"versionUpdates":true}');
  assert.equal(versionUpdateNotificationsEnabled(), true);
});

test("clear removes every notification, read or unread, and counts them", async () => {
  createNotification("123", "Fixture App", [
    { type: "added", description: "Fixture App now collects Location" },
  ]);
  createNotification("123", "Fixture App", [
    { type: "removed", description: "Fixture App no longer collects Contacts" },
  ]);
  db.prepare("UPDATE notifications SET read = 1 WHERE rowid = 1").run();
  assert.equal(rowCount(), 2);

  const res = await post({ action: "clear" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, removed: 2 });
  assert.equal(rowCount(), 0);

  const listed = await (await GET()).json();
  assert.deepEqual(listed.notifications, []);
  assert.equal(listed.unreadCount, 0);
});

test("clear with nothing to clear is a success that removed nothing", async () => {
  const res = await post({ action: "clear" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, removed: 0 });
});

test("an unknown action is still refused", async () => {
  const res = await post({ action: "delete" });
  assert.equal(res.status, 400);
});

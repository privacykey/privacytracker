/**
 * "Sync daily when Monitor is chosen": saving a focus with the Monitor goal
 * sets the sync schedule to daily when the user has never chosen one, and
 * never touches a schedule someone did choose (Manual included). Turning
 * Monitor off later leaves whatever schedule is there. The defaulted
 * schedule's first sync is a day after it was turned on, not at once.
 * Implemented in lib/scheduler.ts (`applyMonitorSyncDefault`, called by
 * POST /api/focus, and `getSchedulerStatus`).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../../app/api/focus/route";
import db from "../../lib/db";
import {
  applyMonitorSyncDefault,
  getSchedulerStatus,
  MONITOR_DEFAULT_AT_KEY,
  MONITOR_DEFAULT_SYNC_SCHEDULE,
  setSetting,
} from "../../lib/scheduler";
import { optInTask, resolveAllTasks } from "../../lib/tasks-server";
import { resetTestDb } from "../helpers/test-db";

function saveFocus(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://127.0.0.1/api/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  );
}

/** The stored row, or null when there is none: "never chosen". */
function storedSchedule(): string | null {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = 'sync_schedule'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

const MONITOR = {
  audience: "self",
  monitor: true,
  cleanup: false,
  minimal: false,
  accessibility: false,
};

test.beforeEach(() => {
  resetTestDb();
});

test("a fresh install that chooses Monitor syncs daily", async () => {
  assert.equal(storedSchedule(), null);
  assert.equal(getSchedulerStatus().schedule, "manual");
  const res = await saveFocus(MONITOR);
  assert.equal(res.status, 200);
  assert.equal(storedSchedule(), "daily");
  assert.equal(MONITOR_DEFAULT_SYNC_SCHEDULE, "daily");
  assert.equal(getSchedulerStatus().schedule, "daily");
});

test("the default's first sync is a day after it was turned on, not at once", async () => {
  const before = Date.now();
  await saveFocus(MONITOR);
  const after = Date.now();
  const status = getSchedulerStatus();
  // Never synced: without the marker this would be due immediately, and
  // the first tick after onboarding would re-fetch every imported app.
  assert.equal(status.lastRun, 0);
  assert.equal(status.isDue, false);
  const day = 24 * 60 * 60 * 1000;
  assert.ok(status.nextRun !== null);
  assert.ok(status.nextRun >= before + day && status.nextRun <= after + day);

  // A day on, it is due; and once a sync has run, the sync counts.
  setSetting(MONITOR_DEFAULT_AT_KEY, String(Date.now() - day - 1000));
  assert.equal(getSchedulerStatus().isDue, true);
  setSetting("last_auto_sync", String(Date.now() - 1000));
  assert.equal(getSchedulerStatus().isDue, false);
});

test("a schedule picked by hand keeps its old timing", () => {
  // No marker: an install that has never synced is due at once, as before.
  setSetting("sync_schedule", "daily");
  assert.equal(getSchedulerStatus().isDue, true);
});

test("the default applies to any audience that keeps Monitor", async () => {
  await saveFocus({ ...MONITOR, audience: "loved_one" });
  assert.equal(storedSchedule(), "daily");
});

test("an explicit Manual choice is kept", async () => {
  setSetting("sync_schedule", "manual");
  await saveFocus(MONITOR);
  assert.equal(storedSchedule(), "manual");
  // And no marker: nothing was defaulted.
  const marker = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(MONITOR_DEFAULT_AT_KEY);
  assert.equal(marker, undefined);
});

test("an explicit Weekly choice is kept", async () => {
  setSetting("sync_schedule", "weekly");
  await saveFocus(MONITOR);
  assert.equal(storedSchedule(), "weekly");
});

test("turning Monitor off later keeps daily", async () => {
  await saveFocus(MONITOR);
  assert.equal(storedSchedule(), "daily");
  await saveFocus({ ...MONITOR, monitor: false, cleanup: true });
  assert.equal(storedSchedule(), "daily");
});

test("a focus without Monitor sets no schedule", async () => {
  await saveFocus({ ...MONITOR, monitor: false, cleanup: true });
  assert.equal(storedSchedule(), null);
  // "Keep it minimal" wins over the tiles, so Monitor is not saved.
  await saveFocus({ ...MONITOR, minimal: true });
  assert.equal(storedSchedule(), null);
});

test("an empty stored value counts as never chosen", () => {
  setSetting("sync_schedule", "");
  assert.equal(applyMonitorSyncDefault(), true);
  assert.equal(storedSchedule(), "daily");
  assert.equal(applyMonitorSyncDefault(), false);
});

test("with the default on, the background-sync checklist item reads as done", async () => {
  // Onboarding opts a Monitor user into this item (resolvePurposeSelection).
  await saveFocus(MONITOR);
  optInTask("setup_background_mode");
  const row = resolveAllTasks(undefined, false).find(
    (t) => t.id === "setup_background_mode"
  );
  assert.equal(row?.state, "completed");
});

test("with an explicit Manual choice, the checklist item stays open", async () => {
  setSetting("sync_schedule", "manual");
  await saveFocus(MONITOR);
  optInTask("setup_background_mode");
  const row = resolveAllTasks(undefined, false).find(
    (t) => t.id === "setup_background_mode"
  );
  assert.notEqual(row?.state, "completed");
});

import assert from "node:assert/strict";
import test from "node:test";
import * as healthRoute from "../app/api/diagnostics/health/route";
import { getRecentActivity } from "../lib/activity";
import db from "../lib/db";
import { readLastHealthCheck, runHealthCheck } from "../lib/health-check";
import {
  isPolicyBulkMutexHeld,
  POLICY_BULK_MUTEX_KEY,
} from "../lib/policy-bulk-state";
import { getSetting, setSetting } from "../lib/scheduler";
import {
  isSyncBulkMutexHeld,
  readSyncBulkState,
  SYNC_BULK_MUTEX_KEY,
  writeSyncBulkState,
  zeroSyncTotals,
} from "../lib/sync-bulk-state";
import {
  BULK_MUTEX_KEY,
  isBulkMutexHeld,
  writeBulkState,
  zeroTotals,
} from "../lib/wayback-bulk-state";
import { resetTestDb, seedTrackedApp } from "./test-db";

test.beforeEach(resetTestDb);

const HOUR = 60 * 60_000;

function seedPolicyAnalysis(
  appId: string,
  runStatus: string,
  runStartedAt: number | null
): void {
  seedTrackedApp({ id: appId });
  db.prepare(
    `INSERT INTO privacy_policy_analyses
       (app_id, policy_url, status, updated_at, run_status, run_started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    appId,
    "https://example.com/p",
    "pending",
    Date.now(),
    runStatus,
    runStartedAt
  );
}

test("healthy DB → status ok, no heals, single activity row", () => {
  const result = runHealthCheck({ trigger: "scheduled" });
  assert.equal(result.healthy, true);
  assert.equal(result.status, "ok");
  assert.equal(result.heals.length, 0);
  assert.equal(result.checks.warnings.length, 0);

  const rows = getRecentActivity({ type: "health_check" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "ok");
});

test("stale lock — orphan mutex (no state blob) is cleared", () => {
  setSetting(SYNC_BULK_MUTEX_KEY, "true"); // held, but no sync_bulk_state
  const result = runHealthCheck({ trigger: "manual" });
  assert.ok(result.heals.some((h) => h.kind === "stale_lock_sync"));
  assert.equal(isSyncBulkMutexHeld(), false);
});

test("stale lock — completed blob (no pending work) is cleared", () => {
  writeSyncBulkState({
    runId: "done-run",
    startedAt: Date.now(),
    initiator: "scheduled",
    currentAppId: null,
    queue: [
      {
        appId: "a1",
        appName: "A1",
        url: "https://apps.apple.com/x/id1",
        status: "done",
      },
    ],
    totals: zeroSyncTotals(),
  });
  setSetting(SYNC_BULK_MUTEX_KEY, "true");

  const result = runHealthCheck({ trigger: "manual" });
  assert.ok(result.heals.some((h) => h.kind === "stale_lock_sync"));
  assert.equal(isSyncBulkMutexHeld(), false);
  assert.equal(readSyncBulkState(), null);
});

test("stale lock — pending work but updatedAt 7h old is cleared", () => {
  // Build the blob by hand so we can backdate updatedAt (writeSyncBulkState
  // always stamps Date.now()). Shape must satisfy readSyncBulkState.
  const staleBlob = {
    version: 1,
    runId: "stale-run",
    startedAt: Date.now() - 8 * HOUR,
    initiator: "scheduled",
    currentAppId: "a1",
    queue: [
      {
        appId: "a1",
        appName: "A1",
        url: "https://apps.apple.com/x/id1",
        status: "pending",
      },
    ],
    totals: zeroSyncTotals(),
    updatedAt: Date.now() - 7 * HOUR,
  };
  setSetting("sync_bulk_state", JSON.stringify(staleBlob));
  setSetting(SYNC_BULK_MUTEX_KEY, "true");

  const result = runHealthCheck({ trigger: "manual" });
  assert.ok(result.heals.some((h) => h.kind === "stale_lock_sync"));
  assert.equal(isSyncBulkMutexHeld(), false);
});

test("CRITICAL: a live run (pending work, recent updatedAt) is NOT cleared", () => {
  writeSyncBulkState({
    runId: "live-run",
    startedAt: Date.now(),
    initiator: "scheduled",
    currentAppId: "a1",
    queue: [
      {
        appId: "a1",
        appName: "A1",
        url: "https://apps.apple.com/x/id1",
        status: "pending",
      },
    ],
    totals: zeroSyncTotals(),
  }); // updatedAt = now
  setSetting(SYNC_BULK_MUTEX_KEY, "true");

  const result = runHealthCheck({ trigger: "manual" });
  assert.equal(
    result.heals.some((h) => h.kind === "stale_lock_sync"),
    false
  );
  assert.equal(isSyncBulkMutexHeld(), true);
  assert.notEqual(readSyncBulkState(), null);
});

test("paused wayback queue is NOT cleared", () => {
  writeBulkState({
    runId: "wb-run",
    startedAt: Date.now() - 8 * HOUR,
    initiator: "resume",
    currentAppId: "a1",
    queue: [{ appId: "a1", appName: "A1", status: "pending" }],
    totals: zeroTotals(),
    streamRequested: false,
  });
  // Flip to paused + backdate so only the paused guard protects it.
  const blob = JSON.parse(getSetting("wayback_bulk_state", ""));
  blob.status = "paused";
  blob.updatedAt = Date.now() - 7 * HOUR;
  setSetting("wayback_bulk_state", JSON.stringify(blob));
  setSetting(BULK_MUTEX_KEY, "true");

  const result = runHealthCheck({ trigger: "manual" });
  assert.equal(
    result.heals.some((h) => h.kind === "stale_lock_wayback"),
    false
  );
  assert.equal(isBulkMutexHeld(), true);
});

test("stuck run_status reset respects the age gate", () => {
  seedPolicyAnalysis("old-app", "running", Date.now() - 7 * HOUR);
  seedPolicyAnalysis("new-app", "running", Date.now() - 60_000);

  const result = runHealthCheck({ trigger: "manual" });
  assert.ok(result.heals.some((h) => h.kind === "policy_run_status_reset"));

  const oldRow = db
    .prepare("SELECT run_status FROM privacy_policy_analyses WHERE app_id = ?")
    .get("old-app") as { run_status: string };
  const newRow = db
    .prepare("SELECT run_status FROM privacy_policy_analyses WHERE app_id = ?")
    .get("new-app") as { run_status: string };
  assert.equal(oldRow.run_status, "idle"); // 7h old → reset
  assert.equal(newRow.run_status, "running"); // 1m old → left alone
});

test("write-heals are skipped while a bulk job is active; read-checks still run", () => {
  setSetting("import_queue_running", "true"); // no _since → not stale-cleared
  seedPolicyAnalysis("stuck-app", "running", Date.now() - 7 * HOUR);

  const result = runHealthCheck({ trigger: "manual" });

  assert.ok(
    result.skippedHeals.some(
      (s) => s.kind === "policy_run_status_reset" && s.reason === "bulk-active"
    )
  );
  const row = db
    .prepare("SELECT run_status FROM privacy_policy_analyses WHERE app_id = ?")
    .get("stuck-app") as { run_status: string };
  assert.equal(row.run_status, "running"); // NOT reset while bulk active
  assert.equal(typeof result.checks.counts.notifications, "number"); // read-checks ran
});

test("orphan rows are reported, NOT deleted", () => {
  db.prepare(
    `INSERT INTO manual_app_events (id, manual_app_id, event_type, occurred_at, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).run("ev-ghost", "ghost-app", "scrape", Date.now(), null);

  const result = runHealthCheck({ trigger: "manual" });
  assert.equal(result.checks.orphans.manualAppEvents, 1);

  const stillThere = db
    .prepare("SELECT COUNT(*) AS n FROM manual_app_events WHERE id = ?")
    .get("ev-ghost") as { n: number };
  assert.equal(stillThere.n, 1); // reported, never deleted
});

test("integrity check is gated (disabled by default, runs when enabled)", () => {
  let result = runHealthCheck({ trigger: "manual" });
  assert.deepEqual(result.checks.database.integrity, { skipped: "disabled" });

  setSetting("health_check_integrity_enabled", "true");
  result = runHealthCheck({ trigger: "manual" });
  const integ = result.checks.database.integrity;
  assert.ok(integ && "status" in integ);
  assert.equal(integ.status, "ok");
  assert.equal(integ.fresh, true);
});

test("result is persisted and served by GET /api/diagnostics/health", async () => {
  const result = runHealthCheck({ trigger: "manual" });
  const last = readLastHealthCheck();
  assert.ok(last);
  assert.equal(last.finishedAt, result.finishedAt);

  const res = healthRoute.GET();
  const body = (await res.json()) as { version: number; finishedAt: number };
  assert.equal(body.version, 1);
  assert.equal(body.finishedAt, result.finishedAt);
});

test("POST runs on demand and is rate-limited", async () => {
  const mkReq = (ip: string) =>
    new Request("http://127.0.0.1/api/diagnostics/health", {
      method: "POST",
      headers: { host: "127.0.0.1", "x-forwarded-for": ip },
    });

  // Fresh IP → admin not required (local host) → 200.
  const okRes = await healthRoute.POST(mkReq("10.0.0.31"));
  assert.equal(okRes.status, 200);
  const okBody = (await okRes.json()) as { version: number };
  assert.equal(okBody.version, 1);

  // Distinct IP, 5 calls (limit 4) → 5th is 429.
  let last: Response | undefined;
  for (let i = 0; i < 5; i++) {
    last = await healthRoute.POST(mkReq("10.0.0.32"));
  }
  assert.equal(last?.status, 429);
});

// Confirm the policy mutex helper import is wired (guards against a rename
// breaking the bulk-active gate silently).
test("policy mutex helper reflects app_settings", () => {
  assert.equal(isPolicyBulkMutexHeld(), false);
  setSetting(POLICY_BULK_MUTEX_KEY, "true");
  assert.equal(isPolicyBulkMutexHeld(), true);
});

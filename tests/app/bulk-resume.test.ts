import assert from "node:assert/strict";
import test from "node:test";
import { getRecentActivity } from "../../lib/activity";
import db from "../../lib/db";
import { runBulkPolicySync } from "../../lib/policy-bulk-runner";
import {
  hasPolicyPendingWork,
  POLICY_BULK_MUTEX_KEY,
  readPolicyBulkState,
  writePolicyBulkState,
  zeroPolicyTotals,
} from "../../lib/policy-bulk-state";
import { getSetting, setSetting } from "../../lib/scheduler";
import { runBulkSync } from "../../lib/sync-bulk-runner";
import {
  hasSyncPendingWork,
  readSyncBulkState,
  SYNC_BULK_MUTEX_KEY,
  writeSyncBulkState,
  zeroSyncTotals,
} from "../../lib/sync-bulk-state";
import { runBulkWaybackImport } from "../../lib/wayback-bulk-runner";
import {
  BULK_MUTEX_KEY,
  hasPendingWork,
  isBulkMutexHeld,
  isBulkStatePaused,
  readBulkState,
  shouldAutoResumeBulkState,
  writeBulkState,
  zeroTotals,
} from "../../lib/wayback-bulk-state";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const originalFetch = global.fetch;

test.beforeEach(resetTestDb);
test.afterEach(() => {
  global.fetch = originalFetch;
});

test("bulk state helpers preserve pending and in-progress work for startup resume", () => {
  writeBulkState({
    runId: "wayback-run",
    startedAt: 1,
    initiator: "manual",
    currentAppId: "app-wayback",
    queue: [
      { appId: "app-wayback", appName: "Wayback App", status: "in_progress" },
      { appId: "done-wayback", appName: "Done App", status: "done" },
    ],
    totals: zeroTotals(),
    streamRequested: true,
  });
  writeSyncBulkState({
    runId: "sync-run",
    startedAt: 2,
    initiator: "scheduled",
    currentAppId: "app-sync",
    queue: [
      {
        appId: "app-sync",
        appName: "Sync App",
        url: "https://apps.apple.com/us/app/sync/id4001",
        status: "pending",
      },
    ],
    totals: zeroSyncTotals(),
  });
  writePolicyBulkState({
    runId: "policy-run",
    startedAt: 3,
    initiator: "automatic",
    phase: "all",
    force: true,
    currentAppId: "app-policy",
    queue: [
      {
        appId: "app-policy",
        appName: "Policy App",
        policyUrl: "https://example.com/privacy",
        status: "in_progress",
      },
    ],
    totals: zeroPolicyTotals(),
    streamRequested: true,
  });

  assert.equal(hasPendingWork(readBulkState()), true);
  assert.equal(shouldAutoResumeBulkState(readBulkState()), true);
  assert.equal(hasSyncPendingWork(readSyncBulkState()), true);
  assert.equal(hasPolicyPendingWork(readPolicyBulkState()), true);
});

test("paused Wayback bulk state keeps pending work but does not auto-resume", () => {
  writeBulkState({
    runId: "wayback-paused-run",
    startedAt: 10,
    initiator: "manual",
    status: "paused",
    pausedAt: 20,
    currentAppId: null,
    queue: [
      { appId: "paused-app", appName: "Paused App", status: "pending" },
      { appId: "done-app", appName: "Done App", status: "done" },
    ],
    totals: zeroTotals(),
    streamRequested: false,
  });

  const state = readBulkState();
  assert.equal(hasPendingWork(state), true);
  assert.equal(isBulkStatePaused(state), true);
  assert.equal(shouldAutoResumeBulkState(state), false);
});

test("tasks active route reports a stale mutex", async () => {
  setSetting(SYNC_BULK_MUTEX_KEY, "true");
  const route = await import("../../app/api/tasks/active/route");
  const body = (await (await route.GET()).json()) as {
    sync: { running: boolean; stale: boolean; summary: unknown };
  };
  assert.equal(body.sync.running, true);
  assert.equal(body.sync.stale, true);
  assert.equal(body.sync.summary, null);
});

// ── A real run, crashed and resumed ─────────────────────────────────────
//
// The blobs below come from the runners themselves, never written by
// hand: a real run is stopped mid-app, and the resume is the call
// `instrumentation.ts` makes after a restart. The run's blob names
// whoever started it, so the resume has to record that it is one.

/**
 * Start a real run and kill it mid-app: its first fetch never answers,
 * so the run stops right after persisting the app it had in flight and
 * never writes again, which is what a server killed at that moment
 * leaves behind (the blob, and the mutex still held).
 */
async function crashMidRun(start: () => Promise<unknown>): Promise<void> {
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  global.fetch = (() => {
    arrive();
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  start();
  await arrived;
}

/**
 * Hold the next run's first fetch until `inFlight` has looked at the run,
 * then answer it and every later fetch with `reply`. Resolves once the
 * run has reached its first fetch; `release` lets it go.
 */
function holdFirstFetch(reply: (url: string) => Response): {
  arrived: Promise<void>;
  release: () => void;
} {
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  global.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (first) {
      first = false;
      arrive();
      await released;
    }
    return reply(url);
  }) as typeof fetch;
  return { arrived, release };
}

interface ActiveJob {
  currentAppName: string | null;
  initiator: string | null;
  runId: string | null;
  running: boolean;
}

async function activeTasks(): Promise<
  Record<"wayback" | "sync" | "policy", ActiveJob>
> {
  const route = await import("../../app/api/tasks/active/route");
  return (await (await route.GET()).json()) as Record<
    "wayback" | "sync" | "policy",
    ActiveJob
  >;
}

/** What the Settings pill reads: `GET /api/wayback/import-all`. */
async function waybackPillInitiator(): Promise<string | null> {
  const route = await import("../../app/api/wayback/import-all/route");
  const body = (await (await route.GET()).json()) as {
    state: { initiator: string } | null;
  };
  return body.state?.initiator ?? null;
}

/**
 * The resumed run rewrites the crashed blob in place: same schema
 * version, same keys, so a build from before the fix still reads it.
 */
function assertSameBlobShape(key: string, crashedRaw: string): void {
  const crashed = JSON.parse(crashedRaw) as Record<string, unknown>;
  const now = JSON.parse(getSetting(key)) as Record<string, unknown>;
  assert.equal(now.version, crashed.version);
  assert.deepEqual(Object.keys(now), Object.keys(crashed));
}

function auditActions(): string[] {
  return (
    db.prepare("SELECT action FROM audit_log ORDER BY created_at").all() as {
      action: string;
    }[]
  ).map((row) => row.action);
}

function mode(row: { detail: unknown }): unknown {
  return (row.detail as { mode?: unknown } | null)?.mode;
}

const emptyArchive = (url: string): Response => {
  if (url.startsWith("https://web.archive.org/cdx/search/cdx")) {
    return new Response(JSON.stringify([["timestamp", "statuscode"]]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.startsWith("https://web.archive.org/save/")) {
    return new Response("archive unavailable", { status: 503 });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

function seedTwoApps(privacyPolicyUrls = false): void {
  seedTrackedApp({
    id: "910000001",
    name: "Alpha",
    privacyPolicyUrl: privacyPolicyUrls
      ? "https://example.com/privacy-alpha"
      : undefined,
  });
  seedTrackedApp({
    id: "910000002",
    name: "Beta",
    privacyPolicyUrl: privacyPolicyUrls
      ? "https://example.com/privacy-beta"
      : undefined,
  });
}

test("an App Store sync resumed after a restart reports initiator resume", async () => {
  seedTwoApps();
  await crashMidRun(() => runBulkSync({ initiator: "manual" }));
  const crashedRaw = getSetting("sync_bulk_state");
  const crashed = readSyncBulkState();
  assert.equal(crashed?.initiator, "manual");
  assert.equal(getSetting(SYNC_BULK_MUTEX_KEY), "true");

  // instrumentation.ts resumeAppStoreSync
  const hold = holdFirstFetch(
    () => new Response("unavailable", { status: 503 })
  );
  const run = runBulkSync({ initiator: "resume", resumeState: crashed! });
  await hold.arrived;
  const { sync } = await activeTasks();
  assert.equal(sync.initiator, "resume");
  assert.equal(sync.running, true);
  assert.equal(sync.runId, crashed?.runId);
  assert.equal(sync.currentAppName, "Alpha");
  assertSameBlobShape("sync_bulk_state", crashedRaw);
  hold.release();
  await run;

  // Resumed after the user's Sync now, it still records as a scheduled
  // sync: nobody pressed anything in this process, and the Upgrading
  // docs say a boot-time auto-resume records as `scheduled_sync`.
  assert.deepEqual(getRecentActivity({ type: "manual_sync" }), []);
  const [row] = getRecentActivity({ type: "scheduled_sync" }).filter(
    (r) => mode(r) === "bulk-resumed"
  );
  assert.ok(row, "the resumed run's summary row");
  assert.match(row.summary ?? "", / \(resumed after restart\)$/);
  assert.equal(readSyncBulkState(), null);
});

test("a Wayback import resumed after a restart reports initiator resume", async () => {
  seedTwoApps();
  await crashMidRun(() => runBulkWaybackImport({ initiator: "manual" }));
  const crashedRaw = getSetting("wayback_bulk_state");
  const crashed = readBulkState();
  assert.equal(crashed?.initiator, "manual");
  assert.equal(getSetting(BULK_MUTEX_KEY), "true");

  // instrumentation.ts resumeWaybackImport
  const hold = holdFirstFetch(emptyArchive);
  const run = runBulkWaybackImport({
    initiator: "resume",
    streamRequested: crashed!.streamRequested,
    resumeState: crashed!,
  });
  await hold.arrived;
  const { wayback } = await activeTasks();
  assert.equal(wayback.initiator, "resume");
  assert.equal(wayback.running, true);
  assert.equal(wayback.runId, crashed?.runId);
  assert.equal(wayback.currentAppName, "Alpha");
  assert.equal(await waybackPillInitiator(), "resume");
  assertSameBlobShape("wayback_bulk_state", crashedRaw);
  hold.release();
  await run;

  const rows = getRecentActivity({ type: "wayback_import" });
  const [summary] = rows.filter((r) => mode(r) === "bulk-resumed");
  assert.ok(summary, "the resumed run's summary row");
  assert.match(
    summary.summary ?? "",
    /^Wayback import \(resumed\) across 2 apps/
  );
  const perApp = rows.filter((r) => mode(r) === "bulk-app");
  assert.equal(perApp.length, 2);
  for (const r of perApp) {
    assert.equal((r.detail as { resumedRun?: unknown }).resumedRun, true);
  }
  assert.deepEqual(auditActions(), ["wayback.import.bulk.resumed.success"]);
  assert.equal(readBulkState(), null);
});

test("a policy sync resumed after a restart reports initiator resume", async () => {
  seedTwoApps(true);
  // `force` so the resumed fetch of Alpha is not throttled away.
  await crashMidRun(() =>
    runBulkPolicySync({ initiator: "manual", phase: "fetch", force: true })
  );
  const crashedRaw = getSetting("policy_bulk_state");
  const crashed = readPolicyBulkState();
  assert.equal(crashed?.initiator, "manual");
  assert.equal(getSetting(POLICY_BULK_MUTEX_KEY), "true");

  // instrumentation.ts resumePolicySync
  const hold = holdFirstFetch(
    () =>
      new Response("Privacy policy text. ".repeat(200), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
  );
  const run = runBulkPolicySync({
    initiator: "resume",
    phase: crashed!.phase,
    force: crashed!.force,
    streamRequested: crashed!.streamRequested,
    resumeState: crashed!,
  });
  await hold.arrived;
  const { policy } = await activeTasks();
  assert.equal(policy.initiator, "resume");
  assert.equal(policy.running, true);
  assert.equal(policy.runId, crashed?.runId);
  assert.equal(policy.currentAppName, "Alpha");
  assertSameBlobShape("policy_bulk_state", crashedRaw);
  hold.release();
  await run;

  const [row] = getRecentActivity({ type: "policy_summary" }).filter(
    (r) => mode(r) === "bulk-resumed"
  );
  assert.ok(row, "the resumed run's summary row");
  assert.match(row.summary ?? "", / \(resumed after restart\)$/);
  assert.deepEqual(auditActions(), ["policy.sync-all.resumed.success"]);
  assert.equal(readPolicyBulkState(), null);
});

test("Resume queue on a Wayback import a restart had resumed is the user's run", async () => {
  seedTwoApps();
  await crashMidRun(() => runBulkWaybackImport({ initiator: "manual" }));

  // The restart resume meets a throttling archive twice and parks the
  // queue, which now says it was resumed after a restart.
  global.fetch = (async () =>
    new Response("slow down", {
      status: 429,
      headers: { "retry-after": "1" },
    })) as typeof fetch;
  await runBulkWaybackImport({
    initiator: "resume",
    resumeState: readBulkState()!,
  });
  const parked = readBulkState();
  assert.equal(parked?.status, "paused");
  assert.equal(parked?.initiator, "resume");

  // The user presses Resume queue: that run is theirs, not a restart's.
  const hold = holdFirstFetch(emptyArchive);
  const route = await import("../../app/api/wayback/import-all/route");
  const res = await route.PATCH(
    new Request("http://localhost/api/wayback/import-all", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    })
  );
  assert.equal(res.status, 200);
  await hold.arrived;
  const { wayback } = await activeTasks();
  assert.equal(wayback.initiator, "manual");
  assert.equal(await waybackPillInitiator(), "manual");
  hold.release();

  const deadline = Date.now() + 5000;
  while (readBulkState() !== null || isBulkMutexHeld()) {
    assert.ok(Date.now() < deadline, "the resumed queue finishes");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const [summary] = getRecentActivity({ type: "wayback_import" }).filter(
    (r) => mode(r) === "bulk"
  );
  assert.match(summary?.summary ?? "", /^Wayback import across 2 apps/);
  assert.ok(auditActions().includes("wayback.import.bulk.success"));
});

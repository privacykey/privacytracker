/**
 * The boot-time resume checks leave a run their own process started alone.
 *
 * `instrumentation.ts` looks for a crash-left bulk run 8, 10 and 12 s after
 * boot. A run this same process started in that window (Settings' "Sync
 * now", or the deferred policy fetch a single app's sync schedules) has the
 * same blob and mutex as a crash-left one, and was "resumed": a second
 * runner on the same queue, and a "resumed after server restart"
 * notification with no restart. The checks here are the real closures:
 * `register()` runs with its boot timers captured, as the runners oracle
 * does, and never armed.
 *
 * Its own file because `bulk-resume.test.ts` simulates a crash with a fetch
 * that never answers: that run never settles, so its job stays live for the
 * rest of that file's process, which a real crash would not leave behind.
 */
import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import { type BulkJob, isBulkRunLive } from "../../lib/live-bulk-runs";
import { runBulkPolicySync } from "../../lib/policy-bulk-runner";
import {
  POLICY_BULK_MUTEX_KEY,
  readPolicyBulkState,
} from "../../lib/policy-bulk-state";
import { getSetting, setSetting } from "../../lib/scheduler";
import { runBulkSync } from "../../lib/sync-bulk-runner";
import {
  readSyncBulkState,
  SYNC_BULK_MUTEX_KEY,
} from "../../lib/sync-bulk-state";
import { runBulkWaybackImport } from "../../lib/wayback-bulk-runner";
import { BULK_MUTEX_KEY, readBulkState } from "../../lib/wayback-bulk-state";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const originalFetch = global.fetch;
const JOB_NAMES: BulkJob[] = ["wayback", "sync", "policy"];

/** The hold a test has not released yet, if it stopped before releasing. */
let unreleased: (() => void) | null = null;

test.beforeEach(resetTestDb);
test.afterEach(async () => {
  // A test that failed while a run was held must not leave that run live
  // for the next one. Let it finish on the stub before the real fetch is
  // back, so it never reaches the network.
  unreleased?.();
  for (const job of JOB_NAMES) {
    await settled(job);
  }
  global.fetch = originalFetch;
});

type Check = () => Promise<void>;
let checks: Promise<Map<number, Check>> | null = null;

/**
 * `register()`'s one-shot boot timers by delay, captured instead of armed.
 * Only the long timers are captured: `register()` arms nothing shorter, and
 * anything else that sets a short timer meanwhile keeps working.
 */
function bootChecks(): Promise<Map<number, Check>> {
  checks ??= (async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;
    const captured = new Map<number, Check>();
    const handle = {
      unref: () => handle,
      ref: () => handle,
      hasRef: () => false,
      refresh: () => handle,
    };
    globalThis.setTimeout = ((fn: Check, ms?: number, ...args: unknown[]) => {
      if ((ms ?? 0) >= 5000) {
        if (!captured.has(ms as number)) {
          captured.set(ms as number, fn);
        }
        return handle;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout;
    globalThis.setInterval = ((
      fn: () => void,
      ms?: number,
      ...args: unknown[]
    ) =>
      (ms ?? 0) >= 5000
        ? handle
        : realSetInterval(fn, ms, ...args)) as typeof setInterval;
    const quiet = console.log;
    console.log = () => {};
    try {
      const { register } = await import("../../instrumentation");
      await register();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.setInterval = realSetInterval;
      console.log = quiet;
    }
    return captured;
  })();
  return checks;
}

async function bootCheck(delay: number): Promise<Check> {
  const check = (await bootChecks()).get(delay);
  assert.ok(check, `register() armed a ${delay} ms check`);
  return check;
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

/**
 * Hold the run's first fetch until released, then answer it and every
 * later fetch with `reply`. Resolves `arrived` once the run is waiting on
 * that first fetch, with its blob written and its mutex held.
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
    release = () => {
      unreleased = null;
      resolve();
    };
  });
  unreleased = release;
  let first = true;
  global.fetch = (async (input: string | URL | Request) => {
    if (first) {
      first = false;
      arrive();
      await released;
    }
    return reply(urlOf(input));
  }) as typeof fetch;
  return { arrived, release };
}

function seedTwoApps(privacyPolicyUrls: boolean): void {
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

interface Job {
  blob: string;
  /** The boot check's delay in `register()`. */
  delay: number;
  job: BulkJob;
  mutex: string;
  notice: string;
  policyLinks: boolean;
  read: () => unknown;
  reply: (url: string) => Response;
  start: () => Promise<unknown>;
}

const JOBS: Job[] = [
  {
    job: "wayback",
    delay: 8000,
    blob: "wayback_bulk_state",
    mutex: BULK_MUTEX_KEY,
    notice: "__wayback_resume__",
    policyLinks: false,
    read: readBulkState,
    reply: emptyArchive,
    start: () => runBulkWaybackImport({ initiator: "manual" }),
  },
  {
    job: "sync",
    delay: 10_000,
    blob: "sync_bulk_state",
    mutex: SYNC_BULK_MUTEX_KEY,
    notice: "__sync_resume__",
    policyLinks: false,
    read: readSyncBulkState,
    reply: () => new Response("unavailable", { status: 503 }),
    start: () => runBulkSync({ initiator: "manual" }),
  },
  {
    job: "policy",
    delay: 12_000,
    blob: "policy_bulk_state",
    mutex: POLICY_BULK_MUTEX_KEY,
    notice: "__policy_resume__",
    policyLinks: true,
    read: readPolicyBulkState,
    reply: () =>
      new Response("Privacy policy text. ".repeat(200), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    // `force` so the fetch is not throttled away.
    start: () =>
      runBulkPolicySync({ initiator: "manual", phase: "fetch", force: true }),
  },
];

function activityModes(): string[] {
  return (
    db
      .prepare(
        "SELECT json_extract(detail, '$.mode') AS mode FROM activity_log ORDER BY started_at"
      )
      .all() as { mode: string | null }[]
  )
    .map((row) => row.mode)
    .filter((mode): mode is string => mode !== null);
}

function notices(appId: string): string[] {
  return (
    db
      .prepare("SELECT change_summary FROM notifications WHERE app_id = ?")
      .all(appId) as { change_summary: string }[]
  ).map((row) => row.change_summary);
}

async function settled(job: BulkJob): Promise<void> {
  for (let i = 0; i < 400 && isBulkRunLive(job); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(isBulkRunLive(job), false, `the ${job} run settled`);
}

for (const j of JOBS) {
  test(`a ${j.job} run started since boot is not resumed by its own process`, async () => {
    const check = await bootCheck(j.delay);
    seedTwoApps(j.policyLinks);
    const hold = holdFirstFetch(j.reply);
    const run = j.start();
    await hold.arrived;
    const blob = getSetting(j.blob);
    assert.ok(blob, "the run wrote its blob");
    assert.equal(getSetting(j.mutex), "true");
    assert.equal(isBulkRunLive(j.job), true);

    await check();

    assert.equal(getSetting(j.blob), blob, "the live run's blob is untouched");
    assert.equal(getSetting(j.mutex), "true", "and so is its mutex");
    assert.ok(!activityModes().includes("bulk-resume-start"), "no resume row");
    assert.deepEqual(notices(j.notice), [], "no resume notification");

    hold.release();
    await run;
    assert.equal(isBulkRunLive(j.job), false);
    assert.deepEqual(
      activityModes().filter((m) => m === "bulk" || m === "bulk-resumed"),
      ["bulk"],
      "one run, one summary row"
    );
    assert.equal(j.read(), null);
  });

  test(`a ${j.job} run a previous process left behind is still resumed`, async () => {
    const check = await bootCheck(j.delay);
    seedTwoApps(j.policyLinks);
    // What a process killed mid-app leaves behind, taken from a real run
    // that then finishes, so nothing of it is live in this process.
    const hold = holdFirstFetch(j.reply);
    const run = j.start();
    await hold.arrived;
    const left = getSetting(j.blob);
    hold.release();
    await run;
    db.prepare("DELETE FROM activity_log").run();
    setSetting(j.blob, left);
    setSetting(j.mutex, "true");
    global.fetch = (async (input: string | URL | Request) =>
      j.reply(urlOf(input))) as typeof fetch;

    await check();
    await settled(j.job);

    assert.equal(
      activityModes().filter((m) => m === "bulk-resume-start").length,
      1,
      "the check resumed it"
    );
    assert.equal(notices(j.notice).length, 1, "and said so");
    assert.ok(activityModes().includes("bulk-resumed"), "the resumed summary");
    assert.equal(j.read(), null);
    assert.notEqual(getSetting(j.mutex), "true");
  });
}

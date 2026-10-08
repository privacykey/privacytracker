import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWaybackAppTotals,
  parseWaybackRunExtras,
  pickWaybackLastRunRow,
  reduceWaybackFrame,
  startingWaybackProgress,
  type WaybackLiveProgress,
  waybackEtaMs,
  waybackLead,
  waybackRunSummary,
  waybackSurveyLine,
  waybackTally,
  waybackWaitUntil,
} from "../../lib/wayback-run-progress";

const NOW = 1_780_000_000_000;
const MINUTE = 60_000;

function run(frames: unknown[], from = startingWaybackProgress()) {
  let progress: WaybackLiveProgress | null = from;
  for (const frame of frames) {
    progress = reduceWaybackFrame(progress, frame);
  }
  return progress;
}

/** Every derivation the card makes from a run, at once. */
function derived(progress: WaybackLiveProgress | null) {
  return {
    lead: waybackLead(progress),
    survey: waybackSurveyLine(progress),
    eta: waybackEtaMs(progress, NOW),
    wait: waybackWaitUntil(progress, NOW),
    tally: waybackTally(progress),
  };
}

const NOTHING_NEW = {
  lead: null,
  survey: null,
  eta: null,
  wait: null,
  tally: { kind: "legacy" },
};

// ── The frames a run sends today (and the Node rollback keeps sending) ──

const LEGACY_FRAMES = [
  {
    type: "batch-start",
    total: 3,
    startedAt: 1,
    initiator: "manual",
    runId: "r",
  },
  { type: "app-start", appId: "1", name: "Alpha", index: 0, total: 3 },
  { type: "target", targetDate: 1, status: "imported" },
  {
    type: "app-done",
    appId: "1",
    name: "Alpha",
    index: 0,
    total: 3,
    result: { imported: 2, unchanged: 19, skipped: 3, failed: 1 },
  },
  { type: "app-start", appId: "2", name: "Bravo", index: 1, total: 3 },
  {
    type: "backoff",
    appId: "2",
    name: "Bravo",
    delayMs: 300_000,
    reason: "429",
  },
  { type: "app-start", appId: "2", name: "Bravo", index: 1, total: 3 },
  {
    type: "app-done",
    appId: "2",
    name: "Bravo",
    index: 1,
    total: 3,
    error: "boom",
  },
];

test("the frames of today's runner keep the checkpoint tally exactly", () => {
  const progress = run(LEGACY_FRAMES);
  // Only the seven keys the card has always had: nothing new to render.
  assert.deepEqual(progress, {
    index: 2,
    total: 3,
    currentAppName: "Bravo",
    imported: 2,
    unchanged: 19,
    skipped: 3,
    failed: 2,
  });
  assert.deepEqual(derived(progress), NOTHING_NEW);
});

test("frames before a run, unknown frames and junk change nothing", () => {
  assert.equal(
    reduceWaybackFrame(null, { type: "app-start", index: 0, name: "A" }),
    null
  );
  assert.equal(reduceWaybackFrame(null, { type: "app-done", index: 0 }), null);
  const progress = startingWaybackProgress();
  for (const junk of [null, 7, "x", [], { type: "nope" }, { type: "target" }]) {
    assert.equal(reduceWaybackFrame(progress, junk), progress);
  }
  // Without a run, the redesign's frames are dropped too.
  for (const frame of [
    { type: "phase", phase: "survey" },
    { type: "survey-app", index: 0, total: 2 },
    { type: "survey-done", survey: {} },
    { type: "waiting", until: NOW + MINUTE },
    { type: "estimate", estimate: { readsRemaining: 3 } },
  ]) {
    assert.equal(reduceWaybackFrame(null, frame), null);
  }
  // A phase this card does not know, or a wait with no end, is ignored.
  assert.equal(
    reduceWaybackFrame(progress, { type: "phase", phase: "x" }),
    progress
  );
  assert.equal(
    reduceWaybackFrame(progress, { type: "waiting", until: 0 }),
    progress
  );
  assert.equal(
    reduceWaybackFrame(progress, { type: "estimate", estimate: {} }),
    progress
  );
});

test("batch-start starts every count from zero", () => {
  const progress = run(LEGACY_FRAMES);
  assert.deepEqual(
    reduceWaybackFrame(progress, { type: "batch-start", total: 9 }),
    {
      ...startingWaybackProgress(),
      total: 9,
    }
  );
});

// ── The redesigned runner (docs/WAYBACK_IMPORT.md, P3) ──

const SURVEY = {
  appsSurveyed: 3,
  appsWithCaptures: 2,
  appsWithoutCaptures: 1,
  capturesTotal: 1800,
  estimatedReads: 30,
  completedAt: NOW - MINUTE,
};

const surveyFrames = [
  {
    type: "batch-start",
    total: 3,
    startedAt: 1,
    initiator: "manual",
    runId: "r",
  },
  { type: "phase", phase: "survey" },
];

test("the survey phase counts apps through the archive index", () => {
  let progress = run(surveyFrames);
  assert.deepEqual(waybackLead(progress), {
    key: "phase_survey",
    values: { current: 1, total: 3 },
  });
  progress = run(
    [
      {
        type: "survey-app",
        appId: "1",
        name: "Alpha",
        index: 0,
        total: 3,
        captureCount: 1744,
        firstCaptureMs: 1,
        lastCaptureMs: 2,
        cached: false,
      },
      {
        type: "survey-app",
        appId: "2",
        name: "Bravo",
        index: 1,
        total: 3,
        captureCount: 56,
        cached: true,
      },
    ],
    progress!
  );
  assert.deepEqual(waybackLead(progress), {
    key: "phase_survey",
    values: { current: 3, total: 3 },
  });
  assert.equal(progress?.currentAppName, "Bravo");
  assert.deepEqual(waybackTally(progress), { kind: "none" });
  // Survey results are not a run line until the survey is over.
  assert.equal(waybackSurveyLine(progress), null);
  assert.equal(waybackEtaMs(progress, NOW), null);
});

test("a wait shows until the next frame, and only while it lies ahead", () => {
  const waiting = run([
    ...surveyFrames,
    {
      type: "waiting",
      appId: "2",
      name: "Bravo",
      until: NOW + 5 * MINUTE,
      reason: "archive.org rate-limited for CDX index",
    },
  ]);
  assert.equal(waybackWaitUntil(waiting, NOW), NOW + 5 * MINUTE);
  assert.equal(waiting?.waitReason, "archive.org rate-limited for CDX index");
  assert.equal(waiting?.currentAppName, "Bravo");
  assert.equal(waybackWaitUntil(waiting, NOW + 5 * MINUTE), null);
  const resumed = reduceWaybackFrame(waiting, {
    type: "survey-app",
    appId: "2",
    name: "Bravo",
    index: 1,
    total: 3,
    captureCount: 56,
  });
  assert.equal(waybackWaitUntil(resumed, NOW), null);
});

test("a full redesigned run reads in apps and label changes", () => {
  let progress = run([
    ...surveyFrames,
    {
      type: "survey-app",
      appId: "1",
      name: "Alpha",
      index: 0,
      total: 3,
      captureCount: 1744,
    },
    {
      type: "survey-app",
      appId: "2",
      name: "Bravo",
      index: 1,
      total: 3,
      captureCount: 56,
    },
    {
      type: "survey-app",
      appId: "3",
      name: "Charlie",
      index: 2,
      total: 3,
      captureCount: 0,
    },
    {
      type: "survey-done",
      survey: SURVEY,
      estimate: {
        readsDone: 0,
        readsRemaining: 30,
        perMinute: 10,
        etaMs: 3 * MINUTE,
      },
    },
    { type: "phase", phase: "reading" },
  ]);
  assert.deepEqual(derived(progress), {
    lead: { key: "phase_reading", values: { current: 0, total: 2 } },
    survey: { key: "survey_result", values: { withPages: 2, withoutPages: 1 } },
    eta: 3 * MINUTE,
    wait: null,
    tally: { kind: "apps", changes: 0, reads: 0, appsFailed: 0 },
  });

  progress = run(
    [
      { type: "app-start", appId: "1", name: "Alpha", index: 0, total: 3 },
      {
        type: "app-done",
        appId: "1",
        name: "Alpha",
        index: 0,
        total: 3,
        result: {
          imported: 2,
          unchanged: 2,
          skipped: 0,
          failed: 0,
          reads: 12,
          changes: 3,
          labelVersions: 4,
          firstCaptureMs: 1,
          lastCaptureMs: 2,
          windows: [],
        },
      },
      {
        type: "estimate",
        estimate: {
          readsDone: 12,
          readsRemaining: 18,
          perMinute: 10,
          etaMs: 108_000,
        },
      },
      { type: "app-start", appId: "2", name: "Bravo", index: 1, total: 3 },
    ],
    progress!
  );
  assert.deepEqual(derived(progress), {
    lead: { key: "phase_reading", values: { current: 2, total: 2 } },
    survey: { key: "survey_result", values: { withPages: 2, withoutPages: 1 } },
    eta: 108_000,
    wait: null,
    tally: { kind: "apps", changes: 3, reads: 12, appsFailed: 0 },
  });

  // Throttled mid-app: the runner waits and retries the same app.
  progress = run(
    [
      {
        type: "waiting",
        appId: "2",
        name: "Bravo",
        until: NOW + 10 * MINUTE,
        reason: "429",
      },
    ],
    progress!
  );
  assert.equal(waybackWaitUntil(progress, NOW), NOW + 10 * MINUTE);
  progress = run(
    [
      { type: "app-start", appId: "2", name: "Bravo", index: 1, total: 3 },
      {
        type: "app-done",
        appId: "2",
        name: "Bravo",
        index: 1,
        total: 3,
        error: "parse",
      },
      // The app with no archived pages finishes without a read.
      { type: "app-start", appId: "3", name: "Charlie", index: 2, total: 3 },
    ],
    progress!
  );
  assert.equal(waybackWaitUntil(progress, NOW), null);
  assert.deepEqual(waybackLead(progress), {
    key: "phase_reading",
    values: { current: 2, total: 2 },
  });
  progress = run(
    [
      {
        type: "app-done",
        appId: "3",
        name: "Charlie",
        index: 2,
        total: 3,
        result: {
          imported: 0,
          unchanged: 0,
          skipped: 0,
          failed: 0,
          reads: 0,
          changes: 0,
          labelVersions: 0,
        },
      },
    ],
    progress!
  );
  assert.equal(progress?.readingDone, 2);
  assert.deepEqual(waybackTally(progress), {
    kind: "apps",
    changes: 3,
    reads: 12,
    appsFailed: 1,
  });

  // The closing frame's totals are the server's word.
  progress = reduceWaybackFrame(progress, {
    type: "summary",
    totals: {
      appsAttempted: 3,
      imported: 2,
      unchanged: 2,
      skipped: 0,
      failed: 1,
      appsDone: 2,
      appsWithHistory: 1,
      appsNoArchive: 1,
      reads: 12,
      changes: 3,
      labelVersions: 4,
    },
    durationMs: 10,
  });
  assert.deepEqual(progress?.appTotals, {
    appsDone: 2,
    appsWithHistory: 1,
    appsNoArchive: 1,
    reads: 12,
    changes: 3,
    labelVersions: 4,
  });
  // The checkpoint tally kept counting underneath, as before.
  assert.equal(progress?.imported, 2);
  assert.equal(progress?.failed, 1);
});

test("without a survey, reading progress counts the whole queue", () => {
  // A v2 blob resumed on the new runner reads with no survey.
  const progress: WaybackLiveProgress = {
    ...startingWaybackProgress(),
    total: 4,
    phase: "reading",
    readingDone: 1,
    readingInFlight: true,
  };
  assert.deepEqual(waybackLead(progress), {
    key: "phase_reading",
    values: { current: 2, total: 4 },
  });
});

test("the survey line covers no archived pages at all", () => {
  const base = { ...startingWaybackProgress(), phase: "reading" as const };
  assert.deepEqual(
    waybackSurveyLine({
      ...base,
      survey: { ...SURVEY, appsWithCaptures: 0, appsWithoutCaptures: 3 },
    }),
    { key: "survey_result_none", values: { count: 3 } }
  );
  assert.deepEqual(
    waybackSurveyLine({
      ...base,
      survey: { ...SURVEY, appsWithCaptures: 3, appsWithoutCaptures: 0 },
    }),
    { key: "survey_result", values: { withPages: 3, withoutPages: 0 } }
  );
  // A finished survey shows even before the phase flips.
  assert.notEqual(
    waybackSurveyLine({
      ...startingWaybackProgress(),
      phase: "survey",
      survey: SURVEY,
    }),
    null
  );
  assert.equal(
    waybackSurveyLine({
      ...startingWaybackProgress(),
      phase: "survey",
      survey: { ...SURVEY, completedAt: null },
    }),
    null
  );
});

test("the estimate reads a time left, a finish time, or the pace", () => {
  const reading = { ...startingWaybackProgress(), phase: "reading" as const };
  const at = (estimate: WaybackLiveProgress["estimate"]) =>
    waybackEtaMs({ ...reading, estimate }, NOW);
  assert.equal(
    at({ readsDone: 0, readsRemaining: 30, perMinute: 10, etaMs: 180_000 }),
    180_000
  );
  // An etaMs the size of an epoch timestamp is the finish time.
  assert.equal(
    at({
      readsDone: 0,
      readsRemaining: 30,
      perMinute: 10,
      etaMs: NOW + 90_000,
    }),
    90_000
  );
  assert.equal(
    at({ readsDone: 0, readsRemaining: 30, perMinute: 10, etaMs: null }),
    180_000
  );
  assert.equal(
    at({ readsDone: 30, readsRemaining: 0, perMinute: 10, etaMs: null }),
    null
  );
  assert.equal(
    at({ readsDone: 0, readsRemaining: 5, perMinute: null, etaMs: null }),
    null
  );
  assert.equal(at(null), null);
});

// ── GET /api/wayback/import-all ──

test("a payload without the redesign's keys adds nothing to render", () => {
  // Today's (and the Node rollback's) projection of the state blob.
  const extras = parseWaybackRunExtras(
    {
      runId: "r",
      startedAt: 1,
      updatedAt: 2,
      initiator: "manual",
      status: "running",
      pausedAt: null,
      pauseCause: null,
      pauseRequestedAt: null,
      cancelRequestedAt: null,
      currentAppId: "2",
      totals: {
        appsAttempted: 2,
        appsWithImports: 1,
        targetsAttempted: 48,
        imported: 2,
        unchanged: 30,
        skipped: 4,
        failed: 0,
        snapshotsRequested: 1,
      },
    },
    {
      total: 201,
      pending: 199,
      inProgress: 1,
      done: 1,
      failed: 0,
      remaining: 200,
    }
  );
  assert.equal(extras.phase, null);
  assert.equal(extras.survey, null);
  assert.equal(extras.estimate, null);
  assert.equal(extras.waitingUntil, null);
  assert.equal(extras.appTotals, null);
  const progress = {
    ...startingWaybackProgress(),
    total: 201,
    index: 2,
    ...extras,
  };
  assert.deepEqual(derived(progress), NOTHING_NEW);
  // A missing state or summary is no different.
  assert.deepEqual(
    derived({
      ...startingWaybackProgress(),
      ...parseWaybackRunExtras(null, null),
    }),
    NOTHING_NEW
  );
});

test("a v3 payload in the survey phase reports the index check", () => {
  const extras = parseWaybackRunExtras(
    {
      phase: "survey",
      survey: {
        appsSurveyed: 36,
        appsWithCaptures: 30,
        appsWithoutCaptures: 6,
      },
      waitingUntil: NOW + 4 * MINUTE,
      waitReason: "archive.org rate-limited for CDX index",
      totals: { appsDone: 0, appsNoArchive: 0, reads: 0, changes: 0 },
    },
    { total: 201, pending: 201, inProgress: 0, done: 0, failed: 0 }
  );
  const progress = { ...startingWaybackProgress(), total: 201, ...extras };
  assert.deepEqual(waybackLead(progress), {
    key: "phase_survey",
    values: { current: 37, total: 201 },
  });
  assert.equal(waybackWaitUntil(progress, NOW), NOW + 4 * MINUTE);
  assert.equal(waybackSurveyLine(progress), null);
  assert.deepEqual(waybackTally(progress), { kind: "none" });
});

test("a v3 payload while reading counts apps with archived pages", () => {
  const extras = parseWaybackRunExtras(
    {
      phase: "reading",
      survey: {
        ...SURVEY,
        appsSurveyed: 201,
        appsWithCaptures: 143,
        appsWithoutCaptures: 58,
      },
      estimate: {
        readsDone: 120,
        readsRemaining: 1100,
        perMinute: 10,
        etaMs: 6_600_000,
      },
      totals: {
        appsDone: 70,
        appsWithHistory: 11,
        appsNoArchive: 58,
        reads: 120,
        changes: 9,
        labelVersions: 20,
        failed: 0,
      },
    },
    // The 58 apps with no pages finished as done, with no reads.
    {
      total: 201,
      pending: 130,
      inProgress: 1,
      done: 70,
      failed: 0,
      remaining: 131,
    }
  );
  const progress = { ...startingWaybackProgress(), total: 201, ...extras };
  assert.deepEqual(derived(progress), {
    lead: { key: "phase_reading", values: { current: 13, total: 143 } },
    survey: {
      key: "survey_result",
      values: { withPages: 143, withoutPages: 58 },
    },
    eta: 6_600_000,
    wait: null,
    tally: { kind: "apps", changes: 9, reads: 120, appsFailed: 0 },
  });
});

test("a payload that carries the queue counts it exactly", () => {
  const extras = parseWaybackRunExtras(
    {
      phase: "reading",
      queue: [
        { appId: "1", status: "done" },
        { appId: "2", status: "failed" },
        { appId: "3", status: "in_progress" },
        { appId: "4", status: "pending" },
        { appId: "5", status: "done", noArchive: true },
        null,
      ],
    },
    { total: 5, done: 2, failed: 1, inProgress: 1 }
  );
  assert.equal(extras.readingDone, 2);
  assert.equal(extras.readingTotal, 4);
  assert.equal(extras.readingInFlight, true);
});

test("payload fields of the wrong type are ignored", () => {
  const extras = parseWaybackRunExtras(
    {
      phase: 3,
      survey: "all of them",
      estimate: [1],
      waitingUntil: "soon",
      waitReason: 5,
      totals: { appsDone: "70" },
    },
    { total: "201", failed: -2 }
  );
  assert.equal(extras.phase, null);
  assert.equal(extras.survey, null);
  assert.equal(extras.estimate, null);
  assert.equal(extras.waitingUntil, null);
  assert.equal(extras.waitReason, null);
  assert.equal(extras.appTotals, null);
  assert.equal(extras.appsFailed, 0);
  assert.equal(extras.surveyTotal, 0);
});

// ── The last run, from the activity log ──

test("the last run is the newest batch summary, resumed runs included", () => {
  const rows = [
    { id: "a", detail: { mode: "bulk-app" } },
    { id: "b", detail: { mode: "bulk-paused" } },
    { id: "c", detail: { mode: "bulk", removed: true } },
    { id: "d", detail: { mode: "bulk-resumed" } },
    { id: "e", detail: { mode: "bulk" } },
  ];
  assert.equal(pickWaybackLastRunRow(rows)?.id, "d");
  assert.equal(pickWaybackLastRunRow(rows.slice(4))?.id, "e");
  assert.equal(pickWaybackLastRunRow([{ detail: null }, {}]), null);
});

test("a run's totals summarise in apps only when they carry app counts", () => {
  assert.deepEqual(
    waybackRunSummary({ appsAttempted: 3, imported: 2, failed: 0 }),
    { kind: "legacy" }
  );
  assert.deepEqual(waybackRunSummary(null), { kind: "legacy" });
  assert.deepEqual(
    waybackRunSummary({ appsDone: 201, appsNoArchive: 58, changes: 37 }),
    { kind: "apps", appsDone: 201, appsNoArchive: 58, changes: 37 }
  );
  assert.deepEqual(parseWaybackAppTotals({ changes: 4 }), {
    appsDone: 0,
    appsWithHistory: 0,
    appsNoArchive: 0,
    reads: 0,
    changes: 4,
    labelVersions: 0,
  });
});

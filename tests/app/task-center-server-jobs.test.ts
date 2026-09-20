import assert from "node:assert/strict";
import test from "node:test";
import {
  finishedCardSubtitleKey,
  serverJobCardReason,
  serverJobCardStep,
} from "../../lib/task-center-server-jobs";

// TaskCenter's SERVER_JOB_HREF.policy, which is also the href SettingsView's
// runBulkPolicySync gives the task it starts.
const POLICY_HREF = "/dashboard/settings/policies#privacy-policies-bulk";

/** One poll's decision, by default for a manual privacy-policy batch. */
function reasonFor(
  overrides: Partial<Parameters<typeof serverJobCardReason>[0]> = {}
) {
  return serverJobCardReason({
    jobKey: "policy",
    initiator: "manual",
    href: POLICY_HREF,
    cardId: undefined,
    tasks: [],
    resumeCardsEnabled: true,
    ...overrides,
  });
}

const card = {
  id: "task-card",
  status: "running" as const,
  href: POLICY_HREF,
};
const settingsTask = {
  id: "task-settings",
  status: "running" as const,
  href: POLICY_HREF,
};

test("a manual policy batch no task shows gets a background card", () => {
  assert.equal(reasonFor(), "background");
});

test("TaskCenter's own card does not count as a task that shows the batch", () => {
  // The card minted on the first poll is running at the same href.
  // Counting it made every later poll skip the batch, so the card's
  // progress and current app stopped moving.
  assert.equal(reasonFor({ cardId: card.id, tasks: [card] }), "background");
});

test("the Settings task that started the batch still stops a second card", () => {
  assert.equal(reasonFor({ tasks: [settingsTask] }), null);
  assert.equal(
    reasonFor({ cardId: card.id, tasks: [card, settingsTask] }),
    null
  );
});

test("a Settings task that has ended no longer shows the batch", () => {
  // Cancel stops the page reading the stream, not the run on the server.
  for (const status of ["done", "error", "cancelled"] as const) {
    assert.equal(
      reasonFor({ tasks: [{ ...settingsTask, status }] }),
      "background",
      status
    );
  }
});

test("a running task somewhere else does not show the batch", () => {
  const perAppPolicyRun = {
    id: "task-app",
    status: "running" as const,
    href: "/apps/910001",
  };
  assert.equal(reasonFor({ tasks: [perAppPolicyRun] }), "background");
});

test("a run resumed after a restart gets a resumed card whatever is running", () => {
  for (const jobKey of ["wayback", "sync", "policy"] as const) {
    assert.equal(
      reasonFor({ jobKey, initiator: "resume", tasks: [settingsTask] }),
      "resumed",
      jobKey
    );
  }
});

test("resume cards turned off hide a resumed run", () => {
  assert.equal(
    reasonFor({ initiator: "resume", resumeCardsEnabled: false }),
    null
  );
});

test("other runs are left to the page that started them", () => {
  for (const jobKey of ["wayback", "sync"] as const) {
    assert.equal(reasonFor({ jobKey }), null, jobKey);
  }
  for (const initiator of ["scheduled", "automatic", null] as const) {
    assert.equal(reasonFor({ initiator }), null, String(initiator));
  }
});

/** One poll's whole step, by default for a manual privacy-policy batch. */
function stepFor(
  overrides: Partial<Parameters<typeof serverJobCardStep>[0]> = {}
) {
  return serverJobCardStep({
    jobKey: "policy",
    job: { initiator: "manual", running: true, runId: "run-1" },
    href: POLICY_HREF,
    card: undefined,
    tasks: [],
    resumeCardsEnabled: true,
    ...overrides,
  });
}

const cardForRun1 = { id: card.id, runId: "run-1" };

test("a card whose run is still going is left alone", () => {
  assert.deepEqual(stepFor({ card: cardForRun1, tasks: [card] }), {
    close: false,
    reason: "background",
  });
});

test("a job that has stopped closes its card", () => {
  for (const job of [
    { initiator: "manual" as const, running: false, runId: null },
    { initiator: "manual" as const, running: false, runId: "run-1" },
    { initiator: "manual" as const, running: true, runId: null },
  ]) {
    assert.deepEqual(
      stepFor({ card: cardForRun1, job, tasks: [card] }),
      { close: true, reason: null },
      JSON.stringify(job)
    );
  }
});

test("a new runId closes the card even when its run gets no card", () => {
  // One run ends and another begins inside a single 4 s poll window. The
  // close-out used to sit behind the decision about whether the new run
  // gets a card, so a replacement run TaskCenter does not surface left the
  // old card up and "running" on progress that had stopped moving, until
  // that run ended as well.
  const unsurfaced = [
    // A batch started from Settings, whose own task shows it.
    {
      job: { initiator: "manual" as const, running: true, runId: "run-2" },
      tasks: [card, settingsTask],
    },
    // An automatic policy fetch, retried every 5 minutes.
    {
      job: { initiator: "automatic" as const, running: true, runId: "run-2" },
      tasks: [card],
    },
    // A scheduled run of one of the other two jobs.
    {
      jobKey: "sync" as const,
      job: { initiator: "scheduled" as const, running: true, runId: "run-2" },
      tasks: [card],
    },
  ];
  for (const overrides of unsurfaced) {
    assert.deepEqual(
      stepFor({ card: cardForRun1, ...overrides }),
      { close: true, reason: null },
      JSON.stringify(overrides.job)
    );
  }
});

test("a new run that does get a card closes the old one and opens a new one", () => {
  // The card being closed is still running at the job's href on this poll:
  // `complete()` only reaches the task list on the next render. It must not
  // be read as a task that already shows the new run, or the batch would
  // get no card at all.
  assert.deepEqual(
    stepFor({
      card: cardForRun1,
      job: { initiator: "manual", running: true, runId: "run-2" },
      tasks: [card],
    }),
    { close: true, reason: "background" }
  );
  // Same poll with the card forgotten: now it does read as that task.
  assert.deepEqual(
    stepFor({
      job: { initiator: "manual", running: true, runId: "run-2" },
      tasks: [card],
    }),
    { close: false, reason: null }
  );
});

test("no card and nothing running is a no-op", () => {
  assert.deepEqual(
    stepFor({ job: { initiator: null, running: false, runId: null } }),
    { close: false, reason: null }
  );
});

test("only a background card needs a new subtitle when it finishes", () => {
  // "Running in the background" is a claim about right now; "Resumed after
  // restart" is how the run started and stays true.
  assert.equal(
    finishedCardSubtitleKey("background"),
    "subtitle_background_finished"
  );
  assert.equal(finishedCardSubtitleKey("resumed"), null);
});

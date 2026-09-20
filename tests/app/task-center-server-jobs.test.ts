import assert from "node:assert/strict";
import test from "node:test";
import { serverJobCardReason } from "../../lib/task-center-server-jobs";

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

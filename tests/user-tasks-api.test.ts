/**
 * DB-touching tests for `lib/tasks-server.ts`. Exercises the JSON blob
 * round-trip (start/dismiss/reset/clearAll), the corruption-tolerant
 * read path, and the completion-context builder against a fresh
 * per-test SQLite file (PRIVACYTRACKER_DATA_DIR is set in setup-env.ts).
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import db from "../lib/db";
import { savePrivacyProfile } from "../lib/privacy-profile-server";
import { setSetting } from "../lib/scheduler";
import {
  buildTaskCompletionContext,
  clearAllTasks,
  dismissTask,
  getUserTasksState,
  optInTask,
  resetTask,
  resolveAllTasks,
  resolveOptInCandidates,
  setUserTasksState,
  startTask,
} from "../lib/tasks-server";

// Each test starts from a clean blob — the per-test DB is shared across
// tests in this file (one SQLite file per process), so we manually wipe
// the keys we touch to avoid cross-test bleed.
function resetState() {
  setSetting("user_tasks_state", "");
  setSetting("task_visit.privacy_map_at", "");
  setSetting("task_visit.app_detail_at", "");
  setSetting("task_visit.compare_at", "");
  setSetting("background_wizard_completed_at", "");
  setSetting("sync_schedule", "");
  setSetting("device_resync.last_committed_at", "");
  savePrivacyProfile(null);
  try {
    db.exec("DELETE FROM app_devices");
  } catch {
    /* missing */
  }
  try {
    db.exec("DELETE FROM devices");
  } catch {
    /* missing */
  }
}

afterEach(() => resetState());

test("getUserTasksState returns the empty blob on a fresh DB", () => {
  resetState();
  const blob = getUserTasksState();
  assert.equal(blob.version, 1);
  assert.deepEqual(blob.tasks, {});
});

test("setUserTasksState round-trips through the JSON blob", () => {
  resetState();
  setUserTasksState({
    version: 1,
    tasks: {
      view_privacy_map: { started_at: 100 },
      compare_two_apps: { dismissed_at: 200 },
    },
  });
  const blob = getUserTasksState();
  assert.equal(blob.tasks.view_privacy_map?.started_at, 100);
  assert.equal(blob.tasks.compare_two_apps?.dismissed_at, 200);
});

test("startTask stamps started_at; dismissTask stamps dismissed_at; resetTask clears", () => {
  resetState();
  startTask("view_privacy_map");
  let blob = getUserTasksState();
  assert.ok(blob.tasks.view_privacy_map?.started_at);

  dismissTask("view_privacy_map");
  blob = getUserTasksState();
  assert.ok(blob.tasks.view_privacy_map?.dismissed_at);

  resetTask("view_privacy_map");
  blob = getUserTasksState();
  assert.equal(blob.tasks.view_privacy_map, undefined);
});

test("clearAllTasks wipes the entire blob", () => {
  resetState();
  startTask("view_privacy_map");
  startTask("compare_two_apps");
  clearAllTasks();
  const blob = getUserTasksState();
  assert.deepEqual(blob.tasks, {});
});

test("getUserTasksState tolerates malformed JSON — returns empty blob, never throws", () => {
  resetState();
  // Direct write to bypass the structured setter.
  setSetting("user_tasks_state", "{not valid json");
  const blob = getUserTasksState();
  assert.equal(blob.version, 1);
  assert.deepEqual(blob.tasks, {});
});

test("getUserTasksState tolerates wrong-shaped JSON", () => {
  resetState();
  setSetting(
    "user_tasks_state",
    JSON.stringify({ version: 2, tasks: "not an object" })
  );
  const blob = getUserTasksState();
  assert.equal(blob.version, 1);
  assert.deepEqual(blob.tasks, {});
});

test("getUserTasksState filters out unknown task ids", () => {
  resetState();
  setSetting(
    "user_tasks_state",
    JSON.stringify({
      version: 1,
      tasks: {
        view_privacy_map: { started_at: 100 },
        bogus_id_from_future_version: { started_at: 200 },
      },
    })
  );
  const blob = getUserTasksState();
  assert.ok(blob.tasks.view_privacy_map);
  assert.equal(
    (blob.tasks as Record<string, unknown>).bogus_id_from_future_version,
    undefined
  );
});

test("getUserTasksState filters out non-numeric timestamps", () => {
  resetState();
  setSetting(
    "user_tasks_state",
    JSON.stringify({
      version: 1,
      tasks: {
        view_privacy_map: { started_at: "now please", dismissed_at: 200 },
      },
    })
  );
  const blob = getUserTasksState();
  // started_at gets dropped (non-numeric); dismissed_at survives.
  assert.equal(blob.tasks.view_privacy_map?.started_at, undefined);
  assert.equal(blob.tasks.view_privacy_map?.dismissed_at, 200);
});

test("buildTaskCompletionContext reads underlying settings + DB state", () => {
  resetState();
  // No profile, no visits → all signals are null/false/0.
  let ctx = buildTaskCompletionContext();
  assert.equal(ctx.hasPrivacyProfile, false);
  assert.equal(ctx.privacyMapVisitedAt, null);
  assert.equal(ctx.anyAppDetailVisitedAt, null);
  assert.equal(ctx.compareVisitedAt, null);
  assert.equal(ctx.backgroundWizardCompletedAt, null);
  assert.equal(ctx.verdictCount, 0);

  // Stamp two visit markers — completion context should pick them up.
  setSetting("task_visit.privacy_map_at", "12345");
  setSetting("task_visit.compare_at", "67890");
  ctx = buildTaskCompletionContext();
  assert.equal(ctx.privacyMapVisitedAt, 12_345);
  assert.equal(ctx.compareVisitedAt, 67_890);
});

test("resolveAllTasks reflects start + completion state", () => {
  resetState();
  // Default focus: self + understand (silent default). No prereqs are
  // met yet, so the typical tasks render as 'ready'.
  let resolved = resolveAllTasks(undefined, false);
  const viewMap = resolved.find((r) => r.id === "view_privacy_map");
  assert.equal(viewMap?.state, "ready");

  // Start the privacy map task — should flip to in_progress.
  startTask("view_privacy_map");
  resolved = resolveAllTasks(undefined, false);
  assert.equal(
    resolved.find((r) => r.id === "view_privacy_map")?.state,
    "in_progress"
  );

  // Stamp the visit marker — completionCheck takes over from started_at.
  setSetting("task_visit.privacy_map_at", String(Date.now()));
  resolved = resolveAllTasks(undefined, false);
  assert.equal(
    resolved.find((r) => r.id === "view_privacy_map")?.state,
    "completed"
  );
});

test("optInTask surfaces an opt-in task in resolveAllTasks", () => {
  resetState();
  // Pre-opt-in: setup_background_mode is hidden, candidate visible.
  assert.equal(
    resolveAllTasks(undefined, false).some(
      (r) => r.id === "setup_background_mode"
    ),
    false
  );
  assert.ok(
    resolveOptInCandidates(undefined, false).some(
      (c) => c.id === "setup_background_mode"
    )
  );

  optInTask("setup_background_mode");

  assert.ok(
    resolveAllTasks(undefined, false).some(
      (r) => r.id === "setup_background_mode"
    )
  );
  // Once opted in, the chip drops off the candidate list.
  assert.equal(
    resolveOptInCandidates(undefined, false).some(
      (c) => c.id === "setup_background_mode"
    ),
    false
  );
});

test("optInTask is a no-op for non-optIn tasks", () => {
  resetState();
  // view_privacy_map is auto-included, not opt-in. optInTask should not
  // write an opted_in_at marker for it.
  optInTask("view_privacy_map");
  const blob = getUserTasksState();
  assert.equal(blob.tasks.view_privacy_map?.opted_in_at, undefined);
});

test("setup_background_mode completion: non-manual sync_schedule satisfies it", () => {
  resetState();
  optInTask("setup_background_mode");
  setSetting("sync_schedule", "weekly");
  const r = resolveAllTasks(undefined, false);
  assert.equal(
    r.find((t) => t.id === "setup_background_mode")!.state,
    "completed"
  );
});

test("remove_apps_from_phone completion reads uninstallVerdictCount from DB", () => {
  resetState();
  // Set a real profile (use a valid uppercase category key so the
  // sanitiser keeps it) so hasPrivacyProfile flips on.
  savePrivacyProfile({ CONTACT_INFO: "tracking" });
  optInTask("remove_apps_from_phone");
  const r = resolveAllTasks(undefined, false);
  assert.equal(
    r.find((t) => t.id === "remove_apps_from_phone")!.state,
    "ready"
  );

  // Verify the context reads uninstallVerdictCount = 0 when there are no
  // verdict rows. The actual transition to 'completed' would need a
  // foreign-keyed app + verdict insert; we already cover that path in
  // the pure tests.
  const ctx = buildTaskCompletionContext();
  assert.equal(ctx.uninstallVerdictCount, 0);
});

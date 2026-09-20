/**
 * TaskCenter's rule for the server bulk jobs it polls from
 * `GET /api/tasks/active` (Wayback import, App Store sync, privacy-policy
 * sync).
 *
 * A running job gets a card of TaskCenter's own for one of two reasons:
 * the server resumed it after a restart, or it is a manual privacy-policy
 * batch that no task in this tab shows (after a reload, in a second tab,
 * after Cancel detached the Settings task, or a batch started through the
 * API). Any other manual run is shown by the page that started it.
 *
 * Kept free of React so the node suite can pin it: that suite runs under
 * `--conditions=react-server`, where TaskCenter itself cannot be imported.
 */

export type ServerJobKey = "wayback" | "sync" | "policy";

export type ServerJobInitiator =
  | "manual"
  | "scheduled"
  | "automatic"
  | "resume"
  | null;

/** Why a job gets a card. It also picks the card's subtitle. */
export type ServerJobCardReason = "resumed" | "background";

/** The fields of a TaskCenter task this rule reads. */
interface TaskView {
  href?: string;
  id: string;
  status: "running" | "done" | "error" | "cancelled";
}

export function serverJobCardReason(input: {
  /** The card TaskCenter already shows for this job, if it has one. */
  cardId: string | undefined;
  /** Where the job's card links to (TaskCenter's `SERVER_JOB_HREF`). */
  href: string;
  initiator: ServerJobInitiator;
  jobKey: ServerJobKey;
  /** `flag.taskcenter.resume_cards`. */
  resumeCardsEnabled: boolean;
  tasks: readonly TaskView[];
}): ServerJobCardReason | null {
  if (input.initiator === "resume") {
    return input.resumeCardsEnabled ? "resumed" : null;
  }
  if (input.jobKey !== "policy" || input.initiator !== "manual") {
    return null;
  }
  // A running task at the job's href is the one SettingsView's
  // runBulkPolicySync started, which already shows the batch. TaskCenter's
  // own card links to the same href, so it is left out: counting it made
  // every poll after the first skip the batch, and the card stopped
  // updating.
  const shownByAnotherTask = input.tasks.some(
    (task) =>
      task.id !== input.cardId &&
      task.status === "running" &&
      task.href === input.href
  );
  return shownByAnotherTask ? null : "background";
}

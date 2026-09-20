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
 * `serverJobCardStep` wraps that rule with the other half of a poll: the
 * card that is already up is closed the moment its run ends, whether or
 * not the run that replaces it is one TaskCenter shows.
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

/** The fields of `GET /api/tasks/active`'s per-job view this rule reads. */
interface ServerJobView {
  initiator: ServerJobInitiator;
  runId: string | null;
  running: boolean;
}

/** What one poll does with the card TaskCenter shows for a server job. */
export interface ServerJobCardStep {
  /** Close the card TaskCenter already shows: the run behind it is over. */
  close: boolean;
  /** Why the run now in flight gets a card, or null when it gets none. */
  reason: ServerJobCardReason | null;
}

/**
 * One poll's whole decision for one job: close the card that is up, and
 * give the run now in flight a card or not.
 *
 * Closing comes first, and deliberately does NOT depend on whether the new
 * run is one TaskCenter surfaces. A run it leaves to the page that started
 * it (a batch Settings owns) or ignores entirely (an automatic policy
 * fetch) that begins in the same 4 s window the previous run ended in used
 * to skip the close, leaving the old card up and "running" on progress
 * that had stopped moving until the new run ended as well.
 */
export function serverJobCardStep(input: {
  /** The card TaskCenter already shows for this job, if it has one. */
  card: { id: string; runId: string } | undefined;
  /** Where the job's card links to (TaskCenter's `SERVER_JOB_HREF`). */
  href: string;
  job: ServerJobView;
  jobKey: ServerJobKey;
  /** `flag.taskcenter.resume_cards`. */
  resumeCardsEnabled: boolean;
  tasks: readonly TaskView[];
}): ServerJobCardStep {
  const runId = input.job.running ? input.job.runId : null;
  const close = input.card !== undefined && input.card.runId !== runId;
  if (!(input.job.running && input.job.runId)) {
    return { close, reason: null };
  }
  return {
    close,
    // The closing card is still one of `tasks` for a render after its
    // `complete()`, so it goes in as `cardId` either way and is not
    // mistaken for a task that already shows the new run.
    reason: serverJobCardReason({
      cardId: input.card?.id,
      href: input.href,
      initiator: input.job.initiator,
      jobKey: input.jobKey,
      resumeCardsEnabled: input.resumeCardsEnabled,
      tasks: input.tasks,
    }),
  };
}

/**
 * The subtitle key a finished card takes, or null to keep the one it has.
 *
 * "Running in the background" is a claim about right now, so it reads wrong
 * under a tick in Recently finished and has to be replaced. "Resumed after
 * restart" says how the run started and stays true once it ends.
 */
export function finishedCardSubtitleKey(
  reason: ServerJobCardReason
): "subtitle_background_finished" | null {
  return reason === "background" ? "subtitle_background_finished" : null;
}

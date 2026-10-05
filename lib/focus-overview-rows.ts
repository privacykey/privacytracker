import type { FocusOverviewApp } from "./focus-review";

/**
 * Row selection for the dashboard overview card (`FocusOverview`).
 *
 * The server hands the card a bounded preview of apps, ordered by what
 * needs a decision first. Rendering all of it made the status block run
 * to two phone screens and listed every changed app twice, because the
 * "Changes to review" section below carries the same apps with more
 * detail. The card now splits the preview in two:
 *
 *   - `primary` is always visible: every decision still in progress, then
 *     enough untouched apps to give a new user somewhere to start.
 *   - `changed` holds the apps whose only state is "has unreviewed
 *     changes". They sit behind an expand control in the card.
 *
 * Pure and client-safe: the import above is type-only, so nothing here
 * pulls the SQLite-backed `focus-review` module into the browser bundle.
 */

/** Rows shown before any decision exists, so the card is never just numbers. */
export const OVERVIEW_STARTER_ROWS = 3;

export interface OverviewRows {
  /** Apps with unreviewed changes and no decision yet. Collapsed by default. */
  changed: FocusOverviewApp[];
  /** Always-visible rows. */
  primary: FocusOverviewApp[];
}

/** A decision the user still has to act on or come back to. */
function inProgress(app: FocusOverviewApp): boolean {
  return (
    app.decision === "due" ||
    app.decision === "replace" ||
    app.decision === "uninstall" ||
    app.decision === "later"
  );
}

export function splitOverviewRows(
  apps: readonly FocusOverviewApp[],
  starterRows: number = OVERVIEW_STARTER_ROWS
): OverviewRows {
  const decided: FocusOverviewApp[] = [];
  const changed: FocusOverviewApp[] = [];
  const rest: FocusOverviewApp[] = [];
  for (const app of apps) {
    if (inProgress(app)) {
      decided.push(app);
    } else if (app.decision === "review" && app.changeCount > 0) {
      changed.push(app);
    } else {
      rest.push(app);
    }
  }
  // A decision in progress is never dropped; only the starter rows are
  // capped, and they give way as decisions take their place.
  const starters = rest.slice(0, Math.max(0, starterRows - decided.length));
  return { primary: [...decided, ...starters], changed };
}

/**
 * Changed apps the preview could not carry. The server caps the preview,
 * so on a large backlog the expanded list is still a slice; the card says
 * how many are missing instead of implying the list is complete.
 */
export function changedBeyondPreview(
  apps: readonly FocusOverviewApp[],
  pendingChanges: number
): number {
  const carried = apps.filter((app) => app.changeCount > 0).length;
  return Math.max(0, pendingChanges - carried);
}

"use client";

import type { ResolvedTask, UserTaskId } from "../../lib/tasks";
import { Icon, type IconName } from "./icons/Icon";

/**
 * Inline skeuomorphic thumbnails for task-list rows — the dashboard cousin
 * of the privacy-label vignettes (`app/components/vignettes/*`). Each one is
 * a small tactile diorama that *shows* the action instead of a flat `○`
 * glyph, sized for the 28px glyph column in `task-list.css`.
 *
 * Contract (matches the vignette engine so the two stay visually coherent):
 *   - The SVG is `aria-hidden`; the row title carries the meaning, exactly
 *     like the flat glyph it replaces. Screen readers skip the motion.
 *   - Motion lives entirely in CSS (`task-list.css`). Every diorama's BASE
 *     (unanimated) frame is its finished "punchline", so the global
 *     `prefers-reduced-motion` collapse rule snaps straight to the meaningful
 *     scene without ever animating. Only transform/opacity animate
 *     (compositor-only), mirroring `.task-journey-node.is-current::after`.
 *   - At rest the diorama is still; the entrance replays on row
 *     `:hover` / `:focus-visible`, and the first actionable diorama row gets
 *     a slow `halo-breathe` ring (`is-recommended`) as the single "start
 *     here" cue.
 *
 * Adding a diorama for another task: add its id to `DIORAMA_TASK_IDS`, add an
 * entry to `DIORAMA_SVG`, and add the `.td-<id>` motion rules in
 * `task-list.css`. Rows without an entry fall back to the flat glyph.
 */

/** Task ids that ship a bespoke inline diorama. Everything else keeps the
 *  flat status glyph in `TaskListInteractive`. Grow this set one diorama at
 *  a time — see `app/components/task-list.css`. */
export const DIORAMA_TASK_IDS = new Set<UserTaskId>([
  "create_privacy_profile",
  "view_privacy_map",
  "review_mismatches",
  "compare_two_apps",
  "open_any_app_detail",
]);

/** Settled rows keep a plain status glyph — a diorama implies "do this",
 *  which is wrong once the task is done or explicitly dismissed. */
const DONE_GLYPH: Partial<Record<ResolvedTask["state"], string>> = {
  completed: "✓",
  dismissed: "–",
};

interface Props {
  id: UserTaskId;
  /** True for the first actionable diorama row — gets the at-rest breathing
   *  ring as the single "start here" cue. */
  recommended: boolean;
  state: ResolvedTask["state"];
}

/** One line icon per check-up step, from the shared set. */
const DIORAMA_ICON: Partial<Record<UserTaskId, IconName>> = {
  create_privacy_profile: "shield-check",
  view_privacy_map: "map-pin",
  review_mismatches: "alert-triangle",
  compare_two_apps: "scale",
  open_any_app_detail: "search",
};

export default function TaskDiorama({ id, state, recommended }: Props) {
  if (state === "completed" || state === "dismissed") {
    return (
      <span aria-hidden="true" className="task-list-row-glyph">
        {DONE_GLYPH[state]}
      </span>
    );
  }

  const icon = DIORAMA_ICON[id];
  if (!icon) {
    // Defensive: id is in DIORAMA_TASK_IDS but has no icon yet. Fall back
    // to the neutral "ready" glyph rather than rendering an empty box.
    return (
      <span aria-hidden="true" className="task-list-row-glyph">
        ○
      </span>
    );
  }

  // The step used to be a 56-unit animated scene drawn at 28 to 40px,
  // which read as a broken sprite at that size. One icon from the set in
  // a tinted tile says the same thing and matches the rest of the chrome.
  return (
    <span
      aria-hidden="true"
      className={`task-diorama td-${id}${recommended ? " is-recommended" : ""}`}
    >
      <Icon name={icon} size={22} />
    </span>
  );
}

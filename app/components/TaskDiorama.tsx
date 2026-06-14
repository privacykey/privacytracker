"use client";

import type { ReactNode } from "react";
import type { ResolvedTask, UserTaskId } from "../../lib/tasks";

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

export default function TaskDiorama({ id, state, recommended }: Props) {
  if (state === "completed" || state === "dismissed") {
    return (
      <span aria-hidden="true" className="task-list-row-glyph">
        {DONE_GLYPH[state]}
      </span>
    );
  }

  const draw = DIORAMA_SVG[id];
  if (!draw) {
    // Defensive: id is in DIORAMA_TASK_IDS but has no SVG yet. Fall back to
    // the neutral "ready" glyph rather than rendering an empty box.
    return (
      <span aria-hidden="true" className="task-list-row-glyph">
        ○
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`task-diorama td-${id}${recommended ? " is-recommended" : ""}`}
    >
      {draw()}
    </span>
  );
}

/**
 * One drawing function per diorama id. SVG is authored in a 56×56 viewBox
 * (rendered at 28px) so coordinates have room to breathe; strokes ~2 units
 * land near 1px on screen. Colours are driven by CSS classes in
 * `task-list.css` so the scene tracks the active light/dark theme.
 */
const DIORAMA_SVG: Partial<Record<UserTaskId, () => ReactNode>> = {
  // "Set your comfort line" — a slider thumb springs to its set point and a
  // verdict check thumps down to confirm it. Reuses the vignettes'
  // spring-overshoot + stamp-thump vocabulary (`v-dt-chip-in`,
  // `v-dh-stamp-in`).
  create_privacy_profile: () => (
    <svg aria-hidden="true" className="td-svg" viewBox="0 0 56 56">
      <rect className="td-track" height="6" rx="3" width="40" x="8" y="23" />
      <line className="td-tick" x1="16" x2="16" y1="19.5" y2="22.5" />
      <line className="td-tick" x1="28" x2="28" y1="19.5" y2="22.5" />
      <line className="td-tick" x1="40" x2="40" y1="19.5" y2="22.5" />
      <circle className="td-thumb" cx="34" cy="26" r="6" />
      <g className="td-stamp">
        <circle className="td-stamp-ring" cx="41" cy="40" r="9" />
        <path className="td-stamp-check" d="M36.4 40 l3.1 3.1 l6 -6.6" />
      </g>
    </svg>
  ),

  // "See what your apps collect" — privacy data types (a person, a heart, an
  // envelope) pulse their data into the app, which then transmits a packet on
  // to a server that lights up. A two-stage collect→send flow; pulse-travel +
  // fade-pop vocabulary (`v-dt-pulse-travel`, `v-fade-pop`).
  view_privacy_map: () => (
    <svg aria-hidden="true" className="td-svg" viewBox="0 0 56 56">
      <path className="td-thread" d="M12 11 C16 14,17 20,20 24" />
      <path className="td-thread" d="M12 28 L20 27" />
      <path className="td-thread" d="M12 44 C16 41,17 33,20 31" />
      <path className="td-thread" d="M34 27 L40 27" />
      <rect
        className="td-server-body"
        height="27"
        rx="2.5"
        width="13"
        x="40"
        y="13"
      />
      <line className="td-server-slot" x1="40.5" x2="52.5" y1="22" y2="22" />
      <line className="td-server-slot" x1="40.5" x2="52.5" y1="31" y2="31" />
      <circle className="td-server-dot" cx="43.5" cy="17.5" r="1" />
      <circle className="td-server-dot" cx="43.5" cy="26.5" r="1" />
      <circle className="td-server-light" cx="43.5" cy="35.5" r="2.1" />
      <g className="td-src">
        <path
          className="td-pin"
          d="M8 2.5 C5 2.5 2.8 4.8 2.8 7.7 C2.8 11.3 8 15.5 8 15.5 C8 15.5 13.2 11.3 13.2 7.7 C13.2 4.8 11 2.5 8 2.5 Z M5.9 7.5 A2.1 2.1 0 1 1 10.1 7.5 A2.1 2.1 0 1 1 5.9 7.5 Z"
          fillRule="evenodd"
        />
      </g>
      <g className="td-src">
        <path
          className="td-src-heart"
          d="M8 31 C6.6 29.4,4.3 28.3,4.3 26.4 C4.3 25.2,5.2 24.4,6.3 24.4 C7.1 24.4,7.7 24.9,8 25.4 C8.3 24.9,8.9 24.4,9.7 24.4 C10.8 24.4,11.7 25.2,11.7 26.4 C11.7 28.3,9.4 29.4,8 31 Z"
        />
      </g>
      <g className="td-src">
        <rect
          className="td-src-mail"
          height="6"
          rx="1"
          width="8"
          x="4"
          y="42"
        />
        <path className="td-mail-flap" d="M4 42.6 L8 45.4 L12 42.6" />
      </g>
      <g className="td-hub">
        <rect
          className="td-hub-body"
          height="14"
          rx="3.5"
          width="14"
          x="20"
          y="20"
        />
        <rect
          className="td-hub-inner"
          height="6"
          rx="1.8"
          width="6"
          x="24"
          y="24"
        />
      </g>
      <circle className="td-packet td-collect td-c1" cx="11" cy="11" r="2" />
      <circle className="td-packet td-collect td-c2" cx="12" cy="28" r="2" />
      <circle className="td-packet td-collect td-c3" cx="12" cy="44" r="2" />
      <circle className="td-packet td-out" cx="34" cy="27" r="2" />
    </svg>
  ),

  // "Deal with apps that cross your line" — a swipe-to-decide gesture: the
  // app card swipes toward a verdict (keep ✓ left / remove ✕ right) and the
  // side it lands on illuminates from grey to colour. See `.td-rv-*` in
  // task-list.css. Reuses the vignettes' pulse-travel / fade vocabulary.
  review_mismatches: () => (
    <svg aria-hidden="true" className="td-svg" viewBox="0 0 56 56">
      <g className="td-rv-card">
        <rect
          className="td-rv-cardbg"
          height="22"
          rx="3"
          width="16"
          x="20"
          y="17"
        />
        <rect
          className="td-rv-appicon"
          height="5"
          rx="1.2"
          width="5"
          x="23"
          y="20"
        />
        <rect
          className="td-rv-line"
          height="1.6"
          rx="0.8"
          width="4"
          x="29.5"
          y="21"
        />
        <rect
          className="td-rv-line"
          height="1.6"
          rx="0.8"
          width="9"
          x="23"
          y="28"
        />
        <rect
          className="td-rv-line"
          height="1.6"
          rx="0.8"
          width="6"
          x="23"
          y="31.5"
        />
      </g>
      <g className="td-rv-keep">
        <circle className="td-rv-badge-base" cx="9" cy="28" r="6" />
        <path className="td-rv-glyph" d="M5.8 28 l2 2 l4 -4.4" />
      </g>
      <g className="td-rv-remove">
        <circle className="td-rv-badge-base" cx="47" cy="28" r="6" />
        <circle className="td-rv-lit" cx="47" cy="28" r="6" />
        <path
          className="td-rv-glyph"
          d="M44.5 25.5 L49.5 30.5 M49.5 25.5 L44.5 30.5"
        />
      </g>
    </svg>
  ),

  // "Compare two apps side by side" — two app cards weigh in on a balance
  // beam over a fulcrum, and it tips toward the lighter (collects-less) app,
  // which lights up green as the winner. The beam pivots about the fulcrum
  // (transform-box: view-box); the winner outline is an opacity fade
  // (compositor-only). See `.td-cmp-*` in task-list.css.
  compare_two_apps: () => (
    <svg aria-hidden="true" className="td-svg" viewBox="0 0 56 56">
      <path className="td-cmp-fulcrum" d="M28 32 L32.5 41 L23.5 41 Z" />
      <g className="td-cmp-beam">
        <rect
          className="td-cmp-bar"
          height="3"
          rx="1.5"
          width="44"
          x="6"
          y="30.5"
        />
        <g>
          <rect
            className="td-cmp-cardbg"
            height="11"
            rx="2"
            width="12"
            x="9"
            y="19"
          />
          <rect
            className="td-cmp-line"
            height="1.6"
            rx="0.8"
            width="8"
            x="11"
            y="22"
          />
          <rect
            className="td-cmp-line"
            height="1.6"
            rx="0.8"
            width="5"
            x="11"
            y="25.5"
          />
        </g>
        <g>
          <rect
            className="td-cmp-cardbg"
            height="11"
            rx="2"
            width="12"
            x="35"
            y="19"
          />
          <rect
            className="td-cmp-line"
            height="1.6"
            rx="0.8"
            width="8"
            x="37"
            y="22"
          />
          <rect
            className="td-cmp-line"
            height="1.6"
            rx="0.8"
            width="5"
            x="37"
            y="25.5"
          />
          <rect
            className="td-cmp-win"
            height="12.6"
            rx="2.6"
            width="13.6"
            x="34.2"
            y="18.2"
          />
        </g>
      </g>
    </svg>
  ),

  // "Open one app's report" — a report document rises open and its
  // privacy-label rows cascade in one after another. translateY + opacity
  // only (compositor-only); base frame = the full report. See `.td-doc-*` in
  // task-list.css.
  open_any_app_detail: () => (
    <svg aria-hidden="true" className="td-svg" viewBox="0 0 56 56">
      <g className="td-doc-card">
        <rect
          className="td-doc-bg"
          height="39"
          rx="3"
          width="28"
          x="14"
          y="9"
        />
        <rect
          className="td-doc-icon"
          height="8"
          rx="2"
          width="8"
          x="18"
          y="13"
        />
        <rect
          className="td-doc-title"
          height="2.5"
          rx="1.2"
          width="10"
          x="28"
          y="14"
        />
        <rect
          className="td-doc-title"
          height="2.5"
          rx="1.2"
          width="7"
          x="28"
          y="18.5"
        />
        <rect
          className="td-doc-chip"
          height="4"
          rx="2"
          width="20"
          x="18"
          y="26"
        />
        <rect
          className="td-doc-chip td-doc-chip-2"
          height="4"
          rx="2"
          width="16"
          x="18"
          y="33"
        />
        <rect
          className="td-doc-chip td-doc-chip-3"
          height="4"
          rx="2"
          width="20"
          x="18"
          y="40"
        />
      </g>
    </svg>
  ),
};

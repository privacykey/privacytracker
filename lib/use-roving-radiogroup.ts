"use client";

/**
 * Roving-tabindex keyboard support for the button-styled radio groups
 * used across the app (`role="radiogroup"` wrapping `<button
 * role="radio">` pills/cards — a deliberate pattern, see the Biome
 * a11y-override rationale in `biome.jsonc`).
 *
 * Buttons are natively focusable, so without intervention every radio
 * in a group lands in the page tab order and arrow keys do nothing —
 * the opposite of the APG radio-group contract (WCAG 4.1.2 / 2.1.1):
 * Tab enters the group once (on the checked radio), Arrow keys move
 * within it, Tab leaves it. This hook supplies the two halves of that
 * contract:
 *
 *   1. `useRovingRadioGroup(options?)` returns a keydown handler for
 *      the `role="radiogroup"` element. ArrowRight/ArrowDown move to
 *      the next radio, ArrowLeft/ArrowUp to the previous (flipped
 *      under RTL for the horizontal pair), Home/End jump to the
 *      first/last, and movement wraps at the ends. Disabled radios are
 *      skipped. By default the radio that receives focus is also
 *      selected (standard "selection follows focus" radio behaviour) —
 *      pass `{ followFocus: false }` for groups where selecting has
 *      significant consequences (server writes, view swaps, whole-
 *      profile overwrites); the APG-sanctioned variant where arrows
 *      move focus only and Space/Enter (the button's native click)
 *      commits the choice.
 *
 *   2. Each radio needs a roving `tabIndex`: `0` on the checked radio,
 *      `-1` everywhere else. Groups where exactly one radio is always
 *      checked can inline `tabIndex={checked ? 0 : -1}`; groups that
 *      can render with *no* checked radio should use
 *      `rovingTabIndex(checked, index, groupHasChecked)` so the first
 *      radio stays tabbable as the entry point.
 *
 * Selection itself stays with each component's existing `onClick` /
 * `aria-checked` wiring — when `followFocus` is on, the hook moves
 * focus and then fires the target's native `click()`, so there is no
 * second source of truth for state.
 *
 *   const radioKeyDown = useRovingRadioGroup();
 *   ...
 *   <div role="radiogroup" onKeyDown={radioKeyDown} ...>
 *     <button role="radio" aria-checked={checked}
 *             tabIndex={checked ? 0 : -1} onClick={...} ...>
 */

import { type KeyboardEvent as ReactKeyboardEvent, useCallback } from "react";

export interface RovingRadioGroupOptions {
  /**
   * When true (default) the radio that receives focus via arrow keys
   * is also selected, matching native radio behaviour. Set false for
   * groups whose selection triggers heavy side effects — focus then
   * moves without selecting, and Enter/Space picks.
   */
  followFocus?: boolean;
}

type Move = "next" | "prev" | "first" | "last";

const KEY_TO_MOVE: Record<string, Move> = {
  ArrowRight: "next",
  ArrowDown: "next",
  ArrowLeft: "prev",
  ArrowUp: "prev",
  Home: "first",
  End: "last",
};

function handleRovingKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  followFocus: boolean
): void {
  let move = KEY_TO_MOVE[event.key];
  if (!move) {
    return;
  }

  // Only steer when the key originated on a radio. Some groups nest
  // other focusable controls inside the radiogroup element (e.g. the
  // preset confirm bubbles) — arrows there keep their default
  // behaviour.
  const origin =
    event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[role="radio"]')
      : null;
  if (!origin) {
    return;
  }

  const group = event.currentTarget;

  // Horizontal arrows track reading direction: in RTL, ArrowRight
  // moves backwards through the DOM order.
  if (
    (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
    getComputedStyle(group).direction === "rtl"
  ) {
    move = move === "next" ? "prev" : "next";
  }

  // Radios of THIS group only — `closest` guards against a nested
  // radiogroup's radios leaking into the cycle — minus anything
  // disabled (skipped per the APG pattern).
  const radios = Array.from(
    group.querySelectorAll<HTMLElement>('[role="radio"]')
  ).filter(
    (el) =>
      el.closest('[role="radiogroup"]') === group &&
      !el.matches(':disabled, [aria-disabled="true"]')
  );
  if (radios.length === 0) {
    return;
  }

  const from = radios.indexOf(origin);
  let to: number;
  if (move === "first") {
    to = 0;
  } else if (move === "last") {
    to = radios.length - 1;
  } else if (from === -1) {
    // Origin radio is disabled/foreign — enter at an edge.
    to = move === "next" ? 0 : radios.length - 1;
  } else if (move === "next") {
    to = (from + 1) % radios.length;
  } else {
    to = (from - 1 + radios.length) % radios.length;
  }

  // The group fully consumes handled keys: no page scroll, no global
  // keyboard-shortcut listeners firing underneath.
  event.preventDefault();
  event.stopPropagation();

  const target = radios[to];
  target.focus();
  if (
    followFocus &&
    target !== origin &&
    target.getAttribute("aria-checked") !== "true"
  ) {
    // Reuse the radio's own click handler so selection state flows
    // through the exact same path a pointer click takes. The checked
    // guard keeps toggle-style radios (click-again-to-clear) from
    // deselecting as focus passes over them.
    target.click();
  }
}

/**
 * Returns a stable keydown handler to spread onto a
 * `role="radiogroup"` element. One handler can be shared by several
 * groups in the same component as long as they want the same
 * `followFocus` behaviour.
 */
export function useRovingRadioGroup(
  options?: RovingRadioGroupOptions
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  const followFocus = options?.followFocus ?? true;
  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) =>
      handleRovingKeyDown(event, followFocus),
    [followFocus]
  );
}

/**
 * Roving `tabIndex` for groups that can render with no checked radio:
 * the checked radio is tabbable; when nothing is checked the first
 * radio becomes the group's single tab stop. Groups that always have
 * exactly one checked radio can inline `checked ? 0 : -1` instead.
 */
export function rovingTabIndex(
  checked: boolean,
  index: number,
  groupHasChecked: boolean
): 0 | -1 {
  if (checked) {
    return 0;
  }
  if (!groupHasChecked && index === 0) {
    return 0;
  }
  return -1;
}

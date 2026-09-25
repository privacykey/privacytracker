"use client";

import { useEffect, useState } from "react";

/**
 * A small bridge to the accessibility quick-toggles panel
 * (app/components/AccessibilityQuickToggles.tsx), so other controls can
 * open it without owning a second copy.
 *
 * The panel owns its open state. Other openers (the "Accessibility" entry
 * in the phone nav drawer, the sample-mode nav, the top-of-page entry on
 * pages without a nav, and the "g then u" shortcut) ask it to open with a
 * window event, passing themselves as the `opener` so Escape and ✕ put
 * focus back where the user started. The panel publishes whether it is
 * mounted and open, so an entry renders only when there is a panel to
 * open and can report `aria-expanded`.
 */

export const A11Y_QUICK_OPEN_EVENT = "a11y-quick-toggles:open";
export const A11Y_QUICK_CLOSE_EVENT = "a11y-quick-toggles:close";
const A11Y_QUICK_STATE_EVENT = "a11y-quick-toggles:state";

/** The panel's root. A click inside it is not a click "outside" the
 *  control that opened it (the nav drawer keeps itself open for it). */
export const A11Y_QUICK_PANEL_SELECTOR = ".a11y-quick-popover";

export interface A11yQuickOpenRequest {
  /**
   * Where focus goes if `opener` can no longer take it when the panel
   * closes (for example the drawer was closed meanwhile, which makes its
   * items inert): the drawer's menu button.
   */
  fallback?: HTMLElement | null;
  /** The control that asked. Escape and ✕ return focus to it. */
  opener?: HTMLElement | null;
}

export interface A11yQuickTogglesState {
  /** A panel is mounted (its flag is on) and can be opened. */
  available: boolean;
  open: boolean;
}

let current: A11yQuickTogglesState = { available: false, open: false };

/** Called by the panel only. */
export function publishA11yQuickTogglesState(
  next: Partial<A11yQuickTogglesState>
): void {
  current = { ...current, ...next };
  window.dispatchEvent(
    new CustomEvent<A11yQuickTogglesState>(A11Y_QUICK_STATE_EVENT, {
      detail: current,
    })
  );
}

/**
 * Whether the panel is open right now. Read synchronously by the nav's
 * Escape handler, which can run before React has re-rendered anything:
 * while the panel is open, its Escape belongs to the panel.
 */
export function isA11yQuickTogglesOpen(): boolean {
  return current.open;
}

export function openA11yQuickToggles(request: A11yQuickOpenRequest = {}) {
  window.dispatchEvent(
    new CustomEvent<A11yQuickOpenRequest>(A11Y_QUICK_OPEN_EVENT, {
      detail: request,
    })
  );
}

export function closeA11yQuickToggles() {
  window.dispatchEvent(new CustomEvent(A11Y_QUICK_CLOSE_EVENT));
}

export function useA11yQuickTogglesState(): A11yQuickTogglesState {
  const [state, setState] = useState<A11yQuickTogglesState>(current);
  useEffect(() => {
    const sync = () => setState(current);
    sync();
    window.addEventListener(A11Y_QUICK_STATE_EVENT, sync);
    return () => window.removeEventListener(A11Y_QUICK_STATE_EVENT, sync);
  }, []);
  return state;
}

/**
 * The first candidate that can take focus right now: still in the
 * document, not inside an `inert` subtree, and painted. Used to hand
 * focus back when the panel closes.
 */
export function firstFocusable(
  candidates: ReadonlyArray<HTMLElement | null | undefined>
): HTMLElement | null {
  for (const el of candidates) {
    if (!el?.isConnected || el.closest("[inert]")) {
      continue;
    }
    if (
      typeof el.checkVisibility === "function" &&
      !el.checkVisibility({ visibilityProperty: true })
    ) {
      continue;
    }
    return el;
  }
  return null;
}

"use client";

/**
 * Shared focus-management hook for modal dialogs (`role="dialog"` +
 * `aria-modal="true"`).
 *
 * `aria-modal="true"` prunes the background from the accessibility tree, but
 * it does *nothing* for DOM focus: the browser keeps focus on whatever
 * triggered the dialog (a button outside it), so screen-reader users are
 * stranded outside the dialog they just opened (WCAG 2.4.3 Focus Order) and
 * sighted keyboard users can Tab straight into the obscured background and
 * activate hidden controls (WCAG 2.1.2 No Keyboard Trap — here, the inverse:
 * no trap where one is required).
 *
 * This hook implements the four things every modal needs, extracted verbatim
 * from the previously-duplicated blocks in `AboutModal.tsx` and
 * `KeyboardShortcuts.tsx`:
 *
 *   1. Remember the element that had focus when the modal opened.
 *   2. Move focus into the dialog card on open (first focusable, else the
 *      card itself).
 *   3. Trap Tab / Shift+Tab so it cycles inside the card.
 *   4. Restore focus to the opener when the modal closes / unmounts.
 *   5. (opt-out-able) Escape closes the modal — registered at the window so
 *      it fires regardless of where focus currently sits.
 *
 * Attach the returned ref to the dialog *card* (the element that wraps the
 * interactive content), and give that card `tabIndex={-1}` so it can receive
 * focus when it has no focusable children. The `role="dialog"` /
 * `aria-modal` attributes can live on the card or on an outer scrim — the
 * trap operates on whatever subtree the ref points at.
 *
 *   const cardRef = useModalFocus<HTMLDivElement>({ open, onClose: close });
 *   ...
 *   <div className="scrim" onClick={close} role="dialog" aria-modal="true">
 *     <div className="card" ref={cardRef} tabIndex={-1}
 *          onClick={(e) => e.stopPropagation()}>
 *       ...
 *     </div>
 *   </div>
 */

import { type RefObject, useEffect, useRef } from "react";

// Focusable-element selector. Covers the common interactive elements; hidden
// ones are filtered out at runtime by `collectFocusable`. Kept in sync with
// the (now-removed) copies in AboutModal / KeyboardShortcuts.
export const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * All visible, focusable descendants of `root`, in DOM order. An element is
 * "visible" when it has a layout box (`offsetParent`) or any client rect —
 * this filters out controls parked inside `display: none` ancestors without
 * needing `getComputedStyle` on every candidate.
 */
export function collectFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)
  ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
}

/**
 * Pure decision for what a Tab / Shift+Tab press should do inside a trapped
 * dialog. Extracted from the effect so the wrap-around logic is unit-testable
 * without a DOM.
 *
 * @param count       number of focusable elements in the card
 * @param activeIndex index of the currently-focused element within that list,
 *                    or -1 when focus is on the card itself / outside it / null
 * @param shiftKey    whether Shift was held (backwards tabbing)
 *
 * - `focus-card`  — the card has no focusable children; park focus on the card.
 * - `focus-index` — wrap focus to `index` and preventDefault.
 * - `none`        — let the browser move focus naturally (no preventDefault).
 */
export type TabTrapAction =
  | { type: "none" }
  | { type: "focus-card" }
  | { type: "focus-index"; index: number };

export function resolveTabTrap(
  count: number,
  activeIndex: number,
  shiftKey: boolean
): TabTrapAction {
  if (count === 0) {
    return { type: "focus-card" };
  }
  if (shiftKey) {
    // Backwards from the first element (or from the card / outside) wraps to
    // the last. `activeIndex <= 0` folds in both "on first" (0) and
    // "not in list / null" (-1).
    if (activeIndex <= 0) {
      return { type: "focus-index", index: count - 1 };
    }
    return { type: "none" };
  }
  // Forwards from the last element wraps to the first.
  if (activeIndex === count - 1) {
    return { type: "focus-index", index: 0 };
  }
  return { type: "none" };
}

export interface UseModalFocusOptions {
  /**
   * Register a window-level Escape handler that calls `onClose`. Default
   * `true`. Set to `false` only when a parent already owns Escape for this
   * surface (e.g. a wizard that handles Escape across several steps).
   */
  closeOnEscape?: boolean;
  /** Called when Escape is pressed (unless `closeOnEscape` is false). */
  onClose?: () => void;
  /** Whether the modal is currently open/mounted. */
  open: boolean;
}

/**
 * Wires focus management for a modal dialog. Returns a ref to attach to the
 * dialog card (see the module doc-comment for the markup contract).
 */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>({
  open,
  onClose,
  closeOnEscape = true,
}: UseModalFocusOptions): RefObject<T | null> {
  const cardRef = useRef<T | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  // Keep the latest onClose without re-running the effect (and thus
  // re-stealing focus) every time the parent re-renders with a new closure.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }

    lastFocused.current = (document.activeElement as HTMLElement) ?? null;

    // Defer focus to the next frame so the card has mounted + painted.
    const raf = requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card) {
        return;
      }
      const focusables = collectFocusable(card);
      (focusables[0] ?? card).focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (closeOnEscape && event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const card = cardRef.current;
      if (!card) {
        return;
      }
      const focusables = collectFocusable(card);
      const active = document.activeElement as HTMLElement | null;
      const activeIndex =
        active && card.contains(active) ? focusables.indexOf(active) : -1;
      const action = resolveTabTrap(
        focusables.length,
        activeIndex,
        event.shiftKey
      );
      if (action.type === "none") {
        return;
      }
      event.preventDefault();
      if (action.type === "focus-card") {
        card.focus();
      } else {
        focusables[action.index]?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      const prev = lastFocused.current;
      lastFocused.current = null;
      // Only restore if the opener is still in the DOM and focusable.
      if (prev && typeof prev.focus === "function" && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [open, closeOnEscape]);

  return cardRef;
}

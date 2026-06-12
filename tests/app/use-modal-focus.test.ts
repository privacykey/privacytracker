import assert from "node:assert/strict";
import test from "node:test";
import {
  MODAL_FOCUSABLE_SELECTOR,
  resolveTabTrap,
} from "../../lib/use-modal-focus";

// The hook's effect (focus-in, restore, window listener) is DOM-driven and
// exercised by the browser; the unit-testable core is `resolveTabTrap`, the
// pure wrap-around decision the Tab handler delegates to. These cases pin the
// contract that previously lived inline (and identically) in AboutModal and
// KeyboardShortcuts.

test("resolveTabTrap parks focus on the card when there is nothing to focus", () => {
  assert.deepEqual(resolveTabTrap(0, -1, false), { type: "focus-card" });
  assert.deepEqual(resolveTabTrap(0, -1, true), { type: "focus-card" });
});

test("resolveTabTrap wraps forward Tab from the last element to the first", () => {
  // 3 focusables, on the last one, Tab forward → wrap to index 0.
  assert.deepEqual(resolveTabTrap(3, 2, false), {
    type: "focus-index",
    index: 0,
  });
});

test("resolveTabTrap lets forward Tab move naturally when not on the last element", () => {
  assert.deepEqual(resolveTabTrap(3, 0, false), { type: "none" });
  assert.deepEqual(resolveTabTrap(3, 1, false), { type: "none" });
  // Focus on the card itself / outside the list (-1) tabbing forward is a
  // no-op — the browser moves to the first focusable on its own.
  assert.deepEqual(resolveTabTrap(3, -1, false), { type: "none" });
});

test("resolveTabTrap wraps Shift+Tab from the first element to the last", () => {
  assert.deepEqual(resolveTabTrap(3, 0, true), {
    type: "focus-index",
    index: 2,
  });
});

test("resolveTabTrap wraps Shift+Tab to the last when focus is on the card / outside", () => {
  // activeIndex -1 means focus is on the card or escaped the list; Shift+Tab
  // must pull it back to the last focusable rather than leak to the page.
  assert.deepEqual(resolveTabTrap(3, -1, true), {
    type: "focus-index",
    index: 2,
  });
});

test("resolveTabTrap lets Shift+Tab move naturally from a middle/last element", () => {
  assert.deepEqual(resolveTabTrap(3, 1, true), { type: "none" });
  assert.deepEqual(resolveTabTrap(3, 2, true), { type: "none" });
});

test("resolveTabTrap handles a single focusable element by trapping both directions", () => {
  // Only one focusable: forward from index 0 (which is also last) wraps to 0,
  // and Shift+Tab from index 0 (also first) wraps to 0. Either way focus stays
  // put — the trap never escapes.
  assert.deepEqual(resolveTabTrap(1, 0, false), {
    type: "focus-index",
    index: 0,
  });
  assert.deepEqual(resolveTabTrap(1, 0, true), {
    type: "focus-index",
    index: 0,
  });
});

test("MODAL_FOCUSABLE_SELECTOR covers the standard interactive controls and excludes tabindex=-1", () => {
  assert.match(MODAL_FOCUSABLE_SELECTOR, /a\[href\]/);
  assert.match(MODAL_FOCUSABLE_SELECTOR, /button:not\(\[disabled\]\)/);
  assert.match(MODAL_FOCUSABLE_SELECTOR, /input:not\(\[disabled\]\)/);
  assert.match(MODAL_FOCUSABLE_SELECTOR, /textarea:not\(\[disabled\]\)/);
  assert.match(MODAL_FOCUSABLE_SELECTOR, /select:not\(\[disabled\]\)/);
  assert.match(MODAL_FOCUSABLE_SELECTOR, /tabindex\]:not\(\[tabindex="-1"\]\)/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_ORDER,
  type DashboardCardId,
  layoutForFocus,
  SIMPLE_VIEW_FOLDED_CARDS,
  splitSimpleViewOrder,
} from "../../lib/dashboard-layout";

test("outside the simple view nothing is folded and the order is untouched", () => {
  const { main, folded } = splitSimpleViewOrder(CANONICAL_ORDER, false);
  assert.deepEqual(main, [...CANONICAL_ORDER]);
  assert.deepEqual(folded, []);
});

test("the simple view folds exactly the three long reference lists", () => {
  const { main, folded } = splitSimpleViewOrder(CANONICAL_ORDER, true);
  assert.deepEqual(
    [...folded].sort(),
    ["profile_mismatch_section", "risk_section", "stale_section"],
    "risk, consider-replacing and stale are the folded cards"
  );
  for (const id of folded) {
    assert.ok(!main.includes(id), `${id} must not render twice`);
  }
  assert.equal(
    main.length + folded.length,
    CANONICAL_ORDER.length,
    "every card lands in exactly one half"
  );
});

test("status and what changed stay on the page in the simple view", () => {
  const { main } = splitSimpleViewOrder(CANONICAL_ORDER, true);
  for (const id of [
    "focus_strip",
    "hero",
    "review_section",
    "task_list",
  ] as DashboardCardId[]) {
    assert.ok(main.includes(id), `${id} is not a folded card`);
  }
});

test("both halves keep the user's order, including a focus-led one", () => {
  // Clean up puts "Consider replacing" near the top; folding must not
  // reshuffle what is left, nor the folded lists among themselves.
  const order = layoutForFocus(
    { v: 1, order: [...CANONICAL_ORDER], hidden: [] },
    { audience: "self", monitor: true, cleanup: true }
  ).order;
  const { main, folded } = splitSimpleViewOrder(order, true);
  assert.deepEqual(
    main,
    order.filter((id) => !SIMPLE_VIEW_FOLDED_CARDS.has(id))
  );
  assert.deepEqual(
    folded,
    order.filter((id) => SIMPLE_VIEW_FOLDED_CARDS.has(id))
  );
});

test("the split never mutates the layout's own order array", () => {
  const order = [...CANONICAL_ORDER];
  const before = [...order];
  splitSimpleViewOrder(order, true);
  assert.deepEqual(order, before);
});

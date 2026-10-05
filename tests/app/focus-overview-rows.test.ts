import assert from "node:assert/strict";
import test from "node:test";
import {
  changedBeyondPreview,
  OVERVIEW_STARTER_ROWS,
  splitOverviewRows,
} from "../../lib/focus-overview-rows";
import type { FocusOverviewApp } from "../../lib/focus-review";

function app(
  id: string,
  decision: FocusOverviewApp["decision"] = "review",
  changeCount = 0
): FocusOverviewApp {
  return {
    id,
    name: `App ${id}`,
    iconUrl: null,
    changeCount,
    decision,
    remindAt: null,
  };
}

const ids = (rows: FocusOverviewApp[]) => rows.map((row) => row.id);

test("changed apps with no decision sit behind the expand control", () => {
  // The audit backup's shape: two replacement plans, six changed apps.
  const preview = [
    app("r1", "replace"),
    app("r2", "replace"),
    ...["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => app(id, "review", 1)),
  ];
  const { primary, changed } = splitOverviewRows(preview);
  assert.deepEqual(ids(primary), ["r1", "r2"]);
  assert.deepEqual(ids(changed), ["c1", "c2", "c3", "c4", "c5", "c6"]);
});

test("every row of the preview lands in exactly one list or is a capped starter", () => {
  const preview = [
    app("due", "due"),
    app("rep", "replace"),
    app("chg", "review", 2),
    app("a"),
    app("b"),
    app("c"),
  ];
  const { primary, changed } = splitOverviewRows(preview);
  // Two decisions leave room for one starter row out of the three.
  assert.deepEqual(ids(primary), ["due", "rep", "a"]);
  assert.deepEqual(ids(changed), ["chg"]);
  const seen = new Set([...ids(primary), ...ids(changed)]);
  assert.equal(seen.size, primary.length + changed.length, "no row twice");
});

test("a decision in progress is never dropped, however many there are", () => {
  const preview = [
    app("d1", "due"),
    app("d2", "replace"),
    app("d3", "replace"),
    app("d4", "uninstall"),
    app("d5", "later"),
    app("filler"),
  ];
  const { primary } = splitOverviewRows(preview);
  assert.deepEqual(ids(primary), ["d1", "d2", "d3", "d4", "d5"]);
});

test("a decided app with new changes stays visible, not behind the control", () => {
  const { primary, changed } = splitOverviewRows([app("rep", "replace", 3)]);
  assert.deepEqual(ids(primary), ["rep"]);
  assert.deepEqual(changed, []);
});

test("with nothing decided, the card shows a capped set of starter rows", () => {
  const preview = ["a", "b", "c", "d", "e"].map((id) => app(id));
  const { primary, changed } = splitOverviewRows(preview);
  assert.equal(primary.length, OVERVIEW_STARTER_ROWS);
  assert.deepEqual(ids(primary), ["a", "b", "c"]);
  assert.deepEqual(changed, []);
});

test("a kept app is settled, so it only ever fills a starter slot", () => {
  const preview = [
    app("k1", "kept"),
    app("k2", "kept"),
    app("k3", "kept"),
    app("k4", "kept"),
  ];
  assert.deepEqual(ids(splitOverviewRows(preview).primary), ["k1", "k2", "k3"]);
});

test("changedBeyondPreview counts the changed apps the preview could not carry", () => {
  const preview = [
    app("rep", "replace", 1),
    app("c1", "review", 1),
    app("c2", "review", 4),
    app("quiet"),
  ];
  // Three of the preview's rows have changes; the fleet has eleven.
  assert.equal(changedBeyondPreview(preview, 11), 8);
  assert.equal(changedBeyondPreview(preview, 3), 0);
  // A count below what the preview shows never goes negative.
  assert.equal(changedBeyondPreview(preview, 1), 0);
});

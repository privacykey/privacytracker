import assert from "node:assert/strict";
import test from "node:test";
import { waybackChangeWindow } from "../../lib/wayback-timeline";

const DAY = 86_400_000;
const change = { type: "added", category: "privacy-label", description: "x" };

function snap(scrapedAt: number, source: "wayback" | "live", changed: boolean) {
  return {
    kind: "snapshot",
    scraped_at: scrapedAt,
    source,
    changes_summary: changed ? [change] : [],
  };
}

const review = { kind: "review", scraped_at: 50 * DAY };

test("a wayback change right after an unchanged wayback row has a window", () => {
  // Newest first, as the timeline renders them.
  const rows = [
    snap(100 * DAY, "wayback", true),
    snap(60 * DAY, "wayback", false),
  ];
  assert.deepEqual(waybackChangeWindow(rows, 0), {
    fromMs: 60 * DAY,
    toMs: 100 * DAY,
  });
});

test("review rows in between are skipped", () => {
  const rows = [
    snap(100 * DAY, "wayback", true),
    review,
    snap(40 * DAY, "wayback", false),
  ];
  assert.deepEqual(waybackChangeWindow(rows, 0), {
    fromMs: 40 * DAY,
    toMs: 100 * DAY,
  });
});

test("only a wayback change row gets a window", () => {
  const rows = [
    snap(120 * DAY, "live", true),
    snap(100 * DAY, "wayback", false),
    snap(60 * DAY, "wayback", false),
  ];
  assert.equal(waybackChangeWindow(rows, 0), null, "live row");
  assert.equal(waybackChangeWindow(rows, 1), null, "unchanged row");
  assert.equal(waybackChangeWindow([review], 0), null, "review row");
  assert.equal(waybackChangeWindow(rows, 7), null, "out of range");
});

test("no window when the row before is live, changed or missing", () => {
  assert.equal(
    waybackChangeWindow(
      [snap(100 * DAY, "wayback", true), snap(60 * DAY, "live", false)],
      0
    ),
    null
  );
  assert.equal(
    waybackChangeWindow(
      [snap(100 * DAY, "wayback", true), snap(60 * DAY, "wayback", true)],
      0
    ),
    null
  );
  // The oldest loaded row: what preceded it is on an unloaded page.
  assert.equal(
    waybackChangeWindow([snap(100 * DAY, "wayback", true)], 0),
    null
  );
  assert.equal(
    waybackChangeWindow([snap(100 * DAY, "wayback", true), review], 0),
    null
  );
});

test("no window when the rows are not in time order", () => {
  const rows = [
    snap(60 * DAY, "wayback", true),
    snap(60 * DAY, "wayback", false),
  ];
  assert.equal(waybackChangeWindow(rows, 0), null);
});

test("a row with no changes_summary at all counts as unchanged", () => {
  const rows = [
    snap(100 * DAY, "wayback", true),
    { kind: "snapshot", scraped_at: 30 * DAY, source: "wayback" },
  ];
  assert.deepEqual(waybackChangeWindow(rows, 0), {
    fromMs: 30 * DAY,
    toMs: 100 * DAY,
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_STORE_HISTORICAL_FLOOR,
  computeHistoricalTargets,
  computeQuarterlyTargets,
} from "../../lib/historical-import";

const FLOOR = APP_STORE_HISTORICAL_FLOOR; // 1 Feb 2021
const TODAY = new Date(Date.UTC(2026, 0, 15)); // 15 Jan 2026
const DAY_MS = 24 * 60 * 60 * 1000;

test("quarterly targets are chronological, floored, and ~3 months apart", () => {
  const targets = computeQuarterlyTargets(TODAY, FLOOR);
  assert.ok(targets.length > 0);

  for (let i = 1; i < targets.length; i++) {
    assert.ok(
      targets[i].getTime() > targets[i - 1].getTime(),
      "targets must be strictly ascending"
    );
  }
  assert.equal(targets[0].getTime(), FLOOR.getTime(), "first target is floor");
  assert.ok(targets.at(-1)!.getTime() <= TODAY.getTime(), "last <= today");

  // A grid-aligned middle gap should be ~one quarter (allow for month-length drift).
  const gapDays = (targets[2].getTime() - targets[1].getTime()) / DAY_MS;
  assert.ok(gapDays >= 85 && gapDays <= 95, `quarter gap ~90d, got ${gapDays}`);
});

test("monthly cadence is denser than quarterly over the same window", () => {
  const quarterly = computeHistoricalTargets(TODAY, FLOOR, {
    intervalMonths: 3,
  });
  const monthly = computeHistoricalTargets(TODAY, FLOOR, { intervalMonths: 1 });
  assert.ok(
    monthly.length > quarterly.length,
    "monthly should produce more targets"
  );

  const gapDays = (monthly[2].getTime() - monthly[1].getTime()) / DAY_MS;
  assert.ok(gapDays >= 28 && gapDays <= 32, `month gap ~30d, got ${gapDays}`);
});

test("intervalMonths is clamped to >= 1", () => {
  const zero = computeHistoricalTargets(TODAY, FLOOR, { intervalMonths: 0 });
  const monthly = computeHistoricalTargets(TODAY, FLOOR, { intervalMonths: 1 });
  assert.equal(
    zero.length,
    monthly.length,
    "0 clamps to monthly, not infinite"
  );
});

test("an off-grid install anchor inside the window is probed", () => {
  const anchor = new Date(Date.UTC(2023, 6, 9)); // 9 Jul 2023 — off the quarter grid
  const withAnchor = computeHistoricalTargets(TODAY, FLOOR, {
    intervalMonths: 3,
    anchorDates: [anchor],
  });
  const hit = withAnchor.some(
    (d) => Math.abs(d.getTime() - anchor.getTime()) <= DAY_MS
  );
  assert.ok(hit, "anchor date should appear among targets");
});

test("anchors outside [floor, today] are ignored", () => {
  const tooOld = new Date(Date.UTC(2019, 0, 1));
  const future = new Date(Date.UTC(2030, 0, 1));
  const base = computeHistoricalTargets(TODAY, FLOOR, { intervalMonths: 3 });
  const withBad = computeHistoricalTargets(TODAY, FLOOR, {
    intervalMonths: 3,
    anchorDates: [tooOld, future],
  });
  assert.equal(withBad.length, base.length);
});

test("an anchor coinciding with an interval target doesn't double-probe", () => {
  const base = computeHistoricalTargets(TODAY, FLOOR, { intervalMonths: 3 });
  const existing = base[2];
  const withDup = computeHistoricalTargets(TODAY, FLOOR, {
    intervalMonths: 3,
    anchorDates: [new Date(existing.getTime())],
  });
  assert.equal(withDup.length, base.length);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { AppProfileBadge } from "../../lib/privacy-profile";
import {
  applyDecision,
  applySkip,
  computeQueueApps,
  countQueueBatches,
  DEFAULT_PREFLIGHT,
  EMPTY_SESSION_TOTALS,
  GUARDIAN_DEFAULT_PREFLIGHT,
  type QueueAppInput,
  splitQueueIntoBatches,
  undoDecision,
  undoSkip,
} from "../../lib/review-queue";
import type { VerdictValue } from "../../lib/verdict-types";

// Small helper to build app fixtures without typing the same 6 fields every line.
function mkApp(
  id: string,
  overrides: Partial<QueueAppInput> = {}
): QueueAppInput {
  return {
    id,
    name: id.toUpperCase(),
    lastSynced: 0,
    changeCount: 0,
    trackCount: 0,
    linkedCount: 0,
    unlinkedCount: 0,
    ...overrides,
  };
}

function mkBadge(count: number, totalGap: number): AppProfileBadge {
  return {
    count,
    totalGap,
    tone: count === 0 ? "ok" : count >= 3 ? "bad" : "warn",
    kind: count === 0 ? "match" : "mismatches",
    label: "",
    description: "",
    worstCategory: null,
    worstCategoryLabel: null,
  };
}

test("computeQueueApps filters by scope=undecided", () => {
  const apps = [mkApp("a"), mkApp("b"), mkApp("c")];
  const result = computeQueueApps(apps, {
    scope: "undecided",
    sort: "alphabetical",
    userVerdicts: { b: "safe" },
    profileBadges: {},
  });
  assert.deepEqual(
    result.map((a) => a.id),
    ["a", "c"]
  );
});

test("computeQueueApps filters by scope=mismatch", () => {
  const apps = [mkApp("a"), mkApp("b"), mkApp("c")];
  const result = computeQueueApps(apps, {
    scope: "mismatch",
    sort: "alphabetical",
    userVerdicts: {},
    profileBadges: { a: mkBadge(2, 4), c: mkBadge(1, 1) },
  });
  assert.deepEqual(
    result.map((app) => app.id),
    ["a", "c"]
  );
});

test("computeQueueApps filters by scope=changed using changedAppIds set", () => {
  const apps = [mkApp("a"), mkApp("b"), mkApp("c", { changeCount: 5 })];
  const result = computeQueueApps(apps, {
    scope: "changed",
    sort: "alphabetical",
    userVerdicts: {},
    profileBadges: {},
    changedAppIds: new Set(["a", "c"]),
  });
  assert.deepEqual(
    result.map((app) => app.id),
    ["a", "c"]
  );
});

test("computeQueueApps with scope=changed falls back to changeCount when set is absent", () => {
  const apps = [
    mkApp("a"),
    mkApp("b", { changeCount: 1 }),
    mkApp("c", { changeCount: 7 }),
  ];
  const result = computeQueueApps(apps, {
    scope: "changed",
    sort: "alphabetical",
    userVerdicts: {},
    profileBadges: {},
  });
  assert.deepEqual(
    result.map((app) => app.id),
    ["b", "c"]
  );
});

test("computeQueueApps sort=mismatch_severity orders worst-first then falls back to risk", () => {
  const apps = [
    mkApp("a", { trackCount: 1 }),
    mkApp("b", { trackCount: 5 }),
    mkApp("c", { trackCount: 3 }),
  ];
  const result = computeQueueApps(apps, {
    scope: "all",
    sort: "mismatch_severity",
    userVerdicts: {},
    profileBadges: {
      a: mkBadge(2, 5),
      b: mkBadge(2, 5), // same gap as a — risk tiebreaker
      c: mkBadge(3, 10),
    },
  });
  // c has highest totalGap, then b (higher risk than a), then a.
  assert.deepEqual(
    result.map((app) => app.id),
    ["c", "b", "a"]
  );
});

test("computeQueueApps sort=risk is independent of profile badges", () => {
  const apps = [
    mkApp("low", { unlinkedCount: 1 }),
    mkApp("high", { trackCount: 2 }),
    mkApp("mid", { linkedCount: 4 }),
  ];
  const result = computeQueueApps(apps, {
    scope: "all",
    sort: "risk",
    userVerdicts: {},
    profileBadges: {},
  });
  assert.deepEqual(
    result.map((app) => app.id),
    ["high", "mid", "low"]
  );
});

test("computeQueueApps sort=random is deterministic given seeded rng", () => {
  const apps = [mkApp("a"), mkApp("b"), mkApp("c"), mkApp("d")];
  // Deterministic RNG: returns 0.0, 0.25, 0.5 in order then wraps.
  let i = 0;
  const seq = [0.0, 0.25, 0.5, 0.75];
  const rng = () => seq[i++ % seq.length];
  const a = computeQueueApps(apps, {
    scope: "all",
    sort: "random",
    userVerdicts: {},
    profileBadges: {},
    rng,
  });
  i = 0;
  const b = computeQueueApps(apps, {
    scope: "all",
    sort: "random",
    userVerdicts: {},
    profileBadges: {},
    rng,
  });
  assert.deepEqual(
    a.map((x) => x.id),
    b.map((x) => x.id)
  );
});

test("splitQueueIntoBatches respects split size; null returns single batch", () => {
  const apps = Array.from({ length: 27 }, (_, idx) => mkApp(`a${idx}`));
  const b10 = splitQueueIntoBatches(apps, 10);
  assert.equal(b10.length, 3);
  assert.equal(b10[0].length, 10);
  assert.equal(b10[2].length, 7);

  const bAll = splitQueueIntoBatches(apps, null);
  assert.equal(bAll.length, 1);
  assert.equal(bAll[0].length, 27);

  // Empty input → empty batches.
  assert.deepEqual(splitQueueIntoBatches([], 10), []);
});

test("countQueueBatches matches splitQueueIntoBatches", () => {
  assert.equal(countQueueBatches(0, 10), 0);
  assert.equal(countQueueBatches(10, 10), 1);
  assert.equal(countQueueBatches(11, 10), 2);
  assert.equal(countQueueBatches(27, 10), 3);
  assert.equal(countQueueBatches(27, null), 1);
});

test("applyDecision increments the right counter and notesAdded", () => {
  let t = EMPTY_SESSION_TOTALS;
  t = applyDecision(t, "safe", false);
  t = applyDecision(t, "safe", true);
  t = applyDecision(t, "replace", false);
  t = applyDecision(t, "uninstall", true);
  assert.equal(t.decided, 4);
  assert.equal(t.safe, 2);
  assert.equal(t.replace, 1);
  assert.equal(t.uninstall, 1);
  assert.equal(t.notesAdded, 2);
});

test("undoDecision reverses applyDecision and clamps to zero", () => {
  let t = EMPTY_SESSION_TOTALS;
  t = applyDecision(t, "safe", true);
  t = undoDecision(t, "safe", true);
  assert.deepEqual(t, EMPTY_SESSION_TOTALS);

  // Underflow protection — calling undo on an empty totals stays at zero.
  const underflow = undoDecision(
    EMPTY_SESSION_TOTALS,
    "uninstall" as VerdictValue,
    false
  );
  assert.equal(underflow.decided, 0);
  assert.equal(underflow.uninstall, 0);
});

test("applySkip increments skipped only and leaves decided untouched", () => {
  let t = EMPTY_SESSION_TOTALS;
  t = applySkip(t);
  t = applySkip(t);
  assert.equal(t.skipped, 2);
  // Critical invariant: skips are NOT decisions, so don't bump `decided`.
  assert.equal(t.decided, 0);
  assert.equal(t.safe, 0);
  assert.equal(t.replace, 0);
  assert.equal(t.uninstall, 0);
});

test("undoSkip reverses applySkip and clamps to zero", () => {
  let t = EMPTY_SESSION_TOTALS;
  t = applySkip(t);
  t = undoSkip(t);
  assert.deepEqual(t, EMPTY_SESSION_TOTALS);
  const underflow = undoSkip(EMPTY_SESSION_TOTALS);
  assert.equal(underflow.skipped, 0);
});

test("default preflight differs for guardian audience", () => {
  assert.equal(DEFAULT_PREFLIGHT.scope, "undecided");
  assert.equal(GUARDIAN_DEFAULT_PREFLIGHT.scope, "mismatch");
  // Both default to mismatch-severity sort so the queue surfaces worst-first.
  assert.equal(DEFAULT_PREFLIGHT.sort, "mismatch_severity");
  assert.equal(GUARDIAN_DEFAULT_PREFLIGHT.sort, "mismatch_severity");
});

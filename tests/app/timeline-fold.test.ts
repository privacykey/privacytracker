/**
 * The fold that keeps the last real change on top of an app's History
 * timeline (lib/timeline-fold.ts). Rows are built the way the server
 * writes them: a label sync with no diff has an empty summary, a policy
 * fetch has one `privacy-policy` entry.
 *
 * The rule mirrors `TimelineFold.swift` in the iOS companion
 * (privacykey/privacytracker-ios PR #13) and these cases mirror its tests,
 * so a change on one side shows up as a failure on the other. The rendered
 * copy is pinned through next-intl in a child process (see
 * tests/helpers/render-timeline-fold-copy.ts for why) against the strings
 * the iOS `summary` produces.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ChangeEntry,
  ChangelogRow,
  ReviewChangelogRow,
  SnapshotChangelogRow,
} from "../../lib/changelog-types";
import {
  FOLD_SUMMARY_KEYS,
  type FoldSummaryMessage,
  foldId,
  foldSummaryMessage,
  foldTimeline,
  isQuietRow,
  quietKind,
  sameLocalDay,
  sameLocalYear,
} from "../../lib/timeline-fold";

const DAY = 86_400_000;
const JUN3 = new Date(2026, 5, 3, 12).getTime();
const OCT9 = new Date(2026, 9, 9, 12).getTime();
// Built from its code point so the source itself carries no em dash.
const EM_DASH = new RegExp(String.fromCharCode(0x2014));

let seq = 0;
const nextId = () => `row-${++seq}`;

function sync(
  at: number,
  triggeredBy: SnapshotChangelogRow["triggered_by"] = "scheduled",
  id = nextId()
): SnapshotChangelogRow {
  return {
    kind: "snapshot",
    id,
    scraped_at: at,
    changes_detected: 0,
    changes_summary: [],
    source: "live",
    triggered_by: triggeredBy,
  };
}

function labelChange(at: number): SnapshotChangelogRow {
  return {
    kind: "snapshot",
    id: nextId(),
    scraped_at: at,
    changes_detected: 1,
    changes_summary: [
      { type: "added", category: "privacy-label", description: "Location" },
    ],
    source: "live",
    triggered_by: "scheduled",
  };
}

function policy(
  at: number,
  event: ChangeEntry["policy_event"] | undefined,
  detected = 0
): SnapshotChangelogRow {
  const entry: ChangeEntry = {
    type: "policy",
    category: "privacy-policy",
    description: `Privacy policy ${event ?? ""}`.trim(),
  };
  if (event) {
    entry.policy_event = event;
  }
  return {
    kind: "snapshot",
    id: nextId(),
    scraped_at: at,
    changes_detected: detected,
    changes_summary: [entry],
    source: "live",
    // appendPolicyChangeEntry writes no trigger.
    triggered_by: null,
  };
}

function wayback(at: number): SnapshotChangelogRow {
  return {
    kind: "snapshot",
    id: nextId(),
    scraped_at: at,
    changes_detected: 0,
    changes_summary: [],
    source: "wayback",
    triggered_by: "wayback",
    wayback_snapshot_url:
      "https://web.archive.org/web/20260101000000id_/https://apps.apple.com/us/app/id1",
  };
}

function review(at: number): ReviewChangelogRow {
  return {
    kind: "review",
    id: `review-${nextId()}`,
    action: "reviewed",
    covered_count: 2,
    note: null,
    scraped_at: at,
    snooze_until: null,
  };
}

const rowItem = (row: ChangelogRow) => ({ kind: "row", id: row.id, row });

test("quiet rows are unchanged syncs and same-or-failed policy checks", () => {
  assert.equal(quietKind(sync(OCT9)), "label_unchanged");
  assert.equal(
    quietKind(sync(OCT9, null)),
    "label_unchanged",
    "a legacy row with no stored trigger is a plain sync"
  );
  assert.equal(quietKind(sync(OCT9, "manual")), "label_unchanged");
  assert.equal(quietKind(policy(OCT9, "same")), "policy_same");
  assert.equal(quietKind(policy(OCT9, "error")), "policy_error");
  // A policy entry is recognised by its type as well as its category.
  const typedOnly: SnapshotChangelogRow = {
    ...policy(OCT9, "same"),
    changes_summary: [
      { type: "policy", description: "same", policy_event: "same" },
    ],
  };
  assert.equal(quietKind(typedOnly), "policy_same");
  assert.equal(isQuietRow(sync(OCT9)), true);
  assert.equal(isQuietRow(labelChange(OCT9)), false);
});

test("rows that say something are never quiet", () => {
  assert.equal(quietKind(labelChange(OCT9)), null);
  assert.equal(quietKind(policy(OCT9, "changed")), null);
  assert.equal(quietKind(policy(OCT9, "first")), null);
  assert.equal(
    quietKind(policy(OCT9, undefined)),
    null,
    "no policy_event reads as changed, as the card does"
  );
  assert.equal(quietKind(wayback(OCT9)), null);
  assert.equal(quietKind(review(OCT9)), null);
  assert.equal(
    quietKind(sync(OCT9, "import")),
    null,
    "the first scan marks where tracking began"
  );
  assert.equal(
    quietKind(policy(OCT9, "same", 1)),
    null,
    "a row flagged for review is not quiet whatever its entries say"
  );
  const accessibility: SnapshotChangelogRow = {
    ...sync(OCT9),
    changes_summary: [
      { type: "added", category: "accessibility", description: "VoiceOver" },
    ],
  };
  assert.equal(quietKind(accessibility), null);
  const mixed: SnapshotChangelogRow = {
    ...sync(OCT9),
    changes_summary: [
      {
        type: "policy",
        category: "privacy-policy",
        description: "same",
        policy_event: "same",
      },
      { type: "added", description: "Location" },
    ],
  };
  assert.equal(quietKind(mixed), null);
  const waybackAttempt: SnapshotChangelogRow = {
    ...sync(OCT9),
    changes_summary: [
      {
        type: "wayback",
        category: "wayback-attempt",
        description: "No capture",
        wayback_event: "no_capture",
      },
    ],
  };
  assert.equal(quietKind(waybackAttempt), null);
});

test("consecutive quiet rows fold into one item and lone ones stay", () => {
  const change = labelChange(OCT9);
  const q1 = sync(OCT9 - DAY);
  const q2 = policy(OCT9 - 2 * DAY, "error");
  const q3 = sync(OCT9 - 3 * DAY);
  const policyChange = policy(JUN3 + 10 * DAY, "changed");
  const lone = sync(JUN3 + 5 * DAY);
  const first = sync(JUN3, "import");

  const items = foldTimeline([change, q1, q2, q3, policyChange, lone, first]);
  assert.equal(items.length, 5);
  assert.deepEqual(items[0], rowItem(change));
  const run = items[1];
  assert.equal(run.kind, "folded");
  if (run.kind !== "folded") {
    return;
  }
  assert.deepEqual(run.rows, [q1, q2, q3]);
  assert.equal(run.count, 3);
  assert.equal(run.newest, OCT9 - DAY);
  assert.equal(run.oldest, OCT9 - 3 * DAY);
  assert.equal(run.errorCount, 1);
  assert.equal(run.includesErrors, true);
  assert.equal(run.id, foldId(q1));
  assert.equal(run.id, `fold:${q1.id}`);
  assert.deepEqual(items[2], rowItem(policyChange));
  assert.deepEqual(
    items[3],
    rowItem(lone),
    "a single quiet row stays unfolded"
  );
  assert.deepEqual(items[4], rowItem(first));
});

test("oldest-first input folds the same runs", () => {
  const rows = [sync(JUN3), sync(JUN3 + DAY), labelChange(OCT9)];
  const items = foldTimeline(rows);
  assert.equal(items.length, 2);
  const run = items[0];
  assert.equal(run.kind, "folded");
  if (run.kind !== "folded") {
    return;
  }
  assert.deepEqual(run.rows, rows.slice(0, 2));
  assert.equal(run.newest, JUN3 + DAY);
  assert.equal(run.oldest, JUN3);
  assert.deepEqual(items[1], rowItem(rows[2]));
});

test("all quiet and empty inputs", () => {
  assert.deepEqual(foldTimeline([]), []);
  const quiet = Array.from({ length: 14 }, (_, i) => sync(OCT9 - i * DAY));
  const items = foldTimeline(quiet);
  assert.equal(items.length, 1);
  const run = items[0];
  assert.equal(run.kind, "folded");
  if (run.kind === "folded") {
    assert.equal(run.count, 14);
    assert.equal(run.errorCount, 0);
    assert.equal(run.includesErrors, false);
  }
});

test("failed policy checks are counted across the run", () => {
  const rows = [
    policy(OCT9, "error"),
    sync(OCT9 - DAY),
    policy(OCT9 - 2 * DAY, "same"),
    policy(OCT9 - 3 * DAY, "error"),
  ];
  const [run] = foldTimeline(rows);
  assert.equal(run.kind, "folded");
  if (run.kind === "folded") {
    assert.equal(run.count, 4);
    assert.equal(run.errorCount, 2);
  }
  const allFailed = foldTimeline([
    policy(OCT9, "error"),
    policy(OCT9 - DAY, "error"),
  ])[0];
  assert.equal(allFailed.kind, "folded");
  if (allFailed.kind === "folded") {
    assert.equal(allFailed.errorCount, allFailed.count);
  }
});

test("a review action breaks a run", () => {
  const a1 = sync(OCT9);
  const a2 = sync(OCT9 - DAY);
  const r = review(OCT9 - 2 * DAY);
  const b1 = sync(OCT9 - 3 * DAY);
  const b2 = sync(OCT9 - 4 * DAY);
  const items = foldTimeline([a1, a2, r, b1, b2]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["folded", "row", "folded"]
  );
  assert.equal(items[0].id, foldId(a1));
  assert.deepEqual(items[1], rowItem(r));
  assert.equal(items[2].id, foldId(b1));
});

test("wayback and import rows break a run and are never folded", () => {
  const items = foldTimeline([
    sync(OCT9),
    wayback(OCT9 - DAY),
    sync(OCT9 - 2 * DAY),
  ]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["row", "row", "row"],
    "an archive row between two quiet rows leaves all three as rows"
  );
  const withFirst = foldTimeline([
    sync(OCT9),
    sync(OCT9 - DAY),
    sync(OCT9 - 2 * DAY, "import"),
  ]);
  assert.deepEqual(
    withFirst.map((item) => item.kind),
    ["folded", "row"]
  );
  assert.equal(
    foldTimeline([wayback(OCT9), wayback(OCT9 - DAY)]).every(
      (item) => item.kind === "row"
    ),
    true,
    "two archive baselines never fold"
  );
});

test("a kept row stays out of the fold, so the first-scan marker survives", () => {
  // A first scan from before `triggered_by` existed stores no trigger. The
  // web decides its "First scan recorded" marker by position, so it names
  // that row; without the option the row would read as one more quiet check.
  const legacyFirst = sync(JUN3, null);
  const rows = [sync(JUN3 + 2 * DAY), sync(JUN3 + DAY), legacyFirst];
  const folded = foldTimeline(rows);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].kind, "folded");

  const kept = foldTimeline(rows, { keep: new Set([legacyFirst.id]) });
  assert.deepEqual(
    kept.map((item) => item.kind),
    ["folded", "row"]
  );
  assert.deepEqual(kept[1], rowItem(legacyFirst));
  // Keeping a row from the middle of a run splits it.
  const middle = sync(JUN3 + DAY);
  const split = foldTimeline(
    [sync(JUN3 + 3 * DAY), sync(JUN3 + 2 * DAY), middle, sync(JUN3)],
    { keep: new Set([middle.id]) }
  );
  assert.deepEqual(
    split.map((item) => item.kind),
    ["folded", "row", "row"]
  );
});

test("the summary message picks its shape from the span and its outcome from the failures", () => {
  const dates = { sameDay: false, first: "3 Jun", last: "9 Oct 2026" };
  const sameDay = { sameDay: true, first: "9 Oct 2026", last: "9 Oct 2026" };
  assert.deepEqual(foldSummaryMessage({ count: 14, errorCount: 0 }, dates), {
    key: "fold_no_change_span",
    values: {
      count: 14,
      failed: 0,
      first: "3 Jun",
      last: "9 Oct 2026",
      date: "9 Oct 2026",
    },
  });
  assert.equal(
    foldSummaryMessage({ count: 3, errorCount: 0 }, sameDay).key,
    "fold_no_change_same_day"
  );
  assert.equal(
    foldSummaryMessage({ count: 14, errorCount: 1 }, dates).key,
    "fold_some_failed_span"
  );
  assert.equal(
    foldSummaryMessage({ count: 14, errorCount: 13 }, sameDay).key,
    "fold_some_failed_same_day"
  );
  assert.equal(
    foldSummaryMessage({ count: 3, errorCount: 3 }, dates).key,
    "fold_all_failed_span"
  );
  assert.equal(
    foldSummaryMessage({ count: 1, errorCount: 1 }, sameDay).key,
    "fold_all_failed_same_day"
  );
  for (const key of FOLD_SUMMARY_KEYS) {
    assert.match(
      key,
      /^fold_(no_change|some_failed|all_failed)_(span|same_day)$/
    );
  }
});

test("same-day and same-year compare local calendar dates", () => {
  const morning = new Date(2026, 9, 9, 0, 5).getTime();
  const night = new Date(2026, 9, 9, 23, 55).getTime();
  assert.equal(sameLocalDay(morning, night), true);
  assert.equal(sameLocalDay(night, night + 10 * 60_000), false);
  assert.equal(sameLocalYear(JUN3, OCT9), true);
  assert.equal(
    sameLocalYear(new Date(2025, 11, 31, 23).getTime(), OCT9),
    false
  );
});

// ── Copy ──────────────────────────────────────────────────────────────

const worker = fileURLToPath(
  new URL("../helpers/render-timeline-fold-copy.ts", import.meta.url)
);

function renderCopy(cases: FoldSummaryMessage[]): {
  en: string[];
  zh: string[];
} {
  const { NODE_OPTIONS: _drop, ...env } = process.env;
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", worker, JSON.stringify(cases)],
    { encoding: "utf8", env, timeout: 60_000 }
  );
  return JSON.parse(stdout) as { en: string[]; zh: string[] };
}

const locale = (name: string) =>
  (
    JSON.parse(
      readFileSync(path.join(process.cwd(), "locales", `${name}.json`), "utf8")
    ) as { timeline: Record<string, string> }
  ).timeline;

test("every fold message exists in both locales and carries no em dash", () => {
  for (const bundle of [locale("en"), locale("zh")]) {
    for (const key of FOLD_SUMMARY_KEYS) {
      assert.equal(typeof bundle[key], "string", key);
      assert.doesNotMatch(bundle[key], EM_DASH, `${key} carries an em dash`);
    }
  }
});

test("the rendered English copy is the iOS summary, word for word", () => {
  const span = { sameDay: false, first: "3 Jun", last: "9 Oct 2026" };
  const day = { sameDay: true, first: "9 Oct 2026", last: "9 Oct 2026" };
  const cases: [FoldSummaryMessage, string][] = [
    [
      foldSummaryMessage({ count: 14, errorCount: 0 }, span),
      "Checked 14 times, 3 Jun to 9 Oct 2026, no change",
    ],
    [
      foldSummaryMessage({ count: 2, errorCount: 0 }, span),
      "Checked twice, 3 Jun to 9 Oct 2026, no change",
    ],
    [
      foldSummaryMessage({ count: 3, errorCount: 0 }, day),
      "Checked 3 times on 9 Oct 2026, no change",
    ],
    [
      foldSummaryMessage({ count: 2, errorCount: 0 }, day),
      "Checked twice on 9 Oct 2026, no change",
    ],
    [
      foldSummaryMessage({ count: 1, errorCount: 0 }, day),
      "Checked once on 9 Oct 2026, no change",
    ],
    [
      foldSummaryMessage({ count: 14, errorCount: 1 }, span),
      "Checked 14 times, 3 Jun to 9 Oct 2026, no change, 1 check failed",
    ],
    [
      foldSummaryMessage({ count: 14, errorCount: 2 }, span),
      "Checked 14 times, 3 Jun to 9 Oct 2026, no change, 2 checks failed",
    ],
    [
      foldSummaryMessage({ count: 3, errorCount: 3 }, span),
      "Checked 3 times, 3 Jun to 9 Oct 2026, every check failed",
    ],
    [
      foldSummaryMessage({ count: 2, errorCount: 2 }, day),
      "Checked twice on 9 Oct 2026, every check failed",
    ],
    [
      foldSummaryMessage({ count: 1, errorCount: 1 }, day),
      "Checked once on 9 Oct 2026, failed",
    ],
  ];
  const rendered = renderCopy(cases.map(([message]) => message));
  cases.forEach(([message, expected], i) => {
    assert.equal(rendered.en[i], expected, message.key);
  });
  rendered.zh.forEach((text, i) => {
    assert.ok(text.length > 0, `zh ${cases[i][0].key} rendered empty`);
    assert.doesNotMatch(
      text,
      /[{}]/,
      `zh ${cases[i][0].key} left a placeholder`
    );
    assert.doesNotMatch(
      text,
      EM_DASH,
      `zh ${cases[i][0].key} carries an em dash`
    );
    // The dates passed in are English fixtures; the fixed words must not be.
    assert.doesNotMatch(
      text,
      /Checked|no change|checks? failed|times|twice|once/,
      `zh ${cases[i][0].key} fell back to English`
    );
  });
});

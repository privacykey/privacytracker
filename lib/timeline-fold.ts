/**
 * Folds the per-app History timeline so the last real change is what the
 * eye lands on.
 *
 * The server writes one `privacy_snapshots` row per check whether or not
 * the check found anything, and the privacy-policy rescrape adds a row for
 * every fetch that came back the same text, or failed. On an app checked
 * daily those quiet rows outnumber the changes many times over and bury
 * the date of the last change under "No changes detected". `foldTimeline`
 * groups each run of two or more consecutive quiet rows into one item
 * carrying the count, the span of dates and how many checks failed;
 * everything that says something (a label diff, a policy first capture or
 * change, an archive row, a review action, the first scan) stays an item
 * of its own, and so does a lone quiet row.
 *
 * The rule is the one the iOS companion uses (privacykey/privacytracker-ios
 * `TimelineFold.swift`, PR #13), so the two surfaces agree on what folds.
 * Change the two together.
 *
 * Pure and client-safe: no React, no SQLite. Works on the rows as the
 * timeline renders them, newest first with review rows interleaved, and
 * just as well oldest first.
 */

import type {
  ChangeEntry,
  ChangelogRow,
  SnapshotChangelogRow,
} from "./changelog-types";

/**
 * What a quiet row was: a sync that found the label as it was, or a
 * policy rescrape that found the same text or failed.
 */
export type QuietKind = "label_unchanged" | "policy_same" | "policy_error";

/** Whether `entry` records a privacy-policy fetch rather than a label diff. */
export function isPolicyEntry(
  entry: Pick<ChangeEntry, "category" | "type">
): boolean {
  return entry.category === "privacy-policy" || entry.type === "policy";
}

/**
 * Whether a row is a check that found nothing, and what kind. A row that
 * was flagged for review (`changes_detected > 0`), came from the archive,
 * or is the first scan (`triggered_by: 'import'` with nothing to diff,
 * which marks where tracking began) is never quiet, and neither is a
 * review action. A policy entry with no `policy_event` reads as `changed`,
 * as the timeline card does, so it is never quiet either.
 */
export function quietKind(row: ChangelogRow): QuietKind | null {
  if (row.kind !== "snapshot") {
    return null;
  }
  if (row.source === "wayback" || row.changes_detected > 0) {
    return null;
  }
  const entries = row.changes_summary ?? [];
  if (entries.length === 0) {
    return row.triggered_by === "import" ? null : "label_unchanged";
  }
  let sawError = false;
  for (const entry of entries) {
    if (!isPolicyEntry(entry)) {
      return null;
    }
    if (entry.policy_event === "same") {
      continue;
    }
    if (entry.policy_event === "error") {
      sawError = true;
      continue;
    }
    // `first`, `changed`, or absent.
    return null;
  }
  return sawError ? "policy_error" : "policy_same";
}

export function isQuietRow(row: ChangelogRow): boolean {
  return quietKind(row) !== null;
}

/** Two or more consecutive quiet rows, folded into one item. */
export interface FoldedRun {
  /** How many rows the run holds; always at least two. */
  count: number;
  /**
   * How many of the rows were failed policy checks. The fold is tinted
   * red when this is above zero.
   */
  errorCount: number;
  /**
   * Keyed on the first row, which stays the same when the run grows at
   * the other end as older pages arrive.
   */
  id: string;
  includesErrors: boolean;
  kind: "folded";
  /** Epoch ms of the newest row in the run. */
  newest: number;
  /** Epoch ms of the oldest row in the run. */
  oldest: number;
  /** The rows, in the order they were given. */
  rows: SnapshotChangelogRow[];
}

export type TimelineItem =
  | { kind: "row"; id: string; row: ChangelogRow }
  | FoldedRun;

export const FOLD_ID_PREFIX = "fold:";

export function foldId(firstRow: { id: string }): string {
  return `${FOLD_ID_PREFIX}${firstRow.id}`;
}

export interface FoldOptions {
  /**
   * Ids of rows to keep out of any fold whatever they hold. The web
   * timeline decides its "First scan recorded" marker by position (the
   * oldest loaded snapshot when nothing older is left to fetch) rather
   * than by trigger, so it names that row here: a legacy first scan with
   * no stored trigger would otherwise be counted as one more quiet check.
   */
  keep?: ReadonlySet<string>;
}

/**
 * Groups every run of two or more consecutive quiet rows into one
 * `folded` item. The rows must already be sorted by date, in either
 * direction; the output keeps their order, and a lone quiet row stays a
 * `row` of its own.
 */
export function foldTimeline(
  rows: readonly ChangelogRow[],
  options: FoldOptions = {}
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let run: SnapshotChangelogRow[] = [];
  let errors = 0;

  const flush = () => {
    const first = run[0];
    if (first && run.length === 1) {
      items.push({ kind: "row", id: first.id, row: first });
    } else if (first) {
      let newest = first.scraped_at;
      let oldest = first.scraped_at;
      for (const row of run) {
        newest = Math.max(newest, row.scraped_at);
        oldest = Math.min(oldest, row.scraped_at);
      }
      items.push({
        kind: "folded",
        id: foldId(first),
        rows: run,
        count: run.length,
        newest,
        oldest,
        errorCount: errors,
        includesErrors: errors > 0,
      });
    }
    run = [];
    errors = 0;
  };

  for (const row of rows) {
    const kind = options.keep?.has(row.id) ? null : quietKind(row);
    if (kind !== null && row.kind === "snapshot") {
      run.push(row);
      if (kind === "policy_error") {
        errors += 1;
      }
    } else {
      flush();
      items.push({ kind: "row", id: row.id, row });
    }
  }
  flush();
  return items;
}

/**
 * The `timeline.*` message that describes a fold, chosen from how many
 * checks failed and whether the run sits on one calendar day:
 *
 *   "Checked 14 times, 3 Jun to 9 Oct 2026, no change"
 *   "Checked twice on 9 Oct 2026, no change"
 *   "Checked 14 times, 3 Jun to 9 Oct 2026, no change, 1 check failed"
 *   "Checked 3 times, 3 Jun to 9 Oct 2026, every check failed"
 *
 * The messages themselves live in locales/en.json, as ICU plurals on
 * `count` and `failed`, and mirror iOS `TimelineFold.summary`. `first`
 * and `last` are the span's dates already formatted for the user's date
 * preference; `date` is `last` again for the one-day shape.
 */
export type FoldSummaryKey =
  | "fold_no_change_span"
  | "fold_no_change_same_day"
  | "fold_some_failed_span"
  | "fold_some_failed_same_day"
  | "fold_all_failed_span"
  | "fold_all_failed_same_day";

export const FOLD_SUMMARY_KEYS: readonly FoldSummaryKey[] = [
  "fold_no_change_span",
  "fold_no_change_same_day",
  "fold_some_failed_span",
  "fold_some_failed_same_day",
  "fold_all_failed_span",
  "fold_all_failed_same_day",
];

export interface FoldSummaryMessage {
  key: FoldSummaryKey;
  values: {
    count: number;
    date: string;
    failed: number;
    first: string;
    last: string;
  };
}

export function foldSummaryMessage(
  run: Pick<FoldedRun, "count" | "errorCount">,
  dates: { sameDay: boolean; first: string; last: string }
): FoldSummaryMessage {
  const outcome =
    run.errorCount <= 0
      ? "no_change"
      : run.errorCount >= run.count
        ? "all_failed"
        : "some_failed";
  const shape = dates.sameDay ? "same_day" : "span";
  return {
    key: `fold_${outcome}_${shape}`,
    values: {
      count: run.count,
      failed: run.errorCount,
      first: dates.first,
      last: dates.last,
      date: dates.last,
    },
  };
}

/** Whether two instants fall on the same calendar day, in local time. */
export function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/** Whether two instants fall in the same calendar year, in local time. */
export function sameLocalYear(a: number, b: number): boolean {
  return new Date(a).getFullYear() === new Date(b).getFullYear();
}

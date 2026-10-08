/**
 * What App Detail → "Reconstruct this app's history" says after
 * `POST /api/apps/[id]/import-history`.
 *
 * The Rust change-finding import (docs/WAYBACK_IMPORT.md, P2) adds
 * `reads`, `changes`, `labelVersions`, `firstCaptureMs`, `lastCaptureMs`
 * and `windows` to the result, so the card can answer in label changes
 * rather than snapshot rows. Without them (the Node rollback) the card
 * says what it always has. A throttled archive answers 503
 * `archive_unavailable` with `retryAfterMs`, which becomes a clock time.
 *
 * Coverage (P5) adds `lookupUrl`, `historyStartsAt`, `historyStartsLate`
 * and `alternateUrls`: the server judges a late start (it also knows the
 * app's release date), and the card offers to add an older App Store
 * address when it does. Absent, the card judges a late start from the
 * first capture alone and offers nothing to add.
 *
 * Pure and client-safe; the component translates the keys returned here.
 */

import { MAX_ALTERNATE_URLS } from "./wayback-alternate-urls";
import { parseRetryAfterMs } from "./wayback-time";

/** The earliest date the importer reads: Apple began publishing privacy
 *  labels on the web App Store in February 2021. */
export const WAYBACK_HISTORY_FLOOR_MS = Date.UTC(2021, 1, 1);

/** How far past the floor an app's first capture may start before the
 *  card says its archived history starts late. */
export const WAYBACK_LATE_START_MS = 180 * 24 * 60 * 60 * 1000;

export interface WaybackAppImportResult {
  /** The older addresses stored for the app; null when the route does
   *  not report them (it predates coverage). */
  alternateUrls: string[] | null;
  changes: number | null;
  failed: number;
  firstCaptureMs: number | null;
  /** When the app's archived history starts, every address included. */
  historyStartsAt: number | null;
  /** The server's verdict on a late start; null when not reported. */
  historyStartsLate: boolean | null;
  imported: number;
  labelVersions: number | null;
  lastCaptureMs: number | null;
  /** The address the import looked up (the US storefront's, usually). */
  lookupUrl: string | null;
  reads: number | null;
  skipped: number;
  snapshotsRequested: number;
  unchanged: number;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number {
  const n = finite(value);
  return n !== null && n > 0 ? n : 0;
}

function optionalCount(value: unknown): number | null {
  const n = finite(value);
  return n === null ? null : Math.max(0, n);
}

/** The route's `result`, or null when the body has none. */
export function parseWaybackAppImportResult(
  raw: unknown
): WaybackAppImportResult | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const first = finite(r.firstCaptureMs);
  const last = finite(r.lastCaptureMs);
  const startsAt = finite(r.historyStartsAt);
  return {
    imported: count(r.imported),
    unchanged: count(r.unchanged),
    skipped: count(r.skipped),
    failed: count(r.failed),
    snapshotsRequested: count(r.snapshotsRequested),
    reads: optionalCount(r.reads),
    changes: optionalCount(r.changes),
    labelVersions: optionalCount(r.labelVersions),
    firstCaptureMs: first !== null && first > 0 ? first : null,
    lastCaptureMs: last !== null && last > 0 ? last : null,
    lookupUrl:
      typeof r.lookupUrl === "string" && r.lookupUrl ? r.lookupUrl : null,
    historyStartsAt: startsAt !== null && startsAt > 0 ? startsAt : null,
    historyStartsLate:
      typeof r.historyStartsLate === "boolean" ? r.historyStartsLate : null,
    alternateUrls: Array.isArray(r.alternateUrls)
      ? r.alternateUrls.filter(
          (url): url is string => typeof url === "string" && url.length > 0
        )
      : null,
  };
}

/** True when the archive's copies of this app start well after Feb 2021. */
export function archivedHistoryStartsLate(
  firstCaptureMs: number | null
): boolean {
  return (
    firstCaptureMs !== null &&
    firstCaptureMs > WAYBACK_HISTORY_FLOOR_MS + WAYBACK_LATE_START_MS
  );
}

/** A message under `app_detail.history_import`, with its values. Dates
 *  stay epoch ms so the component formats them with the user's setting. */
export type WaybackImportMessage =
  | { key: "result_imported"; values: { count: number } }
  | { key: "result_nothing_new" }
  | { key: "result_changes"; values: { count: number } }
  | { key: "result_changes_on_file"; values: { count: number } }
  | { key: "result_no_archive" }
  | { key: "result_no_labels" }
  | { key: "note_failed"; values: { count: number } }
  | { key: "note_snapshot_requested" }
  | { key: "note_reads"; values: { count: number } }
  | { key: "note_starts_on"; values: { dateMs: number } };

/** The card's older-addresses block, from a result that reports them. */
export interface WaybackAlternateState {
  /** Room for another address while history still starts late. */
  canAdd: boolean;
  /** History starts late: say why, and offer to add an address. */
  late: boolean;
  /** The stored older addresses, as the route returned them. */
  urls: string[];
}

export interface WaybackImportOutcome {
  /** Null when the route predates coverage, or there is nothing to show
   *  (history does not start late and no address is stored). */
  alternates: WaybackAlternateState | null;
  headline: WaybackImportMessage;
  notes: WaybackImportMessage[];
  /** Rows written to the timeline; above zero, the timeline refetches. */
  rowsAdded: number;
}

function alternateState(
  result: WaybackAppImportResult
): WaybackAlternateState | null {
  const urls = result.alternateUrls ?? [];
  const late = result.historyStartsLate === true;
  if (!late && urls.length === 0) {
    return null;
  }
  return { late, urls, canAdd: late && urls.length < MAX_ALTERNATE_URLS };
}

/**
 * The headline and notes for a finished import.
 *
 * Rows written are `imported + unchanged` on both backends: `imported`
 * counts only rows whose labels differ from the capture before them, so
 * counting it alone said "Added 1 snapshot" after adding 21.
 */
export function describeWaybackAppImport(
  result: WaybackAppImportResult
): WaybackImportOutcome {
  const rowsAdded = result.imported + result.unchanged;
  const fixNote: WaybackImportMessage | null =
    result.failed > 0
      ? { key: "note_failed", values: { count: result.failed } }
      : result.snapshotsRequested > 0
        ? { key: "note_snapshot_requested" }
        : null;

  if (result.changes === null) {
    // Pre-redesign result: rows, and one note at most, as before.
    return {
      alternates: null,
      headline:
        rowsAdded > 0
          ? { key: "result_imported", values: { count: rowsAdded } }
          : { key: "result_nothing_new" },
      notes: fixNote ? [fixNote] : [],
      rowsAdded,
    };
  }

  // No index range, nothing read, and nothing on file with labels: the
  // archive has no copy of this app. (`changes` and `labelVersions` count
  // the rows already stored, so an app with imported history never
  // reads as having none.)
  if (
    result.firstCaptureMs === null &&
    !result.reads &&
    !result.labelVersions
  ) {
    return {
      alternates: alternateState(result),
      headline: { key: "result_no_archive" },
      notes: [],
      rowsAdded,
    };
  }

  const notes: WaybackImportMessage[] = [];
  // The server's verdict when it gives one: it also weighs the app's
  // release date, so an app first published in 2023 does not start late.
  const startsAt = result.historyStartsAt ?? result.firstCaptureMs;
  const late =
    result.historyStartsLate ??
    archivedHistoryStartsLate(result.firstCaptureMs);
  if (late && startsAt !== null) {
    notes.push({ key: "note_starts_on", values: { dateMs: startsAt } });
  }
  if (fixNote) {
    notes.push(fixNote);
  } else if (result.reads) {
    notes.push({ key: "note_reads", values: { count: result.reads } });
  }
  let headline: WaybackImportMessage;
  if (result.labelVersions === 0 && result.reads) {
    // Pages were read but none carried labels (the first weeks of 2021,
    // or pages that were not product pages): "no changes" would imply
    // the labels stayed the same.
    headline = { key: "result_no_labels" };
  } else if (result.changes > 0 && rowsAdded === 0) {
    headline = {
      key: "result_changes_on_file",
      values: { count: result.changes },
    };
  } else {
    headline = { key: "result_changes", values: { count: result.changes } };
  }
  return { alternates: alternateState(result), headline, notes, rowsAdded };
}

/** Why an import did not finish, for the card's alert line. */
export type WaybackImportFailure =
  | { key: "failed_archive_busy_until"; values: { retryAtMs: number } }
  | { key: "failed_archive_busy" }
  | { key: "failed_status"; values: { status: number } }
  | { message: string };

/**
 * A non-OK response. archive.org throttling is common and clears by
 * itself, so it gets plain words and, when the server said how long, the
 * time to try again; anything else is the route's own message (no App
 * Store URL, our own rate limit), else the status code.
 */
export function describeWaybackAppImportFailure(
  status: number,
  body: { code?: unknown; error?: unknown; retryAfterMs?: unknown } | null,
  retryAfterHeader: string | null,
  now: number = Date.now()
): WaybackImportFailure {
  if (body?.code === "archive_unavailable") {
    const waitMs = parseRetryAfterMs(body.retryAfterMs, retryAfterHeader, now);
    return waitMs === null
      ? { key: "failed_archive_busy" }
      : {
          key: "failed_archive_busy_until",
          values: { retryAtMs: now + waitMs },
        };
  }
  if (typeof body?.error === "string" && body.error.length > 0) {
    return { message: body.error };
  }
  return { key: "failed_status", values: { status } };
}

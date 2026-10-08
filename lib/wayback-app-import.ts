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
 * Pure and client-safe; the component translates the keys returned here.
 */

import { parseRetryAfterMs } from "./wayback-time";

/** The earliest date the importer reads: Apple began publishing privacy
 *  labels on the web App Store in February 2021. */
export const WAYBACK_HISTORY_FLOOR_MS = Date.UTC(2021, 1, 1);

/** How far past the floor an app's first capture may start before the
 *  card says its archived history starts late. */
export const WAYBACK_LATE_START_MS = 180 * 24 * 60 * 60 * 1000;

export interface WaybackAppImportResult {
  changes: number | null;
  failed: number;
  firstCaptureMs: number | null;
  imported: number;
  labelVersions: number | null;
  lastCaptureMs: number | null;
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
  | { key: "note_failed"; values: { count: number } }
  | { key: "note_snapshot_requested" }
  | { key: "note_reads"; values: { count: number } }
  | { key: "note_starts_on"; values: { dateMs: number } };

export interface WaybackImportOutcome {
  headline: WaybackImportMessage;
  notes: WaybackImportMessage[];
  /** Rows written to the timeline; above zero, the timeline refetches. */
  rowsAdded: number;
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
      headline:
        rowsAdded > 0
          ? { key: "result_imported", values: { count: rowsAdded } }
          : { key: "result_nothing_new" },
      notes: fixNote ? [fixNote] : [],
      rowsAdded,
    };
  }

  if (result.firstCaptureMs === null && !result.reads) {
    return { headline: { key: "result_no_archive" }, notes: [], rowsAdded };
  }

  const notes: WaybackImportMessage[] = [];
  if (archivedHistoryStartsLate(result.firstCaptureMs)) {
    notes.push({
      key: "note_starts_on",
      values: { dateMs: result.firstCaptureMs as number },
    });
  }
  if (fixNote) {
    notes.push(fixNote);
  } else if (result.reads) {
    notes.push({ key: "note_reads", values: { count: result.reads } });
  }
  return {
    headline:
      result.changes > 0 && rowsAdded === 0
        ? { key: "result_changes_on_file", values: { count: result.changes } }
        : { key: "result_changes", values: { count: result.changes } },
    notes,
    rowsAdded,
  };
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

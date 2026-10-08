/**
 * The window a reconstructed label change happened in, for the change
 * history timeline.
 *
 * The change-finding import (docs/WAYBACK_IMPORT.md, P2) stores two rows
 * per change: the last capture that still had the old labels (no
 * changes) and the first with the new ones. The change happened between
 * the two, so the change row says "Changed between <date> and <date>"
 * rather than implying archive.org saw it on the day of its capture. The
 * quarterly import's rows read the same way, a quarter apart.
 *
 * Pure and client-safe. Works on the rows as the timeline renders them:
 * newest first, review rows interleaved.
 */

interface TimelineRowLike {
  changes_summary?: readonly unknown[] | null;
  kind: string;
  scraped_at: number;
  source?: string | null;
}

export interface WaybackChangeWindow {
  /** The last capture with the old labels. */
  fromMs: number;
  /** The first capture with the new labels: the change row's own date. */
  toMs: number;
}

const hasChanges = (row: TimelineRowLike) =>
  (row.changes_summary?.length ?? 0) > 0;

/**
 * For the wayback change row at `index`, the window between it and the
 * unchanged wayback row directly before it in time (the next snapshot in
 * the list; review rows are skipped). Null for any other row, or when the
 * row before it is live, changed, or not loaded yet.
 */
export function waybackChangeWindow(
  rows: readonly TimelineRowLike[],
  index: number
): WaybackChangeWindow | null {
  const row = rows[index];
  if (
    row?.kind !== "snapshot" ||
    row.source !== "wayback" ||
    !hasChanges(row)
  ) {
    return null;
  }
  for (let i = index + 1; i < rows.length; i += 1) {
    const older = rows[i];
    if (older.kind !== "snapshot") {
      continue;
    }
    if (
      older.source !== "wayback" ||
      hasChanges(older) ||
      !(older.scraped_at < row.scraped_at)
    ) {
      return null;
    }
    return { fromMs: older.scraped_at, toMs: row.scraped_at };
  }
  return null;
}

/**
 * Historical import — reconstruct privacy-label history from the Internet
 * Archive's Wayback Machine. For every app, pulls one snapshot per quarter
 * back to APP_STORE_HISTORICAL_FLOOR (Q1 2021).
 *
 * Flow per app:
 *   1. computeHistoricalTargets() → chronological list of target dates
 *      (quarterly by default, plus an install-date anchor).
 *   2. List every capture of the App Store product page in one CDX index
 *      request and pick the closest capture per target locally; fall back
 *      to per-target archive.org/wayback/available probes if the index is
 *      unreachable. A throttled archive (429 / 5xx) throws
 *      `WaybackUnavailableError` rather than reading as "no capture".
 *   3. Fetch archived HTML via the `id_` replay variant (strips toolbar)
 *      and parse either the modern serialized-server-data blob or the
 *      historical shoebox shape.
 *   4. Build a `PrivacyTypeSnapshot[]`, diff against the immediately
 *      preceding snapshot in the DB, and write via `saveSnapshot` with
 *      source='wayback', scrapedAt = capture timestamp, waybackUrl = replay
 *      URL — in a transaction that also re-diffs the wayback row that now
 *      follows it, so the chain of diffs stays consistent as rows land out
 *      of order. The oldest row is a baseline and carries no changes.
 *   5. If the archive has no capture within tolerance of *today*, ask Save
 *      Page Now to archive the live page once so the next import has a
 *      recent capture to work from.
 *
 * Wayback rows never bump `apps.changeCount` — they are history, not a new
 * change to review. Self-contained on purpose: the live path also writes
 * to apps / privacy_types tables which must stay pinned to current state.
 */

import {
  appendWaybackAttemptEntry,
  diffSnapshots,
  saveSnapshot,
} from "./changelog";
import type {
  ChangeEntry,
  PrivacyCategorySnapshot,
  PrivacyTypeSnapshot,
} from "./changelog-types";
import db from "./db";
// extractFromShoebox parses the legacy `shoebox-media-api-cache-apps`
// script tag (Jan 2021 – Nov 2025). Shared with the live scraper so the
// historical schema map stays in one place.
import { extractFromShoebox } from "./scraper";
import { safeFetch } from "./security";
import {
  isAbortError,
  isWaybackUnavailableError,
  listWaybackCaptures,
  lookupWaybackSnapshotNear,
  parseRetryAfterMs,
  parseWaybackTimestampMs,
  submitToWaybackSaveNow,
  type WaybackCapture,
  type WaybackSnapshot,
  WaybackUnavailableError,
} from "./wayback";

/**
 * Earliest Wayback target date the importer will probe. Anchored at
 * 1 Feb 2021 (Q1 2021) so the quarter walker aligns cleanly with the
 * 3-month buckets. Apple started server-rendering privacy data in
 * `shoebox-media-api-cache-apps` in late Jan 2021. APP_STORE_WEB_LAUNCH
 * is kept as an alias for callers that still reference the old name.
 */
export const APP_STORE_HISTORICAL_FLOOR = new Date(Date.UTC(2021, 1, 1)); // 1 Feb 2021
export const APP_STORE_WEB_LAUNCH = APP_STORE_HISTORICAL_FLOOR;

/**
 * Quarterly cadence: one attempt every 3 calendar months (not a fixed
 * 90d delta — fixed deltas drift relative to user-visible quarters).
 */
const QUARTER_MONTHS = 3;

/**
 * Maximum acceptable drift between a target date and the actual capture.
 * Beyond this we treat the target as unavailable, otherwise a single
 * unrelated capture could stand in for the whole quarter.
 */
const CAPTURE_DRIFT_TOLERANCE_MS = 45 * 24 * 60 * 60 * 1000; // 45 days

/**
 * Offsets (in days) walked outward from the quarter anchor when the
 * initial availability probe returns nothing or falls outside drift
 * tolerance. Symmetric and stays inside drift tolerance — we widen
 * coverage without weakening the drift guarantee.
 */
const WAYBACK_FALLBACK_OFFSET_DAYS = [0, -14, 14, -28, 28, -42, 42];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

/**
 * How close an existing wayback row may sit to a target before the target
 * is treated as already covered. Half the cadence, capped at the drift
 * tolerance: 45 days for the quarterly default, 15 days for a monthly
 * reconstruction. A fixed 45-day window used to make monthly imports skip
 * every other month as "already covered".
 */
export function dedupeWindowForInterval(intervalMonths: number): number {
  const months = Math.max(1, Math.floor(intervalMonths));
  return Math.min(
    CAPTURE_DRIFT_TOLERANCE_MS,
    Math.round((months * THIRTY_DAYS_MS) / 2)
  );
}

/** Cap on how much archived HTML we'll pull per page. Matches the live scraper. */
const ARCHIVE_HTML_MAX_BYTES = 4 * 1024 * 1024;

const ARCHIVE_HTML_TIMEOUT_MS = 30_000;

const WAYBACK_HOSTS = ["web.archive.org", "archive.org"];

/**
 * Options for {@link computeHistoricalTargets}.
 */
export interface HistoricalTargetOptions {
  /**
   * Extra dates to probe regardless of the interval grid — typically the
   * user's install date (`apps.firstSeen`) so the reconstruction always
   * tries to capture the privacy state from when they started tracking the
   * app. Anchors outside `[floor, now]` are ignored; anchors within a day
   * of an existing target are de-duped.
   */
  anchorDates?: Date[];
  /**
   * Months between successive targets. Defaults to {@link QUARTER_MONTHS}
   * (one snapshot per calendar quarter). Lower values (e.g. `1` = monthly)
   * produce a denser reconstruction at the cost of more archive.org probes.
   * Clamped to `>= 1`.
   */
  intervalMonths?: number;
}

/**
 * List of target dates to attempt, oldest first. Steps back from `today`
 * in `intervalMonths` increments down to the launch anchor, then folds in
 * any `anchorDates` (e.g. the install date) that fall inside the window.
 * `today` is clamped to launch if earlier.
 */
export function computeHistoricalTargets(
  today: Date = new Date(),
  launchDate: Date = APP_STORE_WEB_LAUNCH,
  options: HistoricalTargetOptions = {}
): Date[] {
  const intervalMonths = Math.max(
    1,
    Math.floor(options.intervalMonths ?? QUARTER_MONTHS)
  );
  const floor = launchDate.getTime();
  const now = Math.max(today.getTime(), floor);

  const targets: number[] = [];

  // Walk backwards from today in `intervalMonths` steps; the launch date is
  // appended explicitly so we always cover the first Wayback-available
  // moment even if the step overshoots.
  const cursor = new Date(now);
  cursor.setUTCMonth(cursor.getUTCMonth() - intervalMonths);
  while (cursor.getTime() > floor) {
    targets.push(cursor.getTime());
    cursor.setUTCMonth(cursor.getUTCMonth() - intervalMonths);
  }
  targets.push(floor);

  // Install anchors (and any other explicit dates) — clamp into the window so
  // backfill always probes the install era even when it doesn't line up with
  // the interval grid.
  for (const anchor of options.anchorDates ?? []) {
    const ms = anchor.getTime();
    if (Number.isFinite(ms) && ms >= floor && ms <= now) {
      targets.push(ms);
    }
  }

  // Sort ascending so importers can diff chronologically.
  targets.sort((a, b) => a - b);

  // De-duplicate: collapse targets within a day of their predecessor so an
  // anchor that lands on (or beside) an interval target — or a cursor that
  // lands exactly on the floor — doesn't double-probe the same capture.
  const unique: Date[] = [];
  for (const ts of targets) {
    if (
      unique.length === 0 ||
      ts - unique[unique.length - 1].getTime() > ONE_DAY_MS
    ) {
      unique.push(new Date(ts));
    }
  }
  return unique;
}

/**
 * Quarterly cadence wrapper kept for back-compat — existing callers and the
 * docs reference it by name. Equivalent to {@link computeHistoricalTargets}
 * with the default 3-month interval and no anchors.
 */
export function computeQuarterlyTargets(
  today: Date = new Date(),
  launchDate: Date = APP_STORE_WEB_LAUNCH
): Date[] {
  return computeHistoricalTargets(today, launchDate, {
    intervalMonths: QUARTER_MONTHS,
  });
}

export interface ImportAppHistoryOptions {
  /**
   * Skip targets that already have a wayback snapshot within this many
   * milliseconds. Defaults to {@link dedupeWindowForInterval} of the
   * cadence (45 days quarterly, 15 days monthly) so rerunning the import
   * doesn't double-insert quarters you've already pulled.
   */
  dedupeWindowMs?: number;
  /**
   * Months between reconstructed snapshots. Defaults to quarterly
   * (`QUARTER_MONTHS` = 3). Pass `1` for a denser monthly reconstruction.
   * Threaded straight into {@link computeHistoricalTargets}.
   */
  intervalMonths?: number;
  /** Optional progress hook — called once per target. */
  onProgress?: (event: ImportProgressEvent) => void;
  /** Optional cancellation signal for bulk runs. */
  signal?: AbortSignal;
  /** Supply a clock for tests; defaults to `new Date()`. */
  today?: Date;
}

export type ImportTargetOutcome =
  | "imported"
  | "unchanged"
  | "skipped_existing"
  | "skipped_no_capture"
  | "skipped_drift"
  | "skipped_parse_failure"
  | "skipped_fetch_failure"
  /** Save Page Now was triggered to archive the live page for a future import. */
  | "requested_snapshot"
  /** Save Page Now was attempted but failed; reason on `errorMessage`. */
  | "skipped_save_now_failed";

export interface ImportTargetResult {
  /** The timestamp Wayback actually returned, if a capture was found. */
  captureDate?: number;
  /** Changes detected against the preceding snapshot, if any were written. */
  changeCount?: number;
  /** Set when `outcome` describes a failure. */
  errorMessage?: string;
  outcome: ImportTargetOutcome;
  /** Populated for `requested_snapshot` — the freshly-submitted Save Page Now URL. */
  saveNowUrl?: string;
  /** The quarter we aimed at, as epoch-ms. */
  targetDate: number;
  /** The final web.archive.org URL we parsed, if any. */
  waybackUrl?: string;
}

export interface ImportAppHistoryResult {
  appId: string;
  attempted: number;
  failed: number;
  imported: number;
  skipped: number;
  /** Empty quarters where Save Page Now was fired. Reported as "requested N fresh snapshots". */
  snapshotsRequested: number;
  targets: ImportTargetResult[];
  unchanged: number;
}

export interface ImportProgressEvent {
  appId: string;
  captureDate?: number;
  changeCount?: number;
  outcome: ImportTargetOutcome;
  saveNowUrl?: string;
  targetDate: number;
  waybackUrl?: string;
}

interface ArchiveAppRow {
  id: string;
  name: string;
  url: string;
}

/**
 * Full quarterly backfill for one app. Best-effort per-target — a missing
 * capture, parse failure, or network blip on one quarter does not abort
 * the rest.
 */
export async function importAppHistory(
  app: ArchiveAppRow,
  options: ImportAppHistoryOptions = {}
): Promise<ImportAppHistoryResult> {
  const today = options.today ?? new Date();
  const todayMs = today.getTime();
  const intervalMonths = Math.max(
    1,
    Math.floor(options.intervalMonths ?? QUARTER_MONTHS)
  );
  const dedupeWindowMs =
    options.dedupeWindowMs ?? dedupeWindowForInterval(intervalMonths);
  const onProgress = options.onProgress;
  const signal = options.signal;

  // Anchor a target on the user's install date (apps.firstSeen) so the
  // reconstruction always tries to capture the privacy state from when they
  // started tracking the app — that install-era snapshot is exactly the
  // baseline the "Since you added this app" view diffs against. Skipped when
  // the install is recent enough that the first live scrape already covers
  // it: a fresh install would otherwise probe "today", find nothing, and
  // request a Save Page Now for a moment the live sync already has on
  // record. Falls back to the plain interval grid when firstSeen is unknown
  // (legacy 0 rows).
  const anchorDates: Date[] = [];
  const firstSeenRow = db
    .prepare("SELECT firstSeen FROM apps WHERE id = ?")
    .get(app.id) as { firstSeen: number } | undefined;
  const firstSeenMs = Number(firstSeenRow?.firstSeen) || 0;
  if (firstSeenMs > 0 && todayMs - firstSeenMs > dedupeWindowMs) {
    anchorDates.push(new Date(firstSeenMs));
  }

  const targets = computeHistoricalTargets(today, APP_STORE_WEB_LAUNCH, {
    intervalMonths,
    anchorDates,
  });

  const existing = db
    .prepare(
      `SELECT scraped_at, wayback_snapshot_url
         FROM privacy_snapshots
        WHERE app_id = ? AND source = 'wayback'`
    )
    .all(app.id) as Array<{
    scraped_at: number;
    wayback_snapshot_url: string | null;
  }>;
  // Capture URLs already on file, scheme-normalised: the availability API
  // hands back `http://web.archive.org/…` while the CDX path builds
  // `https://…`, and both must dedupe against each other.
  const existingUrls = new Set<string>();
  for (const row of existing) {
    const key = normaliseWaybackUrl(row.wayback_snapshot_url);
    if (key) {
      existingUrls.add(key);
    }
  }

  const result: ImportAppHistoryResult = {
    appId: app.id,
    attempted: 0,
    imported: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    snapshotsRequested: 0,
    targets: [],
  };

  // One CDX request lists every capture of the page, so each target's
  // closest capture is then a local pick. `null` means the index was
  // unreachable or malformed — fall back to the per-target availability
  // walk. A throttled archive throws instead: every later probe for this
  // app would be throttled too, and the bulk runner knows how to back off
  // from `WaybackUnavailableError`.
  throwIfAborted(signal);
  const captures = await listWaybackCaptures(app.url, {
    from: APP_STORE_WEB_LAUNCH,
    signal,
  });

  // Fallback-path proxy for "the archive has nothing recent": whether the
  // newest target ended up covered (imported now or already on file).
  let newestTargetCovered = false;
  const newestTargetMs = targets[targets.length - 1]?.getTime();

  for (const target of targets) {
    throwIfAborted(signal);
    result.attempted++;
    const targetMs = target.getTime();
    const isNewestTarget = targetMs === newestTargetMs;

    // Skip targets we've already covered within the dedupe window.
    const alreadyCovered = existing.some(
      (row) => Math.abs(row.scraped_at - targetMs) <= dedupeWindowMs
    );
    if (alreadyCovered) {
      if (isNewestTarget) {
        newestTargetCovered = true;
      }
      const info: ImportTargetResult = {
        targetDate: targetMs,
        outcome: "skipped_existing",
      };
      result.targets.push(info);
      result.skipped++;
      onProgress?.({ appId: app.id, ...info });
      continue;
    }

    let walk: WaybackProbeResult;
    try {
      walk = captures
        ? pickCaptureFromIndex(captures, targetMs, CAPTURE_DRIFT_TOLERANCE_MS)
        : await findCaptureWithinTolerance(
            app.url,
            target,
            CAPTURE_DRIFT_TOLERANCE_MS,
            signal
          );
    } catch (error) {
      if (isAbortError(error) || isWaybackUnavailableError(error)) {
        throw error;
      }
      const info: ImportTargetResult = {
        targetDate: targetMs,
        outcome: "skipped_fetch_failure",
        errorMessage: error instanceof Error ? error.message : "lookup failed",
      };
      result.targets.push(info);
      result.failed++;
      onProgress?.({ appId: app.id, ...info });
      continue;
    }

    if (walk.kind === "none") {
      // No archive.org capture near this target. Save Page Now is decided
      // once per app after the loop — archiving today's page can't fill a
      // 2021 gap, so it is only worth requesting when the archive has
      // nothing *recent*.
      const info: ImportTargetResult = {
        targetDate: targetMs,
        outcome: "skipped_no_capture",
      };
      result.targets.push(info);
      result.skipped++;
      onProgress?.({ appId: app.id, ...info });
      continue;
    }

    if (walk.kind === "drift") {
      const info: ImportTargetResult = {
        targetDate: targetMs,
        outcome: "skipped_drift",
        captureDate: walk.captureMs,
        waybackUrl: walk.snapshot.url,
      };
      result.targets.push(info);
      result.skipped++;
      onProgress?.({ appId: app.id, ...info });
      continue;
    }

    const lookup = walk.snapshot;
    const captureMs = walk.captureMs;
    const lookupKey = normaliseWaybackUrl(lookup.url);

    // Safety net: skip if this exact Wayback capture is already stored (two
    // targets can resolve to the same capture in sparsely-covered quarters).
    if (lookupKey && existingUrls.has(lookupKey)) {
      if (isNewestTarget) {
        newestTargetCovered = true;
      }
      const info: ImportTargetResult = {
        targetDate: targetMs,
        outcome: "skipped_existing",
        captureDate: captureMs,
        waybackUrl: lookup.url,
      };
      result.targets.push(info);
      result.skipped++;
      onProgress?.({ appId: app.id, ...info });
      continue;
    }

    const replayUrl = buildReplayUrl(lookup.url, lookup.timestamp, app.url);

    let html: string;
    try {
      html = await fetchArchivedHtml(replayUrl, signal);
    } catch (error) {
      if (isAbortError(error) || isWaybackUnavailableError(error)) {
        throw error;
      }
      const info: ImportTargetResult = {
        targetDate: targetMs,
        outcome: "skipped_fetch_failure",
        captureDate: captureMs,
        waybackUrl: lookup.url,
        errorMessage: error instanceof Error ? error.message : "fetch failed",
      };
      result.targets.push(info);
      result.failed++;
      onProgress?.({ appId: app.id, ...info });
      continue;
    }

    const snapshot = parsePrivacyItemsFromArchivedHtml(html);
    if (!snapshot) {
      const info: ImportTargetResult = {
        targetDate: targetMs,
        outcome: "skipped_parse_failure",
        captureDate: captureMs,
        waybackUrl: lookup.url,
      };
      result.targets.push(info);
      result.failed++;
      onProgress?.({ appId: app.id, ...info });
      continue;
    }

    const { changes, isBaseline } = writeWaybackSnapshot(
      app.id,
      snapshot,
      captureMs,
      lookup.url
    );

    // Keep `existing` current so later targets dedupe against rows we just wrote.
    existing.push({ scraped_at: captureMs, wayback_snapshot_url: lookup.url });
    if (lookupKey) {
      existingUrls.add(lookupKey);
    }
    if (isNewestTarget) {
      newestTargetCovered = true;
    }

    const outcome: ImportTargetOutcome =
      changes.length > 0 || isBaseline ? "imported" : "unchanged";
    if (outcome === "imported") {
      result.imported++;
    } else {
      result.unchanged++;
    }

    const info: ImportTargetResult = {
      targetDate: targetMs,
      outcome,
      captureDate: captureMs,
      waybackUrl: lookup.url,
      changeCount: changes.length,
    };
    result.targets.push(info);
    onProgress?.({ appId: app.id, ...info });
  }

  // Save Page Now archives the *current* page, so it only helps when the
  // archive has no recent capture of it — then the next import (and anyone
  // else looking) gets a third-party record of today's labels. One request
  // per app per run; the outcome rides on `result.targets` as an extra
  // entry dated today so callers can show it alongside the real targets.
  const hasRecentCapture = captures
    ? captures.some(
        (capture) =>
          Math.abs(todayMs - capture.ms) <= CAPTURE_DRIFT_TOLERANCE_MS
      )
    : newestTargetCovered;
  if (!hasRecentCapture) {
    throwIfAborted(signal);
    const info = await requestFreshCapture(app, todayMs, signal);
    result.targets.push(info);
    if (info.outcome === "requested_snapshot") {
      result.snapshotsRequested++;
    } else {
      result.skipped++;
    }
    onProgress?.({ appId: app.id, ...info });
  }

  return result;
}

/**
 * Insert a back-dated wayback row and keep the diff chain consistent around
 * it, in one transaction:
 *
 *   - The new row is diffed against the snapshot immediately before it. When
 *     nothing older exists it is the *baseline* and carries no changes —
 *     diffing it against today's labels (the old behaviour) produced a
 *     change list pointing the wrong way through time.
 *   - The wayback row immediately after it, if any, is re-diffed against
 *     the new row. Its stored diff was computed against whatever preceded it
 *     at insert time, which the new row has just displaced; without the
 *     repair, a denser re-import double-counts every change. Live rows are
 *     never rewritten — they belong to the scraper and feed the review
 *     queue — so the last archive→live hop is bridged at read time in
 *     `getChangelog` instead.
 */
function writeWaybackSnapshot(
  appId: string,
  snapshot: PrivacyTypeSnapshot[],
  captureMs: number,
  waybackUrl: string
): { changes: ChangeEntry[]; isBaseline: boolean } {
  return db.transaction(() => {
    const prev = getSnapshotBefore(appId, captureMs);
    const changes: ChangeEntry[] = prev ? diffSnapshots(prev, snapshot) : [];
    saveSnapshot(appId, snapshot, changes, {
      source: "wayback",
      scrapedAt: captureMs,
      waybackUrl,
    });
    repairSuccessorWaybackDiff(appId, captureMs, snapshot);
    return { changes, isBaseline: prev === null };
  })();
}

/**
 * Re-diff the wayback row that now directly follows `insertedAtMs` against
 * the freshly inserted snapshot. No-op when the successor is a live row (or
 * there is none).
 */
function repairSuccessorWaybackDiff(
  appId: string,
  insertedAtMs: number,
  inserted: PrivacyTypeSnapshot[]
): void {
  const next = db
    .prepare(
      `SELECT id, source, snapshot_json
         FROM privacy_snapshots
        WHERE app_id = ? AND scraped_at > ?
        ORDER BY scraped_at ASC
        LIMIT 1`
    )
    .get(appId, insertedAtMs) as
    | { id: string; source: string | null; snapshot_json: string | null }
    | undefined;
  if (next?.source !== "wayback" || !next.snapshot_json) {
    return;
  }
  let nextSnapshot: PrivacyTypeSnapshot[];
  try {
    nextSnapshot = JSON.parse(next.snapshot_json) as PrivacyTypeSnapshot[];
  } catch {
    return;
  }
  const changes = diffSnapshots(inserted, nextSnapshot);
  db.prepare(
    `UPDATE privacy_snapshots
        SET changes_summary = ?, changes_detected = ?
      WHERE id = ?`
  ).run(JSON.stringify(changes), changes.length > 0 ? 1 : 0, next.id);
}

/** Ask Save Page Now to archive the live page; never throws except on abort. */
async function requestFreshCapture(
  app: ArchiveAppRow,
  todayMs: number,
  signal?: AbortSignal
): Promise<ImportTargetResult> {
  try {
    const saved = await submitToWaybackSaveNow(app.url, { signal });
    if (!saved.ok) {
      // Keep the reason so the UI can say why the request didn't land
      // instead of collapsing to "no capture".
      return {
        targetDate: todayMs,
        outcome: "skipped_save_now_failed",
        errorMessage: saved.error,
      };
    }
    const info: ImportTargetResult = {
      targetDate: todayMs,
      outcome: "requested_snapshot",
      saveNowUrl: saved.snapshot.url,
      captureDate:
        parseWaybackTimestampMs(saved.snapshot.timestamp) ?? undefined,
    };
    // Only successful requests get a timeline note. Failures used to write
    // one too, which turned routine "archive is busy" runs into a wall of
    // "⚠ Wayback snapshot request failed" cards; they still surface in the
    // activity log and on `ImportTargetResult.errorMessage`.
    appendWaybackAttemptEntry(app.id, {
      event: "requested_snapshot",
      description: describeWaybackAttempt(info),
      saveNowUrl: info.saveNowUrl,
      targetDate: info.targetDate,
    });
    return info;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    // submitToWaybackSaveNow returns a discriminated union and shouldn't
    // throw, but guard so a future refactor can't break the import.
    return {
      targetDate: todayMs,
      outcome: "skipped_save_now_failed",
      errorMessage: error instanceof Error ? error.message : "save now failed",
    };
  }
}

/**
 * Pick the capture closest to `targetMs` from a CDX listing. Mirrors the
 * outcome shape of the availability walk so the import loop is agnostic
 * about which probe produced it.
 */
function pickCaptureFromIndex(
  captures: WaybackCapture[],
  targetMs: number,
  toleranceMs: number
): WaybackProbeResult {
  if (captures.length === 0) {
    return { kind: "none" };
  }
  let best = captures[0];
  let bestDrift = Math.abs(best.ms - targetMs);
  for (const capture of captures) {
    const drift = Math.abs(capture.ms - targetMs);
    if (drift < bestDrift) {
      best = capture;
      bestDrift = drift;
    }
  }
  const snapshot: WaybackSnapshot = {
    url: best.url,
    timestamp: best.timestamp,
  };
  return bestDrift <= toleranceMs
    ? { kind: "in_tolerance", snapshot, captureMs: best.ms }
    : { kind: "drift", snapshot, captureMs: best.ms };
}

/** `http://web.archive.org/…` and `https://…` name the same capture. */
function normaliseWaybackUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  return url.replace(/^http:\/\//i, "https://");
}

/**
 * Remove imported history rows. Pass an `appId` to scope to a single app
 * or omit for a global purge. Returns the number of rows deleted.
 *
 * Covers the back-dated `source = 'wayback'` snapshots *and* the synthetic
 * "requested a fresh capture" notes the importer writes (`source = 'live'`,
 * `triggered_by = 'wayback'`). A real scrape never carries that trigger, so
 * the predicate is exact — and without it "Remove all imported history"
 * left a purple note dated today on every app it had touched.
 */
export function removeImportedHistory(appId?: string): number {
  const where =
    "(source = 'wayback' OR (source = 'live' AND triggered_by = 'wayback'))";
  const stmt = appId
    ? db.prepare(`DELETE FROM privacy_snapshots WHERE ${where} AND app_id = ?`)
    : db.prepare(`DELETE FROM privacy_snapshots WHERE ${where}`);
  const info = appId ? stmt.run(appId) : stmt.run();
  return Number(info.changes ?? 0);
}

export interface CategoryTrendBucket {
  added: number;
  /** End of the quarter, exclusive. */
  endMs: number;
  /** Human label ("Q4 2025"). */
  label: string;
  removed: number;
  /** Start of the quarter (epoch ms, UTC-aligned to the 1st of the month). */
  startMs: number;
}

export interface CategoryTrendResult {
  buckets: CategoryTrendBucket[];
  netChange: number;
  totalAdded: number;
  totalRemoved: number;
}

export interface QuarterlyChangePoint {
  /** Total count of individual ChangeEntry items across those rows. */
  changeEntries: number;
  /** Number of snapshot rows with `changes_detected = 1` in this bucket. */
  changeEvents: number;
  endMs: number;
  label: string;
  startMs: number;
}

interface AggregatedSnapshotRow {
  changes_detected: number;
  changes_summary: string | null;
  scraped_at: number;
  source: string | null;
}

/** Roll up per-snapshot change entries into quarterly added/removed counts. */
export function computeCategoryTrend(
  appId: string,
  options: { today?: Date } = {}
): CategoryTrendResult {
  const rows = loadAggregationRows(appId);
  const buckets = bucketByQuarter(rows, options.today ?? new Date());

  let totalAdded = 0;
  let totalRemoved = 0;
  const out: CategoryTrendBucket[] = buckets.map((bucket) => {
    let added = 0;
    let removed = 0;
    for (const row of bucket.rows) {
      if (!row.changes_summary) {
        continue;
      }
      let parsed: ChangeEntry[] = [];
      try {
        parsed = JSON.parse(row.changes_summary) as ChangeEntry[];
      } catch {
        parsed = [];
      }
      for (const change of parsed) {
        if (!isPrivacyLabelEntry(change)) {
          continue;
        }
        if (change.type === "added") {
          added++;
        } else if (change.type === "removed") {
          removed++;
        }
      }
    }
    totalAdded += added;
    totalRemoved += removed;
    return {
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      label: bucket.label,
      added,
      removed,
    };
  });

  return {
    totalAdded,
    totalRemoved,
    netChange: totalAdded - totalRemoved,
    buckets: out,
  };
}

/**
 * Count *events* per quarter — one point per bucket for a sparkline.
 * Distinct from `computeCategoryTrend` (which counts entries) because the
 * sparkline reads better with a rows-with-changes y-axis. Only rows with at
 * least one privacy-label entry count: policy rescrapes and accessibility
 * updates share the table but are not label changes.
 */
export function computeQuarterlyChanges(
  appId: string,
  options: { today?: Date } = {}
): QuarterlyChangePoint[] {
  const rows = loadAggregationRows(appId);
  const buckets = bucketByQuarter(rows, options.today ?? new Date());

  return buckets.map((bucket) => {
    let changeEvents = 0;
    let changeEntries = 0;
    for (const row of bucket.rows) {
      if (row.changes_detected !== 1 || !row.changes_summary) {
        continue;
      }
      let labelEntries = 0;
      try {
        const parsed = JSON.parse(row.changes_summary) as ChangeEntry[];
        labelEntries = parsed.filter(isPrivacyLabelEntry).length;
      } catch {
        /* malformed JSON — not a countable event */
      }
      if (labelEntries > 0) {
        changeEvents++;
        changeEntries += labelEntries;
      }
    }
    return {
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      label: bucket.label,
      changeEvents,
      changeEntries,
    };
  });
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

/**
 * Privacy-label diffs are the untagged default; every other entry kind
 * (`privacy-policy`, `accessibility`, `age-rating`, `wayback-attempt`)
 * carries an explicit category and must not feed the label aggregates.
 */
function isPrivacyLabelEntry(change: ChangeEntry): boolean {
  return (change.category ?? "privacy-label") === "privacy-label";
}

function loadAggregationRows(appId: string): AggregatedSnapshotRow[] {
  return db
    .prepare(
      `SELECT scraped_at, changes_detected, changes_summary, source
         FROM privacy_snapshots
        WHERE app_id = ?
        ORDER BY scraped_at ASC`
    )
    .all(appId) as AggregatedSnapshotRow[];
}

interface QuarterBucket {
  endMs: number;
  label: string;
  rows: AggregatedSnapshotRow[];
  startMs: number;
}

/**
 * Partition rows into calendar quarters anchored on
 * {@link APP_STORE_HISTORICAL_FLOOR} through the quarter containing `today`.
 * Empty quarters are still emitted so the sparkline has a continuous x-axis.
 */
function bucketByQuarter(
  rows: AggregatedSnapshotRow[],
  today: Date
): QuarterBucket[] {
  const launch = APP_STORE_WEB_LAUNCH;
  const startYear = launch.getUTCFullYear();
  const startQuarter = Math.floor(launch.getUTCMonth() / 3); // 0 = Q1 for Feb
  const endYear = today.getUTCFullYear();
  const endQuarter = Math.floor(today.getUTCMonth() / 3);

  const buckets: QuarterBucket[] = [];
  let y = startYear;
  let q = startQuarter;
  while (y < endYear || (y === endYear && q <= endQuarter)) {
    const startMs = Date.UTC(y, q * 3, 1);
    const endMs = Date.UTC(q === 3 ? y + 1 : y, ((q + 1) % 4) * 3, 1);
    buckets.push({
      startMs,
      endMs,
      label: `Q${q + 1} ${y}`,
      rows: [],
    });
    q += 1;
    if (q > 3) {
      q = 0;
      y += 1;
    }
  }

  for (const row of rows) {
    const bucket = buckets.find(
      (b) => row.scraped_at >= b.startMs && row.scraped_at < b.endMs
    );
    if (bucket) {
      bucket.rows.push(row);
    }
  }

  return buckets;
}

/**
 * Outcome of the widened Wayback availability search.
 *   `in_tolerance` — capture inside the drift window; proceed.
 *   `drift`        — captures exist but none close enough; surface the nearest miss.
 *   `none`         — no capture anywhere near the target.
 */
type WaybackProbeResult =
  | { kind: "in_tolerance"; snapshot: WaybackSnapshot; captureMs: number }
  | { kind: "drift"; snapshot: WaybackSnapshot; captureMs: number }
  | { kind: "none" };

/**
 * Widen the search for a Wayback capture around `target`. Wayback's
 * "closest capture" is relative to the probe timestamp, so a probe at
 * target+14 may surface a different (closer) capture than target+0.
 * Tries symmetric offsets inside drift tolerance, taking the first
 * in-window hit or returning the nearest-miss for diagnostics.
 *
 * Per-probe exceptions are swallowed — one timeout shouldn't abandon
 * the whole quarter — except a throttled archive, which is re-thrown so
 * the caller stops probing instead of recording seven more 429s as an
 * empty quarter.
 */
async function findCaptureWithinTolerance(
  targetUrl: string,
  target: Date,
  toleranceMs: number,
  signal?: AbortSignal
): Promise<WaybackProbeResult> {
  const targetMs = target.getTime();
  const seen = new Set<string>();
  let bestMiss: {
    snapshot: WaybackSnapshot;
    captureMs: number;
    drift: number;
  } | null = null;

  for (const offsetDays of WAYBACK_FALLBACK_OFFSET_DAYS) {
    throwIfAborted(signal);
    const probeDate = new Date(targetMs + offsetDays * ONE_DAY_MS);

    let lookup: WaybackSnapshot | null = null;
    try {
      lookup = await lookupWaybackSnapshotNear(targetUrl, probeDate, {
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || isWaybackUnavailableError(error)) {
        throw error;
      }
      continue;
    }
    if (!lookup) {
      continue;
    }

    // De-dupe — same URL means we already measured this capture's drift.
    if (seen.has(lookup.url)) {
      continue;
    }
    seen.add(lookup.url);

    // Prefer the payload's timestamp, then the one embedded in the URL;
    // only a URL with neither falls back to the probe date.
    const captureMs =
      parseWaybackTimestampMs(
        lookup.timestamp ?? timestampFromWaybackUrl(lookup.url)
      ) ?? probeDate.getTime();
    const drift = Math.abs(captureMs - targetMs);
    if (drift <= toleranceMs) {
      return { kind: "in_tolerance", snapshot: lookup, captureMs };
    }
    if (!bestMiss || drift < bestMiss.drift) {
      bestMiss = { snapshot: lookup, captureMs, drift };
    }
  }

  if (bestMiss) {
    return {
      kind: "drift",
      snapshot: bestMiss.snapshot,
      captureMs: bestMiss.captureMs,
    };
  }
  return { kind: "none" };
}

/**
 * Most-recent snapshot strictly older than `beforeMs`, or null when the
 * capture predates everything on file. Null means "this is the baseline":
 * the caller stores it with no changes. It deliberately does *not* fall
 * back to today's `privacy_types` — that produced a diff from the present
 * back to the past on the oldest imported row, which then surfaced as
 * inverted "now collects / no longer collects" entries in the universal
 * changelog and the first bucket of the history chart.
 */
function getSnapshotBefore(
  appId: string,
  beforeMs: number
): PrivacyTypeSnapshot[] | null {
  const row = db
    .prepare(
      `SELECT snapshot_json
         FROM privacy_snapshots
        WHERE app_id = ? AND scraped_at < ?
        ORDER BY scraped_at DESC
        LIMIT 1`
    )
    .get(appId, beforeMs) as { snapshot_json: string | null } | undefined;

  if (!row?.snapshot_json) {
    return null;
  }
  try {
    return JSON.parse(row.snapshot_json) as PrivacyTypeSnapshot[];
  } catch {
    return null;
  }
}

/** `YYYYMMDDhhmmss` (or a left-anchored prefix) out of a `/web/<ts>/` URL. */
function timestampFromWaybackUrl(waybackUrl: string): string | undefined {
  return waybackUrl.match(/\/web\/(\d{4,14})(?:[a-z_]+)?\//i)?.[1];
}

/**
 * Build the `id_` replay URL for a capture. `id_` disables Wayback's
 * toolbar injection and URL rewriting so the archived HTML comes through
 * as Apple served it. Prefer Wayback's canonical timestamp; fall back to
 * parsing it out of the URL if the availability payload omitted it.
 */
function buildReplayUrl(
  waybackUrl: string,
  timestamp: string | undefined,
  originalUrl: string
): string {
  const ts = timestamp ?? timestampFromWaybackUrl(waybackUrl);
  if (!ts) {
    return waybackUrl; // unusual; let safeFetch handle the plain URL
  }
  return `https://web.archive.org/web/${ts}id_/${originalUrl}`;
}

async function fetchArchivedHtml(
  replayUrl: string,
  signal?: AbortSignal
): Promise<string> {
  const { body, response } = await safeFetch(replayUrl, {
    allowedHosts: WAYBACK_HOSTS,
    maxBytes: ARCHIVE_HTML_MAX_BYTES,
    timeoutMs: ARCHIVE_HTML_TIMEOUT_MS,
    signal,
    redirect: "follow",
    headers: {
      "User-Agent":
        "privacytracker/1.0 (+privacy-history archiver) Mozilla/5.0 (compatible)",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  // A throttled replay is the same signal as a throttled index; anything
  // else non-200 (a 404 for a capture the index listed, say) is a fetch
  // failure for this target, not a parse failure of an error page.
  if (response.status === 429 || response.status >= 500) {
    throw new WaybackUnavailableError(
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
      "replay"
    );
  }
  if (response.status !== 200) {
    throw new Error(`archive replay returned HTTP ${response.status}`);
  }
  return body.toString("utf8");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw new DOMException("Wayback import cancelled", "AbortError");
}

/**
 * Parse Wayback-captured App Store HTML. Mirrors `lib/scraper.ts` →
 * `saveToDb`'s parser chain but only produces a snapshot — never writes
 * to apps / privacy_types / privacy_categories. Returns null for 404
 * pages or captures that don't carry privacy data.
 *
 * Three parser eras supported (same as the live scraper):
 *   - Modern (Nov 2025+): `<script id="serialized-server-data">` blob
 *     plus legacy `privacyHeader` / generic `pageData` fallbacks.
 *   - Historical (Jan 2021 – Nov 2025): `shoebox-media-api-cache-apps`
 *     under `d[0].attributes.privacy.privacyTypes`; field-renames
 *     normalised by `extractFromShoebox`.
 *   - Pre-Jan 2021: no privacy data; returns null.
 */
export function parsePrivacyItemsFromArchivedHtml(
  html: string
): PrivacyTypeSnapshot[] | null {
  // Closing tag accepts `<\/script\b[^>]*>` (whitespace AND attributes
  // before `>`) to stay robust against every HTML5 end-tag form a
  // Wayback capture might serve back to us — including the attribute-
  // bearing variants (`</script foo="bar">`) that CodeQL rule
  // `js/bad-tag-filter` flagged in `lib/privacy-policy.ts`. A naked
  // `</script>` literal would let archived pages with any non-bare
  // end tag slip through as one giant unterminated match.
  const jsonMatch = html.match(
    /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script\b[^>]*>/
  );

  // Modern serialized-server-data path; missing tag drops to the
  // shoebox fallback below.
  let data: any = null;
  if (jsonMatch) {
    try {
      const raw = JSON.parse(jsonMatch[1]);
      data = Array.isArray(raw) ? raw : (raw?.data ?? []);
    } catch {
      data = null;
    }
  }

  let privacyItems: any[] = [];
  try {
    const shelfMap = data?.[0]?.data?.shelfMapping;

    if (shelfMap?.privacyTypes?.items?.length) {
      privacyItems = shelfMap.privacyTypes.items;
    }

    if (!privacyItems.length) {
      const viaHeader =
        shelfMap?.privacyHeader?.seeAllAction?.pageData?.shelves;
      if (viaHeader?.length) {
        for (const shelf of viaHeader) {
          if (shelf.contentType !== "privacyType") {
            continue;
          }
          for (const item of shelf.items ?? []) {
            if (item.categories?.length) {
              privacyItems.push(item);
            } else if (item.purposes?.length) {
              // Flatten legacy purposes→categories. De-dup on identifier so
              // a category referenced by several purposes lands once.
              const catMap = new Map<string, PrivacyCategorySnapshot>();
              for (const p of item.purposes) {
                for (const c of p.categories ?? []) {
                  if (!catMap.has(c.identifier)) {
                    catMap.set(c.identifier, {
                      identifier: c.identifier,
                      title: c.title,
                    });
                  }
                }
              }
              privacyItems.push({
                identifier: item.identifier,
                title: item.title,
                categories: [...catMap.values()],
              });
            }
          }
        }
      }
    }

    if (!privacyItems.length) {
      const pageData = data?.[0]?.data?.pageData;
      if (pageData?.shelves?.length) {
        for (const shelf of pageData.shelves) {
          if (shelf.contentType === "privacyType") {
            privacyItems.push(...(shelf.items ?? []));
          }
        }
      }
    }

    // Historical Ember/FastBoot fallback (Jan 2021 – Nov 2025).
    // Extractor shared with the live scraper.
    if (!privacyItems.length) {
      privacyItems = extractFromShoebox(html);
    }
  } catch {
    return null;
  }

  // No privacy items in any extractor — return null. Covers pre-Jan-2021
  // captures, error pages, and redirect shells.
  if (privacyItems.length === 0) {
    return null;
  }

  const snapshot: PrivacyTypeSnapshot[] = [];
  const typeIds = new Set<string>();
  for (const item of privacyItems) {
    if (!item?.identifier || typeIds.has(item.identifier)) {
      continue;
    }
    typeIds.add(item.identifier);
    const categories: PrivacyCategorySnapshot[] = [];
    const catIds = new Set<string>();
    for (const cat of item.categories ?? []) {
      if (!cat?.identifier || catIds.has(cat.identifier)) {
        continue;
      }
      catIds.add(cat.identifier);
      categories.push({
        identifier: cat.identifier,
        title: typeof cat.title === "string" ? cat.title : cat.identifier,
      });
    }
    snapshot.push({
      identifier: item.identifier,
      title: typeof item.title === "string" ? item.title : item.identifier,
      categories,
    });
  }

  return snapshot;
}

/**
 * Short human-readable line for the synthetic timeline entry written on
 * no-capture branches.
 */
function describeWaybackAttempt(info: ImportTargetResult): string {
  const quarter = formatQuarterLabel(info.targetDate);
  switch (info.outcome) {
    case "requested_snapshot":
      return "Requested a fresh Wayback capture of the live App Store page so the next import has a recent baseline.";
    case "skipped_save_now_failed":
      return `Could not request a Wayback snapshot for ${quarter}: ${info.errorMessage ?? "Save Page Now failed"}.`;
    default:
      return `No Wayback capture found near ${quarter}.`;
  }
}

/** "Q1 2026" from an epoch-ms target. */
function formatQuarterLabel(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "target quarter";
  }
  const d = new Date(ms);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${d.getUTCFullYear()}`;
}

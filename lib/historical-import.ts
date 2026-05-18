/**
 * Historical import — reconstruct privacy-label history from the Internet
 * Archive's Wayback Machine. For every app, pulls one snapshot per quarter
 * back to APP_STORE_HISTORICAL_FLOOR (Q1 2021).
 *
 * Flow per app:
 *   1. computeQuarterlyTargets() → chronological list of target dates.
 *   2. Ask Wayback for the closest capture of the App Store product page
 *      via archive.org/wayback/available.
 *   3. Fetch archived HTML via the `id_` replay variant (strips toolbar)
 *      and parse either the modern serialized-server-data blob or the
 *      historical shoebox shape.
 *   4. Build a `PrivacyTypeSnapshot[]`, diff against the immediately
 *      preceding snapshot in the DB, and write via `saveSnapshot` with
 *      source='wayback', scrapedAt = capture timestamp, waybackUrl = replay URL.
 *
 * Wayback rows never bump `apps.changeCount` — they are history, not a new
 * change to review. Self-contained on purpose: the live path also writes
 * to apps / privacy_types tables which must stay pinned to current state.
 */

import crypto from "node:crypto";
import {
  appendWaybackAttemptEntry,
  buildSnapshot,
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
  lookupWaybackSnapshotNear,
  parseWaybackTimestampMs,
  submitToWaybackSaveNow,
  type WaybackSnapshot,
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

/** Cap on how much archived HTML we'll pull per page. Matches the live scraper. */
const ARCHIVE_HTML_MAX_BYTES = 4 * 1024 * 1024;

const ARCHIVE_HTML_TIMEOUT_MS = 30_000;

const WAYBACK_HOSTS = ["web.archive.org", "archive.org"];

/**
 * List of target dates to attempt, oldest first. Steps back from `today`
 * in 3-month increments down to the launch anchor. `today` is clamped to
 * launch if earlier.
 */
export function computeQuarterlyTargets(
  today: Date = new Date(),
  launchDate: Date = APP_STORE_WEB_LAUNCH
): Date[] {
  const floor = launchDate.getTime();
  const now = Math.max(today.getTime(), floor);

  const targets: number[] = [];

  // Walk backwards from today in 3-month steps; the launch date is
  // appended explicitly so we always cover the first Wayback-available
  // moment even if the step overshoots.
  const cursor = new Date(now);
  cursor.setUTCMonth(cursor.getUTCMonth() - QUARTER_MONTHS);
  while (cursor.getTime() > floor) {
    targets.push(cursor.getTime());
    cursor.setUTCMonth(cursor.getUTCMonth() - QUARTER_MONTHS);
  }
  targets.push(floor);

  // Sort ascending so importers can diff chronologically.
  targets.sort((a, b) => a - b);

  // De-duplicate in case the cursor happened to land exactly on the floor.
  const unique: Date[] = [];
  for (const ts of targets) {
    if (unique.length === 0 || unique[unique.length - 1].getTime() !== ts) {
      unique.push(new Date(ts));
    }
  }
  return unique;
}

export interface ImportAppHistoryOptions {
  /**
   * Skip targets that already have a wayback snapshot within this many
   * milliseconds. Defaults to 45 days so rerunning the import after adding
   * a new app doesn't double-insert quarters you've already pulled.
   */
  dedupeWindowMs?: number;
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
  const dedupeWindowMs = options.dedupeWindowMs ?? 45 * 24 * 60 * 60 * 1000;
  const onProgress = options.onProgress;
  const signal = options.signal;

  const targets = computeQuarterlyTargets(today);

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

  // Save Page Now archives the current page, not the historical target date.
  // One request per app per run is enough; retrying for every empty quarter
  // only amplifies transient archive.org failures.
  const saveNowAttempted = new Set<string>();

  for (const target of targets) {
    throwIfAborted(signal);
    result.attempted++;
    const targetMs = target.getTime();

    // Skip quarters we've already covered within the dedupe window.
    const alreadyCovered = existing.some(
      (row) => Math.abs(row.scraped_at - targetMs) <= dedupeWindowMs
    );
    if (alreadyCovered) {
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
      walk = await findCaptureWithinTolerance(
        app.url,
        target,
        CAPTURE_DRIFT_TOLERANCE_MS,
        signal
      );
    } catch (error) {
      if (isAbortError(error)) {
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
      // No archive.org capture near this quarter. Fire Save Page Now to
      // archive the live page for the next import run; submit at most
      // once per app per run.
      let info: ImportTargetResult = {
        targetDate: targetMs,
        outcome: "skipped_no_capture",
      };
      if (!saveNowAttempted.has(app.url)) {
        saveNowAttempted.add(app.url);
        try {
          const saved = await submitToWaybackSaveNow(app.url, { signal });
          if (saved.ok) {
            info = {
              targetDate: targetMs,
              outcome: "requested_snapshot",
              saveNowUrl: saved.snapshot.url,
              captureDate:
                parseWaybackTimestampMs(saved.snapshot.timestamp) ?? undefined,
            };
            result.snapshotsRequested++;
          } else {
            // Capture the failure reason so the UI shows why the request
            // didn't land instead of collapsing to "no capture".
            info = {
              targetDate: targetMs,
              outcome: "skipped_save_now_failed",
              errorMessage: saved.error,
            };
          }
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          // submitToWaybackSaveNow returns a discriminated union and
          // shouldn't throw, but guard so a future refactor can't break us.
          info = {
            targetDate: targetMs,
            outcome: "skipped_save_now_failed",
            errorMessage:
              error instanceof Error ? error.message : "save now failed",
          };
        }
      }
      // Only surface successful Save Page Now requests on the per-app
      // Change History timeline. Earlier versions also wrote rows for
      // `save_now_failed` and `no_capture` outcomes, but those turned
      // routine quarters-with-no-archive into a noisy stream of
      // "⚠ Wayback snapshot request failed" entries on every run.
      // Failures still surface in the bulk-import activity log and on
      // `ImportTargetResult.errorMessage` for the API caller.
      if (info.outcome === "requested_snapshot") {
        appendWaybackAttemptEntry(app.id, {
          event: "requested_snapshot",
          description: describeWaybackAttempt(info),
          details: info.errorMessage ? [info.errorMessage] : undefined,
          saveNowUrl: info.saveNowUrl,
          targetDate: info.targetDate,
        });
      }
      result.targets.push(info);
      if (info.outcome === "skipped_no_capture") {
        result.skipped++;
      } else if (info.outcome === "skipped_save_now_failed") {
        result.skipped++;
      }
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

    // Safety net: skip if this exact Wayback URL is already stored (two
    // targets can resolve to the same capture in sparsely-covered quarters).
    if (existing.some((row) => row.wayback_snapshot_url === lookup.url)) {
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
      if (isAbortError(error)) {
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

    // Diff against the immediately-preceding snapshot (live or wayback).
    // If older than every existing snapshot (common on first wayback
    // import), treat as a first-seen row with no changes.
    const prev = getSnapshotBefore(app.id, captureMs);
    const changes: ChangeEntry[] = prev ? diffSnapshots(prev, snapshot) : [];

    saveSnapshot(app.id, snapshot, changes, {
      source: "wayback",
      scrapedAt: captureMs,
      waybackUrl: lookup.url,
    });

    // Keep `existing` current so later targets dedupe against rows we just wrote.
    existing.push({ scraped_at: captureMs, wayback_snapshot_url: lookup.url });

    const outcome: ImportTargetOutcome =
      changes.length > 0 || !prev ? "imported" : "unchanged";
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

  return result;
}

/**
 * Remove imported history rows. Pass an `appId` to scope to a single app
 * or omit for a global purge. Returns the number of rows deleted.
 */
export function removeImportedHistory(appId?: string): number {
  const stmt = appId
    ? db.prepare(
        "DELETE FROM privacy_snapshots WHERE source = 'wayback' AND app_id = ?"
      )
    : db.prepare("DELETE FROM privacy_snapshots WHERE source = 'wayback'");
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
 * sparkline reads better with a rows-with-changes y-axis.
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
      if (row.changes_detected !== 1) {
        continue;
      }
      changeEvents++;
      if (row.changes_summary) {
        try {
          const parsed = JSON.parse(row.changes_summary) as ChangeEntry[];
          changeEntries += parsed.length;
        } catch {
          /* malformed JSON — skip entry-count contribution */
        }
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
  const startQuarter = Math.floor(launch.getUTCMonth() / 3); // 3 = Q4 for Nov
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
 * the whole quarter.
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
      if (isAbortError(error)) {
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

    const captureMs =
      parseWaybackTimestampMs(lookup.timestamp) ?? probeDate.getTime();
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
 * Most-recent snapshot strictly older than `beforeMs`, falling back to
 * `buildSnapshot(appId)` when no earlier row exists. The fallback prevents
 * "every category is new" noise on first-import for apps that only have
 * current privacy_types rows in the DB.
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
    .get(appId, beforeMs) as { snapshot_json: string } | undefined;

  if (row) {
    try {
      return JSON.parse(row.snapshot_json) as PrivacyTypeSnapshot[];
    } catch {
      return null;
    }
  }

  // No older row — fall back to today's state if any privacy_types rows exist.
  const current = buildSnapshot(appId);
  return current.length > 0 ? current : null;
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
  const tsFromUrl = waybackUrl.match(/\/web\/(\d{4,14})\//)?.[1];
  const ts = timestamp ?? tsFromUrl;
  if (!ts) {
    return waybackUrl; // unusual; let safeFetch handle the plain URL
  }
  return `https://web.archive.org/web/${ts}id_/${originalUrl}`;
}

async function fetchArchivedHtml(
  replayUrl: string,
  signal?: AbortSignal
): Promise<string> {
  const { body } = await safeFetch(replayUrl, {
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
 * Load every app and run `importAppHistory` sequentially. Sequential
 * because archive.org's availability endpoint is rate-sensitive and the
 * progress stream is easier to reason about. Callers needing streaming
 * progress should build their own loop with `importAppHistory`'s
 * `onProgress` hook.
 */
export async function importAllAppsHistory(
  options: ImportAppHistoryOptions = {}
): Promise<ImportAppHistoryResult[]> {
  const apps = db
    .prepare(
      `SELECT id, url, name
         FROM apps
        WHERE url IS NOT NULL AND TRIM(url) != ''
        ORDER BY name COLLATE NOCASE ASC`
    )
    .all() as ArchiveAppRow[];

  const results: ImportAppHistoryResult[] = [];
  for (const app of apps) {
    results.push(await importAppHistory(app, options));
  }
  return results;
}

/** Stable run id helper used by the route layer. */
export function makeImportRunId(): string {
  return `wayback-import-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Short human-readable line for the synthetic timeline entry written on
 * no-capture branches.
 */
function describeWaybackAttempt(info: ImportTargetResult): string {
  const quarter = formatQuarterLabel(info.targetDate);
  switch (info.outcome) {
    case "requested_snapshot":
      return `Requested a fresh Wayback snapshot (aimed at ${quarter}).`;
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

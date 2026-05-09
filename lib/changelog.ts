import db from './db';
import crypto from 'crypto';

// Re-export all pure types and constants from the client-safe split so that
// existing server-side callers can continue importing from this single file.
export type {
  PrivacyCategorySnapshot,
  PrivacyTypeSnapshot,
  ChangeEntry,
  SnapshotChangelogRow,
  ReviewChangelogRow,
  ChangelogRow,
  UnacknowledgedChangeEvent,
  UnacknowledgedChanges,
  ReviewAction,
  SnoozeDays,
  ReviewActionRecord,
} from './changelog-types';
export { SNOOZE_DAYS_OPTIONS } from './changelog-types';

import type {
  PrivacyTypeSnapshot,
  ChangeEntry,
  SnapshotChangelogRow,
  ReviewChangelogRow,
  ChangelogRow,
  UnacknowledgedChangeEvent,
  UnacknowledgedChanges,
  ReviewAction,
  SnoozeDays,
  ReviewActionRecord,
} from './changelog-types';

/** Build a snapshot of an app's current privacy state directly from DB rows. */
export function buildSnapshot(appId: string): PrivacyTypeSnapshot[] {
  const types = db.prepare('SELECT * FROM privacy_types WHERE app_id = ?').all(appId) as any[];
  return types.map(t => {
    const categories = db.prepare(
      'SELECT * FROM privacy_categories WHERE type_id = ?'
    ).all(t.id) as any[];
    return {
      identifier: t.identifier,
      title: t.title,
      categories: categories.map(c => ({
        identifier: c.identifier,
        title: c.title,
      })),
    };
  });
}

/** Diff two snapshots and return a list of human-readable changes. */
export function diffSnapshots(
  oldSnapshot: PrivacyTypeSnapshot[],
  newSnapshot: PrivacyTypeSnapshot[]
): ChangeEntry[] {
  const changes: ChangeEntry[] = [];

  const oldTypes = new Map(oldSnapshot.map(t => [t.identifier, t]));
  const newTypes = new Map(newSnapshot.map(t => [t.identifier, t]));

  // New top-level privacy types
  for (const [id, newType] of newTypes) {
    if (!oldTypes.has(id)) {
      changes.push({
        type: 'added',
        description: `New privacy label: "${newType.title}"`,
        details: newType.categories.map(c => c.title),
      });
    }
  }

  // Removed top-level privacy types
  for (const [id, oldType] of oldTypes) {
    if (!newTypes.has(id)) {
      changes.push({
        type: 'removed',
        description: `Removed privacy label: "${oldType.title}"`,
      });
    }
  }

  // Changes within existing types — compare categories
  for (const [id, newType] of newTypes) {
    const oldType = oldTypes.get(id);
    if (!oldType) continue;

    const oldCatIds = new Set(oldType.categories.map(c => c.identifier));
    const newCatIds = new Set(newType.categories.map(c => c.identifier));

    const addedCats = newType.categories.filter(c => !oldCatIds.has(c.identifier));
    const removedCats = oldType.categories.filter(c => !newCatIds.has(c.identifier));

    for (const c of addedCats) {
      changes.push({
        type: 'added',
        description: `"${newType.title}" now collects: ${c.title}`,
      });
    }

    for (const c of removedCats) {
      changes.push({
        type: 'removed',
        description: `"${newType.title}" no longer collects: ${c.title}`,
      });
    }
  }

  return changes;
}

export interface SaveSnapshotOptions {
  /**
   * Provenance of the snapshot. Defaults to `'live'` for the real-time
   * scrape path. Use `'wayback'` for back-dated rows written by the
   * historical-import flow.
   */
  source?: 'live' | 'wayback';
  /**
   * Override the timestamp written to `scraped_at`. Historical imports pass
   * the capture date of the Wayback snapshot so the changelog timeline
   * places the row at the correct point in history rather than "now".
   */
  scrapedAt?: number;
  /**
   * The `https://web.archive.org/web/…` URL the snapshot was reconstructed
   * from. Ignored unless `source === 'wayback'`.
   */
  waybackUrl?: string | null;
  /**
   * When true, do not bump `apps.changeCount` even if `changes` is
   * non-empty. Defaults to `true` for `source === 'wayback'` so retroactive
   * imports don't re-raise the unacknowledged-changes badge for history the
   * user has already lived through.
   */
  skipChangeCountBump?: boolean;
  /**
   * Provenance of *why* this sync ran. Stored verbatim on the snapshot row so
   * the History timeline can show a "Scheduled sync"/"Manual sync"/etc. pill
   * next to each entry. Freeform, but conventional values are:
   *   - `'scheduled'` — background scheduler tick
   *   - `'manual'`    — user clicked Sync now / rescraped a single app
   *   - `'import'`    — initial scrape during onboarding or bulk import
   *   - `'wayback'`   — historical back-fill
   * Defaults to `'wayback'` when `source === 'wayback'` and `undefined`
   * otherwise; the UI falls back to "Live sync" for the undefined case so
   * legacy rows still render sensibly.
   */
  triggeredBy?: SyncTrigger | null;
  /**
   * App Store version string ("7.22.0") current at the moment this snapshot
   * was taken. Captured from iTunes Lookup by the scraper and threaded through
   * so the History timeline can tag each row with the version the user was on
   * when Apple published this label set. `null`/`undefined` is fine — the UI
   * just omits the chip on rows that don't carry it.
   */
  appVersion?: string | null;
  /**
   * `currentVersionReleaseDate` (epoch ms) from iTunes Lookup at the time of
   * the scrape. Intentionally separate from `scrapedAt` so users can see the
   * release date even when they sync weeks after the update landed.
   */
  appVersionUpdatedAt?: number | null;
}

/**
 * Canonical set of values we write into `privacy_snapshots.triggered_by`. The
 * UI maps these to user-facing labels in ChangelogTimeline.
 *
 * `'sample'` is reserved for snapshots produced by the dev-only
 * seed-sample-data endpoint. The changelog timeline tags those rows with
 * a purple "SAMPLE" pill so devs (and reviewers screenshotting the UI)
 * can tell synthesised history apart from real syncs at a glance.
 */
export type SyncTrigger = 'scheduled' | 'manual' | 'import' | 'wayback' | 'sample';

/**
 * Coerce the raw `triggered_by` column value to one of the canonical
 * `SyncTrigger` values. Legacy rows (pre-migration) will have NULL — fall
 * back to `'wayback'` when `source === 'wayback'` so the UI still renders a
 * meaningful pill, and `null` otherwise so the UI can show the pre-feature
 * generic "Live sync" label.
 */
/**
 * Defensive parse for `change_review_actions.covered_snapshot_ids`. The
 * column is a JSON array of snapshot UUIDs written at review time; legacy
 * rows (pre-migration) store NULL and anything malformed (a caller that
 * wrote a non-array, or a future-proofing placeholder) falls back to an
 * empty array so the UI can just render the bare count.
 */
function parseCoveredSnapshotIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function normalizeTrigger(
  raw: string | null,
  source: string | null,
): SyncTrigger | null {
  if (
    raw === 'scheduled' ||
    raw === 'manual' ||
    raw === 'import' ||
    raw === 'wayback' ||
    raw === 'sample'
  ) {
    return raw;
  }
  if (source === 'wayback') return 'wayback';
  return null;
}

/** Persist a snapshot and optional change list to the database. */
export function saveSnapshot(
  appId: string,
  snapshot: PrivacyTypeSnapshot[],
  changes: ChangeEntry[],
  options: SaveSnapshotOptions = {},
): string {
  const id = crypto.randomUUID();
  const hasChanges = changes.length > 0;
  const source = options.source ?? 'live';
  const scrapedAt = options.scrapedAt ?? Date.now();
  const waybackUrl = source === 'wayback' ? options.waybackUrl ?? null : null;
  // Wayback rows are *history* — they should never inflate the unacknowledged
  // badge or the change counter. Callers can still opt out of the bump for
  // live snapshots by passing skipChangeCountBump explicitly, but the
  // default mirrors the legacy behaviour: live rows with real changes bump,
  // wayback rows never do.
  const skipBump = options.skipChangeCountBump ?? source === 'wayback';
  // triggered_by is optional — callers that haven't been threaded through yet
  // will write NULL and the UI falls back to an inferred label. Wayback rows
  // default to 'wayback' so back-fill always carries provenance even if the
  // helper forgets to pass it.
  const triggeredBy =
    options.triggeredBy ?? (source === 'wayback' ? 'wayback' : null);

  const appVersion = options.appVersion ?? null;
  const appVersionUpdatedAt =
    typeof options.appVersionUpdatedAt === 'number' ? options.appVersionUpdatedAt : null;

  db.prepare(`
    INSERT INTO privacy_snapshots
      (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,
       source, wayback_snapshot_url, triggered_by,
       app_version, app_version_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    appId,
    scrapedAt,
    JSON.stringify(snapshot),
    hasChanges ? 1 : 0,
    JSON.stringify(changes),
    source,
    waybackUrl,
    triggeredBy,
    appVersion,
    appVersionUpdatedAt,
  );

  if (hasChanges && !skipBump) {
    db.prepare('UPDATE apps SET changeCount = changeCount + 1 WHERE id = ?').run(appId);
  }

  return id;
}

/**
 * Append a synthetic changelog entry for a privacy-policy event. Re-uses the
 * `privacy_snapshots` table so the existing timeline just renders these rows
 * alongside label diffs — no new storage, no new UI wiring on the history tab
 * beyond an icon tweak.
 *
 * Snapshot json is kept identical to whatever the latest label snapshot was,
 * so diffSnapshots on the next label sync still works correctly.
 */
export function appendPolicyChangeEntry(
  appId: string,
  entry: ChangeEntry,
): void {
  const latest = getLatestSnapshot(appId) ?? [];
  const id = crypto.randomUUID();
  // `same` events exist only so the History timeline shows that a rescrape
  // happened — they are not a "change to review". Mark changes_detected = 0
  // so they don't inflate the unacknowledged-changes badge or the bell-icon
  // notification count. `first`, `changed`, and `error` keep the flag set:
  //   - `first` is the first-ever capture and worth acknowledging.
  //   - `changed` is the whole point of the feature.
  //   - `error` surfaces a failed rescrape the user should notice.
  const changesDetected = entry.policy_event === 'same' ? 0 : 1;
  db.prepare(`
    INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    appId,
    Date.now(),
    JSON.stringify(latest),
    changesDetected,
    JSON.stringify([{ ...entry, category: entry.category ?? 'privacy-policy' }]),
  );
}

/**
 * Append a synthetic changelog entry for a Wayback-archive attempt. Mirrors
 * `appendPolicyChangeEntry` — re-uses `privacy_snapshots` so the existing
 * timeline renders the row alongside label diffs, no new storage or widgets.
 *
 * Three variants, all written with `changes_detected = 0` so they don't
 * inflate the unacknowledged-changes badge:
 *
 *   - `requested_snapshot` — we asked Save Page Now to archive the live
 *     App Store page for this app. Carries the save-now URL so the UI
 *     can link directly to the in-flight capture.
 *   - `save_now_failed`    — Save Page Now was tried and failed (timeout,
 *     non-200, missing URL). The failure reason rides in `description`.
 *   - `no_capture`         — archive.org has nothing near the target
 *     quarter *and* we already tried Save-Now for this app earlier in
 *     the same run (or deliberately opted out). Recorded so users see
 *     the per-quarter attempt rather than silent skipping.
 *
 * `targetDate` is the calendar quarter the importer was aiming at —
 * useful context ("Aimed at Q1 2026 — no archive found"), optional.
 */
export function appendWaybackAttemptEntry(
  appId: string,
  options: {
    event: 'requested_snapshot' | 'no_capture' | 'save_now_failed';
    description: string;
    details?: string[];
    saveNowUrl?: string;
    targetDate?: number;
  },
): void {
  const latest = getLatestSnapshot(appId) ?? [];
  const id = crypto.randomUUID();
  const entry: ChangeEntry = {
    type: 'wayback',
    description: options.description,
    category: 'wayback-attempt',
    wayback_event: options.event,
  };
  if (options.details && options.details.length > 0) entry.details = options.details;
  if (options.saveNowUrl) entry.save_now_url = options.saveNowUrl;
  if (typeof options.targetDate === 'number') entry.target_date = options.targetDate;

  db.prepare(`
    INSERT INTO privacy_snapshots
      (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,
       source, triggered_by)
    VALUES (?, ?, ?, ?, 0, ?, 'live', 'wayback')
  `).run(
    id,
    appId,
    Date.now(),
    JSON.stringify(latest),
    JSON.stringify([entry]),
  );
}

/** Return the most recent snapshot for an app, or null if none exists. */
export function getLatestSnapshot(appId: string): PrivacyTypeSnapshot[] | null {
  const row = db.prepare(`
    SELECT snapshot_json FROM privacy_snapshots
    WHERE app_id = ?
    ORDER BY scraped_at DESC
    LIMIT 1
  `).get(appId) as any;

  return row ? JSON.parse(row.snapshot_json) : null;
}

/**
 * Return paginated changelog entries for an app, newest first. Interleaves
 * privacy-snapshot rows with review-action rows so "Acknowledged on X" shows
 * up inline in the timeline. `limit` applies to the *merged* list, not each
 * source independently, so callers don't have to post-filter.
 */
export function getChangelog(appId: string, limit = 50): ChangelogRow[] {
  const snapshots = (db
    .prepare(`
      SELECT id, scraped_at, snapshot_json, changes_detected, changes_summary,
             source, wayback_snapshot_url, triggered_by,
             app_version, app_version_updated_at
      FROM privacy_snapshots
      WHERE app_id = ?
      ORDER BY scraped_at DESC
      LIMIT ?
    `)
    .all(appId, limit) as Array<{
      id: string;
      scraped_at: number;
      snapshot_json: string | null;
      changes_detected: number;
      changes_summary: string | null;
      source: string | null;
      wayback_snapshot_url: string | null;
      triggered_by: string | null;
      app_version: string | null;
      app_version_updated_at: number | null;
    }>).map<SnapshotChangelogRow>(row => ({
      kind: 'snapshot',
      id: row.id,
      scraped_at: row.scraped_at,
      snapshot_json: row.snapshot_json ?? null,
      changes_detected: row.changes_detected,
      changes_summary: row.changes_summary ? (JSON.parse(row.changes_summary) as ChangeEntry[]) : [],
      // Normalize NULL/missing source to 'live' so older rows (pre-migration)
      // still render correctly and the UI can branch on a guaranteed value.
      source: row.source === 'wayback' ? 'wayback' : 'live',
      wayback_snapshot_url: row.wayback_snapshot_url ?? null,
      triggered_by: normalizeTrigger(row.triggered_by, row.source),
      app_version: row.app_version ?? null,
      app_version_updated_at: row.app_version_updated_at ?? null,
    }));

  // Mark wayback rows whose snapshot content is byte-identical to an adjacent
  // live row. The UI uses this to show "Matches live sync" so users can see
  // at a glance that the back-filled baseline is the same privacy state Apple
  // is currently publishing. Equality is over the raw snapshot_json string —
  // we rebuild snapshots deterministically in buildSnapshot, so stringifying
  // twice in the same order is a reliable comparison.
  for (let i = 0; i < snapshots.length; i++) {
    const row = snapshots[i];
    if (row.source !== 'wayback' || !row.snapshot_json) continue;
    // Look at both neighbours because wayback rows are usually back-dated and
    // end up either immediately before or immediately after a live sync row
    // in the timeline, depending on when the import ran.
    const neighbours = [snapshots[i - 1], snapshots[i + 1]];
    for (const other of neighbours) {
      if (!other || other.source !== 'live' || !other.snapshot_json) continue;
      if (other.snapshot_json === row.snapshot_json) {
        row.matches_live_sync = true;
        break;
      }
    }
  }

  const reviews = (db
    .prepare(`
      SELECT id, acted_at, action, covered_count, covered_snapshot_ids,
             snooze_until, note
      FROM change_review_actions
      WHERE app_id = ?
      ORDER BY acted_at DESC
      LIMIT ?
    `)
    .all(appId, limit) as Array<{
      id: string;
      acted_at: number;
      action: ReviewAction;
      covered_count: number;
      covered_snapshot_ids: string | null;
      snooze_until: number | null;
      note: string | null;
    }>).map<ReviewChangelogRow>(row => ({
      kind: 'review',
      id: `review:${row.id}`,
      scraped_at: row.acted_at,
      action: row.action,
      covered_count: row.covered_count,
      // JSON-decoded list of snapshot ids covered at review time. Defensive
      // parse — malformed or missing rows (pre-migration) default to [].
      covered_snapshot_ids: parseCoveredSnapshotIds(row.covered_snapshot_ids),
      snooze_until: row.snooze_until,
      note: row.note,
    }));

  // Merge-sort by timestamp DESC. Stable tie-break: snapshot before review so
  // if a user clicks Mark-reviewed immediately after a sync lands the order on
  // screen reads "change detected → acknowledged" rather than the reverse.
  const merged: ChangelogRow[] = [...snapshots, ...reviews].sort((a, b) => {
    if (b.scraped_at !== a.scraped_at) return b.scraped_at - a.scraped_at;
    if (a.kind !== b.kind) return a.kind === 'snapshot' ? -1 : 1;
    return 0;
  });

  return merged.slice(0, limit);
}

/**
 * One row on the universal /changelog page. Each row is a single
 * `ChangeEntry` (one privacy category added, one accessibility feature
 * removed, one policy update, etc.) hoisted out of its parent snapshot
 * so the global feed can sort + filter at the entry level rather than
 * the snapshot level. The snapshot context (app, timestamp, source) is
 * stamped onto every row for rendering.
 */
export interface UniversalChangeRow {
  /** Stable id: `<snapshotId>:<entryIndex>`. Lets the UI render keys
   *  + scroll-to-row anchors without duplicate collisions. */
  id: string;
  appId: string;
  appName: string;
  appIconUrl: string | null;
  appDeveloper: string | null;
  scrapedAt: number;
  /** 'live' | 'wayback' — wayback rows are back-dated archive imports. */
  source: 'live' | 'wayback';
  /**
   * Inherited snapshot trigger so the UI can tag scheduled vs manual.
   * Reuses the `SyncTrigger` union (the same shape `normalizeTrigger`
   * returns) so that `'sample'` rows from the demo seed don't fail
   * type-check at the call-site. The UI renders `'sample'` as a plain
   * "live" row with no special pill, but the typing has to admit the
   * value to keep the assignment legal.
   */
  triggeredBy: SyncTrigger | null;
  entry: ChangeEntry;
}

export interface UniversalChangelogFilters {
  /** Inclusive window (epoch ms). Defaults to "all time" when omitted. */
  fromMs?: number;
  toMs?: number;
  /** Restrict to a specific tracked app id. */
  appId?: string;
  /** Restrict to one or more entry types — ChangeEntry.type. */
  types?: Array<ChangeEntry['type']>;
  /** Restrict to one or more entry categories — ChangeEntry.category. */
  categories?: Array<NonNullable<ChangeEntry['category']>>;
  /** Page size; defaults to 100. The UI is expected to paginate via
   *  `offset` rather than asking for huge limits. */
  limit?: number;
  /** Skip this many rows from the head of the (sorted) result set. */
  offset?: number;
}

/**
 * Universal changelog feed across every tracked app. Walks
 * `privacy_snapshots`, joins to apps for icon + name, and explodes
 * each snapshot's `changes_summary` JSON into one row per
 * `ChangeEntry`. Filters apply at the entry level so a snapshot with
 * mixed types is included or excluded per-entry rather than as a
 * whole.
 *
 * Returns `{ rows, total }` so the UI can render a "showing N of M"
 * footer and decide whether to render a Load-more button.
 */
export function listUniversalChangelog(
  opts: UniversalChangelogFilters = {},
): { rows: UniversalChangeRow[]; total: number } {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const offset = Math.max(0, opts.offset ?? 0);

  const where: string[] = ['s.changes_detected > 0'];
  const params: Array<number | string> = [];
  if (typeof opts.fromMs === 'number') {
    where.push('s.scraped_at >= ?');
    params.push(opts.fromMs);
  }
  if (typeof opts.toMs === 'number') {
    where.push('s.scraped_at <= ?');
    params.push(opts.toMs);
  }
  if (opts.appId) {
    where.push('s.app_id = ?');
    params.push(opts.appId);
  }

  // We can't filter ChangeEntry.type / .category at SQL level because
  // they live inside the JSON `changes_summary` blob. Pull a generous
  // page of candidate snapshots, expand entries in JS, then apply the
  // per-entry filter. The candidate cap is `limit * 8` so even when
  // most entries don't match the filter we still have a good chance of
  // filling the requested page in one DB pass.
  const candidateCap = Math.min(limit * 8, 4000);

  type Row = {
    snapshot_id: string;
    app_id: string;
    name: string;
    iconUrl: string | null;
    developer: string | null;
    scraped_at: number;
    changes_summary: string | null;
    source: string | null;
    triggered_by: string | null;
  };

  const candidates = (db
    .prepare(
      `SELECT s.id AS snapshot_id, s.app_id, a.name, a.iconUrl, a.developer,
              s.scraped_at, s.changes_summary, s.source, s.triggered_by
         FROM privacy_snapshots s
         JOIN apps a ON a.id = s.app_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.scraped_at DESC
        LIMIT ?`,
    )
    .all(...params, candidateCap)) as Row[];

  const typeSet = opts.types && opts.types.length > 0
    ? new Set<string>(opts.types)
    : null;
  const categorySet = opts.categories && opts.categories.length > 0
    ? new Set<string>(opts.categories)
    : null;

  const rowsAll: UniversalChangeRow[] = [];
  for (const r of candidates) {
    let entries: ChangeEntry[];
    try {
      entries = r.changes_summary
        ? (JSON.parse(r.changes_summary) as ChangeEntry[])
        : [];
    } catch {
      // Bad JSON — skip the snapshot rather than failing the whole feed.
      continue;
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (typeSet && !typeSet.has(entry.type)) continue;
      if (categorySet) {
        const c = entry.category ?? 'privacy-label';
        if (!categorySet.has(c)) continue;
      }
      rowsAll.push({
        id: `${r.snapshot_id}:${i}`,
        appId: r.app_id,
        appName: r.name,
        appIconUrl: r.iconUrl ?? null,
        appDeveloper: r.developer ?? null,
        scrapedAt: r.scraped_at,
        source: r.source === 'wayback' ? 'wayback' : 'live',
        triggeredBy: normalizeTrigger(r.triggered_by, r.source),
        entry,
      });
    }
  }

  return {
    rows: rowsAll.slice(offset, offset + limit),
    total: rowsAll.length,
  };
}

/**
 * Return every snapshot that detected changes after the user's last
 * acknowledgement. These are the entries the "What's changed" panel
 * shows until the user clicks Mark as reviewed.
 */
export function getUnacknowledgedChanges(appId: string): UnacknowledgedChanges {
  const row = db
    .prepare(
      'SELECT changes_acknowledged_at, changes_snoozed_until FROM apps WHERE id = ?',
    )
    .get(appId) as
    | { changes_acknowledged_at?: number; changes_snoozed_until?: number }
    | undefined;
  const since = row?.changes_acknowledged_at ?? 0;
  // Snooze expires automatically: anything in the past is as good as 0 so
  // the UI naturally re-surfaces the panel when the timer elapses without
  // any scheduled cleanup job.
  const rawSnoozeUntil = row?.changes_snoozed_until ?? 0;
  const snoozedUntil = rawSnoozeUntil > Date.now() ? rawSnoozeUntil : 0;

  const rows = db
    .prepare(`
      SELECT id, scraped_at, changes_summary
      FROM privacy_snapshots
      WHERE app_id = ? AND changes_detected = 1 AND scraped_at > ?
      ORDER BY scraped_at DESC
    `)
    .all(appId, since) as Array<{ id: string; scraped_at: number; changes_summary: string | null }>;

  const events: UnacknowledgedChangeEvent[] = rows.map(r => {
    let parsed: ChangeEntry[] = [];
    if (r.changes_summary) {
      try {
        parsed = JSON.parse(r.changes_summary) as ChangeEntry[];
      } catch {
        parsed = [];
      }
    }
    return { id: r.id, scraped_at: r.scraped_at, changes: parsed };
  });

  let addedCount = 0;
  let removedCount = 0;
  let totalCount = 0;
  for (const event of events) {
    for (const change of event.changes) {
      totalCount += 1;
      if (change.type === 'added') addedCount += 1;
      else if (change.type === 'removed') removedCount += 1;
    }
  }

  return { since, events, totalCount, addedCount, removedCount, snoozedUntil };
}

/**
 * Core writer for the acknowledgement panel. Records one row in
 * `change_review_actions` and — for terminal actions (reviewed, dismissed,
 * unsnoozed) — clears the changeCount badge and any lingering snooze so the
 * UI moves forward. Snooze stamps `changes_snoozed_until` but leaves
 * `changes_acknowledged_at` alone so the same change set re-surfaces once
 * the timer elapses.
 *
 * Returns the inserted row so callers can echo it back in the API response
 * (useful for optimistic UI or the History-timeline refresh).
 */
export function recordReviewAction(
  appId: string,
  options: { action: ReviewAction; snoozeDays?: SnoozeDays; note?: string },
): ReviewActionRecord {
  const { action, snoozeDays, note } = options;
  const now = Date.now();
  const id = crypto.randomUUID();

  // Snapshot the count AND the specific snapshot ids at the time of the
  // action. `covered_count` gives us "reviewed 4 changes" even if a
  // subsequent sync adds more entries before the row is read back; the
  // `covered_snapshot_ids` list lets the History timeline link each review
  // row to the exact syncs that were acknowledged, so clicking one flashes
  // the specific snapshot the user was reviewing. Snoozing captures both
  // too — the History reflects what was being deferred, and an unsnooze
  // later doesn't lose that provenance.
  const pending = getUnacknowledgedChanges(appId);
  const coveredCount = pending.totalCount;
  const coveredSnapshotIds = pending.events.map(e => e.id);
  const coveredSnapshotIdsJson =
    coveredSnapshotIds.length > 0 ? JSON.stringify(coveredSnapshotIds) : null;

  // Snapshot the apps-row state BEFORE the write so the response can
  // carry it back to the client for the Cmd-Z undo path. Captured
  // outside the transaction because the read doesn't need transactional
  // isolation against itself — the only mutator is the write below in
  // the same transaction, so pre-state is whatever's on disk right now.
  const preState = readReviewActionPreState(appId);

  let snoozeUntil: number | null = null;
  if (action === 'snoozed') {
    const days = snoozeDays ?? 7;
    snoozeUntil = now + days * 24 * 60 * 60 * 1000;
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO change_review_actions
         (id, app_id, action, acted_at, covered_count, covered_snapshot_ids,
          snooze_until, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      appId,
      action,
      now,
      coveredCount,
      coveredSnapshotIdsJson,
      snoozeUntil,
      note ?? null,
    );

    if (action === 'reviewed' || action === 'dismissed') {
      // Terminal actions advance the acknowledgement watermark and clear
      // any pending snooze (otherwise Mark-reviewed during a snooze would
      // silently leave the app in a snoozed-but-reviewed tombstone state
      // where the panel refuses to show the next change set).
      db.prepare(
        `UPDATE apps
            SET changeCount = 0,
                changes_acknowledged_at = ?,
                changes_snoozed_until = 0
          WHERE id = ?`,
      ).run(now, appId);
      db.prepare('UPDATE notifications SET read = 1 WHERE app_id = ? AND read = 0')
        .run(appId);
    } else if (action === 'snoozed') {
      db.prepare('UPDATE apps SET changes_snoozed_until = ? WHERE id = ?')
        .run(snoozeUntil, appId);
    } else if (action === 'unsnoozed') {
      db.prepare('UPDATE apps SET changes_snoozed_until = 0 WHERE id = ?')
        .run(appId);
    }
  });
  tx();

  return {
    id,
    app_id: appId,
    action,
    acted_at: now,
    covered_count: coveredCount,
    covered_snapshot_ids: coveredSnapshotIds,
    snooze_until: snoozeUntil,
    note: note ?? null,
    // Pre-action apps-row snapshot. Wired through here (rather than
    // through a second helper exported alongside) so existing callers
    // that just want "did the action take?" don't have to thread a
    // separate read. Optional field on the response type, so callers
    // that don't care can ignore it.
    pre_state: preState ?? undefined,
  };
}

/**
 * Back-compat alias. The original call site was a POST to the acknowledge
 * API with no body; keeping this export means a rollback of the API layer
 * still works even if someone calls the lib directly.
 */
export function acknowledgeChanges(appId: string): void {
  recordReviewAction(appId, { action: 'reviewed' });
}

/**
 * Snapshot of the `apps`-row state that {@link recordReviewAction} mutates.
 * Returned alongside the inserted `change_review_actions` row so the UI can
 * stash it in an undo op and replay the exact prior values via
 * {@link undoReviewAction}. Without this snapshot a Cmd-Z would have no
 * way to restore the watermark — `covered_count` only tells us how many
 * snapshots were unread at the moment of the action, not the precise
 * `changes_acknowledged_at` epoch we need to put back.
 */
export interface ReviewActionPreState {
  changeCount: number;
  changesAcknowledgedAt: number;
  changesSnoozedUntil: number;
}

/**
 * Read the three apps-row columns that {@link recordReviewAction} can
 * write to. Returns null if the row doesn't exist (which would have
 * blocked the action in the first place; the helper is defensive).
 */
function readReviewActionPreState(appId: string): ReviewActionPreState | null {
  const row = db
    .prepare(
      `SELECT changeCount, changes_acknowledged_at, changes_snoozed_until
         FROM apps WHERE id = ?`,
    )
    .get(appId) as
    | { changeCount: number; changes_acknowledged_at: number; changes_snoozed_until: number }
    | undefined;
  if (!row) return null;
  return {
    changeCount: row.changeCount,
    changesAcknowledgedAt: row.changes_acknowledged_at,
    changesSnoozedUntil: row.changes_snoozed_until,
  };
}

/**
 * Reverse a previous {@link recordReviewAction} call. Designed for the
 * Cmd-Z undo path on the change-review panel — the UI stashes the
 * inserted action's id plus the {@link ReviewActionPreState} snapshot
 * returned by `recordReviewAction`, and on undo posts both back here
 * together.
 *
 * Restoring runs in a single transaction:
 *   1. DELETE the `change_review_actions` row (scoped to `appId` so a
 *      stale or forged id can't wipe a row that belongs to another app).
 *   2. UPDATE the apps row's three review-related columns back to the
 *      pre-state values.
 *
 * Notifications that were marked read by the original action are NOT
 * automatically re-flipped to unread here — the bell exposes its own
 * mark-all flow and we'd risk resurrecting genuinely-read rows the user
 * had also acknowledged via a different path. The undo toast wording
 * acknowledges this: the change-review badge returns to its prior
 * count, but the bell stays cleared.
 *
 * Returns `{ ok: false }` when the row doesn't exist (probably a
 * stale undo stack — the user double-clicked Cmd+Z, or two tabs raced).
 */
export function undoReviewAction(
  appId: string,
  actionId: string,
  preState: ReviewActionPreState,
): { ok: boolean } {
  const tx = db.transaction(() => {
    const del = db
      .prepare(`DELETE FROM change_review_actions WHERE id = ? AND app_id = ?`)
      .run(actionId, appId);
    if (del.changes === 0) return false;
    db.prepare(
      `UPDATE apps
          SET changeCount = ?,
              changes_acknowledged_at = ?,
              changes_snoozed_until = ?
        WHERE id = ?`,
    ).run(
      preState.changeCount,
      preState.changesAcknowledgedAt,
      preState.changesSnoozedUntil,
      appId,
    );
    return true;
  });
  return { ok: tx() };
}

/**
 * Return review-panel actions for an app, newest first. Used by the
 * ChangelogTimeline to interleave acknowledgement events with privacy
 * snapshots, and by any UI that wants to show recent review activity in
 * isolation.
 */
export function getReviewActions(appId: string, limit = 50): ReviewActionRecord[] {
  const rows = db
    .prepare(
      `SELECT id, app_id, action, acted_at, covered_count, covered_snapshot_ids,
              snooze_until, note
         FROM change_review_actions
        WHERE app_id = ?
        ORDER BY acted_at DESC
        LIMIT ?`,
    )
    .all(appId, limit) as Array<{
      id: string;
      app_id: string;
      action: ReviewAction;
      acted_at: number;
      covered_count: number;
      covered_snapshot_ids: string | null;
      snooze_until: number | null;
      note: string | null;
    }>;
  return rows.map<ReviewActionRecord>(row => ({
    id: row.id,
    app_id: row.app_id,
    action: row.action,
    acted_at: row.acted_at,
    covered_count: row.covered_count,
    covered_snapshot_ids: parseCoveredSnapshotIds(row.covered_snapshot_ids),
    snooze_until: row.snooze_until,
    note: row.note,
  }));
}

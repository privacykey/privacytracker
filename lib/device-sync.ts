/**
 * Device re-sync diff engine.
 *
 * Two-phase model (mirrors the audit-bundle import preview → confirm
 * pattern):
 *   1. `computeDeviceSyncDiff(deviceId, currentApps)` — pure computation
 *      over the previous device app set + the incoming list. Returns
 *      `{ adds, removes, unchanged }`. The "removes" list flags each row
 *      with `wouldOrphan` so the UI can warn before committing.
 *   2. `applyDeviceSyncDiff(deviceId, selection)` — writes the user's
 *      ticked subset inside a single transaction.
 *
 * The diff is keyed by App Store track id when available; matching
 * incoming bundle IDs / names to a track id is the importer's job, not
 * this module's. We accept a list of `{ appId, ... }` rows that the
 * re-sync flow has already resolved.
 */

import db from "./db";
import { getDeviceById, orphanSweepApp, upsertAppDeviceLink } from "./devices";

/** A single app that the import flow says is currently on the device. */
export interface ImportedAppRef {
  /** App Store track id (the `apps.id` column). Required. */
  appId: string;
  bundleId?: string | null;
  developer?: string | null;
  iconUrl?: string | null;
  /** Display name — used in the diff UI when this app is new. */
  name: string;
  url?: string | null;
}

export interface DiffAdd {
  appId: string;
  bundleId: string | null;
  developer: string | null;
  iconUrl: string | null;
  name: string;
  url: string | null;
}

export interface DiffRemove {
  appId: string;
  name: string;
  /** True when removing this app from the device would untrack it
   *  everywhere (no other device links + no user verdicts / annotations /
   *  shortlist entries). Drives the orphan warning in the confirm UI. */
  wouldOrphan: boolean;
}

/**
 * A previous-row / incoming-row pair the diff matched by bundle ID
 * rather than appId. This happens when two import paths resolved the
 * same physical app to different App Store track IDs (e.g., a legacy
 * name-search import vs. a cfgutil bundle-ID lookup). Treated as
 * "unchanged" in the user-visible counts; the commit step transfers
 * user data from `previousAppId` to `incomingAppId` and drops the
 * orphaned previous row, collapsing the duplicate.
 */
export interface DiffBundleIdMerge {
  bundleId: string;
  /** The track ID on the row the new import resolved to. */
  incomingAppId: string;
  /** Display name from the incoming row. */
  incomingName: string;
  /** The track ID stored on the previous row (the duplicate). */
  previousAppId: string;
  /** Display name from the previous row — used by the activity log. */
  previousName: string;
}

export interface DeviceSyncDiff {
  adds: DiffAdd[];
  /**
   * Same-bundle, different-track-ID pairs detected at diff time. Empty
   * on clean imports; populated when the previous device app set has
   * rows that the new import is about to replace with same-bundle
   * duplicates. The commit step processes these to merge user data
   * across the duplicate rows before applying the rest of the diff.
   */
  bundleIdMerges: DiffBundleIdMerge[];
  deviceId: string;
  removes: DiffRemove[];
  unchanged: number;
}

/** Compute the diff between the device's current app set and the
 *  incoming import list. Pure over its inputs (one indexed read for the
 *  device's app ids). */
export function computeDeviceSyncDiff(
  deviceId: string,
  currentImport: ImportedAppRef[]
): DeviceSyncDiff {
  const device = getDeviceById(deviceId);
  if (!device) {
    throw new Error(`unknown deviceId: ${deviceId}`);
  }

  // Previous app set for this device, from the junction. We pull the
  // bundle ID alongside the track ID + name so the bundle-ID overlap
  // check below can match incoming rows that have the same bundle ID
  // as a previous row but a different track ID (a legacy artifact —
  // see DiffBundleIdMerge for the full backstory).
  const previousRows = db
    .prepare(`
      SELECT ad.app_id AS app_id, a.name AS name, a.bundleId AS bundle_id
      FROM app_devices ad
      JOIN apps a ON a.id = ad.app_id
      WHERE ad.device_id = ?
    `)
    .all(deviceId) as {
    app_id: string;
    name: string;
    bundle_id: string | null;
  }[];
  const previousById = new Map(previousRows.map((r) => [r.app_id, r.name]));
  // Reverse lookup: bundleId → previousAppId/name. Empty bundle IDs
  // (legacy rows without one) skip the overlap path entirely.
  const previousByBundleId = new Map<string, { appId: string; name: string }>();
  for (const row of previousRows) {
    if (row.bundle_id && row.bundle_id.length > 0) {
      previousByBundleId.set(row.bundle_id, {
        appId: row.app_id,
        name: row.name,
      });
    }
  }

  // Dedupe the incoming list by appId — the importer may surface the
  // same row twice if it came through two paths.
  const incomingById = new Map<string, ImportedAppRef>();
  for (const row of currentImport) {
    if (!row.appId) {
      continue;
    }
    if (!incomingById.has(row.appId)) {
      incomingById.set(row.appId, row);
    }
  }

  const adds: DiffAdd[] = [];
  const bundleIdMerges: DiffBundleIdMerge[] = [];
  // Track which previous appIds were "absorbed" into an incoming row
  // via bundle-ID overlap. Those don't fall into `removes` — the
  // commit step will merge the row into the incoming appId instead.
  const absorbedPreviousIds = new Set<string>();
  let unchanged = 0;
  for (const [appId, row] of incomingById) {
    if (previousById.has(appId)) {
      // Exact track-ID match — already linked, nothing to do.
      unchanged += 1;
      continue;
    }
    // Fall back to bundle-ID overlap. A previous row with the same
    // bundle ID but a different track ID is the migration artifact
    // we want to collapse — treat it as unchanged for the user-visible
    // counts and queue a merge for the commit step.
    const bundleId = row.bundleId ?? null;
    if (bundleId) {
      const prev = previousByBundleId.get(bundleId);
      if (prev && prev.appId !== appId) {
        absorbedPreviousIds.add(prev.appId);
        bundleIdMerges.push({
          previousAppId: prev.appId,
          incomingAppId: appId,
          bundleId,
          previousName: prev.name,
          incomingName: row.name,
        });
        unchanged += 1;
        continue;
      }
    }
    adds.push({
      appId,
      name: row.name,
      developer: row.developer ?? null,
      url: row.url ?? null,
      iconUrl: row.iconUrl ?? null,
      bundleId: row.bundleId ?? null,
    });
  }

  const removes: DiffRemove[] = [];
  for (const [appId, name] of previousById) {
    if (incomingById.has(appId)) {
      continue;
    }
    if (absorbedPreviousIds.has(appId)) {
      continue;
    }
    removes.push({
      appId,
      name,
      wouldOrphan: wouldOrphanIfUnlinkedFromDevice(appId, deviceId),
    });
  }

  return { deviceId, adds, removes, unchanged, bundleIdMerges };
}

/**
 * Returns true if dropping the (appId, deviceId) row would leave the app
 * with no other device links AND no attached user data (user verdicts /
 * annotations / shortlist entries).
 *
 * Visible to the resolver only; not exported because the UI gets the
 * pre-computed `wouldOrphan` boolean inside `DiffRemove`.
 */
function wouldOrphanIfUnlinkedFromDevice(
  appId: string,
  deviceId: string
): boolean {
  // Other devices still linked?
  const otherLinks = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM app_devices WHERE app_id = ? AND device_id != ?"
      )
      .get(appId, deviceId) as { n: number }
  ).n;
  if (otherLinks > 0) {
    return false;
  }

  // Attached user data?
  const checks = [
    "SELECT 1 FROM app_verdicts WHERE app_id = ? AND source = 'user' LIMIT 1",
    "SELECT 1 FROM annotations WHERE app_id = ? LIMIT 1",
    "SELECT 1 FROM shortlist_entries WHERE app_id = ? LIMIT 1",
  ];
  for (const sql of checks) {
    try {
      if (db.prepare(sql).get(appId)) {
        return false;
      }
    } catch {
      // Table doesn't exist on this DB — skip.
    }
  }
  return true;
}

export interface ApplyDeviceSyncSelection {
  /** App ids the user wants to ADD to the device (subset of diff.adds.appId). */
  addAppIds: string[];
  /**
   * Same-bundle, different-track-ID pairs the diff detected. The
   * commit step transfers user data (verdicts, annotations, shortlist,
   * device links, snapshots) from `previousAppId` to `incomingAppId`
   * and deletes the orphaned previous row. Optional so the existing
   * test fixtures + callers that don't surface merges still work.
   */
  bundleIdMerges?: ReadonlyArray<{
    previousAppId: string;
    incomingAppId: string;
  }>;
  /** App ids the user wants to REMOVE from the device (subset of diff.removes.appId). */
  removeAppIds: string[];
}

export interface ApplyDeviceSyncResult {
  added: number;
  /** Number of same-bundle duplicates collapsed into their canonical row. */
  merged: number;
  orphanedAndDeleted: number;
  removed: number;
}

/**
 * Commit the user's diff selection. Single transaction: process
 * bundle-ID merges first (so a "remove" doesn't trip an orphan sweep
 * before the user data has been transferred), then bulk add via
 * `upsertAppDeviceLink`, bulk remove via direct delete, then
 * orphan-sweep over the removed app ids. Touches
 * `devices.last_synced_at`.
 */
export function applyDeviceSyncDiff(
  deviceId: string,
  selection: ApplyDeviceSyncSelection
): ApplyDeviceSyncResult {
  const device = getDeviceById(deviceId);
  if (!device) {
    throw new Error(`unknown deviceId: ${deviceId}`);
  }

  const now = Date.now();
  let added = 0;
  let removed = 0;
  let orphanedAndDeleted = 0;
  let merged = 0;

  const tx = db.transaction(() => {
    // Process bundle-ID merges up front. Each merge transfers all
    // user data from the previous appId onto the incoming appId, then
    // drops the previous row entirely. Doing this first means a later
    // `removeAppIds` entry pointing at the same previousAppId becomes
    // a no-op (the row is gone) rather than tripping an orphan sweep
    // that would lose the data we just transferred.
    for (const pair of selection.bundleIdMerges ?? []) {
      const { previousAppId, incomingAppId } = pair;
      if (
        !(previousAppId && incomingAppId) ||
        previousAppId === incomingAppId
      ) {
        continue;
      }
      const incomingExists = db
        .prepare("SELECT 1 FROM apps WHERE id = ?")
        .get(incomingAppId);
      const previousExists = db
        .prepare("SELECT 1 FROM apps WHERE id = ?")
        .get(previousAppId);
      if (!(incomingExists && previousExists)) {
        continue;
      }
      transferUserDataAcrossAppIds(previousAppId, incomingAppId);
      // The previous row's app_devices links → switch to incoming.
      // INSERT OR IGNORE avoids the PK collision when the incoming
      // row is already linked to the same device(s).
      db.prepare(`
        INSERT OR IGNORE INTO app_devices (app_id, device_id, first_seen_at, last_seen_at)
        SELECT ?, device_id, first_seen_at, last_seen_at
        FROM app_devices WHERE app_id = ?
      `).run(incomingAppId, previousAppId);
      db.prepare("DELETE FROM app_devices WHERE app_id = ?").run(previousAppId);
      // Finally drop the orphan app row. FK cascades clear privacy
      // snapshots + type/category rows automatically.
      db.prepare("DELETE FROM apps WHERE id = ?").run(previousAppId);
      merged += 1;
    }

    for (const appId of selection.addAppIds) {
      // Validate that the app actually exists; silently skip stale ids.
      const exists = db.prepare("SELECT 1 FROM apps WHERE id = ?").get(appId);
      if (!exists) {
        continue;
      }
      upsertAppDeviceLink(appId, deviceId, now);
      added += 1;
    }
    for (const appId of selection.removeAppIds) {
      const r = db
        .prepare("DELETE FROM app_devices WHERE app_id = ? AND device_id = ?")
        .run(appId, deviceId);
      if (r.changes > 0) {
        removed += 1;
        if (orphanSweepApp(appId)) {
          orphanedAndDeleted += 1;
        }
      }
    }
    db.prepare("UPDATE devices SET last_synced_at = ? WHERE id = ?").run(
      now,
      deviceId
    );
  });
  tx();

  return { added, removed, orphanedAndDeleted, merged };
}

/**
 * Move user-authored data (annotations, verdicts, shortlist entries,
 * privacy snapshots, etc.) from `oldAppId` onto `newAppId` so the
 * caller can safely delete the `oldAppId` row without losing the
 * user's work. Each table is touched defensively — a missing table
 * (older DB / mid-migration) skips rather than throwing.
 *
 * Conflicts are resolved with the "keep both, prefer the newer" rule
 * where possible (UNIQUE constraint hits become updates), or "keep
 * the existing newAppId row" where merging doesn't make sense (a
 * single shortlist entry per app, etc.). The previous row is
 * destined for deletion either way, so any data not transferred is
 * gone permanently — defensive UPDATE OR REPLACE / INSERT OR IGNORE
 * are intentional, not bugs.
 */
function transferUserDataAcrossAppIds(
  oldAppId: string,
  newAppId: string
): void {
  const updates: Array<{ sql: string }> = [
    // Annotations — repoint to the new app id. No UNIQUE constraint
    // on (app_id, …), so a straight UPDATE moves every row.
    { sql: "UPDATE annotations SET app_id = ? WHERE app_id = ?" },
    // Verdicts — UNIQUE(app_id, source, source_name). Drop any
    // existing verdict on the NEW row from the same source first so
    // the move doesn't fail; the previous row's verdict was the one
    // the user set most recently (we already de-duped by bundle ID).
    {
      sql: `
        DELETE FROM app_verdicts
        WHERE app_id = ?
          AND (app_id, source, COALESCE(source_name, ''))
            IN (
              SELECT ?, source, COALESCE(source_name, '')
              FROM app_verdicts WHERE app_id = ?
            )
      `,
    },
    { sql: "UPDATE app_verdicts SET app_id = ? WHERE app_id = ?" },
    // Shortlist entries — UNIQUE(source_app_id, candidate_name).
    // Best-effort: drop conflicts on the new id first.
    {
      sql: `
        DELETE FROM shortlist_entries
        WHERE source_app_id = ?
          AND candidate_name IN (
            SELECT candidate_name FROM shortlist_entries WHERE source_app_id = ?
          )
      `,
    },
    {
      sql: "UPDATE shortlist_entries SET source_app_id = ? WHERE source_app_id = ?",
    },
  ];
  for (const stmt of updates) {
    try {
      // The "delete conflicting rows first" variants take (newAppId, newAppId, oldAppId)
      // — i.e., three params — while plain UPDATEs take (newAppId, oldAppId).
      const expectedParams = (stmt.sql.match(/\?/g) ?? []).length;
      if (expectedParams === 3) {
        db.prepare(stmt.sql).run(newAppId, newAppId, oldAppId);
      } else {
        db.prepare(stmt.sql).run(newAppId, oldAppId);
      }
    } catch (e) {
      // Table doesn't exist on this DB, or another constraint we
      // didn't anticipate. Skip — losing one tangential row from a
      // merge is preferable to aborting the whole transaction.
      console.warn(
        "[device-sync] transferUserDataAcrossAppIds skipped statement:",
        (e as Error).message
      );
    }
  }
  // Privacy snapshots / change rows — these carry the per-app
  // historical record. We keep the previous row's snapshots so the
  // user doesn't lose history when the duplicate collapses. Any row
  // on the new id that pre-dates the merge stays; the old rows are
  // repointed via straight UPDATE.
  try {
    db.prepare("UPDATE privacy_snapshots SET app_id = ? WHERE app_id = ?").run(
      newAppId,
      oldAppId
    );
  } catch (e) {
    console.warn(
      "[device-sync] snapshot transfer skipped:",
      (e as Error).message
    );
  }
}

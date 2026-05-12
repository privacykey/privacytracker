/**
 * Read/write helpers for `related_apps_observed`.
 *
 * The table captures the App Store product-page shelves that we already
 * fetch HTML for during a normal privacy-label scrape:
 *
 *   - 'may_also_like'      — Apple's "Customers Also Bought" / "You Might
 *                            Also Like" shelf at the bottom of every
 *                            product page.
 *   - 'more_by_developer'  — the smaller shelf above that, same developer.
 *
 * Replace-on-write semantics live in {@link replaceRelatedAppsForSource}:
 * every time the source app is rescraped, the writer wipes existing rows
 * for that (source_app_id, shelf_type) tuple and reinserts. This keeps
 * the table from accumulating stale entries when Apple rotates the
 * shelf — at any moment, the table only ever reflects what the LAST
 * scrape saw.
 *
 * Reads return `RelatedAppRow[]` in insertion order (most-recently
 * observed first within a shelf), which is the order Apple presents
 * them on the product page.
 */

import db from './db';

export type RelatedShelfType = 'may_also_like' | 'more_by_developer';

export interface RelatedAppRow {
  sourceAppId:       string;
  relatedAppleId:    string;
  relatedName:       string;
  relatedDeveloper:  string | null;
  relatedIconUrl:    string | null;
  relatedStoreUrl:   string;
  shelfType:         RelatedShelfType;
  observedAt:        number;
}

/** Subset of {@link RelatedAppRow} that the scraper produces, before we know `observedAt`. */
export interface RelatedAppInput {
  relatedAppleId:    string;
  relatedName:       string;
  relatedDeveloper:  string | null;
  relatedIconUrl:    string | null;
  relatedStoreUrl:   string;
  shelfType:         RelatedShelfType;
}

// Internal — DB row shape (snake_case).
interface DbRow {
  source_app_id:      string;
  related_apple_id:   string;
  related_name:       string;
  related_developer:  string | null;
  related_icon_url:   string | null;
  related_store_url:  string;
  shelf_type:         RelatedShelfType;
  observed_at:        number;
}

function rowToRelated(row: DbRow): RelatedAppRow {
  return {
    sourceAppId:      row.source_app_id,
    relatedAppleId:   row.related_apple_id,
    relatedName:      row.related_name,
    relatedDeveloper: row.related_developer,
    relatedIconUrl:   row.related_icon_url,
    relatedStoreUrl:  row.related_store_url,
    shelfType:        row.shelf_type,
    observedAt:       row.observed_at,
  };
}

// ─────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────

/**
 * Apps observed on the "Customers Also Bought" shelf during the source
 * app's last scrape. Order matches Apple's presentation order.
 */
export function getMayAlsoLike(sourceAppId: string): RelatedAppRow[] {
  const rows = db.prepare(
    `SELECT source_app_id, related_apple_id, related_name, related_developer,
            related_icon_url, related_store_url, shelf_type, observed_at
     FROM related_apps_observed
     WHERE source_app_id = ? AND shelf_type = 'may_also_like'
     ORDER BY observed_at DESC, related_apple_id ASC`,
  ).all(sourceAppId) as DbRow[];
  return rows.map(rowToRelated);
}

/**
 * Apps observed on the "More By This Developer" shelf. Same source ordering
 * convention as {@link getMayAlsoLike}.
 */
export function getMoreByDeveloper(sourceAppId: string): RelatedAppRow[] {
  const rows = db.prepare(
    `SELECT source_app_id, related_apple_id, related_name, related_developer,
            related_icon_url, related_store_url, shelf_type, observed_at
     FROM related_apps_observed
     WHERE source_app_id = ? AND shelf_type = 'more_by_developer'
     ORDER BY observed_at DESC, related_apple_id ASC`,
  ).all(sourceAppId) as DbRow[];
  return rows.map(rowToRelated);
}

/**
 * Both shelves at once, grouped by shelf_type. Used by the Compare view
 * if we ever want to render both shelves side-by-side; currently the
 * UI only surfaces 'may_also_like'.
 */
export function getRelatedAppsForSource(sourceAppId: string): Record<RelatedShelfType, RelatedAppRow[]> {
  return {
    may_also_like:     getMayAlsoLike(sourceAppId),
    more_by_developer: getMoreByDeveloper(sourceAppId),
  };
}

// ─────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────

/**
 * Atomic replace: wipe every row for the source app (all shelf types)
 * and reinsert the new set in a single transaction. `observedAt`
 * defaults to `Date.now()` so callers don't have to thread time
 * through the scraper.
 *
 * Empty `inputs` array still triggers the delete — meaning "this scrape
 * confirmed there are no shelves on the page right now." That's a real
 * signal we don't want to lose. Callers that want the prior state
 * preserved should skip the call entirely.
 */
export function replaceRelatedAppsForSource(
  sourceAppId: string,
  inputs: readonly RelatedAppInput[],
  observedAt: number = Date.now(),
): void {
  const del = db.prepare(`DELETE FROM related_apps_observed WHERE source_app_id = ?`);
  const ins = db.prepare(
    `INSERT INTO related_apps_observed
       (source_app_id, related_apple_id, related_name, related_developer,
        related_icon_url, related_store_url, shelf_type, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    del.run(sourceAppId);
    for (const row of inputs) {
      ins.run(
        sourceAppId,
        row.relatedAppleId,
        row.relatedName,
        row.relatedDeveloper,
        row.relatedIconUrl,
        row.relatedStoreUrl,
        row.shelfType,
        observedAt,
      );
    }
  })();
}

/** Test helper: hard-delete everything (used by resetTestDb / Dev Options purge). */
export function purgeAllRelatedApps(): number {
  return db.prepare(`DELETE FROM related_apps_observed`).run().changes;
}

import type { ChangeEntry } from "./changelog";
import db from "./db";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface TriageApp {
  categoryCount: number;
  developer?: string;
  iconUrl?: string;
  id: string;
  lastSynced: number;
  linkedCount: number;
  name: string;
  riskLevel: "high" | "moderate" | "low" | "minimal";
  riskScore: number;
  trackCount: number;
  unlinkedCount: number;
}

/**
 * Distinct `ChangeEntry.category` values that can appear in a reviewable
 * app's most recent change bundle. Kept as a literal union (rather than
 * reusing the ChangeEntry union) so the type stays focused on what the
 * home-page summary actually cares about — wayback-attempt entries never
 * reach the reviewable list because they're persisted with
 * `skipChangeCountBump`, so the home page only ever needs these three.
 */
export type ReviewableChangeCategory =
  | "privacy-label"
  | "accessibility"
  | "privacy-policy";

export interface ReviewableApp extends TriageApp {
  /**
   * Distinct change categories present in the most recent unacknowledged
   * change bundle. Lets the home-page summary render dynamic copy like
   * "Apple updated the accessibility labels on …" vs. the old hard-coded
   * privacy-labels-only sentence. Legacy entries with no explicit
   * `category` field default to `privacy-label` so pre-accessibility rows
   * keep the original wording.
   */
  categories: ReviewableChangeCategory[];
  changeCount: number;
  /** Most recent scrape that detected changes since last ack */
  lastChangeAt: number;
  /** Human-readable summary of the most important change */
  topChange: string | null;
}

export interface RecentActivityEntry {
  addedCount: number;
  appId: string;
  appName: string;
  iconUrl?: string;
  modifiedCount: number;
  removedCount: number;
  scrapedAt: number;
  topChange: string | null;
}

export interface TriageData {
  changesThisWeek: number;
  higherRisk: TriageApp[];
  highRiskCount: number;
  lastSyncedAt: number;
  moderateRiskCount: number;
  /** True when nothing in the list calls for action right now. */
  quiet: boolean;
  recentActivity: RecentActivityEntry[];
  reviewable: ReviewableApp[];
  stale: TriageApp[];
  staleCount: number;
  totalApps: number;
  totalCategories: number;
}

// ─────────────────────────────────────────────
// Risk helpers (must stay in sync with AppGrid.tsx)
// ─────────────────────────────────────────────

function riskScore(t: number, l: number, u: number): number {
  return t * 10 + l * 3 + u * 1;
}

function riskLevel(t: number, l: number, u: number): TriageApp["riskLevel"] {
  if (t >= 1) {
    return "high";
  }
  if (l >= 3) {
    return "moderate";
  }
  if (l >= 1 || u >= 1) {
    return "low";
  }
  return "minimal";
}

// ─────────────────────────────────────────────
// Main query
// ─────────────────────────────────────────────

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Pick the single "most notable" change from a list: first `added`, else `removed`, else first. */
function pickTopChange(entries: ChangeEntry[]): string | null {
  if (!entries.length) {
    return null;
  }
  const added = entries.find((e) => e.type === "added");
  if (added) {
    return added.description;
  }
  const removed = entries.find((e) => e.type === "removed");
  if (removed) {
    return removed.description;
  }
  return entries[0].description;
}

export function getTriageData(): TriageData {
  const now = Date.now();

  const rows = db
    .prepare(
      `
    SELECT a.id, a.name, a.iconUrl, a.developer, a.lastSynced,
      a.changeCount, a.changes_acknowledged_at,
      (SELECT COUNT(c.id) FROM privacy_categories c JOIN privacy_types t ON c.type_id = t.id WHERE t.app_id = a.id) AS categoryCount,
      (SELECT COUNT(c.id) FROM privacy_categories c JOIN privacy_types t ON c.type_id = t.id
        WHERE t.app_id = a.id AND t.identifier = 'DATA_USED_TO_TRACK_YOU') AS trackCount,
      (SELECT COUNT(c.id) FROM privacy_categories c JOIN privacy_types t ON c.type_id = t.id
        WHERE t.app_id = a.id AND t.identifier = 'DATA_LINKED_TO_YOU') AS linkedCount,
      (SELECT COUNT(c.id) FROM privacy_categories c JOIN privacy_types t ON c.type_id = t.id
        WHERE t.app_id = a.id AND t.identifier = 'DATA_NOT_LINKED_TO_YOU') AS unlinkedCount
    FROM apps a
    ORDER BY a.name ASC
    `
    )
    .all() as Array<{
    id: string;
    name: string;
    iconUrl?: string;
    developer?: string;
    lastSynced: number;
    changeCount: number;
    changes_acknowledged_at?: number;
    categoryCount: number;
    trackCount: number;
    linkedCount: number;
    unlinkedCount: number;
  }>;

  const triageApps: (TriageApp & {
    changeCount: number;
    acknowledgedAt: number;
  })[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    iconUrl: r.iconUrl,
    developer: r.developer,
    lastSynced: r.lastSynced,
    categoryCount: r.categoryCount,
    trackCount: r.trackCount,
    linkedCount: r.linkedCount,
    unlinkedCount: r.unlinkedCount,
    riskScore: riskScore(r.trackCount, r.linkedCount, r.unlinkedCount),
    riskLevel: riskLevel(r.trackCount, r.linkedCount, r.unlinkedCount),
    changeCount: r.changeCount ?? 0,
    acknowledgedAt: r.changes_acknowledged_at ?? 0,
  }));

  const totalApps = triageApps.length;
  const totalCategories = triageApps.reduce(
    (sum, a) => sum + a.categoryCount,
    0
  );
  const highRiskCount = triageApps.filter((a) => a.riskLevel === "high").length;
  const moderateRiskCount = triageApps.filter(
    (a) => a.riskLevel === "moderate"
  ).length;
  const staleCount = triageApps.filter(
    (a) => now - a.lastSynced > THIRTY_DAYS_MS
  ).length;
  const lastSyncedAt = triageApps.reduce(
    (max, a) => Math.max(max, a.lastSynced),
    0
  );

  // ── Reviewable apps: anything with unacknowledged changes ──
  const reviewable: ReviewableApp[] = [];
  for (const app of triageApps) {
    if (app.changeCount <= 0) {
      continue;
    }

    const snapshotRow = db
      .prepare(
        `
        SELECT scraped_at, changes_summary
        FROM privacy_snapshots
        WHERE app_id = ? AND changes_detected = 1 AND scraped_at > ?
        ORDER BY scraped_at DESC
        LIMIT 1
      `
      )
      .get(app.id, app.acknowledgedAt) as
      | { scraped_at: number; changes_summary: string | null }
      | undefined;

    let topChange: string | null = null;
    let lastChangeAt = app.lastSynced;
    const categorySet = new Set<ReviewableChangeCategory>();
    if (snapshotRow) {
      lastChangeAt = snapshotRow.scraped_at;
      if (snapshotRow.changes_summary) {
        try {
          const parsed = JSON.parse(
            snapshotRow.changes_summary
          ) as ChangeEntry[];
          topChange = pickTopChange(parsed);
          for (const entry of parsed) {
            // Legacy rows written before the category field existed default
            // to privacy-label — that's what the diff pipeline produced
            // exclusively pre-accessibility. Wayback-attempt is filtered
            // out: those rows never land here anyway (saveSnapshot passes
            // skipChangeCountBump for wayback imports) but this keeps the
            // summary honest if some future flow ever bumps changeCount
            // via a wayback path.
            const raw = entry.category ?? "privacy-label";
            if (
              raw === "privacy-label" ||
              raw === "accessibility" ||
              raw === "privacy-policy"
            ) {
              categorySet.add(raw);
            }
          }
        } catch {
          topChange = null;
        }
      }
    }

    // Order the array deterministically (privacy-label first, then
    // accessibility, then policy) so downstream renderers don't have to
    // re-sort. A stable order also keeps React keys + memoised copy
    // generation consistent across renders of the same data.
    const categories: ReviewableChangeCategory[] = [
      "privacy-label",
      "accessibility",
      "privacy-policy",
    ].filter((c): c is ReviewableChangeCategory =>
      categorySet.has(c as ReviewableChangeCategory)
    );

    reviewable.push({
      ...app,
      lastChangeAt,
      topChange,
      categories,
    });
  }
  reviewable.sort((a, b) => b.lastChangeAt - a.lastChangeAt);

  // ── Higher-risk apps: top by risk score, filtered to anything non-minimal ──
  const higherRisk = triageApps
    .filter((a) => a.riskLevel === "high" || a.riskLevel === "moderate")
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 6)
    .map((a) => stripExtras(a));

  // ── Stale apps: not synced in >30 days ──
  const stale = triageApps
    .filter((a) => now - a.lastSynced > THIRTY_DAYS_MS)
    .sort((a, b) => a.lastSynced - b.lastSynced)
    .slice(0, 6)
    .map((a) => stripExtras(a));

  // ── Changes this week + recent activity feed ──
  const weekAgo = now - SEVEN_DAYS_MS;
  const weekSnapshots = db
    .prepare(
      `
      SELECT ps.app_id, ps.scraped_at, ps.changes_summary, a.name, a.iconUrl
      FROM privacy_snapshots ps
      JOIN apps a ON a.id = ps.app_id
      WHERE ps.changes_detected = 1 AND ps.scraped_at > ?
      ORDER BY ps.scraped_at DESC
      LIMIT 8
    `
    )
    .all(weekAgo) as Array<{
    app_id: string;
    scraped_at: number;
    changes_summary: string | null;
    name: string;
    iconUrl?: string;
  }>;

  let changesThisWeek = 0;
  const recentActivity: RecentActivityEntry[] = weekSnapshots.map((row) => {
    let entries: ChangeEntry[] = [];
    if (row.changes_summary) {
      try {
        entries = JSON.parse(row.changes_summary) as ChangeEntry[];
      } catch {
        entries = [];
      }
    }
    changesThisWeek += entries.length;
    return {
      appId: row.app_id,
      appName: row.name,
      iconUrl: row.iconUrl,
      scrapedAt: row.scraped_at,
      addedCount: entries.filter((e) => e.type === "added").length,
      removedCount: entries.filter((e) => e.type === "removed").length,
      modifiedCount: entries.filter((e) => e.type === "modified").length,
      topChange: pickTopChange(entries),
    };
  });

  // "Quiet" is about whether there's anything *actionable* right now.
  // Higher-risk apps are ongoing state, not an alert, so they don't keep the
  // hero in attention mode.
  const quiet = reviewable.length === 0 && staleCount === 0 && totalApps > 0;

  return {
    totalApps,
    totalCategories,
    highRiskCount,
    moderateRiskCount,
    staleCount,
    lastSyncedAt,
    changesThisWeek,
    reviewable: reviewable.slice(0, 6),
    higherRisk,
    stale,
    recentActivity,
    quiet,
  };
}

function stripExtras(
  app: TriageApp & { changeCount: number; acknowledgedAt: number }
): TriageApp {
  const { changeCount: _cc, acknowledgedAt: _ack, ...rest } = app;
  void _cc;
  void _ack;
  return rest;
}

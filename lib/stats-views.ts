/**
 * Data helpers that back the Statistics page's visualisation sections
 * (heatmap, sankey, radar, stacked-area timeline, small multiples).
 *
 * Kept separate from lib/stats.ts so the cheap summary cards at the top of
 * the page don't trigger the heavier queries here when the viz panels
 * aren't rendered — the routes (/api/stats/matrix, /timeline, /radar) call
 * these individually so Next can stream them.
 *
 * Severity identifiers live on privacy_types.identifier (one of three
 * DATA_* strings). Category identifiers live on privacy_categories.identifier
 * (14 canonical strings from CATEGORY_META, plus OTHER/unknowns tolerated).
 */
import db from "./db";
import type {
  PolicyLensKey,
  PolicyRating,
  PolicySummary,
} from "./policy-summary-meta";
import { POLICY_LENSES, POLICY_RATINGS } from "./policy-summary-meta";
import { CATEGORY_META, SEVERITY_CONFIG } from "./privacy-meta";
import type {
  MatrixApp,
  MatrixCategory,
  MatrixData,
  RadarApp,
  RadarData,
  RadarLens,
  SeverityId,
  TimelineBucket,
  TimelineData,
  TimelinePoint,
} from "./stats-views-shared";

// Re-export the shared types so existing callers that import from
// './stats-views' keep working. RADAR_MAX is re-exported below near the
// radar helper for discoverability.
export type {
  MatrixApp,
  MatrixCategory,
  MatrixData,
  RadarApp,
  RadarData,
  RadarLens,
  SeverityId,
  TimelineBucket,
  TimelineData,
  TimelinePoint,
};

const SEVERITY_ORDER: SeverityId[] = [
  "DATA_USED_TO_TRACK_YOU",
  "DATA_LINKED_TO_YOU",
  "DATA_NOT_LINKED_TO_YOU",
];

// ──────────────────────────────────────────────────────────────────────
// Matrix — apps × category × severity
//   Drives: heatmap, sankey, small multiples. One shot so all three views
//   use identical data and Apple-category-order. Types live in
//   ./stats-views-shared.ts so client components can consume them without
//   transitively pulling in better-sqlite3.
// ──────────────────────────────────────────────────────────────────────

export function getMatrixData(): MatrixData {
  const apps = db
    .prepare(`
    SELECT a.id, a.name, a.iconUrl, a.developer,
           (SELECT COUNT(DISTINCT c.identifier)
              FROM privacy_categories c
              JOIN privacy_types t ON t.id = c.type_id
             WHERE t.app_id = a.id) AS categoryCount
    FROM apps a
    ORDER BY a.name COLLATE NOCASE
  `)
    .all() as MatrixApp[];

  // All (app, category, severity) triples. Apps that publish nothing simply
  // contribute no rows here; the UI handles the empty case.
  const rows = db
    .prepare(`
    SELECT t.app_id       AS appId,
           t.identifier   AS sev,
           c.identifier   AS cat
    FROM privacy_categories c
    JOIN privacy_types t ON t.id = c.type_id
  `)
    .all() as { appId: string; sev: string; cat: string }[];

  const cells: Record<string, Record<string, SeverityId>> = {};
  const catCounts = new Map<string, Set<string>>();
  const sevRank: Record<SeverityId, number> = {
    DATA_USED_TO_TRACK_YOU: 3,
    DATA_LINKED_TO_YOU: 2,
    DATA_NOT_LINKED_TO_YOU: 1,
  };

  for (const { appId, sev, cat } of rows) {
    if (!SEVERITY_ORDER.includes(sev as SeverityId)) {
      continue;
    }
    const s = sev as SeverityId;
    const appCells = (cells[appId] ??= {});
    const prev = appCells[cat];
    if (!prev || sevRank[s] > sevRank[prev]) {
      appCells[cat] = s;
    }

    if (!catCounts.has(cat)) {
      catCounts.set(cat, new Set());
    }
    catCounts.get(cat)!.add(appId);
  }

  // Category order: canonical CATEGORY_META order first (so the heatmap
  // y-axis matches the rest of the UI), unknowns appended alphabetically.
  const canonical = Object.keys(CATEGORY_META);
  const seen = new Set<string>(canonical);
  const extras = [...catCounts.keys()].filter((c) => !seen.has(c)).sort();
  const categoryOrder = [...canonical, ...extras].filter((c) =>
    catCounts.has(c)
  );

  const categories: MatrixCategory[] = categoryOrder.map((identifier) => ({
    identifier,
    label: CATEGORY_META[identifier]?.label ?? identifier,
    appCount: catCounts.get(identifier)?.size ?? 0,
  }));

  const severities = SEVERITY_ORDER.map((identifier) => ({
    identifier,
    label: SEVERITY_CONFIG[identifier]?.label ?? identifier,
  }));

  return { apps, categories, severities, cells };
}

// ──────────────────────────────────────────────────────────────────────
// Timeline — change counts bucketed by time, stacked by change type
//   Drives: stacked-area chart. Reads privacy_snapshots.changes_summary.
//   Types: TimelineBucket / TimelinePoint / TimelineData live in
//   ./stats-views-shared.ts (imported above).
// ──────────────────────────────────────────────────────────────────────

function bucketKey(ts: number, kind: TimelineBucket): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  if (kind === "month") {
    return `${yyyy}-${mm}-01`;
  }
  if (kind === "week") {
    // ISO week: shift to Monday 00:00 UTC
    const dow = d.getUTCDay(); // 0=Sun
    const diff = (dow + 6) % 7;
    const monday = new Date(
      Date.UTC(yyyy, d.getUTCMonth(), d.getUTCDate() - diff)
    );
    return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}-${String(monday.getUTCDate()).padStart(2, "0")}`;
  }
  return `${yyyy}-${mm}-${dd}`;
}

function chooseBucket(from: number, to: number): TimelineBucket {
  const days = Math.max(1, (to - from) / 86_400_000);
  if (days <= 14) {
    return "day";
  }
  if (days <= 120) {
    return "week";
  }
  return "month";
}

/**
 * Build stacked-area timeline data across the privacy_snapshots table.
 *
 * `appId` is optional — when provided, the aggregate is scoped to a single
 * app so the same endpoint can drive both the site-wide Change Timeline on
 * the stats page and the per-app one embedded in the app detail's
 * Change History strip. When omitted, the query unions across every app,
 * matching the original stats-page behaviour.
 */
export function getTimelineData(
  from: number,
  to: number,
  bucketType?: TimelineBucket,
  appId?: string
): TimelineData {
  const kind: TimelineBucket = bucketType ?? chooseBucket(from, to);

  // Parameters are appended conditionally so the prepared SQL stays static
  // enough for better-sqlite3 to cache. `app_id` is a TEXT column holding
  // the Apple track id string, so we bind it as-is.
  const params: (string | number)[] = [from, to];
  let appFilter = "";
  if (appId) {
    appFilter = "AND app_id = ?";
    params.push(appId);
  }

  const rows = db
    .prepare(`
    SELECT scraped_at AS ts, changes_summary AS changes
    FROM privacy_snapshots
    WHERE changes_detected = 1
      AND scraped_at >= ?
      AND scraped_at <= ?
      ${appFilter}
  `)
    .all(...params) as { ts: number; changes: string | null }[];

  // Contextual counters — every sync that landed (regardless of whether it
  // detected changes) and every review action (reviewed / dismissed /
  // snoozed / unsnoozed). Same time window + appId filter as above so the
  // three series line up on the same x-axis. Kept as separate SELECTs to
  // avoid touching the existing change-type aggregation below.
  const syncRows = db
    .prepare(`
    SELECT scraped_at AS ts
    FROM privacy_snapshots
    WHERE scraped_at >= ?
      AND scraped_at <= ?
      ${appFilter}
  `)
    .all(...params) as { ts: number }[];

  const reviewFilter = appId ? "AND app_id = ?" : "";
  const reviewRows = db
    .prepare(`
    SELECT acted_at AS ts
    FROM change_review_actions
    WHERE acted_at >= ?
      AND acted_at <= ?
      ${reviewFilter}
  `)
    .all(...params) as { ts: number }[];

  const buckets = new Map<string, TimelinePoint>();
  let total = 0;

  const touch = (key: string): TimelinePoint => {
    let point = buckets.get(key);
    if (!point) {
      point = {
        bucket: key,
        added: 0,
        removed: 0,
        modified: 0,
        policy: 0,
        accessibilityAdded: 0,
        accessibilityRemoved: 0,
        syncs: 0,
        reviews: 0,
      };
      buckets.set(key, point);
    }
    return point;
  };

  for (const row of rows) {
    let entries: { type?: string; category?: string }[] = [];
    try {
      entries = row.changes ? JSON.parse(row.changes) : [];
    } catch {
      continue;
    }
    const point = touch(bucketKey(row.ts, kind));
    for (const e of entries) {
      // Route added/removed by category so the chart can draw
      // accessibility as its own blue band. Legacy rows (no category) are
      // treated as privacy-label for back-compat — that matches their
      // historical rendering in the detail-page changelog.
      if (e.category === "accessibility") {
        if (e.type === "added") {
          point.accessibilityAdded = (point.accessibilityAdded ?? 0) + 1;
        } else if (e.type === "removed") {
          point.accessibilityRemoved = (point.accessibilityRemoved ?? 0) + 1;
        } else {
          continue;
        }
      } else if (e.type === "added") {
        point.added++;
      } else if (e.type === "removed") {
        point.removed++;
      } else if (e.type === "modified") {
        point.modified++;
      } else if (e.type === "policy") {
        point.policy++;
      } else {
        continue;
      }
      total++;
    }
  }

  for (const row of syncRows) {
    const point = touch(bucketKey(row.ts, kind));
    point.syncs = (point.syncs ?? 0) + 1;
  }
  for (const row of reviewRows) {
    const point = touch(bucketKey(row.ts, kind));
    point.reviews = (point.reviews ?? 0) + 1;
  }

  const emptyPoint = (key: string): TimelinePoint => ({
    bucket: key,
    added: 0,
    removed: 0,
    modified: 0,
    policy: 0,
    accessibilityAdded: 0,
    accessibilityRemoved: 0,
    syncs: 0,
    reviews: 0,
  });

  // Fill empty buckets so the area chart has a continuous baseline rather
  // than jumping across gaps.
  //
  // NB: the loop's starting timestamp has to line up with the bucket
  // type, otherwise the last bucket can silently drop off the chart.
  // Example of the bug this avoids: `from` is a Thursday (e.g. Jan 1)
  // and we step by 7 days. bucketKey always maps a Thursday to its
  // ISO-week Monday, so the iteration effectively walks Thursdays and
  // the loop ends at the last Thursday <= `to`. When `to` is a
  // Wednesday, the *current* week's Thursday is still in the future,
  // so that week's Monday bucket never gets pushed — which makes
  // events recorded "today" invisible on the chart even though the
  // server-side Map has them.
  const points: TimelinePoint[] = [];
  if (kind === "day") {
    const fromDate = new Date(from);
    let t = Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate()
    );
    while (t <= to) {
      const key = bucketKey(t, kind);
      points.push(buckets.get(key) ?? emptyPoint(key));
      t += 86_400_000;
    }
  } else if (kind === "week") {
    // Align start to the Monday of `from`'s ISO week so successive +7d
    // steps always land on Mondays — the same key bucketKey returns.
    const fromDate = new Date(from);
    const midnight = Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate()
    );
    const dow = new Date(midnight).getUTCDay(); // 0 = Sun, 1 = Mon, …
    const diff = (dow + 6) % 7; // days since Monday
    let t = midnight - diff * 86_400_000;
    while (t <= to) {
      const key = bucketKey(t, kind);
      points.push(buckets.get(key) ?? emptyPoint(key));
      t += 7 * 86_400_000;
    }
  } else {
    // monthly: walk month-by-month so February etc. are the right length
    const start = new Date(from);
    const end = new Date(to);
    const cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)
    );
    while (cursor.getTime() <= end.getTime()) {
      const key = bucketKey(cursor.getTime(), "month");
      points.push(buckets.get(key) ?? emptyPoint(key));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  return { from, to, bucketType: kind, points, total };
}

// ──────────────────────────────────────────────────────────────────────
// Radar — policy-fingerprint per app
//   Drives: radar chart. Reads privacy_policy_analyses.summary_json and maps
//   each of the 8 lenses to a numeric score so they can share a radar axis.
//   Types + RADAR_MAX live in ./stats-views-shared.ts; the client imports
//   them there so it never pulls in the DB-backed module.
// ──────────────────────────────────────────────────────────────────────

/** Higher = more concerning. `unclear` goes mid-low so it doesn't overpower shapes. */
const RATING_SCORE: Record<PolicyRating, number> = {
  favorable: 1,
  unclear: 1.5,
  mixed: 3,
  concerning: 4,
};

// Re-export RADAR_MAX from the shared module for callers that previously
// pulled it from this file.
export { RADAR_MAX } from "./stats-views-shared";

/**
 * Build radar data for the given app IDs. Pass an empty array to get the
 * top-N apps with populated policy summaries, which is what the Stats page
 * uses by default.
 */
export function getRadarData(appIds?: string[]): RadarData {
  const placeholders = appIds?.length ? appIds.map(() => "?").join(",") : null;
  const rows = placeholders
    ? (db
        .prepare(`
        SELECT a.id, a.name, a.iconUrl, p.summary_json, p.status
        FROM apps a
        LEFT JOIN privacy_policy_analyses p ON p.app_id = a.id
        WHERE a.id IN (${placeholders})
      `)
        .all(...appIds!) as {
        id: string;
        name: string;
        iconUrl: string;
        summary_json: string | null;
        status: string | null;
      }[])
    : (db
        .prepare(`
        SELECT a.id, a.name, a.iconUrl, p.summary_json, p.status
        FROM apps a
        LEFT JOIN privacy_policy_analyses p ON p.app_id = a.id
        WHERE p.summary_json IS NOT NULL
        ORDER BY a.lastSynced DESC
        LIMIT 6
      `)
        .all() as {
        id: string;
        name: string;
        iconUrl: string;
        summary_json: string | null;
        status: string | null;
      }[]);

  const apps: RadarApp[] = rows.map((r) => {
    let summary: PolicySummary | null = null;
    if (r.summary_json) {
      try {
        summary = JSON.parse(r.summary_json) as PolicySummary;
      } catch {
        /* ignore malformed */
      }
    }
    const byKey = new Map<
      PolicyLensKey,
      { rating: PolicyRating; summary: string }
    >();
    for (const lens of summary?.lenses ?? []) {
      byKey.set(lens.key, lens);
    }

    const lenses: RadarLens[] = POLICY_LENSES.map((l) => {
      const hit = byKey.get(l.key);
      return {
        key: l.key,
        label: l.label,
        rating: hit?.rating ?? null,
        score: hit?.rating ? RATING_SCORE[hit.rating] : null,
      };
    });

    return {
      id: r.id,
      name: r.name,
      iconUrl: r.iconUrl,
      lenses,
      hasPolicy: !!summary,
      status: r.status ?? undefined,
    };
  });

  return {
    axes: POLICY_LENSES.map((l) => ({ key: l.key, label: l.label })),
    ratings: POLICY_RATINGS,
    apps,
  };
}

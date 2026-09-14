import {
  CANONICAL_ACCESSIBILITY_FEATURES,
  getAccessibilityCoverageByFeature,
} from "./accessibility";
import db from "./db";
import type { DeviceScope } from "./device-scope";
import { scopeAppIdClause, scopeSqlClause } from "./device-scope-server";
import {
  getMismatchCountsByApp,
  getPrivacyProfile,
} from "./privacy-profile-server";

export interface StatsData {
  accessibilityFeatureFrequency: {
    identifier: string;
    title: string;
    appCount: number;
  }[];
  appsEvaluatedForAccessibility: number;
  /**
   * Count of tracked apps that violate at least one preference in the user's
   * saved privacy profile. `0` when no apps mismatch OR when no profile is
   * configured — the `profileActive` flag is what callers should test to
   * decide whether to render a card for this number.
   */
  appsNotMatchingProfile: number;
  /**
   * Accessibility nutrition-label roll-up. `appsWithAccessibilityLabels` is
   * the count of tracked apps Apple has published an accessibility shelf for
   * with ≥1 feature; `appsEvaluatedForAccessibility` is the denominator —
   * apps where `hasAccessibilityLabels IS NOT NULL`, i.e. scraped successfully.
   * Apps whose scrape failed or predate the accessibility scraper don't count
   * either way. `accessibilityFeatureFrequency` is a bar-chart friendly list
   * that guarantees every canonical feature appears (count 0 when no tracked
   * app claims it) so the chart isn't misleading.
   */
  appsWithAccessibilityLabels: number;
  appsWithChanges: number;
  categoryFrequency: { identifier: string; title: string; appCount: number }[];
  /** True when a privacy profile is set with at least one explicit preference. */
  profileActive: boolean;
  recentChanges: any[];
  staleApps: number;
  staleAppsList: any[];
  totalApps: number;
  totalCategories: number;
  totalSyncs: number;
  totalUniqueCategories: number;
}

/**
 * `scope` narrows every figure on the Stats page to the apps on the
 * given device(s).
 *
 * Every query here is scoped, not just the headline ones. A stats page
 * that mixed a scoped "total apps" with an unscoped "category
 * frequency" would be actively misleading — the whole point of the page
 * is that the numbers relate to each other.
 *
 * Two shapes are needed because the queries start from different
 * tables: `scopeSqlClause` for anything selecting from `apps`, and the
 * correlated `scopeAppIdClause` for counts over `privacy_categories`,
 * `privacy_snapshots` and `notifications`.
 */
export function getStats(scope?: DeviceScope): StatsData {
  const STALE_THRESHOLD = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const q = <T>(sql: string, ...params: any[]): T =>
    db.prepare(sql).get(...params) as T;
  const qa = <T>(sql: string, ...params: any[]): T[] =>
    db.prepare(sql).all(...params) as T[];

  const onApps = scope ? scopeSqlClause(scope, "apps") : null;
  const byId = (expr: string) => (scope ? scopeAppIdClause(scope, expr) : null);
  /** ` AND <scope>` / ` WHERE <scope>` fragment, or "" when unrestricted. */
  const and = (f: { clause: string } | null) => (f ? ` AND ${f.clause}` : "");
  const where = (f: { clause: string } | null) =>
    f ? ` WHERE ${f.clause}` : "";
  const p = (f: { params: string[] } | null) => f?.params ?? [];

  const catScope = byId("pt2.app_id");
  const snapScope = byId("ps.app_id");
  const notifScope = byId("n.app_id");

  const totalApps =
    q<any>(`SELECT COUNT(*) as c FROM apps${where(onApps)}`, ...p(onApps))?.c ??
    0;
  // Categories hang off privacy_types, so the scope has to reach the app
  // through the type row — hence the pt2 join rather than a direct filter.
  const totalCategories =
    q<any>(
      `SELECT COUNT(*) as c FROM privacy_categories pc
         JOIN privacy_types pt2 ON pt2.id = pc.type_id
        WHERE pc.type_id IS NOT NULL${and(catScope)}`,
      ...p(catScope)
    )?.c ?? 0;
  const totalUniqueCategories =
    q<any>(
      `SELECT COUNT(DISTINCT pc.identifier) as c FROM privacy_categories pc
         JOIN privacy_types pt2 ON pt2.id = pc.type_id
        WHERE pc.type_id IS NOT NULL${and(catScope)}`,
      ...p(catScope)
    )?.c ?? 0;
  const appsWithChanges =
    q<any>(
      `SELECT COUNT(*) as c FROM apps WHERE changeCount > 0${and(onApps)}`,
      ...p(onApps)
    )?.c ?? 0;
  const staleApps =
    q<any>(
      `SELECT COUNT(*) as c FROM apps WHERE lastSynced < ?${and(onApps)}`,
      STALE_THRESHOLD,
      ...p(onApps)
    )?.c ?? 0;
  const totalSyncs =
    q<any>(
      `SELECT COUNT(*) as c FROM privacy_snapshots ps${where(snapScope)}`,
      ...p(snapScope)
    )?.c ?? 0;

  const categoryFrequency = qa<{
    identifier: string;
    title: string;
    appCount: number;
  }>(
    `
    SELECT pc.identifier, pc.title, COUNT(DISTINCT pt.app_id) AS appCount
    FROM privacy_categories pc
    JOIN privacy_types pt ON pt.id = pc.type_id
    WHERE pc.type_id IS NOT NULL${and(byId("pt.app_id"))}
    GROUP BY pc.identifier, pc.title
    ORDER BY appCount DESC
    LIMIT 15
  `,
    ...p(byId("pt.app_id"))
  );

  // Pull a deeper slice than the compact view needs. The Stats page Recent
  // Changes panel is now scrollable with an optional "Privacy label
  // changes only" filter, both of which benefit from having more than the
  // old 8 rows to work with. 50 is a middle ground that keeps JSON payload
  // small without starving the scroll view on busy libraries.
  const recentChanges = qa<any>(
    `
    SELECT n.id, n.app_id, n.app_name, n.change_summary, n.created_at, n.read, a.iconUrl
    FROM notifications n
    LEFT JOIN apps a ON a.id = n.app_id
    ${where(notifScope)}
    ORDER BY n.created_at DESC
    LIMIT 50
  `,
    ...p(notifScope)
  ).map((n) => ({ ...n, change_summary: JSON.parse(n.change_summary) }));

  const staleAppsList = qa<any>(
    `
    SELECT id, name, iconUrl, developer, url, lastSynced
    FROM apps
    WHERE lastSynced < ?${and(onApps)}
    ORDER BY lastSynced ASC
    LIMIT 10
  `,
    STALE_THRESHOLD,
    ...p(onApps)
  );

  // Privacy-profile match. `getMismatchCountsByApp` returns a Map keyed by
  // appId, only containing apps with ≥1 mismatch — so .size is the count
  // of off-profile apps directly. When no profile is set the map is empty
  // and profileActive is false, which suppresses the card downstream.
  const savedProfile = getPrivacyProfile();
  const profileActive =
    !!savedProfile &&
    Object.values(savedProfile).some((v) => typeof v === "string");
  const appsNotMatchingProfile = profileActive
    ? getMismatchCountsByApp(scope).size
    : 0;

  // Accessibility roll-up. The denominator is "apps we could actually evaluate"
  // — i.e. apps whose last scrape produced a verdict on the accessibility
  // shelf — so apps that predate the scraper (NULL column) don't drag the
  // headline figure down. Guaranteeing every canonical feature appears in the
  // bar chart (even with count 0) keeps the visual honest when no tracked app
  // claims a given feature.
  const appsWithAccessibilityLabels =
    q<any>(
      `SELECT COUNT(*) as c FROM apps WHERE hasAccessibilityLabels = 1${and(onApps)}`,
      ...p(onApps)
    )?.c ?? 0;
  const appsEvaluatedForAccessibility =
    q<any>(
      `SELECT COUNT(*) as c FROM apps WHERE hasAccessibilityLabels IS NOT NULL${and(onApps)}`,
      ...p(onApps)
    )?.c ?? 0;

  const coverageRows = getAccessibilityCoverageByFeature(scope);
  const coverageByIdentifier = new Map(
    coverageRows.map((r) => [r.identifier, r] as const)
  );
  // Merge canonical baseline with any Apple-introduced features we've captured.
  const accessibilityFeatureFrequency: StatsData["accessibilityFeatureFrequency"] =
    [];
  for (const canonical of CANONICAL_ACCESSIBILITY_FEATURES) {
    const hit = coverageByIdentifier.get(canonical.identifier);
    accessibilityFeatureFrequency.push({
      identifier: canonical.identifier,
      title: canonical.title,
      appCount: hit?.appCount ?? 0,
    });
    if (hit) {
      coverageByIdentifier.delete(canonical.identifier);
    }
  }
  // Any remaining rows are novel features Apple has introduced since the
  // canonical list was last updated — append them so the chart reflects
  // reality instead of hiding new data.
  for (const extra of coverageByIdentifier.values()) {
    accessibilityFeatureFrequency.push({
      identifier: extra.identifier,
      title: extra.title,
      appCount: extra.appCount,
    });
  }

  return {
    totalApps,
    totalCategories,
    totalUniqueCategories,
    appsWithChanges,
    staleApps,
    totalSyncs,
    appsNotMatchingProfile,
    profileActive,
    categoryFrequency,
    recentChanges,
    staleAppsList,
    appsWithAccessibilityLabels,
    appsEvaluatedForAccessibility,
    accessibilityFeatureFrequency,
  };
}

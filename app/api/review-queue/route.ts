export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { type Annotation, listAnnotations } from "@/lib/annotations";
import { getDeviceEcidsForApps } from "@/lib/devices";
import type { AppProfileBadge } from "@/lib/privacy-profile";
import { getProfileBadgesByApp } from "@/lib/privacy-profile-server";
import { getAllApps } from "@/lib/scraper";
import { checkRateLimit, rateLimitKeyForRequest } from "@/lib/security";
import { listShortlistGroups } from "@/lib/shortlist";
import type { ShortlistEntry } from "@/lib/shortlist-types";
import {
  getImportedVerdictsByAppId,
  getUserVerdictsByAppId,
} from "@/lib/verdicts";

/**
 * GET /api/review-queue — the apps that need a decision: anything with a
 * user verdict OR an imported recommendation, with everything the review
 * wizard renders per row.
 *
 * Added for Rust-core Phase 0. `/dashboard/review-recommendations` built
 * this in its server component from six reads plus a per-row
 * `listAnnotations()`. The assembly is lifted here verbatim so the row
 * shape stays byte-identical to what ReviewRecommendationsView already
 * consumes.
 *
 * `?count=1` skips row assembly and returns only `reviewableCount`, for
 * callers that just need the badge number.
 *
 * TWO COUNTS, deliberately: `reviewableCount` is the raw union of apps
 * carrying a user verdict or an imported one — including verdicts for
 * apps no longer in the library, which is what the dashboard's CTA
 * counts. `rowCount` is `rows.length`, i.e. after the inner join against
 * getAllApps(). They are NOT interchangeable; the dashboard reads the
 * first, this page renders the second.
 *
 * Every read degrades independently (empty list / empty map), matching
 * the page's per-read try/catch rather than failing the whole response.
 */

interface ReviewRow {
  bundleId: string | null;
  developer: string | null;
  iconUrl: string | null;
  id: string;
  importedVerdicts: unknown[];
  name: string;
  notes: Annotation[];
  profileBadge: AppProfileBadge | null;
  shortlistCandidates: ShortlistEntry[];
  url: string | null;
  userVerdict: unknown;
}

export async function GET(request: Request) {
  // Unauthenticated read, rate limited — same posture as /api/shortlist:
  // this is the most expensive read here (per-row annotations), so a
  // same-origin loop shouldn't be able to hammer SQLite with it.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "review-queue.list"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const countOnly = new URL(request.url).searchParams.get("count") === "1";

  const safe = <T>(fn: () => T, fallback: T, label: string): T => {
    try {
      return fn();
    } catch (error) {
      console.warn(`[review-queue] ${label} failed:`, error);
      return fallback;
    }
  };

  const userVerdicts = safe(
    () => getUserVerdictsByAppId(),
    new Map(),
    "getUserVerdictsByAppId"
  );
  const importedVerdicts = safe(
    () => getImportedVerdictsByAppId(),
    new Map(),
    "getImportedVerdictsByAppId"
  );

  // Raw union — the dashboard's semantics. Counts verdicts for apps that
  // are no longer tracked; the row list below drops those.
  const reviewableCount = new Set([
    ...userVerdicts.keys(),
    ...importedVerdicts.keys(),
  ]).size;

  if (countOnly) {
    return NextResponse.json({ reviewableCount });
  }

  const apps = safe(() => getAllApps() as any[], [], "getAllApps");
  const profileBadges = safe(
    () => getProfileBadgesByApp(),
    {} as Record<string, AppProfileBadge>,
    "getProfileBadgesByApp"
  );

  // Keyed by sourceApp.id — the id lives on the nested sourceApp, not on
  // the group. Typed (no cast) so a ShortlistGroup shape change fails tsc
  // here instead of silently emptying every row's candidates.
  const shortlistsByApp: Record<string, ShortlistEntry[]> = {};
  for (const group of safe(() => listShortlistGroups(), [], "shortlist")) {
    shortlistsByApp[group.sourceApp.id] = group.entries;
  }

  const rows: ReviewRow[] = [];
  for (const app of apps) {
    const own = userVerdicts.get(app.id) ?? null;
    const imported = importedVerdicts.get(app.id) ?? [];
    if (!own && imported.length === 0) {
      continue;
    }
    rows.push({
      id: app.id,
      name: app.name,
      developer: app.developer ?? null,
      iconUrl: app.iconUrl ?? null,
      bundleId: app.bundleId ?? null,
      url: app.url ?? null,
      profileBadge: profileBadges[app.id] ?? null,
      shortlistCandidates: shortlistsByApp[app.id] ?? [],
      notes: safe(
        () => listAnnotations(app.id),
        [],
        `listAnnotations ${app.id}`
      ),
      userVerdict: own,
      importedVerdicts: imported,
    });
  }

  // Source-device ECIDs for uninstall-queued rows: the wizard warns when
  // the connected device isn't where the app came from. An empty map
  // means "can't verify" and fires no warning — same as the page's catch.
  const sourceDeviceEcids: Record<string, string[]> = {};
  const uninstallRowIds = rows
    .filter((r) => (r.userVerdict as any)?.verdict === "uninstall")
    .map((r) => r.id);
  for (const [appId, ecids] of safe(
    () => getDeviceEcidsForApps(uninstallRowIds),
    new Map<string, string[]>(),
    "getDeviceEcidsForApps"
  )) {
    sourceDeviceEcids[appId] = ecids;
  }

  return NextResponse.json({
    rows,
    sourceDeviceEcids,
    rowCount: rows.length,
    reviewableCount,
    total: apps.length,
  });
}

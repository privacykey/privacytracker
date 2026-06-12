/**
 * Per-app side-band data for the apps grid, scoped to one page of apps.
 *
 * The grid renders four id-keyed maps next to each card: privacy-profile
 * badges, the user's own verdicts, the pending-change breakdown (which
 * colour the pulsing dot is), and device links. Historically the page
 * computed all four for the whole fleet on every render — fine at 200 apps,
 * a multi-megabyte RSC payload at 5,000+. With the grid paginated, both the
 * server page (first page) and `/api/apps?limit=…&meta=grid` (background
 * pages) assemble the maps for just the apps they're about to send, via
 * this helper.
 *
 * Each map is built defensively: a failure in one (e.g. profile table
 * missing mid-migration) logs a warning and falls back to an empty map
 * instead of taking the other three down — mirroring the per-helper
 * try/catch the page used before this module existed.
 */

import { getAppDeviceMap } from "./devices";
import type { AppProfileBadge } from "./privacy-profile";
import { getProfileBadgesByApp } from "./privacy-profile-server";
import { getPendingChangeCategoriesByApp } from "./scraper";
import type { VerdictValue } from "./verdict-types";
import { getUserVerdictsByAppId } from "./verdicts";

export interface AppGridMeta {
  appDeviceMap: Record<string, string[]>;
  pendingChangeCategoriesByApp: Record<
    string,
    { privacy: boolean; accessibility: boolean; policy: boolean }
  >;
  profileBadges: Record<string, AppProfileBadge>;
  userVerdicts: Record<string, VerdictValue>;
}

export function buildAppGridMeta(appIds: readonly string[]): AppGridMeta {
  let profileBadges: AppGridMeta["profileBadges"] = {};
  try {
    profileBadges = getProfileBadgesByApp(appIds);
  } catch (error) {
    console.warn("[app-grid-meta] getProfileBadgesByApp failed:", error);
  }

  let pendingChangeCategoriesByApp: AppGridMeta["pendingChangeCategoriesByApp"] =
    {};
  try {
    pendingChangeCategoriesByApp = getPendingChangeCategoriesByApp(appIds);
  } catch (error) {
    console.warn(
      "[app-grid-meta] getPendingChangeCategoriesByApp failed:",
      error
    );
  }

  const userVerdicts: AppGridMeta["userVerdicts"] = {};
  try {
    for (const [id, v] of getUserVerdictsByAppId(appIds)) {
      userVerdicts[id] = v.verdict;
    }
  } catch (error) {
    console.warn("[app-grid-meta] getUserVerdictsByAppId failed:", error);
  }

  const appDeviceMap: AppGridMeta["appDeviceMap"] = {};
  try {
    for (const [appId, ids] of getAppDeviceMap(appIds)) {
      appDeviceMap[appId] = ids;
    }
  } catch (error) {
    console.warn("[app-grid-meta] getAppDeviceMap failed:", error);
  }

  return {
    appDeviceMap,
    pendingChangeCategoriesByApp,
    profileBadges,
    userVerdicts,
  };
}

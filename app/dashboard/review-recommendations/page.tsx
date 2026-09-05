import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { Annotation } from "../../../lib/annotations";
import { listAnnotations } from "../../../lib/annotations";
import { getDeviceEcidsForApps } from "../../../lib/devices";
import { getActiveFocus } from "../../../lib/feature-flag-storage";
import { resolveFlagFromDb } from "../../../lib/feature-flags-server";
import type { AppProfileBadge } from "../../../lib/privacy-profile";
import { getProfileBadgesByApp } from "../../../lib/privacy-profile-server";
import { getAllApps } from "../../../lib/scraper";
import { listShortlistGroups } from "../../../lib/shortlist";
import type { ShortlistEntry } from "../../../lib/shortlist-types";
import {
  getImportedVerdictsByAppId,
  getUserVerdictsByAppId,
} from "../../../lib/verdicts";
import Nav from "../../components/Nav";
import ReviewRecommendationsView from "../../components/ReviewRecommendationsView";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("review_title"),
  };
}

/**
 * /dashboard/review-recommendations — universal Review / Compare / Save
 * wizard, with an optional desktop-only Backup / Act extension.
 *
 * The extension requires audience=self, the cfgutil feature flag, and the
 * Tauri desktop runtime. It records a backup only after both native discovery
 * and server-side Manifest.db verification; Act then re-checks that durable
 * stamp immediately before the first removal.
 *
 * Web users and people outside the extension gates still get the complete
 * non-destructive recommendation flow without disabled desktop controls.
 */
export default function ReviewRecommendationsPage() {
  const focus = getActiveFocus();
  const flagOn = resolveFlagFromDb("flag.devopts.cfgutil_uninstall") === "on";

  // Pull data unconditionally — the view shows the same apps regardless
  // of gate state, just hides destructive controls when gates fail.
  let apps: ReturnType<typeof getAllApps> = [];
  try {
    apps = getAllApps();
  } catch (e) {
    console.warn("[review] getAllApps failed:", e);
  }

  // No apps tracked → punt to onboarding (the empty-state wizard isn't
  // useful for a first-run flow).
  if (apps.length === 0) {
    redirect("/onboard");
  }

  const userVerdicts = getUserVerdictsByAppId();
  const importedVerdicts = getImportedVerdictsByAppId();

  // Profile-match badges per app — render as the secondary chip slot
  // (verdicts are already visible as the active picker chip).
  let profileBadges: Record<string, AppProfileBadge> = {};
  try {
    profileBadges = getProfileBadgesByApp();
  } catch (e) {
    console.warn("[review] getProfileBadgesByApp failed:", e);
  }

  // Shortlist entries grouped by source app, indexed for O(1) lookup at
  // row render. Surfaced inline under each "Replace" app on the Compare step.
  const shortlistsByApp: Record<string, ShortlistEntry[]> = {};
  try {
    const groups = listShortlistGroups();
    for (const g of groups) {
      shortlistsByApp[g.sourceApp.id] = g.entries;
    }
  } catch (e) {
    console.warn("[review] listShortlistGroups failed:", e);
  }

  // Reduce to apps that need attention: anything with a user verdict OR
  // an imported recommendation.
  interface Row {
    bundleId: string | null;
    developer: string | null;
    iconUrl: string | null;
    id: string;
    importedVerdicts: ReturnType<typeof getImportedVerdictsByAppId> extends Map<
      string,
      infer V
    >
      ? V
      : never;
    name: string;
    /** User's existing notes for this app, read-only here. */
    notes: Annotation[];
    profileBadge: AppProfileBadge | null;
    /** Shortlisted candidate replacements for this app. */
    shortlistCandidates: ShortlistEntry[];
    /** Real App Store URL — used by the printable checklist's tap-to-open links. */
    url: string | null;
    userVerdict: ReturnType<typeof getUserVerdictsByAppId> extends Map<
      string,
      infer V
    >
      ? V | null
      : never;
  }
  const rows: Row[] = [];
  for (const app of apps as Array<{
    id: string;
    name: string;
    developer: string | null;
    iconUrl: string | null;
    bundleId: string | null;
    url: string | null;
  }>) {
    const own = userVerdicts.get(app.id) ?? null;
    const imported = importedVerdicts.get(app.id) ?? [];
    if (!own && imported.length === 0) {
      continue;
    }
    // listAnnotations is sync (better-sqlite3) so the per-row call is fine.
    let notes: Annotation[] = [];
    try {
      notes = listAnnotations(app.id);
    } catch (e) {
      console.warn("[review] listAnnotations failed for", app.id, e);
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
      notes,
      userVerdict: own,
      importedVerdicts: imported,
    });
  }

  // Source-device ECID map for the apps that are queued for uninstall.
  // The wizard uses this to flag "the connected cfgutil device doesn't
  // match where this app was originally imported from" — a soft warning
  // that prevents users from trying to uninstall an app off a device
  // it isn't installed on. Empty map on failure means "can't verify"
  // (no warning fires).
  const uninstallRowIds = rows
    .filter((r) => r.userVerdict?.verdict === "uninstall")
    .map((r) => r.id);
  const sourceDeviceEcids: Record<string, string[]> = {};
  try {
    const map = getDeviceEcidsForApps(uninstallRowIds);
    for (const [appId, ecids] of map) {
      sourceDeviceEcids[appId] = ecids;
    }
  } catch (e) {
    console.warn("[review] getDeviceEcidsForApps failed:", e);
  }

  // Format once on the server and pass the finished label through. Calling
  // toLocaleString during both SSR and hydration can use different locale
  // defaults and force React to rebuild the entire wizard on first load.
  const generatedAtLabel = new Date().toLocaleString();

  return (
    <>
      <Nav appCount={apps.length} />
      <ReviewRecommendationsView
        audience={focus.audience}
        flagOn={flagOn}
        generatedAtLabel={generatedAtLabel}
        rows={rows}
        sourceDeviceEcids={sourceDeviceEcids}
      />
    </>
  );
}

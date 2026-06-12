import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { type AgeBandKey, isValidAgeBand } from "@/lib/age-rating";
import {
  getResolverContextFromDb,
  resolveFlagFromDb,
} from "@/lib/feature-flags-server";
import { buildAppGridMeta } from "../../../lib/app-grid-meta";
import { getAllDevices } from "../../../lib/devices";
import {
  MANUAL_APP_SOURCE_META,
  MANUAL_APP_SOURCES,
} from "../../../lib/manual-apps";
import { listManualApps } from "../../../lib/manual-apps-server";
import { getPrivacyProfile } from "../../../lib/privacy-profile-server";
import { getSetting } from "../../../lib/scheduler";
import { countApps, getAppsPage } from "../../../lib/scraper";
import AppGrid, { type AppGridFlagState } from "../../components/AppGrid";
import Nav from "../../components/Nav";

export const dynamic = "force-dynamic";

/**
 * How many apps the server renders into the initial RSC payload. The rest
 * stream in client-side via `/api/apps?limit=…&offset=…&meta=grid` (see
 * AppGrid's background hydration). 250 keeps typical fleets (1–4 devices'
 * worth) on the exact pre-pagination behaviour — one page, no follow-up
 * fetches — while capping the payload that made /dashboard/apps the app's
 * only real scaling bottleneck (21.8 MB RSC at 5,000 apps).
 */
const GRID_INITIAL_PAGE_SIZE = 250;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("apps_title"),
  };
}

export default function AppsPage() {
  let apps: any[] = [];
  let totalApps = 0;
  try {
    totalApps = countApps();
    apps = getAppsPage({ limit: GRID_INITIAL_PAGE_SIZE, offset: 0 }) as any[];
  } catch (error) {
    // DB not ready
    console.warn("[apps] getAppsPage failed:", error);
  }

  // Surface user-authored "custom" apps (web clips, TestFlight, sideloaded,
  // personal builds) in the same grid. They have no App Store listing so they
  // render with a 'Custom' pill instead of a risk pill, and skip sync. Client
  // components import the metadata map from lib/manual-apps (client-safe) but
  // the list itself comes from the server module here.
  let manualApps: ReturnType<typeof listManualApps> = [];
  try {
    manualApps = listManualApps();
  } catch (error) {
    console.warn("[apps] listManualApps failed:", error);
  }

  // Only redirect to onboarding when we truly have nothing to show. A user
  // with only custom apps should still land on the grid so they can manage
  // them. `totalApps` (not the first page's length) is the real signal.
  if (totalApps === 0 && manualApps.length === 0) {
    redirect("/onboard");
  }

  const manualSources = MANUAL_APP_SOURCES.map((value) => ({
    ...MANUAL_APP_SOURCE_META[value],
  }));

  // Per-app side-band maps (profile badges, verdicts, pending-change
  // breakdown, device links), scoped to the first page's ids so the RSC
  // payload stays proportional to the page, not the fleet. AppGrid merges
  // the equivalent maps for later pages from the `meta=grid` API responses.
  // Empty maps are safe fallbacks: AppGrid treats "missing key" as "hide
  // badge" / "undecided" / "no pending dot" / "unattached".
  const gridMeta = buildAppGridMeta(apps.map((a) => String(a.id)));
  const profileBadges = gridMeta.profileBadges;

  // Server-hydrated accessibility toggle. Passed down so AppGrid suppresses
  // the filter row (and ignores `?access=`) when the user has disabled the
  // feature in Settings, keeping behaviour consistent with the detail page.
  let showAccessibilityFilter = true;
  try {
    showAccessibilityFilter =
      getSetting("track_accessibility_labels", "true") !== "false";
  } catch (error) {
    console.warn("[apps] reading track_accessibility_labels failed:", error);
  }

  // Per-app user verdicts (`appId → value`) and the pending-change
  // breakdown both come from the scoped gridMeta above. The "N apps need
  // a decision" CTA lives on the dashboard home (/dashboard).
  const userVerdicts = gridMeta.userVerdicts;
  const pendingChangeCategoriesByApp = gridMeta.pendingChangeCategoriesByApp;

  // Round 3 wave E: resolve all flag.appgrid.* flags server-side. Wrapped
  // in a try/catch so a resolver failure doesn't blow up the grid — falls
  // back to undefined which AppGrid treats as "all visible".
  const appgridFlags: AppGridFlagState | undefined = (() => {
    try {
      const r = (k: Parameters<typeof resolveFlagFromDb>[0]) =>
        resolveFlagFromDb(k) === "on";
      return {
        filterSearch: r("flag.appgrid.filter.search"),
        filterSortTabs: r("flag.appgrid.filter.sort_tabs"),
        filterRiskButtons: r("flag.appgrid.filter.risk_buttons"),
        filterProfileMismatch: r("flag.appgrid.filter.profile_mismatch"),
        filterAccessibility: r("flag.appgrid.filter.accessibility"),
        filterDevice: r("flag.appgrid.filter.device"),
        filterActiveBanners: r("flag.appgrid.filter.active_banners"),
        actionsSyncFiltered: r("flag.appgrid.actions.sync_filtered"),
        actionsSyncAll: r("flag.appgrid.actions.sync_all"),
        actionsCompareMode: r("flag.appgrid.actions.compare_mode"),
        actionsCustomAppsNav: r("flag.appgrid.actions.custom_apps_nav"),
        actionsAddApps: r("flag.appgrid.actions.add_apps"),
        cardChangeDot: r("flag.appgrid.card.change_dot"),
        cardProfileBadge: r("flag.appgrid.card.profile_badge"),
        cardFreshnessChip: r("flag.appgrid.card.freshness_chip"),
        cardRiskPill: r("flag.appgrid.card.risk_pill"),
        cardRiskChips: r("flag.appgrid.card.risk_chips"),
        cardResyncButton: r("flag.appgrid.card.resync_button"),
        cardDeleteButton: r("flag.appgrid.card.delete_button"),
        cardAnnotationHighlight: r("flag.appgrid.card.annotation_highlight"),
        cardVerdictPill: r("flag.appgrid.card.verdict_pill"),
        emptyState: r("flag.appgrid.empty_state"),
        guardianAgeRating: r("flag.guardian.age_rating"),
        reviewQueueEnabled: r("flag.appgrid.review_queue.enabled"),
        reviewQueueBulkSelect: r("flag.appgrid.review_queue.bulk_select"),
        reviewQueueCfgutilUninstall: r(
          "flag.appgrid.review_queue.cfgutil_uninstall"
        ),
      };
    } catch (e) {
      console.warn("[apps-page] flag resolution failed:", e);
      return;
    }
  })();

  // Audience drives the review-queue's guardian copy variant + default
  // scope. Falls back to 'self' when the focus blob is missing / DB not
  // ready — same behaviour as the rest of the focus-aware surfaces.
  let audience: "self" | "loved_one" | "guardian" = "self";
  try {
    audience = getResolverContextFromDb().focus.audience;
  } catch (e) {
    console.warn("[apps-page] reading focus audience failed:", e);
  }

  // Whether the user has set a privacy profile — gates mismatch-based
  // sort + scope options in the queue preflight. Cheap read; missing
  // profile is the empty-object case.
  let hasProfile = false;
  try {
    const profile = getPrivacyProfile();
    hasProfile = !!profile && Object.keys(profile).length > 0;
  } catch (e) {
    console.warn("[apps-page] reading privacy profile failed:", e);
  }

  // User-toggleable: show the progress bar in the running carousel
  // header. Defaults to 'true' so new installs see it; users can mute
  // via Settings if it's distracting.
  let showQueueProgressBar = true;
  try {
    showQueueProgressBar =
      getSetting("queue_show_progress_bar", "true") !== "false";
  } catch (e) {
    console.warn("[apps-page] reading queue_show_progress_bar failed:", e);
  }

  // Guardian child age band — drives the age-rating pill + filter. Null
  // (unset / invalid / read failure) hides the surface entirely.
  let childAgeBand: AgeBandKey | null = null;
  try {
    const rawBand = getSetting("guardian_child_age_band", "");
    childAgeBand = isValidAgeBand(rawBand) ? rawBand : null;
  } catch (e) {
    console.warn("[apps-page] reading guardian_child_age_band failed:", e);
  }

  // Device filter data — passed to AppGrid so the client can render a
  // dropdown and filter rows by `?device=<id>` URL param without an
  // extra fetch. The app→device links ride in via gridMeta (scoped to
  // the first page). Empty arrays on failure keep the grid working.
  let devices: ReturnType<typeof getAllDevices> = [];
  const appDeviceMap = gridMeta.appDeviceMap;
  try {
    devices = getAllDevices();
  } catch (e) {
    console.warn("[apps-page] reading devices failed:", e);
  }

  return (
    <>
      <Nav appCount={totalApps + manualApps.length} />
      {/* Device-connect toast intentionally NOT mounted here. Polling
          cfgutil from the apps grid was misleading (this view is the
          user's tracked-apps list, not a 1:1 of what's on a device)
          and expensive. The toast now lives under /onboard, gated on
          a "user has used cfgutil before" flag, driven by IOKit
          device-attach events rather than polling. */}
      <AppGrid
        appDeviceMap={appDeviceMap}
        audience={audience}
        childAgeBand={childAgeBand}
        devices={devices}
        flags={appgridFlags}
        hasProfile={hasProfile}
        initialApps={apps}
        initialManualApps={manualApps}
        initialTotal={totalApps}
        manualSources={manualSources}
        pendingChangeCategoriesByApp={pendingChangeCategoriesByApp}
        profileBadges={profileBadges}
        showAccessibilityFilter={showAccessibilityFilter}
        showQueueProgressBar={showQueueProgressBar}
        userVerdicts={userVerdicts}
      />
    </>
  );
}

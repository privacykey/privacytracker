import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAllApps, getPendingChangeCategoriesByApp } from '../../../lib/scraper';
import { listManualApps } from '../../../lib/manual-apps-server';
import { MANUAL_APP_SOURCES, MANUAL_APP_SOURCE_META } from '../../../lib/manual-apps';
import { getProfileBadgesByApp } from '../../../lib/privacy-profile-server';
import { getSetting } from '../../../lib/scheduler';
import { getUserVerdictsByAppId } from '../../../lib/verdicts';
import type { VerdictValue } from '../../../lib/verdict-types';
import AppGrid, { type AppGridFlagState } from '../../components/AppGrid';
import Nav from '../../components/Nav';
import { resolveFlagFromDb } from '@/lib/feature-flags-server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('page_metadata');
  return {
    title: t('apps_title'),
  };
}

export default function AppsPage() {
  let apps: any[] = [];
  try {
    apps = getAllApps() as any[];
  } catch (error) {
    // DB not ready
    console.warn('[apps] getAllApps failed:', error);
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
    console.warn('[apps] listManualApps failed:', error);
  }

  // Only redirect to onboarding when we truly have nothing to show. A user
  // with only custom apps should still land on the grid so they can manage
  // them.
  if (apps.length === 0 && manualApps.length === 0) {
    redirect('/onboard');
  }

  const manualSources = MANUAL_APP_SOURCES.map(value => ({ ...MANUAL_APP_SOURCE_META[value] }));

  // Compute per-app profile-match badges on the server so the grid renders
  // them in the initial HTML without a client-side fetch. An empty object
  // here is a safe fallback: AppGrid treats "missing key" as "hide badge",
  // which is what we want whenever no profile is set / DB is unavailable.
  let profileBadges: ReturnType<typeof getProfileBadgesByApp> = {};
  try {
    profileBadges = getProfileBadgesByApp();
  } catch (error) {
    console.warn('[apps] getProfileBadgesByApp failed:', error);
  }

  // Server-hydrated accessibility toggle. Passed down so AppGrid suppresses
  // the filter row (and ignores `?access=`) when the user has disabled the
  // feature in Settings, keeping behaviour consistent with the detail page.
  let showAccessibilityFilter = true;
  try {
    showAccessibilityFilter =
      getSetting('track_accessibility_labels', 'true') !== 'false';
  } catch (error) {
    console.warn('[apps] reading track_accessibility_labels failed:', error);
  }

  // Per-app user verdicts — passed to AppGrid as a plain `appId → value`
  // map so cards can render the verdict pill without a per-card fetch.
  // Only the local user's own verdict is included; imported
  // recommendations live on the App Detail page where the picker can
  // surface them inline. Empty object on read failure is safe — the
  // grid treats missing keys as "undecided" / no pill.
  const userVerdicts: Record<string, VerdictValue> = {};
  try {
    const map = getUserVerdictsByAppId();
    for (const [id, v] of map) {
      userVerdicts[id] = v.verdict;
    }
  } catch (error) {
    console.warn('[apps] getUserVerdictsByAppId failed:', error);
  }

  // The "N apps need a decision" CTA lives on the dashboard home
  // (/dashboard); the verdict helpers are kept imported in case other
  // surfaces below want them.

  // Per-app pending-change breakdown. Lets the card renderer pick between
  // an orange dot (privacy), a blue dot (accessibility), or both
  // side-by-side. Empty object is a safe default — the card just falls
  // back to the legacy single-orange dot driven by `app.changeCount`.
  let pendingChangeCategoriesByApp: ReturnType<typeof getPendingChangeCategoriesByApp> = {};
  try {
    pendingChangeCategoriesByApp = getPendingChangeCategoriesByApp();
  } catch (error) {
    console.warn('[apps] getPendingChangeCategoriesByApp failed:', error);
  }

  // Round 3 wave E: resolve all flag.appgrid.* flags server-side. Wrapped
  // in a try/catch so a resolver failure doesn't blow up the grid — falls
  // back to undefined which AppGrid treats as "all visible".
  const appgridFlags: AppGridFlagState | undefined = (() => {
    try {
      const r = (k: Parameters<typeof resolveFlagFromDb>[0]) =>
        resolveFlagFromDb(k) === 'on';
      return {
        filterSearch: r('flag.appgrid.filter.search'),
        filterSortTabs: r('flag.appgrid.filter.sort_tabs'),
        filterRiskButtons: r('flag.appgrid.filter.risk_buttons'),
        filterProfileMismatch: r('flag.appgrid.filter.profile_mismatch'),
        filterAccessibility: r('flag.appgrid.filter.accessibility'),
        filterActiveBanners: r('flag.appgrid.filter.active_banners'),
        actionsSyncFiltered: r('flag.appgrid.actions.sync_filtered'),
        actionsSyncAll: r('flag.appgrid.actions.sync_all'),
        actionsCompareMode: r('flag.appgrid.actions.compare_mode'),
        actionsCustomAppsNav: r('flag.appgrid.actions.custom_apps_nav'),
        actionsAddApps: r('flag.appgrid.actions.add_apps'),
        cardChangeDot: r('flag.appgrid.card.change_dot'),
        cardProfileBadge: r('flag.appgrid.card.profile_badge'),
        cardFreshnessChip: r('flag.appgrid.card.freshness_chip'),
        cardRiskPill: r('flag.appgrid.card.risk_pill'),
        cardRiskChips: r('flag.appgrid.card.risk_chips'),
        cardResyncButton: r('flag.appgrid.card.resync_button'),
        cardDeleteButton: r('flag.appgrid.card.delete_button'),
        cardAnnotationHighlight: r('flag.appgrid.card.annotation_highlight'),
        emptyState: r('flag.appgrid.empty_state'),
      };
    } catch (e) {
      console.warn('[apps-page] flag resolution failed:', e);
      return undefined;
    }
  })();

  return (
    <>
      <Nav appCount={apps.length + manualApps.length} />
      {/* Device-connect toast intentionally NOT mounted here. Polling
          cfgutil from the apps grid was misleading (this view is the
          user's tracked-apps list, not a 1:1 of what's on a device)
          and expensive. The toast now lives under /onboard, gated on
          a "user has used cfgutil before" flag, driven by IOKit
          device-attach events rather than polling. */}
      <AppGrid
        initialApps={apps}
        initialManualApps={manualApps}
        manualSources={manualSources}
        profileBadges={profileBadges}
        userVerdicts={userVerdicts}
        showAccessibilityFilter={showAccessibilityFilter}
        pendingChangeCategoriesByApp={pendingChangeCategoriesByApp}
        flags={appgridFlags}
      />
    </>
  );
}

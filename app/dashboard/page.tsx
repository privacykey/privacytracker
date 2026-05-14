import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTriageData } from '../../lib/triage';
import {
  getManualAppsBannerDismissed,
  getUserIntent,
} from '../../lib/preferences-server';
import { countManualApps } from '../../lib/manual-apps-server';
import { getMismatchedApps } from '../../lib/privacy-profile-server';
import { resolveFlagFromDb } from '../../lib/feature-flags-server';
import { getSetting } from '../../lib/scheduler';
import { getActiveFocus, getWelcomedAt, setWelcomedAt } from '../../lib/feature-flag-storage';
import {
  getUserVerdictsByAppId,
  getImportedVerdictsByAppId,
} from '../../lib/verdicts';
import { getTranslations } from 'next-intl/server';
import HomeView, { type DashboardFlagState } from '../components/HomeView';
import Nav from '../components/Nav';
import CoachmarkTour from '../components/CoachmarkTour';
import SampleModeView from '../components/SampleModeView';
import BundleImportProvenanceBanner from '../components/BundleImportProvenanceBanner';
import TaskList from '../components/TaskList';
import { resolveAllTasks, resolveOptInCandidates } from '../../lib/tasks-server';
import {
  consumeMigrationFlowMarker,
  getMostRecentImport,
} from '../../lib/audit-bundle-import';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Home — privacytracker',
};

interface DashboardPageProps {
  searchParams?: Promise<{ sample?: string }>;
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  // ?sample=1 — set by the welcome screen's "Try with sample data" button.
  // Skips the empty-apps redirect so the SampleModeView client component can
  // pick up the sessionStorage seed and render the demo apps inline.
  const params = (await searchParams) ?? {};
  const sampleMode = params.sample === '1';

  if (sampleMode) {
    return (
      <>
        <Nav />
        <SampleModeView />
      </>
    );
  }

  let triage: ReturnType<typeof getTriageData> | null = null;
  try {
    triage = getTriageData();
  } catch (error) {
    // DB not ready
    console.warn('[dashboard] getTriageData failed:', error);
  }

  // Round 3 wave B: lazy welcomed_at write. If the user has apps but no
  // welcomed_at marker, set it now — that means they completed the wizard
  // (somehow) without hitting /api/welcomed-at, which is the dashboard's
  // signal to stop sending them back through onboarding. Only fires on the
  // first eligible dashboard render; subsequent calls are no-ops because
  // welcomed_at is already set.
  if (triage && triage.totalApps > 0) {
    try {
      if (getWelcomedAt() === null) setWelcomedAt();
    } catch (e) {
      console.warn('[dashboard] welcomed_at lazy-set failed:', e);
    }
  }

  // Migration-flow one-shot redirect. When the user arrived from a
  // bundle that was exported via the desktop migration wizard, the
  // import handler stashed `migration_flow_pending`. Consume it here
  // and bounce straight into the Review wizard so the user picks up
  // exactly where they left off on the previous device. consume()
  // clears the marker, so a refresh of the destination page doesn't
  // re-trigger the redirect.
  //
  // Note: `redirect()` aborts via a thrown signal — we read the marker
  // *outside* a try/catch so the redirect signal isn't swallowed.
  // DB-level errors only happen inside `consume()` and that's where
  // the catch lives.
  let migrationTarget: string | null = null;
  if (triage && triage.totalApps > 0) {
    try {
      const migrate = consumeMigrationFlowMarker();
      if (migrate) migrationTarget = migrate.targetPath;
    } catch (e) {
      console.warn('[dashboard] migration consume failed:', e);
    }
  }
  if (migrationTarget) redirect(migrationTarget);

  if (!triage || triage.totalApps === 0) {
    // If the user hasn't picked an archetype yet, send them to the welcome
    // splash first so dashboard tailoring has something to key off once
    // they finish onboarding. Otherwise jump straight to the import wizard.
    const intent = (() => {
      try {
        return getUserIntent();
      } catch {
        return null;
      }
    })();
    redirect(intent ? '/onboard' : '/welcome');
  }

  const userIntent = (() => {
    try {
      return getUserIntent();
    } catch {
      return null;
    }
  })();

  // Signals for the "add manual apps" banner. Both are swallowed on error
  // so a fresh DB (or a migration mid-flight) still renders the dashboard;
  // the banner just stays hidden until the next page load.
  const manualAppsCount = (() => {
    try {
      return countManualApps();
    } catch {
      return 0;
    }
  })();
  const manualAppsBannerDismissed = (() => {
    try {
      return getManualAppsBannerDismissed();
    } catch {
      return false;
    }
  })();

  // Apps that exceed the user's privacy profile. Empty when no profile is set
  // — HomeView hides the whole section in that case. Swallow DB errors so a
  // fresh install still renders the dashboard.
  let mismatchedApps: ReturnType<typeof getMismatchedApps> = [];
  try {
    mismatchedApps = getMismatchedApps();
  } catch (error) {
    console.warn('[dashboard] getMismatchedApps failed:', error);
  }

  // Round 3 PR 3: pre-resolve dashboard flags server-side so HomeView gets
  // the right initial markup with no hydration flash. Errors fall back to
  // an undefined flag-state, which makes HomeView use the legacy intent
  // checks — safe degradation if the resolver itself misbehaves.
  const flags: DashboardFlagState | undefined = (() => {
    try {
      const resolve = (k: Parameters<typeof resolveFlagFromDb>[0]) =>
        resolveFlagFromDb(k) === 'on';
      return {
        callout: {
          declutter: resolve('flag.dashboard.callout.declutter'),
          guardian: resolve('flag.dashboard.callout.guardian'),
          understand_declutter: resolve('flag.dashboard.callout.understand_declutter'),
          understand_only: resolve('flag.dashboard.callout.understand_only'),
        },
        focusStrip: resolve('flag.dashboard.focus_strip'),
        heroQuiet: resolve('flag.dashboard.hero.quiet_state'),
        heroAttention: resolve('flag.dashboard.hero.attention_state'),
        manualAppsBanner: resolve('flag.dashboard.manual_apps_banner'),
        riskSection: resolve('flag.dashboard.risk_section'),
        glanceSection: resolve('flag.dashboard.glance_section'),
        reviewSection: resolve('flag.dashboard.review_section'),
        profileMismatchSection: resolve('flag.dashboard.profile_mismatch_section'),
        staleSection: resolve('flag.dashboard.stale_section'),
        activitySection: resolve('flag.dashboard.activity_section'),
        riskTierLegend: resolve('flag.dashboard.risk_tier_legend'),
        backgroundModeWizard: resolve('flag.dashboard.background_mode_wizard'),
        taskList: resolve('flag.dashboard.task_list'),
      };
    } catch (error) {
      console.warn('[dashboard] flag resolution failed:', error);
      return undefined;
    }
  })();

  // Server-side resolve of the audience-aware user-tasks panel. Errors
  // swallow to an empty array so a fresh DB or resolver mishap doesn't
  // take down the dashboard — the panel simply won't render. Desktop
  // tasks are filtered out here (isDesktop=false); the client provider
  // includes them back in once it knows the runtime.
  const userTasks = (() => {
    try {
      return resolveAllTasks(undefined, false);
    } catch (error) {
      console.warn('[dashboard] resolveAllTasks failed:', error);
      return [];
    }
  })();

  // Opt-in chip candidates for the "Add a task" tray. Resolved here so
  // the panel can render the chip tray on first paint (no client-fetch
  // latency before the tray appears).
  const userTaskCandidates = (() => {
    try {
      return resolveOptInCandidates(undefined, false);
    } catch (error) {
      console.warn('[dashboard] resolveOptInCandidates failed:', error);
      return [];
    }
  })();

  // Server-side visibility gate for the background-mode callout. The
  // callout renders only when the user hasn't already completed or
  // dismissed the wizard — both stored as epoch ms strings in
  // app_settings, empty = never. The component does its own runtime
  // Tauri check on top, so this is purely the "is the user new to
  // this surface?" signal.
  const backgroundCalloutVisible = (() => {
    try {
      const completed = getSetting('background_wizard_completed_at', '');
      const dismissed = getSetting('background_wizard_dismissed_at', '');
      return !completed && !dismissed;
    } catch {
      return false;
    }
  })();

  // Coachmark tour gating + focus state for goal-driven step inclusion.
  // Tour is hard-gated by `flag.onboarding.coachmark_tour`; sessionStorage
  // tracks per-session completion inside the component itself.
  const tourEnabled = (() => {
    try {
      return resolveFlagFromDb('flag.onboarding.coachmark_tour') === 'on';
    } catch {
      return false;
    }
  })();
  const tourFocus = (() => {
    try {
      return getActiveFocus();
    } catch {
      return null;
    }
  })();

  // Resolve nav-relevant flags so the Nav can hide entries the user's
  // focus has turned off (matches the page-level gates we added in Wave A).
  const navFlags = (() => {
    try {
      return {
        appCountBadge: resolveFlagFromDb('flag.nav.app_count_badge') === 'on',
        notificationBell: resolveFlagFromDb('flag.nav.notification_bell') === 'on',
        notificationBellPolling: resolveFlagFromDb('flag.notifications.bell.polling') === 'on',
        taskCenterTrigger: resolveFlagFromDb('flag.nav.task_center_trigger') === 'on',
        taskListIcon: resolveFlagFromDb('flag.nav.task_list_icon') === 'on',
        mobileDrawer: resolveFlagFromDb('flag.nav.mobile_drawer') === 'on',
        pagePrivacyMap: resolveFlagFromDb('flag.page.privacy_map') === 'on',
        pageStats: resolveFlagFromDb('flag.page.stats') === 'on',
        pageShortlist: resolveFlagFromDb('flag.page.shortlist') === 'on',
      };
    } catch {
      return undefined;
    }
  })();

  // Round 3 v1 final — provenance banner for users who recently
  // imported an audit bundle. The 24h `getMostRecentImport` window
  // matches the spec's "for 24h after a bundle import" rule; once the
  // window elapses the prop is null and the client component never
  // mounts. Per-tab dismissal lives in sessionStorage on the client.
  const recentBundleImport = (() => {
    try {
      return getMostRecentImport();
    } catch {
      return null;
    }
  })();

  // Count of distinct apps that need a decision — either the user
  // has set their own verdict OR an imported recommendation has
  // landed. Drives the "N apps need a decision" CTA banner that
  // links into /dashboard/review-recommendations.
  const reviewableCount = (() => {
    try {
      const userMap = getUserVerdictsByAppId();
      const importedMap = getImportedVerdictsByAppId();
      const ids = new Set<string>([...userMap.keys(), ...importedMap.keys()]);
      return ids.size;
    } catch (error) {
      console.warn('[dashboard] reviewableCount computation failed:', error);
      return 0;
    }
  })();

  return (
    <>
      <Nav appCount={triage.totalApps} flags={navFlags} />
      {recentBundleImport && (
        <BundleImportProvenanceBanner
          importedAt={recentBundleImport.importedAt}
          recommenderName={recentBundleImport.recommenderName ?? 'your friend'}
          appsAdded={recentBundleImport.appsAdded}
          appsUpdated={recentBundleImport.appsUpdated}
          annotationsAdded={recentBundleImport.annotationsAdded}
        />
      )}
      {/* "N apps need a decision" banner. Renders only when the user
          has at least one verdict set or an imported recommendation
          waiting — there's actually somewhere to go. Click routes
          into the review-and-act wizard, which decides whether the
          destructive Backup/Act addon steps unlock. Wrapped in a
          .review-cta-wrap so the existing AppGrid styling carries
          over without touching the layout. */}
      {reviewableCount > 0 && (
        <ReviewCtaBanner count={reviewableCount} />
      )}
      <HomeView
        triage={triage}
        userIntent={userIntent}
        manualAppsCount={manualAppsCount}
        manualAppsBannerDismissed={manualAppsBannerDismissed}
        mismatchedApps={mismatchedApps}
        flags={flags}
        backgroundCalloutVisible={backgroundCalloutVisible}
        taskListSlot={<TaskList tasks={userTasks} candidates={userTaskCandidates} />}
      />
      {tourEnabled && tourFocus && (
        <CoachmarkTour
          enabled={tourEnabled}
          audience={tourFocus.audience}
          goals={tourFocus.goals}
          aiConfigured={tourFocus.aiConfigured}
        />
      )}
    </>
  );
}

/**
 * "N apps need a decision" CTA banner. Async server component so the
 * heading + body strings come from `dashboard.review_cta.*` via
 * next-intl's server `getTranslations`. Pulled out into its own
 * helper so the parent page stays JSX-light, and the ICU plural in
 * the heading (`{count, plural, one {# app needs} other {# apps need}}`)
 * resolves cleanly without a sprinkle of conditionals at the call-site.
 */
async function ReviewCtaBanner({ count }: { count: number }) {
  const t = await getTranslations('dashboard.review_cta');
  return (
    <div className="review-cta-wrap">
      <Link
        href="/dashboard/review-recommendations"
        className="review-cta"
        aria-label={t('aria', { count })}
      >
        <span className="review-cta-icon" aria-hidden="true">📝</span>
        <span className="review-cta-body">
          <strong>{t('heading', { count })}</strong>
          <span className="review-cta-sub">{t('body')}</span>
        </span>
        <span className="review-cta-arrow" aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

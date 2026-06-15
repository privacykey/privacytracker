import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  countAppsAboveAgeBand,
  getChildAgeBand,
} from "../../lib/age-rating-server";
import {
  consumeMigrationFlowMarker,
  getMostRecentImport,
} from "../../lib/audit-bundle-import";
import {
  type DashboardLayout,
  DEFAULT_LAYOUT,
} from "../../lib/dashboard-layout";
import { getDashboardLayout } from "../../lib/dashboard-layout-server";
import {
  getActiveFocus,
  getActiveFocusWorkflow,
  getWelcomedAt,
  setWelcomedAt,
} from "../../lib/feature-flag-storage";
import { resolveFlagFromDb } from "../../lib/feature-flags-server";
import { countManualApps } from "../../lib/manual-apps-server";
import { describePurpose } from "../../lib/onboarding-purpose";
import { getManualAppsBannerDismissed } from "../../lib/preferences-server";
import { getMismatchedApps } from "../../lib/privacy-profile-server";
import { getSetting } from "../../lib/scheduler";
import {
  resolveAllTasks,
  resolveOptInCandidates,
} from "../../lib/tasks-server";
import { getTriageData } from "../../lib/triage";
import {
  getImportedVerdictsByAppId,
  getUserVerdictsByAppId,
} from "../../lib/verdicts";
import BundleImportProvenanceBanner from "../components/BundleImportProvenanceBanner";
import CoachmarkTour from "../components/CoachmarkTour";
import HomeView, {
  type DashboardFlagState,
  type FocusSummary,
} from "../components/HomeView";
import Nav from "../components/Nav";
import SampleModeView from "../components/SampleModeView";
import TaskList from "../components/TaskList";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("home_title"),
  };
}

interface DashboardPageProps {
  searchParams?: Promise<{ sample?: string; edit?: string }>;
}

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  // ?sample=1 — set by the welcome screen's "Try with sample data" button.
  // Skips the empty-apps redirect so the SampleModeView client component can
  // pick up the sessionStorage seed and render the demo apps inline.
  const params = (await searchParams) ?? {};
  const sampleMode = params.sample === "1";
  // ?edit=layout — opens the inline edit-in-place mode for the dashboard
  // layout. Only honoured when `flag.dashboard.layout_editor.visible` is
  // on (the resolver below ignores the param if the flag is off).
  const editLayoutRequested = params.edit === "layout";

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
    console.warn("[dashboard] getTriageData failed:", error);
  }

  // Round 3 wave B: lazy welcomed_at write. If the user has apps but no
  // welcomed_at marker, set it now — that means they completed the wizard
  // (somehow) without hitting /api/welcomed-at, which is the dashboard's
  // signal to stop sending them back through onboarding. Only fires on the
  // first eligible dashboard render; subsequent calls are no-ops because
  // welcomed_at is already set.
  if (triage && triage.totalApps > 0) {
    try {
      if (getWelcomedAt() === null) {
        setWelcomedAt();
      }
    } catch (e) {
      console.warn("[dashboard] welcomed_at lazy-set failed:", e);
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
      if (migrate) {
        migrationTarget = migrate.targetPath;
      }
    } catch (e) {
      console.warn("[dashboard] migration consume failed:", e);
    }
  }
  if (migrationTarget) {
    redirect(migrationTarget);
  }

  if (!triage || triage.totalApps === 0) {
    // If the user hasn't set a focus yet, send them to the welcome splash
    // first so dashboard tailoring has something to key off once they
    // finish onboarding. Otherwise jump straight to the import wizard.
    // Read the raw setting (getActiveFocus() defaults audience to 'self').
    const focusSet = (() => {
      try {
        return getSetting("flag.focus.audience", "") !== "";
      } catch {
        return false;
      }
    })();
    redirect(focusSet ? "/onboard" : "/welcome");
  }

  // Summarise the focus for HomeView's own tailoring (focus strip + stale
  // elevation). `null` when no focus is stored — getActiveFocus() defaults
  // audience to 'self', so gate on the raw setting first.
  const focusSummary: FocusSummary | null = (() => {
    try {
      if (getSetting("flag.focus.audience", "") === "") {
        return null;
      }
      const focus = getActiveFocus();
      const monitor = focus.goals.has("monitor");
      const cleanup = focus.goals.has("cleanup");
      return {
        purpose: describePurpose({
          audience: focus.audience,
          monitor,
          cleanup,
          minimal: focus.goals.has("minimal"),
          accessibility: focus.goals.has("accessibility"),
          workflow: getActiveFocusWorkflow(focus),
        }).primary,
        understandDeclutter: monitor && cleanup,
      };
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
    console.warn("[dashboard] getMismatchedApps failed:", error);
  }

  // Pre-resolve dashboard flags server-side so HomeView gets the right
  // initial markup with no hydration flash. Errors fall back to an
  // undefined flag-state, which makes HomeView's callouts default off —
  // safe degradation if the resolver itself misbehaves.
  const flags: DashboardFlagState | undefined = (() => {
    try {
      const resolve = (k: Parameters<typeof resolveFlagFromDb>[0]) =>
        resolveFlagFromDb(k) === "on";
      return {
        callout: {
          age_rating: resolve("flag.dashboard.callout.age_rating"),
          declutter: resolve("flag.dashboard.callout.declutter"),
          guardian: resolve("flag.dashboard.callout.guardian"),
          understand_declutter: resolve(
            "flag.dashboard.callout.understand_declutter"
          ),
          understand_only: resolve("flag.dashboard.callout.understand_only"),
        },
        focusStrip: resolve("flag.dashboard.focus_strip"),
        heroQuiet: resolve("flag.dashboard.hero.quiet_state"),
        heroAttention: resolve("flag.dashboard.hero.attention_state"),
        manualAppsBanner: resolve("flag.dashboard.manual_apps_banner"),
        riskSection: resolve("flag.dashboard.risk_section"),
        glanceSection: resolve("flag.dashboard.glance_section"),
        reviewSection: resolve("flag.dashboard.review_section"),
        profileMismatchSection: resolve(
          "flag.dashboard.profile_mismatch_section"
        ),
        staleSection: resolve("flag.dashboard.stale_section"),
        activitySection: resolve("flag.dashboard.activity_section"),
        riskTierLegend: resolve("flag.dashboard.risk_tier_legend"),
        backgroundModeWizard: resolve("flag.dashboard.background_mode_wizard"),
        taskList: resolve("flag.dashboard.task_list"),
        layoutEditorVisible: resolve("flag.dashboard.layout_editor.visible"),
      };
    } catch (error) {
      console.warn("[dashboard] flag resolution failed:", error);
      return;
    }
  })();

  // Guardian age-rating summary for the callout. Only computed when the
  // callout flag resolved on AND a band is stored — both cheap reads.
  // Null (off / no band / error) drops the callout entirely.
  const ageRatingFlagged = (() => {
    if (!flags?.callout.age_rating) {
      return null;
    }
    try {
      const band = getChildAgeBand();
      if (!band) {
        return null;
      }
      return { band, count: countAppsAboveAgeBand(band) };
    } catch (error) {
      console.warn("[dashboard] age-rating count failed:", error);
      return null;
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
      console.warn("[dashboard] resolveAllTasks failed:", error);
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
      console.warn("[dashboard] resolveOptInCandidates failed:", error);
      return [];
    }
  })();

  // Journey-strip vs legacy-list rendering of the tasks panel. Resolved
  // here (not inside TaskList) so the variant choice sits next to the
  // other dashboard flag reads; "list" is the safe fallback.
  const taskJourneyVariant: "journey" | "list" = (() => {
    try {
      return resolveFlagFromDb("flag.dashboard.task_journey") === "on"
        ? "journey"
        : "list";
    } catch (error) {
      console.warn("[dashboard] task_journey flag resolution failed:", error);
      return "list";
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
      const completed = getSetting("background_wizard_completed_at", "");
      const dismissed = getSetting("background_wizard_dismissed_at", "");
      return !(completed || dismissed);
    } catch {
      return false;
    }
  })();

  // Coachmark tour gating + focus state for goal-driven step inclusion.
  // Tour is hard-gated by `flag.onboarding.coachmark_tour`; sessionStorage
  // tracks per-session completion inside the component itself.
  const tourEnabled = (() => {
    try {
      return resolveFlagFromDb("flag.onboarding.coachmark_tour") === "on";
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
        appCountBadge: resolveFlagFromDb("flag.nav.app_count_badge") === "on",
        notificationBell:
          resolveFlagFromDb("flag.nav.notification_bell") === "on",
        notificationBellPolling:
          resolveFlagFromDb("flag.notifications.bell.polling") === "on",
        taskCenterTrigger:
          resolveFlagFromDb("flag.nav.task_center_trigger") === "on",
        taskListIcon: resolveFlagFromDb("flag.nav.task_list_icon") === "on",
        mobileDrawer: resolveFlagFromDb("flag.nav.mobile_drawer") === "on",
        pagePrivacyMap: resolveFlagFromDb("flag.page.privacy_map") === "on",
        pageStats: resolveFlagFromDb("flag.page.stats") === "on",
        pageShortlist: resolveFlagFromDb("flag.page.shortlist") === "on",
      };
    } catch {
      return;
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

  // Saved dashboard layout (preset or custom). Always reconciled against
  // the current canonical card set on read so older shapes upgrade
  // automatically when new cards ship. Swallowed DB errors fall back to
  // the canonical default — same defensive pattern as the other reads on
  // this page.
  const dashboardLayout: DashboardLayout = (() => {
    try {
      return getDashboardLayout();
    } catch (error) {
      console.warn("[dashboard] getDashboardLayout failed:", error);
      return DEFAULT_LAYOUT;
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
      console.warn("[dashboard] reviewableCount computation failed:", error);
      return 0;
    }
  })();

  return (
    <>
      <Nav appCount={triage.totalApps} flags={navFlags} />
      {recentBundleImport && (
        <BundleImportProvenanceBanner
          annotationsAdded={recentBundleImport.annotationsAdded}
          appsAdded={recentBundleImport.appsAdded}
          appsUpdated={recentBundleImport.appsUpdated}
          importedAt={recentBundleImport.importedAt}
          recommenderName={recentBundleImport.recommenderName ?? "your friend"}
        />
      )}
      <HomeView
        ageRatingFlagged={ageRatingFlagged}
        backgroundCalloutVisible={backgroundCalloutVisible}
        editMode={editLayoutRequested && (flags?.layoutEditorVisible ?? true)}
        flags={flags}
        focusSummary={focusSummary}
        layout={dashboardLayout}
        manualAppsBannerDismissed={manualAppsBannerDismissed}
        manualAppsCount={manualAppsCount}
        mismatchedApps={mismatchedApps}
        // The "N apps need a decision" CTA is now part of the
        // customisable layout (card id `review_cta`). The server
        // renders the banner here so server-side `getTranslations`
        // resolves the ICU plural; HomeView slots it into the layout
        // order in place of the standalone render above HomeView.
        reviewCtaSlot={
          reviewableCount > 0 ? (
            <ReviewCtaBanner count={reviewableCount} />
          ) : null
        }
        taskListSlot={
          <TaskList
            candidates={userTaskCandidates}
            tasks={userTasks}
            variant={taskJourneyVariant}
          />
        }
        triage={triage}
      />
      {tourEnabled && tourFocus && (
        <CoachmarkTour
          aiConfigured={tourFocus.aiConfigured}
          audience={tourFocus.audience}
          enabled={tourEnabled}
          goals={tourFocus.goals}
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
  const t = await getTranslations("dashboard.review_cta");
  return (
    <div className="review-cta-wrap">
      <Link
        aria-label={t("aria", { count })}
        className="review-cta"
        href="/dashboard/review-recommendations"
      >
        <span aria-hidden="true" className="review-cta-icon">
          📝
        </span>
        <span className="review-cta-body">
          <strong>{t("heading", { count })}</strong>
          <span className="review-cta-sub">{t("body")}</span>
        </span>
        <span aria-hidden="true" className="review-cta-arrow">
          →
        </span>
      </Link>
    </div>
  );
}

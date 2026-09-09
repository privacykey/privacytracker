"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { type DashboardLayout, DEFAULT_LAYOUT } from "@/lib/dashboard-layout";
import { describePurpose } from "@/lib/onboarding-purpose";
import { useFlagBundle, useFlagBundleStatus } from "@/lib/use-flag-bundle";
import BundleImportProvenanceBanner from "./BundleImportProvenanceBanner";
import CoachmarkTour from "./CoachmarkTour";
import HomeView, {
  type DashboardFlagState,
  type FocusSummary,
} from "./HomeView";
import Nav from "./Nav";
import ReviewCtaBanner from "./ReviewCtaBanner";
import SampleModeView from "./SampleModeView";
import TaskList from "./TaskList";

/**
 * Client loader for /dashboard (Rust-core Phase 0) — the last and largest
 * page of the conversion. The page did 27 server reads; they now come
 * from nine GET fetches issued together, the shared flag bundle, and two
 * POSTs that replace server-side writes. Behaviours preserved on
 * purpose, each of which a literal port would have broken:
 *
 * ORDER OF EFFECTS. The page ran: sample short-circuit → triage →
 * welcomed_at (only if unset, only with apps) → migration-marker consume
 * (only with apps; one-shot read-and-clear) → empty-install redirect →
 * render. That order is kept exactly. In particular ?sample=1 returns
 * BEFORE any effect runs (no writes, no marker burned for a demo
 * preview), and the marker is consumed only once triage confirms apps.
 *
 * TWO-WAY EMPTY REDIRECT. No apps + no focus → /welcome (the splash sets
 * the focus the dashboard keys off); no apps + focus → /onboard. A
 * failed triage fetch takes the same branch as "no apps", as the page's
 * catch did. RequireAppsGate is single-target, so it is not used here.
 *
 * FLAGS FAIL OPEN. The page's resolver catch produced `undefined`, and
 * HomeView / Nav apply their own `?? true` / `?? false` defaults to an
 * undefined flag state. useFlagBundle fails CLOSED, so on failedToLoad
 * this passes `undefined` — never a bundle of falses, which would render
 * an empty dashboard and a link-less nav.
 *
 * HELD MOUNT. `layout` seeds useDashboardLayoutSaver's useState and never
 * re-syncs — mounting HomeView with DEFAULT_LAYOUT while the saved layout
 * is in flight would make ?edit=layout's first debounced PUT overwrite
 * the user's custom layout (and log a dashboard_layout_applied row).
 * `manualAppsBannerDismissed` seeds state the same way. Nothing renders
 * until every wave-1 read, the flag bundle, and the (flag-gated) age
 * rating read have all settled.
 *
 * AGE RATING IS GATED. countAppsAboveAgeBand() scans every rated app; the
 * page only ran it when the callout flag resolved on, so the fetch waits
 * for the bundle and is skipped when the flag is off.
 *
 * SLOTS. TaskList (now a client component over UserTasksProvider) and
 * ReviewCtaBanner are passed as ReactNodes as before. reviewCtaSlot is
 * null — not a zero-count banner — when nothing is reviewable, because
 * HomeView reads a non-null slot as "has data" and edit mode renders a
 * null slot as a reorderable ghost row.
 */

const DASHBOARD_FLAG_KEYS = [
  "flag.dashboard.callout.age_rating",
  "flag.dashboard.callout.declutter",
  "flag.dashboard.callout.guardian",
  "flag.dashboard.callout.understand_declutter",
  "flag.dashboard.callout.understand_only",
  "flag.dashboard.focus_strip",
  "flag.dashboard.hero.quiet_state",
  "flag.dashboard.hero.attention_state",
  "flag.dashboard.manual_apps_banner",
  "flag.dashboard.risk_section",
  "flag.dashboard.glance_section",
  "flag.dashboard.review_section",
  "flag.dashboard.profile_mismatch_section",
  "flag.dashboard.stale_section",
  "flag.dashboard.activity_section",
  "flag.dashboard.risk_tier_legend",
  "flag.dashboard.background_mode_wizard",
  "flag.dashboard.task_list",
  "flag.dashboard.layout_editor.visible",
  "flag.nav.app_count_badge",
  "flag.nav.notification_bell",
  "flag.notifications.bell.polling",
  "flag.nav.task_center_trigger",
  "flag.nav.task_list_icon",
  "flag.nav.mobile_drawer",
  "flag.page.privacy_map",
  "flag.page.stats",
  "flag.page.shortlist",
  "flag.dashboard.task_journey",
  "flag.onboarding.coachmark_tour",
] as const;

type HomeProps = Parameters<typeof HomeView>[0];
type NavFlags = Parameters<typeof Nav>[0]["flags"];
type TourGoals = Parameters<typeof CoachmarkTour>[0]["goals"];

interface FocusPayload {
  accessibility: boolean;
  aiConfigured: boolean;
  audience: HomeProps["triage"] extends never
    ? never
    : Parameters<typeof CoachmarkTour>[0]["audience"];
  audienceSet: boolean;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
  workflow: Parameters<typeof describePurpose>[0]["workflow"];
}

interface RecentImport {
  annotationsAdded: number;
  appsAdded: number;
  appsUpdated: number;
  importedAt: number;
  recommenderName: string | null;
}

interface Loaded {
  backgroundCalloutVisible: boolean;
  focus: FocusPayload | null;
  layout: DashboardLayout;
  manualAppsBannerDismissed: boolean;
  manualAppsCount: number;
  mismatchedApps: NonNullable<HomeProps["mismatchedApps"]>;
  recentImport: RecentImport | null;
  reviewableCount: number;
  triage: HomeProps["triage"];
}

const json = (url: string) =>
  fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

export default function HomeLoader() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sampleMode = searchParams.get("sample") === "1";
  const editLayoutRequested = searchParams.get("edit") === "layout";

  const [data, setData] = useState<Loaded | null>(null);
  // `undefined` = not decided yet; `null` = callout off / no band / error.
  const [ageRating, setAgeRating] = useState<
    HomeProps["ageRatingFlagged"] | undefined
  >(undefined);

  const bundle = useFlagBundle(DASHBOARD_FLAG_KEYS);
  const { failedToLoad } = useFlagBundleStatus();
  const flagsSettled = bundle !== null || failedToLoad;

  // Wave 1 — every read the page did before deciding whether to render.
  useEffect(() => {
    if (sampleMode) {
      return;
    }
    let live = true;
    Promise.all([
      json("/api/triage"),
      json("/api/focus"),
      json("/api/manual-apps"),
      json("/api/preferences"),
      json("/api/dashboard/layout"),
      json("/api/settings"),
      json("/api/privacy-profile/mismatches"),
      json("/api/import/audit-bundle/recent"),
      json("/api/review-queue?count=1"),
    ]).then(
      async ([
        triage,
        focus,
        manual,
        prefs,
        layoutJson,
        settings,
        mismatches,
        recent,
        review,
      ]) => {
        if (!live) {
          return;
        }
        // A failed triage read and a genuinely empty install are the
        // SAME branch, as on the server.
        const totalApps: number = triage?.totalApps ?? 0;
        if (totalApps === 0) {
          router.replace(focus?.audienceSet ? "/onboard" : "/welcome");
          return;
        }

        // Lazy welcomed_at — first-write-wins, so this can fire on every
        // mount without re-stamping the completion time.
        fetch("/api/welcomed-at", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ifUnset: true }),
        }).catch(() => {
          /* the page swallowed this too */
        });

        // One-shot migration marker — only now that apps are confirmed.
        const migrate = await fetch("/api/migration-flow/consume", {
          method: "POST",
        })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null);
        if (!live) {
          return;
        }
        if (typeof migrate?.targetPath === "string") {
          router.replace(migrate.targetPath);
          return;
        }

        setData({
          triage,
          focus: focus ?? null,
          manualAppsCount: manual?.apps?.length ?? 0,
          manualAppsBannerDismissed: prefs?.manualAppsBannerDismissed === true,
          layout: layoutJson?.layout ?? DEFAULT_LAYOUT,
          backgroundCalloutVisible: settings
            ? !(
                settings.background_wizard_completed_at ||
                settings.background_wizard_dismissed_at
              )
            : false,
          mismatchedApps: mismatches?.apps ?? [],
          recentImport: recent?.recent ?? null,
          reviewableCount: review?.reviewableCount ?? 0,
        });
      }
    );
    return () => {
      live = false;
    };
  }, [sampleMode, router]);

  const ageRatingCalloutOn =
    !failedToLoad && bundle?.["flag.dashboard.callout.age_rating"] === true;

  // Wave 2 — gated on the resolved flag, exactly as the page gated the
  // full-table scan behind it.
  useEffect(() => {
    if (sampleMode || !(data && flagsSettled)) {
      return;
    }
    if (!ageRatingCalloutOn) {
      setAgeRating(null);
      return;
    }
    let live = true;
    json("/api/age-rating/summary").then((summary) => {
      if (live) {
        setAgeRating(
          summary?.band ? { band: summary.band, count: summary.count } : null
        );
      }
    });
    return () => {
      live = false;
    };
  }, [sampleMode, data, flagsSettled, ageRatingCalloutOn]);

  if (sampleMode) {
    return (
      <>
        <Nav />
        <SampleModeView />
      </>
    );
  }

  if (!(data && flagsSettled && ageRating !== undefined)) {
    return null;
  }

  const v = failedToLoad ? null : bundle;
  const flags: DashboardFlagState | undefined = v
    ? {
        callout: {
          age_rating: v["flag.dashboard.callout.age_rating"],
          declutter: v["flag.dashboard.callout.declutter"],
          guardian: v["flag.dashboard.callout.guardian"],
          understand_declutter:
            v["flag.dashboard.callout.understand_declutter"],
          understand_only: v["flag.dashboard.callout.understand_only"],
        },
        focusStrip: v["flag.dashboard.focus_strip"],
        heroQuiet: v["flag.dashboard.hero.quiet_state"],
        heroAttention: v["flag.dashboard.hero.attention_state"],
        manualAppsBanner: v["flag.dashboard.manual_apps_banner"],
        riskSection: v["flag.dashboard.risk_section"],
        glanceSection: v["flag.dashboard.glance_section"],
        reviewSection: v["flag.dashboard.review_section"],
        profileMismatchSection: v["flag.dashboard.profile_mismatch_section"],
        staleSection: v["flag.dashboard.stale_section"],
        activitySection: v["flag.dashboard.activity_section"],
        riskTierLegend: v["flag.dashboard.risk_tier_legend"],
        backgroundModeWizard: v["flag.dashboard.background_mode_wizard"],
        taskList: v["flag.dashboard.task_list"],
        layoutEditorVisible: v["flag.dashboard.layout_editor.visible"],
      }
    : undefined;
  const navFlags: NavFlags = v
    ? {
        appCountBadge: v["flag.nav.app_count_badge"],
        notificationBell: v["flag.nav.notification_bell"],
        notificationBellPolling: v["flag.notifications.bell.polling"],
        taskCenterTrigger: v["flag.nav.task_center_trigger"],
        taskListIcon: v["flag.nav.task_list_icon"],
        mobileDrawer: v["flag.nav.mobile_drawer"],
        pagePrivacyMap: v["flag.page.privacy_map"],
        pageStats: v["flag.page.stats"],
        pageShortlist: v["flag.page.shortlist"],
      }
    : undefined;
  const taskJourneyVariant: "journey" | "list" = v?.[
    "flag.dashboard.task_journey"
  ]
    ? "journey"
    : "list";
  // The page's catch resolved this to false; a failed bundle does too.
  const tourEnabled = v?.["flag.onboarding.coachmark_tour"] === true;

  const { focus } = data;
  const focusSummary: FocusSummary | null = focus?.audienceSet
    ? {
        purpose: describePurpose({
          audience: focus.audience,
          monitor: focus.monitor,
          cleanup: focus.cleanup,
          minimal: focus.minimal,
          accessibility: focus.accessibility,
          workflow: focus.workflow,
        }).primary,
        understandDeclutter: focus.monitor && focus.cleanup,
      }
    : null;
  // getActiveFocus() defaulted to self regardless of audienceSet, so the
  // tour ran whenever the read succeeded.
  const tourGoals = focus
    ? (new Set(
        (
          [
            ["monitor", focus.monitor],
            ["cleanup", focus.cleanup],
            ["minimal", focus.minimal],
            ["accessibility", focus.accessibility],
          ] as const
        )
          .filter(([, on]) => on)
          .map(([goal]) => goal)
      ) as TourGoals)
    : null;

  return (
    <>
      <Nav appCount={data.triage.totalApps} flags={navFlags} />
      {data.recentImport && (
        <BundleImportProvenanceBanner
          annotationsAdded={data.recentImport.annotationsAdded}
          appsAdded={data.recentImport.appsAdded}
          appsUpdated={data.recentImport.appsUpdated}
          importedAt={data.recentImport.importedAt}
          recommenderName={data.recentImport.recommenderName ?? "your friend"}
        />
      )}
      <HomeView
        ageRatingFlagged={ageRating}
        backgroundCalloutVisible={data.backgroundCalloutVisible}
        editMode={editLayoutRequested && (flags?.layoutEditorVisible ?? true)}
        flags={flags}
        focusSummary={focusSummary}
        layout={data.layout}
        manualAppsBannerDismissed={data.manualAppsBannerDismissed}
        manualAppsCount={data.manualAppsCount}
        mismatchedApps={data.mismatchedApps}
        reviewCtaSlot={
          data.reviewableCount > 0 ? (
            <ReviewCtaBanner count={data.reviewableCount} />
          ) : null
        }
        taskListSlot={<TaskList variant={taskJourneyVariant} />}
        triage={data.triage}
      />
      {tourEnabled && focus && tourGoals && (
        <CoachmarkTour
          aiConfigured={focus.aiConfigured}
          audience={focus.audience}
          enabled={tourEnabled}
          goals={tourGoals}
        />
      )}
    </>
  );
}

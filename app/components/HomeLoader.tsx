"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { type DashboardLayout, DEFAULT_LAYOUT } from "@/lib/dashboard-layout";
import { describePurpose } from "@/lib/onboarding-purpose";
import { isSameOriginPath } from "@/lib/same-origin-path";
import { useFlagBundleStatus, useFlagValues } from "@/lib/use-flag-bundle";
import BundleImportProvenanceBanner from "./BundleImportProvenanceBanner";
import CoachmarkTour from "./CoachmarkTour";
import { useDeviceScope, withScopeParam } from "./DeviceScopeProvider";
import HomeView, {
  type DashboardFlagState,
  type FocusSummary,
} from "./HomeView";
import LoaderRetry from "./LoaderRetry";
import { NavSkeleton, PageSkeleton } from "./LoadingShell";
import Nav from "./Nav";
import ReviewCtaBanner from "./ReviewCtaBanner";
import SampleModeView, { SampleModeNav } from "./SampleModeView";
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
 * failed triage or focus reads show a retry state, preserving the saved
 * onboarding choices. RequireAppsGate is single-target, so it is not used here.
 *
 * FLAGS FAIL OPEN. The page's resolver catch produced `undefined`, and
 * HomeView / Nav apply their own `?? true` / `?? false` defaults to an
 * undefined flag state. A failed bundle read leaves every key unset, so
 * on failedToLoad this passes `undefined` — never a bundle of falses,
 * which would render an empty dashboard and a link-less nav.
 *
 * RAW READ. The keys are read raw (useFlagValues) and coerced with
 * `=== "on"` here, key by key, because one of them is tri-state:
 * `flag.dashboard.risk_tier_legend` defaults to "collapsed", which a
 * boolean read turns into false. That hid the "How we score risk" legend
 * for every focus. It is passed through raw, as AppDetailLoader does for
 * the annotations rail. useFlagValues rather than the hard-default
 * seeded hook, because the HELD MOUNT below waits on its `null`; a
 * seeded value would paint the legend for a minimal focus and then take
 * it away.
 *
 * HELD MOUNT. `layout` seeds useDashboardLayoutSaver's useState and never
 * re-syncs — mounting HomeView in edit mode with DEFAULT_LAYOUT after a
 * failed read would let the first PUT overwrite the user's custom layout.
 * Layout reads are required in edit mode, and a previously unverified
 * fallback cannot become editable while the required read is in flight.
 * `manualAppsBannerDismissed` seeds state the same way. HomeView does not
 * mount until every wave-1 read, the flag bundle, and the (flag-gated)
 * age rating read have all settled; until then the loader paints the
 * neutral nav and page skeletons (LoadingShell.tsx), never the real Nav,
 * whose links are flag-gated here.
 *
 * AGE RATING IS GATED. countAppsAboveAgeBand() scans every rated app; the
 * page only ran it when the callout flag resolved on, so the fetch waits
 * for the bundle and is skipped when the flag is off. It runs alongside
 * wave 1 rather than after it.
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

type DashboardFlagKey = (typeof DASHBOARD_FLAG_KEYS)[number];
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
  layoutVerified: boolean;
  manualAppsBannerDismissed: boolean;
  manualAppsCount: number;
  mismatchedApps: NonNullable<HomeProps["mismatchedApps"]>;
  recentImport: RecentImport | null;
  reviewableCount: number;
  scopeParam: string | null;
  triage: HomeProps["triage"];
}

const requiredJson = (url: string) =>
  fetch(url).then((res) =>
    res.ok
      ? res.json()
      : Promise.reject(new Error(`HTTP ${res.status}: ${url}`))
  );

const json = (url: string) =>
  fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

export default function HomeLoader() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sampleMode = searchParams.get("sample") === "1";
  const editLayoutRequested = searchParams.get("edit") === "layout";

  const visits = useRef(
    new Map<
      string,
      { since: number | null; recorded: boolean; startedAt: number }
    >()
  );
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // `undefined` = not decided yet; `null` = callout off / no band / error.
  const [ageRating, setAgeRating] = useState<
    HomeProps["ageRatingFlagged"] | undefined
  >(undefined);

  const flagValues = useFlagValues(DASHBOARD_FLAG_KEYS);
  const { failedToLoad } = useFlagBundleStatus();
  const flagsSettled = flagValues !== null || failedToLoad;
  const { ready: scopeReady, scopeParam } = useDeviceScope();

  // Wave 1 — every read the page did before deciding whether to render.
  useEffect(() => {
    if (sampleMode) {
      return;
    }
    // Hold for the scope, for the same reason the grid does: the
    // empty-install redirect below reads `totalApps`, and firing it
    // against an unscoped read that later narrows would bounce a user to
    // onboarding on a scope change.
    if (!scopeReady) {
      return;
    }
    let live = true;
    setFailed(false);
    const visitKey = `privacytracker.dashboard.visit.${scopeParam ?? "all"}`;
    if (!visits.current.has(visitKey)) {
      let since: number | null = null;
      try {
        const value = Number(localStorage.getItem(visitKey));
        if (Number.isSafeInteger(value) && value > 0 && value <= Date.now()) {
          since = value;
        }
      } catch {
        /* Storage is optional. */
      }
      visits.current.set(visitKey, {
        since,
        recorded: false,
        startedAt: Date.now(),
      });
    }
    const visit = visits.current.get(visitKey)!;
    Promise.all([
      // Three of these describe "your apps" and so follow the device
      // scope: the triage blob (every dashboard count), the off-profile
      // list, and the review CTA's number. The other six are install-wide
      // settings and are deliberately left unscoped.
      requiredJson(
        withScopeParam(
          `/api/triage?overview=1${visit.since ? `&since=${visit.since}` : ""}`,
          scopeParam
        )
      ),
      requiredJson("/api/focus"),
      json("/api/manual-apps"),
      json("/api/preferences"),
      (editLayoutRequested ? requiredJson : json)("/api/dashboard/layout"),
      json("/api/settings"),
      json(
        withScopeParam(
          "/api/privacy-profile/mismatches?unresolved=1",
          scopeParam
        )
      ),
      json("/api/import/audit-bundle/recent"),
      json(withScopeParam("/api/review-queue?count=1", scopeParam)),
    ])
      .then(
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
          if (
            typeof triage?.totalApps !== "number" ||
            typeof focus?.audienceSet !== "boolean"
          ) {
            throw new Error("Invalid dashboard state");
          }
          if (editLayoutRequested && !layoutJson?.layout) {
            throw new Error("Could not load saved dashboard layout");
          }
          const totalApps: number = triage.totalApps;
          // `!scopeParam`: scoped to a device with nothing on it,
          // totalApps is legitimately 0. Bouncing there would eject a user
          // with a full library out to /onboard for picking a quiet phone
          // in the nav. Only an unscoped zero means an empty install.
          if (totalApps === 0 && !scopeParam) {
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
          // Checked here as well as on the server: this client never
          // navigates anywhere but a path inside the app.
          if (isSameOriginPath(migrate?.targetPath)) {
            router.replace(migrate.targetPath);
            return;
          }

          if (!visit.recorded) {
            try {
              localStorage.setItem(visitKey, String(visit.startedAt));
            } catch {
              /* Keep the dashboard usable without storage. */
            }
            visit.recorded = true;
          }
          setData({
            triage,
            focus: focus ?? null,
            manualAppsCount: manual?.apps?.length ?? 0,
            manualAppsBannerDismissed:
              prefs?.manualAppsBannerDismissed === true,
            layout: layoutJson?.layout ?? DEFAULT_LAYOUT,
            layoutVerified: Boolean(layoutJson?.layout),
            backgroundCalloutVisible: settings
              ? !(
                  settings.background_wizard_completed_at ||
                  settings.background_wizard_dismissed_at
                )
              : false,
            mismatchedApps: mismatches?.apps ?? [],
            recentImport: recent?.recent ?? null,
            reviewableCount: review?.reviewableCount ?? 0,
            scopeParam,
          });
        }
      )
      .catch((error) => {
        console.warn("[dashboard] essential state load failed:", error);
        if (live) {
          setFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [sampleMode, router, scopeReady, scopeParam, editLayoutRequested, retry]);

  const ageRatingCalloutOn =
    !failedToLoad && flagValues?.["flag.dashboard.callout.age_rating"] === "on";

  // Wave 2 — gated on the resolved flag, exactly as the page gated the
  // full-table scan behind it. It no longer waits for wave 1 as well:
  // the flag is the gate, and running the two one after the other added
  // a whole round trip before the dashboard could paint. `retry` re-runs
  // it with wave 1 (after a sync, or a Try again), as `data` used to.
  useEffect(() => {
    if (sampleMode || !flagsSettled) {
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
  }, [sampleMode, flagsSettled, ageRatingCalloutOn, retry]);

  if (sampleMode) {
    // The demo gets its own nav: the full one links to pages that send an
    // install with no apps to onboarding without a word (SampleModeView).
    return (
      <>
        <SampleModeNav />
        <SampleModeView />
      </>
    );
  }

  if (failed) {
    return (
      <>
        <Nav />
        <LoaderRetry onRetry={() => setRetry((value) => value + 1)} />
      </>
    );
  }

  if (
    !(data && flagsSettled && ageRating !== undefined) ||
    (editLayoutRequested && !data.layoutVerified)
  ) {
    // Held (see HELD MOUNT above), but not blank: the nav skeleton holds
    // the bar's place without any flag-gated link, and the page skeleton
    // tells assistive tech the page is loading.
    return (
      <>
        <NavSkeleton />
        <PageSkeleton />
      </>
    );
  }

  const v = failedToLoad ? null : flagValues;
  const on = (key: DashboardFlagKey) => v?.[key] === "on";
  const flags: DashboardFlagState | undefined = v
    ? {
        callout: {
          age_rating: on("flag.dashboard.callout.age_rating"),
          declutter: on("flag.dashboard.callout.declutter"),
          guardian: on("flag.dashboard.callout.guardian"),
          understand_declutter: on(
            "flag.dashboard.callout.understand_declutter"
          ),
          understand_only: on("flag.dashboard.callout.understand_only"),
        },
        focusStrip: on("flag.dashboard.focus_strip"),
        heroQuiet: on("flag.dashboard.hero.quiet_state"),
        heroAttention: on("flag.dashboard.hero.attention_state"),
        manualAppsBanner: on("flag.dashboard.manual_apps_banner"),
        riskSection: on("flag.dashboard.risk_section"),
        glanceSection: on("flag.dashboard.glance_section"),
        reviewSection: on("flag.dashboard.review_section"),
        profileMismatchSection: on("flag.dashboard.profile_mismatch_section"),
        staleSection: on("flag.dashboard.stale_section"),
        activitySection: on("flag.dashboard.activity_section"),
        // Tri-state, passed raw (see RAW READ above). A key the server
        // did not return falls back to the hard default.
        riskTierLegend: v["flag.dashboard.risk_tier_legend"] ?? "collapsed",
        backgroundModeWizard: on("flag.dashboard.background_mode_wizard"),
        taskList: on("flag.dashboard.task_list"),
        layoutEditorVisible: on("flag.dashboard.layout_editor.visible"),
      }
    : undefined;
  const navFlags: NavFlags = v
    ? {
        appCountBadge: on("flag.nav.app_count_badge"),
        notificationBell: on("flag.nav.notification_bell"),
        notificationBellPolling: on("flag.notifications.bell.polling"),
        taskCenterTrigger: on("flag.nav.task_center_trigger"),
        taskListIcon: on("flag.nav.task_list_icon"),
        mobileDrawer: on("flag.nav.mobile_drawer"),
        pagePrivacyMap: on("flag.page.privacy_map"),
        pageStats: on("flag.page.stats"),
        pageShortlist: on("flag.page.shortlist"),
      }
    : undefined;
  const taskJourneyVariant: "journey" | "list" = on(
    "flag.dashboard.task_journey"
  )
    ? "journey"
    : "list";
  // The page's catch resolved this to false; a failed bundle does too.
  const tourEnabled = on("flag.onboarding.coachmark_tour");

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
        audience: focus.audience,
        monitor: focus.monitor,
        cleanup: focus.cleanup,
        minimal: focus.minimal,
        accessibility: focus.accessibility,
        workflow: focus.workflow,
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
        onSyncComplete={() => setRetry((value) => value + 1)}
        reviewCtaSlot={
          !data.triage.overview && data.reviewableCount > 0 ? (
            <ReviewCtaBanner count={data.reviewableCount} />
          ) : null
        }
        scopeParam={data.scopeParam}
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

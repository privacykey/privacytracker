"use client";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgeBandKey } from "../../lib/age-rating";
import {
  CALLOUT_CARDS,
  DASHBOARD_PRESET_KEYS,
  DASHBOARD_PRESET_META,
  type DashboardCardId,
  type DashboardLayout,
  DEFAULT_LAYOUT,
  FIRST_CLASS_CARDS,
} from "../../lib/dashboard-layout";
import { categoryLabel as i18nCategoryLabel } from "../../lib/i18n-meta";
import { INTENT_META, type UserIntent } from "../../lib/preferences";
import { CATEGORY_META } from "../../lib/privacy-meta";
import {
  type AppMismatchSummary,
  describeWorstMismatchLocalised,
  TIER_META,
} from "../../lib/privacy-profile";
import { scrollPulse } from "../../lib/scroll-pulse";
import type {
  RecentActivityEntry,
  ReviewableApp,
  ReviewableChangeCategory,
  TriageApp,
  TriageData,
} from "../../lib/triage";
import {
  type UseDashboardLayoutSaverResult,
  useDashboardLayoutSaver,
} from "../../lib/use-dashboard-layout-saver";
import {
  rovingTabIndex,
  useRovingRadioGroup,
} from "../../lib/use-roving-radiogroup";
import BackgroundModeCallout from "./BackgroundModeCallout";
import PrivacyTypeIcon from "./PrivacyTypeIcon";
import { useTaskCenter } from "./TaskCenter";
import Toast from "./Toast";

// ─────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────

/** Smooth-scroll to an in-page anchor and briefly flash it so the user sees
 *  "something happened" even when the target is already in view. */
function handleHashClick(
  e: React.MouseEvent<HTMLAnchorElement>,
  hash: string
): void {
  if (!hash.startsWith("#")) {
    return;
  }
  const id = hash.slice(1);
  const el =
    typeof document === "undefined" ? null : document.getElementById(id);
  if (!el) {
    return;
  }
  e.preventDefault();
  // Also shift keyboard focus to the destination so tabbing continues
  // from there and screen readers announce the new landing point. If
  // the target isn't naturally focusable, give it a temporary
  // tabindex="-1" for programmatic focus only.
  if (!el.hasAttribute("tabindex")) {
    el.setAttribute("tabindex", "-1");
  }
  el.focus({ preventScroll: true });
  // Fire-and-forget from a click handler: scrollPulse self-cancels the
  // previous run on repeat clicks, so no handle to keep here.
  scrollPulse(el, { className: "home-pulse", durationMs: 1400 });
  if (history?.replaceState) {
    history.replaceState(null, "", hash);
  }
}

type RelT = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

function relativeTime(t: RelT, ts: number): string {
  if (!ts) {
    return t("dash");
  }
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) {
    return t("just_now");
  }
  if (s < 3600) {
    return t("minutes_ago", { count: Math.floor(s / 60) });
  }
  if (s < 86_400) {
    return t("hours_ago", { count: Math.floor(s / 3600) });
  }
  const d = Math.floor(s / 86_400);
  if (d === 1) {
    return t("yesterday");
  }
  if (d < 30) {
    return t("days_ago", { count: d });
  }
  const months = Math.floor(d / 30);
  return t("months_ago", { count: months });
}

const RISK_CLS: Record<TriageApp["riskLevel"], string> = {
  high: "risk-pill-high",
  moderate: "risk-pill-moderate",
  low: "risk-pill-low",
  minimal: "risk-pill-minimal",
};

// ─────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────

/**
 * Resolved dashboard flag values consumed by HomeView. Computed server-side in
 * `app/dashboard/page.tsx` via `resolveFlagFromDb` so the rendered markup is
 * correct on first paint. Round 3 wave D widened this from the four callouts
 * to cover every `flag.dashboard.*` plus the `flag.global.*` flags HomeView
 * cares about; PRs after wave D add more if new sections appear.
 */
export interface DashboardFlagState {
  /** "This week's activity" feed. */
  activitySection: boolean;
  /** Tauri-only "Set up background mode" callout, sits in the focus
   *  strip area. Runtime-gated on `isDesktop()` so the web build never
   *  renders it even when the flag is on. */
  backgroundModeWizard: boolean;
  callout: {
    /** "N apps rated above your child's age range" (guardian feature). */
    age_rating: boolean;
    declutter: boolean;
    guardian: boolean;
    understand_declutter: boolean;
    understand_only: boolean;
  };
  /** Top-of-page chip strip showing the current focus. */
  focusStrip: boolean;
  /** At-a-glance stats grid (apps tracked, categories, high-risk, changes). */
  glanceSection: boolean;
  /** "⚡ Things need attention" hero variant. */
  heroAttention: boolean;
  /** "Nothing new to review" hero variant. */
  heroQuiet: boolean;
  /** "Customise dashboard…" footer link + editor route gate. Off hides
   *  the link only; users with existing custom layouts keep them — the
   *  flag gates the editor surface, not the consumer. */
  layoutEditorVisible: boolean;
  /** "Not everything lives on the App Store" promo card. */
  manualAppsBanner: boolean;
  /** "Consider replacing" — privacy-profile mismatches. */
  profileMismatchSection: boolean;
  /** "Changes to review" block. */
  reviewSection: boolean;
  /** Risk-section watchlist block. */
  riskSection: boolean;
  /** Collapsible risk-tier reference legend. */
  riskTierLegend: boolean;
  /** Stale apps (not synced in 30+ days). */
  staleSection: boolean;
  /** Audience-aware "tasks worth trying" panel at the very top. Off
   *  hides the inline panel only; the nav icon has a separate flag. */
  taskList: boolean;
}

export default function HomeView({
  triage,
  userIntent,
  manualAppsCount,
  manualAppsBannerDismissed,
  mismatchedApps = [],
  flags,
  backgroundCalloutVisible = false,
  taskListSlot,
  reviewCtaSlot = null,
  layout = DEFAULT_LAYOUT,
  editMode = false,
  ageRatingFlagged = null,
}: {
  triage: TriageData;
  /**
   * Archetype the user picked on the welcome splash. `null` while the
   * feature is being rolled out or if the user skipped — in that case the
   * dashboard falls back to the original neutral ordering.
   *
   * Round 3 PR 3: kept as a prop because several intent-driven branches
   * inside HomeView (stale-section elevation, glance-section ordering,
   * focus-strip rendering) still consume it via the back-compat shim in
   * lib/preferences-server.ts. Round 4+ swaps these branches to flags
   * and removes the prop.
   */
  userIntent: UserIntent | null;
  /**
   * How many manual apps (web clips, TestFlight, sideloaded, own-build)
   * the user has tracked. Used to decide whether the "consider adding
   * manual apps" banner is still relevant — once there's one on file we
   * assume the user has discovered the feature.
   */
  manualAppsCount: number;
  /**
   * Sticky dismissal flag persisted via `/api/preferences`. Once set to
   * true the banner stays hidden even if the user later deletes all of
   * their manual apps. Can be cleared from Settings (future work) if we
   * want to let them resurface it.
   */
  manualAppsBannerDismissed: boolean;
  /**
   * Apps whose worst-observed privacy tier exceeds the user's profile. Empty
   * when no profile is set or no app mismatches — the section stays hidden
   * in that case. Already sorted worst-first by the server.
   */
  mismatchedApps?: AppMismatchSummary[];
  /**
   * Resolved dashboard-flag values from the server. Drives the four
   * callouts under §5.3 and (in subsequent PRs) the wider dashboard
   * surface. See `DashboardFlagState` above for the shape.
   */
  flags?: DashboardFlagState;
  /** Server-side gate for the Tauri "Set up background mode" callout —
   *  `true` only when the flag is on AND the user hasn't already
   *  completed or dismissed the wizard. The component still
   *  runtime-checks `isDesktop()` so the web build never renders it. */
  backgroundCalloutVisible?: boolean;
  /** Pre-resolved tasks panel from the server. Passed as a React node so
   *  the server component renders inside the client component's tree
   *  without HomeView depending on next-intl's server runtime. Render in
   *  place at the top of the page — gated on `flags.taskList`. */
  taskListSlot?: ReactNode;
  /**
   * Pre-rendered "N apps need a decision" CTA from the server, or null
   * when there's no review backlog. Lives in the customisable layout
   * (card id `review_cta`) so users can reorder or hide it; the server
   * component handles the data fetch + server-side i18n.
   */
  reviewCtaSlot?: ReactNode;
  /**
   * User's saved dashboard layout — drives card order + which first-class
   * cards are hidden. Defaults to `DEFAULT_LAYOUT` (canonical order, nothing
   * hidden) so callers that haven't been wired through the server-side
   * read still render correctly. The server route does pass it via
   * `getDashboardLayout()` so users see their preset on first paint.
   */
  layout?: DashboardLayout;
  /**
   * Inline edit-in-place mode. When true, the dashboard wraps every card
   * in a sortable overlay (drag handle + hide button) and renders ghost
   * placeholders for hidden / zero-data-predicate cards so users can
   * still reorder + restore them. A sticky toolbar at the top exposes
   * presets, reset, and an "Open list editor" exit to the structured
   * settings page. Triggered by `?edit=layout` server-side.
   */
  editMode?: boolean;
  /**
   * Guardian age-rating summary computed server-side: how many tracked
   * apps are rated above the child's age band, plus the band itself for
   * the callout copy. Null when the feature is off / no band is set /
   * nothing is flagged — the callout drops out entirely.
   */
  ageRatingFlagged?: { band: AgeBandKey; count: number } | null;
}) {
  const taskCenter = useTaskCenter();
  const [syncingAll, setSyncingAll] = useState(false);
  const [toast, setToast] = useState("");
  // Local override so the banner disappears immediately on dismiss without
  // a round-trip refresh. Seeded from the server-persisted flag.
  const [bannerDismissed, setBannerDismissed] = useState(
    manualAppsBannerDismissed
  );
  const [dismissingBanner, setDismissingBanner] = useState(false);
  const showManualAppsBanner = !bannerDismissed && manualAppsCount === 0;

  const dismissManualAppsBanner = async () => {
    if (dismissingBanner) {
      return;
    }
    // Optimistic: hide immediately, re-surface on failure so the user
    // knows we didn't persist their intent.
    setBannerDismissed(true);
    setDismissingBanner(true);
    try {
      const res = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissManualAppsBanner: true }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn("[home] dismiss manual-apps banner failed:", err);
      setBannerDismissed(false);
      showToast(tToasts("dismiss_save_failed"));
    } finally {
      setDismissingBanner(false);
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  // Translation handles for heads-up labels and the sync-all toast
  // copy below. Captured at the top of the component so the useMemo +
  // syncAllStale closure can both depend on stable references.
  const tHeadsUp = useTranslations("dashboard.headsup");
  const tSyncAll = useTranslations("dashboard.sync_all");
  const tToasts = useTranslations("dashboard.toasts");

  const headsUps = useMemo(() => {
    // "Heads up" is only for things that need *action* right now. High-risk
    // apps are ongoing state, not an alert — they live in their own reference
    // block above the hero. Both labels run through the
    // `dashboard.headsup.*` ICU plurals so the count agrees with the
    // active locale.
    const items: { key: string; label: string; cls: string; href: string }[] =
      [];
    if (triage.reviewable.length > 0) {
      items.push({
        key: "review",
        label: tHeadsUp("review_label", { count: triage.reviewable.length }),
        cls: "headsup-review",
        href: "#changes-to-review",
      });
    }
    if (triage.staleCount > 0) {
      items.push({
        key: "stale",
        label: tHeadsUp("stale_label", { count: triage.staleCount }),
        cls: "headsup-stale",
        href: "#stale-apps",
      });
    }
    return items;
  }, [triage, tHeadsUp]);

  const syncAllStale = async () => {
    if (syncingAll) {
      return;
    }
    setSyncingAll(true);
    const total = triage.stale.length || triage.totalApps;
    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title:
        total === triage.totalApps
          ? tSyncAll("title_all_apps")
          : tSyncAll("title_stale_apps"),
      subtitle: tSyncAll("subtitle_count", { count: total }),
      kind: "sync",
      href: "/dashboard",
      onCancel: () => controller.abort(),
    });
    try {
      const res = await fetch("/api/apps");
      const all = (await res.json()) as Array<{
        id: string;
        url: string;
        lastSynced: number;
      }>;
      const pool =
        triage.stale.length > 0
          ? all.filter((a) => triage.stale.some((s) => s.id === a.id))
          : all;
      await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: pool.map((a) => a.url), resync: true }),
        signal: controller.signal,
      });
      showToast(tSyncAll("toast_complete"));
      handle.complete(
        "done",
        tSyncAll("complete_summary", { count: pool.length })
      );
      // Refresh the server-rendered view to pick up new triage data.
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        console.error("[home] Sync-all failed:", err);
        showToast(tSyncAll("toast_failed"));
        handle.complete(
          "error",
          (err as Error)?.message ?? tSyncAll("toast_failed").replace("❌ ", "")
        );
      }
    } finally {
      setSyncingAll(false);
    }
  };

  // Intent-driven tailoring. The user's saved layout drives order +
  // visibility now (see `layout` prop + CARD_RENDERERS below). Intent still
  // feeds the few cases where it affects an individual section's variant
  // rather than its position: hero/risk variant choice + StaleSection's
  // "elevated" treatment for the hygiene archetype. The old `statsFirst`
  // top/bottom flip is gone — users who want stats first pick the
  // `at_a_glance` preset.
  //
  // Callout visibility stays driven by flags (the server pre-resolves the
  // four callout flags from the rule engine), falling back to the legacy
  // intent check when `flags` is missing.
  const showThirdPartyCallout =
    flags?.callout.understand_declutter ?? userIntent === "hygiene";
  const showCleanupCallout =
    flags?.callout.declutter ?? userIntent === "cleanup";
  const showFamilyCallout = flags?.callout.guardian ?? userIntent === "family";
  // No legacy-intent fallback — the age-rating callout is new and only
  // exists behind its flag (which already chains off flag.guardian.age_rating
  // via FLAG_DEPENDENCIES).
  const showAgeRatingCallout = flags?.callout.age_rating ?? false;
  const showDefinitionsCallout =
    flags?.callout.understand_only ?? userIntent === "curious";
  const elevateStale = userIntent === "hygiene";

  // Round 3 wave D: each section's flag-driven visibility. Falls back to
  // the legacy intent-driven render when `flags` isn't passed (mostly for
  // back-compat with any pages that haven't been wired yet).
  const showFocusStrip = flags?.focusStrip ?? true;
  const showManualBannerFlag = flags?.manualAppsBanner ?? true;
  const showRiskFlag = flags?.riskSection ?? true;
  const showHeroQuiet = flags?.heroQuiet ?? true;
  const showHeroAttention = flags?.heroAttention ?? true;
  const showGlance = flags?.glanceSection ?? true;
  const showReview = flags?.reviewSection ?? true;
  const showProfileMismatch = flags?.profileMismatchSection ?? true;
  const showStale = flags?.staleSection ?? true;
  const showActivity = flags?.activitySection ?? true;
  const showRiskTierLegend = flags?.riskTierLegend ?? true;
  const showTaskList = flags?.taskList ?? true;
  const showBackgroundModeWizard = flags?.backgroundModeWizard ?? false;
  const showLayoutEditorLink = flags?.layoutEditorVisible ?? true;

  // In edit mode, the live layout comes from `useDashboardLayoutSaver`
  // (which seeds from the `layout` prop and diverges as the user edits).
  // In normal mode the saver still runs but its state is unused — the
  // hook is unconditional so React doesn't warn about a changing hook
  // order. No API calls fire unless a reorder / toggle / preset actually
  // runs, all of which only happen in edit mode.
  const saver = useDashboardLayoutSaver(layout);
  const effectiveLayout = editMode ? saver.layout : layout;

  // First-class cards in the user's hidden set are dropped before the
  // renderer even runs — keeps the renderers focused on data-driven
  // predicates and the flag axis.
  const hiddenSet = useMemo(
    () => (editMode ? saver.hiddenSet : new Set(layout.hidden)),
    [editMode, saver.hiddenSet, layout.hidden]
  );

  // Renderer map — one closure per card id, returning the JSX or null when
  // the card's data predicate / flag gate is unsatisfied. Iteration order
  // comes from `layout.order` below, so users can reorder freely. Each
  // closure is keyed on its DashboardCardId; missing renderers (e.g. a
  // stored layout that references a deprecated id) just drop out — the
  // server-side `reconcileLayout` strips unknowns on read anyway.
  const renderers: Record<DashboardCardId, () => ReactNode> = {
    task_list: () => (showTaskList ? taskListSlot : null),
    // The server passes `reviewCtaSlot` only when there's actually a
    // review backlog (reviewableCount > 0). When the slot is null the
    // renderer returns null and the card drops out of the rendered list
    // — in edit mode it becomes a "no data right now" ghost so users
    // can still see + reorder it.
    review_cta: () => reviewCtaSlot ?? null,
    focus_strip: () =>
      showFocusStrip && userIntent ? <FocusStrip intent={userIntent} /> : null,
    // Tauri-only — the component itself runtime-gates on `isDesktop()`,
    // and the parent only passes `backgroundCalloutVisible=true` when
    // the user hasn't already completed/dismissed the wizard.
    background_mode_wizard: () =>
      showBackgroundModeWizard && backgroundCalloutVisible ? (
        <BackgroundModeCallout initiallyVisible={true} />
      ) : null,
    manual_apps_banner: () =>
      showManualAppsBanner && showManualBannerFlag ? (
        <ManualAppsBanner
          dismissing={dismissingBanner}
          onDismiss={dismissManualAppsBanner}
        />
      ) : null,
    risk_section: () =>
      showRiskFlag && triage.higherRisk.length > 0 ? (
        <RiskSection
          apps={triage.higherRisk}
          id="higher-risk"
          variant={
            showCleanupCallout
              ? "cleanup"
              : showFamilyCallout
                ? "family"
                : "default"
          }
        />
      ) : null,
    // Hero — quiet vs attention variants are picked by the component
    // based on triage data; the flag pair gates the whole hero. Either-or
    // rather than both, so we render the hero when at least one variant
    // is enabled.
    hero: () =>
      showHeroQuiet || showHeroAttention ? (
        <Hero
          headsUps={headsUps}
          onSyncAll={syncAllStale}
          syncing={syncingAll}
          triage={triage}
        />
      ) : null,
    cleanup_callout: () =>
      showCleanupCallout ? (
        <CleanupCallout count={triage.highRiskCount} />
      ) : null,
    family_callout: () =>
      showFamilyCallout ? <FamilyCallout count={triage.highRiskCount} /> : null,
    age_rating_callout: () =>
      showAgeRatingCallout && ageRatingFlagged && ageRatingFlagged.count > 0 ? (
        <AgeRatingCallout
          band={ageRatingFlagged.band}
          count={ageRatingFlagged.count}
        />
      ) : null,
    third_party_callout: () =>
      showThirdPartyCallout ? <ThirdPartyCallout triage={triage} /> : null,
    glance_section: () =>
      showGlance ? <GlanceSection triage={triage} /> : null,
    definitions_callout: () =>
      showDefinitionsCallout ? <DefinitionsCallout /> : null,
    review_section: () =>
      showReview && triage.reviewable.length > 0 ? (
        <ReviewSection id="changes-to-review" reviewable={triage.reviewable} />
      ) : null,
    profile_mismatch_section: () =>
      showProfileMismatch && mismatchedApps.length > 0 ? (
        <ConsiderReplacingSection
          apps={mismatchedApps}
          id="consider-replacing"
        />
      ) : null,
    stale_section: () =>
      showStale && triage.stale.length > 0 ? (
        <StaleSection
          apps={triage.stale}
          elevated={elevateStale}
          id="stale-apps"
        />
      ) : null,
    activity_section: () =>
      showActivity && triage.recentActivity.length > 0 ? (
        <ActivitySection activity={triage.recentActivity} />
      ) : null,
    risk_tier_legend: () =>
      showRiskTierLegend ? <RiskTierLegend id="risk-tiers" /> : null,
  };

  return editMode ? (
    <EditModeShell
      effectiveLayout={effectiveLayout}
      hiddenSet={hiddenSet}
      renderers={renderers}
      saver={saver}
      toast={toast}
    />
  ) : (
    <div className="page-container home-page">
      {layout.order.map((id) => {
        if (hiddenSet.has(id)) {
          return null;
        }
        const node = renderers[id]?.();
        if (!node) {
          return null;
        }
        return <Fragment key={id}>{node}</Fragment>;
      })}
      {showLayoutEditorLink && <LayoutEditorFooterLink />}
      <Toast>{toast}</Toast>
    </div>
  );
}

// ─────────────────────────────────────────────
// Edit-in-place shell
// ─────────────────────────────────────────────

/**
 * Wraps the dashboard in DndContext + SortableContext, adds the sticky
 * toolbar, and renders each card inside a SortableEditCard. Hidden +
 * zero-data-predicate cards render as compact ghost rows so users can
 * still see them, restore them, and reorder them.
 *
 * Kept inline as a sub-component (not a separate file) because it
 * closures over the renderer map + the rest of HomeView's state, and
 * the renderer map is the load-bearing piece — extracting it would
 * mean threading every triage/flag/handler prop through.
 */
function EditModeShell({
  effectiveLayout,
  hiddenSet,
  renderers,
  saver,
  toast,
}: {
  effectiveLayout: DashboardLayout;
  hiddenSet: ReadonlySet<DashboardCardId>;
  renderers: Record<DashboardCardId, () => ReactNode>;
  saver: UseDashboardLayoutSaverResult;
  toast: string;
}) {
  const t = useTranslations("dashboard.layout_editor");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // 2.4.11 Focus Not Obscured: the sticky toolbar floats over the card
  // list, so focus- or keyboard-drag-driven scrolling must clear it. The
  // toolbar height varies (preset pills wrap at narrow widths / large text
  // scale), so measure it and expose the clearance as a CSS variable that
  // .home-edit-card's scroll-margin-top consumes.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const shell = shellRef.current;
    const toolbar = toolbarRef.current;
    if (!(shell && toolbar) || typeof ResizeObserver === "undefined") {
      return;
    }
    // offsetHeight (not getBoundingClientRect) so the value stays in the
    // same zoomed coordinate space as the scroll-margin that consumes it
    // when the in-app text scale is active. +8 sticky top, +16 breathing.
    const apply = () => {
      shell.style.setProperty(
        "--home-edit-toolbar-clearance",
        `${toolbar.offsetHeight + 24}px`
      );
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(toolbar);
    return () => ro.disconnect();
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      saver.reorder(active.id as DashboardCardId, over.id as DashboardCardId);
    },
    [saver]
  );

  return (
    <div className="page-container home-page home-page-edit" ref={shellRef}>
      <EditModeToolbar saver={saver} toolbarRef={toolbarRef} />
      <DndContext
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        sensors={sensors}
      >
        <SortableContext
          items={effectiveLayout.order as string[]}
          strategy={verticalListSortingStrategy}
        >
          <div aria-label={t("edit_cards_aria")} className="home-edit-cards">
            {effectiveLayout.order.map((id) => {
              const realNode = hiddenSet.has(id) ? null : renderers[id]?.();
              const hidden = hiddenSet.has(id);
              return (
                <SortableEditCard
                  hasData={realNode != null}
                  hidden={hidden}
                  id={id}
                  isCallout={CALLOUT_CARDS.has(id)}
                  key={id}
                  onToggleVisibility={() => saver.toggleVisibility(id)}
                >
                  {realNode}
                </SortableEditCard>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {/* Live region for keyboard drag + post-save announcements. */}
      <div
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {saver.liveMessage}
      </div>

      <Toast>{toast}</Toast>
    </div>
  );
}

// ─────────────────────────────────────────────
// Sticky toolbar — preset pills + reset + open simple editor + done
// ─────────────────────────────────────────────

function EditModeToolbar({
  saver,
  toolbarRef,
}: {
  saver: UseDashboardLayoutSaverResult;
  toolbarRef?: React.Ref<HTMLElement>;
}) {
  const router = useRouter();
  const t = useTranslations("dashboard.layout_editor");
  const tPresetLabel = useTranslations(
    "dashboard.layout_editor.presets.labels"
  );
  const tPresetDesc = useTranslations(
    "dashboard.layout_editor.presets.descriptions"
  );

  // APG keyboard contract for the preset radiogroup: one tab stop,
  // arrows move focus only — applying a preset overwrites the whole
  // layout (and may pop the inline confirm), so Enter/Space commits.
  const presetRadioKeyDown = useRovingRadioGroup({ followFocus: false });

  const exitEditMode = useCallback(() => {
    // Drop ?edit=layout from the URL and trigger a server-side re-fetch
    // so the dashboard rerenders with the freshly-saved layout. Saves
    // are already persisted via the debounced PUT, so a refresh is the
    // simplest way to ensure derived data (triage / flags / etc.) is
    // consistent with the new shape.
    router.push("/dashboard");
    router.refresh();
  }, [router]);

  return (
    <section
      aria-label={t("toolbar_aria")}
      className="home-edit-toolbar"
      ref={toolbarRef}
    >
      <div className="home-edit-toolbar-status">
        <span className="home-edit-toolbar-title">{t("toolbar_title")}</span>
        {saver.savingState === "saving" && (
          <span className="layout-editor-saving">{t("saving")}</span>
        )}
        {saver.savingState === "saved" && (
          <span className="layout-editor-saved">{t("saved")}</span>
        )}
        {saver.savingState === "error" && saver.errorMsg && (
          <span className="layout-editor-error" role="alert">
            {t("save_error", { message: saver.errorMsg })}
          </span>
        )}
      </div>

      <div
        aria-label={t("preset_aria_group")}
        className="home-edit-toolbar-presets"
        onKeyDown={presetRadioKeyDown}
        role="radiogroup"
      >
        {DASHBOARD_PRESET_KEYS.map((presetKey, presetIndex) => {
          const meta = DASHBOARD_PRESET_META[presetKey];
          const isActive = saver.activePreset === presetKey;
          const isPending = saver.pendingPreset === presetKey;
          return (
            <div
              className={`home-edit-toolbar-preset-cell${
                isPending ? "has-pending-confirm" : ""
              }`}
              key={presetKey}
            >
              <button
                aria-checked={isActive}
                className={`home-edit-toolbar-preset-pill${
                  isActive ? "is-active" : ""
                }`}
                data-preset={presetKey}
                data-severity={meta.severityCls}
                onClick={() => saver.applyPreset(presetKey)}
                role="radio"
                tabIndex={rovingTabIndex(
                  isActive,
                  presetIndex,
                  saver.activePreset !== null
                )}
                title={tPresetDesc(presetKey)}
                type="button"
              >
                <span aria-hidden="true">{meta.icon}</span>
                <span>{tPresetLabel(presetKey)}</span>
              </button>
              {isPending && (
                <div
                  aria-label={t("confirm_aria")}
                  className="layout-editor-preset-confirm"
                  role="dialog"
                >
                  <p className="layout-editor-preset-confirm-text">
                    {t("confirm_text", { preset: tPresetLabel(presetKey) })}
                  </p>
                  <div className="layout-editor-preset-confirm-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => saver.applyPreset(presetKey, true)}
                      type="button"
                    >
                      {t("confirm_apply")}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={saver.cancelPendingPreset}
                      type="button"
                    >
                      {t("confirm_cancel")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="home-edit-toolbar-actions">
        <Link
          className="btn btn-ghost btn-sm"
          href="/dashboard/settings/layout"
        >
          {t("open_simple_editor")}
        </Link>
        <button
          className="btn btn-ghost btn-sm"
          disabled={saver.savingState === "saving"}
          onClick={saver.resetLayout}
          type="button"
        >
          {t("reset_button")}
        </button>
        <button
          className="btn btn-primary btn-sm"
          onClick={exitEditMode}
          type="button"
        >
          {t("done_button")}
        </button>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────
// Sortable wrapper around a single card in edit mode
// ─────────────────────────────────────────────

function SortableEditCard({
  id,
  hidden,
  isCallout,
  hasData,
  onToggleVisibility,
  children,
}: {
  id: DashboardCardId;
  hidden: boolean;
  isCallout: boolean;
  hasData: boolean;
  onToggleVisibility: () => void;
  children: ReactNode;
}) {
  const t = useTranslations("dashboard.layout_editor");
  const tCardLabel = useTranslations("dashboard.layout_editor.cards.labels");
  const tCardDesc = useTranslations(
    "dashboard.layout_editor.cards.descriptions"
  );
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const label = tCardLabel(id);
  const description = tCardDesc(id);
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
  };

  // Ghost variant — used for hidden first-class cards AND for callouts /
  // sections whose data predicate isn't met. Both still get a row so the
  // user can reorder them; first-class hidden rows get a "Show" button
  // so they can be restored, callouts/empties get an "Auto-managed"
  // pill instead.
  const showAsGhost = hidden || !hasData;
  const isFirstClassHidden = hidden && FIRST_CLASS_CARDS.has(id);
  const dragHandleAria = t("drag_handle_aria", { name: label });

  return (
    <div
      className={`home-edit-card${isDragging ? " is-dragging" : ""}${
        showAsGhost ? " is-ghost" : ""
      }${hidden ? " is-hidden" : ""}${isCallout ? " is-callout" : ""}`}
      data-card-id={id}
      ref={setNodeRef}
      style={style}
    >
      <div className="home-edit-card-bar">
        <button
          aria-label={dragHandleAria}
          className="home-edit-card-handle"
          type="button"
          {...attributes}
          {...listeners}
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>
        <span className="home-edit-card-label">{label}</span>
        <div className="home-edit-card-bar-actions">
          {isFirstClassHidden && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={onToggleVisibility}
              type="button"
            >
              {t("restore_button")}
            </button>
          )}
          {/* First-class cards always expose Hide while unhidden, even
              when their data predicate isn't currently met — users can
              preemptively mute a card so it stays hidden once it
              acquires data later (e.g. a stale section that's empty
              right now but will populate after the next sync drift). */}
          {!hidden && FIRST_CLASS_CARDS.has(id) && (
            <button
              aria-label={t("hide_card_aria", { name: label })}
              className="btn btn-ghost btn-sm"
              onClick={onToggleVisibility}
              title={t("hide_card_aria", { name: label })}
              type="button"
            >
              {t("hide_button")}
            </button>
          )}
          {isCallout && (
            <span
              className="layout-editor-auto-managed"
              title={t("auto_managed_title")}
            >
              {t("auto_managed_label")}
            </span>
          )}
        </div>
      </div>

      {/* Real card content (when present + visible). pointer-events: none
          so clicks inside don't fire the underlying interactive bits —
          users can read but not interact during edit mode. */}
      {!showAsGhost && <div className="home-edit-card-content">{children}</div>}

      {/* Ghost row — shown when the card is hidden OR its data predicate
          doesn't hold. Compact, with a short description so users know
          what they're reordering even when no actual content renders. */}
      {showAsGhost && (
        <div className="home-edit-card-ghost">
          <span className="home-edit-card-ghost-desc">{description}</span>
          {hidden && (
            <span className="home-edit-card-ghost-status">
              {t("ghost_hidden")}
            </span>
          )}
          {!(hidden || hasData) && (
            <span className="home-edit-card-ghost-status">
              {isCallout ? t("ghost_auto_managed") : t("ghost_no_data")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Footer link — opens the editable-layout settings page
// ─────────────────────────────────────────────

function LayoutEditorFooterLink() {
  const t = useTranslations("dashboard.layout_footer");
  return (
    <div className="home-layout-footer">
      <Link
        aria-label={t("customize_aria")}
        className="home-layout-footer-link"
        href="/dashboard?edit=layout"
      >
        {t("customize")}
      </Link>
      <span aria-hidden="true" className="home-layout-footer-sep">
        ·
      </span>
      <Link
        className="home-layout-footer-link home-layout-footer-secondary"
        href="/dashboard/settings/layout"
      >
        {t("simple_editor")}
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────
// Focus strip — compact "you chose X" header with link to Settings
// ─────────────────────────────────────────────

function FocusStrip({ intent }: { intent: UserIntent }) {
  const meta = INTENT_META[intent];
  // i18n: chrome copy from `dashboard.focus_strip.*`, intent label from
  // the shared `intent.<key>` namespace (one of the four legacy archetypes).
  // Icon stays sourced from INTENT_META — emoji is language-agnostic.
  const t = useTranslations("dashboard.focus_strip");
  const tIntent = useTranslations("intent");
  return (
    <div className="focus-strip" data-tour="focus-card" role="note">
      <span aria-hidden="true" className="focus-strip-icon">
        {meta.icon}
      </span>
      <div className="focus-strip-body">
        <div className="focus-strip-label">{t("label")}</div>
        <div className="focus-strip-value">{tIntent(intent)}</div>
      </div>
      <Link className="focus-strip-change" href="/dashboard/settings#focus">
        {t("change")}
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────
// Intent-specific callouts
// ─────────────────────────────────────────────

function CleanupCallout({ count }: { count: number }) {
  // i18n — quiet/alert bodies + the alert pluralised title +
  // the "Review high-risk apps →" link, all from `dashboard.callouts.*`.
  const tCallouts = useTranslations("dashboard.callouts");
  if (count === 0) {
    return (
      <div className="intent-callout intent-callout-quiet">
        <div className="intent-callout-title">
          {tCallouts("nothing_urgent_title")}
        </div>
        <p className="intent-callout-copy">
          {tCallouts("nothing_urgent_body")}
        </p>
      </div>
    );
  }
  return (
    <div className="intent-callout intent-callout-alert">
      <div className="intent-callout-title">
        {tCallouts("cleanup_title", { count })}
      </div>
      <p className="intent-callout-copy">{tCallouts("cleanup_body")}</p>
      <Link className="intent-callout-link" href="#higher-risk">
        {tCallouts("cleanup_link")}
      </Link>
    </div>
  );
}

function FamilyCallout({ count }: { count: number }) {
  const tCallouts = useTranslations("dashboard.callouts");
  return (
    <div className="intent-callout intent-callout-info">
      <div className="intent-callout-title">
        {tCallouts("looking_out_for_family_title")}
      </div>
      <p className="intent-callout-copy">
        {tCallouts("looking_out_for_family_body")}
        {count > 0 &&
          ` ${tCallouts("looking_out_for_family_count", { count })}`}
      </p>
    </div>
  );
}

function AgeRatingCallout({
  band,
  count,
}: {
  band: AgeBandKey;
  count: number;
}) {
  const tCallouts = useTranslations("dashboard.callouts");
  const tAgeBand = useTranslations("age_band");
  return (
    <div className="intent-callout intent-callout-warn">
      <div className="intent-callout-title">
        {tCallouts("age_rating_title", { count })}
      </div>
      <p className="intent-callout-copy">
        {tCallouts("age_rating_body", {
          count,
          band: tAgeBand(`labels.${band}`),
        })}
      </p>
      <Link className="intent-callout-link" href="/dashboard/apps?age=above">
        {tCallouts("age_rating_review_link")}
      </Link>{" "}
      <Link className="intent-callout-link" href="/help/parental-controls">
        {tCallouts("age_rating_resources_link")}
      </Link>
    </div>
  );
}

function ThirdPartyCallout({ triage }: { triage: TriageData }) {
  const stale = triage.staleCount;
  const tCallouts = useTranslations("dashboard.callouts");
  return (
    <div className="intent-callout intent-callout-info">
      <div className="intent-callout-title">
        {tCallouts("security_hygiene_title")}
      </div>
      <p className="intent-callout-copy">
        {tCallouts("security_hygiene_body")}
        {stale > 0 &&
          ` ${tCallouts("security_hygiene_stale", { count: stale })}`}
      </p>
      {stale > 0 && (
        <Link className="intent-callout-link" href="#stale-apps">
          {tCallouts("security_hygiene_jump")}
        </Link>
      )}
    </div>
  );
}

function DefinitionsCallout() {
  const tCallouts = useTranslations("dashboard.callouts");
  return (
    <div className="intent-callout intent-callout-quiet intent-callout-tall">
      <div className="intent-callout-title">
        {tCallouts("new_to_privacy_labels_title")}
      </div>
      <p className="intent-callout-copy">
        {tCallouts("new_to_privacy_labels_body")}
      </p>
      <Link
        className="intent-callout-link intent-callout-link-prominent"
        href="/help/definitions"
      >
        {tCallouts("definitions_link")}
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────
// Risk tier legend — reference panel explaining the risk pill
// ─────────────────────────────────────────────

/**
 * Four-tier legend matching the thresholds in lib/triage.ts (`riskLevel`).
 * Keep the thresholds in sync with that function — the copy here is the
 * user-facing version of the same rules. Examples are deliberately
 * generic (no named apps) because the user's library varies and we don't
 * want to editorialise about specific brands from the dashboard.
 */
const RISK_TIER_ENTRIES: Array<{
  key: TriageApp["riskLevel"];
  label: string;
  rule: string;
  meaning: string;
  example: string;
}> = [
  {
    key: "high",
    label: "High risk",
    rule: 'At least one data type declared as "Data Used to Track You".',
    meaning:
      "The developer reports that the app or its partners can use this data to recognize you outside the app — usually for advertising, measurement, retargeting, or data brokers.",
    example:
      "Typical of large social networks and ad-supported free apps that share identifiers with data brokers.",
  },
  {
    key: "moderate",
    label: "Moderate risk",
    rule: "No cross-app tracking, but three or more data types linked to your identity.",
    meaning:
      "The app ties a lot of data to your account. It stays inside the app, but the developer still holds a rich profile of you.",
    example:
      "Typical of banking, shopping, streaming and communication apps where a lot is tied to your sign-in.",
  },
  {
    key: "low",
    label: "Low risk",
    rule: "Some data collected, but only a small amount is linked to your identity.",
    meaning:
      "The app collects something — often diagnostics, optional usage stats, or a single linked category — without building a full profile.",
    example:
      "Typical of light-touch utilities, calculators, or reference apps that collect a crash log or optional analytics.",
  },
  {
    key: "minimal",
    label: "Minimal",
    rule: "The developer declares no data collection at all.",
    meaning:
      "Apple's privacy labels show an empty sheet. Nothing the app says it collects, linked or otherwise.",
    example:
      "Typical of single-player offline games, simple reference tools, and some privacy-focused utilities.",
  },
];

/**
 * Promo card pointing first-time users at /dashboard/manual-apps. Pulled
 * out of HomeView's render so the translation hook can live inside the
 * component without complicating the parent's hook layout.
 */
function ManualAppsBanner({
  onDismiss,
  dismissing,
}: {
  onDismiss: () => void;
  dismissing: boolean;
}) {
  const t = useTranslations("dashboard.manual_apps_banner");
  return (
    <div className="manual-apps-banner" role="note">
      <div aria-hidden="true" className="manual-apps-banner-icon">
        🔖
      </div>
      <div className="manual-apps-banner-body">
        <div className="manual-apps-banner-title">{t("title")}</div>
        <p className="manual-apps-banner-copy">{t("body")}</p>
      </div>
      <div className="manual-apps-banner-actions">
        <Link className="btn btn-primary btn-sm" href="/dashboard/manual-apps">
          {t("set_them_up")}
        </Link>
        <button
          className="btn btn-ghost btn-sm"
          disabled={dismissing}
          onClick={onDismiss}
          type="button"
        >
          {t("dismiss")}
        </button>
      </div>
    </div>
  );
}

function RiskTierLegend({ id }: { id: string }) {
  // i18n — legend chrome from `dashboard.risk_tier_legend.*`, the four
  // tier explainer cards from `dashboard.risk_tiers.${key}_{rule|meaning|example}`,
  // and the pill labels themselves from the shared `risk.*_label`
  // namespace so the legend pill matches the per-card pill verbatim.
  const t = useTranslations("dashboard.risk_tier_legend");
  const tTier = useTranslations("dashboard.risk_tiers");
  const tRisk = useTranslations("risk");
  return (
    <section className="home-section home-section-legend" id={id}>
      <details className="risk-tier-legend">
        <summary className="risk-tier-legend-summary">
          <span className="risk-tier-legend-kicker">{t("kicker")}</span>
          <span className="risk-tier-legend-hint">{t("hint")}</span>
        </summary>
        <p className="risk-tier-legend-intro">{t("intro")}</p>
        <div className="risk-tier-grid">
          {RISK_TIER_ENTRIES.map((tier) => (
            <div
              className={`risk-tier-card risk-tier-${tier.key}`}
              key={tier.key}
            >
              <div className="risk-tier-card-head">
                <span className={`risk-pill ${RISK_CLS[tier.key]}`}>
                  {tRisk(`${tier.key}_label`)}
                </span>
              </div>
              <div className="risk-tier-card-rule">
                {tTier(`${tier.key}_rule`)}
              </div>
              <p className="risk-tier-card-meaning">
                {tTier(`${tier.key}_meaning`)}
              </p>
              <p className="risk-tier-card-example">
                <span className="risk-tier-card-example-kicker">
                  {t("example_kicker")}
                </span>
                {tTier(`${tier.key}_example`)}
              </p>
            </div>
          ))}
        </div>
        <p className="risk-tier-legend-footer">{t("footer")}</p>
      </details>
    </section>
  );
}

// ─────────────────────────────────────────────
// Hero — either "quiet state" or "heads up"
// ─────────────────────────────────────────────

function Hero({
  triage,
  headsUps,
  onSyncAll,
  syncing,
}: {
  triage: TriageData;
  headsUps: { key: string; label: string; cls: string; href: string }[];
  onSyncAll: () => void;
  syncing: boolean;
}) {
  // i18n: hero structural strings (title, action buttons, links) plus
  // the rich `<strong>{apps}</strong>` / `<strong>{categories}</strong>` /
  // `<strong>{relative}</strong>` interpolations on the quiet variant.
  // Both bundles include the rich-tag markup so `t.rich` resolves them
  // identically; the `chunks => <strong>{chunks}</strong>` callback at
  // each call site is what makes the emphasis render in either locale.
  const tHero = useTranslations("dashboard.hero");
  const tRel = useTranslations("dashboard.relative_time");
  if (triage.quiet) {
    return (
      <section className="home-hero home-hero-quiet">
        <div aria-hidden="true" className="home-hero-icon home-hero-icon-quiet">
          ✓
        </div>
        <div className="home-hero-body">
          <h1 className="home-hero-title">{tHero("nothing_new")}</h1>
          <p className="home-hero-copy">
            {tHero.rich("quiet_tracking", {
              strong: (chunks) => <strong>{chunks}</strong>,
              apps: tHero("quiet_n_apps", { count: triage.totalApps }),
              categories: tHero("quiet_n_categories", {
                count: triage.totalCategories,
              }),
            })}
            {triage.lastSyncedAt > 0 && (
              <>
                {" "}
                {tHero.rich("quiet_last_refreshed", {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  relative: relativeTime(tRel, triage.lastSyncedAt),
                })}
              </>
            )}
          </p>
          <div className="home-hero-actions">
            <button
              className="btn btn-secondary"
              disabled={syncing}
              onClick={onSyncAll}
              type="button"
            >
              {syncing ? <span className="spinner" /> : "↻"}
              {syncing ? tHero("syncing") : tHero("resync_now")}
            </button>
            <Link className="btn btn-ghost" href="/dashboard/apps">
              {tHero("view_all_apps")} →
            </Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="home-hero home-hero-attention">
      <div
        aria-hidden="true"
        className="home-hero-icon home-hero-icon-attention"
      >
        ⚡
      </div>
      <div className="home-hero-body">
        <h1 className="home-hero-title">
          {tHero("needs_attention_title", { count: headsUps.length })}
        </h1>
        <ul className="home-headsup-list">
          {headsUps.map((item) => (
            <li className={`home-headsup-item ${item.cls}`} key={item.key}>
              <a
                className="home-headsup-link"
                href={item.href}
                onClick={(e) => handleHashClick(e, item.href)}
              >
                {item.label}
                <span aria-hidden="true" className="home-headsup-arrow">
                  ↓
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Changes to review
// ─────────────────────────────────────────────

/**
 * Build a dynamic subtitle phrase that reflects which kinds of changes
 * are actually in the current reviewable set. Examples:
 *
 *   only privacy-label             → "privacy labels"
 *   only accessibility             → "accessibility labels"
 *   privacy-label + accessibility  → "privacy and accessibility labels"
 *   all three                      → "privacy labels, accessibility labels, or privacy policies"
 *
 * We collapse the common "privacy labels + accessibility labels" pairing
 * into "privacy and accessibility labels" because the word "labels"
 * duplicates otherwise. Falls back to the safe generic "privacy labels"
 * phrasing when the category set is empty — e.g. pre-migration rows that
 * were written before categories were tracked at all.
 *
 * Translator-typed first arg keeps the helper locale-aware while staying
 * out of React's hook ordering — call sites already have `tReviewSummary`
 * in scope from the parent component.
 */
type ReviewSummaryT = (key: string) => string;

function buildReviewableSummaryPhrase(
  t: ReviewSummaryT,
  reviewable: ReviewableApp[]
): string {
  const present = new Set<ReviewableChangeCategory>();
  for (const app of reviewable) {
    for (const c of app.categories) {
      present.add(c);
    }
  }

  const hasLabel = present.has("privacy-label");
  const hasA11y = present.has("accessibility");
  const hasPolicy = present.has("privacy-policy");

  // Common pairings get a tighter phrasing so the sentence doesn't read
  // like a checklist. The "privacy + accessibility labels" pairing was
  // the one the original copy specifically asked for.
  if (hasLabel && hasA11y && !hasPolicy) {
    return t("privacy_and_accessibility_labels");
  }
  if (hasLabel && hasPolicy && !hasA11y) {
    return t("privacy_labels_or_policies");
  }
  if (hasA11y && hasPolicy && !hasLabel) {
    return t("accessibility_or_policies");
  }
  if (hasLabel && hasA11y && hasPolicy) {
    return t("all_three");
  }

  // Singletons — or the empty fallback, which reads the same as the
  // legacy "privacy labels" copy so pre-migration installs keep their
  // wording.
  if (hasA11y) {
    return t("accessibility_labels");
  }
  if (hasPolicy) {
    return t("privacy_policies");
  }
  return t("privacy_labels");
}

function ReviewSection({
  id,
  reviewable,
}: {
  id: string;
  reviewable: ReviewableApp[];
}) {
  const tSections = useTranslations("dashboard.sections");
  const tRowMeta = useTranslations("dashboard.row_meta");
  const tRisk = useTranslations("risk");
  const tRel = useTranslations("dashboard.relative_time");
  const tReviewSummary = useTranslations("dashboard.review_summary");
  const summaryPhrase = buildReviewableSummaryPhrase(
    tReviewSummary,
    reviewable
  );
  return (
    <section className="home-section home-section-review" id={id}>
      <div className="home-section-header">
        <h2 className="home-section-title">
          <span className="home-section-kicker">
            {tSections("review_kicker")}
          </span>
        </h2>
        <p className="home-section-sub">
          {tSections("review_sub", {
            summary: summaryPhrase,
            count: reviewable.length,
          })}
        </p>
      </div>

      <div className="home-row-list">
        {reviewable.map((app) => {
          // If the only change we detected on this scrape was an
          // accessibility-label update, suppress the privacy-risk pill.
          // The pill is derived from privacy labels alone (tracking /
          // linked / unlinked counts) so rendering it next to an
          // accessibility-only change reads as editorial about the
          // change, which is misleading. Instead we swap in a neutral
          // "Accessibility" pill so the row doesn't lose its trailing
          // chip (which keeps the grid visually aligned). Rows with
          // mixed categories — e.g. accessibility + privacy-label — keep
          // the risk pill because the privacy posture *is* relevant.
          const isAccessibilityOnly =
            app.categories.length === 1 &&
            app.categories[0] === "accessibility";
          return (
            <Link
              className="home-row home-row-review"
              href={`/apps/${app.id}#what-changed`}
              key={app.id}
            >
              <AppIcon app={app} size={44} />
              <div className="home-row-body">
                <div className="home-row-title">{app.name}</div>
                <div className="home-row-sub">
                  {app.changeCount} change{app.changeCount === 1 ? "" : "s"} ·{" "}
                  {relativeTime(tRel, app.lastChangeAt)}
                  {app.topChange && (
                    <span className="home-row-topchange">
                      {" "}
                      · {app.topChange}
                    </span>
                  )}
                </div>
              </div>
              {isAccessibilityOnly ? (
                <span
                  className="risk-pill risk-pill-accessibility"
                  title={tRowMeta("accessibility_only_change_tooltip")}
                >
                  {tRowMeta("accessibility_chip")}
                </span>
              ) : (
                <span className={`risk-pill ${RISK_CLS[app.riskLevel]}`}>
                  {tRisk(`${app.riskLevel}_label`)}
                </span>
              )}
              <span aria-hidden="true" className="home-row-arrow">
                →
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Consider replacing (privacy-profile mismatches)
//
// Purely opt-in — only renders when the user has a privacy profile set AND
// at least one app exceeds it. Rows are already sorted worst-first on the
// server (by totalGap desc), so the first few entries are the most-egregious
// mismatches. Each row deep-links to the app's detail page so the user can
// decide whether to delete / replace it.
// ─────────────────────────────────────────────

function ConsiderReplacingSection({
  id,
  apps,
}: {
  id: string;
  apps: AppMismatchSummary[];
}) {
  const tCategory = useTranslations("category");
  const tTier = useTranslations("privacy_profile_tier_short");
  const tMismatch = useTranslations("privacy_profile_mismatch_sentence");
  const tBadge = useTranslations("profile_badge");
  const tSections = useTranslations("dashboard.sections");
  // Cap the visible list to keep the section scannable. Users with many
  // mismatches get a "see all" footer that routes to the apps grid with
  // the "bad match" filter implicitly applied via the badge (which is now
  // present on every card).
  const MAX_VISIBLE = 6;
  const visible = apps.slice(0, MAX_VISIBLE);
  const hidden = Math.max(0, apps.length - visible.length);

  return (
    <section className="home-section profile-replace-section" id={id}>
      <div className="profile-replace-section-title">
        <span aria-hidden>🛡</span>
        Consider replacing
        <span className="home-section-count" style={{ marginLeft: 6 }}>
          {apps.length} app{apps.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="profile-replace-section-subtitle">
        These apps go further than your privacy profile allows. Open one to see
        which categories mismatch, and decide whether to keep, replace, or
        delete.
      </p>

      <div className="profile-replace-list">
        {visible.map((entry) => {
          const top = entry.mismatch.mismatches[0];
          // Fallback description in the (practically impossible) case where
          // the mismatch array is empty — we only surface apps with count>0,
          // so the localised mismatch helper should rarely return null.
          const desc =
            describeWorstMismatchLocalised(
              entry.mismatch,
              (key) => i18nCategoryLabel(tCategory, key),
              (key) => tTier(key),
              (key, values) => tMismatch(key, values)
            ) ??
            tBadge("mismatches_description", { count: entry.mismatch.count });
          // The tier chip colour mirrors the worst observed tier. We reuse
          // the existing severity-* classes from globals.css (via TIER_META)
          // so the palette stays consistent with every other privacy surface.
          const tierCls = top ? TIER_META[top.observed].severityCls : "";
          const topCategory = top
            ? (CATEGORY_META[top.category]?.icon ?? "•")
            : "•";
          return (
            <Link
              className="profile-replace-row"
              href={`/apps/${entry.appId}`}
              key={entry.appId}
              title={tSections("open_app_title", { name: entry.appName })}
            >
              {entry.iconUrl ? (
                <Image
                  alt=""
                  className="profile-replace-row-icon"
                  height={36}
                  src={entry.iconUrl}
                  style={{ objectFit: "cover" }}
                  unoptimized
                  width={36}
                />
              ) : (
                <div aria-hidden className="profile-replace-row-icon">
                  <span style={{ fontSize: 22 }}>{topCategory}</span>
                </div>
              )}
              <div className="profile-replace-row-body">
                <div className="profile-replace-row-name">{entry.appName}</div>
                <div className="profile-replace-row-desc">{desc}</div>
              </div>
              {tierCls && (
                <span aria-hidden className={`risk-chip ${tierCls}`}>
                  {top ? <PrivacyTypeIcon tier={top.observed} /> : null}
                </span>
              )}
              <span className="profile-replace-row-count">
                {entry.mismatch.count} mismatch
                {entry.mismatch.count === 1 ? "" : "es"}
              </span>
            </Link>
          );
        })}
      </div>

      {hidden > 0 && (
        <p className="settings-field-help" style={{ marginTop: 10 }}>
          +{hidden} more on the{" "}
          <Link className="welcome-link" href="/dashboard/apps">
            apps page
          </Link>{" "}
          (look for the warning badge).
        </p>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Higher-risk apps
// ─────────────────────────────────────────────

function RiskSection({
  id,
  apps,
  variant = "default",
}: {
  id: string;
  apps: TriageApp[];
  /** Intent-driven wording. `cleanup` frames this as a delete-list, `family`
   *  frames it as a review-with-kids list, `default` is the neutral watchlist. */
  variant?: "default" | "cleanup" | "family";
}) {
  const tSections = useTranslations("dashboard.sections");
  const tRisk = useTranslations("risk");
  const kicker =
    variant === "cleanup"
      ? tSections("cleanup_kicker")
      : variant === "family"
        ? tSections("family_kicker")
        : tSections("watchlist_kicker");
  const sub =
    variant === "cleanup"
      ? tSections("cleanup_sub")
      : variant === "family"
        ? tSections("family_sub")
        : tSections("watchlist_sub");
  return (
    <section
      className="home-section home-section-risk home-section-watchlist"
      id={id}
    >
      <div className="home-section-header">
        <h2 className="home-section-title">
          <span className="home-section-kicker">{kicker}</span>
          <span className="home-section-count">
            {tSections("watchlist_count", { count: apps.length })}
          </span>
        </h2>
        <p className="home-section-sub">{sub}</p>
      </div>

      <div className="home-row-list">
        {apps.map((app) => (
          <Link
            className="home-row home-row-risk"
            href={`/apps/${app.id}`}
            key={app.id}
          >
            <AppIcon app={app} size={40} />
            <div className="home-row-body">
              <div className="home-row-title">{app.name}</div>
              <div className="home-row-sub">
                {app.unlinkedCount > 0 && (
                  <span className="home-row-chip home-row-chip-unlinked">
                    <PrivacyTypeIcon tier="not_linked" />
                    {app.unlinkedCount} unlinked
                  </span>
                )}
                {app.linkedCount > 0 && (
                  <span className="home-row-chip home-row-chip-linked">
                    <PrivacyTypeIcon tier="linked" />
                    {app.linkedCount} linked
                  </span>
                )}
                {app.trackCount > 0 && (
                  <span className="home-row-chip home-row-chip-track">
                    <PrivacyTypeIcon tier="tracking" />
                    {app.trackCount} track
                  </span>
                )}
              </div>
            </div>
            <span className={`risk-pill ${RISK_CLS[app.riskLevel]}`}>
              {tRisk(`${app.riskLevel}_label`)}
            </span>
            <span aria-hidden="true" className="home-row-arrow">
              →
            </span>
          </Link>
        ))}
      </div>

      <div className="home-section-footer">
        <Link className="btn btn-ghost btn-sm" href="/dashboard/apps">
          See all apps sorted by risk →
        </Link>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Stale apps
// ─────────────────────────────────────────────

function StaleSection({
  id,
  apps,
  elevated = false,
}: {
  id: string;
  apps: TriageApp[];
  /** Hygiene mode elevates this with a distinct colour so stale-policy health
   *  gets the user's attention. */
  elevated?: boolean;
}) {
  const tSections = useTranslations("dashboard.sections");
  const tRowMeta = useTranslations("dashboard.row_meta");
  const tRel = useTranslations("dashboard.relative_time");
  return (
    <section
      className={`home-section home-section-stale${elevated ? " home-section-stale-elevated" : ""}`}
      id={id}
    >
      <div className="home-section-header">
        <h2 className="home-section-title">
          <span className="home-section-kicker">
            {tSections("stale_kicker")}
          </span>
        </h2>
        <p className="home-section-sub">
          {elevated
            ? tSections("stale_sub_elevated")
            : tSections("stale_sub_short")}
        </p>
      </div>

      <div className="home-row-list">
        {apps.map((app) => (
          <Link
            className="home-row home-row-stale"
            href={`/apps/${app.id}`}
            key={app.id}
          >
            <AppIcon app={app} size={40} />
            <div className="home-row-body">
              <div className="home-row-title">{app.name}</div>
              <div className="home-row-sub">
                {tRowMeta("last_synced", {
                  relative: relativeTime(tRel, app.lastSynced),
                })}
              </div>
            </div>
            <span aria-hidden="true" className="home-row-arrow">
              →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Recent activity feed
// ─────────────────────────────────────────────

function ActivitySection({ activity }: { activity: RecentActivityEntry[] }) {
  const tSections = useTranslations("dashboard.sections");
  const tRel = useTranslations("dashboard.relative_time");
  return (
    <section className="home-section home-section-activity">
      <div className="home-section-header">
        <h2 className="home-section-title">
          <span className="home-section-kicker">
            {tSections("activity_kicker")}
          </span>
        </h2>
      </div>
      <ul className="home-activity-list">
        {activity.map((a, i) => (
          <li className="home-activity-item" key={`${a.appId}-${i}`}>
            <AppIcon
              app={{ iconUrl: a.iconUrl, name: a.appName }}
              className="home-activity-icon"
              size={28}
            />
            <div className="home-activity-body">
              <Link
                className="home-activity-app"
                href={`/apps/${a.appId}#what-changed`}
              >
                {a.appName}
              </Link>
              <span className="home-activity-meta">
                {a.addedCount > 0 && (
                  <span className="home-activity-added">+{a.addedCount}</span>
                )}
                {a.removedCount > 0 && (
                  <span className="home-activity-removed">
                    −{a.removedCount}
                  </span>
                )}
                {a.modifiedCount > 0 && (
                  <span className="home-activity-modified">
                    ✎{a.modifiedCount}
                  </span>
                )}
                {a.topChange && (
                  <span className="home-activity-top"> · {a.topChange}</span>
                )}
              </span>
            </div>
            <span className="home-activity-date">
              {relativeTime(tRel, a.scrapedAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: At-a-glance stats
// ─────────────────────────────────────────────

function GlanceSection({ triage }: { triage: TriageData }) {
  const t = useTranslations("dashboard.glance");
  const hasChanges = triage.changesThisWeek > 0;
  return (
    <section className="home-section home-section-glance">
      <div className="home-glance-grid">
        <GlanceStat
          href="/dashboard/apps"
          label={t("apps_tracked")}
          subtitle={t("apps_tracked_sub")}
          value={triage.totalApps}
        />
        <GlanceStat
          href="/dashboard/privacy"
          label={t("categories")}
          subtitle={t("categories_sub")}
          value={triage.totalCategories}
        />
        <GlanceStat
          href={
            triage.highRiskCount > 0
              ? "/dashboard/apps?risk=high"
              : "/dashboard/apps"
          }
          label={t("high_risk")}
          subtitle={
            triage.highRiskCount > 0
              ? t("high_risk_sub_some")
              : t("high_risk_sub_none")
          }
          tone={triage.highRiskCount > 0 ? "warn" : "ok"}
          value={triage.highRiskCount}
        />
        <GlanceStat
          href={hasChanges ? "#changes-to-review" : "/dashboard/stats"}
          label={t("changes_week")}
          subtitle={
            hasChanges ? t("changes_week_sub_some") : t("changes_week_sub_none")
          }
          tone={hasChanges ? "warn" : "ok"}
          value={triage.changesThisWeek}
        />
      </div>
    </section>
  );
}

function GlanceStat({
  label,
  value,
  tone = "neutral",
  href,
  subtitle,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "neutral";
  href?: string;
  subtitle?: string;
}) {
  const content = (
    <>
      <div className="home-glance-value">{value}</div>
      <div className="home-glance-label">{label}</div>
      {subtitle && <div className="home-glance-sub">{subtitle}</div>}
      {href && (
        <span aria-hidden="true" className="home-glance-arrow">
          →
        </span>
      )}
    </>
  );

  if (href?.startsWith("#")) {
    return (
      <a
        className={`home-glance-stat home-glance-${tone} home-glance-link`}
        href={href}
        onClick={(e) => handleHashClick(e, href)}
      >
        {content}
      </a>
    );
  }
  if (href) {
    return (
      <Link
        className={`home-glance-stat home-glance-${tone} home-glance-link`}
        href={href}
      >
        {content}
      </Link>
    );
  }
  return (
    <div className={`home-glance-stat home-glance-${tone}`}>{content}</div>
  );
}

// ─────────────────────────────────────────────
// App icon helper
// ─────────────────────────────────────────────

function AppIcon({
  app,
  size,
  className = "",
}: {
  app: { iconUrl?: string; name: string };
  size: number;
  className?: string;
}) {
  if (app.iconUrl) {
    return (
      <Image
        alt=""
        className={`home-app-icon ${className}`}
        height={size}
        src={app.iconUrl}
        style={{ objectFit: "cover", borderRadius: Math.round(size * 0.22) }}
        unoptimized
        width={size}
      />
    );
  }
  return (
    <div
      className={`home-app-icon home-app-icon-placeholder ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
        fontSize: Math.round(size * 0.4),
      }}
    >
      {app.name[0]}
    </div>
  );
}

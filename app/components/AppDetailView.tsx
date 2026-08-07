"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useModalFocus } from "../../lib/use-modal-focus";

// AnnotationsSidebar is loaded lazily — it pulls in `marked` (~30kb), so
// only ship that to App Detail clients when the flag is on. Audience-aware
// initial-expansion + sessionStorage state happens inside the component.
const AnnotationsSidebar = dynamic(() => import("./AnnotationsSidebar"), {
  ssr: false,
});

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type {
  AccessibilityPreference,
  AccessibilityProfile,
} from "../../lib/accessibility-profile";
import {
  CANONICAL_ACCESSIBILITY_FEATURES,
  type CanonicalAccessibilityFeature,
} from "../../lib/accessibility-types";
import { type AgeBandKey, compareRatingToBand } from "../../lib/age-rating";
import type {
  ChangeEntry,
  ChangelogRow,
  ReviewAction,
  SnoozeDays,
  UnacknowledgedChangeEvent,
  UnacknowledgedChanges,
} from "../../lib/changelog-types";
import { SNOOZE_DAYS_OPTIONS } from "../../lib/changelog-types";
import { formatDate as formatDateWithMode } from "../../lib/date-format";
import { useDateFormat } from "../../lib/date-format-hook";
import {
  categoryDescription as i18nCategoryDescription,
  categoryLabel as i18nCategoryLabel,
  severityDescription as i18nSeverityDescription,
  severityLabel as i18nSeverityLabel,
} from "../../lib/i18n-meta";
import { formatPriceLine, priceTooltip } from "../../lib/price-display";
import {
  CATEGORY_META,
  SEVERITY_CONFIG,
  sortPrivacyTypesForDisplay,
} from "../../lib/privacy-meta";
import {
  type PrivacyProfile,
  TIER_RANK,
  TYPE_IDENTIFIER_TO_TIER,
} from "../../lib/privacy-profile";
import { isSafeExternalHref } from "../../lib/safe-href";
import { TOAST_HOLD_MS } from "../../lib/toast-timing";
import type { AppVerdict } from "../../lib/verdict-types";
import AppDevicesPanel from "./AppDevicesPanel";
import ChangelogTimeline from "./ChangelogTimeline";
import CompareAppsView from "./CompareAppsView";
import PolicySummaryPanel from "./detail/PolicySummaryPanel";
import type { App, PrivacyType, RecentPolicyChangeHint } from "./detail/types";
import InfoTooltip from "./InfoTooltip";
import { getLastNonAppPath } from "./NavigationHistoryTracker";
import PrivacyTypeIcon from "./PrivacyTypeIcon";
import RateLimitBanner from "./RateLimitBanner";
import SinceInstallCard from "./SinceInstallCard";
import { useTaskCenter } from "./TaskCenter";
import Toast from "./Toast";
import VerdictPicker from "./VerdictPicker";

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Heuristic: is this app authored by Apple (i.e. a built-in / first-party
 * app like Messages, Maps, Safari, Mail, Health, Wallet)? Apple uses a
 * handful of publisher strings on the App Store — match them case-insensitively
 * with a leading anchor so we don't false-positive on third-party devs whose
 * name happens to contain "Apple" (e.g. "Pineapple Studios").
 */
function isAppleBuiltInApp(developer: string | undefined | null): boolean {
  if (!developer) {
    return false;
  }
  const d = developer.trim().toLowerCase();
  return (
    d === "apple" ||
    d === "apple inc." ||
    d === "apple inc" ||
    d.startsWith("apple distribution") ||
    d.startsWith("apple ")
  );
}

// ── Main component ────────────────────────────────────────────────────

// Re-exported for back-compat: this type lived (exported) in this file
// before the detail/ split.
export type { AccessibilityFeatureProp } from "./detail/types";

type Tab = "privacy" | "accessibility" | "changelog" | "policy" | "compare";

/**
 * Shape of the `importProvenance` prop passed down from the server — mirrors
 * `AppImportProvenance` in `lib/imports.ts` but redeclared here so the client
 * bundle doesn't reach into the server-only `lib/imports` module (which
 * imports `better-sqlite3` via `lib/db`). Next.js's bundler would flag the
 * transitive import even with `import type`, so we keep a plain shape here.
 */
export interface AppImportProvenanceProp {
  importedAt: number;
  importId: string;
  item: {
    id: string;
    query: string;
    editedQuery: string | null;
    status:
      | "matched"
      | "unmatched"
      | "skipped"
      | "imported"
      | "error"
      | "pending_search"
      | "queued"
      | "removed";
  };
  source: "screenshots" | "file" | "manual";
  sourceLabel: string | null;
}

/**
 * Resolved detail-flag values from the server. Wave F widens this from the
 * annotations sidebar to cover every major App Detail section. Each entry
 * is a 'on' | 'off' boolean (or 'collapsed' for the few that support it);
 * legacy callers that don't pass the prop keep their pre-flag behaviour
 * because every consumer falls back to "true" / "on" when the value is
 * missing.
 */
export interface DetailFlagState {
  // Accessibility tab
  a11yPanel: boolean;
  a11yPreferenceHighlights: boolean;
  actionsDeleteButton: boolean;
  // Actions
  actionsResyncButton: boolean;
  annotationsSidebar: "on" | "off" | "collapsed";
  /** Server-resolved focus.audience — drives audience-specific copy + behaviour. */
  audience: "self" | "loved_one" | "guardian";
  // Charts (under timeline)
  chartsCategoryTrend: boolean;
  chartsTrendLegend: boolean;
  chartsTrendPresets: boolean;
  // Footer
  footerImportProvenance: boolean;
  /** flag.guardian.age_rating — header age-rating verdict chip. */
  guardianAgeRating: boolean;
  headerA11yCountChip: boolean;
  headerChangeCountBadge: boolean;
  // Header
  headerFreshnessBadge: boolean;
  // Privacy labels
  labelsCards: boolean;
  labelsNoDetailsWarning: boolean;
  labelsProfileMismatchBadges: boolean;
  policyAiSummary: boolean;
  policyAiSummaryDisclaimer: boolean;
  policyChangeStrip: boolean;
  policyChunkNotes: boolean;
  policyFallbackReferences: boolean;
  policyHighlights: boolean;
  policyLensGrid: boolean;
  // Policy tab
  policyPanel: boolean;
  policyPreviewToggle: boolean;
  policyRecentChangeBanner: boolean;
  policyRescrapeButton: boolean;
  policyRescrapeSummariseButton: boolean;
  policyRunLogDetails: boolean;
  policyRunLogStrip: boolean;
  policySafetySummary: boolean;
  policySourcePolicyLink: boolean;
  policySummariseButton: boolean;
  policyWaybackBackupLink: boolean;
  policyWhatsNew: boolean;
  reviewDismiss: boolean;
  reviewMarkReviewed: boolean;
  // Change review
  reviewPanel: boolean;
  reviewSnoozedPanel: boolean;
  reviewSnoozeMenu: boolean;
  // Tabs
  tabsCompare: boolean;
  // Timeline (Change History tab)
  timelineLiveRows: boolean;
  timelineMatchesLiveSyncBadge: boolean;
  timelinePolicyDiffToggle: boolean;
  timelinePolicyPreviewToggle: boolean;
  timelineReviewRows: boolean;
  timelineReviewSnapshotChips: boolean;
  timelineTriggerPills: boolean;
  timelineVersionChip: boolean;
  timelineWaybackRows: boolean;
  timelineWaybackToggle: boolean;
}

export default function AppDetailView({
  app,
  changelog,
  unacknowledged,
  aiProvider,
  recentPolicyChange,
  policyDiffAlertDays,
  privacyProfile,
  a11yProfile = null,
  waybackShowImportedDefault = true,
  importProvenance = null,
  trackAccessibility = true,
  childAgeBand = null,
  detailFlags,
}: {
  app: App;
  changelog: ChangelogRow[];
  unacknowledged: UnacknowledgedChanges;
  aiProvider: string;
  /** Banner hint from the server; null when no recent change / banner disabled. */
  recentPolicyChange?: RecentPolicyChangeHint | null;
  /** Window (days) currently configured in Settings; used in the banner copy. */
  policyDiffAlertDays?: number;
  /**
   * The user's saved privacy profile (category → max tolerated tier). When
   * non-null, cells whose observed tier exceeds the profile's threshold get
   * a red "mismatch" border so the reason the app is flagged is obvious at
   * a glance. `null` disables the highlighting entirely.
   */
  privacyProfile?: PrivacyProfile | null;
  /**
   * Saved accessibility profile (feature identifier → 'required' | 'nice').
   * When non-null, the accessibility tab renders a preference key at the
   * top and puts a teal border around feature rows the user cares about.
   * `null` preserves the pre-profile rendering.
   */
  a11yProfile?: AccessibilityProfile | null;
  /**
   * Initial state for the timeline's "show Wayback imports" toggle, sourced
   * from the `wayback_show_imported` app setting. The per-page checkbox can
   * still flip it locally without re-saving the user's global preference.
   */
  waybackShowImportedDefault?: boolean;
  /**
   * Source import-item + batch for this app. Null when no history row is on
   * file (legacy import, or the app entered via a code path that bypasses
   * the onboarding wizard). The footer at the bottom of the page uses this
   * to show "imported on …" plus a "fix match" deep-link into Import History.
   */
  importProvenance?: AppImportProvenanceProp | null;
  /**
   * Server-hydrated value of the `track_accessibility_labels` setting. When
   * `false`, the accessibility chip, tab, and everything gated on it are
   * hidden — even on apps that do declare features — so users who turned
   * the feature off in Settings don't see residual UI.
   */
  trackAccessibility?: boolean;
  /**
   * Guardian child age band — drives the age-rating verdict chip in the
   * header. Null hides the verdict (the neutral rating chip still shows).
   */
  childAgeBand?: AgeBandKey | null;
  /**
   * Resolved feature flags relevant to this surface. Round 3 PR 4 wires
   * only the annotations-sidebar gate + audience; subsequent PRs add more.
   */
  detailFlags?: DetailFlagState;
}) {
  // Round 3 wave F: effective flag values with "all-on" defaults so this
  // component still renders correctly when callers haven't been wired yet.
  const f = {
    annotationsSidebar: detailFlags?.annotationsSidebar ?? "collapsed",
    audience: detailFlags?.audience ?? "self",
    // FALSE default — new guarded surface, un-wired callers stay unchanged.
    guardianAgeRating: detailFlags?.guardianAgeRating ?? false,
    headerFreshnessBadge: detailFlags?.headerFreshnessBadge ?? true,
    headerChangeCountBadge: detailFlags?.headerChangeCountBadge ?? true,
    headerA11yCountChip: detailFlags?.headerA11yCountChip ?? true,
    tabsCompare: detailFlags?.tabsCompare ?? true,
    actionsResyncButton: detailFlags?.actionsResyncButton ?? true,
    actionsDeleteButton: detailFlags?.actionsDeleteButton ?? true,
    footerImportProvenance: detailFlags?.footerImportProvenance ?? true,
    labelsCards: detailFlags?.labelsCards ?? true,
    labelsProfileMismatchBadges:
      detailFlags?.labelsProfileMismatchBadges ?? true,
    labelsNoDetailsWarning: detailFlags?.labelsNoDetailsWarning ?? true,
    policyPanel: detailFlags?.policyPanel ?? true,
    policyAiSummary: detailFlags?.policyAiSummary ?? true,
    policyLensGrid: detailFlags?.policyLensGrid ?? true,
    policySafetySummary: detailFlags?.policySafetySummary ?? false,
    policyHighlights: detailFlags?.policyHighlights ?? true,
    policyChangeStrip: detailFlags?.policyChangeStrip ?? true,
    policyChunkNotes: detailFlags?.policyChunkNotes ?? true,
    policyRunLogStrip: detailFlags?.policyRunLogStrip ?? true,
    policyRunLogDetails: detailFlags?.policyRunLogDetails ?? true,
    policyFallbackReferences: detailFlags?.policyFallbackReferences ?? true,
    policyWaybackBackupLink: detailFlags?.policyWaybackBackupLink ?? true,
    policySourcePolicyLink: detailFlags?.policySourcePolicyLink ?? true,
    policyRecentChangeBanner: detailFlags?.policyRecentChangeBanner ?? true,
    policyWhatsNew: detailFlags?.policyWhatsNew ?? true,
    policyRescrapeButton: detailFlags?.policyRescrapeButton ?? true,
    policySummariseButton: detailFlags?.policySummariseButton ?? true,
    policyRescrapeSummariseButton:
      detailFlags?.policyRescrapeSummariseButton ?? true,
    policyPreviewToggle: detailFlags?.policyPreviewToggle ?? true,
    policyAiSummaryDisclaimer: detailFlags?.policyAiSummaryDisclaimer ?? true,
    a11yPanel: detailFlags?.a11yPanel ?? true,
    a11yPreferenceHighlights: detailFlags?.a11yPreferenceHighlights ?? true,
    reviewPanel: detailFlags?.reviewPanel ?? true,
    reviewMarkReviewed: detailFlags?.reviewMarkReviewed ?? true,
    reviewDismiss: detailFlags?.reviewDismiss ?? true,
    reviewSnoozeMenu: detailFlags?.reviewSnoozeMenu ?? true,
    reviewSnoozedPanel: detailFlags?.reviewSnoozedPanel ?? true,
    timelineLiveRows: detailFlags?.timelineLiveRows ?? true,
    timelineWaybackRows: detailFlags?.timelineWaybackRows ?? true,
    timelineWaybackToggle: detailFlags?.timelineWaybackToggle ?? true,
    timelineTriggerPills: detailFlags?.timelineTriggerPills ?? true,
    timelineVersionChip: detailFlags?.timelineVersionChip ?? true,
    timelineMatchesLiveSyncBadge:
      detailFlags?.timelineMatchesLiveSyncBadge ?? true,
    timelineReviewRows: detailFlags?.timelineReviewRows ?? true,
    timelineReviewSnapshotChips:
      detailFlags?.timelineReviewSnapshotChips ?? true,
    timelinePolicyPreviewToggle:
      detailFlags?.timelinePolicyPreviewToggle ?? true,
    timelinePolicyDiffToggle: detailFlags?.timelinePolicyDiffToggle ?? true,
    chartsCategoryTrend: detailFlags?.chartsCategoryTrend ?? true,
    chartsTrendPresets: detailFlags?.chartsTrendPresets ?? true,
    chartsTrendLegend: detailFlags?.chartsTrendLegend ?? true,
  };

  const [tab, setTab] = useState<Tab>("privacy");
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState("");
  const [reviewState, setReviewState] =
    useState<UnacknowledgedChanges>(unacknowledged);
  const canShowAccessibilityTab =
    f.a11yPanel && trackAccessibility && app.hasAccessibilityLabels != null;
  const canShowPolicyTab = f.policyPanel;

  // One-shot blue pulse on the section the URL hash points at — same
  // pattern Settings uses for `#ai-summaries` / `#sync-status`.
  // Currently only `#profile-mismatch` is wired (fired by the
  // notification bell when the user clicks a "App imported · N
  // mismatches" entry), but adding a new target is just a matter of
  // matching the hash here and giving the section a class that flips
  // on when this state matches its id.
  const [hashPulseTarget, setHashPulseTarget] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const apply = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash) {
        return;
      }
      // Make sure the tab containing the hashed target is visible.
      if (hash === "profile-mismatch") {
        setTab("privacy");
      } else if (hash === "policy") {
        setTab(canShowPolicyTab ? "policy" : "privacy");
      } else if (hash === "accessibility") {
        setTab(canShowAccessibilityTab ? "accessibility" : "privacy");
      } else if (hash === "changelog" || hash.startsWith("snapshot-")) {
        setTab("changelog");
      }
      setHashPulseTarget(hash);
      // Clear after the pulse animation finishes so a same-hash
      // re-click can re-trigger it (otherwise the class stays on
      // and the animation never re-runs).
      const timeout = window.setTimeout(() => {
        setHashPulseTarget((prev) => (prev === hash ? null : prev));
      }, 2000);
      return () => window.clearTimeout(timeout);
    };
    const cleanup = apply();
    window.addEventListener("hashchange", apply);
    return () => {
      window.removeEventListener("hashchange", apply);
      if (typeof cleanup === "function") {
        cleanup();
      }
    };
  }, [canShowAccessibilityTab, canShowPolicyTab]);
  // Initial verdicts payload for the picker. We fetch once here so the
  // server-rendered hero doesn't need to await the verdicts query; the
  // picker also re-fetches on mount to catch any imports that landed
  // between server render and client mount.
  const [verdictsInitial, setVerdictsInitial] = useState<
    AppVerdict[] | undefined
  >(undefined);
  useEffect(() => {
    let live = true;
    fetch(`/api/verdicts?appId=${encodeURIComponent(String(app.id))}`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then(({ verdicts }: { verdicts: AppVerdict[] }) => {
        if (!live) {
          return;
        }
        setVerdictsInitial(verdicts);
      })
      .catch(() => {
        // Silent — the picker re-fetches on mount.
      });
    return () => {
      live = false;
    };
  }, [app.id]);
  const taskCenter = useTaskCenter();
  // `router.refresh()` re-runs the parent server component so a freshly-recorded
  // review action shows up in the Change History tab without a full page reload.
  const router = useRouter();

  // i18n translation handles for the AppDetailView surfaces. Captured at
  // the top of the component so all the inner JSX blocks below can use
  // them without having to thread `t` through props or re-call the hook
  // (which would violate React's hooks rules anyway).
  const tDetail = useTranslations("app_detail");
  const tDetailTabs = useTranslations("app_detail.tabs");
  // The delete-failure toast reuses the AppGrid copy so the two delete
  // flows stay word-for-word identical (see deleteApp below).
  const tAppGrid = useTranslations("app_grid");
  // Price + IAP chip copy — shared namespace with ShortlistView's chips.
  const tPriceChip = useTranslations("price_chip");
  // Age-band labels — shared namespace with the focus form's band picker.
  const tAgeBand = useTranslations("age_band");
  // Category-label translators originally lived here, but the
  // category-card render runs inside the PrivacyTypeSection sub-
  // component (see line ~3060), and React's hooks rules mean each
  // component owns its own translator instances. The hooks now sit
  // inside PrivacyTypeSection itself; nothing in this main body
  // reads them, so the duplicates were removed.

  // Delete-flow state. `pendingDelete` drives the confirmation modal,
  // `deleting` spinners the confirm button + locks the dismiss paths so the
  // user can't close the modal mid-request and end up with an orphaned
  // DELETE they thought they cancelled.
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteModalRef = useModalFocus<HTMLDivElement>({
    open: pendingDelete,
    onClose: () => {
      if (!deleting) {
        setPendingDelete(false);
      }
    },
    closeOnEscape: true,
  });

  // Kebab actions menu — re-sync + remove-from-tracker live behind a ⋯
  // trigger so the hero stays focused on content rather than maintenance.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    // `pointerdown` (not `mousedown`) so the outside-click close path works
    // on iOS Safari. Mobile Safari synthesises mouse events from touches
    // unreliably — the menu was failing to open on iPhone because tapping
    // the ⋯ trigger never fired a `mousedown` that the close handler could
    // see, while pointer events fire consistently for touch + mouse + pen.
    // Mirrors the convention already used by `Nav.tsx` (hamburger) and
    // `TaskCenter.tsx` (panel close).
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Dynamic back-link: defaults to "Dashboard" so the first render matches
  // the SSR output. On mount we resolve the real previous page the user
  // was on (see resolveBackDestination below) and, if it's a same-origin
  // page we recognise (Apps / Privacy Map / Stats / Shortlist / Settings /
  // Compare / Custom apps), swap the label + href so the button takes the
  // user back where they came from — filters and sort intact, because we
  // preserve the full `pathname + search`.
  const [backDestination, setBackDestination] = useState<{
    href: string;
    label: string;
  }>({ href: "/dashboard", label: tDetail("back_label.dashboard") });

  // Keep local review state in sync when the server hands us a new snapshot.
  useEffect(() => {
    setReviewState(unacknowledged);
  }, [unacknowledged]);

  // Resolve the back-link from sessionStorage first (populated by
  // NavigationHistoryTracker in the root layout on every path change),
  // then `document.referrer` for hard-loaded first-session visits.
  //
  // Why sessionStorage is primary: Next.js <Link> uses history.pushState
  // for soft navigation, which per the HTML spec does NOT update
  // document.referrer — it stays frozen at whatever the Referer header
  // was on the initial hard page load. So after Apps → /apps/[id] soft
  // nav, document.referrer could still be /dashboard/compare from an
  // earlier session, which was exactly the bug that prompted this switch.
  //
  // getLastNonAppPath() returns the most recent path that wasn't another
  // /apps/[id] page, so a chain of app→app navigations still resolves
  // back to the list page the user originally came from (rather than
  // compounding into a useless "back to /apps/X from /apps/Y").
  //
  // The effect depends on `app.id` so that navigating /apps/A → /apps/B
  // (within the same mounted segment) still refreshes the back label.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    // Table of recognised origins. Each entry captures the pathname that
    // identifies the page *and* a human label for the button. The href
    // stored later includes the full `pathname + search` so (for example)
    // coming back from /dashboard/apps?risk=high&sort=name restores the
    // user's filter + sort selection.
    const known: Array<{ match: (p: string) => boolean; label: string }> = [
      {
        match: (p) => p === "/dashboard/apps",
        label: tDetail("back_label.apps"),
      },
      {
        match: (p) => p.startsWith("/dashboard/privacy"),
        label: tDetail("back_label.privacy_map"),
      },
      {
        match: (p) => p === "/dashboard/stats",
        label: tDetail("back_label.stats"),
      },
      {
        match: (p) => p === "/dashboard/shortlist",
        label: tDetail("back_label.shortlist"),
      },
      {
        match: (p) => p.startsWith("/dashboard/settings"),
        label: tDetail("back_label.settings"),
      },
      {
        match: (p) => p.startsWith("/dashboard/compare"),
        label: tDetail("back_label.compare"),
      },
      {
        match: (p) =>
          p === "/dashboard/manual-apps" ||
          p.startsWith("/dashboard/manual-apps/"),
        label: tDetail("back_label.custom_apps"),
      },
      {
        match: (p) => p === "/dashboard",
        label: tDetail("back_label.dashboard"),
      },
    ];

    // Try to resolve from a same-origin path string (sessionStorage value
    // or document.referrer pathname). Returns null if no known entry matches.
    const resolveFromPath = (
      pathWithSearch: string
    ): { href: string; label: string } | null => {
      // pathWithSearch is either "/dashboard/apps" or "/dashboard/apps?risk=high".
      const [pathOnly] = pathWithSearch.split("?");
      for (const entry of known) {
        if (entry.match(pathOnly)) {
          return { href: pathWithSearch, label: entry.label };
        }
      }
      return null;
    };

    // 1) Preferred: sessionStorage entry written by NavigationHistoryTracker.
    //    This survives soft navigations, which document.referrer does not.
    const tracked = getLastNonAppPath();
    if (tracked) {
      const resolved = resolveFromPath(tracked);
      if (resolved) {
        setBackDestination(resolved);
        return;
      }
    }

    // 2) Fallback: document.referrer — only reliable for the very first
    //    page view after a hard navigation, but good enough for users
    //    who open /apps/[id] in a new tab directly.
    const ref = document.referrer;
    if (!ref) {
      return;
    }
    let refUrl: URL;
    try {
      refUrl = new URL(ref);
    } catch {
      return;
    }
    if (refUrl.origin !== window.location.origin) {
      return;
    }
    const resolved = resolveFromPath(refUrl.pathname + refUrl.search);
    if (resolved) {
      setBackDestination(resolved);
    }
    // Anything else (onboarding wizard, help page, /apps/<other-id>) falls
    // through to the default "Dashboard" so the back button is always
    // trustworthy.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [app.id]);

  // If we arrived via a notification deep-link (#what-changed), nudge the
  // browser to scroll after hydration so the review panel is visible.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (window.location.hash !== "#what-changed") {
      return;
    }
    if (reviewState.totalCount === 0) {
      return;
    }
    const el = document.getElementById("what-changed");
    if (el) {
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [reviewState.totalCount]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), TOAST_HOLD_MS);
  };

  // Settings → Appearance → Date format. The local `formatDate` here
  // used to hard-code `'en-AU'` and ignored the user's preference, so
  // every surface that received it as a prop (WhatsNewSection,
  // policy-meta-pill block, app-detail-footer-line, change-rating
  // strip, mismatch banner, etc.) rendered DD MMM YYYY no matter what
  // the user chose. Now it routes through the shared formatter and
  // re-renders reactively when the preference broadcasts.
  const dateMode = useDateFormat();
  const formatDate = (ts: number) => formatDateWithMode(ts, dateMode);

  const daysSince = (ts: number) => {
    const d = Math.floor((Date.now() - ts) / 86_400_000);
    if (d === 0) {
      return tDetail("date_compact.today");
    }
    if (d === 1) {
      return tDetail("date_compact.yesterday");
    }
    return tDetail("date_compact.days_ago", { count: d });
  };

  const freshnessClass = () => {
    const d = Math.floor((Date.now() - app.lastSynced) / 86_400_000);
    if (d > 30) {
      return "stale";
    }
    if (d > 7) {
      return "aging";
    }
    return "fresh";
  };

  const resync = async () => {
    setSyncing(true);
    // Register the work with the Task Center so the user can navigate away
    // and still see progress / cancel from the nav bar. AbortController lets
    // the menu cancel fire mid-flight.
    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title: tDetail("task_titles.resync_running", { name: app.name }),
      subtitle: tDetail("task_titles.labels_subtitle"),
      kind: "scrape",
      href: `/apps/${app.id}`,
      onCancel: () => controller.abort(),
    });

    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Label-only sync. Privacy policy fetch + AI summary are scoped to the
        // "AI Policy" tab so people don't re-summarise (and re-pay for LLM
        // calls) every time they refresh App Store labels.
        body: JSON.stringify({
          urls: [app.url],
          resync: true,
          summarizePolicies: false,
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      const result = data.results?.[0];
      if (result?.changesDetected) {
        showToast(
          tDetail("toasts.sync_changes_detected", { count: result.changeCount })
        );
        handle.complete(
          "done",
          tDetail("task_titles.completion_changes", {
            count: result.changeCount,
          })
        );
      } else if (result?.versionChanged && result.currentVersion) {
        showToast(
          tDetail("toasts.sync_version_updated", {
            version: result.currentVersion,
          })
        );
        handle.complete(
          "done",
          tDetail("task_titles.completion_version_updated", {
            version: result.currentVersion,
          })
        );
      } else {
        showToast(tDetail("toasts.sync_no_changes"));
        handle.complete("done", tDetail("task_titles.completion_no_changes"));
      }
      // Soft refresh: re-run the parent server component so freshly-written
      // snapshots/notifications/review rows come through on the next render,
      // without dropping the user's current client state (selected tab,
      // expanded accordions, scroll position). The previous
      // `window.location.reload()` was jarring because it always reset the
      // view to the 'privacy' default tab.
      setTimeout(() => router.refresh(), 1500);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        showToast(tDetail("toasts.sync_cancelled"));
      } else {
        console.error(`[app-detail] Re-sync failed for ${app.name}:`, err);
        showToast(tDetail("toasts.sync_failed"));
        handle.complete(
          "error",
          (err as Error)?.message ?? tDetail("task_titles.sync_failed_fallback")
        );
      }
    }
    setSyncing(false);
  };

  /**
   * Remove this app from tracking. Mirrors the AppGrid delete flow so the
   * two surfaces behave identically — same endpoint, same confirmation
   * copy, same post-action toast. On success we navigate the user back to
   * wherever they came from (their original list / filter) rather than
   * dumping them on the dashboard: that matches the "dynamic back link"
   * behaviour above and avoids losing their place in a filtered view.
   */
  const deleteApp = async () => {
    if (deleting) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/apps?id=${encodeURIComponent(app.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      // router.push keeps the navigation in Next's SPA path so the apps list
      // re-renders from the freshly-mutated server state (the /dashboard/apps
      // route is force-dynamic). We point at the same href the back link
      // would have used so the user lands on the filtered/sorted list they
      // started from, minus the deleted app.
      router.push(backDestination.href);
    } catch (error) {
      console.error("[app-detail] Delete failed:", error);
      showToast(tAppGrid("toast_delete_failed"));
      setDeleting(false);
    }
  };

  // Count total categories across all privacy types
  const totalCategories = app.privacyTypes.reduce(
    (sum, pt) => sum + pt.categories.length,
    0
  );

  return (
    <div className="page-container">
      {/* Back link — dynamic label/href based on where the user came from
          (see the useEffect above that inspects document.referrer). Default
          is "Dashboard" so the SSR output and first paint always render a
          sensible button. */}
      <Link
        className="btn btn-ghost btn-sm"
        href={backDestination.href}
        style={{ marginBottom: 24, display: "inline-flex" }}
      >
        {tDetail("back_to", { label: backDestination.label })}
      </Link>

      {/* Hero */}
      <div className="detail-hero">
        {app.iconUrl ? (
          /* Icon is decorative: the app name appears as an <h1> right
             next to it, so alt="" avoids a duplicate announcement. */
          <Image
            alt=""
            className="detail-hero-icon"
            height={88}
            src={app.iconUrl}
            style={{ objectFit: "cover" }}
            unoptimized
            width={88}
          />
        ) : (
          <div className="detail-hero-icon-placeholder">{app.name[0]}</div>
        )}

        <div className="detail-hero-info">
          <h1 className="detail-hero-name">{app.name}</h1>
          {app.developer && <p className="detail-hero-dev">{app.developer}</p>}

          <div className="detail-hero-meta">
            {f.headerFreshnessBadge && (
              <span className={`freshness-badge ${freshnessClass()}`}>
                {tDetail("synced_relative", {
                  relative: daysSince(app.lastSynced),
                })}
              </span>
            )}

            {f.headerChangeCountBadge && reviewState.totalCount > 0 && (
              <a
                className="severity-badge severity-track change-badge-link"
                href="#what-changed"
              >
                {tDetail("changes_to_review", {
                  count: reviewState.totalCount,
                })}
              </a>
            )}

            {app.currentVersion && (
              <span
                className="detail-version-pill"
                title={
                  app.versionUpdatedAt
                    ? tDetail("released_title", {
                        date: formatDate(app.versionUpdatedAt),
                      })
                    : undefined
                }
              >
                v{app.currentVersion}
                {app.versionUpdatedAt && (
                  <>
                    <span aria-hidden="true" className="detail-version-dot">
                      ·
                    </span>
                    <span className="detail-version-date">
                      {tDetail("updated_relative", {
                        relative: daysSince(app.versionUpdatedAt),
                      })}
                    </span>
                  </>
                )}
              </span>
            )}

            {/*
              Phase 2 price + IAP chip. Rendered next to the version
              pill so cost-of-app context lives alongside other listing
              metadata. The chip is silent when we have no price data
              yet — `formatPriceLine` returns null and the span is
              skipped, which keeps legacy rows (pre-Phase-2 sync)
              looking exactly as they did before. The IAP indicator
              ("· IAP") appears only when explicitly detected so the
              copy never claims "no IAP" without evidence.
            */}
            {(() => {
              const line = formatPriceLine(tPriceChip, {
                priceAmount: app.priceAmount,
                priceCurrency: app.priceCurrency,
                priceFormatted: app.priceFormatted,
                hasIap: app.hasIap,
              });
              if (!line) {
                return null;
              }
              return (
                <span
                  className="detail-price-pill"
                  title={priceTooltip(tPriceChip, {
                    priceAmount: app.priceAmount,
                    priceCurrency: app.priceCurrency,
                    priceFormatted: app.priceFormatted,
                    hasIap: app.hasIap,
                  })}
                >
                  {line}
                </span>
              );
            })()}

            {/*
              Age-rating chip. The neutral rating ("Ages 13+") renders for
              everyone once a sync has captured it. When the guardian flag
              is on AND a child age band is set, the chip gains a verdict:
              above-range turns it into a warning with a link to the
              parental-controls guide; within-range stays quiet (a subtle
              ✓ variant). 'unknown' never warns — no data, no alarm.
            */}
            {app.ageRating &&
              (() => {
                const verdict =
                  f.guardianAgeRating && childAgeBand
                    ? compareRatingToBand(childAgeBand, app.ageRating)
                    : null;
                if (verdict === "above" && childAgeBand) {
                  return (
                    <>
                      <span
                        className="detail-age-pill detail-age-pill-above"
                        title={tDetail("age_pill_above_title", {
                          rating: app.ageRating,
                          band: tAgeBand(`labels.${childAgeBand}`),
                        })}
                      >
                        <span aria-hidden="true">⚠</span>
                        {tDetail("age_pill_above", { rating: app.ageRating })}
                      </span>
                      <Link
                        className="btn btn-ghost btn-sm"
                        href="/help/parental-controls"
                      >
                        {tDetail("age_resources_link")}
                      </Link>
                    </>
                  );
                }
                return (
                  <span
                    className={`detail-age-pill ${verdict === "within" ? "detail-age-pill-within" : ""}`}
                    title={
                      verdict === "within" && childAgeBand
                        ? tDetail("age_pill_within_title", {
                            rating: app.ageRating,
                            band: tAgeBand(`labels.${childAgeBand}`),
                          })
                        : tDetail("age_pill_title")
                    }
                  >
                    {verdict === "within" && <span aria-hidden="true">✓</span>}
                    {tDetail("age_pill", { rating: app.ageRating })}
                  </span>
                );
              })()}

            {/*
              Accessibility chip. Gated on the user's "track accessibility
              labels" setting so disabling the feature removes every surface
              (chip, tab, grid filter) in one place. A blue pill with an a11y
              icon links down to the dedicated tab when the developer has
              declared ≥1 feature; when the shelf is present but empty we
              show a muted "no features" variant so users know Apple asked
              and the developer filed nothing.
            */}
            {f.headerA11yCountChip &&
              trackAccessibility &&
              app.hasAccessibilityLabels === 1 && (
                <button
                  aria-label={tDetail("a11y_chip_aria", {
                    count: app.accessibilityFeatures?.length ?? 0,
                  })}
                  className="detail-a11y-chip"
                  onClick={() => setTab("accessibility")}
                  title={tDetail("tooltips.view_a11y_features")}
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    fill="none"
                    height="14"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    width="14"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="7.2" fill="currentColor" r="1.4" />
                    <path d="M6.5 10.5h11" />
                    <path d="M12 10.5v4" />
                    <path d="M9 18l3-3.5L15 18" />
                  </svg>
                  <span>
                    {tDetailTabs("accessibility")}
                    {typeof app.accessibilityFeatures?.length === "number" && (
                      <>
                        {" "}
                        <span className="detail-a11y-chip-count">
                          {app.accessibilityFeatures.length}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              )}
            {f.headerA11yCountChip &&
              trackAccessibility &&
              app.hasAccessibilityLabels === 0 && (
                <span
                  className="detail-a11y-chip detail-a11y-chip-muted"
                  title={tDetail("tooltips.a11y_shelf_no_features")}
                >
                  <svg
                    aria-hidden="true"
                    fill="none"
                    height="14"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    width="14"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="7.2" fill="currentColor" r="1.4" />
                    <path d="M6.5 10.5h11" />
                    <path d="M12 10.5v4" />
                    <path d="M9 18l3-3.5L15 18" />
                  </svg>
                  <span>{tDetail("no_a11y_labels")}</span>
                </span>
              )}

            <span style={{ fontSize: 12, color: "var(--text-3)" }}>
              {tDetail("first_seen", {
                date: formatDate(app.firstSeen || app.lastSynced),
              })}
            </span>

            {isSafeExternalHref(app.url) && (
              <a
                className="btn btn-ghost btn-sm"
                href={app.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {tDetail("view_on_app_store")}
              </a>
            )}

            {isSafeExternalHref(app.privacyPolicyUrl) && (
              <a
                className="btn btn-ghost btn-sm"
                href={app.privacyPolicyUrl!}
                rel="noopener noreferrer"
                target="_blank"
              >
                {tDetail("privacy_policy_link")}
              </a>
            )}

            {/* Always-visible entry point to the in-app definitions page so
                new users can quickly learn what the severity chips mean.
                Pass `from` + `label` so the page's Back button returns here
                instead of dropping the user on the dashboard. */}
            <Link
              className="btn btn-ghost btn-sm"
              href={{
                pathname: "/help/definitions",
                query: { from: `/apps/${app.id}`, label: app.name },
              }}
              title={tDetail("tooltips.read_apple_definitions")}
            >
              {tDetail("label_definitions_link")}
            </Link>
          </div>
        </div>

        {/* Rate-limit banner — surfaces an active App Store HTML cooldown
            so a user clicking Re-sync sees *why* the button bounces
            instead of just watching it spin and fail. The auto-retry
            callback re-fires the same `resync` handler when the
            cooldown elapses, so the page picks back up automatically
            once Apple's window opens. We use the `floating` variant
            because the banner sits between the hero header and the
            action row and benefits from a slight elevation. */}
        <RateLimitBanner
          category="scrape"
          onResume={() => {
            if (!(syncing || deleting)) {
              void resync();
            }
          }}
          variant="floating"
        />

        {/* Hero actions — re-sync and remove-from-tracker live behind a
            kebab menu so the page chrome doesn't read as if maintenance
            is the primary task. While a sync or delete is in flight,
            menu items disable individually. */}
        {(f.actionsResyncButton || f.actionsDeleteButton) && (
          <div className="detail-hero-actions" ref={menuRef}>
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label={tDetail("actions_menu_label", { name: app.name })}
              className="btn btn-secondary detail-hero-actions-trigger"
              data-tour="resync-button"
              disabled={syncing || deleting}
              onClick={() => setMenuOpen((o) => !o)}
              style={{ position: "relative" }}
              title={tDetail("actions_menu_label", { name: app.name })}
              type="button"
            >
              {syncing ? (
                <>
                  <span className="spinner" /> {tDetail("syncing")}
                </>
              ) : (
                <>⋯</>
              )}
              {app.syncCount > 1 && !syncing && (
                <span aria-hidden="true" className="icon-btn-badge">
                  {app.syncCount}
                </span>
              )}
            </button>
            {menuOpen && (
              <div className="detail-hero-actions-menu" role="menu">
                {f.actionsResyncButton && (
                  <button
                    className="detail-hero-actions-item"
                    disabled={syncing || deleting}
                    onClick={() => {
                      setMenuOpen(false);
                      resync();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="detail-hero-actions-icon"
                    >
                      ↻
                    </span>
                    {tDetail("actions_menu_resync")}
                    {app.syncCount > 1 && (
                      <span
                        aria-hidden="true"
                        className="detail-hero-actions-count"
                      >
                        ({app.syncCount})
                      </span>
                    )}
                  </button>
                )}
                {f.actionsDeleteButton && (
                  <button
                    className="detail-hero-actions-item detail-hero-actions-item-danger"
                    disabled={syncing || deleting}
                    onClick={() => {
                      setMenuOpen(false);
                      setPendingDelete(true);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="detail-hero-actions-icon"
                    >
                      🗑
                    </span>
                    {tDetail("actions_menu_remove")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Apple / built-in app hint.
          The App Store doesn't show the same privacy-label treatment for
          Apple's own apps — they're consolidated on apple.com/au/privacy/labels.
          When we detect an Apple-authored app we surface a link so users can
          cross-reference there. We match `developer` loosely because the
          App Store has used "Apple", "Apple Inc.", and "Apple Distribution
          International Ltd." over time. */}
      {isAppleBuiltInApp(app.developer) && (
        <div className="apple-labels-hint" role="note">
          <span aria-hidden="true" className="apple-labels-hint-icon">
            ⓘ
          </span>
          <span>
            {tDetail.rich("apple_app_hint", {
              apple: (chunks) => (
                <a
                  href="https://www.apple.com/au/privacy/labels/"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {chunks}
                </a>
              ),
              defs: (chunks) => (
                <Link
                  href={{
                    pathname: "/help/definitions",
                    query: { from: `/apps/${app.id}`, label: app.name },
                  }}
                >
                  {chunks}
                </Link>
              ),
            })}
          </span>
        </div>
      )}

      {/*
        Verdict picker — sits between the hero and the change-review
        panel so the user's per-app decision is the next thing they
        see after the title block. Imported recommendations (from any
        audit-bundle a recipient has accepted) surface inside the
        picker as advisory pills above the user's own three-button
        choice, so a recipient can see "Mum says remove: …" before
        making their own call.
      */}
      <VerdictPicker
        appId={String(app.id)}
        appName={app.name}
        initialVerdicts={verdictsInitial}
      />

      {/* Change review panel sits 2/3 wide; the "Installed on" side
       *  panel (1/3) renders to the right when the app is linked to one
       *  or more user-named devices. The side panel hides itself when
       *  there's only the migration's "Unknown device" placeholder, so
       *  pre-rollout users don't see an empty card. Below 900px the
       *  grid collapses to one column (see .what-changed-grid). */}
      {f.reviewPanel && reviewState.totalCount > 0 && (
        <div className="what-changed-grid">
          <ChangeReviewPanel
            app={app}
            onAcknowledged={() =>
              setReviewState({
                since: Date.now(),
                events: [],
                totalCount: 0,
                addedCount: 0,
                removedCount: 0,
                snoozedUntil: 0,
              })
            }
            onRefreshHistory={() => router.refresh()}
            onShowToast={showToast}
            onSnoozed={(until) =>
              setReviewState((prev) => ({ ...prev, snoozedUntil: until }))
            }
            onUnsnoozed={() =>
              setReviewState((prev) => ({ ...prev, snoozedUntil: 0 }))
            }
            // Privacy-policy change entries inside the panel render a
            // "View policy change →" link that flips the tab to the
            // changelog/history view, where the diff button on the
            // matching row reveals the full text. Same pattern as
            // PolicySummaryPanel's onViewDiff. Without this, the only
            // visible action on a policy change is "Mark as reviewed",
            // which feels wrong because the user hasn't actually
            // *seen* what changed.
            onViewChange={() => setTab("changelog")}
            showDismiss={f.reviewDismiss}
            showMarkReviewed={f.reviewMarkReviewed}
            showSnoozedPanel={f.reviewSnoozedPanel}
            showSnoozeMenu={f.reviewSnoozeMenu}
            unacknowledged={reviewState}
          />
          <AppDevicesPanel appId={String(app.id)} />
        </div>
      )}

      {/* Tabs — wired as a WAI-ARIA tablist so screen readers announce
          "tab 1 of 3, selected" and arrow-key navigation is expected. */}
      <div
        aria-label={tDetail("tabs_aria")}
        className="detail-tabs"
        role="tablist"
      >
        <button
          aria-controls="tabpanel-privacy"
          aria-selected={tab === "privacy"}
          className={`detail-tab ${tab === "privacy" ? "active" : ""}`}
          id="tab-privacy"
          onClick={() => setTab("privacy")}
          role="tab"
          tabIndex={tab === "privacy" ? 0 : -1}
          type="button"
        >
          {tDetailTabs("privacy_labels")}
          <span style={{ marginLeft: 6, fontSize: 12, color: "var(--text-3)" }}>
            {tDetailTabs("categories_badge", { count: totalCategories })}
          </span>
        </button>
        {/*
          Accessibility tab — only rendered when the global toggle is on AND
          we have a verdict on the accessibility shelf for this app. Legacy
          rows (hasAccessibilityLabels === null) don't get the tab so users
          aren't presented with an empty surface on apps we haven't rescraped
          since the feature shipped.
        */}
        {f.a11yPanel &&
          trackAccessibility &&
          app.hasAccessibilityLabels != null && (
            <button
              aria-controls="tabpanel-accessibility"
              aria-selected={tab === "accessibility"}
              className={`detail-tab ${tab === "accessibility" ? "active" : ""}`}
              id="tab-accessibility"
              onClick={() => setTab("accessibility")}
              role="tab"
              tabIndex={tab === "accessibility" ? 0 : -1}
              type="button"
            >
              {tDetailTabs("accessibility")}
              <span
                style={{ marginLeft: 6, fontSize: 12, color: "var(--text-3)" }}
              >
                {app.hasAccessibilityLabels === 1
                  ? tDetailTabs("features_badge", {
                      count: app.accessibilityFeatures?.length ?? 0,
                    })
                  : tDetailTabs("no_features")}
              </span>
            </button>
          )}
        {f.policyPanel && (
          <button
            aria-controls="tabpanel-policy"
            aria-selected={tab === "policy"}
            className={`detail-tab ${tab === "policy" ? "active" : ""}`}
            id="tab-policy"
            onClick={() => setTab("policy")}
            role="tab"
            tabIndex={tab === "policy" ? 0 : -1}
            type="button"
          >
            {tDetailTabs("ai_policy")}
            <span
              style={{ marginLeft: 6, fontSize: 12, color: "var(--text-3)" }}
            >
              {app.privacyPolicyUrl
                ? app.policyAnalysis?.summary
                  ? tDetailTabs("policy_summary_ready")
                  : tDetailTabs("policy_not_summarised")
                : tDetailTabs("policy_no_link")}
            </span>
          </button>
        )}
        <button
          aria-controls="tabpanel-changelog"
          aria-selected={tab === "changelog"}
          className={`detail-tab ${tab === "changelog" ? "active" : ""}`}
          id="tab-changelog"
          onClick={() => setTab("changelog")}
          role="tab"
          tabIndex={tab === "changelog" ? 0 : -1}
          type="button"
        >
          {tDetailTabs("change_history")}
          <span style={{ marginLeft: 6, fontSize: 12, color: "var(--text-3)" }}>
            {(() => {
              // The merged changelog includes acknowledgement rows, which
              // would make the "N syncs" label lie. Count snapshots only so
              // the badge still means "number of sync events".
              const syncCount = changelog.filter(
                (r) => r.kind === "snapshot"
              ).length;
              return tDetail("tab_sync_count", { count: syncCount });
            })()}
          </span>
        </button>
        {f.tabsCompare && (
          <button
            aria-controls="tabpanel-compare"
            aria-selected={tab === "compare"}
            className={`detail-tab ${tab === "compare" ? "active" : ""}`}
            id="tab-compare"
            onClick={() => setTab("compare")}
            role="tab"
            tabIndex={tab === "compare" ? 0 : -1}
            type="button"
          >
            {tDetail("tab_compare")}
            <span
              style={{ marginLeft: 6, fontSize: 12, color: "var(--text-3)" }}
            >
              {tDetail("tab_compare_vs")}
            </span>
          </button>
        )}
      </div>

      {/* Tab content follows */}

      {/* Privacy tab */}
      {tab === "privacy" && (
        <div
          aria-labelledby="tab-privacy"
          id="tabpanel-privacy"
          role="tabpanel"
        >
          {f.policyWhatsNew && app.whatsNew && (
            <WhatsNewSection
              formatDate={formatDate}
              releasedAt={app.versionUpdatedAt}
              version={app.currentVersion}
              whatsNew={app.whatsNew}
            />
          )}

          {app.privacyTypes.length === 0 ? (
            // Wave I: the "no details" / "no labels" empty states are
            // gated behind `flag.detail.labels.no_details_warning`. When
            // off the panel renders nothing rather than a placeholder —
            // most users want the cards or nothing at all.
            f.labelsNoDetailsWarning ? (
              app.hasPrivacyDetails === 0 ? (
                // Apple's standard copy when the developer hasn't filled in
                // privacy labels yet. Wording matches the App Store. Styled as
                // a yellow "attention" state — not red (no evidence of harm)
                // but not neutral either (the user can't make an informed
                // decision until Apple collects labels from the developer).
                <div
                  className="empty-state empty-state-attention"
                  role="status"
                  style={{ padding: "60px 0" }}
                >
                  <div aria-hidden="true" className="empty-state-icon">
                    ⚠️
                  </div>
                  <div className="empty-state-title">
                    {tDetail("no_details_title")}
                  </div>
                  <p className="empty-state-text">
                    {tDetail("no_details_body")}
                  </p>
                </div>
              ) : (
                <div className="empty-state" style={{ padding: "60px 0" }}>
                  <div aria-hidden="true" className="empty-state-icon">
                    🛡
                  </div>
                  <div className="empty-state-title">
                    {tDetail("no_labels_title")}
                  </div>
                  <p className="empty-state-text">
                    {tDetail("no_labels_body")}
                  </p>
                </div>
              )
            ) : null
          ) : (
            f.labelsCards && (
              // Wrapper carries `id="profile-mismatch"` so notification
              // links of the form `/apps/<id>#profile-mismatch` (fired
              // by createProfileMismatchNotification + bell routing)
              // can scroll-to and pulse this section. The pulse class
              // is toggled in by an effect below that watches
              // location.hash.
              <div
                className={`app-detail-privacy-types${
                  hashPulseTarget === "profile-mismatch"
                    ? " app-detail-privacy-types--pulse"
                    : ""
                }`}
                id="profile-mismatch"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                  scrollMarginTop: 80,
                }}
              >
                {sortPrivacyTypesForDisplay(app.privacyTypes).map((pt) => (
                  <PrivacyTypeSection
                    key={pt.id}
                    privacyType={pt}
                    profile={
                      f.labelsProfileMismatchBadges
                        ? (privacyProfile ?? null)
                        : null
                    }
                  />
                ))}
              </div>
            )
          )}
        </div>
      )}

      {/* Accessibility tab — renders the declared-feature list alongside the
          canonical baseline, so users can see both what Apple expects a
          developer to consider AND what this developer actually filed. */}
      {tab === "accessibility" && trackAccessibility && f.a11yPanel && (
        <div
          aria-labelledby="tab-accessibility"
          id="tabpanel-accessibility"
          role="tabpanel"
        >
          <AccessibilityPanel
            a11yProfile={
              f.a11yPreferenceHighlights ? (a11yProfile ?? null) : null
            }
            app={app}
            formatDate={formatDate}
          />
        </div>
      )}

      {/* AI Policy tab */}
      {tab === "policy" && f.policyPanel && (
        <div aria-labelledby="tab-policy" id="tabpanel-policy" role="tabpanel">
          <PolicySummaryPanel
            aiProvider={aiProvider}
            app={app}
            flags={{
              aiSummary: f.policyAiSummary,
              aiSummaryDisclaimer: f.policyAiSummaryDisclaimer,
              highlights: f.policyHighlights,
              lensGrid: f.policyLensGrid,
              safetySummary: f.policySafetySummary,
              whatsNew: f.policyWhatsNew,
              recentChangeBanner: f.policyRecentChangeBanner,
              changeStrip: f.policyChangeStrip,
              chunkNotes: f.policyChunkNotes,
              runLogStrip: f.policyRunLogStrip,
              runLogDetails: f.policyRunLogDetails,
              fallbackReferences: f.policyFallbackReferences,
              waybackBackupLink: f.policyWaybackBackupLink,
              sourcePolicyLink: f.policySourcePolicyLink,
              rescrapeButton: f.policyRescrapeButton,
              summariseButton: f.policySummariseButton,
              rescrapeSummariseButton: f.policyRescrapeSummariseButton,
              previewToggle: f.policyPreviewToggle,
            }}
            formatDate={formatDate}
            onViewDiff={() => setTab("changelog")}
            policyDiffAlertDays={policyDiffAlertDays ?? 90}
            recentPolicyChange={recentPolicyChange ?? null}
          />
        </div>
      )}

      {/* Changelog tab */}
      {tab === "changelog" && (
        <div
          aria-labelledby="tab-changelog"
          id="tabpanel-changelog"
          role="tabpanel"
        >
          {/* Cumulative "since you added this app" diff — the net change from
              the install-era baseline snapshot to today, above the
              change-by-change timeline below. Self-hides until there's a
              real multi-snapshot baseline to compare against. */}
          <SinceInstallCard appId={app.id} />
          <ChangelogTimeline
            appId={app.id}
            defaultShowImported={waybackShowImportedDefault}
            flags={{
              liveRows: f.timelineLiveRows,
              waybackRows: f.timelineWaybackRows,
              waybackToggle: f.timelineWaybackToggle,
              triggerPills: f.timelineTriggerPills,
              versionChip: f.timelineVersionChip,
              matchesLiveSyncBadge: f.timelineMatchesLiveSyncBadge,
              reviewRows: f.timelineReviewRows,
              reviewSnapshotChips: f.timelineReviewSnapshotChips,
              policyPreviewToggle: f.timelinePolicyPreviewToggle,
              policyDiffToggle: f.timelinePolicyDiffToggle,
              chartsCategoryTrend: f.chartsCategoryTrend,
              chartsTrendPresets: f.chartsTrendPresets,
              chartsTrendLegend: f.chartsTrendLegend,
            }}
            rows={changelog}
          />
        </div>
      )}

      {/* Compare tab — slot A is pinned to the current app; slot B is a
          library pick or an App Store candidate. CompareAppsView handles
          its own data fetching against /api/compare. */}
      {tab === "compare" && (
        <div
          aria-labelledby="tab-compare"
          id="tabpanel-compare"
          role="tabpanel"
        >
          <CompareAppsView
            initialSpec={`id:${app.id}`}
            lockPinned
            pinnedSlot="A"
          />
        </div>
      )}

      {/* Provenance footer — tells the user when / how this app got added,
          and gives them a one-click path back to the Import History row so
          they can fix a wrong match without hunting through Settings. When
          `importProvenance` is null (legacy imports that predate the items
          write path) we still show "Imported" from `app.firstSeen` so the
          page always has a bottom-of-page answer for "when did this arrive?"
          — just without the fix-match CTA, because there's no history row
          to link to. */}
      {f.footerImportProvenance && (
        <footer
          aria-label={tDetail("footer.import_provenance")}
          className="app-detail-footer"
        >
          {importProvenance ? (
            (() => {
              const sourceLabel = (() => {
                if (importProvenance.sourceLabel) {
                  return importProvenance.sourceLabel;
                }
                switch (importProvenance.source) {
                  case "screenshots":
                    return tDetail("import_source.screenshots");
                  case "file":
                    return tDetail("import_source.file_upload");
                  case "manual":
                    return tDetail("import_source.manual_entry");
                  default:
                    return tDetail("import_source.onboarding");
                }
              })();
              const query =
                importProvenance.item.editedQuery?.trim() ||
                importProvenance.item.query.trim();
              // Encode both the importId (so Import History auto-expands it)
              // and the item id (so SettingsView can scroll/highlight it).
              const fixHref = `/dashboard/settings/import-history?importId=${encodeURIComponent(importProvenance.importId)}&item=${encodeURIComponent(importProvenance.item.id)}`;
              return (
                <>
                  <span className="app-detail-footer-line">
                    {tDetail("footer_provenance.imported_via_lead")}
                    <strong>{formatDate(importProvenance.importedAt)}</strong>
                    {tDetail("footer_provenance.imported_via_mid")}
                    <strong>{sourceLabel}</strong>
                    {query ? (
                      <>
                        {tDetail("footer_provenance.imported_via_query_lead")}
                        <span className="app-detail-footer-query">{query}</span>
                        {tDetail("footer_provenance.imported_via_query_post")}
                      </>
                    ) : (
                      tDetail("footer_provenance.imported_via_post")
                    )}
                  </span>
                  <span className="app-detail-footer-cta">
                    {tDetail("footer_provenance.wrong_match")}{" "}
                    <Link className="app-detail-footer-link" href={fixHref}>
                      {tDetail("footer_provenance.fix_in_history")}
                    </Link>
                  </span>
                </>
              );
            })()
          ) : (
            <span className="app-detail-footer-line">
              {tDetail("footer_provenance.imported_on_lead")}
              <strong>{formatDate(app.firstSeen || app.lastSynced)}</strong>
              {tDetail("footer_provenance.imported_on_post")}
              <Link
                className="app-detail-footer-link"
                href="/dashboard/settings/import-history"
              >
                {tDetail("footer_provenance.open_history_link")}
              </Link>
            </span>
          )}
        </footer>
      )}

      {/* Stop-tracking confirmation modal. Mirrors the AppGrid modal so the
          experience is consistent regardless of where the user kicks off a
          delete from. The overlay is only dismissable when `deleting` is
          false — otherwise we could drop the user back on the page
          mid-request and leave them unsure whether the delete went
          through. */}
      {pendingDelete && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!deleting) {
              setPendingDelete(false);
            }
          }}
        >
          <div
            aria-describedby="delete-app-copy"
            aria-labelledby="delete-app-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            ref={deleteModalRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="modal-badge">{tDetail("remove_modal.badge")}</div>
            <h2 className="modal-title" id="delete-app-title">
              {tDetail("remove_modal.title", { name: app.name })}
            </h2>
            <p className="modal-copy" id="delete-app-copy">
              {tDetail("remove_modal.body")}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={deleting}
                onClick={() => setPendingDelete(false)}
                type="button"
              >
                {tDetail("remove_modal.cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={deleting}
                onClick={() => void deleteApp()}
                type="button"
              >
                {deleting ? (
                  <>
                    <span className="spinner-sm" />{" "}
                    {tDetail("remove_modal.removing")}
                  </>
                ) : (
                  tDetail("remove_modal.confirm")
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast>{toast}</Toast>

      {/* Annotations sidebar (round 3 PR 4). Gated by
          flag.detail.annotations_sidebar (server-resolved). 'on' means
          expanded; 'collapsed' means visible but the body's collapsed by
          default; 'off' means hidden entirely. The 'collapsed' state is
          the default for `audience.self`; loved_one starts expanded. */}
      {detailFlags && detailFlags.annotationsSidebar !== "off" && (
        <AnnotationsSidebar
          appId={String(app.id)}
          initiallyExpanded={detailFlags.annotationsSidebar === "on"}
        />
      )}
    </div>
  );
}

// ── Change Review Panel ───────────────────────────────────────────────
//
// Surfaces the most recent unacknowledged sync events. Lets the user
// mark them reviewed which clears the change dot on the app card AND
// any related notifications, turning the bell into an inbox instead
// of a permanent red signal.

interface ChangeClassification {
  categoryIcon?: string;
  categoryLabel?: string;
  severity: "track" | "linked" | "unlinked" | "none";
  severityLabel: string;
}

// Map a raw ChangeEntry description back to its severity class via the
// privacy type title (the description starts with the type title in quotes,
// e.g. `"Data Used to Track You" now collects: Contact Info`). This lets
// us colour each change by how sensitive the data category is.
function classifyChange(entry: ChangeEntry): ChangeClassification {
  const description = entry.description;
  let severity: ChangeClassification["severity"] = "none";
  let severityLabel = "";

  for (const key of Object.keys(SEVERITY_CONFIG)) {
    const meta = SEVERITY_CONFIG[key];
    if (description.includes(meta.label)) {
      severity =
        key === "DATA_USED_TO_TRACK_YOU"
          ? "track"
          : key === "DATA_LINKED_TO_YOU"
            ? "linked"
            : "unlinked";
      severityLabel = meta.label;
      break;
    }
  }

  // Try to extract the category label from "... now collects: Foo" or
  // "... no longer collects: Foo" so we can add its icon.
  const catMatch = description.match(/collects?: (.+)$/);
  let categoryLabel: string | undefined;
  let categoryIcon: string | undefined;
  if (catMatch) {
    const name = catMatch[1].trim();
    categoryLabel = name;
    for (const meta of Object.values(CATEGORY_META)) {
      if (meta.label.toLowerCase() === name.toLowerCase()) {
        categoryIcon = meta.icon;
        break;
      }
    }
  }

  return { severity, severityLabel, categoryLabel, categoryIcon };
}

/**
 * Format a change-review event timestamp. Deterministic by design: every
 * field is built by hand rather than going through `Intl.DateTimeFormat`,
 * so the string is byte-for-byte identical between the Node server (using
 * its bundled ICU) and the WebKit/Chromium client (using the system ICU).
 *
 * The previous implementation used `Intl.DateTimeFormat('en-AU', { day:
 * 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute:
 * '2-digit' })` and produced "8 May 2026, 02:44 pm" on Node 24 but
 * "8 May 2026 at 02:44 pm" on recent WebKit — same options, different
 * CLDR/ICU data. React's hydration step then bailed with
 *   "Hydration failed because the server rendered text didn't match
 *    the client. … 8 May 2026 at 02:44 pm vs 8 May 2026, 02:44 pm"
 * and re-rendered the whole subtree on the client, which is wasted
 * work + a console error.
 *
 * We keep the visual layout the previous output had on Node (day, short
 * month, year, two-digit 12-hour clock with am/pm) and ship the literal
 * separator chars as a constant in this file. Loss of i18n flexibility
 * is a non-issue: the original call was hardcoded to 'en-AU' anyway.
 */
const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatEventDate(ts: number) {
  const d = new Date(ts);
  const day = d.getDate();
  const month = SHORT_MONTHS[d.getMonth()];
  const year = d.getFullYear();
  const hours24 = d.getHours();
  const ampm = hours24 >= 12 ? "pm" : "am";
  // 12-hour clock with explicit zero-padding so 02:44 pm doesn't flip to
  // " 2:44 pm" depending on the runtime's whitespace handling.
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const hh = hours12.toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${day} ${month} ${year}, ${hh}:${mm} ${ampm}`;
}

/**
 * i18n keys (under `app_detail.change_review.snooze_options`) for the snooze
 * menu's preset labels. Mirrors `SNOOZE_DAYS_OPTIONS` in `lib/changelog.ts` —
 * kept as a parallel map rather than computing from the tuple so we can
 * phrase each option in natural language ("1 day", "1 week", "1 month")
 * instead of "N days".
 */
const SNOOZE_LABEL_KEYS: Record<SnoozeDays, string> = {
  1: "one_day",
  7: "one_week",
  30: "one_month",
};

function formatSnoozeDate(ts: number) {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

function ChangeReviewPanel({
  app,
  unacknowledged,
  onAcknowledged,
  onSnoozed,
  onUnsnoozed,
  onRefreshHistory,
  onShowToast,
  onViewChange,
  showMarkReviewed = true,
  showDismiss = true,
  showSnoozeMenu = true,
  showSnoozedPanel = true,
}: {
  app: App;
  unacknowledged: UnacknowledgedChanges;
  onAcknowledged: () => void;
  onSnoozed: (until: number) => void;
  onUnsnoozed: () => void;
  onRefreshHistory: () => void;
  onShowToast: (msg: string) => void;
  /**
   * Fired when the user clicks "View policy change →" on a
   * privacy-policy entry. Parent flips its tab state to 'changelog'
   * so the diff button on the timeline row can reveal the full text.
   */
  onViewChange?: () => void;
  /**
   * Wave I — per-action gates. Each button stays in the layout when its
   * flag resolves on; flipping any of them off removes only that button
   * without disturbing the panel's other affordances. Defaults preserve
   * the legacy "all visible" behaviour for unflagged callers.
   */
  showMarkReviewed?: boolean;
  showDismiss?: boolean;
  showSnoozeMenu?: boolean;
  /**
   * Wave I — `flag.detail.review.snoozed_panel`. When false, a snoozed
   * panel renders nothing (rather than the "reminders snoozed" header),
   * matching the focus that hides snooze affordances entirely.
   */
  showSnoozedPanel?: boolean;
}) {
  // i18n — `change_review` namespace covers the snooze aria-label and any
  // other change-review-panel chrome that gets extracted in subsequent
  // passes. Captured at the top to satisfy hooks rules.
  const tDetail = useTranslations("app_detail");
  // `busy` is the single in-flight action — buttons disable as a group so we
  // don't end up with racing requests (e.g. Mark-reviewed fired twice because
  // the first POST hadn't landed yet).
  const [busy, setBusy] = useState<
    null | "reviewed" | "dismissed" | "snoozed" | "unsnoozed"
  >(null);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);

  // ── Cmd+Z undo for change-review actions ────────────────────────────
  // Each successful POST to /api/apps/<id>/acknowledge stashes the
  // returned action id + the apps-row pre-state snapshot in this
  // bounded stack. KeyboardShortcuts.tsx dispatches an `app:undo`
  // window event when the user hits Cmd/Ctrl+Z outside of a text
  // input; we listen for it while the panel is mounted and replay the
  // most-recent op via /api/apps/<id>/acknowledge/undo. Matches the
  // pattern in ShortlistView so a future undo-store refactor can fold
  // both surfaces into one helper without reshaping the UX.
  interface ReviewUndoOp {
    actionId: string;
    actionLabel: ReviewAction;
    preState: {
      changeCount: number;
      changesAcknowledgedAt: number;
      changesSnoozedUntil: number;
    };
  }
  const MAX_UNDO_OPS = 20;
  const [undoStack, setUndoStack] = useState<ReviewUndoOp[]>([]);

  const pushReviewUndo = useCallback((op: ReviewUndoOp) => {
    setUndoStack((prev) => {
      const next = [...prev, op];
      if (next.length > MAX_UNDO_OPS) {
        next.shift();
      }
      return next;
    });
  }, []);

  const handleReviewUndo = useCallback(async () => {
    const target = undoStack.at(-1);
    if (!target) {
      return;
    }
    setUndoStack((prev) => prev.slice(0, -1));
    try {
      const res = await fetch(`/api/apps/${app.id}/acknowledge/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: target.actionId,
          preState: target.preState,
        }),
      });
      // 410 = the row's already gone (double-Cmd-Z, or another tab beat
      // us to it). Drop the op silently and tell the user nothing was
      // restored, rather than spamming an error toast.
      if (res.status === 410) {
        onShowToast(tDetail("toasts.review_undo_nothing"));
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const toastKeyMap: Record<ReviewAction, string> = {
        reviewed: "toasts.review_undo_reviewed",
        dismissed: "toasts.review_undo_dismissed",
        snoozed: "toasts.review_undo_snoozed",
        unsnoozed: "toasts.review_undo_unsnoozed",
      };
      onShowToast(tDetail(toastKeyMap[target.actionLabel]));
      // Tell the parent to refetch so the panel state realigns with the
      // restored db row. onAcknowledged is the wrong callback to fire
      // here (it would clear the unack state on the parent again);
      // onRefreshHistory is the lighter-weight refetch that pulls the
      // changelog timeline + unacknowledged changes together.
      onRefreshHistory();
    } catch (error) {
      console.error("[app-detail] review undo failed:", error);
      onShowToast(tDetail("toasts.review_undo_failed"));
    }
  }, [app.id, onRefreshHistory, onShowToast, undoStack]);

  // Listen at the window level. The KeyboardShortcuts component owns
  // the actual key handling and only dispatches `app:undo` outside of
  // text-input fields, so this listener won't interfere with native
  // undo in textareas or input boxes elsewhere on the page.
  useEffect(() => {
    const handler = () => {
      void handleReviewUndo();
    };
    window.addEventListener("app:undo", handler);
    return () => window.removeEventListener("app:undo", handler);
  }, [handleReviewUndo]);

  const postAction = async (
    action: ReviewAction,
    options: { snoozeDays?: SnoozeDays } = {}
  ): Promise<{ ok: boolean; snoozeUntil?: number | null }> => {
    setBusy(action);
    try {
      const res = await fetch(`/api/apps/${app.id}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, snoozeDays: options.snoozeDays }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json().catch(() => null)) as {
        ok: boolean;
        record?: {
          id?: string;
          snooze_until: number | null;
          pre_state?: {
            changeCount: number;
            changesAcknowledgedAt: number;
            changesSnoozedUntil: number;
          };
        };
      } | null;
      // Stash the undo op only when we have BOTH the action's row id
      // and the pre-state snapshot. Either missing means the response
      // shape regressed (defensive) — log once and skip pushing rather
      // than queueing a half-formed op that would 400 on undo.
      if (data?.record?.id && data.record.pre_state) {
        pushReviewUndo({
          actionId: data.record.id,
          actionLabel: action,
          preState: data.record.pre_state,
        });
      }
      return { ok: true, snoozeUntil: data?.record?.snooze_until ?? null };
    } catch (error) {
      console.error(`[app-detail] ${action} failed:`, error);
      onShowToast(tDetail("toasts.review_action_failed", { action }));
      return { ok: false };
    } finally {
      setBusy(null);
    }
  };

  const handleReviewed = async () => {
    const result = await postAction("reviewed");
    if (result.ok) {
      onShowToast(tDetail("toasts.review_marked_reviewed"));
      onAcknowledged();
      onRefreshHistory();
    }
  };

  const handleDismiss = async () => {
    const result = await postAction("dismissed");
    if (result.ok) {
      onShowToast(tDetail("toasts.review_dismissed"));
      onAcknowledged();
      onRefreshHistory();
    }
  };

  const handleSnooze = async (days: SnoozeDays) => {
    setSnoozeMenuOpen(false);
    const result = await postAction("snoozed", { snoozeDays: days });
    if (result.ok && result.snoozeUntil) {
      onShowToast(
        tDetail("toasts.review_snoozed", {
          duration: tDetail(
            `change_review.snooze_options.${SNOOZE_LABEL_KEYS[days]}`
          ),
        })
      );
      onSnoozed(result.snoozeUntil);
      onRefreshHistory();
    }
  };

  const handleUnsnooze = async () => {
    const result = await postAction("unsnoozed");
    if (result.ok) {
      onShowToast(tDetail("toasts.review_unsnoozed"));
      onUnsnoozed();
      onRefreshHistory();
    }
  };

  const { totalCount, addedCount, removedCount, events, since, snoozedUntil } =
    unacknowledged;
  const isSnoozed = snoozedUntil > Date.now();

  // Collapsed state — reminders are snoozed. Still show the count so the user
  // knows what they deferred, plus a quick "Resume now" button.
  if (isSnoozed) {
    if (!showSnoozedPanel) {
      return null;
    }
    return (
      <section
        className="change-review-panel change-review-panel-snoozed"
        id="what-changed"
      >
        <div className="change-review-header">
          <div className="change-review-header-text">
            <div className="change-review-kicker">
              {tDetail("snoozed_kicker")}
            </div>
            <h2 className="change-review-title">
              {tDetail("snoozed_resume", {
                count: totalCount,
                date: formatSnoozeDate(snoozedUntil),
              })}
            </h2>
            <p className="change-review-sub">{tDetail("snoozed_sub")}</p>
          </div>
          <button
            className="btn btn-secondary change-review-ack-btn"
            disabled={busy !== null}
            onClick={handleUnsnooze}
            type="button"
          >
            {busy === "unsnoozed" ? (
              <>
                <span className="spinner-sm" /> {tDetail("snoozed_resuming")}
              </>
            ) : (
              tDetail("snoozed_resume_now")
            )}
          </button>
        </div>
      </section>
    );
  }

  const addedLabel =
    addedCount > 0 ? tDetail("review_added_label", { count: addedCount }) : "";
  const removedLabel =
    removedCount > 0
      ? tDetail("review_removed_label", { count: removedCount })
      : "";
  const countBlurb = [addedLabel, removedLabel].filter(Boolean).join(" · ");

  return (
    <section className="change-review-panel" id="what-changed">
      <div className="change-review-header">
        <div className="change-review-header-text">
          <div className="change-review-kicker">{tDetail("review_kicker")}</div>
          <h2 className="change-review-title">
            {tDetail("review_count", { count: totalCount })}
            {countBlurb && (
              <span className="change-review-count-blurb">
                {tDetail("review_count_blurb", { parts: countBlurb })}
              </span>
            )}
          </h2>
          <p className="change-review-sub">
            {since > 0
              ? tDetail("review_sub_with_since", {
                  events: events.length,
                  date: formatEventDate(since),
                })
              : tDetail("review_sub_no_since", { events: events.length })}
          </p>
        </div>
        <div
          className="change-review-actions"
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            position: "relative",
          }}
        >
          {showMarkReviewed && (
            <button
              className="btn btn-primary change-review-ack-btn"
              disabled={busy !== null}
              onClick={handleReviewed}
              type="button"
            >
              {busy === "reviewed" ? (
                <>
                  <span className="spinner-sm" /> {tDetail("review_marking")}
                </>
              ) : (
                tDetail("review_mark_done")
              )}
            </button>
          )}
          {showDismiss && (
            <button
              className="btn btn-secondary"
              disabled={busy !== null}
              onClick={handleDismiss}
              title={tDetail("tooltips.clear_badge_no_review")}
              type="button"
            >
              {busy === "dismissed" ? (
                <>
                  <span className="spinner-sm" /> {tDetail("review_dismissing")}
                </>
              ) : (
                tDetail("review_dismiss")
              )}
            </button>
          )}
          {showSnoozeMenu && (
            <div className="snooze-menu-wrap">
              <button
                aria-expanded={snoozeMenuOpen}
                aria-haspopup="menu"
                className="btn btn-secondary"
                disabled={busy !== null}
                onClick={() => setSnoozeMenuOpen((open) => !open)}
                type="button"
              >
                {busy === "snoozed" ? (
                  <>
                    <span className="spinner-sm" /> {tDetail("review_snoozing")}
                  </>
                ) : (
                  tDetail("review_remind_later")
                )}
              </button>
              {snoozeMenuOpen && (
                <div
                  aria-label={tDetail("change_review.snooze_aria")}
                  className="snooze-menu"
                  onMouseLeave={() => setSnoozeMenuOpen(false)}
                  role="menu"
                >
                  {SNOOZE_DAYS_OPTIONS.map((days) => (
                    <button
                      className="snooze-menu-item"
                      key={days}
                      onClick={() => handleSnooze(days)}
                      role="menuitem"
                      type="button"
                    >
                      {tDetail(
                        `change_review.snooze_options.${SNOOZE_LABEL_KEYS[days]}`
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="change-review-events">
        {events.map((event) => (
          <ChangeReviewEvent
            event={event}
            key={event.id}
            onViewChange={onViewChange}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Map the `classifyChange` severity class back to the `severity.*` locale
 * namespace key, so the chip renders the localised label while the English
 * `SEVERITY_CONFIG.label` stays the matcher for the (English) server-side
 * change descriptions.
 */
const SEVERITY_I18N_KEY: Record<
  Exclude<ChangeClassification["severity"], "none">,
  string
> = {
  track: "data_used_to_track_you",
  linked: "data_linked_to_you",
  unlinked: "data_not_linked_to_you",
};

function ChangeReviewEvent({
  event,
  onViewChange,
}: {
  event: UnacknowledgedChangeEvent;
  onViewChange?: () => void;
}) {
  const tDetail = useTranslations("app_detail");
  const tSeverity = useTranslations("severity");
  return (
    <div className="change-review-event">
      <div className="change-review-event-date">
        {formatEventDate(event.scraped_at)}
      </div>
      <ul className="change-review-list">
        {event.changes.map((entry, idx) => {
          const cls = classifyChange(entry);
          const isPolicyChange = entry.category === "privacy-policy";
          return (
            <li
              className={`change-review-item change-review-item-${entry.type} change-review-sev-${cls.severity}`}
              key={idx}
            >
              <span aria-hidden="true" className="change-review-icon">
                {entry.type === "added"
                  ? "＋"
                  : entry.type === "removed"
                    ? "−"
                    : "~"}
              </span>
              <div className="change-review-body">
                <div className="change-review-desc">
                  {cls.categoryIcon && (
                    <span className="change-review-cat-icon">
                      {cls.categoryIcon}
                    </span>
                  )}
                  {entry.description}
                </div>
                {cls.severityLabel && (
                  <span
                    className={`change-review-sev-chip change-review-sev-chip-${cls.severity}`}
                  >
                    {cls.severity === "none"
                      ? cls.severityLabel
                      : tSeverity(SEVERITY_I18N_KEY[cls.severity])}
                  </span>
                )}
                {entry.details && entry.details.length > 0 && (
                  <div className="change-review-details">
                    {entry.details.join(", ")}
                  </div>
                )}
                {/* Privacy-policy entries get a "view change" button.
                    Marking as reviewed without seeing what changed
                    isn't really reviewing — the button flips the parent
                    tab to the changelog/history view where the diff
                    is rendered. Hidden when the parent didn't supply
                    a navigation handler (e.g. shared usage outside
                    AppDetailView). `align-self: flex-start` keeps the
                    button to its content width inside the column-flex
                    `.change-review-body` parent instead of stretching
                    across. */}
                {isPolicyChange && onViewChange && (
                  <button
                    className="btn btn-secondary btn-sm change-review-view-change"
                    onClick={onViewChange}
                    type="button"
                  >
                    {tDetail("change_review.view_policy_change")}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── What's New Section ────────────────────────────────────────────────
//
// Surfaces the App Store "What's New" release notes alongside the version
// pill so auditors can eyeball whether a new version explains any privacy
// label changes. Collapsed by default when the notes are long so it doesn't
// push the privacy labels below the fold.

function WhatsNewSection({
  whatsNew,
  version,
  releasedAt,
  formatDate,
}: {
  whatsNew: string;
  version?: string | null;
  releasedAt?: number | null;
  formatDate: (ts: number) => string;
}) {
  const tDetail = useTranslations("app_detail");
  const LONG_THRESHOLD = 280;
  const isLong = whatsNew.length > LONG_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);

  return (
    <section className="whats-new-section">
      <div className="whats-new-header">
        <div>
          <div className="whats-new-kicker">{tDetail("whats_new_kicker")}</div>
          <h2 className="whats-new-title">
            {version
              ? tDetail("whats_new.version", { version })
              : tDetail("whats_new.latest")}
            {releasedAt && (
              <span className="whats-new-date">
                {" "}
                · {formatDate(releasedAt)}
              </span>
            )}
          </h2>
        </div>
        {isLong && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setExpanded(!expanded)}
            type="button"
          >
            {expanded
              ? tDetail("whats_new.collapse")
              : tDetail("whats_new.expand")}
          </button>
        )}
      </div>
      <pre
        className={`whats-new-body ${expanded ? "" : "whats-new-body-clamped"}`}
      >
        {whatsNew}
      </pre>
    </section>
  );
}

// ── Privacy Type Section ──────────────────────────────────────────────

function PrivacyTypeSection({
  privacyType,
  profile,
}: {
  privacyType: PrivacyType;
  /** Saved user profile; null disables all mismatch highlighting. */
  profile: PrivacyProfile | null;
}) {
  // i18n — for the "exceeds your privacy profile" aria-label on
  // mismatch indicators inside this section.
  const tDetail = useTranslations("app_detail");
  // Category labels + descriptions, threaded through the helpers from
  // lib/i18n-meta.ts so each card renders Apple's Simplified Chinese
  // glossary entries when the active locale is `zh`. Re-declared here
  // (rather than passed as a prop from the parent) because
  // PrivacyTypeSection runs as its own component — the parent's
  // `tCategory` / `tCategoryDesc` aren't in scope across the boundary.
  const tCategory = useTranslations("category");
  const tCategoryDesc = useTranslations("category_descriptions");
  // Reused from AppGrid — `app_grid.n_categories_aria` is the byte-identical
  // "{n} categories" plural the visible count below needs.
  const tAppGrid = useTranslations("app_grid");
  // Severity badge label + tooltip, and the tier words in the mismatch
  // tooltip, all resolve through their shared locale namespaces; the
  // English meta maps stay as fallbacks for unknown identifiers.
  const tSeverity = useTranslations("severity");
  const tTierShort = useTranslations("privacy_profile_tier_short");
  const [open, setOpen] = useState(true); // default open
  const sev = SEVERITY_CONFIG[privacyType.identifier];
  const sevLabel =
    i18nSeverityLabel(tSeverity, privacyType.identifier) ??
    sev?.label ??
    privacyType.title;
  const sevDescription =
    i18nSeverityDescription(tSeverity, privacyType.identifier) ??
    sev?.description;
  // Stable ids so aria-controls / id match even across re-renders.
  const panelId = `accordion-panel-${privacyType.identifier}`;
  const headerId = `accordion-header-${privacyType.identifier}`;

  // Translate the privacy-type identifier to the data-use tier the profile
  // compares against. "DATA_NOT_LINKED_TO_YOU" → "not_linked", etc. Unknown
  // identifiers fall through to no tier, disabling highlighting for this row.
  const typeTier = TYPE_IDENTIFIER_TO_TIER[privacyType.identifier] ?? null;

  // Pre-compute which categories exceed the profile threshold. We key by the
  // category identifier so the loop below stays cheap even with larger
  // privacy-type shelves.
  const mismatchedCats = new Set<string>();
  if (profile && typeTier) {
    const observedRank = TIER_RANK[typeTier];
    for (const cat of privacyType.categories) {
      const allowed = profile[cat.identifier];
      if (!allowed) {
        continue; // "no preference" — skip silently
      }
      if (observedRank > TIER_RANK[allowed]) {
        mismatchedCats.add(cat.identifier);
      }
    }
  }
  const hasMismatches = mismatchedCats.size > 0;

  return (
    <div className="accordion-section">
      {/*
        Accordion header. The toggle is a real `<button>` (wrapping the
        severity badge — the section's visible title) with the
        `InfoTooltip` as its SIBLING, not a descendant: the previous
        role="button" div wrapped the tooltip's own <button>, which is
        the axe `nested-interactive` violation (a focusable control
        inside a control). The row div keeps a plain onClick as a
        pointer-only convenience so the whole header stays clickable —
        same blessed pattern as the modal overlays (see biome.jsonc);
        keyboard and AT users get the native button.
      */}
      <div className="accordion-header" onClick={() => setOpen(!open)}>
        <div className="accordion-header-left">
          <div className="tooltip-inline">
            <button
              aria-controls={panelId}
              aria-expanded={open}
              className="inline-header-toggle"
              id={headerId}
              onClick={(e) => {
                // The row's convenience onClick would double-toggle.
                e.stopPropagation();
                setOpen(!open);
              }}
              type="button"
            >
              <span className={`severity-badge ${sev?.cls ?? "severity-none"}`}>
                <PrivacyTypeIcon identifier={privacyType.identifier} />
                {sevLabel}
              </span>
            </button>
            {sevDescription && <InfoTooltip text={sevDescription} />}
          </div>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            {tAppGrid("n_categories_aria", {
              count: privacyType.categories.length,
            })}
          </span>
          {hasMismatches && (
            <span
              aria-label={tDetail("mismatch_chip.aria", {
                count: mismatchedCats.size,
              })}
              className="accordion-mismatch-chip"
              title={tDetail("tooltips.categories_exceed_profile")}
            >
              {tDetail("mismatch_chip.label", { count: mismatchedCats.size })}
            </span>
          )}
        </div>
        <span
          aria-hidden="true"
          style={{
            color: "var(--text-3)",
            fontSize: 12,
            transition: "transform 0.2s",
            transform: open ? "rotate(180deg)" : "none",
          }}
        >
          ▼
        </span>
      </div>

      {open && (
        <section
          aria-labelledby={headerId}
          className="accordion-body"
          id={panelId}
        >
          {privacyType.detail && (
            <p
              style={{
                fontSize: 13,
                color: "var(--text-2)",
                marginBottom: 16,
                lineHeight: 1.5,
              }}
            >
              {privacyType.detail}
            </p>
          )}
          <div className="category-grid">
            {privacyType.categories.map((cat) => {
              const meta = CATEGORY_META[cat.identifier];
              const isMismatch = mismatchedCats.has(cat.identifier);
              // Localised category label + description. Falls back to the
              // English META shape when the identifier isn't in the locale
              // bundle (new identifier we haven't translated yet) — same
              // pattern used everywhere else categoryLabel / categoryDescription
              // are wired.
              const localisedLabel =
                i18nCategoryLabel(tCategory, cat.identifier) ??
                meta?.label ??
                cat.title;
              const localisedDescription =
                i18nCategoryDescription(tCategoryDesc, cat.identifier) ??
                meta?.description;
              // Build a plain-language tooltip for mismatches so hovering a
              // flagged card explains the rule instead of just asserting it.
              const mismatchTitle = (() => {
                if (!(isMismatch && typeTier)) {
                  return;
                }
                const allowed = profile?.[cat.identifier];
                if (!allowed) {
                  return;
                }
                const observedLabel = tTierShort(typeTier).toLowerCase();
                const allowedLabel = tTierShort(allowed).toLowerCase();
                return tDetail("mismatch_title", {
                  label: localisedLabel,
                  observed: observedLabel,
                  allowed: allowedLabel,
                });
              })();
              return (
                /*
                  Wrapper exists so the InfoTooltip can sit BESIDE the
                  Link rather than inside it. HTML disallows interactive
                  descendants (the tooltip's <button>) inside an <a>
                  (which is what next/link renders). The wrapper is
                  position:relative so the tooltip overlay can absolute-
                  position itself over the header's icon slot — visually
                  identical to before, but the DOM tree is now flat from
                  the Link's perspective. Native link semantics
                  (Cmd-click, middle-click, right-click → "Open in new
                  tab") are preserved.
                */
                <div className="category-card-wrapper" key={cat.id}>
                  <Link
                    className={`category-card category-card-link${isMismatch ? " category-card-mismatch" : ""}`}
                    href={`/dashboard/privacy#cat-${privacyType.identifier}-${cat.identifier}`}
                    title={
                      mismatchTitle ?? tDetail("category_other_apps_title")
                    }
                  >
                    {/*
                      Mismatch flag is pinned to the top-right of the card
                      via CSS (absolute positioning) — living outside the
                      header flex flow keeps it in a consistent corner
                      regardless of how long the category label is. The
                      card itself also picks up a rose tint via
                      `.category-card-mismatch` so the whole card reads
                      as "doesn't match your profile" at a glance.
                    */}
                    {isMismatch && (
                      <span
                        aria-label={tDetail("actions.exceeds_profile_aria")}
                        className="category-card-mismatch-flag"
                      >
                        ⚠
                      </span>
                    )}
                    <div className="category-card-header">
                      <span className="category-card-icon">
                        {meta?.icon ?? "📂"}
                      </span>
                      <span aria-hidden="true" className="category-card-arrow">
                        →
                      </span>
                    </div>
                    <span className="category-card-label">
                      {localisedLabel}
                    </span>
                  </Link>
                  {/*
                    Info tooltip sits OUTSIDE the Link, absolutely
                    positioned to overlay the spot where the icon is.
                    Without this restructure the tooltip's <button>
                    would be a descendant of <a>, which HTML disallows.
                  */}
                  {localisedDescription && (
                    <span className="category-card-info-overlay">
                      <InfoTooltip side="right" text={localisedDescription} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Accessibility panel — renders the declared-feature list for an app
 * alongside the canonical baseline, so users can see at a glance which
 * features Apple publishes support fields for AND which ones the
 * developer has actually claimed. When the shelf is present but empty,
 * the panel says so plainly instead of pretending the tab has content.
 *
 * Kept deliberately server-source-free: all data comes from the `app`
 * prop the server component already loaded via `getAppWithPrivacy`.
 */
function AccessibilityPanel({
  app,
  formatDate,
  a11yProfile,
}: {
  app: App;
  formatDate: (ts: number) => string;
  /** Saved accessibility profile; null means "no preferences set". */
  a11yProfile: AccessibilityProfile | null;
}) {
  // i18n — for the "Your accessibility preferences" aria-label on the
  // profile chip rendered inside this panel.
  const tDetail = useTranslations("app_detail");
  const declared = app.accessibilityFeatures ?? [];
  const declaredByIdentifier = new Map(declared.map((f) => [f.identifier, f]));

  // Merge: canonical first (in the order Apple lists them on the App Store
  // shelf), followed by any declared features we don't recognise as
  // canonical. This ordering keeps the UI stable across Apple catalog
  // changes — adding a new feature Apple publishes won't reshuffle the list.
  interface Row {
    canonical: CanonicalAccessibilityFeature | null;
    declared: boolean;
    description: string | null;
    key: string;
    /** User's preference for this feature; null when unset. */
    preference: AccessibilityPreference | null;
    title: string;
  }

  // Normalise the profile into a quick-lookup map even when the caller
  // passed `null` so the row builder can do a single `profileLookup.get`
  // per feature without a branch. Features the user hasn't set stay
  // `undefined` in the map and surface as `preference: null` on the row.
  const profileLookup = new Map<string, AccessibilityPreference>();
  if (a11yProfile) {
    for (const [key, value] of Object.entries(a11yProfile)) {
      if (typeof value === "string") {
        profileLookup.set(key, value);
      }
    }
  }

  const rows: Row[] = [];
  for (const canonical of CANONICAL_ACCESSIBILITY_FEATURES) {
    const hit = declaredByIdentifier.get(canonical.identifier);
    rows.push({
      key: canonical.identifier,
      title: canonical.title,
      description: hit?.description ?? canonical.fallbackDescription ?? null,
      declared: !!hit,
      canonical,
      preference: profileLookup.get(canonical.identifier) ?? null,
    });
    if (hit) {
      declaredByIdentifier.delete(canonical.identifier);
    }
  }
  for (const extra of declaredByIdentifier.values()) {
    rows.push({
      key: extra.identifier,
      title: extra.title,
      description: extra.description,
      declared: true,
      canonical: null,
      preference: profileLookup.get(extra.identifier) ?? null,
    });
  }

  const declaredCount = declared.length;
  const canonicalCount = CANONICAL_ACCESSIBILITY_FEATURES.length;
  const coveragePct = canonicalCount
    ? Math.round(
        (rows.filter((r) => r.declared && r.canonical).length /
          canonicalCount) *
          100
      )
    : 0;

  // Aggregate counts for the profile key card — how many features the user
  // has marked at each tier, and how many of those this app declares vs
  // misses. Used to populate the key header above the feature list.
  const preferenceStats: Record<
    AccessibilityPreference,
    { total: number; missing: number }
  > = {
    required: { total: 0, missing: 0 },
    nice: { total: 0, missing: 0 },
  };
  const declaredIdentifiers = new Set(declared.map((f) => f.identifier));
  for (const [key, preference] of profileLookup) {
    preferenceStats[preference].total += 1;
    if (!declaredIdentifiers.has(key)) {
      preferenceStats[preference].missing += 1;
    }
  }
  const profileActive = profileLookup.size > 0;
  const totalPreferred = profileLookup.size;
  const totalMissingPreferred =
    preferenceStats.required.missing + preferenceStats.nice.missing;

  return (
    <div className="a11y-panel">
      {/* Summary card — headline "X of Y declared" so users can size up
          coverage at a glance before scanning the per-feature list. */}
      <div className="a11y-summary-card">
        <div className="a11y-summary-headline">
          <span className="a11y-summary-count">{declaredCount}</span>
          <span className="a11y-summary-total">
            {tDetail("a11y_summary.of_total", { count: canonicalCount })}
          </span>
        </div>
        <div className="a11y-summary-sub">
          {app.hasAccessibilityLabels === 1
            ? tDetail("a11y_summary.coverage", { pct: coveragePct })
            : tDetail("a11y_summary.shelf_empty")}{" "}
          <span className="a11y-summary-synced">
            {tDetail("a11y_summary.last_synced", {
              date: formatDate(app.lastSynced),
            })}
          </span>
        </div>
      </div>

      {/* Profile key — shown only when the user has saved at least one
          preference. Acts as a legend for the teal highlight on preferred
          rows below, and summarises how well this app matches their
          profile in a single glance. */}
      {profileActive && (
        <div
          aria-label={tDetail("actions.your_a11y_prefs_aria")}
          className={`a11y-profile-key${
            totalMissingPreferred === 0 ? "a11y-profile-key-match" : ""
          }`}
          role="note"
        >
          <div className="a11y-profile-key-header">
            <span className="a11y-profile-key-eyebrow">
              {tDetail("actions.your_a11y_prefs_aria")}
            </span>
            <span className="a11y-profile-key-summary">
              {totalMissingPreferred === 0
                ? tDetail("a11y_profile_key_all_declared", {
                    count: totalPreferred,
                  })
                : tDetail("a11y_profile_key_missing_count", {
                    missing: totalMissingPreferred,
                    total: totalPreferred,
                  })}
            </span>
          </div>
          <div className="a11y-profile-key-tiers">
            {preferenceStats.required.total > 0 && (
              <span className="a11y-profile-key-tier a11y-profile-key-tier-required">
                <span aria-hidden="true" className="a11y-profile-key-swatch" />
                <strong>{preferenceStats.required.total}</strong>{" "}
                {tDetail("a11y_profile_key_tier_required")}
                {preferenceStats.required.missing > 0 && (
                  <span className="a11y-profile-key-tier-missing">
                    {tDetail("a11y_profile_key_tier_missing", {
                      count: preferenceStats.required.missing,
                    })}
                  </span>
                )}
              </span>
            )}
            {preferenceStats.nice.total > 0 && (
              <span className="a11y-profile-key-tier a11y-profile-key-tier-nice">
                <span aria-hidden="true" className="a11y-profile-key-swatch" />
                <strong>{preferenceStats.nice.total}</strong>{" "}
                {tDetail("a11y_profile_key_tier_nice")}
                {preferenceStats.nice.missing > 0 && (
                  <span className="a11y-profile-key-tier-missing">
                    {tDetail("a11y_profile_key_tier_missing", {
                      count: preferenceStats.nice.missing,
                    })}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="a11y-profile-key-hint">
            {tDetail.rich("a11y_profile_key_hint", {
              link: (chunks) => (
                <Link href="/dashboard/settings/you#accessibility-profile">
                  {chunks}
                </Link>
              ),
            })}
          </div>
        </div>
      )}

      {/* Informational note — self-declared labels are a signal, not proof. */}
      <p className="a11y-disclaimer" role="note">
        <span aria-hidden="true">ⓘ</span> {tDetail("a11y_disclaimer")}
      </p>

      <div className="a11y-feature-list">
        {rows.map((row) => (
          <div
            className={[
              "a11y-feature-row",
              row.declared ? "is-declared" : "is-missing",
              row.preference ? `has-preference pref-${row.preference}` : "",
              row.preference && !row.declared ? "preference-missing" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={row.key}
          >
            <div aria-hidden="true" className="a11y-feature-status">
              {row.declared ? (
                <svg
                  aria-hidden="true"
                  fill="none"
                  height="18"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  viewBox="0 0 24 24"
                  width="18"
                >
                  <polyline points="4 12 10 18 20 6" />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  fill="none"
                  height="18"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  viewBox="0 0 24 24"
                  width="18"
                >
                  <line x1="6" x2="18" y1="6" y2="18" />
                  <line x1="18" x2="6" y1="6" y2="18" />
                </svg>
              )}
            </div>
            <div className="a11y-feature-body">
              <div className="a11y-feature-title">
                {row.title}
                {!row.canonical && (
                  <span
                    className="a11y-feature-new-badge"
                    title={tDetail("tooltips.a11y_feature_post_build")}
                  >
                    {tDetail("a11y_feature_new_badge")}
                  </span>
                )}
                {row.preference && (
                  <span
                    className={`a11y-feature-pref-chip a11y-feature-pref-chip-${row.preference}`}
                    title={tDetail(`a11y_pref_chip.${row.preference}_desc`)}
                  >
                    {tDetail(`a11y_pref_chip.${row.preference}`)}
                  </span>
                )}
              </div>
              {row.description && (
                <div className="a11y-feature-desc">{row.description}</div>
              )}
              <div
                aria-label={
                  row.declared
                    ? tDetail("a11y_state.declared_aria")
                    : tDetail("a11y_state.not_declared_aria")
                }
                className="a11y-feature-state"
              >
                {row.declared
                  ? tDetail("a11y_state.declared_label")
                  : tDetail("a11y_state.not_declared_label")}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

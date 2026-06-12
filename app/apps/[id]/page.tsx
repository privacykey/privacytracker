import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { AccessibilityProfile } from "../../../lib/accessibility-profile";
import { getAccessibilityProfile } from "../../../lib/accessibility-profile-server";
import { type AgeBandKey, isValidAgeBand } from "../../../lib/age-rating";
import { normalizeAiProvider } from "../../../lib/ai-config";
import {
  getChangelog,
  getUnacknowledgedChanges,
  type UnacknowledgedChanges,
} from "../../../lib/changelog";
import { getActiveFocus } from "../../../lib/feature-flag-storage";
import { resolveFlagFromDb } from "../../../lib/feature-flags-server";
import {
  type AppImportProvenance,
  getAppImportProvenance,
} from "../../../lib/imports";
import {
  getRecentPolicyChange,
  type RecentPolicyChange,
} from "../../../lib/policy-versions";
import type { PrivacyProfile } from "../../../lib/privacy-profile";
import { getPrivacyProfile } from "../../../lib/privacy-profile-server";
import { getSetting, setSettingIfUnset } from "../../../lib/scheduler";
import { getAppWithPrivacy } from "../../../lib/scraper";
import AppDetailView, {
  type DetailFlagState,
} from "../../components/AppDetailView";
import Nav from "../../components/Nav";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  try {
    const { id } = await params;
    const app = getAppWithPrivacy(id) as any;
    if (app) {
      return { title: t("app_detail_title", { name: app.name }) };
    }
  } catch (error) {
    console.warn("[app-detail] generateMetadata failed:", error);
  }
  return { title: t("app_detail_fallback") };
}

export default async function AppDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  let app: any = null;
  let changelog: any[] = [];
  let unacknowledged: UnacknowledgedChanges = {
    since: 0,
    events: [],
    totalCount: 0,
    addedCount: 0,
    removedCount: 0,
    snoozedUntil: 0,
  };
  let aiProvider: any = "disabled";
  let recentPolicyChange: RecentPolicyChange | null = null;
  let policyDiffAlertDays = 90;
  let privacyProfile: PrivacyProfile | null = null;
  // Saved accessibility profile — feature → 'required' | 'nice'. Drives the
  // "your preferences" key at the top of the accessibility tab and the teal
  // border highlight on preferred-feature rows. Missing profile falls back
  // to the legacy unmarked rendering.
  let a11yProfile: AccessibilityProfile | null = null;
  // Provenance for the "imported on …" footer at the bottom of the detail
  // page. May be null for legacy apps that predate the import-items write
  // path — the footer degrades gracefully to "imported" (no date / fix-link)
  // so the UI doesn't crash the page when history is missing.
  let importProvenance: AppImportProvenance | null = null;
  // Default visibility for Wayback-imported rows in the timeline. Read from
  // the `wayback_show_imported` setting so the user's global preference
  // flows through to each per-app view; they can still flip the inline
  // toggle on the timeline for an ad-hoc compare without re-saving
  // settings.
  let waybackShowImportedDefault = true;
  // Server-hydrated value of the `track_accessibility_labels` setting. The
  // client uses it to decide whether to render the accessibility chip/tab.
  // Stored as 'true'/'false'; anything non-'false' is treated as on so
  // pre-feature installs default to showing the new surface.
  let trackAccessibility = true;
  // Guardian child age band — drives the header age-rating verdict chip.
  let childAgeBand: AgeBandKey | null = null;

  try {
    const { id } = await params;
    app = getAppWithPrivacy(id);
    changelog = getChangelog(id);
    unacknowledged = getUnacknowledgedChanges(id);
    aiProvider = normalizeAiProvider(getSetting("ai_provider", "disabled"));

    // Honour the configurable alert window (default 90 days). The banner
    // is intentionally derived here on the server — the alert should be
    // consistent with the policy_version_id we deep-link to, and the
    // AI Policy tab is already force-dynamic so it rehydrates each visit.
    const raw = Number.parseInt(getSetting("policy_diff_alert_days", "90"), 10);
    if (Number.isFinite(raw) && raw >= 0) {
      policyDiffAlertDays = raw;
    }
    if (app) {
      recentPolicyChange = getRecentPolicyChange(app.id, policyDiffAlertDays);
    }

    // Load the saved privacy profile once — AppDetailView uses it to draw a
    // border around any (privacy-type, category) pair whose observed tier
    // exceeds the user's allowed threshold. Missing / unset profile → null,
    // and the view falls back to its previous unmarked rendering.
    privacyProfile = getPrivacyProfile();

    // Load the saved accessibility profile once — mirrors privacy profile.
    // `getAccessibilityProfile` returns null when the user hasn't set any
    // preferences, which the detail view interprets as "render no
    // preference chrome" (same as legacy behaviour).
    a11yProfile = getAccessibilityProfile();

    // Source-of-truth for the "imported on …" footer. Safe to call before
    // the `if (!app)` guard below because we've already loaded the app;
    // wrap in its own try so a schema drift here doesn't blank the whole
    // detail page.
    if (app) {
      try {
        importProvenance = getAppImportProvenance(app.id);
      } catch (provenanceError) {
        console.warn(
          "[app-detail] getAppImportProvenance failed:",
          provenanceError
        );
      }
    }

    // The "show Wayback imports in timelines" setting is stored as 'true'/
    // 'false' for consistency with other boolean flags; treat anything that
    // isn't literally 'false' as on so installs pre-dating the feature
    // default to showing imports after they run the backfill.
    waybackShowImportedDefault =
      getSetting("wayback_show_imported", "true") !== "false";

    trackAccessibility =
      getSetting("track_accessibility_labels", "true") !== "false";

    const rawBand = getSetting("guardian_child_age_band", "");
    childAgeBand = isValidAgeBand(rawBand) ? rawBand : null;
  } catch (error) {
    // DB not ready
    console.warn("[app-detail] Could not load app/changelog/settings:", error);
  }

  if (!app) {
    notFound();
  }

  // First-visit marker for the user-tasks `open_any_app_detail`
  // completion check. Idempotent: once set, every subsequent render is a
  // single SELECT no-op. We only stamp after the `notFound()` check so a
  // bogus url doesn't count as "visited an app detail."
  try {
    setSettingIfUnset("task_visit.app_detail_at", String(Date.now()));
  } catch (e) {
    console.warn("[app-detail] task visit marker failed:", e);
  }

  // Round 3 wave F: pre-resolve every flag.detail.* server-side so the
  // first paint is correct. Errors fall back to a sensible all-on default
  // so a broken resolver doesn't take down the page.
  const detailFlags: DetailFlagState = (() => {
    try {
      const focus = getActiveFocus();
      const r = (k: Parameters<typeof resolveFlagFromDb>[0]) =>
        resolveFlagFromDb(k) === "on";
      return {
        annotationsSidebar: resolveFlagFromDb(
          "flag.detail.annotations_sidebar"
        ),
        audience: focus.audience,
        guardianAgeRating: r("flag.guardian.age_rating"),
        headerFreshnessBadge: r("flag.detail.header.freshness_badge"),
        headerChangeCountBadge: r("flag.detail.header.change_count_badge"),
        headerA11yCountChip: r("flag.detail.header.a11y_count_chip"),
        tabsCompare: r("flag.detail.tabs.compare"),
        actionsResyncButton: r("flag.detail.actions.resync_button"),
        actionsDeleteButton: r("flag.detail.actions.delete_button"),
        footerImportProvenance: r("flag.detail.footer.import_provenance"),
        labelsCards: r("flag.detail.labels.cards"),
        labelsProfileMismatchBadges: r(
          "flag.detail.labels.profile_mismatch_badges"
        ),
        labelsNoDetailsWarning: r("flag.detail.labels.no_details_warning"),
        policyPanel: r("flag.detail.policy.panel"),
        policyAiSummary: r("flag.detail.policy.ai_summary"),
        policyLensGrid: r("flag.detail.policy.lens_grid"),
        policySafetySummary: r("flag.detail.policy.safety_summary"),
        policyHighlights: r("flag.detail.policy.highlights"),
        policyChangeStrip: r("flag.detail.policy.change_strip"),
        policyChunkNotes: r("flag.detail.policy.chunk_notes"),
        policyRunLogStrip: r("flag.detail.policy.run_log_strip"),
        policyRunLogDetails: r("flag.detail.policy.run_log_details"),
        policyFallbackReferences: r("flag.detail.policy.fallback_references"),
        policyWaybackBackupLink: r("flag.detail.policy.wayback_backup_link"),
        policySourcePolicyLink: r("flag.detail.policy.source_policy_link"),
        policyRecentChangeBanner: r("flag.detail.policy.recent_change_banner"),
        policyWhatsNew: r("flag.detail.policy.whats_new"),
        policyRescrapeButton: r("flag.detail.policy.rescrape_button"),
        policySummariseButton: r("flag.detail.policy.summarise_button"),
        policyRescrapeSummariseButton: r(
          "flag.detail.policy.rescrape_summarise_button"
        ),
        policyPreviewToggle: r("flag.detail.policy.preview_toggle"),
        policyAiSummaryDisclaimer: r(
          "flag.detail.policy.ai_summary_disclaimer"
        ),
        a11yPanel: r("flag.detail.a11y.panel"),
        a11yPreferenceHighlights: r("flag.detail.a11y.preference_highlights"),
        reviewPanel: r("flag.detail.review.panel"),
        reviewMarkReviewed: r("flag.detail.review.mark_reviewed"),
        reviewDismiss: r("flag.detail.review.dismiss"),
        reviewSnoozeMenu: r("flag.detail.review.snooze_menu"),
        reviewSnoozedPanel: r("flag.detail.review.snoozed_panel"),
        timelineLiveRows: r("flag.detail.timeline.live_rows"),
        timelineWaybackRows: r("flag.detail.timeline.wayback_rows"),
        timelineWaybackToggle: r("flag.detail.timeline.wayback_toggle"),
        timelineTriggerPills: r("flag.detail.timeline.trigger_pills"),
        timelineVersionChip: r("flag.detail.timeline.version_chip"),
        timelineMatchesLiveSyncBadge: r(
          "flag.detail.timeline.matches_live_sync_badge"
        ),
        timelineReviewRows: r("flag.detail.timeline.review_rows"),
        timelineReviewSnapshotChips: r(
          "flag.detail.timeline.review_snapshot_chips"
        ),
        timelinePolicyPreviewToggle: r(
          "flag.detail.timeline.policy_preview_toggle"
        ),
        timelinePolicyDiffToggle: r("flag.detail.timeline.policy_diff_toggle"),
        chartsCategoryTrend: r("flag.detail.charts.category_trend"),
        chartsTrendPresets: r("flag.detail.charts.trend_presets"),
        chartsTrendLegend: r("flag.detail.charts.trend_legend"),
      };
    } catch (error) {
      console.warn("[app-detail] flag resolution failed:", error);
      // All-on default. Mirrors the per-prop fallbacks inside AppDetailView's
      // `f` block so behaviour is consistent across the two failure paths.
      return {
        annotationsSidebar: "collapsed",
        audience: "self",
        // Guarded surface — stays off when the resolver is down.
        guardianAgeRating: false,
        headerFreshnessBadge: true,
        headerChangeCountBadge: true,
        headerA11yCountChip: true,
        tabsCompare: true,
        actionsResyncButton: true,
        actionsDeleteButton: true,
        footerImportProvenance: true,
        labelsCards: true,
        labelsProfileMismatchBadges: true,
        labelsNoDetailsWarning: true,
        policyPanel: true,
        policyAiSummary: true,
        policyLensGrid: true,
        policySafetySummary: false,
        policyHighlights: true,
        policyChangeStrip: true,
        policyChunkNotes: true,
        policyRunLogStrip: true,
        policyRunLogDetails: true,
        policyFallbackReferences: true,
        policyWaybackBackupLink: true,
        policySourcePolicyLink: true,
        policyRecentChangeBanner: true,
        policyWhatsNew: true,
        policyRescrapeButton: true,
        policySummariseButton: true,
        policyRescrapeSummariseButton: true,
        policyPreviewToggle: true,
        policyAiSummaryDisclaimer: true,
        a11yPanel: true,
        a11yPreferenceHighlights: true,
        reviewPanel: true,
        reviewMarkReviewed: true,
        reviewDismiss: true,
        reviewSnoozeMenu: true,
        reviewSnoozedPanel: true,
        timelineLiveRows: true,
        timelineWaybackRows: true,
        timelineWaybackToggle: true,
        timelineTriggerPills: true,
        timelineVersionChip: true,
        timelineMatchesLiveSyncBadge: true,
        timelineReviewRows: true,
        timelineReviewSnapshotChips: true,
        timelinePolicyPreviewToggle: true,
        timelinePolicyDiffToggle: true,
        chartsCategoryTrend: true,
        chartsTrendPresets: true,
        chartsTrendLegend: true,
      };
    }
  })();

  return (
    <>
      <Nav />
      <AppDetailView
        a11yProfile={a11yProfile}
        aiProvider={aiProvider}
        app={app}
        changelog={changelog}
        childAgeBand={childAgeBand}
        detailFlags={detailFlags}
        importProvenance={importProvenance}
        policyDiffAlertDays={policyDiffAlertDays}
        privacyProfile={privacyProfile}
        recentPolicyChange={recentPolicyChange}
        trackAccessibility={trackAccessibility}
        unacknowledged={unacknowledged}
        waybackShowImportedDefault={waybackShowImportedDefault}
      />
    </>
  );
}

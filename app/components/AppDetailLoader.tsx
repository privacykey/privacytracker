"use client";

import { notFound, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useFlagBundleStatus, useFlagValues } from "@/lib/use-flag-bundle";
import AppDetailView, { type DetailFlagState } from "./AppDetailView";
import Nav from "./Nav";
import RecordTaskVisit from "./RecordTaskVisit";

/**
 * Client loader for /apps/[id] (Rust-core Phase 0).
 *
 * The page did seventeen server reads; they now come from one aggregate,
 * `GET /api/apps/[id]/detail`, plus the shared flag bundle. Five things
 * here are deliberate and each guards against a way the port would have
 * silently regressed:
 *
 * 1. ALL-OR-NOTHING MOUNT. AppDetailView stages `unacknowledged` into
 *    useState once with no sync effect, and its tab strip is shaped by a
 *    flag × a setting × an app field. Mounting it with placeholders and
 *    filling in later would freeze the review panel at "no changes" and
 *    re-shape the tabs after first paint. Nothing renders until the
 *    payload AND the flag bundle have both landed.
 * 2. FLAGS FAIL OPEN. The page's resolver catch fell back to an all-on
 *    DetailFlagState (a broken resolver still gave a working page);
 *    useFlagBundle fails closed. On `failedToLoad` the page's own all-on
 *    literal is substituted — the DetailFlagState analogue of
 *    RequireFlagGate's failOpen.
 * 3. TRI-STATE READ. `annotationsSidebar` is "on" | "off" | "collapsed"
 *    with a hard default of "collapsed"; it's read raw via useFlagValues,
 *    never coerced with `=== "on"` (which would hide the rail for the
 *    default self audience).
 * 4. TASK VISIT AFTER THE 404. The first-visit marker is rendered inside
 *    the success branch, so /apps/999999999 does not complete the
 *    "open any app detail" checklist item — the page stamped it only
 *    after its notFound() guard for the same reason.
 * 5. REFETCH, NOT router.refresh(). Four call sites relied on the server
 *    component re-running after a mutation; that's a no-op for a shell.
 *    The loader's refetch is threaded in as `onRefresh`.
 *
 * Failure mode: a 400/404 is a real notFound(); any other failure shows
 * a retry state rather than a blank page.
 */

const DETAIL_FLAG_KEYS = [
  "flag.detail.annotations_sidebar",
  "flag.guardian.age_rating",
  "flag.detail.header.freshness_badge",
  "flag.detail.header.change_count_badge",
  "flag.detail.header.a11y_count_chip",
  "flag.detail.tabs.compare",
  "flag.detail.actions.resync_button",
  "flag.detail.actions.delete_button",
  "flag.detail.footer.import_provenance",
  "flag.detail.labels.cards",
  "flag.detail.labels.profile_mismatch_badges",
  "flag.detail.labels.no_details_warning",
  "flag.detail.policy.panel",
  "flag.detail.policy.ai_summary",
  "flag.detail.policy.lens_grid",
  "flag.detail.policy.safety_summary",
  "flag.detail.policy.highlights",
  "flag.detail.policy.change_strip",
  "flag.detail.policy.chunk_notes",
  "flag.detail.policy.run_log_strip",
  "flag.detail.policy.run_log_details",
  "flag.detail.policy.fallback_references",
  "flag.detail.policy.wayback_backup_link",
  "flag.detail.policy.source_policy_link",
  "flag.detail.policy.recent_change_banner",
  "flag.detail.policy.whats_new",
  "flag.detail.policy.rescrape_button",
  "flag.detail.policy.summarise_button",
  "flag.detail.policy.rescrape_summarise_button",
  "flag.detail.policy.preview_toggle",
  "flag.detail.policy.ai_summary_disclaimer",
  "flag.detail.a11y.panel",
  "flag.detail.a11y.preference_highlights",
  "flag.detail.review.panel",
  "flag.detail.review.mark_reviewed",
  "flag.detail.review.dismiss",
  "flag.detail.review.snooze_menu",
  "flag.detail.review.snoozed_panel",
  "flag.detail.timeline.live_rows",
  "flag.detail.timeline.wayback_rows",
  "flag.detail.timeline.wayback_toggle",
  "flag.detail.timeline.trigger_pills",
  "flag.detail.timeline.version_chip",
  "flag.detail.timeline.matches_live_sync_badge",
  "flag.detail.timeline.review_rows",
  "flag.detail.timeline.review_snapshot_chips",
  "flag.detail.timeline.policy_preview_toggle",
  "flag.detail.timeline.policy_diff_toggle",
  "flag.detail.charts.category_trend",
  "flag.detail.charts.trend_presets",
  "flag.detail.charts.trend_legend",
] as const;

type Payload = Omit<
  Parameters<typeof AppDetailView>[0],
  "detailFlags" | "onRefresh"
> & { audience: DetailFlagState["audience"] };

/**
 * The page's resolver-failure fallback, verbatim: all on except the two
 * guarded surfaces, and the tri-state sidebar at its hard default.
 */
const ALL_ON_FLAGS: DetailFlagState = {
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

export default function AppDetailLoader() {
  const tMeta = useTranslations("page_metadata");
  const tError = useTranslations("loader_error");
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [data, setData] = useState<Payload | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ready" | "missing" | "error"
  >("loading");
  // Bumping this re-runs the fetch: the `onRefresh` hook for mutations.
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  const flagValues = useFlagValues(DETAIL_FLAG_KEYS);
  const { failedToLoad } = useFlagBundleStatus();

  useEffect(() => {
    if (!id) {
      return;
    }
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(id)}/detail`)
      .then((res) => {
        if (res.status === 404 || res.status === 400) {
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(new Error(`HTTP ${res.status}`));
      })
      .then((json: Payload | null) => {
        if (!live) {
          return;
        }
        if (json) {
          setData(json);
          setStatus("ready");
          document.title = tMeta("app_detail_title", { name: json.app.name });
        } else {
          setStatus("missing");
        }
      })
      .catch((error) => {
        console.warn("[app-detail] load failed:", error);
        if (live) {
          setStatus("error");
        }
      });
    return () => {
      live = false;
    };
  }, [id, nonce]);

  if (status === "missing") {
    notFound();
  }

  if (status === "error") {
    return (
      <>
        <Nav />
        <div className="page-container">
          <div className="empty-state">
            <div className="empty-state-title">{tError("title")}</div>
            <p className="empty-state-text">
              <button
                className="btn btn-secondary"
                onClick={refetch}
                type="button"
              >
                {tError("retry")}
              </button>
            </p>
          </div>
        </div>
      </>
    );
  }

  if (!(data && flagValues)) {
    return <Nav />;
  }

  const v = flagValues;
  const detailFlags: DetailFlagState = failedToLoad
    ? { ...ALL_ON_FLAGS, audience: data.audience }
    : {
        // Raw tri-state; missing (unknown key) falls to the hard default.
        annotationsSidebar:
          (v["flag.detail.annotations_sidebar"] as
            | DetailFlagState["annotationsSidebar"]
            | undefined) ?? "collapsed",
        audience: data.audience,
        guardianAgeRating: v["flag.guardian.age_rating"] === "on",
        headerFreshnessBadge: v["flag.detail.header.freshness_badge"] === "on",
        headerChangeCountBadge:
          v["flag.detail.header.change_count_badge"] === "on",
        headerA11yCountChip: v["flag.detail.header.a11y_count_chip"] === "on",
        tabsCompare: v["flag.detail.tabs.compare"] === "on",
        actionsResyncButton: v["flag.detail.actions.resync_button"] === "on",
        actionsDeleteButton: v["flag.detail.actions.delete_button"] === "on",
        footerImportProvenance:
          v["flag.detail.footer.import_provenance"] === "on",
        labelsCards: v["flag.detail.labels.cards"] === "on",
        labelsProfileMismatchBadges:
          v["flag.detail.labels.profile_mismatch_badges"] === "on",
        labelsNoDetailsWarning:
          v["flag.detail.labels.no_details_warning"] === "on",
        policyPanel: v["flag.detail.policy.panel"] === "on",
        policyAiSummary: v["flag.detail.policy.ai_summary"] === "on",
        policyLensGrid: v["flag.detail.policy.lens_grid"] === "on",
        policySafetySummary: v["flag.detail.policy.safety_summary"] === "on",
        policyHighlights: v["flag.detail.policy.highlights"] === "on",
        policyChangeStrip: v["flag.detail.policy.change_strip"] === "on",
        policyChunkNotes: v["flag.detail.policy.chunk_notes"] === "on",
        policyRunLogStrip: v["flag.detail.policy.run_log_strip"] === "on",
        policyRunLogDetails: v["flag.detail.policy.run_log_details"] === "on",
        policyFallbackReferences:
          v["flag.detail.policy.fallback_references"] === "on",
        policyWaybackBackupLink:
          v["flag.detail.policy.wayback_backup_link"] === "on",
        policySourcePolicyLink:
          v["flag.detail.policy.source_policy_link"] === "on",
        policyRecentChangeBanner:
          v["flag.detail.policy.recent_change_banner"] === "on",
        policyWhatsNew: v["flag.detail.policy.whats_new"] === "on",
        policyRescrapeButton: v["flag.detail.policy.rescrape_button"] === "on",
        policySummariseButton:
          v["flag.detail.policy.summarise_button"] === "on",
        policyRescrapeSummariseButton:
          v["flag.detail.policy.rescrape_summarise_button"] === "on",
        policyPreviewToggle: v["flag.detail.policy.preview_toggle"] === "on",
        policyAiSummaryDisclaimer:
          v["flag.detail.policy.ai_summary_disclaimer"] === "on",
        a11yPanel: v["flag.detail.a11y.panel"] === "on",
        a11yPreferenceHighlights:
          v["flag.detail.a11y.preference_highlights"] === "on",
        reviewPanel: v["flag.detail.review.panel"] === "on",
        reviewMarkReviewed: v["flag.detail.review.mark_reviewed"] === "on",
        reviewDismiss: v["flag.detail.review.dismiss"] === "on",
        reviewSnoozeMenu: v["flag.detail.review.snooze_menu"] === "on",
        reviewSnoozedPanel: v["flag.detail.review.snoozed_panel"] === "on",
        timelineLiveRows: v["flag.detail.timeline.live_rows"] === "on",
        timelineWaybackRows: v["flag.detail.timeline.wayback_rows"] === "on",
        timelineWaybackToggle:
          v["flag.detail.timeline.wayback_toggle"] === "on",
        timelineTriggerPills: v["flag.detail.timeline.trigger_pills"] === "on",
        timelineVersionChip: v["flag.detail.timeline.version_chip"] === "on",
        timelineMatchesLiveSyncBadge:
          v["flag.detail.timeline.matches_live_sync_badge"] === "on",
        timelineReviewRows: v["flag.detail.timeline.review_rows"] === "on",
        timelineReviewSnapshotChips:
          v["flag.detail.timeline.review_snapshot_chips"] === "on",
        timelinePolicyPreviewToggle:
          v["flag.detail.timeline.policy_preview_toggle"] === "on",
        timelinePolicyDiffToggle:
          v["flag.detail.timeline.policy_diff_toggle"] === "on",
        chartsCategoryTrend: v["flag.detail.charts.category_trend"] === "on",
        chartsTrendPresets: v["flag.detail.charts.trend_presets"] === "on",
        chartsTrendLegend: v["flag.detail.charts.trend_legend"] === "on",
      };

  return (
    <>
      <Nav />
      <RecordTaskVisit surface="app_detail" />
      <AppDetailView
        a11yProfile={data.a11yProfile}
        aiProvider={data.aiProvider}
        app={data.app}
        changelog={data.changelog}
        childAgeBand={data.childAgeBand}
        detailFlags={detailFlags}
        importProvenance={data.importProvenance}
        onRefresh={refetch}
        policyDiffAlertDays={data.policyDiffAlertDays}
        privacyProfile={data.privacyProfile}
        recentPolicyChange={data.recentPolicyChange}
        trackAccessibility={data.trackAccessibility}
        unacknowledged={data.unacknowledged}
        waybackShowImportedDefault={data.waybackShowImportedDefault}
      />
    </>
  );
}

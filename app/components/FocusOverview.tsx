"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import {
  changedBeyondPreview,
  splitOverviewRows,
} from "@/lib/focus-overview-rows";
import type { FocusOverviewApp, FocusOverviewData } from "@/lib/focus-review";
import { useFlagValues } from "@/lib/use-flag-bundle";
import { withScopeParam } from "./DeviceScopeProvider";
import type { FocusSummary } from "./HomeView";
import "./focus-overview.css";

const FLAGS = [
  "flag.appgrid.review_queue.enabled",
  "flag.page.compare",
  "flag.settings.admin.export.audit_bundle",
] as const;

export function FocusGoalLabels({ focus }: { focus: FocusSummary }) {
  const t = useTranslations("focus_overview");
  const labels = [
    t(`audience.${focus.audience ?? "self"}`),
    ...(["monitor", "cleanup", "minimal", "accessibility"] as const)
      .filter((key) => focus[key])
      .map((key) => t(`goal.${key}`)),
  ];
  return (
    <span className="focus-goal-labels">
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </span>
  );
}

function OverviewRow({
  app,
  canReview,
  canCompare,
}: {
  app: FocusOverviewApp;
  canReview: boolean;
  canCompare: boolean;
}) {
  const t = useTranslations("focus_overview");
  return (
    <li>
      <div className="focus-overview-app-name">
        {app.iconUrl && <img alt="" height={36} src={app.iconUrl} width={36} />}
        <Link href={`/apps/${encodeURIComponent(app.id)}`}>{app.name}</Link>
      </div>
      <div className="focus-overview-app-status">
        {app.changeCount > 0 && (
          <span>{t("app_changes", { count: app.changeCount })}</span>
        )}
        {(canReview || app.decision !== "review") && (
          <span>
            {t(`decision.${app.decision}`)}
            {app.remindAt && app.decision !== "due"
              ? ` · ${new Date(app.remindAt).toLocaleDateString()}`
              : ""}
          </span>
        )}
      </div>
      {app.decision === "due" ? (
        <div className="focus-overview-app-actions">
          <Link
            className="btn btn-primary btn-sm"
            href={`/apps/${encodeURIComponent(app.id)}#verdict-picker-heading`}
          >
            {t("review_now")}
          </Link>
          <Link
            className="btn btn-secondary btn-sm"
            href={`/apps/${encodeURIComponent(app.id)}#review-reminder`}
          >
            {t("reschedule")}
          </Link>
        </div>
      ) : canCompare && app.decision === "replace" ? (
        <Link
          className="btn btn-secondary btn-sm"
          href={`/dashboard/compare?a=id:${encodeURIComponent(app.id)}&from=review`}
        >
          {t("find_compare")}
        </Link>
      ) : (
        <Link
          className="btn btn-ghost btn-sm"
          href={`/apps/${encodeURIComponent(app.id)}${canReview ? "#verdict-picker-heading" : ""}`}
        >
          {t(canReview ? "review_app" : "view_app")}
        </Link>
      )}
    </li>
  );
}

export function FocusOverview({
  data,
  total,
  focus,
  scopeParam,
  onSyncAll,
  syncing,
  staleCount = 0,
  changesListedBelow = false,
}: {
  data: FocusOverviewData;
  total: number;
  focus: FocusSummary | null;
  scopeParam: string | null;
  onSyncAll: () => void;
  syncing: boolean;
  /** Apps not synced in over a month. Stated beside the sync button so the
   *  status block still says how stale the picture is. */
  staleCount?: number;
  /** True when the "Changes to review" section renders on the same page.
   *  That section lists the changed apps with more detail, so the card
   *  starts with its own copy of them collapsed. Without the section the
   *  card is the only place they appear, and it starts expanded. */
  changesListedBelow?: boolean;
}) {
  const t = useTranslations("focus_overview");
  const tHero = useTranslations("dashboard.hero");
  const tHeadsUp = useTranslations("dashboard.headsup");
  const flags = useFlagValues(FLAGS);
  const changedId = useId();
  const [showChanged, setShowChanged] = useState(!changesListedBelow);
  const { primary, changed } = splitOverviewRows(data.apps);
  const beyondPreview = changedBeyondPreview(data.apps, data.pendingChanges);
  const canReview = flags?.["flag.appgrid.review_queue.enabled"] === "on";
  const canCompare = flags?.["flag.page.compare"] === "on";
  const handoff =
    focus?.workflow === "other_handoff" &&
    flags?.["flag.settings.admin.export.audit_bundle"] === "on";
  return (
    <section aria-labelledby="focus-overview-title" className="focus-overview">
      <header className="focus-overview-heading">
        <div>
          <h1 id="focus-overview-title">{t("title")}</h1>
          <p>
            {t(
              focus?.monitor && focus?.cleanup
                ? "intent_both"
                : focus?.cleanup
                  ? "intent_cleanup"
                  : focus?.monitor
                    ? "intent_monitor"
                    : "intent_review"
            )}
          </p>
        </div>
        <Link
          className="btn btn-secondary"
          href={withScopeParam("/dashboard/apps", scopeParam)}
        >
          {t("all_apps", { count: total })}
        </Link>
      </header>
      <div className="focus-overview-stats">
        <div>
          <strong>{total}</strong>
          <span>{t("tracked_apps")}</span>
        </div>
        <div>
          <strong>{data.pendingChanges}</strong>
          <span>{t("pending")}</span>
          {data.newChanges !== null && (
            <small>{t("since_visit", { count: data.newChanges })}</small>
          )}
        </div>
        {focus?.cleanup && (
          <div>
            <strong>{data.replacementCount}</strong>
            <span>{t("replacement_plans")}</span>
          </div>
        )}
      </div>
      {data.dueCount > 0 && (
        <p className="focus-overview-reminder">
          {t("due", { count: data.dueCount })}
        </p>
      )}
      <ul className="focus-overview-apps">
        {primary.map((app) => (
          <OverviewRow
            app={app}
            canCompare={canCompare}
            canReview={canReview}
            key={app.id}
          />
        ))}
      </ul>
      {changed.length > 0 && (
        <div className="focus-overview-changed">
          <button
            aria-controls={changedId}
            aria-expanded={showChanged}
            className="btn btn-secondary btn-sm focus-overview-changed-toggle"
            onClick={() => setShowChanged((open) => !open)}
            type="button"
          >
            <span aria-hidden="true">{showChanged ? "▴" : "▾"}</span>
            {showChanged
              ? t("hide_changed")
              : t("show_changed", { count: changed.length })}
          </button>
          <div hidden={!showChanged} id={changedId}>
            <ul className="focus-overview-apps-more">
              {changed.map((app) => (
                <OverviewRow
                  app={app}
                  canCompare={canCompare}
                  canReview={canReview}
                  key={app.id}
                />
              ))}
            </ul>
            {beyondPreview > 0 && (
              <p className="focus-overview-changed-more">
                {t("more_changed", { count: beyondPreview })}{" "}
                <Link href={withScopeParam("/dashboard/apps", scopeParam)}>
                  {t("more_changed_link")}
                </Link>
              </p>
            )}
          </div>
        </div>
      )}
      <footer className="focus-overview-actions">
        <div className="focus-overview-sync">
          <button
            className="btn btn-secondary"
            disabled={syncing}
            onClick={onSyncAll}
            type="button"
          >
            {tHero(syncing ? "syncing" : "resync_now")}
          </button>
          {/* The count is text, not the button's name: the Stale section
              below owns the "Sync N stale apps" button, and two controls
              with one name on a page read as one to assistive tech. */}
          {staleCount > 0 && (
            <p>{tHeadsUp("stale_label", { count: staleCount })}</p>
          )}
        </div>
        {canReview && focus?.cleanup && (
          <Link
            className="btn btn-primary"
            href={withScopeParam("/dashboard/apps?mode=queue", scopeParam)}
          >
            {t("guided_cleanup")}
          </Link>
        )}
        {handoff && (
          <div>
            <Link
              className="btn btn-secondary"
              href="/dashboard/settings/admin#export-data"
            >
              {t("handoff")}
            </Link>
            <p>{t("handoff_hint")}</p>
          </div>
        )}
        {/* Explains the since-last-visit count, so it shows only with one. */}
        {data.newChanges !== null && <p>{t("first_visit_hint")}</p>}
      </footer>
    </section>
  );
}

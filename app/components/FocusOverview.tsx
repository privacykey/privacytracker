"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { FocusOverviewData } from "@/lib/focus-review";
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

export function FocusOverview({
  data,
  total,
  focus,
  scopeParam,
  onSyncAll,
  syncing,
}: {
  data: FocusOverviewData;
  total: number;
  focus: FocusSummary | null;
  scopeParam: string | null;
  onSyncAll: () => void;
  syncing: boolean;
}) {
  const t = useTranslations("focus_overview");
  const tHero = useTranslations("dashboard.hero");
  const flags = useFlagValues(FLAGS);
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
        {data.apps.map((app) => (
          <li key={app.id}>
            <div className="focus-overview-app-name">
              {app.iconUrl && (
                <img alt="" height={36} src={app.iconUrl} width={36} />
              )}
              <Link href={`/apps/${encodeURIComponent(app.id)}`}>
                {app.name}
              </Link>
            </div>
            <div className="focus-overview-app-status">
              {app.changeCount > 0 && (
                <span>{t("app_changes", { count: app.changeCount })}</span>
              )}
              {(canReview || app.decision !== "review") && (
                <span>
                  {t(`decision.${app.decision}`)}
                  {app.remindAt
                    ? ` · ${new Date(app.remindAt).toLocaleDateString()}`
                    : ""}
                </span>
              )}
            </div>
            {canCompare && app.decision === "replace" ? (
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
        ))}
      </ul>
      <footer className="focus-overview-actions">
        <button
          className="btn btn-secondary"
          disabled={syncing}
          onClick={onSyncAll}
          type="button"
        >
          {tHero(syncing ? "syncing" : "resync_now")}
        </button>
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
        <p>{t("first_visit_hint")}</p>
      </footer>
    </section>
  );
}

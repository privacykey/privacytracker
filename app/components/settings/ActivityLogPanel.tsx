"use client";

/**
 * Developer Options → activity log: the operational timeline of scrapes,
 * re-syncs, policy summaries and scheduled runs.
 *
 * Distinct from the AI debug log above it — that one is opt-in and captures
 * full prompt/response payloads; this is an always-on, user-friendly audit
 * of boundary events so someone can spot a bug or confirm their apps are
 * actually being refreshed.
 *
 * All of the state (paging, four filters, live polling, the flash pulse)
 * lives in `useActivityLog`, so this component takes a single prop. The
 * accordion is lazy: nothing is fetched until it is first opened.
 */

import { useTranslations } from "next-intl";
import { useFlag } from "@/lib/feature-flags-hooks";
import { useActivityLog } from "@/lib/use-activity-log";
import ActivityRowDetail from "./ActivityRowDetail";
import { fmtDuration, fmtRelativeTime } from "./format";

/** Human-readable type labels + emoji icons for the activity log rows. */
const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  scrape: "Initial scrape",
  resync: "Re-sync",
  policy_summary: "Policy summary",
  scheduled_sync: "Scheduled sync",
  manual_sync: "Manual sync",
  import: "Import",
  backup_export: "Backup export",
  backup_restore: "Backup restore",
  reset: "Reset",
  health_check: "Health check",
};

const ACTIVITY_TYPE_ICONS: Record<string, string> = {
  scrape: "📥",
  resync: "↻",
  policy_summary: "📝",
  scheduled_sync: "⏰",
  manual_sync: "▶",
  import: "📦",
  backup_export: "💾",
  backup_restore: "⟲",
  reset: "⚠",
  health_check: "🩺",
};

export default function ActivityLogPanel({
  showToast,
}: {
  showToast: (msg: string) => void;
}) {
  const devActivityLogOn = useFlag("flag.devopts.activity_log") === "on";
  const devActivityLogRetentionDaysOn =
    useFlag("flag.devopts.activity_log.retention_days") === "on";
  const tSettings = useTranslations("settings");
  const tTime = useTranslations("settings.time");
  const tToast = useTranslations("settings.toasts");
  const tDevActivity = useTranslations("settings.dev_options.activity_log");
  const tDevActivityTypes = useTranslations(
    "settings.dev_options.activity_types"
  );

  // The `activity*` prefixes are redundant now that this has its own file —
  // they existed to disambiguate inside SettingsView's ~90-state scope. They
  // are kept for this commit so the markup below is a verbatim copy of what
  // SettingsView rendered, which is what makes the before/after HTML diff
  // meaningful. Dropping them is a mechanical follow-up.
  const {
    log: activityLog,
    loading: activityLoading,
    hasMore: activityHasMore,
    total: activityTotal,
    typeFilter: activityTypeFilter,
    setTypeFilter: setActivityTypeFilter,
    statusFilter: activityStatusFilter,
    setStatusFilter: setActivityStatusFilter,
    timeWindow: activityTimeWindow,
    setTimeWindow: setActivityTimeWindow,
    sortBy: activitySortBy,
    setSortBy: setActivitySortBy,
    sortDir: activitySortDir,
    setSortDir: setActivitySortDir,
    expandedId: activityExpandedId,
    setExpandedId: setActivityExpandedId,
    open: activityOpen,
    setOpen: setActivityOpen,
    livePaused: activityLivePaused,
    setLivePaused: setActivityLivePaused,
    flashing: activityFlashing,
    load: loadActivityLog,
  } = useActivityLog({
    onLoadError: () => showToast(tToast("activity_log_load_failed")),
  });

  return (
    <>
      {/* Activity log — always-on operational timeline of scrapes, re-syncs,
            policy summaries, and scheduled runs. Distinct from the AI debug
            log above (which is opt-in and captures full prompt/response
            payloads); this one is a user-friendly audit of boundary events so
            a user can spot bugs or confirm their apps are being refreshed. */}
      {devActivityLogRetentionDaysOn && (
        <div
          className="settings-field"
          style={{
            marginBottom: 8,
            padding: "6px 0",
            fontSize: 12,
            color: "var(--text-3)",
          }}
        >
          <strong>{tDevActivity("retention_lead")}</strong>
          {tDevActivity("retention_body")}
        </div>
      )}
      {devActivityLogOn && (
        <details
          className="settings-advanced-details"
          id="activity-log"
          onToggle={(event) => {
            const isOpen = (event.target as HTMLDetailsElement).open;
            setActivityOpen(isOpen);
            if (isOpen && activityLog === null) {
              void loadActivityLog(false);
            }
          }}
          open={activityOpen}
          style={{
            marginTop: 24,
            borderTop: "1px solid var(--border)",
            paddingTop: 16,
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
              userSelect: "none",
            }}
          >
            {tDevActivity("summary")}
          </summary>
          <p
            className="settings-field-help"
            style={{ marginTop: 12, marginBottom: 12 }}
          >
            {tDevActivity("help")}
          </p>

          <div className="activity-log-toolbar">
            <label className="activity-log-filter">
              <span>{tDevActivity("filter_activity")}</span>
              <select
                className="settings-input"
                onChange={(event) => setActivityTypeFilter(event.target.value)}
                value={activityTypeFilter}
              >
                <option value="">{tDevActivity("all_activity")}</option>
                <option value="scrape">{tDevActivityTypes("scrape")}</option>
                <option value="resync">{tDevActivityTypes("resync")}</option>
                <option value="policy_summary">
                  {tDevActivityTypes("policy_summary")}
                </option>
                <option value="scheduled_sync">
                  {tDevActivityTypes("scheduled_sync")}
                </option>
                <option value="manual_sync">
                  {tDevActivityTypes("manual_sync")}
                </option>
                <option value="import">{tDevActivityTypes("import")}</option>
                <option value="backup_export">
                  {tDevActivityTypes("backup_export")}
                </option>
                <option value="backup_restore">
                  {tDevActivityTypes("backup_restore")}
                </option>
                <option value="reset">{tDevActivityTypes("reset")}</option>
              </select>
            </label>
            <label className="activity-log-filter">
              <span>{tDevActivity("filter_status")}</span>
              <select
                className="settings-input"
                onChange={(event) =>
                  setActivityStatusFilter(event.target.value)
                }
                value={activityStatusFilter}
              >
                <option value="">{tDevActivity("all_statuses")}</option>
                <option value="ok">{tDevActivity("status_ok")}</option>
                <option value="error">{tDevActivity("status_error")}</option>
                <option value="partial">
                  {tDevActivity("status_partial")}
                </option>
                <option value="cancelled">
                  {tDevActivity("status_cancelled")}
                </option>
              </select>
            </label>
            <label className="activity-log-filter">
              <span>{tDevActivity("filter_since")}</span>
              <select
                className="settings-input"
                onChange={(event) => setActivityTimeWindow(event.target.value)}
                value={activityTimeWindow}
              >
                <option value="">{tDevActivity("any_time")}</option>
                <option value="5m">{tDevActivity("last_5m")}</option>
                <option value="15m">{tDevActivity("last_15m")}</option>
                <option value="1h">{tDevActivity("last_1h")}</option>
                <option value="6h">{tDevActivity("last_6h")}</option>
                <option value="24h">{tDevActivity("last_24h")}</option>
                <option value="7d">{tDevActivity("last_7d")}</option>
              </select>
            </label>
            <label className="activity-log-filter">
              <span>{tDevActivity("filter_sort")}</span>
              <select
                className="settings-input"
                onChange={(event) => {
                  const [field, dir] = event.target.value.split(":") as [
                    "started_at" | "ended_at" | "duration_ms",
                    "asc" | "desc",
                  ];
                  setActivitySortBy(field);
                  setActivitySortDir(dir);
                }}
                value={`${activitySortBy}:${activitySortDir}`}
              >
                <option value="started_at:desc">
                  {tDevActivity("sort_started_desc")}
                </option>
                <option value="started_at:asc">
                  {tDevActivity("sort_started_asc")}
                </option>
                <option value="ended_at:desc">
                  {tDevActivity("sort_ended_desc")}
                </option>
                <option value="ended_at:asc">
                  {tDevActivity("sort_ended_asc")}
                </option>
                <option value="duration_ms:desc">
                  {tDevActivity("sort_duration_desc")}
                </option>
                <option value="duration_ms:asc">
                  {tDevActivity("sort_duration_asc")}
                </option>
              </select>
            </label>
            <button
              className="btn btn-secondary"
              disabled={activityLoading}
              onClick={() => void loadActivityLog(false)}
              type="button"
            >
              {activityLoading && activityLog === null ? (
                <>
                  <span className="spinner-sm" /> {tDevActivity("loading")}
                </>
              ) : activityLog === null ? (
                tDevActivity("load")
              ) : (
                tDevActivity("refresh")
              )}
            </button>
            {/* Live-polling indicator. Only meaningful once the log has been
                loaded at least once — before that the toolbar just shows the
                "Load activity" button. Clicking toggles the pause state; the
                dot pulses while live and goes grey when paused. */}
            {activityLog !== null && (
              <button
                aria-pressed={!activityLivePaused}
                className={
                  // Brief flash when a new row was just prepended — purely
                  // cosmetic, auto-cleared ~1.2s later by the flashing effect.
                  `activity-log-live-toggle${activityLivePaused ? "is-paused" : ""}${
                    !activityLivePaused && activityFlashing ? "just-pulsed" : ""
                  }`
                }
                onClick={() => setActivityLivePaused((prev) => !prev)}
                title={
                  activityLivePaused
                    ? tDevActivity("live_title_paused")
                    : tDevActivity("live_title_active")
                }
                type="button"
              >
                <span aria-hidden className="activity-log-live-dot" />
                {activityLivePaused
                  ? tDevActivity("paused")
                  : tDevActivity("live")}
              </button>
            )}
          </div>

          {activityLog !== null && (
            <div style={{ marginTop: 12 }}>
              {activityLog.length === 0 ? (
                <div className="activity-log-empty">
                  {(() => {
                    const parts: string[] = [];
                    if (activityStatusFilter) {
                      parts.push(`${activityStatusFilter}`);
                    }
                    if (activityTypeFilter) {
                      parts.push(activityTypeFilter.replace(/_/g, " "));
                    }
                    if (parts.length > 0) {
                      return tDevActivity("empty_filter", {
                        filter: parts.join(" "),
                      });
                    }
                    return tDevActivity("empty_default");
                  })()}
                </div>
              ) : (
                <>
                  <ul className="activity-log-list">
                    {activityLog.map((row) => {
                      const isExpanded = activityExpandedId === row.id;
                      const typeLabel = ACTIVITY_TYPE_LABELS[row.type]
                        ? tDevActivityTypes(
                            row.type as Parameters<typeof tDevActivityTypes>[0]
                          )
                        : row.type;
                      const typeIcon = ACTIVITY_TYPE_ICONS[row.type] ?? "·";
                      const statusClass = `activity-status-pill activity-status-${row.status}`;
                      return (
                        <li
                          className={`activity-log-row activity-status-row-${row.status}`}
                          key={row.id}
                        >
                          <button
                            aria-expanded={isExpanded}
                            className="activity-log-header"
                            onClick={() =>
                              setActivityExpandedId((prev) =>
                                prev === row.id ? null : row.id
                              )
                            }
                            type="button"
                          >
                            <span aria-hidden className="activity-log-icon">
                              {typeIcon}
                            </span>
                            <span className="activity-log-title">
                              <span className="activity-log-type">
                                {typeLabel}
                              </span>
                              {row.appName && (
                                <span className="activity-log-appname">
                                  {" "}
                                  · {row.appName}
                                </span>
                              )}
                            </span>
                            <span className={statusClass}>{row.status}</span>
                            <span className="activity-log-meta">
                              {fmtRelativeTime(tTime, tSettings, row.startedAt)}
                              {typeof row.durationMs === "number" &&
                                row.durationMs > 0 && (
                                  <> · {fmtDuration(row.durationMs)}</>
                                )}
                            </span>
                          </button>
                          {row.summary && (
                            <div className="activity-log-summary">
                              {row.summary}
                            </div>
                          )}
                          {isExpanded && row.detail && (
                            <ActivityRowDetail row={row} />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="activity-log-footer">
                    <span className="activity-log-count">
                      {tDevActivity("showing", {
                        current: activityLog.length,
                        total: activityTotal,
                      })}
                    </span>
                    {activityHasMore && (
                      <button
                        className="btn btn-secondary"
                        disabled={activityLoading}
                        onClick={() => void loadActivityLog(true)}
                        type="button"
                      >
                        {activityLoading ? (
                          <>
                            <span className="spinner-sm" />{" "}
                            {tDevActivity("loading")}
                          </>
                        ) : (
                          tDevActivity("load_more")
                        )}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </details>
      )}
    </>
  );
}

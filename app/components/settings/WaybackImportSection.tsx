"use client";

/**
 * Wayback History Import — back-fill privacy-label history from
 * archive.org for every tracked app.
 *
 * The run is long and crash-resumable, so most of this card is progress
 * reporting: a live tally while it runs, a "Resumed after restart" pill
 * when `initiator === 'resume'` (the user did not click anything — the
 * server picked an interrupted run back up on boot), and the previous
 * run's summary otherwise.
 *
 * Anchor id `wayback-import` matches the SettingsSidebar entry — see
 * ./README.md.
 */

import { useTranslations } from "next-intl";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";
import { fmtRelativeTime } from "./format";
import type {
  WaybackLastRun,
  WaybackProgress,
  WaybackRunStatus,
} from "./types";

export default function WaybackImportSection({
  waybackRunning,
  waybackProgress,
  waybackSummary,
  waybackRunStatus,
  waybackInitiator,
  waybackLastRun,
  waybackControlBusy,
  controlWaybackImport,
  runBulkWaybackImport,
  waybackShowImported,
  saveWaybackShowImported,
  waybackToggleAutoSave,
  waybackRemoving,
  setWaybackRemoveOpen,
}: {
  waybackRunning: boolean;
  waybackProgress: WaybackProgress | null;
  waybackSummary: string | null;
  waybackRunStatus: WaybackRunStatus;
  /** 'resume' means the server restarted an interrupted run by itself. */
  waybackInitiator: "manual" | "resume" | null;
  waybackLastRun: WaybackLastRun | null;
  waybackControlBusy: null | "pause" | "resume" | "cancel" | "force";
  controlWaybackImport: (action: "pause" | "resume" | "cancel") => void;
  runBulkWaybackImport: (options?: { force?: boolean }) => void;
  waybackShowImported: boolean;
  saveWaybackShowImported: (next: boolean) => void;
  waybackToggleAutoSave: ReturnType<typeof useSettingsAutoSave<boolean>>;
  waybackRemoving: boolean;
  setWaybackRemoveOpen: (next: boolean) => void;
}) {
  const tSettings = useTranslations("settings");
  const tTime = useTranslations("settings.time");
  const tWayback = useTranslations("settings.wayback");

  return (
    <div className="settings-section" id="wayback-import">
      <h2 className="settings-section-title">
        <span
          aria-hidden="true"
          className="wayback-icon-inline"
          style={{ marginRight: 8 }}
        >
          🕰
        </span>
        {tWayback("title")}
      </h2>
      <p className="settings-section-subtitle">{tWayback("subtitle")}</p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          marginTop: 12,
        }}
      >
        <button
          className="btn btn-secondary"
          disabled={
            waybackRunning ||
            waybackRemoving ||
            waybackControlBusy !== null ||
            waybackRunStatus === "paused" ||
            waybackRunStatus === "pause_requested" ||
            waybackRunStatus === "cancel_requested"
          }
          onClick={() => void runBulkWaybackImport()}
          title={tWayback("import_title")}
          type="button"
        >
          {waybackRunning ? (
            <>
              <span className="spinner" /> {tWayback("import_busy")}
            </>
          ) : (
            tWayback("import_button")
          )}
        </button>
        {(waybackRunStatus === "running" ||
          waybackRunStatus === "pause_requested") && (
          <button
            className="btn btn-secondary"
            disabled={
              waybackControlBusy !== null ||
              waybackRunStatus === "pause_requested"
            }
            onClick={() => void controlWaybackImport("pause")}
            title={tWayback("pause_title")}
            type="button"
          >
            {waybackControlBusy === "pause" ||
            waybackRunStatus === "pause_requested" ? (
              <>
                <span className="spinner" /> {tWayback("pause_busy")}
              </>
            ) : (
              tWayback("pause_button")
            )}
          </button>
        )}
        {waybackRunStatus === "paused" && (
          <button
            className="btn btn-secondary"
            disabled={waybackControlBusy !== null}
            onClick={() => void controlWaybackImport("resume")}
            title={tWayback("resume_title")}
            type="button"
          >
            {waybackControlBusy === "resume" ? (
              <>
                <span className="spinner" /> {tWayback("resume_busy")}
              </>
            ) : (
              tWayback("resume_button")
            )}
          </button>
        )}
        {(waybackRunStatus === "running" ||
          waybackRunStatus === "pause_requested" ||
          waybackRunStatus === "paused" ||
          waybackRunStatus === "cancel_requested") && (
          <button
            className="btn btn-secondary"
            disabled={
              waybackControlBusy !== null ||
              waybackRunStatus === "cancel_requested"
            }
            onClick={() => void controlWaybackImport("cancel")}
            title={tWayback("cancel_title")}
            type="button"
          >
            {waybackControlBusy === "cancel" ||
            waybackRunStatus === "cancel_requested" ? (
              <>
                <span className="spinner" /> {tWayback("cancel_busy")}
              </>
            ) : (
              tWayback("cancel_button")
            )}
          </button>
        )}
        {(waybackRunStatus === "paused" || waybackRunStatus === "stale") && (
          <button
            className="btn btn-secondary"
            disabled={waybackControlBusy !== null || waybackRemoving}
            onClick={() => void runBulkWaybackImport({ force: true })}
            title={tWayback("force_title")}
            type="button"
          >
            {waybackControlBusy === "force" ? (
              <>
                <span className="spinner" /> {tWayback("force_busy")}
              </>
            ) : (
              tWayback("force_button")
            )}
          </button>
        )}
        <button
          className="btn btn-secondary"
          disabled={
            waybackRunning || waybackRemoving || waybackControlBusy !== null
          }
          onClick={() => setWaybackRemoveOpen(true)}
          title={tWayback("remove_title")}
          type="button"
        >
          {waybackRemoving ? (
            <>
              <span className="spinner" /> {tWayback("remove_busy")}
            </>
          ) : (
            tWayback("remove_button")
          )}
        </button>
      </div>

      <label className="settings-checkbox-row" style={{ marginTop: 14 }}>
        <input
          checked={waybackShowImported}
          className="settings-checkbox"
          disabled={waybackToggleAutoSave.saving}
          onChange={(event) =>
            void saveWaybackShowImported(event.target.checked)
          }
          type="checkbox"
        />
        <span>
          {tWayback("show_imported_label")}
          <span
            className="settings-field-help"
            style={{ display: "block", marginTop: 4 }}
          >
            {tWayback("show_imported_help")}
          </span>
        </span>
      </label>

      {/*
          Status card for the Historical Import. Three display modes, in
          priority order:
            1. A run is actively streaming (waybackRunning + waybackProgress):
               show a live "Importing n/N · AppName" line plus running
               tallies for imported / no-op / skipped / failed.
            2. A run finished during this page visit (waybackRunning=false
               and waybackProgress is still populated for a split second
               before the finally-block clears it) — treated the same as #1
               for rendering purposes.
            3. Otherwise, hydrate from `waybackLastRun` (loaded on mount
               and refreshed at the end of every run) so reloading the page
               still shows "Last run: 3 imported, 1 failed — 2 hr ago".
          The surrounding block only renders when we have something to say,
          so first-visit users with no runs yet see nothing extra.
        */}
      {waybackProgress || waybackLastRun || waybackSummary ? (
        <div
          className="settings-status-card"
          style={{
            marginTop: 14,
            padding: 12,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--surface-2, rgba(0,0,0,0.02))",
            fontSize: 13,
            color: "var(--text-2)",
          }}
        >
          {waybackProgress ? (
            <div>
              {/*
                  Resume banner — only rendered when this run was picked up
                  automatically by instrumentation.ts after a server restart.
                  Distinct from the "live tally" line below so users
                  understand a background import is in flight that nobody
                  on this page clicked. Uses the purple accent already used
                  for Wayback-sourced rows in the changelog timeline so the
                  visual language is consistent.
                */}
              {waybackInitiator === "resume" ? (
                <div
                  role="status"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    marginBottom: 8,
                    borderRadius: 6,
                    background: "rgba(124, 58, 237, 0.10)",
                    color: "var(--accent-wayback, #6d28d9)",
                    fontSize: 12,
                    lineHeight: 1.35,
                  }}
                >
                  <span aria-hidden="true">↻</span>
                  <span>
                    <strong style={{ marginRight: 4 }}>
                      {tWayback("resume_label")}
                    </strong>
                    {tWayback("resume_body")}
                  </span>
                </div>
              ) : null}
              {waybackRunStatus === "paused" ? (
                <div
                  role="status"
                  style={{
                    padding: "6px 10px",
                    marginBottom: 8,
                    borderRadius: 6,
                    background: "rgba(217, 119, 6, 0.12)",
                    color: "var(--warning, #b45309)",
                    fontSize: 12,
                    lineHeight: 1.35,
                  }}
                >
                  <strong style={{ marginRight: 4 }}>
                    {tWayback("paused_label")}
                  </strong>
                  {tWayback("paused_body")}
                </div>
              ) : null}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                {waybackRunStatus === "paused" ? (
                  <span aria-hidden="true">Ⅱ</span>
                ) : (
                  <span aria-hidden="true" className="spinner" />
                )}
                <strong style={{ color: "var(--text-1)" }}>
                  {waybackRunStatus === "pause_requested"
                    ? tWayback("pause_requested")
                    : waybackRunStatus === "cancel_requested"
                      ? tWayback("cancel_requested")
                      : waybackRunStatus === "paused"
                        ? tWayback("paused_progress")
                        : waybackProgress.total > 0
                          ? tWayback("progress_lead", {
                              current: Math.min(
                                waybackProgress.index,
                                waybackProgress.total
                              ),
                              total: waybackProgress.total,
                            })
                          : tWayback("starting")}
                </strong>
                {waybackProgress.currentAppName ? (
                  <span style={{ color: "var(--text-2)" }}>
                    · {waybackProgress.currentAppName}
                  </span>
                ) : null}
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 12,
                  color: "var(--text-2)",
                }}
              >
                <span>
                  <strong style={{ color: "var(--text-1)" }}>
                    {waybackProgress.imported}
                  </strong>{" "}
                  {tWayback("stat_imported")}
                </span>
                {waybackProgress.unchanged > 0 ? (
                  <span>
                    <strong style={{ color: "var(--text-1)" }}>
                      {waybackProgress.unchanged}
                    </strong>{" "}
                    {tWayback("stat_no_op")}
                  </span>
                ) : null}
                {waybackProgress.skipped > 0 ? (
                  <span>
                    <strong style={{ color: "var(--text-1)" }}>
                      {waybackProgress.skipped}
                    </strong>{" "}
                    {tWayback("stat_skipped")}
                  </span>
                ) : null}
                <span
                  style={{
                    color:
                      waybackProgress.failed > 0
                        ? "var(--danger, #b91c1c)"
                        : undefined,
                  }}
                >
                  <strong
                    style={{
                      color:
                        waybackProgress.failed > 0
                          ? "var(--danger, #b91c1c)"
                          : "var(--text-1)",
                    }}
                  >
                    {waybackProgress.failed}
                  </strong>{" "}
                  {tWayback("stat_failed")}
                </span>
              </div>
            </div>
          ) : waybackLastRun ? (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  marginBottom: 6,
                }}
              >
                <span
                  aria-label={tWayback("status_aria", {
                    status: waybackLastRun.status,
                  })}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 8px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 0.3,
                    background:
                      waybackLastRun.status === "ok"
                        ? "rgba(22,163,74,0.12)"
                        : waybackLastRun.status === "partial"
                          ? "rgba(217,119,6,0.14)"
                          : "rgba(220,38,38,0.14)",
                    color:
                      waybackLastRun.status === "ok"
                        ? "var(--success, #15803d)"
                        : waybackLastRun.status === "partial"
                          ? "var(--warning, #b45309)"
                          : "var(--danger, #b91c1c)",
                  }}
                >
                  {waybackLastRun.status === "ok"
                    ? tWayback("status_ok")
                    : waybackLastRun.status === "partial"
                      ? tWayback("status_partial")
                      : waybackLastRun.status === "cancelled"
                        ? tWayback("status_cancelled")
                        : tWayback("status_error")}
                </span>
                <strong style={{ color: "var(--text-1)" }}>
                  {tWayback("last_run")}
                </strong>
                {waybackLastRun.startedAt ? (
                  <span style={{ color: "var(--text-3)" }}>
                    ·{" "}
                    {fmtRelativeTime(
                      tTime,
                      tSettings,
                      waybackLastRun.startedAt
                    )}
                  </span>
                ) : null}
              </div>
              {waybackLastRun.totals ? (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  <span>
                    <strong style={{ color: "var(--text-1)" }}>
                      {waybackLastRun.totals.imported}
                    </strong>{" "}
                    {tWayback("stat_imported")}
                  </span>
                  {waybackLastRun.totals.unchanged > 0 ? (
                    <span>
                      <strong style={{ color: "var(--text-1)" }}>
                        {waybackLastRun.totals.unchanged}
                      </strong>{" "}
                      {tWayback("stat_no_op")}
                    </span>
                  ) : null}
                  {waybackLastRun.totals.skipped > 0 ? (
                    <span>
                      <strong style={{ color: "var(--text-1)" }}>
                        {waybackLastRun.totals.skipped}
                      </strong>{" "}
                      {tWayback("stat_skipped")}
                    </span>
                  ) : null}
                  <span
                    style={{
                      color:
                        waybackLastRun.totals.failed > 0
                          ? "var(--danger, #b91c1c)"
                          : undefined,
                    }}
                  >
                    <strong
                      style={{
                        color:
                          waybackLastRun.totals.failed > 0
                            ? "var(--danger, #b91c1c)"
                            : "var(--text-1)",
                      }}
                    >
                      {waybackLastRun.totals.failed}
                    </strong>{" "}
                    {tWayback("stat_failed")}
                  </span>
                  <span style={{ color: "var(--text-3)" }}>
                    {tWayback("across_apps", {
                      count: waybackLastRun.totals.appsAttempted,
                    })}
                  </span>
                </div>
              ) : waybackLastRun.summary ? (
                <div>{waybackLastRun.summary}</div>
              ) : null}
            </div>
          ) : waybackSummary ? (
            <div>
              {tWayback("summary_lead")} {waybackSummary}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

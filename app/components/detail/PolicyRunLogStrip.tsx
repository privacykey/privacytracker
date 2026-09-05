"use client";

import { useTranslations } from "next-intl";
import { formatDate as formatDateWithMode } from "../../../lib/date-format";
import { useDateFormat } from "../../../lib/date-format-hook";
import type { PolicyRunPhase } from "../../../lib/policy-summary-meta";

// ── Policy run-log strip & preview ────────────────────────────────────
//
// Shows phase-by-phase "thinking" for the currently running (or last)
// regenerate action. Errors surface inline so users don't need to open the
// browser devtools; hover reveals the full trace so the compact summary
// doesn't clutter the page.

function formatPhaseMs(ms?: number): string {
  if (!Number.isFinite(ms) || ms === undefined) {
    return "";
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

export default function PolicyRunLogStrip({
  running,
  log,
  regenError,
  showDetails = true,
}: {
  running: boolean;
  log: PolicyRunPhase[];
  regenError: string;
  /**
   * Wave I — `flag.detail.policy.run_log_details`. When false the
   * compact "Thinking… / Run complete" header still renders, but the
   * expandable "Full trace (N entries)" `<details>` block is hidden so
   * the strip stays a one-line status indicator.
   */
  showDetails?: boolean;
}) {
  const tLog = useTranslations("app_detail.policy_log");
  // Settings → Appearance → Date format. Drives the "Last run" label
  // shown next to the status text below — the trace lines themselves
  // stay ISO `YYYY-MM-DD HH:MM:SS` regardless of preference because
  // they're a debug surface where unambiguous machine-readable dates
  // are more useful than locale-formatted ones.
  const dateMode = useDateFormat();
  if (!running && log.length === 0 && !regenError) {
    return null;
  }

  const last = log.at(-1);
  const lastRunLabel =
    !running && last ? formatDateWithMode(last.at, dateMode) : null;
  const inProgressLabel = running
    ? last
      ? last.note
        ? tLog("label_with_note", { phase: last.phase, note: last.note })
        : last.phase
      : tLog("starting")
    : last
      ? last.error
        ? tLog("last_run_with_error", { phase: last.phase })
        : tLog("last_run", { phase: last.phase })
      : "";

  // Render every row as plain text in a <details> so hover / click reveals the
  // full trace. We keep the compact "latest phase" label on the closed state.
  // Trace timestamps include the ISO date prefix so a multi-day run log
  // doesn't render eight rows that all look like `14:32:15` — operators
  // need to see which day each phase landed on.
  const title = log
    .map((entry) => {
      const when = new Date(entry.at)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      const dur = entry.ms ? ` (${formatPhaseMs(entry.ms)})` : "";
      const detail = entry.error
        ? ` ERROR: ${entry.error}`
        : entry.note
          ? ` — ${entry.note}`
          : "";
      return `${when} ${entry.phase}${dur}${detail}`;
    })
    .join("\n");

  return (
    <div
      className="policy-run-log-strip"
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--surface-2)",
        border: "1px solid var(--border-1)",
        fontSize: 13,
        color: "var(--text-2, #9fb3c8)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {running ? (
          <span aria-hidden="true" className="spinner" />
        ) : regenError ? (
          <span aria-hidden="true">⚠</span>
        ) : (
          <span aria-hidden="true">✓</span>
        )}
        <strong style={{ color: "var(--text-1, #e4ecf7)" }}>
          {running
            ? tLog("thinking")
            : regenError
              ? tLog("run_failed")
              : tLog("run_complete")}
        </strong>
        <span
          style={{ cursor: log.length > 0 ? "help" : "default" }}
          title={title}
        >
          {inProgressLabel}
        </span>
        {/* Settings-formatted "Last run" date next to the phase label.
            Hidden while a run is in flight (the spinner + phase text
            already convey "happening now") and when there's no log
            yet. Renders in muted text colour so it sits behind the
            primary status. */}
        {lastRunLabel && (
          <span
            style={{
              marginLeft: "auto",
              color: "var(--text-3, #6c7c94)",
              fontSize: 12,
            }}
          >
            {tLog("last_run_at", { date: lastRunLabel })}
          </span>
        )}
      </div>

      {showDetails && log.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary
            style={{ cursor: "pointer", color: "var(--text-3, #6c7c94)" }}
          >
            {tLog("full_trace", { count: log.length })}
          </summary>
          <pre
            style={{
              marginTop: 8,
              maxHeight: 240,
              overflow: "auto",
              fontSize: 12,
              background: "var(--surface-3)",
              padding: 10,
              borderRadius: 6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {title}
          </pre>
        </details>
      )}
    </div>
  );
}

"use client";

/**
 * Live progress panel for the optional policy-summary run at the end of
 * onboarding: a row per app, a cell per phase (scrape, summarise), and a
 * running ETA derived from observed per-phase averages.
 *
 * Long enough to be worth interrupting, hence the cancel affordance —
 * the run is resumable, so stopping is cheap.
 */

import { useTranslations } from "next-intl";
import { formatMs } from "./format";
import PolicyPhaseCell from "./PolicyPhaseCell";
import type { PolicyRegenerateStatus, PolicyRunPhase } from "./types";

export default function PolicyRunPanel({
  progress,
  activePhase,
  runDone,
  phaseAvgMs,
  onCancelRequest,
  onViewDashboard,
}: {
  progress: PolicyRegenerateStatus[];
  activePhase: PolicyRunPhase;
  runDone: boolean;
  phaseAvgMs: { fetch: number | null; summarise: number | null };
  onCancelRequest: () => void;
  onViewDashboard: () => void;
}) {
  const total = progress.length;

  const scrapeDone = progress.filter(
    (p) =>
      p.scrape.status === "done" ||
      p.scrape.status === "error" ||
      p.scrape.status === "skipped"
  ).length;
  const summariseDone = progress.filter(
    (p) =>
      p.summarise.status === "done" ||
      p.summarise.status === "error" ||
      p.summarise.status === "skipped"
  ).length;

  const overallCompleted = scrapeDone + summariseDone;
  const overallTotal = total * 2;
  const pct =
    overallTotal === 0
      ? 0
      : Math.round((overallCompleted / overallTotal) * 100);

  const t = useTranslations("onboard.policy_run");
  // ETA: use the active phase's rolling average × remaining.
  let etaText: string | null = null;
  if (activePhase === "fetch" && phaseAvgMs.fetch !== null) {
    const remaining = total - scrapeDone;
    if (remaining > 0) {
      etaText = t("eta_fetch", {
        time: formatMs(remaining * phaseAvgMs.fetch),
      });
    }
  } else if (activePhase === "summarise" && phaseAvgMs.summarise !== null) {
    const remainingSummarise = progress.filter(
      (p) =>
        p.summarise.status === "pending" || p.summarise.status === "working"
    ).length;
    if (remainingSummarise > 0) {
      etaText = t("eta_summarise", {
        time: formatMs(remainingSummarise * phaseAvgMs.summarise),
      });
    }
  }

  const phaseLabel =
    activePhase === "fetch"
      ? t("phase_fetch")
      : activePhase === "summarise"
        ? t("phase_summarise")
        : runDone
          ? t("phase_finished")
          : t("phase_starting");

  const totalsLabel =
    activePhase === "fetch"
      ? t("totals_fetch", { done: scrapeDone, total })
      : activePhase === "summarise"
        ? t("totals_summarise", { done: summariseDone, total })
        : runDone
          ? t("totals_done", { fetched: scrapeDone, summarised: summariseDone })
          : "";

  return (
    <div className="policy-run-panel">
      <div className="policy-run-header">
        <div>
          <div className="policy-run-eyebrow">{phaseLabel}</div>
          <div className="policy-run-title">
            {totalsLabel}
            {etaText && <span className="policy-run-eta"> · {etaText}</span>}
          </div>
        </div>
        {runDone ? (
          <button
            className="btn btn-primary"
            onClick={onViewDashboard}
            type="button"
          >
            {t("view_dashboard")}
          </button>
        ) : (
          <button
            className="btn btn-secondary"
            onClick={onCancelRequest}
            type="button"
          >
            {t("cancel")}
          </button>
        )}
      </div>

      <div className="policy-run-progress-bar">
        <div
          className="policy-run-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="policy-run-rows">
        {progress.map((item, index) => (
          <div className="policy-phase-row" key={`${item.appId}-${index}`}>
            <div className="policy-phase-app">
              <div className="policy-phase-app-name">{item.name}</div>
            </div>
            <PolicyPhaseCell
              kind="scrape"
              label={t("scrape_label")}
              result={item.scrape}
            />
            <PolicyPhaseCell
              kind="summarise"
              label={t("summarise_label")}
              result={item.summarise}
            />
          </div>
        ))}
      </div>

      {runDone && (
        <div className="policy-run-footer">
          <button
            className="btn btn-secondary"
            onClick={onViewDashboard}
            type="button"
          >
            {t("go_dashboard")}
          </button>
        </div>
      )}
    </div>
  );
}

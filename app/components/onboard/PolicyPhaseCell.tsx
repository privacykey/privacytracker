"use client";

/**
 * One phase cell inside PolicyRunPanel — pending / working / done / error
 * / skipped, as a glyph plus a label.
 */

import { useTranslations } from "next-intl";
import { formatMs } from "./format";
import type { PolicyPhaseResult } from "./types";

export default function PolicyPhaseCell({
  label,
  kind,
  result,
}: {
  label: string;
  kind: "scrape" | "summarise";
  result: PolicyPhaseResult;
}) {
  const t = useTranslations("onboard.policy_run");
  const icon =
    result.status === "pending" ? (
      "○"
    ) : result.status === "working" ? (
      <span className="spinner-sm" />
    ) : result.status === "done" ? (
      "✓"
    ) : result.status === "error" ? (
      "✕"
    ) : (
      "—"
    );

  const verb =
    result.status === "pending"
      ? t("verb_pending")
      : result.status === "working"
        ? kind === "scrape"
          ? t("verb_fetching")
          : t("verb_summarising")
        : result.status === "done"
          ? t("verb_done")
          : result.status === "error"
            ? t("verb_failed")
            : t("verb_skipped");

  let timing: string | null = null;
  if (result.startedAt) {
    const end = result.finishedAt ?? Date.now();
    const elapsed = end - result.startedAt;
    if (result.status === "working") {
      timing = t("elapsed_suffix", { time: formatMs(elapsed) });
    } else if (result.finishedAt) {
      timing = formatMs(elapsed);
    }
  }

  return (
    <div className={`policy-phase-col policy-phase-${result.status}`}>
      <div className="policy-phase-col-label">{label}</div>
      <div className="policy-phase-col-state">
        <span className="policy-phase-icon">{icon}</span>
        <span className="policy-phase-verb">{verb}</span>
        {timing && <span className="policy-phase-timing">{timing}</span>}
      </div>
      {result.detail && (
        <div className="policy-phase-detail">{result.detail}</div>
      )}
    </div>
  );
}

/**
 * Inline "Edit name & retry" affordance for each row in the
 * "Not in the App Store" triage section. Lets the user fix
 * capitalisation / typos / add a developer hint on a query that
 * came back empty, and re-fire `/api/search` for JUST that one
 * block via the existing `handleBlockResearch` path. Mirrors the
 * matched-block edit affordance in `SearchResultBlock`; without
 * this, the only way to retry a single unmatched query was to
 * back out of step 3, fix the name in step 2's textarea, and
 * re-run the whole search — which used to nuke every other pick
 * the user had already made.
 */

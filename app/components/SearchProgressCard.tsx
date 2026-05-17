"use client";

/**
 * Step-2 chunked-search progress card. Replaces the previous endless
 * spinner that just said "Searching App Store…" for ~40s on a 200-app
 * import. Renders a thin progress bar + "X of Y matched" subtitle +
 * "Batch K of N" hint + a Cancel button that calls the AbortController
 * the parent wired up.
 *
 * Progress fidelity is per-batch (chunks of ~50 names), not per-name —
 * `/api/search` doesn't stream, so we drive the bar from the running
 * matched count after each chunk completes.
 */

import { useTranslations } from "next-intl";
// Co-located CSS — Turbopack hot-reloads reliably this way; the giant
// globals.css has burned us on incremental builds.
import "./onboard-step2.css";

interface Props {
  onCancel: () => void;
  progress: {
    matched: number;
    total: number;
    currentBatch: number;
    totalBatches: number;
  };
}

export default function SearchProgressCard({ progress, onCancel }: Props) {
  const t = useTranslations("onboard.step2.search_progress");
  // Drive the bar from batch completion when the matched count
  // doesn't move (e.g. several chunks return zero matches in a row —
  // still progress, just not match progress). Bar fills to whichever
  // signal is further along.
  const matchedPct =
    progress.total > 0 ? (progress.matched / progress.total) * 100 : 0;
  const batchPct =
    progress.totalBatches > 0
      ? (progress.currentBatch / progress.totalBatches) * 100
      : 0;
  const pct = Math.min(100, Math.max(matchedPct, batchPct));

  // First chunk hasn't finished yet — show an indeterminate-looking
  // animated bar (CSS handles the shimmer; the inline width is just
  // the "this much certainly done" anchor) plus a clearer subtitle so
  // the user isn't staring at a static "0 of 212".
  const isPreFirst = progress.currentBatch === 0 && progress.matched === 0;

  return (
    <div aria-live="polite" className="search-progress-card" role="status">
      <div className="search-progress-card-headline">
        <span className="search-progress-card-title">{t("title")}</span>
        <span className="search-progress-card-count">
          {t("matched_of_total", {
            matched: progress.matched,
            total: progress.total,
          })}
        </span>
      </div>
      <div
        aria-valuemax={progress.total}
        aria-valuemin={0}
        aria-valuenow={progress.matched}
        className={`search-progress-bar${isPreFirst ? "is-indeterminate" : ""}`}
        role="progressbar"
      >
        <div
          className="search-progress-bar-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="search-progress-card-footer">
        <span className="search-progress-card-batch">
          {isPreFirst
            ? t("preparing")
            : t("batch_of", {
                current: progress.currentBatch,
                total: progress.totalBatches,
              })}
        </span>
        <button
          className="search-progress-cancel-btn"
          onClick={onCancel}
          title={t("cancel_title")}
          type="button"
        >
          {t("cancel")}
        </button>
      </div>
      <p className="search-progress-card-hint">{t("hint")}</p>
    </div>
  );
}

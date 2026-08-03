"use client";

/**
 * Shown when Apple rate-limits the import mid-run.
 *
 * Not an error dialog: the queued apps are persisted server-side and a
 * background worker drains them on a timer, so this explains the pause
 * and offers to carry on elsewhere rather than asking the user to wait.
 */

import type { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type * as React from "react";
import type { Step } from "./types";

export default function RateLimitPauseModal({
  rateLimitPauseModal,
  setRateLimitPauseModal,
  setStep,
  router,
  rateLimitModalCardRef,
}: {
  /** null when closed; carries what landed before Apple pushed back. */
  rateLimitPauseModal: {
    queuedCount: number;
    successCount: number;
    retryAfterMs: number;
  } | null;
  setRateLimitPauseModal: (
    next: {
      queuedCount: number;
      successCount: number;
      retryAfterMs: number;
    } | null
  ) => void;
  setStep: (next: Step) => void;
  router: ReturnType<typeof useRouter>;
  rateLimitModalCardRef: React.RefObject<HTMLDivElement | null>;
}) {
  const tModalRate = useTranslations("onboard.modals.rate_limit_pause");

  return (
    <>
      {rateLimitPauseModal && (
        <div
          className="modal-overlay"
          onClick={() => setRateLimitPauseModal(null)}
        >
          <div
            aria-describedby="rate-limit-modal-copy"
            aria-labelledby="rate-limit-modal-title"
            aria-modal="true"
            className="modal-card rate-limit-pause-modal"
            onClick={(event) => event.stopPropagation()}
            ref={rateLimitModalCardRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="modal-badge">{tModalRate("badge")}</div>
            <h2 className="modal-title" id="rate-limit-modal-title">
              {tModalRate("title")}
            </h2>
            <p className="modal-copy" id="rate-limit-modal-copy">
              {tModalRate("body_lead")}
              {tModalRate.rich("body_queued", {
                count: rateLimitPauseModal.queuedCount,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
              {tModalRate("body_retry_minutes", {
                count: Math.max(
                  1,
                  Math.round(rateLimitPauseModal.retryAfterMs / 60_000)
                ),
              })}
              {rateLimitPauseModal.successCount > 0 &&
                tModalRate.rich("body_success", {
                  count: rateLimitPauseModal.successCount,
                  b: (chunks) => <strong>{chunks}</strong>,
                })}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setRateLimitPauseModal(null)}
                type="button"
              >
                {tModalRate("stay_here")}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setRateLimitPauseModal(null);
                  router.push("/dashboard/settings/import-history");
                }}
                type="button"
              >
                {tModalRate("view_history")}
              </button>
              {rateLimitPauseModal.successCount > 0 && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setRateLimitPauseModal(null);
                    // Step 5 = AI summaries. The button in the page
                    // footer does the same thing, but the modal makes
                    // it a one-click path from the pause itself.
                    setStep(5);
                  }}
                  type="button"
                >
                  {tModalRate("summarise")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

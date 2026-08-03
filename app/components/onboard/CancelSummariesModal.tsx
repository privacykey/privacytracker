"use client";

/**
 * Confirm dialog for stopping the policy-summary run.
 *
 * Offers two stop modes rather than one: finish the app currently in
 * flight, or stop immediately. The run is resumable either way, so the
 * distinction is only about wasting the in-progress request.
 */

import { useTranslations } from "next-intl";
import type * as React from "react";

export default function CancelSummariesModal({
  cancelModalOpen,
  setCancelModalOpen,
  requestStop,
  cancelModalCardRef,
}: {
  cancelModalOpen: boolean;
  setCancelModalOpen: (next: boolean) => void;
  requestStop: (mode: "now" | "after-current") => void;
  cancelModalCardRef: React.RefObject<HTMLDivElement | null>;
}) {
  const tModalCancel = useTranslations("onboard.modals.cancel_summaries");

  return (
    <>
      {cancelModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => setCancelModalOpen(false)}
        >
          <div
            aria-describedby="cancel-modal-copy"
            aria-labelledby="cancel-modal-title"
            aria-modal="true"
            className="modal-card cancel-confirm-modal"
            onClick={(event) => event.stopPropagation()}
            ref={cancelModalCardRef}
            role="dialog"
            tabIndex={-1}
          >
            <h2 className="modal-title" id="cancel-modal-title">
              {tModalCancel("title")}
            </h2>
            <p className="modal-copy" id="cancel-modal-copy">
              {tModalCancel("body")}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setCancelModalOpen(false)}
                type="button"
              >
                {tModalCancel("keep_going")}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => requestStop("after-current")}
                type="button"
              >
                {tModalCancel("stop_after_current")}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => requestStop("now")}
                type="button"
              >
                {tModalCancel("stop_now")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

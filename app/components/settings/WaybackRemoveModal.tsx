"use client";

/**
 * Confirm dialog for purging every Wayback-imported snapshot.
 *
 * Only touches rows with `source = 'wayback'` — live sync history is left
 * alone, which is the distinction the copy has to make clear before the
 * user commits.
 */

import { useTranslations } from "next-intl";
import type { useModalFocus } from "@/lib/use-modal-focus";

export default function WaybackRemoveModal({
  waybackRemoveOpen,
  closeWaybackRemoveModal,
  removeAllWaybackHistory,
  waybackRemoving,
  waybackRemoveModalRef,
}: {
  waybackRemoveOpen: boolean;
  closeWaybackRemoveModal: () => void;
  removeAllWaybackHistory: () => void;
  waybackRemoving: boolean;
  waybackRemoveModalRef: ReturnType<typeof useModalFocus<HTMLDivElement>>;
}) {
  const tWaybackRemove = useTranslations("settings.wayback.remove_modal");

  return (
    <>
      {waybackRemoveOpen && (
        <div className="modal-overlay" onClick={closeWaybackRemoveModal}>
          <div
            aria-describedby="wayback-remove-copy"
            aria-labelledby="wayback-remove-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            ref={waybackRemoveModalRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="modal-badge">{tWaybackRemove("badge")}</div>
            <h2 className="modal-title" id="wayback-remove-title">
              {tWaybackRemove("title")}
            </h2>
            <p className="modal-copy" id="wayback-remove-copy">
              {tWaybackRemove("body")}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={waybackRemoving}
                onClick={closeWaybackRemoveModal}
                type="button"
              >
                {tWaybackRemove("cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={waybackRemoving}
                onClick={() => void removeAllWaybackHistory()}
                type="button"
              >
                {waybackRemoving ? (
                  <>
                    <span className="spinner-sm" /> {tWaybackRemove("removing")}
                  </>
                ) : (
                  tWaybackRemove("confirm")
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

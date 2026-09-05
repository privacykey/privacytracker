"use client";

/**
 * Confirm dialog for the inline "Remove from Apps" button on an
 * import-history row.
 *
 * Replaced a bare `window.confirm` so the destructive UX matches the
 * wayback-remove and reset-app dialogs. The body is an IIFE because it
 * derives a display label from the staged item before rendering.
 */

import { useTranslations } from "next-intl";
import type { PendingItemRemoval } from "@/lib/use-import-history";
import type { useModalFocus } from "@/lib/use-modal-focus";

export default function RemoveItemModal({
  pendingItemRemoval,
  setPendingItemRemoval,
  removingItemId,
  confirmRemoveItemFromDashboard,
  removeItemModalRef,
}: {
  /** null when closed; stages the import row, item and appId so the copy
   *  can name what is about to be removed. */
  pendingItemRemoval: PendingItemRemoval | null;
  setPendingItemRemoval: (next: PendingItemRemoval | null) => void;
  /** Non-null while a removal is in flight — doubles as the busy flag. */
  removingItemId: string | null;
  confirmRemoveItemFromDashboard: () => void;
  removeItemModalRef: ReturnType<typeof useModalFocus<HTMLDivElement>>;
}) {
  const tModalRemoveApp = useTranslations("settings.modals.remove_app");

  return (
    <>
      {/*
        Confirm modal for the inline "Remove from Apps" button on an
        import-history row. Replaces the previous `window.confirm` so
        the destructive UX matches the wayback-remove + reset-app
        dialogs above.
      */}
      {pendingItemRemoval &&
        (() => {
          const { item } = pendingItemRemoval;
          const label = item.appName || item.editedQuery || item.query;
          const closing = removingItemId !== null;
          return (
            <div
              className="modal-overlay"
              onClick={() => {
                if (!closing) {
                  setPendingItemRemoval(null);
                }
              }}
            >
              <div
                aria-describedby="remove-item-copy"
                aria-labelledby="remove-item-title"
                aria-modal="true"
                className="modal-card"
                onClick={(event) => event.stopPropagation()}
                ref={removeItemModalRef}
                role="dialog"
                tabIndex={-1}
              >
                <div className="modal-badge">{tModalRemoveApp("badge")}</div>
                <h2 className="modal-title" id="remove-item-title">
                  {tModalRemoveApp("title", { name: label })}
                </h2>
                <p className="modal-copy" id="remove-item-copy">
                  {tModalRemoveApp("body")}
                </p>
                <div className="modal-actions">
                  <button
                    className="btn btn-secondary"
                    disabled={closing}
                    onClick={() => setPendingItemRemoval(null)}
                    type="button"
                  >
                    {tModalRemoveApp("cancel")}
                  </button>
                  <button
                    autoFocus
                    className="btn btn-danger"
                    disabled={closing}
                    onClick={() => void confirmRemoveItemFromDashboard()}
                    type="button"
                  >
                    {closing ? (
                      <>
                        <span aria-hidden="true" className="spinner-sm" />{" "}
                        {tModalRemoveApp("removing")}
                      </>
                    ) : (
                      tModalRemoveApp("confirm")
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </>
  );
}

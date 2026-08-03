"use client";

/**
 * Confirm dialog for deleting an import from history.
 *
 * Two modes, chosen in the dialog itself: drop just the history row, or
 * also remove the apps it added. The second is the destructive one, which
 * is why the choice lives here rather than being implied by which button
 * was clicked.
 */

import { useTranslations } from "next-intl";
import type { DateFormatMode } from "@/lib/date-format";
import type { DeleteTarget } from "@/lib/use-import-history";
import type { useModalFocus } from "@/lib/use-modal-focus";
import { fmtShortDate } from "./format";

export default function DeleteImportModal({
  deleteTarget,
  setDeleteTarget,
  deleting,
  confirmDeleteImport,
  deleteImportModalRef,
  dateMode,
}: {
  /** null when closed; carries the import row and the chosen mode. */
  deleteTarget: DeleteTarget | null;
  setDeleteTarget: (next: DeleteTarget | null) => void;
  deleting: boolean;
  confirmDeleteImport: () => void;
  deleteImportModalRef: ReturnType<typeof useModalFocus<HTMLDivElement>>;
  dateMode: DateFormatMode;
}) {
  const tModalDelete = useTranslations("settings.modals.delete_import");

  return (
    <>
      {deleteTarget && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!deleting) {
              setDeleteTarget(null);
            }
          }}
        >
          <div
            aria-labelledby="delete-import-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            ref={deleteImportModalRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="modal-badge">{tModalDelete("badge")}</div>
            <h2 className="modal-title" id="delete-import-title">
              {tModalDelete("title")}
            </h2>
            <p className="modal-copy">
              {tModalDelete("meta", {
                date: fmtShortDate(deleteTarget.importRow.createdAt, dateMode),
                total: deleteTarget.importRow.total,
                imported: deleteTarget.importRow.imported,
              })}
            </p>

            <div className="delete-import-options">
              <label
                className={`delete-import-option${deleteTarget.mode === "history-only" ? " is-active" : ""}`}
              >
                <input
                  checked={deleteTarget.mode === "history-only"}
                  disabled={deleting}
                  name="delete-import-mode"
                  onChange={() =>
                    setDeleteTarget({ ...deleteTarget, mode: "history-only" })
                  }
                  type="radio"
                  value="history-only"
                />
                <div>
                  <div className="delete-import-option-label">
                    {tModalDelete("option_history_only_label")}
                  </div>
                  <div className="delete-import-option-desc">
                    {tModalDelete("option_history_only_desc")}
                  </div>
                </div>
              </label>

              <label
                className={`delete-import-option${deleteTarget.mode === "with-apps" ? " is-active" : ""}`}
              >
                <input
                  checked={deleteTarget.mode === "with-apps"}
                  disabled={deleting}
                  name="delete-import-mode"
                  onChange={() =>
                    setDeleteTarget({ ...deleteTarget, mode: "with-apps" })
                  }
                  type="radio"
                  value="with-apps"
                />
                <div>
                  <div className="delete-import-option-label">
                    {tModalDelete("option_with_apps_label")}
                  </div>
                  <div className="delete-import-option-desc">
                    {tModalDelete("option_with_apps_desc", {
                      count: deleteTarget.importRow.imported,
                    })}
                  </div>
                </div>
              </label>
            </div>

            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                type="button"
              >
                {tModalDelete("cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={deleting}
                onClick={() => void confirmDeleteImport()}
                type="button"
              >
                {deleting ? (
                  <>
                    <span className="spinner-sm" /> {tModalDelete("deleting")}
                  </>
                ) : deleteTarget.mode === "with-apps" ? (
                  tModalDelete("confirm_with_apps")
                ) : (
                  tModalDelete("confirm_history")
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

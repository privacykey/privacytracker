"use client";

/**
 * Two-step confirm dialog for "Reset all data".
 *
 * Step 1 offers a backup export before anything is destroyed; step 2 is
 * the actual confirmation. The export button is right there because the
 * point at which someone is about to wipe the database is exactly when
 * they should be offered a copy of it.
 */

import { useTranslations } from "next-intl";
import type { useModalFocus } from "@/lib/use-modal-focus";

export default function ResetAppModal({
  resetStep,
  setResetStep,
  closeResetModal,
  resetAllData,
  resetting,
  resetModalRef,
  exportingBackup,
  handleExportBackup,
}: {
  /** 0 = closed, 1 = offer a backup, 2 = final confirmation. */
  resetStep: 0 | 1 | 2;
  setResetStep: (next: 0 | 1 | 2) => void;
  closeResetModal: () => void;
  resetAllData: () => void;
  resetting: boolean;
  resetModalRef: ReturnType<typeof useModalFocus<HTMLDivElement>>;
  exportingBackup: boolean;
  handleExportBackup: () => void;
}) {
  const tBackupCard = useTranslations("settings.backup_card");
  const tResetCard = useTranslations("settings.reset_app_card");

  return (
    <>
      {resetStep > 0 && (
        <div className="modal-overlay" onClick={closeResetModal}>
          <div
            aria-describedby="reset-app-copy"
            aria-labelledby="reset-app-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            ref={resetModalRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="modal-badge">{tResetCard("modal_badge")}</div>
            <h2 className="modal-title" id="reset-app-title">
              {resetStep === 1
                ? tResetCard("modal_title_step_1")
                : tResetCard("modal_title_step_2")}
            </h2>
            <p className="modal-copy" id="reset-app-copy">
              {resetStep === 1
                ? tResetCard("modal_body_step_1")
                : tResetCard("modal_body_step_2")}
            </p>
            {resetStep === 2 && (
              <div className="destructive-backup-offer">
                <div className="destructive-backup-copy">
                  {tBackupCard("download_before_reset")}
                </div>
                <button
                  className="btn btn-secondary"
                  disabled={exportingBackup || resetting}
                  onClick={handleExportBackup}
                  type="button"
                >
                  {exportingBackup
                    ? tBackupCard("download_busy")
                    : tBackupCard("download_before_destructive")}
                </button>
              </div>
            )}
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={resetting}
                onClick={closeResetModal}
                type="button"
              >
                {tResetCard("cancel")}
              </button>

              {resetStep === 1 ? (
                <button
                  className="btn btn-danger"
                  onClick={() => setResetStep(2)}
                  type="button"
                >
                  {tResetCard("continue")}
                </button>
              ) : (
                <button
                  className="btn btn-danger"
                  disabled={resetting}
                  onClick={() => void resetAllData()}
                  type="button"
                >
                  {resetting ? (
                    <>
                      <span className="spinner-sm" /> {tResetCard("resetting")}
                    </>
                  ) : (
                    tResetCard("delete_and_restart")
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

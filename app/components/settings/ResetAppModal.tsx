"use client";

/**
 * Confirm dialog for "Delete all data" (lib/wipe-all-data.ts).
 *
 * One step: it names everything the wipe removes, says what happens to
 * backup files already downloaded, offers a fresh backup, and enables
 * "Delete everything" only once the user has typed the confirmation word.
 * Same shape as the restore dialog, which asks for RESTORE: the two
 * actions that replace or erase the whole database ask for the same kind
 * of deliberate confirmation.
 */

import { useTranslations } from "next-intl";
import type { useModalFocus } from "@/lib/use-modal-focus";
import "./reset-app.css";

/** What the user types to enable the button. Not translated, like RESTORE. */
export const RESET_CONFIRM_WORD = "DELETE";

export function resetConfirmMatches(text: string): boolean {
  return text.trim().toUpperCase() === RESET_CONFIRM_WORD;
}

const SCOPE_KEYS = [
  "modal_scope_apps",
  "modal_scope_devices",
  "modal_scope_settings",
  "modal_scope_history",
  "modal_scope_backups",
] as const;

export default function ResetAppModal({
  open,
  closeResetModal,
  resetAllData,
  resetting,
  resetModalRef,
  confirmText,
  setConfirmText,
  exportingBackup,
  handleExportBackup,
}: {
  open: boolean;
  closeResetModal: () => void;
  resetAllData: () => void;
  resetting: boolean;
  resetModalRef: ReturnType<typeof useModalFocus<HTMLDivElement>>;
  confirmText: string;
  setConfirmText: (next: string) => void;
  exportingBackup: boolean;
  handleExportBackup: () => void;
}) {
  const tBackupCard = useTranslations("settings.backup_card");
  const tResetCard = useTranslations("settings.reset_app_card");

  if (!open) {
    return null;
  }

  return (
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
          {tResetCard("modal_title")}
        </h2>
        <div className="modal-copy reset-app-copy" id="reset-app-copy">
          <p>{tResetCard("modal_intro")}</p>
          <ul className="reset-scope-list">
            {SCOPE_KEYS.map((key) => (
              <li key={key}>{tResetCard(key)}</li>
            ))}
          </ul>
          <p>{tResetCard("modal_after")}</p>
        </div>

        <div className="modal-warning" style={{ marginTop: 12 }}>
          {tResetCard("modal_downloaded_backups")}
        </div>

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

        <label className="modal-confirm-label" htmlFor="reset-confirm-input">
          {tResetCard.rich("confirm_label", {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </label>
        <input
          autoComplete="off"
          autoCorrect="off"
          className="modal-confirm-input"
          disabled={resetting}
          id="reset-confirm-input"
          onChange={(event) => setConfirmText(event.target.value)}
          placeholder={RESET_CONFIRM_WORD}
          spellCheck={false}
          type="text"
          value={confirmText}
        />

        <div className="modal-actions">
          <button
            className="btn btn-secondary"
            disabled={resetting}
            onClick={closeResetModal}
            type="button"
          >
            {tResetCard("cancel")}
          </button>
          <button
            className="btn btn-danger"
            disabled={resetting || !resetConfirmMatches(confirmText)}
            onClick={() => void resetAllData()}
            type="button"
          >
            {resetting ? (
              <>
                <span className="spinner-sm" /> {tResetCard("deleting")}
              </>
            ) : (
              tResetCard("confirm_button")
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

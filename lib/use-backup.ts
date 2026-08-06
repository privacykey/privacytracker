"use client";

/**
 * Backup & Restore: the export button, the three-phase restore flow
 * (preview -> typed confirmation -> apply, because restoring the wrong
 * backup is unrecoverable), automatic snapshots with their settings
 * auto-save, and the restore modal's focus management.
 *
 * Moved out of SettingsView as one unit — read only by BackupSection,
 * ResetSection's export button, and the RestoreBackupModal overlay.
 * `loadBackupSnapshots` stays in the returned surface because the
 * admin-token unlock handler re-pulls it when the gate opens.
 *
 * Loads its own snapshot list on mount; the endpoint answers 401/403
 * when an admin token is required, and the load treats that as "locked",
 * not an error.
 */

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type {
  BackupRestorePreview,
  BackupSnapshotRow,
  BackupSnapshotSettings,
  BackupSnapshotsPayload,
} from "@/app/components/settings/types";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useSettingsAutoSave } from "@/lib/use-settings-auto-save";

const DEFAULT_BACKUP_SNAPSHOT_SETTINGS: BackupSnapshotSettings = {
  enabled: false,
  intervalHours: 24,
  retentionCount: 10,
  lastRunAt: null,
  nextRunAt: null,
};

export function useBackup({ showToast }: { showToast: (msg: string) => void }) {
  const tBackupCard = useTranslations("settings.backup_card");
  const tToast = useTranslations("settings.toasts");

  // ── Backup & Restore state ─────────────────────────────────────────────
  // The restore flow is three-phase: (1) pick a file, (2) the server previews
  // it and we show counts + a typed-confirmation input, (3) the user types
  // RESTORE and commits. Phase state lives in `restoreStage`; the parsed
  // payload is stashed in `pendingRestore` so we don't re-read the file.
  type BackupRestoreStage = "idle" | "previewing" | "confirm" | "applying";
  const [exportingBackup, setExportingBackup] = useState(false);
  const [restoreStage, setRestoreStage] = useState<BackupRestoreStage>("idle");
  const [restorePreview, setRestorePreview] =
    useState<BackupRestorePreview | null>(null);
  const [pendingRestorePayload, setPendingRestorePayload] = useState<
    string | null
  >(null);
  const [pendingRestoreFilename, setPendingRestoreFilename] = useState<
    string | null
  >(null);
  const [restoreError, setRestoreError] = useState<string>("");
  const [restoreConfirmText, setRestoreConfirmText] = useState("");
  const [backupSnapshotSettings, setBackupSnapshotSettings] =
    useState<BackupSnapshotSettings>(DEFAULT_BACKUP_SNAPSHOT_SETTINGS);
  const [backupSnapshotDirectory, setBackupSnapshotDirectory] = useState("");
  const [backupSnapshots, setBackupSnapshots] = useState<BackupSnapshotRow[]>(
    []
  );
  // Saving flag now lives on `backupSnapshotsAutoSave.saving`.
  const [creatingBackupSnapshot, setCreatingBackupSnapshot] = useState(false);

  const applyBackupSnapshotPayload = (payload: BackupSnapshotsPayload) => {
    setBackupSnapshotSettings(
      payload.settings ?? DEFAULT_BACKUP_SNAPSHOT_SETTINGS
    );
    setBackupSnapshotDirectory(payload.directory ?? "");
    setBackupSnapshots(
      Array.isArray(payload.snapshots) ? payload.snapshots : []
    );
  };

  const loadBackupSnapshots = async () => {
    try {
      const res = await fetch("/api/backup/snapshots", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // Locked by the non-local admin gate. The deployment card's
          // unlock form explains the state; a toast on every settings
          // visit would just be noise. Re-fetched after unlock.
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      applyBackupSnapshotPayload((await res.json()) as BackupSnapshotsPayload);
    } catch (error) {
      console.warn("[settings] loadBackupSnapshots failed:", error);
      showToast(tToast("backup_snapshots_load_failed"));
    }
  };

  const handleCreateBackupSnapshot = async () => {
    if (creatingBackupSnapshot) {
      return;
    }
    setCreatingBackupSnapshot(true);
    try {
      const res = await fetch("/api/backup/snapshots", { method: "POST" });
      if (!res.ok) {
        let msg = tToast("backup_snapshot_create_failed");
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        showToast(msg);
        return;
      }
      applyBackupSnapshotPayload((await res.json()) as BackupSnapshotsPayload);
      showToast(tToast("backup_snapshot_created"));
    } catch (error) {
      console.warn("[settings] createBackupSnapshot failed:", error);
      showToast(tToast("backup_snapshot_create_failed"));
    } finally {
      setCreatingBackupSnapshot(false);
    }
  };

  /**
   * Backup snapshot settings live behind PUT `/api/backup/snapshots`,
   * which expects the full `{ enabled, intervalHours, retentionCount }`
   * blob. The route returns the persisted payload so we re-baseline
   * via `applyBackupSnapshotPayload` (covers retention clamps + lastRunAt).
   *
   * Save lifecycle:
   *  - Toggle enabled → immediate save
   *  - Interval dropdown → immediate save (discrete)
   *  - Retention number → save on blur (numeric edit)
   */
  const backupSnapshotsAutoSave = useSettingsAutoSave<{
    enabled: boolean;
    intervalHours: number;
    retentionCount: number;
  }>({
    endpoint: "/api/backup/snapshots",
    method: "PUT",
    buildBody: (value) => value,
    successMessage: (value) =>
      value.enabled
        ? tBackupCard("snapshots_toast_set", {
            hours: value.intervalHours,
            count: value.retentionCount,
          })
        : tBackupCard("snapshots_toast_disabled"),
    taskLabel: tBackupCard("snapshots_task_label"),
    onSaved: (_value, response) => {
      if (response) {
        applyBackupSnapshotPayload(response as BackupSnapshotsPayload);
      }
    },
  });

  const saveBackupSnapshots = useCallback(
    (next: {
      enabled: boolean;
      intervalHours: number;
      retentionCount: number;
    }) => {
      void backupSnapshotsAutoSave.save(next);
    },
    [backupSnapshotsAutoSave]
  );

  // ── Backup & Restore handlers ──────────────────────────────────────────
  /**
   * Download a full-DB backup as JSON. We fetch through JS (instead of a plain
   * <a download> link) so we can surface server-side errors (rate-limit, admin
   * token missing, etc.) without letting the browser dump an error page into
   * a file.
   */
  const handleExportBackup = async () => {
    if (exportingBackup) {
      return;
    }
    setExportingBackup(true);
    try {
      const res = await fetch("/api/backup/export");
      if (!res.ok) {
        let msg = "Export failed";
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }
      const blob = await res.blob();
      // Prefer the server-assigned filename from Content-Disposition so the
      // ISO timestamp matches what the server recorded in audit_log.
      let filename = "privacytracker-backup.json";
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^";]+)"?/i);
      if (match) {
        filename = match[1];
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showToast(tToast("backup_downloaded"));
    } catch (error) {
      console.error("[settings] backup export failed:", error);
      showToast(tToast("backup_download_failed"));
    } finally {
      setExportingBackup(false);
    }
  };

  const resetRestoreFlow = () => {
    setRestoreStage("idle");
    setRestorePreview(null);
    setPendingRestorePayload(null);
    setPendingRestoreFilename(null);
    setRestoreError("");
    setRestoreConfirmText("");
  };

  /**
   * Handle the chosen backup file: read it, POST to /api/backup/preview for
   * validation, and move the flow into the typed-confirmation stage. We stash
   * the raw text so the commit step doesn't need to re-read the file.
   */
  const handleRestoreFileChosen = async (file: File) => {
    setRestoreError("");
    setRestoreStage("previewing");
    setPendingRestoreFilename(file.name);
    setRestoreConfirmText("");
    try {
      const text = await file.text();
      let previewBody: unknown;
      try {
        previewBody = JSON.parse(text);
      } catch {
        throw new Error("File is not valid JSON.");
      }
      const res = await fetch("/api/backup/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(previewBody),
      });
      if (!res.ok) {
        let msg = "Could not validate backup";
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        throw new Error(msg);
      }
      const preview = (await res.json()) as BackupRestorePreview;
      setRestorePreview(preview);
      setPendingRestorePayload(text);
      setRestoreStage("confirm");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setRestoreError(msg);
      setPendingRestorePayload(null);
      setRestorePreview(null);
      setRestoreStage("idle");
    }
  };

  /**
   * Commit the stashed backup payload. On success, reload imports + schedule
   * status so the UI reflects the restored state — the user may have landed
   * in a completely different data world than the one they were looking at.
   */
  const handleRestoreConfirm = async () => {
    if (!pendingRestorePayload) {
      return;
    }
    if (restoreConfirmText.trim().toUpperCase() !== "RESTORE") {
      setRestoreError("Type RESTORE to confirm.");
      return;
    }
    setRestoreError("");
    setRestoreStage("applying");
    try {
      const res = await fetch("/api/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pendingRestorePayload,
      });
      if (!res.ok) {
        let msg = "Restore failed";
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        setRestoreError(msg);
        setRestoreStage("confirm");
        return;
      }
      showToast(tToast("backup_restored"));
      // Small delay so the toast is visible before the hard reload.
      setTimeout(() => {
        window.location.reload();
      }, 600);
    } catch (error) {
      console.error("[settings] restore commit failed:", error);
      setRestoreError(
        error instanceof Error ? error.message : "Restore failed"
      );
      setRestoreStage("confirm");
    }
  };

  // Focus management for every modal dialog rendered below: trap Tab, move
  // focus into the card on open, restore it on close, and close on Escape.
  // One hook per dialog (see useModalFocus). Each `onClose` mirrors the
  // dialog's own dismiss guard (e.g. don't close mid-apply / mid-delete).
  const restoreModalRef = useModalFocus<HTMLDivElement>({
    open:
      (restoreStage === "confirm" || restoreStage === "applying") &&
      restorePreview !== null,
    onClose: () => {
      if (restoreStage !== "applying") {
        resetRestoreFlow();
      }
    },
  });
  // Self-loading, same as the other subsystem hooks — SettingsView's
  // shared mount loader no longer knows backups exist.
  useEffect(() => {
    void loadBackupSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once effect
  }, []);

  return {
    exportingBackup,
    setExportingBackup,
    restoreStage,
    setRestoreStage,
    restorePreview,
    setRestorePreview,
    pendingRestorePayload,
    setPendingRestorePayload,
    pendingRestoreFilename,
    setPendingRestoreFilename,
    restoreError,
    setRestoreError,
    restoreConfirmText,
    setRestoreConfirmText,
    backupSnapshotSettings,
    setBackupSnapshotSettings,
    backupSnapshotDirectory,
    setBackupSnapshotDirectory,
    backupSnapshots,
    setBackupSnapshots,
    creatingBackupSnapshot,
    setCreatingBackupSnapshot,
    applyBackupSnapshotPayload,
    loadBackupSnapshots,
    handleCreateBackupSnapshot,
    backupSnapshotsAutoSave,
    saveBackupSnapshots,
    handleExportBackup,
    resetRestoreFlow,
    handleRestoreFileChosen,
    handleRestoreConfirm,
    restoreModalRef,
  };
}

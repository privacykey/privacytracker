"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { TOAST_HOLD_MS } from "../../lib/toast-timing";
import Toast from "./Toast";
import "./device-sync.css";

/**
 * Settings → Devices — one row per known device with rename / re-sync /
 * delete affordances. Reads the server-side initial list to avoid a
 * flash-of-empty, then keeps the list fresh via on-demand re-fetches
 * after mutations.
 *
 * When the URL has `?resync_added=N&resync_removed=M&resync_orphaned=K`,
 * a small toast renders for TOAST_HOLD_MS — the re-sync wizard routes
 * back here on commit and uses these params to signal the outcome.
 */

export interface DeviceListEntry {
  appCount: number;
  createdAt: number;
  deviceClass: string | null;
  ecid: string | null;
  id: string;
  iosVersion: string | null;
  isUnknownPlaceholder: boolean;
  lastSyncedAt: number;
  model: string | null;
  name: string;
}

export default function DevicesView({
  initialDevices,
}: {
  initialDevices: DeviceListEntry[];
}) {
  const t = useTranslations("devices");
  const searchParams = useSearchParams();
  const [devices, setDevices] = useState<DeviceListEntry[]>(initialDevices);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  // Replaces `window.confirm()` — the native dialog is unreliable inside
  // the Tauri webview and gives no preview of what's about to break.
  // Selecting a device here opens an in-app modal styled with the same
  // `.modal-overlay` / `.modal-card` chrome the apps grid uses.
  const [pendingDelete, setPendingDelete] = useState<DeviceListEntry | null>(
    null
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resyncToast, setResyncToast] = useState<{
    added: number;
    removed: number;
    orphaned: number;
    merged: number;
  } | null>(null);

  // One-shot resync-result toast from the URL params (?resync_added=…).
  useEffect(() => {
    const added = Number.parseInt(searchParams?.get("resync_added") ?? "", 10);
    const removed = Number.parseInt(
      searchParams?.get("resync_removed") ?? "",
      10
    );
    const orphaned = Number.parseInt(
      searchParams?.get("resync_orphaned") ?? "",
      10
    );
    const merged = Number.parseInt(
      searchParams?.get("resync_merged") ?? "",
      10
    );
    if (!(Number.isFinite(added) && Number.isFinite(removed))) {
      return;
    }
    setResyncToast({
      added,
      removed,
      orphaned: Number.isFinite(orphaned) ? orphaned : 0,
      merged: Number.isFinite(merged) ? merged : 0,
    });
    const timer = window.setTimeout(() => setResyncToast(null), TOAST_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [searchParams]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/devices", { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as { devices: DeviceListEntry[] };
      setDevices(json.devices ?? []);
    } catch (error) {
      console.warn("[devices] refresh failed:", error);
    }
  }, []);

  const handleRenameStart = (device: DeviceListEntry) => {
    setRenamingId(device.id);
    setRenameValue(device.name);
  };
  const handleRenameCancel = () => {
    setRenamingId(null);
    setRenameValue("");
  };
  const handleRenameSubmit = useCallback(
    async (id: string) => {
      const trimmed = renameValue.trim();
      if (!trimmed) {
        return;
      }
      setBusyId(id);
      try {
        const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        await refresh();
        setRenamingId(null);
        setRenameValue("");
      } catch (error) {
        console.warn("[devices] rename failed:", error);
      } finally {
        setBusyId(null);
      }
    },
    [renameValue, refresh]
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) {
      return;
    }
    const id = pendingDelete.id;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      await refresh();
      setPendingDelete(null);
    } catch (error) {
      console.warn("[devices] delete failed:", error);
    } finally {
      setDeletingId(null);
    }
  }, [pendingDelete, refresh]);

  return (
    <div>
      <h1 className="settings-section-title">{t("page_title")}</h1>
      <p className="settings-section-subtitle">{t("page_subtitle")}</p>

      <Toast style={{ marginBottom: 16 }}>
        {resyncToast && (
          <>
            {t("resync_toast", {
              added: resyncToast.added,
              removed: resyncToast.removed,
              orphaned: resyncToast.orphaned,
            })}
            {resyncToast.merged > 0 && (
              <>
                {" · "}
                {t("resync_toast_merged", { count: resyncToast.merged })}
              </>
            )}
          </>
        )}
      </Toast>

      {devices.length === 0 && (
        <div className="devices-empty">{t("empty")}</div>
      )}

      {pendingDelete && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!deletingId) {
              setPendingDelete(null);
            }
          }}
        >
          <div
            aria-describedby="delete-device-copy"
            aria-labelledby="delete-device-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deletingId) {
                setPendingDelete(null);
              }
            }}
            role="dialog"
          >
            <div className="modal-badge">{t("delete_modal_badge")}</div>
            <h2 className="modal-title" id="delete-device-title">
              {t("delete_modal_title", { name: pendingDelete.name })}
            </h2>
            <p className="modal-copy" id="delete-device-copy">
              {t("delete_modal_body", { count: pendingDelete.appCount })}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={deletingId !== null}
                onClick={() => setPendingDelete(null)}
                type="button"
              >
                {t("delete_modal_cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={deletingId !== null}
                onClick={() => void confirmDelete()}
                type="button"
              >
                {deletingId === null
                  ? t("delete_modal_confirm")
                  : t("delete_modal_deleting")}
              </button>
            </div>
          </div>
        </div>
      )}

      {devices.length > 0 && (
        <ul className="devices-list">
          {devices.map((device) => {
            const isRenaming = renamingId === device.id;
            const isBusy = busyId === device.id;
            const subtitleParts = [
              device.model,
              device.iosVersion,
              t("app_count", { count: device.appCount }),
            ].filter(Boolean);
            return (
              <li className="devices-list-row" key={device.id}>
                <div className="devices-list-row-info">
                  {isRenaming ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleRenameSubmit(device.id);
                      }}
                      style={{ display: "flex", gap: 6, alignItems: "center" }}
                    >
                      <input
                        aria-label={t("rename_input_aria")}
                        autoFocus
                        className="settings-input"
                        disabled={isBusy}
                        onChange={(e) => setRenameValue(e.target.value)}
                        style={{ minWidth: 220 }}
                        type="text"
                        value={renameValue}
                      />
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={isBusy}
                        type="submit"
                      >
                        {t("rename_save")}
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={isBusy}
                        onClick={handleRenameCancel}
                        type="button"
                      >
                        {t("rename_cancel")}
                      </button>
                    </form>
                  ) : (
                    <span className="devices-list-row-name">
                      {device.name}
                      {device.isUnknownPlaceholder && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontWeight: 400,
                            opacity: 0.7,
                          }}
                        >
                          ({t("unknown_placeholder_hint")})
                        </span>
                      )}
                    </span>
                  )}
                  <span className="devices-list-row-meta">
                    {subtitleParts.join(" · ")}
                  </span>
                </div>
                {!isRenaming && (
                  <div className="devices-list-row-actions">
                    <Link
                      className="btn btn-primary btn-sm"
                      href={`/onboard?resync=${encodeURIComponent(device.id)}`}
                    >
                      {t("resync")}
                    </Link>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={isBusy}
                      onClick={() => handleRenameStart(device)}
                      type="button"
                    >
                      {t("rename")}
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      disabled={isBusy}
                      onClick={() => setPendingDelete(device)}
                      type="button"
                    >
                      {t("delete")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

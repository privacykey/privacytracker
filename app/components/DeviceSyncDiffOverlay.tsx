"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useModalFocus } from "../../lib/use-modal-focus";
import "./device-sync.css";

/**
 * Two-screen overlay that drives the re-sync diff commit:
 *
 *   1. Diff selection — adds + removes lists with per-row checkboxes.
 *      Orphan-warning badge on removes that would untrack the app
 *      everywhere.
 *   2. Final confirmation — summary "Removing N · Adding M · Keeping K"
 *      with an orphan callout if any will be untracked entirely.
 *
 * Triggered after an OnboardWizard import finishes when the URL had
 * `?resync=<deviceId>`. The wizard passes the deviceId plus the list of
 * appIds the import just resolved; this overlay fetches the diff from
 * `/api/device-sync/preview`, lets the user tick rows, and commits via
 * `/api/device-sync/commit`.
 */

interface DiffAdd {
  appId: string;
  developer: string | null;
  name: string;
}
interface DiffRemove {
  appId: string;
  name: string;
  wouldOrphan: boolean;
}
interface DiffBundleIdMerge {
  bundleId: string;
  incomingAppId: string;
  incomingName: string;
  previousAppId: string;
  previousName: string;
}
interface DeviceSyncDiff {
  adds: DiffAdd[];
  bundleIdMerges?: DiffBundleIdMerge[];
  deviceId: string;
  removes: DiffRemove[];
  unchanged: number;
}

export interface DeviceSyncDiffOverlayProps {
  /** Apps the just-finished import resolved — used as `currentImport` in
   *  the preview API call. `bundleId` is optional because the preview
   *  endpoint backfills it from `apps.bundleId` when the caller omits
   *  it; passing it here saves the server-side lookup. */
  currentImport: Array<{
    appId: string;
    name: string;
    developer?: string | null;
    bundleId?: string | null;
  }>;
  deviceId: string;
  onClose: () => void;
  /** Fired after a successful commit, with the result counts so the
   *  caller can show a toast / route the user onward. */
  onCommit: (result: {
    added: number;
    removed: number;
    orphanedAndDeleted: number;
    merged: number;
  }) => void;
  open: boolean;
}

export default function DeviceSyncDiffOverlay({
  open,
  deviceId,
  currentImport,
  onClose,
  onCommit,
}: DeviceSyncDiffOverlayProps) {
  const t = useTranslations("device_sync");
  const [diff, setDiff] = useState<DeviceSyncDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"select" | "confirm">("select");
  const [committing, setCommitting] = useState(false);
  const [pickedAdds, setPickedAdds] = useState<Set<string>>(new Set());
  const [pickedRemoves, setPickedRemoves] = useState<Set<string>>(new Set());
  const dialogCardRef = useModalFocus<HTMLDivElement>({
    open,
    onClose,
    closeOnEscape: false,
  });

  // Fetch the diff on open.
  useEffect(() => {
    if (!open) {
      return;
    }
    setLoading(true);
    setError(null);
    setPhase("select");
    fetch("/api/device-sync/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId,
        currentImport,
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as { diff: DeviceSyncDiff };
        setDiff(json.diff);
        // Default-select everything — the common path is "yeah, apply
        // these." User unticks rows they want to keep / skip.
        setPickedAdds(new Set(json.diff.adds.map((a) => a.appId)));
        setPickedRemoves(new Set(json.diff.removes.map((r) => r.appId)));
      })
      .catch((e) => {
        console.warn("[device-sync-overlay] preview failed:", e);
        setError(e instanceof Error ? e.message : "preview failed");
      })
      .finally(() => setLoading(false));
  }, [open, deviceId, currentImport]);

  // Escape closes the overlay (unless committing).
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !committing) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, committing, onClose]);

  const toggleAdd = useCallback((id: string) => {
    setPickedAdds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  const toggleRemove = useCallback((id: string) => {
    setPickedRemoves((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const orphanedThatWillBeRemoved = useMemo(() => {
    if (!diff) {
      return [] as DiffRemove[];
    }
    return diff.removes.filter(
      (r) => pickedRemoves.has(r.appId) && r.wouldOrphan
    );
  }, [diff, pickedRemoves]);

  const handleCommit = useCallback(async () => {
    setCommitting(true);
    setError(null);
    try {
      // Pass the bundle-ID merges the preview detected straight back
      // so the commit step can collapse the duplicate rows in the
      // same transaction. The server re-validates the pair shape.
      const merges = (diff?.bundleIdMerges ?? []).map((m) => ({
        previousAppId: m.previousAppId,
        incomingAppId: m.incomingAppId,
      }));
      const res = await fetch("/api/device-sync/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          addAppIds: Array.from(pickedAdds),
          removeAppIds: Array.from(pickedRemoves),
          bundleIdMerges: merges,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }
      onCommit({
        added: json.added ?? 0,
        removed: json.removed ?? 0,
        orphanedAndDeleted: json.orphanedAndDeleted ?? 0,
        merged: json.merged ?? 0,
      });
    } catch (e) {
      console.warn("[device-sync-overlay] commit failed:", e);
      setError(e instanceof Error ? e.message : "commit failed");
      setCommitting(false);
    }
  }, [deviceId, pickedAdds, pickedRemoves, onCommit, diff]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="device-sync-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !committing) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        aria-labelledby="device-sync-title"
        aria-modal="true"
        className="device-sync-card"
        ref={dialogCardRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="device-sync-card-header">
          <div className="device-sync-card-titles">
            <h2 id="device-sync-title">
              {phase === "select" ? t("diff_title") : t("confirm_title")}
            </h2>
            <p>
              {phase === "select" ? t("diff_subtitle") : t("confirm_subtitle")}
            </p>
          </div>
          <button
            aria-label={t("close_aria")}
            className="device-sync-close"
            disabled={committing}
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>

        {loading && <p>{t("loading")}</p>}
        {error && <p style={{ color: "var(--danger, #ff3b30)" }}>{error}</p>}

        {diff && phase === "select" && (
          <>
            <div className="device-sync-body">
              <SectionAdds
                diff={diff}
                onToggle={toggleAdd}
                picked={pickedAdds}
              />
              <SectionRemoves
                diff={diff}
                onToggle={toggleRemove}
                picked={pickedRemoves}
              />
              {diff.unchanged > 0 && (
                <p className="device-sync-unchanged">
                  {t("unchanged_count", { count: diff.unchanged })}
                </p>
              )}
            </div>
            <footer className="device-sync-footer">
              <span className="device-sync-summary">
                {t("selection_summary", {
                  adds: pickedAdds.size,
                  removes: pickedRemoves.size,
                })}
              </span>
              <button
                className="btn btn-secondary"
                onClick={onClose}
                type="button"
              >
                {t("cancel")}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => setPhase("confirm")}
                type="button"
              >
                {t("continue")}
              </button>
            </footer>
          </>
        )}

        {diff && phase === "confirm" && (
          <>
            <div className="device-sync-body">
              <p className="device-sync-confirm-summary">
                {t.rich("confirm_summary", {
                  adds: pickedAdds.size,
                  removes: pickedRemoves.size,
                  kept: diff.unchanged,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              {orphanedThatWillBeRemoved.length > 0 && (
                <div className="device-sync-orphan-list">
                  <p className="device-sync-orphan-list-title">
                    {t("orphan_heading", {
                      count: orphanedThatWillBeRemoved.length,
                    })}
                  </p>
                  <ul>
                    {orphanedThatWillBeRemoved.map((r) => (
                      <li key={r.appId}>{r.name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <footer className="device-sync-footer">
              <button
                className="btn btn-secondary"
                disabled={committing}
                onClick={() => setPhase("select")}
                type="button"
              >
                {t("back")}
              </button>
              <button
                className="btn btn-primary"
                disabled={committing}
                onClick={() => void handleCommit()}
                type="button"
              >
                {committing ? t("committing") : t("looks_good")}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function SectionAdds({
  diff,
  picked,
  onToggle,
}: {
  diff: DeviceSyncDiff;
  picked: Set<string>;
  onToggle: (id: string) => void;
}) {
  const t = useTranslations("device_sync");
  if (diff.adds.length === 0) {
    return null;
  }
  return (
    <section aria-label={t("adds_aria")} className="device-sync-section">
      <h3 className="device-sync-section-title">
        {t.rich("adds_heading", {
          count: diff.adds.length,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </h3>
      <ul className="device-sync-rows">
        {diff.adds.map((a) => (
          <li className="device-sync-row" key={a.appId}>
            <input
              aria-label={t("add_check_aria", { name: a.name })}
              checked={picked.has(a.appId)}
              className="device-sync-row-check"
              onChange={() => onToggle(a.appId)}
              type="checkbox"
            />
            <div className="device-sync-row-body">
              <span className="device-sync-row-title">{a.name}</span>
              {a.developer && (
                <span className="device-sync-row-subtitle">{a.developer}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SectionRemoves({
  diff,
  picked,
  onToggle,
}: {
  diff: DeviceSyncDiff;
  picked: Set<string>;
  onToggle: (id: string) => void;
}) {
  const t = useTranslations("device_sync");
  if (diff.removes.length === 0) {
    return null;
  }
  return (
    <section aria-label={t("removes_aria")} className="device-sync-section">
      <h3 className="device-sync-section-title">
        {t.rich("removes_heading", {
          count: diff.removes.length,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </h3>
      <ul className="device-sync-rows">
        {diff.removes.map((r) => (
          <li className="device-sync-row" key={r.appId}>
            <input
              aria-label={t("remove_check_aria", { name: r.name })}
              checked={picked.has(r.appId)}
              className="device-sync-row-check"
              onChange={() => onToggle(r.appId)}
              type="checkbox"
            />
            <div className="device-sync-row-body">
              <span className="device-sync-row-title">{r.name}</span>
            </div>
            {r.wouldOrphan && (
              <span
                className="device-sync-row-warning"
                title={t("orphan_warning")}
              >
                {t("orphan_badge")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

"use client";

/**
 * Per-app historical import — the App Detail counterpart to Settings →
 * Historical Import, which runs across the whole library. Sits above the
 * Change History timeline so "where did this app's older entries come
 * from, and can I get more?" is answered in the place the question occurs.
 *
 * The button always posts `force: true`. Without it, a target whose
 * neighbour is already on file is reported `skipped_existing` without the
 * archive ever being asked — right for the scheduled bulk pass, wrong for
 * a person deliberately clicking "check again" after the archive has
 * gained captures (or after a parser fix taught us to read older ones).
 * Forcing cannot duplicate a row: the importer still refuses to store the
 * same capture twice.
 *
 * Gated by `flag.detail.timeline.wayback_import`, which depends on
 * `flag.detail.timeline.wayback_rows` — there is no point importing rows
 * the timeline is configured to hide.
 */

import { useTranslations } from "next-intl";
import { useState } from "react";
import "./app-history-import.css";

interface ImportResult {
  failed: number;
  imported: number;
  skipped: number;
  snapshotsRequested: number;
  unchanged: number;
}

type Status =
  | { kind: "ok"; text: string; note: string | null }
  | { kind: "error"; text: string };

export default function AppHistoryImportCard({
  appId,
  onImported,
}: {
  appId: string;
  /** Called after a run that actually wrote rows, so the timeline refetches. */
  onImported?: () => void;
}) {
  const t = useTranslations("app_detail.history_import");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const run = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(appId)}/import-history`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: true }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        code?: string;
        error?: string;
        result?: ImportResult;
      } | null;
      if (!res.ok) {
        // archive.org throttling is common and self-resolving, so it gets
        // plain-language copy instead of the raw error. Everything else
        // falls back to the route's own message (no App Store URL, our own
        // per-app rate limit), then to the status code.
        throw new Error(
          data?.code === "archive_unavailable"
            ? t("failed_archive_busy")
            : (data?.error ?? t("failed_status", { status: res.status }))
        );
      }
      const result = data?.result;
      if (!result) {
        throw new Error(t("failed_generic"));
      }
      // Rows actually written = `imported` + `unchanged`. The importer's
      // `imported` counts only rows whose labels differ from the capture
      // before them (plus the oldest, which is the baseline), so a run that
      // reconstructs twenty quarters of a stable app reports `imported: 1`
      // while twenty-one rows appear on the timeline. Counting only
      // `imported` here said "Added 1 snapshot" after adding 21.
      const added = result.imported + result.unchanged;
      // One headline plus, when something needs explaining, one note. The
      // per-target detail lives in the activity log; this card is a
      // yes/no/how-many answer.
      const note =
        result.failed > 0
          ? t("note_failed", { count: result.failed })
          : result.snapshotsRequested > 0
            ? t("note_snapshot_requested")
            : null;
      setStatus({
        kind: "ok",
        text:
          added > 0
            ? t("result_imported", { count: added })
            : t("result_nothing_new"),
        note,
      });
      if (added > 0) {
        onImported?.();
      }
    } catch (error) {
      setStatus({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-history-import">
      <div className="app-history-import-copy">
        <h3 className="app-history-import-title">
          <span aria-hidden="true">🕰</span> {t("title")}
        </h3>
        <p className="app-history-import-body">{t("body")}</p>
      </div>
      <div className="app-history-import-action">
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void run()}
          title={t("button_title")}
          type="button"
        >
          {busy ? (
            <>
              <span className="spinner" /> {t("button_busy")}
            </>
          ) : (
            t("button")
          )}
        </button>
        {status ? (
          <div
            className={`app-history-import-status ${status.kind}`}
            role={status.kind === "error" ? "alert" : "status"}
          >
            <div>{status.text}</div>
            {status.kind === "ok" && status.note ? (
              <div className="app-history-import-note">{status.note}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

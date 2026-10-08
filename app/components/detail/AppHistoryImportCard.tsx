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
 *
 * On the Rust backend the result counts label changes, and the card says
 * how many it found, how many pages it read, and when the app's archived
 * history starts if that is well after February 2021; a throttled archive
 * gets the time to try again. Without those fields (the Node rollback)
 * it reports snapshot rows as before. lib/wayback-app-import.ts decides.
 */

import { useTranslations } from "next-intl";
import { useState } from "react";
import { formatDate } from "../../../lib/date-format";
import { useDateFormat } from "../../../lib/date-format-hook";
import {
  describeWaybackAppImport,
  describeWaybackAppImportFailure,
  parseWaybackAppImportResult,
  type WaybackImportFailure,
  type WaybackImportMessage,
} from "../../../lib/wayback-app-import";
import { formatWaybackClockTime } from "../../../lib/wayback-time";
import "./app-history-import.css";

// Kept as descriptors, not text, so dates and times follow the user's
// date format even if it changes while the result is on screen.
type Status =
  | {
      kind: "ok";
      headline: WaybackImportMessage;
      notes: WaybackImportMessage[];
    }
  | { kind: "error"; failure: WaybackImportFailure };

export default function AppHistoryImportCard({
  appId,
  onImported,
}: {
  appId: string;
  /** Called after a run that actually wrote rows, so the timeline refetches. */
  onImported?: () => void;
}) {
  const t = useTranslations("app_detail.history_import");
  const dateMode = useDateFormat();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const say = (message: WaybackImportMessage): string => {
    if (message.key === "note_starts_on") {
      return t("note_starts_on", {
        date: formatDate(message.values.dateMs, dateMode),
      });
    }
    return "values" in message
      ? t(message.key, message.values)
      : t(message.key);
  };

  const sayFailure = (failure: WaybackImportFailure): string => {
    if ("message" in failure) {
      return failure.message;
    }
    if (failure.key === "failed_archive_busy_until") {
      return t("failed_archive_busy_until", {
        time: formatWaybackClockTime(failure.values.retryAtMs, dateMode),
      });
    }
    return "values" in failure
      ? t(failure.key, failure.values)
      : t(failure.key);
  };

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
        code?: unknown;
        error?: unknown;
        result?: unknown;
        retryAfterMs?: unknown;
      } | null;
      if (!res.ok) {
        // archive.org throttling is common and self-resolving, so it gets
        // plain-language copy (with the time to try again, when the server
        // sent one) instead of the raw error. Everything else falls back to
        // the route's own message (no App Store URL, our own per-app rate
        // limit), then to the status code.
        setStatus({
          kind: "error",
          failure: describeWaybackAppImportFailure(
            res.status,
            data,
            res.headers.get("retry-after")
          ),
        });
        return;
      }
      const result = parseWaybackAppImportResult(data?.result);
      if (!result) {
        setStatus({ kind: "error", failure: { message: t("failed_generic") } });
        return;
      }
      // One headline plus, when something needs explaining, a note or two.
      // The per-target detail lives in the activity log; this card is a
      // yes/no/how-many answer.
      const outcome = describeWaybackAppImport(result);
      setStatus({
        kind: "ok",
        headline: outcome.headline,
        notes: outcome.notes,
      });
      if (outcome.rowsAdded > 0) {
        onImported?.();
      }
    } catch (error) {
      setStatus({
        kind: "error",
        failure: {
          message: error instanceof Error ? error.message : String(error),
        },
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
            <div>
              {status.kind === "ok"
                ? say(status.headline)
                : sayFailure(status.failure)}
            </div>
            {status.kind === "ok"
              ? status.notes.map((note) => (
                  <div className="app-history-import-note" key={note.key}>
                    {say(note)}
                  </div>
                ))
              : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

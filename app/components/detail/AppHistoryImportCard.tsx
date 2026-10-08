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
 *
 * When the server says the history starts late (coverage, P5), the card
 * explains that a renamed app's older pages may sit under its old address
 * and takes up to three older App Store addresses, posted as the whole
 * `alternateUrls` list with the import; each stored address can be
 * removed the same way. The route is the authority on what it accepts
 * (lib/wayback-alternate-urls.ts only catches the obvious mistakes first).
 */

import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { formatDate } from "../../../lib/date-format";
import { useDateFormat } from "../../../lib/date-format-hook";
import {
  type AlternateUrlProblem,
  checkAlternateUrl,
  isAlternateUrlRejection,
  MAX_ALTERNATE_URLS,
  withAlternateUrl,
  withoutAlternateUrl,
} from "../../../lib/wayback-alternate-urls";
import {
  describeWaybackAppImport,
  describeWaybackAppImportFailure,
  parseWaybackAppImportResult,
  type WaybackAlternateState,
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
  // From the last result that reported them; kept while a later run is
  // in flight or fails, so the list never blinks out.
  const [alternates, setAlternates] = useState<WaybackAlternateState | null>(
    null
  );
  const [lookupUrl, setLookupUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [altProblem, setAltProblem] = useState<AlternateUrlProblem | null>(
    null
  );
  const inputId = useId();
  const errorId = useId();
  const storedId = useId();

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

  const sayProblem = (problem: AlternateUrlProblem): string => {
    switch (problem) {
      case "not_app_store":
        return t("alt_error_not_app_store");
      case "other_app":
        return t("alt_error_other_app", { appId });
      case "duplicate":
        return t("alt_error_duplicate");
      case "limit":
        return t("alt_limit", { max: MAX_ALTERNATE_URLS });
      default:
        return t("alt_error_rejected");
    }
  };

  /**
   * One import. `alternateUrls`, when given, replaces the stored older
   * addresses (an empty list clears them); left out, the route keeps
   * whatever it has. `adding` clears the typed address once it is stored.
   */
  const run = async (alternateUrls?: string[], adding = false) => {
    const previous = status;
    setBusy(true);
    setStatus(null);
    setAltProblem(null);
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(appId)}/import-history`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            alternateUrls ? { force: true, alternateUrls } : { force: true }
          ),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        code?: unknown;
        error?: unknown;
        result?: unknown;
        retryAfterMs?: unknown;
      } | null;
      if (!res.ok) {
        if (isAlternateUrlRejection(data)) {
          // Nothing ran: the last result still stands, and the problem is
          // said next to the address.
          setStatus(previous);
          setAltProblem("rejected");
          return;
        }
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
      setAlternates(outcome.alternates);
      setLookupUrl(result.lookupUrl);
      if (adding) {
        setDraft("");
      }
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

  const addAlternate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const existing = alternates?.urls ?? [];
    const check = checkAlternateUrl(draft, { appId, existing, lookupUrl });
    if (!check.ok) {
      setAltProblem(check.problem);
      return;
    }
    void run(withAlternateUrl(existing, check.url), true);
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
      {alternates ? (
        <div className="app-history-import-alt">
          {alternates.late ? (
            <p className="app-history-import-alt-help">{t("alt_help")}</p>
          ) : null}
          {alternates.urls.length > 0 ? (
            <>
              <div className="app-history-import-alt-heading" id={storedId}>
                {t("alt_stored")}
              </div>
              <ul
                aria-labelledby={storedId}
                className="app-history-import-alt-list"
              >
                {alternates.urls.map((url) => (
                  <li key={url}>
                    <span className="app-history-import-alt-url">{url}</span>
                    <button
                      aria-label={t("alt_remove_aria", { url })}
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() =>
                        void run(withoutAlternateUrl(alternates.urls, url))
                      }
                      type="button"
                    >
                      {t("alt_remove")}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {alternates.canAdd ? (
            <form
              className="app-history-import-alt-form"
              noValidate
              onSubmit={addAlternate}
            >
              <label className="app-history-import-alt-label" htmlFor={inputId}>
                {t("alt_label")}
              </label>
              <div className="app-history-import-alt-row">
                <input
                  aria-describedby={altProblem ? errorId : undefined}
                  aria-invalid={altProblem ? true : undefined}
                  autoCapitalize="none"
                  autoComplete="off"
                  className="settings-input"
                  id={inputId}
                  inputMode="url"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setAltProblem(null);
                  }}
                  placeholder={t("alt_placeholder", { appId })}
                  spellCheck={false}
                  type="text"
                  value={draft}
                />
                <button
                  className="btn btn-secondary"
                  disabled={busy || draft.trim() === ""}
                  type="submit"
                >
                  {t("alt_add")}
                </button>
              </div>
            </form>
          ) : alternates.late ? (
            <p className="app-history-import-alt-help">
              {t("alt_limit", { max: MAX_ALTERNATE_URLS })}
            </p>
          ) : null}
          {altProblem ? (
            <div
              className="app-history-import-alt-error"
              id={errorId}
              role="alert"
            >
              <span aria-hidden="true">⚠</span> {sayProblem(altProblem)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

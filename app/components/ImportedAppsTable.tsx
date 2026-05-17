"use client";

/**
 * Step-2 imported-apps table — the user-facing surface for the structured
 * `ImportedAppEntry[]` state. Replaces the previous newline-delimited
 * textarea so bundle IDs and developer hints (captured at import time
 * from cfgutil / CSV) can't silently disappear when the user edits the
 * list — every row is a removable record that visually surfaces what
 * we know about it.
 *
 * Three render zones:
 *   1. Row count header                 ("212 apps ready to search")
 *   2. Scrollable list of removable rows (one per ImportedAppEntry)
 *   3. Inline "+ Add" textarea          (multi-line paste supported)
 *
 * Adding works via:
 *   - Newline-separated paste/typed input → "+ Add" button (commits +
 *     clears the textarea).
 *   - Cmd/Ctrl-Enter inside the textarea (keyboard shortcut for the
 *     button, mirrors the rest of the codebase's submit chords).
 *
 * Removing works per-row via the ✕ button — there's no bulk-remove
 * because edits at step 2 are usually surgical ("oh I shouldn't have
 * imported X"). A "Clear all" affordance lives outside this component
 * (e.g. the "Re-run import" link on the upload summary).
 *
 * Bundle-ID + developer chips are read-only summaries — they tell the
 * user "we kept this with the row" so they understand what they'd lose
 * by removing it.
 */

import { useTranslations } from "next-intl";
import { useState } from "react";
// Co-located CSS — Turbopack hot-reloads reliably this way; the giant
// globals.css has burned us on incremental builds.
import "./onboard-step2.css";

export interface ImportedAppEntryView {
  bundleId?: string;
  developer?: string;
  id: string;
  likelyWebClip?: boolean;
  name: string;
  source: "manual" | "cfgutil" | "file" | "ocr";
}

interface Props {
  entries: ImportedAppEntryView[];
  onAdd: (rawText: string) => void;
  onRemove: (id: string) => void;
}

export default function ImportedAppsTable({ entries, onRemove, onAdd }: Props) {
  const t = useTranslations("onboard.step2.table");
  const [pending, setPending] = useState("");

  const handleSubmit = () => {
    if (pending.trim().length === 0) {
      return;
    }
    onAdd(pending);
    setPending("");
  };

  const isEmpty = entries.length === 0;

  return (
    <div className="imported-apps-table">
      <div className="imported-apps-table-header">
        <span
          className="imported-apps-table-count"
          data-testid="imported-apps-count"
        >
          {isEmpty
            ? t("empty_header")
            : t("count_header", { count: entries.length })}
        </span>
      </div>

      {/* Rows. Wrapped in a scroll container so a 200-app cfgutil
          import doesn't push the bulk-paste input + footer button off
          the viewport. Empty state renders an inline hint inside the
          same container so the layout shape stays consistent. */}
      <div
        className={`imported-apps-table-rows${isEmpty ? "is-empty" : ""}`}
        data-testid="imported-apps-rows"
        role="list"
      >
        {isEmpty ? (
          <div className="imported-apps-table-empty-hint">
            {t("empty_hint")}
          </div>
        ) : (
          entries.map((entry) => (
            <ImportedAppRow
              entry={entry}
              key={entry.id}
              onRemove={onRemove}
              t={t}
            />
          ))
        )}
      </div>

      {/* Inline bulk-paste input. Newline-separated names — commits
          on "+ Add" click or Cmd/Ctrl-Enter inside the textarea. */}
      <div className="imported-apps-table-add">
        <textarea
          className="textarea imported-apps-table-add-input"
          data-testid="onboard-app-names"
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t("add_placeholder")}
          rows={3}
          value={pending}
        />
        <button
          className="btn btn-secondary imported-apps-table-add-btn"
          data-testid="imported-apps-add"
          disabled={pending.trim().length === 0}
          onClick={handleSubmit}
          type="button"
        >
          {t("add_label")}
        </button>
      </div>
    </div>
  );
}

function ImportedAppRow({
  entry,
  onRemove,
  t,
}: {
  entry: ImportedAppEntryView;
  onRemove: (id: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="imported-apps-row" role="listitem">
      <div className="imported-apps-row-main">
        <span className="imported-apps-row-name">{entry.name}</span>
        {entry.developer && (
          <span className="imported-apps-row-developer">{entry.developer}</span>
        )}
      </div>
      <div className="imported-apps-row-chips">
        {entry.bundleId && (
          <span
            className="imported-apps-row-chip imported-apps-row-chip-bundle"
            title={t("chip_bundle_title", { bundleId: entry.bundleId })}
          >
            {t("chip_bundle_label")}
          </span>
        )}
        {entry.likelyWebClip && (
          <span
            className="imported-apps-row-chip imported-apps-row-chip-webclip"
            title={t("chip_webclip_title")}
          >
            {t("chip_webclip_label")}
          </span>
        )}
        <span
          className={`imported-apps-row-source imported-apps-row-source-${entry.source}`}
          title={t(`source_title.${entry.source}` as "source_title.manual")}
        >
          {t(`source_label.${entry.source}` as "source_label.manual")}
        </span>
      </div>
      <button
        aria-label={t("remove_aria", { name: entry.name })}
        className="imported-apps-row-remove"
        onClick={() => onRemove(entry.id)}
        title={t("remove_title", { name: entry.name })}
        type="button"
      >
        ✕
      </button>
    </div>
  );
}

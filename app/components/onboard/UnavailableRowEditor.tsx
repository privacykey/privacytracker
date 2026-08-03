"use client";

/**
 * Inline editor for a row that found no App Store match.
 *
 * Unchanged text is still submittable: the parent passes `force=true`, so
 * "Search again" replays the same query, which is what you want after a
 * transient iTunes miss or a since-unblocked security gate.
 */

import { useTranslations } from "next-intl";
import { useState } from "react";

export default function UnavailableRowEditor({
  initialQuery,
  busyEditing,
  onRetry,
  onCancel,
}: {
  busyEditing: boolean;
  initialQuery: string;
  onCancel: () => void;
  onRetry: (nextQuery: string) => void;
}) {
  const t = useTranslations("onboard.search_block");
  const [draft, setDraft] = useState(initialQuery);
  const trimmed = draft.trim();
  // Unchanged text is still submittable — the parent passes force=true,
  // so "Search again" replays the same query (useful after a transient
  // iTunes miss or a since-unblocked security gate).
  const canSubmit = !busyEditing && trimmed.length > 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flex: "1 1 100%",
        flexWrap: "wrap",
      }}
    >
      <input
        autoFocus
        className="settings-input"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSubmit) {
            e.preventDefault();
            onRetry(trimmed);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={t("edit_app_name")}
        style={{ flex: "1 1 220px", minWidth: 0 }}
        type="text"
        value={draft}
      />
      <button
        className="btn btn-primary btn-sm"
        disabled={!canSubmit}
        onClick={() => onRetry(trimmed)}
        type="button"
      >
        {busyEditing ? <span className="spinner-sm" /> : t("search_again")}
      </button>
      <button
        className="btn btn-secondary btn-sm"
        disabled={busyEditing}
        onClick={onCancel}
        type="button"
      >
        {t("cancel")}
      </button>
    </div>
  );
}

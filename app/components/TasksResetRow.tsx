"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { emitUserTasksRefresh } from "./UserTasksProvider";

/**
 * "Show all tasks again" row — Developer Options entry that wipes the
 * user-tasks state blob in `app_settings`, so dismissed-or-completed
 * tasks resurface for re-engagement. Used as a reset escape hatch (the
 * plan also calls out a future "Replay coachmark tour" sibling control
 * here — wire it in alongside when that ships).
 */
export default function TasksResetRow() {
  const t = useTranslations("settings.dev.reset_tasks");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const onClick = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setDone(false);
    try {
      const res = await fetch("/api/user-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_all" }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      emitUserTasksRefresh();
      setDone(true);
      window.setTimeout(() => setDone(false), 2400);
    } catch (error) {
      console.warn("[settings] reset tasks failed:", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="settings-field-row"
      style={{ marginTop: 6, marginBottom: 18 }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <strong style={{ fontSize: 14 }}>{t("title")}</strong>
        <span className="settings-field-help">{t("description")}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {done && (
          <span role="status" style={{ fontSize: 12, color: "var(--text-2)" }}>
            {t("done")}
          </span>
        )}
        <button
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => void onClick()}
          type="button"
        >
          {busy ? t("busy") : t("cta")}
        </button>
      </div>
    </div>
  );
}

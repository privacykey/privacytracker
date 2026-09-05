"use client";

/**
 * Per-type notification preferences plus the autosave-to-TaskCenter
 * toggle. The prefs object and its debounced save live in SettingsView
 * because the bell and the notification API routes share them.
 *
 * Anchor id `notifications` — see ./README.md on why ids are load-bearing.
 */

import { useTranslations } from "next-intl";
import type * as React from "react";
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_TYPE_KEYS,
  type NotificationTypeKey,
} from "@/lib/notification-prefs";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";

export default function NotificationPrefsSection({
  autosaveLogToTaskCenter,
  notificationPrefs,
  notificationPrefsAutoSave,
  onAutosaveLogToggle,
  savedNotificationPrefs,
  scheduleNotificationPrefsSave,
  setNotificationPrefs,
}: {
  autosaveLogToTaskCenter: boolean;
  notificationPrefs: Record<NotificationTypeKey, boolean>;
  notificationPrefsAutoSave: ReturnType<
    typeof useSettingsAutoSave<Record<NotificationTypeKey, boolean>>
  >;
  onAutosaveLogToggle: (next: boolean) => void;
  savedNotificationPrefs: Record<NotificationTypeKey, boolean>;
  scheduleNotificationPrefsSave: (
    next: Record<NotificationTypeKey, boolean>
  ) => void;
  setNotificationPrefs: React.Dispatch<
    React.SetStateAction<Record<NotificationTypeKey, boolean>>
  >;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tAria = useTranslations("settings.aria");
  const tNotifPrefs = useTranslations("notification_prefs");
  const tNotifPrefsCard = useTranslations("settings.notification_prefs_card");

  return (
    <div className="settings-section" id="notifications">
      <h2 className="settings-section-title">{tSections("notifications")}</h2>
      <p className="settings-section-subtitle">{tSub("notifications")}</p>

      <div
        aria-label={tAria("notification_types")}
        className="notification-prefs-list"
        role="group"
      >
        {NOTIFICATION_TYPE_KEYS.map((key) => {
          const enabled = notificationPrefs[key];
          const inputId = `notif-pref-${key}`;
          // Map the camelCase enum key onto the snake_case
          // translation-key prefix used in the locale bundle
          // (e.g. `labelChanges` → `label_changes`).
          const tKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
          return (
            <label
              className="notification-prefs-row"
              htmlFor={inputId}
              key={key}
            >
              <input
                checked={enabled}
                className="notification-prefs-toggle"
                id={inputId}
                onChange={(event) => {
                  const next = {
                    ...notificationPrefs,
                    [key]: event.target.checked,
                  };
                  setNotificationPrefs(next);
                  // Auto-save: debounced PUT so rapid toggling
                  // collapses into one server write + one toast.
                  scheduleNotificationPrefsSave(next);
                }}
                type="checkbox"
              />
              <span className="notification-prefs-copy">
                <span className="notification-prefs-label">
                  {tNotifPrefs(`${tKey}_label`)}
                </span>
                <span className="notification-prefs-description">
                  {tNotifPrefs(`${tKey}_desc`)}
                </span>
                <span className="notification-prefs-example">
                  {tNotifPrefs(`${tKey}_example`)}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
          marginTop: 14,
        }}
      >
        {/* Save button removed — checkboxes auto-save via debounced
              `scheduleNotificationPrefsSave`. The Reset Defaults helper
              stays so power users can wipe to baseline in one click; it
              also routes through the same debounced save path. */}
        <button
          className="btn btn-ghost"
          disabled={
            notificationPrefsAutoSave.saving ||
            NOTIFICATION_TYPE_KEYS.every(
              (key) =>
                notificationPrefs[key] === DEFAULT_NOTIFICATION_PREFS[key]
            )
          }
          onClick={() => {
            const next = { ...DEFAULT_NOTIFICATION_PREFS };
            setNotificationPrefs(next);
            scheduleNotificationPrefsSave(next);
          }}
          type="button"
        >
          {tNotifPrefsCard("reset_defaults")}
        </button>
        {NOTIFICATION_TYPE_KEYS.every(
          (key) => notificationPrefs[key] === savedNotificationPrefs[key]
        ) && (
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            {tNotifPrefsCard("up_to_date")}
          </span>
        )}
      </div>

      {/* Settings-autosave Task Center mirror. Lives at the bottom of
            the Notifications section because it's a "where does this
            notice show up" control — the bell vs. the Task Center
            dropdown — rather than a per-event toggle like the rows
            above. localStorage-backed, per-browser. */}
      <label className="settings-checkbox-row" style={{ marginTop: 14 }}>
        <input
          checked={autosaveLogToTaskCenter}
          className="settings-checkbox"
          onChange={(e) => onAutosaveLogToggle(e.target.checked)}
          type="checkbox"
        />
        <span>
          {tNotifPrefsCard("autosave_log_label")}
          <span
            className="settings-field-help"
            style={{ display: "block", marginTop: 4 }}
          >
            {tNotifPrefsCard("autosave_log_help")}
          </span>
        </span>
      </label>
    </div>
  );
}

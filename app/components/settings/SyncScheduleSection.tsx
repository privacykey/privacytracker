"use client";

/**
 * Background-sync cadence picker.
 *
 * Auto-saves: clicking a card flips local state AND fires the POST, with
 * the bottom-centre toast surfacing success/failure. There is no Save
 * button — the "current" badge is how you tell what is actually
 * persisted, which is why it reads from the fetched `status` rather than
 * from local state.
 *
 * The options are a `role="radiogroup"` of `role="radio"` buttons rather
 * than native inputs so they can carry the design system's card styling;
 * `followFocus: false` on the roving handler is deliberate, because
 * arrowing onto a card here would otherwise fire a server write.
 *
 * Anchor id `sync-schedule` matches the SettingsSidebar entry — see
 * ./README.md.
 */

import { useTranslations } from "next-intl";
import type { KeyboardEvent } from "react";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";
import type { Schedule, SyncStatus } from "./types";

const SCHEDULE_OPTIONS: { value: Schedule; label: string; desc: string }[] = [
  { value: "manual", label: "Manual", desc: "Only sync when you ask" },
  { value: "daily", label: "Daily", desc: "Every 24 hours automatically" },
  { value: "weekly", label: "Weekly", desc: "Once a week automatically" },
];

export default function SyncScheduleSection({
  schedule,
  setSchedule,
  autoSave,
  onRadioKeyDown,
  status,
}: {
  schedule: Schedule;
  setSchedule: (next: Schedule) => void;
  autoSave: ReturnType<typeof useSettingsAutoSave<Schedule>>;
  onRadioKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Null until `loadStatus()` resolves; the "current" badge waits for it. */
  status: SyncStatus | null;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tAria = useTranslations("settings.aria");
  const tSchedule = useTranslations("settings.schedule");

  return (
    <div className="settings-section" id="sync-schedule">
      <h2 className="settings-section-title">{tSections("sync_schedule")}</h2>
      <p className="settings-section-subtitle">{tSub("sync_schedule")}</p>

      <div
        aria-label={tAria("sync_interval")}
        className="schedule-options"
        onKeyDown={onRadioKeyDown}
        role="radiogroup"
      >
        {SCHEDULE_OPTIONS.map((opt) => {
          const selected = schedule === opt.value;
          // Localise label + desc per option. The English fallback covers a
          // new schedule value landing in SCHEDULE_OPTIONS before its
          // translation key exists.
          const localisedLabel = (() => {
            try {
              return tSchedule(`${opt.value}_label`);
            } catch {
              return opt.label;
            }
          })();
          const localisedDesc = (() => {
            try {
              return tSchedule(`${opt.value}_desc`);
            } catch {
              return opt.desc;
            }
          })();
          return (
            <button
              aria-checked={selected}
              className={`schedule-option ${selected ? "active" : ""}`}
              disabled={autoSave.saving}
              key={opt.value}
              onClick={() => {
                setSchedule(opt.value);
                void autoSave.save(opt.value);
              }}
              role="radio"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              <div className="schedule-option-label">{localisedLabel}</div>
              <div className="schedule-option-desc">{localisedDesc}</div>
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {status && schedule === status.schedule && (
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            {tSchedule("current")}
          </span>
        )}
      </div>
    </div>
  );
}

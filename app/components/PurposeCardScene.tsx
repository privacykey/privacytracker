/**
 * PurposeCardScene — the small animated "what this purpose does" vignettes
 * shown on the /welcome purpose cards (monitor / clean up / help). Pure,
 * presentational (no hooks), so it renders in both client components
 * (FocusPurposeForm) and server components (/help/focus). All copy is passed
 * in so the caller owns its own translation runtime.
 *
 * Styles live in app/globals.css under `.focus-purpose-scene` / `.fps-*`.
 */

import type { PrimaryPurpose } from "@/lib/onboarding-purpose";

/**
 * /welcome primary-purpose icons. Used as the non-animated fallback (the
 * settings focus editor and any `custom` purpose that has no scene).
 */
export const PURPOSE_ICONS: Record<PrimaryPurpose, string> = {
  monitor: "🔍",
  cleanup: "🧹",
  help: "🧭",
  custom: "⚙️",
};

const CLEANUP_REVIEW_APPS = [
  { action: "keep", name: "ShopPop" },
  { action: "remove", name: "OldChat" },
  { action: "keep", name: "Notes" },
  { action: "keep", name: "GameBox" },
] as const;

const CLEANUP_ACTION_MARKS = {
  keep: "✓",
  remove: "×",
} as const;

const HOME_SCREEN_APPS = [
  { action: "keep", name: "Mail", short: "M" },
  { action: "keep", name: "Maps", short: "M" },
  { action: "keep", name: "Notes", short: "N" },
  { action: "keep", name: "Pay", short: "P" },
  { action: "keep", name: "ShopPop", short: "S" },
  { action: "remove", name: "OldChat", short: "O" },
  { action: "keep", name: "GameBox", short: "G" },
  { action: "keep", name: "FitLoop", short: "F" },
] as const;

const FAMILY_PHONE_COLORS = ["blue", "green", "rose"] as const;

export interface PurposeCardSceneProps {
  deleteLabel: string;
  helpDetail: string;
  helpTitle: string;
  monitorChangeText: string;
  monitorTitle: string;
  purpose: PrimaryPurpose;
}

export default function PurposeCardScene({
  deleteLabel,
  helpDetail,
  helpTitle,
  monitorChangeText,
  monitorTitle,
  purpose,
}: PurposeCardSceneProps) {
  if (purpose === "monitor") {
    return (
      <div
        aria-hidden="true"
        className="focus-purpose-scene focus-purpose-scene--monitor"
      >
        <div className="fps-phone fps-monitor-phone">
          <div className="fps-phone-speaker" />
          <div className="fps-ios-app fps-ios-app--updating">
            <span className="fps-shared-app-mark" />
            <span className="fps-loader" />
          </div>
        </div>
        <div className="fps-desktop fps-monitor-desktop">
          <div className="fps-desktop-screen">
            <div className="fps-notification fps-monitor-notification">
              <span className="fps-notification-app-icon">
                <span className="fps-shared-app-mark" />
              </span>
              <strong>{monitorTitle}</strong>
              <span>{monitorChangeText}</span>
            </div>
          </div>
          <div className="fps-desktop-stand" />
        </div>
      </div>
    );
  }

  if (purpose === "cleanup") {
    return (
      <div
        aria-hidden="true"
        className="focus-purpose-scene focus-purpose-scene--cleanup"
      >
        <div className="fps-cleanup-list">
          {CLEANUP_REVIEW_APPS.map((app) => (
            <div className="fps-cleanup-row" key={app.name}>
              <span className="fps-cleanup-row-app">{app.name}</span>
              <span
                className={`fps-cleanup-row-action fps-cleanup-row-action--${app.action}`}
              >
                {CLEANUP_ACTION_MARKS[app.action]}
              </span>
            </div>
          ))}
        </div>
        <div className="fps-home-screen">
          <div className="fps-home-grid">
            {HOME_SCREEN_APPS.map((app, index) => (
              <span
                className={`fps-home-app fps-home-app--${index + 1} fps-home-app--${app.action}`}
                key={app.name}
              >
                <span className="fps-home-app-initial">{app.short}</span>
                {app.action === "remove" && (
                  <span className="fps-home-app-name">{app.name}</span>
                )}
              </span>
            ))}
          </div>
          <div className="fps-delete-confirm">{deleteLabel}</div>
          <span className="fps-tap-pulse" />
        </div>
      </div>
    );
  }

  if (purpose === "help") {
    return (
      <div
        aria-hidden="true"
        className="focus-purpose-scene focus-purpose-scene--help"
      >
        <div className="fps-family-phones">
          {FAMILY_PHONE_COLORS.map((color, phoneIndex) => (
            <div
              className={`fps-child-phone fps-child-phone--${color}`}
              key={color}
            >
              {Array.from({ length: 6 }).map((_, appIndex) => (
                <span
                  className={`fps-child-app fps-child-app--${phoneIndex + 1}-${appIndex + 1} ${
                    (color === "blue" || color === "green") && appIndex === 0
                      ? "fps-child-app--flagged"
                      : ""
                  }`}
                  key={`${color}-${appIndex}`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="fps-help-desktop">
          <div className="fps-desktop-screen">
            <div className="fps-tracker-grid">
              {Array.from({ length: 9 }).map((_, index) => (
                <span className="fps-tracker-app" key={index} />
              ))}
            </div>
            <div className="fps-notification fps-help-notification">
              <span className="fps-profile-alert-icon" />
              <strong>{helpTitle}</strong>
              <span>{helpDetail}</span>
            </div>
          </div>
          <div className="fps-desktop-stand" />
        </div>
        <span className="fps-app-stream fps-app-stream--one" />
        <span className="fps-app-stream fps-app-stream--two" />
        <span className="fps-app-stream fps-app-stream--three" />
      </div>
    );
  }

  return (
    <span aria-hidden="true" className="welcome-card-icon">
      {PURPOSE_ICONS[purpose]}
    </span>
  );
}

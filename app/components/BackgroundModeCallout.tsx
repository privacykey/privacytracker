"use client";

/**
 * Compact dashboard callout that points users at the
 * {@link BackgroundModeWizard}. Lives in the focus strip area of
 * HomeView so it shares the visual weight of the audience/goals
 * chips next to it.
 *
 * Tauri-only. Mounted by HomeView when:
 *   - the page is being viewed inside the desktop shell
 *     (`isDesktop()` returns true at runtime), AND
 *   - the feature flag `flag.dashboard.background_mode_wizard` is on, AND
 *   - the user hasn't dismissed or completed the wizard yet
 *     (`background_wizard_completed_at` + `background_wizard_dismissed_at`
 *     both empty in app_settings).
 *
 * Clicking "Set up" opens the wizard modal. "Not now" dismisses
 * permanently (re-discoverable via Settings).
 */

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { isDesktop } from "../../lib/desktop";
import BackgroundModeWizard from "./BackgroundModeWizard";

interface Props {
  /** Server-resolved initial visibility — populated when no completion
   *  or dismissal timestamp is present in app_settings. Components
   *  mount with this honoured, then watch for runtime updates. */
  initiallyVisible: boolean;
}

export default function BackgroundModeCallout({ initiallyVisible }: Props) {
  const t = useTranslations("background_mode_callout");
  const [visible, setVisible] = useState(initiallyVisible);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [confirmedDesktop, setConfirmedDesktop] = useState(false);

  // `isDesktop()` reads `window.__TAURI_INTERNALS__`, which is only
  // populated client-side. Defer the runtime check to mount so SSR
  // doesn't render the callout for web users (the server has no way
  // to know which build the user is on — the env-var path covers
  // Docker/CLI but not visitor browsers).
  useEffect(() => {
    setConfirmedDesktop(isDesktop());
  }, []);

  if (!(visible && confirmedDesktop)) {
    return null;
  }

  const handleDismiss = async () => {
    setVisible(false);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          background_wizard_dismissed_at: String(Date.now()),
        }),
      });
    } catch (err) {
      console.warn("[BackgroundModeCallout] dismiss save failed:", err);
    }
  };

  return (
    <>
      <div
        aria-label={t("region_aria")}
        className="bg-mode-callout"
        role="region"
      >
        <span aria-hidden="true" className="bg-mode-callout-icon">
          🌙
        </span>
        <div className="bg-mode-callout-text">
          <strong className="bg-mode-callout-title">{t("title")}</strong>
          <span className="bg-mode-callout-body">{t("body")}</span>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setWizardOpen(true)}
          type="button"
        >
          {t("cta")}
        </button>
        <button
          aria-label={t("dismiss_aria")}
          className="bg-mode-callout-dismiss"
          onClick={() => void handleDismiss()}
          title={t("dismiss_title")}
          type="button"
        >
          ✕
        </button>
      </div>
      {wizardOpen && (
        <BackgroundModeWizard
          onClose={(outcome) => {
            setWizardOpen(false);
            if (outcome === "completed") {
              setVisible(false);
            }
          }}
        />
      )}
    </>
  );
}

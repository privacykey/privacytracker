"use client";

/**
 * Step 1 — pick how to get the app list in.
 *
 * The method cards are ordered by device class (a phone leads with
 * screenshots, a Mac with Apple Configurator), and each card is
 * independently flag-gated, so the set on screen varies per install.
 */

import Link from "next/link";
import { COUNTRY_OPTIONS, countryLabel } from "@/lib/region";
import type { OnboardWizardState } from "@/lib/use-onboard-wizard";
import { rovingTabIndex } from "@/lib/use-roving-radiogroup";
import LanguageSuggestionBanner from "../LanguageSuggestionBanner";
import { type ImportMethod, METHOD_LAYOUT } from "./shared";

export default function Step1ChooseMethod({
  w,
}: {
  /** The whole `useOnboardWizard` return value. One prop rather than
   *  33: the wizard is a single state machine, so a step that took
   *  its bindings individually would have a signature nobody could read.
   *  See ./README.md. */
  w: OnboardWizardState;
}) {
  const {
    country,
    countryInferred,
    countryLoaded,
    deviceClass,
    handleRestoreFileChosen,
    languageSuggestion,
    method,
    methodAvailability,
    methodMeta,
    methodRadioKeyDown,
    onboardMethodImportAuditBundleOn,
    onboardMethodLiveTextOn,
    onboardMethodRestoreBackupOn,
    onboardStepAccessibilityToggleOn,
    onboardStepAppStoreRegionOn,
    onboardStepChooseMethodOn,
    restoreError,
    restoreFileRef,
    restoreStage,
    setImportInfo,
    setImportedApps,
    setLanguageSuggestion,
    setLiveTextModalOpen,
    setMethod,
    setStep,
    step,
    tStep1,
    tWiz,
    trackAccessibility,
    updateCountry,
    updateTrackAccessibility,
    userSelectedMethodRef,
  } = w;

  return (
    <>
      {step === 1 && onboardStepChooseMethodOn && (
        <>
          {/* Back link to the previous onboarding screen so users
                aren't stranded on step 1 with no way back to revisit
                their audience or goals picks. Mirrors the Back button
                on subsequent wizard steps; keeps the same `wizard-back-link`
                placement so the muscle-memory carries between screens. */}
          <Link
            aria-label={tStep1("back_aria")}
            className="wizard-back-link"
            href="/welcome"
          >
            <span aria-hidden="true">←</span> {tStep1("back_to_goals")}
          </Link>
          <h1 className="wizard-title">{tWiz("add_apps")}</h1>
          <p className="wizard-subtitle">{tStep1("subtitle")}</p>

          {(() => {
            // Tailored method picker: only the "primary" and "secondary"
            // cards ride above the fold; everything else drops into an
            // Advanced drawer so the page stays focused on whichever path
            // actually works on this device.
            const layout = METHOD_LAYOUT[deviceClass];
            // Wave I: filter the method list against the per-method
            // flags. Each entry stays only if its flag resolves on,
            // mirroring the rule-table semantics. A method that's gated
            // off vanishes from both the visible row and the Advanced
            // drawer; the selection effect above falls through to the next
            // available method if the current one disappears.
            const primaryMethods: ImportMethod[] = [
              layout.primary,
              ...layout.secondary,
            ].filter((m) => methodAvailability[m]);
            const advancedMethods = layout.advanced.filter(
              (m) => methodAvailability[m]
            );

            const renderMethodCard = (value: ImportMethod, extraClass = "") => {
              const selected = method === value;
              // The primary and advanced grids are separate radiogroups
              // sharing one `method` state — rove within whichever grid
              // this card belongs to.
              const grid = primaryMethods.includes(value)
                ? primaryMethods
                : advancedMethods;
              return (
                <button
                  aria-checked={selected}
                  className={`method-card ${selected ? "active" : ""} ${extraClass}`.trim()}
                  data-testid={`onboard-method-${value}`}
                  key={value}
                  onClick={() => {
                    userSelectedMethodRef.current = true;
                    setMethod(value);
                    // Swapping methods wipes input state so a stale developer
                    // hint from a prior CSV drop can't accidentally rank
                    // manual-entry results. Same goes for bundleId hints
                    // captured from a prior cfgutil import — without this
                    // wipe, switching from "configurator" to "manual" would
                    // attempt a bundle-ID lookup against names the user
                    // typed by hand, which is wrong.
                    // Wipe the imported-apps list so a switch from
                    // (say) Configurator to manual entry doesn't
                    // leave the prior import's rows lingering.
                    setImportedApps([]);
                    setImportInfo("");
                  }}
                  role="radio"
                  tabIndex={rovingTabIndex(
                    selected,
                    grid.indexOf(value),
                    grid.includes(method)
                  )}
                  type="button"
                >
                  <div className="method-card-top">
                    <span className="method-card-badge">
                      {methodMeta[value].eyebrow}
                    </span>
                    <span aria-hidden="true" className="method-card-radio">
                      {selected ? "✓" : ""}
                    </span>
                  </div>
                  <div className="method-card-title">
                    {methodMeta[value].title}
                  </div>
                  <p className="method-card-copy">{methodMeta[value].blurb}</p>
                  <div className="method-card-hint">
                    {methodMeta[value].hint}
                  </div>

                  {/* Device-specific inline action rows. Rendered inside
                        the card but outside the copy blocks so the CTA sits
                        below the hint. Clicks bubble up to the card unless
                        explicitly stopped. */}
                  {value === "manual" &&
                    onboardMethodLiveTextOn &&
                    (deviceClass === "phone" || deviceClass === "tablet") && (
                      <div className="method-card-action">
                        <button
                          className="link-button-inline"
                          onClick={(event) => {
                            event.stopPropagation();
                            setLiveTextModalOpen(true);
                          }}
                          type="button"
                        >
                          {tStep1("live_text_link")}
                        </button>
                      </div>
                    )}
                  {/* The help link that used to live here pointed at
                        /help/export-app-list, which is actually a guide for
                        the Python backup helper — not Apple Configurator —
                        so we've moved it to the "Upload a file" method
                        (see the `method === 'file'` branch below), where
                        it's contextually correct. The Configurator card
                        now stays purely descriptive; its own step-2 UI
                        carries any Configurator-specific guidance. */}
                </button>
              );
            };

            return (
              <>
                <div
                  aria-label={tStep1("method_grid_aria")}
                  className="method-grid method-grid-primary"
                  onKeyDown={methodRadioKeyDown}
                  role="radiogroup"
                >
                  {primaryMethods.map((value) =>
                    renderMethodCard(
                      value,
                      primaryMethods.length === 1 ? "method-card-wide" : ""
                    )
                  )}
                </div>

                {advancedMethods.length > 0 && (
                  <details className="method-advanced">
                    <summary className="method-advanced-summary">
                      {tStep1("advanced_summary")}
                    </summary>
                    <div
                      aria-label={tStep1("advanced_grid_aria")}
                      className="method-grid method-grid-advanced"
                      onKeyDown={methodRadioKeyDown}
                      role="radiogroup"
                    >
                      {advancedMethods.map((value) => renderMethodCard(value))}
                    </div>
                  </details>
                )}
              </>
            );
          })()}

          {/*
              Store region — asked up-front because AU-only banking/transport
              apps etc. would otherwise return nothing (or the wrong match)
              on the default US storefront. Hydrated from `app_country` and
              persisted back on change so future re-syncs stay consistent.
            */}
          {onboardStepAppStoreRegionOn && (
            <div className="wizard-country-row">
              <div className="wizard-country-copy">
                <div className="wizard-country-label">
                  {tStep1("country_label")}
                </div>
                <div className="wizard-country-sub">
                  {tStep1("country_sub")}
                </div>
              </div>
              <select
                aria-label={tStep1("country_aria")}
                className="settings-input settings-select wizard-country-select"
                disabled={!countryLoaded}
                onChange={(event) => void updateCountry(event.target.value)}
                value={country}
              >
                {COUNTRY_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {tStep1("country_option", {
                      label: option.label,
                      code: option.code.toUpperCase(),
                    })}
                  </option>
                ))}
              </select>
              {countryInferred && (
                <div className="wizard-country-language-suggestion">
                  <div
                    className="wizard-note wizard-note-info"
                    style={{ margin: 0 }}
                  >
                    {tStep1("country_inferred", {
                      label: countryLabel(country),
                    })}
                  </div>
                </div>
              )}
              {/* Region → language suggestion. Mirror of the Settings
                  banner: appears below the picker after a region change
                  whose expected language differs from the active UI
                  locale. Click "Switch" → POST /api/locale + reload;
                  Dismiss → just clears the suggestion (no persistence). */}
              {languageSuggestion && (
                <div className="wizard-country-language-suggestion">
                  <LanguageSuggestionBanner
                    onDismiss={() => setLanguageSuggestion(null)}
                    target={languageSuggestion}
                  />
                </div>
              )}
            </div>
          )}

          {/*
              Accessibility-label tracking. Apple publishes an "Accessibility"
              shelf on each app listing declaring features the developer
              claims to support (VoiceOver, Voice Control, Larger Text…). We
              always capture this alongside privacy labels, but the user can
              hide the chip/chart/filter if they don't care about the signal.
            */}
          {onboardStepAccessibilityToggleOn && (
            <div className="wizard-country-row wizard-a11y-row">
              <div className="wizard-country-copy">
                <div className="wizard-country-label">
                  <span aria-hidden="true" className="wizard-a11y-icon">
                    {/* SF-symbol-style accessibility person-in-a-circle */}
                    <svg
                      aria-hidden="true"
                      fill="none"
                      height="18"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.8"
                      viewBox="0 0 24 24"
                      width="18"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <circle cx="12" cy="7.2" fill="currentColor" r="1.4" />
                      <path d="M6.5 10.5h11" />
                      <path d="M12 10.5v4" />
                      <path d="M9 18l3-3.5L15 18" />
                    </svg>
                  </span>
                  {tStep1("a11y_label")}
                </div>
                <div className="wizard-country-sub">{tStep1("a11y_sub")}</div>
              </div>
              <label className="wizard-a11y-toggle">
                <input
                  aria-label={tStep1("a11y_aria")}
                  checked={trackAccessibility}
                  onChange={(event) =>
                    void updateTrackAccessibility(event.target.checked)
                  }
                  type="checkbox"
                />
                <span className="wizard-a11y-toggle-label">
                  {trackAccessibility ? tStep1("a11y_on") : tStep1("a11y_off")}
                </span>
              </label>
            </div>
          )}

          <div className="wizard-footer-actions">
            <button
              className="btn btn-primary btn-lg"
              data-testid="onboard-step1-continue"
              onClick={() => setStep(2)}
              style={{ flex: 1 }}
              type="button"
            >
              {tStep1("continue_with", {
                method: methodMeta[method].title.toLowerCase(),
              })}
            </button>
          </div>

          {/*
              Subtle "have a backup?" escape hatch. Users who are re-installing
              the app or migrating from another machine shouldn't have to walk
              through the whole import flow just to restore a JSON they already
              exported. Kept deliberately quiet so it doesn't compete with the
              primary CTA above.
            */}
          {(onboardMethodRestoreBackupOn ||
            onboardMethodImportAuditBundleOn) && (
            <div className="onboard-restore-footer">
              <p className="onboard-restore-footer-copy">
                {tStep1("restore_lead")}
              </p>
              {onboardMethodRestoreBackupOn && (
                <button
                  className="onboard-restore-footer-link"
                  disabled={
                    restoreStage === "previewing" || restoreStage === "applying"
                  }
                  onClick={() => restoreFileRef.current?.click()}
                  type="button"
                >
                  {restoreStage === "previewing"
                    ? tStep1("restore_busy")
                    : tStep1("restore_link")}
                </button>
              )}
              <input
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) {
                    handleRestoreFileChosen(file);
                  }
                }}
                ref={restoreFileRef}
                style={{ display: "none" }}
                type="file"
              />
              {restoreError && restoreStage === "idle" && (
                <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>
                  {restoreError}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

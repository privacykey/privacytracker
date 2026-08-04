"use client";

import Link from "next/link";
import {
  AI_PROVIDER_OPTIONS,
  providerRequiresApiKey,
  providerSupportsApiKey,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
} from "../../lib/ai-config";
import { parseManualAppText } from "../../lib/app-import";
import {
  APPLE_CONFIGURATOR_HTTPS_URL,
  APPLE_CONFIGURATOR_MACAPPSTORE_URL,
  findChildSafetyPropertyNames,
} from "../../lib/desktop";
import type { DeviceClass } from "../../lib/device";
import { COUNTRY_OPTIONS, countryLabel } from "../../lib/region";
import {
  type TriageChoice,
  useOnboardWizard,
} from "../../lib/use-onboard-wizard";
import { rovingTabIndex } from "../../lib/use-roving-radiogroup";
import AlreadyTrackedAccordion from "./AlreadyTrackedAccordion";
import DeviceSyncDiffOverlay from "./DeviceSyncDiffOverlay";
import ImportedAppsTable from "./ImportedAppsTable";
import LanguageSuggestionBanner from "./LanguageSuggestionBanner";
import LiveTextModal from "./LiveTextModal";
import CancelSummariesModal from "./onboard/CancelSummariesModal";
import PolicyRunPanel from "./onboard/PolicyRunPanel";
import RateLimitPauseModal from "./onboard/RateLimitPauseModal";
import RestoreBackupModal from "./onboard/RestoreBackupModal";
import SearchResultBlock from "./onboard/SearchResultBlock";
import {
  type ImportMethod,
  METHOD_LAYOUT,
  makeImportedAppEntry,
} from "./onboard/shared";
import type { AppCandidate, SearchResult } from "./onboard/types";
import UnavailableRowEditor from "./onboard/UnavailableRowEditor";
import RateLimitBanner from "./RateLimitBanner";
import SearchProgressCard from "./SearchProgressCard";
import Step2DiffConfirmModal from "./Step2DiffConfirmModal";
import Step2DiffPanel from "./Step2DiffPanel";

const ONBOARD_AI_OPTIONS = AI_PROVIDER_OPTIONS;

interface OnboardWizardProps {
  /**
   * Server-resolved flags whose first paint must match the runtime-aware
   * resolver. Client-side `useFlag` falls back to hard defaults before the
   * resolver cache is hydrated, which is not enough for Tauri-only gates.
   */
  flags?: {
    methodConfigurator: boolean;
  };
  /**
   * Server-sniffed device class from the UA header. Drives the initial
   * method-card layout so the first paint shows the right primary option
   * for this device. Refined client-side by `refineDeviceOnClient` once
   * viewport width / touch points become observable.
   */
  initialDevice?: DeviceClass;
}

export default function OnboardWizard({
  initialDevice = "desktop",
  flags,
}: OnboardWizardProps) {
  const {
    stepLabels,
    router,
    importQueue,
    tWiz,
    tSearchBlock,
    tStepIndicator,
    tOnboard,
    tAiStep,
    tAiOptions,
    tStep1,
    tStep2,
    tStep3,
    tStep4,
    tCfg,
    tStatus,
    methodMeta,
    onboardMethodLiveTextOn,
    onboardHideTrackedToggleOn,
    onboardStepAiSummariesOn,
    onboardPostDashboardSkipOn,
    onboardPostBackgroundWorkerOn,
    onboardImportRateLimitHandoffOn,
    onboardMethodRestoreBackupOn,
    onboardMethodImportAuditBundleOn,
    onboardStepAppStoreRegionOn,
    onboardStepAccessibilityToggleOn,
    onboardStepChooseMethodOn,
    onboardStepConfirmMatchesOn,
    onboardStepImportProgressOn,
    methodAvailability,
    textFileRef,
    imageFileRef,
    step,
    setStep,
    deviceClass,
    method,
    setMethod,
    userSelectedMethodRef,
    wizardRadioKeyDown,
    methodRadioKeyDown,
    liveTextModalOpen,
    setLiveTextModalOpen,
    country,
    countryLoaded,
    countryInferred,
    languageSuggestion,
    setLanguageSuggestion,
    trackAccessibility,
    ratePending,
    rateTick,
    settingsLoaded,
    storedAi,
    aiProvider,
    aiApiKey,
    setAiApiKey,
    aiBaseUrl,
    setAiBaseUrl,
    aiModel,
    setAiModel,
    savingAi,
    aiError,
    uploadedFileName,
    setUploadedFileName,
    inDesktop,
    cfgutilCheck,
    cfgutilChecking,
    cfgutilExporting,
    cfgutilError,
    setCfgutilError,
    cfgutilDiagnostic,
    cfgutilDevices,
    cfgutilDevicesLoading,
    selectedCfgutilEcid,
    setSelectedCfgutilEcid,
    imageFiles,
    setImageFiles,
    isDraggingText,
    setIsDraggingText,
    isDraggingImages,
    setIsDraggingImages,
    ocring,
    ocrMessage,
    setOcrMessage,
    ocrError,
    setOcrError,
    ocrErrorDetail,
    setOcrErrorDetail,
    isIosSafari,
    importedApps,
    setImportedApps,
    pendingAppText,
    setPendingAppText,
    developerHints,
    webClipEntries,
    importInfo,
    setImportInfo,
    searchResults,
    setSearchResults,
    selected,
    setSelected,
    webClipSaveState,
    setWebClipSaveState,
    webClipSavedCount,
    setWebClipSavedCount,
    webClipSaveError,
    setWebClipSaveError,
    triageChoices,
    setTriageChoices,
    unmatchedSaveState,
    setUnmatchedSaveState,
    unmatchedSavedCount,
    setUnmatchedSavedCount,
    unmatchedSaveError,
    setUnmatchedSaveError,
    setManuallyChosenQueries,
    skippedQueries,
    setSkippedQueries,
    rematchingRegion,
    searching,
    searchError,
    searchBlocked,
    blockSearchError,
    blockSearching,
    searchProgress,
    hideTrackedBlocks,
    setHideTrackedBlocks,
    trackedByAppleId,
    trackedByBundleId,
    scrapeList,
    done,
    importDetailsOpen,
    setImportDetailsOpen,
    scrapeRateLimit,
    rateLimitPauseModal,
    setRateLimitPauseModal,
    scrapeCancelRef,
    scrapeRateTick,
    editingBlock,
    setEditingBlock,
    policyProgress,
    policyRunDone,
    activePhase,
    phaseAvgMs,
    cancelModalOpen,
    setCancelModalOpen,
    scrapeActiveRowRef,
    scrapeListEndRef,
    etaTick,
    restoreFileRef,
    restoreStage,
    restorePreview,
    pendingRestoreFilename,
    restoreError,
    setRestoreError,
    restoreConfirmText,
    setRestoreConfirmText,
    resetRestoreFlow,
    restoreModalCardRef,
    cancelModalCardRef,
    rateLimitModalCardRef,
    handleRestoreFileChosen,
    handleRestoreConfirm,
    aiTestStatus,
    aiTestMessage,
    aiTestLatency,
    testAiConnection,
    updateCountry,
    updateTrackAccessibility,
    parseTextFile,
    describeCfgutilDevice,
    describeCfgutilDeviceMeta,
    refreshCfgutilDevices,
    runCfgutilCheck,
    runCfgutilExportClick,
    isPreviewMode,
    resyncDeviceId,
    resyncOverlayOpen,
    setResyncOverlayOpen,
    resyncOverlayApps,
    priorImportHistory,
    step2DiffConfirmOpen,
    setStep2DiffConfirmOpen,
    step2DiffCommitting,
    step2DiffPicked,
    setStep2DiffPicked,
    isAutoResyncCfgutil,
    handleTextDrop,
    handleImageDrop,
    handleImageSelection,
    commitStep2Diff,
    handleSearch,
    cancelSearch,
    handleBlockResearch,
    handleBlockSkip,
    handleCancelQueuedMatches,
    handleRegionRematch,
    handleConfirm,
    aiSettingsComplete,
    runPolicyRegeneration,
    requestStop,
    selectedCount,
    providerOptions,
    selectedModelPreset,
    selectedCfgutilDevice,
    onProviderChange,
  } = useOnboardWizard({ initialDevice, flags });
  return (
    <div className="wizard-outer">
      <div className="wizard-card wizard-card-wide">
        {/*
          Dev-only preview banner — sits above the stepper when the
          wizard was opened via `/onboard?preview=fresh` from the
          DevMenu. Click-through is fine on every step except the
          final submit (Step 4's scrape batch), which short-circuits
          server-side calls when this mode is active. Distinct purple
          border so it's never mistaken for a real onboarding banner.
        */}
        {isPreviewMode && (
          <div className="wizard-preview-banner" role="status">
            <span aria-hidden="true" className="wizard-preview-banner-icon">
              👁
            </span>
            <div>
              <strong>{tOnboard("preview_banner.lead")}</strong>
              <span className="wizard-preview-banner-sub">
                {tOnboard("preview_banner.body")}
              </span>
            </div>
          </div>
        )}
        {/* Step indicator is informational only (not a navigation control),
            so expose it as an ordered list with aria-current="step" on the
            active one. Screen readers announce position in the sequence. */}
        <ol
          aria-label={tStepIndicator("aria", {
            step,
            total: stepLabels.length,
          })}
          className="wizard-steps"
        >
          {stepLabels.map(([value, label], index) => {
            const isActive = step === value;
            const isDone = step > value;
            const statusWord = isDone
              ? tStepIndicator("completed")
              : isActive
                ? tStepIndicator("current")
                : tStepIndicator("upcoming");
            return (
              <li
                aria-current={isActive ? "step" : undefined}
                className="wizard-step-node"
                key={value}
                style={{ flex: index < stepLabels.length - 1 ? 1 : "none" }}
              >
                <span className="sr-only">{statusWord}: </span>
                <div
                  aria-hidden="true"
                  className={`wizard-step-circle ${isDone ? "done" : isActive ? "active" : "inactive"}`}
                >
                  {isDone ? "✓" : value}
                </div>
                <span
                  className={`wizard-step-label ${isActive ? "active" : isDone ? "done" : ""}`}
                >
                  {label}
                </span>
                {index < stepLabels.length - 1 && (
                  <div
                    aria-hidden="true"
                    className={`wizard-step-line ${isDone ? "done" : ""}`}
                  />
                )}
              </li>
            );
          })}
        </ol>

        {step === 5 &&
          !onboardStepAiSummariesOn &&
          (() => {
            // Wave I: when `flag.onboarding.step.ai_summaries` resolves
            // off, the wizard skips the optional summary step entirely
            // and routes straight to the dashboard. The fire-once router
            // push happens inside an effect-style IIFE because `step ===
            // 5` only renders briefly before the navigation completes.
            if (typeof window !== "undefined") {
              queueMicrotask(() => router.push("/dashboard"));
            }
            return (
              <div
                className="wizard-note wizard-note-info"
                style={{ marginTop: 16 }}
              >
                {tOnboard("skipping_ai")}
              </div>
            );
          })()}

        {step === 5 &&
          onboardStepAiSummariesOn &&
          policyProgress.length === 0 && (
            <>
              <div className="wizard-subtle-eyebrow">{tAiStep("eyebrow")}</div>
              <h1 className="wizard-title">{tWiz("ai_summarise")}</h1>
              {/*
              Two-paragraph lede explaining *why* the policy step exists at
              all. Privacy labels = what the developer tells Apple; privacy
              policies = the closer-to-complete picture (subprocessors,
              retention, sale-of-data, etc.). We surface the watch-for-
              changes promise here so users understand the value even if
              they say "no thanks" to the AI summarisation offer below.
            */}
              <p className="wizard-subtitle">{tAiStep("lede")}</p>
              <p className="wizard-subtitle">{tAiStep("lede_paragraph_2")}</p>

              <h2 className="wizard-section-heading" style={{ marginTop: 24 }}>
                {tAiStep("ai_offer_heading")}
              </h2>
              <p className="wizard-subtitle">{tAiStep("subtitle")}</p>

              <div
                aria-label={tAiStep("provider_aria")}
                className="method-grid"
                onKeyDown={wizardRadioKeyDown}
                role="radiogroup"
              >
                {ONBOARD_AI_OPTIONS.map((option) => {
                  const selected = aiProvider === option.value;
                  return (
                    <button
                      aria-checked={selected}
                      className={`method-card ${selected ? "active" : ""}`}
                      key={option.value}
                      onClick={() => onProviderChange(option.value)}
                      role="radio"
                      tabIndex={selected ? 0 : -1}
                      type="button"
                    >
                      <div className="method-card-top">
                        <span className="method-card-badge">
                          {tAiStep("provider_badge")}
                        </span>
                        <span aria-hidden="true" className="method-card-radio">
                          {selected ? "✓" : ""}
                        </span>
                      </div>
                      <div className="method-card-title">
                        {option.labelKey
                          ? tAiOptions(option.labelKey)
                          : option.label}
                      </div>
                      <p className="method-card-copy">
                        {tAiOptions(option.descKey)}
                      </p>
                      <div className="method-card-hint">
                        {option.value === "openai"
                          ? tAiStep("hint_openai")
                          : option.value === "anthropic"
                            ? tAiStep("hint_anthropic")
                            : tAiStep("hint_custom")}
                      </div>
                    </button>
                  );
                })}
              </div>

              {aiProvider !== "disabled" && (
                <>
                  <div className="settings-field-grid">
                    <label className="settings-field">
                      <span className="settings-field-label">
                        {tAiStep("base_url_label")}
                      </span>
                      <input
                        className="settings-input"
                        onChange={(event) => setAiBaseUrl(event.target.value)}
                        placeholder={resolveDefaultBaseUrl(aiProvider)}
                        spellCheck={false}
                        type="text"
                        value={aiBaseUrl}
                      />
                    </label>

                    <label className="settings-field">
                      <span className="settings-field-label">
                        {tAiStep("popular_models_label")}
                      </span>
                      <select
                        className="settings-input settings-select"
                        onChange={(event) => {
                          if (event.target.value !== "__custom__") {
                            setAiModel(event.target.value);
                          }
                        }}
                        value={selectedModelPreset}
                      >
                        {providerOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                        <option value="__custom__">
                          {tAiStep("custom_model_option")}
                        </option>
                      </select>
                    </label>
                  </div>

                  <div
                    className="settings-field-grid"
                    style={{ marginTop: 16 }}
                  >
                    <label className="settings-field">
                      <span className="settings-field-label">
                        {tAiStep("model_id_label")}
                      </span>
                      <input
                        className="settings-input"
                        onChange={(event) => setAiModel(event.target.value)}
                        placeholder={resolveDefaultModel(aiProvider)}
                        spellCheck={false}
                        type="text"
                        value={aiModel}
                      />
                    </label>

                    {providerSupportsApiKey(aiProvider) && (
                      <label className="settings-field">
                        <span className="settings-field-label">
                          {tAiStep("api_key_label")}
                        </span>
                        <input
                          autoComplete="off"
                          className="settings-input"
                          onChange={(event) => setAiApiKey(event.target.value)}
                          // i18n-exempt — literal API-key prefix formats ("sk-ant-...", "sk-..."), locale-neutral
                          placeholder={
                            aiProvider === "anthropic"
                              ? "sk-ant-..."
                              : aiProvider === "openai"
                                ? "sk-..."
                                : tAiStep("api_key_placeholder_custom")
                          }
                          spellCheck={false}
                          type="password"
                          value={aiApiKey}
                        />
                        <span className="settings-field-help">
                          {providerRequiresApiKey(aiProvider)
                            ? tAiStep("api_key_help_required")
                            : tAiStep("api_key_help_optional")}
                        </span>
                      </label>
                    )}
                  </div>

                  <div className="ai-test-row" style={{ marginTop: 16 }}>
                    <button
                      className="btn btn-secondary ai-test-button"
                      disabled={
                        aiTestStatus === "testing" || !aiSettingsComplete
                      }
                      onClick={() => void testAiConnection()}
                      type="button"
                    >
                      <span
                        className={`ai-test-dot ai-test-dot-${aiTestStatus}`}
                      >
                        {aiTestStatus === "testing" ? (
                          <span className="spinner-sm" />
                        ) : null}
                      </span>
                      {aiTestStatus === "testing"
                        ? tAiStep("test_busy")
                        : aiTestStatus === "ok" || aiTestStatus === "fail"
                          ? tAiStep("test_retry")
                          : tAiStep("test_idle")}
                    </button>
                    {(aiTestMessage || aiTestLatency !== null) && (
                      <div
                        className={`ai-test-message ai-test-message-${aiTestStatus}`}
                      >
                        {aiTestStatus === "ok"
                          ? "✓ "
                          : aiTestStatus === "fail"
                            ? "⚠ "
                            : ""}
                        {aiTestMessage ||
                          (aiTestStatus === "ok"
                            ? tAiStep("test_reachable")
                            : "")}
                        {aiTestLatency !== null && (
                          <span className="ai-test-latency">
                            {tAiStep("test_latency", { ms: aiTestLatency })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}

              {storedAi && !aiError && settingsLoaded && (
                <div
                  className="wizard-note wizard-note-green"
                  style={{ marginTop: 16 }}
                >
                  {tAiStep("stored_loaded")}
                </div>
              )}

              {aiError && (
                <div
                  className="wizard-note wizard-note-red"
                  style={{ marginTop: 16 }}
                >
                  {aiError}
                </div>
              )}

              <div className="wizard-footer-actions" style={{ marginTop: 28 }}>
                {onboardPostDashboardSkipOn && (
                  <button
                    className="btn btn-secondary btn-lg"
                    disabled={savingAi}
                    onClick={() => router.push("/dashboard")}
                    type="button"
                  >
                    {tAiStep("skip_dashboard")}
                  </button>
                )}
                <button
                  className="btn btn-primary btn-lg"
                  disabled={
                    savingAi ||
                    !settingsLoaded ||
                    aiProvider === "disabled" ||
                    !aiSettingsComplete
                  }
                  onClick={() => void runPolicyRegeneration()}
                  style={{ flex: 1 }}
                  type="button"
                >
                  {savingAi ? (
                    <>
                      <span className="spinner" /> {tAiStep("saving_ai")}
                    </>
                  ) : (
                    tAiStep("save_and_generate", {
                      count: scrapeList.filter(
                        (item) => item.status === "success"
                      ).length,
                    })
                  )}
                </button>
              </div>
            </>
          )}

        {step === 5 &&
          onboardStepAiSummariesOn &&
          policyProgress.length > 0 && (
            <PolicyRunPanel
              activePhase={activePhase}
              etaTick={etaTick}
              onCancelRequest={() => setCancelModalOpen(true)}
              onViewDashboard={() => router.push("/dashboard")}
              phaseAvgMs={phaseAvgMs}
              progress={policyProgress}
              runDone={policyRunDone}
            />
          )}

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

              const renderMethodCard = (
                value: ImportMethod,
                extraClass = ""
              ) => {
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
                    <p className="method-card-copy">
                      {methodMeta[value].blurb}
                    </p>
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
                        {advancedMethods.map((value) =>
                          renderMethodCard(value)
                        )}
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
                    {trackAccessibility
                      ? tStep1("a11y_on")
                      : tStep1("a11y_off")}
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
                      restoreStage === "previewing" ||
                      restoreStage === "applying"
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
                  <p
                    style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}
                  >
                    {restoreError}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="wizard-title">{methodMeta[method].title}</h1>
            <p className="wizard-subtitle">
              {method === "screenshots"
                ? tStep2("subtitle_screenshots")
                : method === "file"
                  ? tStep2("subtitle_file")
                  : method === "configurator"
                    ? tStep2("subtitle_configurator")
                    : tStep2("subtitle_manual")}
            </p>

            {method === "screenshots" && (
              <>
                {isIosSafari && (
                  <div className="wizard-note wizard-note-amber" role="note">
                    <strong>{tStep2("ios_safari_heads_up_lead")}</strong>
                    {tStep2("ios_safari_heads_up_body_pre")}
                    <button
                      className="link-button-inline"
                      onClick={() => {
                        userSelectedMethodRef.current = true;
                        setMethod("manual");
                        setImageFiles([]);
                        setOcrError("");
                        setOcrErrorDetail("");
                        setOcrMessage("");
                      }}
                      type="button"
                    >
                      {tStep2("ios_safari_link_manual")}
                    </button>
                    {tStep2("ios_safari_between")}
                    <button
                      className="link-button-inline"
                      onClick={() => {
                        userSelectedMethodRef.current = true;
                        setMethod("file");
                        setImageFiles([]);
                        setOcrError("");
                        setOcrErrorDetail("");
                        setOcrMessage("");
                      }}
                      type="button"
                    >
                      {tStep2("ios_safari_link_file")}
                    </button>
                    {tStep2("ios_safari_end")}
                  </div>
                )}

                <div className="wizard-note wizard-note-info" role="note">
                  <strong>{tStep2("screenshot_tip_lead")}</strong>
                  {tStep2("screenshot_tip_body")}
                  <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                    <li>{tStep2("screenshot_tip_li1")}</li>
                    <li>{tStep2("screenshot_tip_li2")}</li>
                    <li>{tStep2("screenshot_tip_li3")}</li>
                  </ul>
                </div>

                <div
                  aria-label={tStep2("drop_screenshots_aria")}
                  className={`file-drop ${isDraggingImages ? "over" : ""}`}
                  onClick={() => imageFileRef.current?.click()}
                  onDragLeave={() => setIsDraggingImages(false)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsDraggingImages(true);
                  }}
                  onDrop={handleImageDrop}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      imageFileRef.current?.click();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div style={{ fontSize: 28 }}>🖼</div>
                  <div className="file-drop-text">
                    {tStep2("drop_screenshots")}
                  </div>
                  <div className="file-drop-subtext">
                    {tStep2("drop_screenshots_sub")}
                  </div>
                  <input
                    accept="image/*"
                    multiple
                    onChange={(event) =>
                      handleImageSelection(event.target.files)
                    }
                    ref={imageFileRef}
                    style={{ display: "none" }}
                    type="file"
                  />
                </div>

                {imageFiles.length > 0 && (
                  <div className="upload-summary">
                    <div className="upload-summary-title">
                      {tStep2("selected_count", { count: imageFiles.length })}
                    </div>
                    <div className="upload-chip-row">
                      {imageFiles.map((file) => (
                        <span
                          className="upload-chip"
                          key={`${file.name}-${file.lastModified}`}
                        >
                          {file.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {ocring && (
                  <div className="wizard-note wizard-note-blue">
                    <span className="spinner-sm" />
                    <span>{ocrMessage || tStep2("scanning")}</span>
                  </div>
                )}

                {!ocring && ocrMessage && (
                  <div className="wizard-note wizard-note-green">
                    {ocrMessage}
                  </div>
                )}

                {ocrError && (
                  <div className="wizard-note wizard-note-red">
                    <div>{ocrError}</div>
                    {ocrErrorDetail && (
                      <details style={{ marginTop: 8 }}>
                        <summary
                          style={{
                            cursor: "pointer",
                            fontSize: 12,
                            opacity: 0.85,
                          }}
                        >
                          {tStep2("show_technical")}
                        </summary>
                        <pre
                          style={{
                            margin: "6px 0 0",
                            padding: 8,
                            background: "rgba(0,0,0,0.18)",
                            borderRadius: 6,
                            fontSize: 11,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {ocrErrorDetail}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </>
            )}

            {method === "file" && (
              <>
                <div className="wizard-inline-actions">
                  <Link
                    className="wizard-inline-link"
                    href="/help/export-app-list"
                    target="_blank"
                  >
                    {tStep2("file_export_link")}
                  </Link>
                </div>

                <div
                  aria-label={tStep2("file_drop_aria")}
                  className={`file-drop ${isDraggingText ? "over" : ""}`}
                  onClick={() => textFileRef.current?.click()}
                  onDragLeave={() => setIsDraggingText(false)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsDraggingText(true);
                  }}
                  onDrop={handleTextDrop}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      textFileRef.current?.click();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div style={{ fontSize: 28 }}>📂</div>
                  <div className="file-drop-text">
                    {tStep2.rich("file_drop_text", {
                      b: (chunks) => <strong>{chunks}</strong>,
                    })}
                  </div>
                  <div className="file-drop-subtext">
                    {tStep2("file_drop_sub")}
                  </div>
                  <input
                    accept=".txt,.csv,text/plain,text/csv"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        parseTextFile(file);
                      }
                    }}
                    ref={textFileRef}
                    style={{ display: "none" }}
                    type="file"
                  />
                </div>

                {uploadedFileName && (
                  <div className="upload-summary">
                    <div className="upload-summary-title">
                      {tStep2("imported_from", { filename: uploadedFileName })}
                    </div>
                    <div className="upload-summary-copy">
                      {tStep2("imported_from_review")}
                    </div>
                  </div>
                )}
              </>
            )}

            {method === "configurator" &&
              (() => {
                // Once the cfgutil export has populated names AND set the
                // upload-summary title, the user is "done" with the
                // collection step — collapsing the ladder + how-to + CSV
                // dropzone gets them straight to the names list and the
                // Continue affordance, which is what they actually need
                // to act on next. Showing all three side-by-side after
                // success buries the action and makes the wizard look
                // unfinished. We keep the upload-summary visible (it's
                // the "you imported X apps from <device>" confirmation)
                // and add a fresh "Re-run import" link inside it for
                // users who want to redo the export without a tab back.
                const cfgutilImportSuccessful =
                  uploadedFileName !== "" && importedApps.length > 0;
                // Pick an emoji for the device class so the success
                // summary visually matches the import-history row
                // SettingsView renders. Uses the live `selectedCfgutilDevice`
                // (richer than the source-label parse SettingsView has
                // to do) when available.
                const deviceClassRaw =
                  selectedCfgutilDevice?.deviceClass?.toLowerCase() ?? "";
                const deviceIcon = deviceClassRaw.includes("iphone")
                  ? "📱"
                  : deviceClassRaw.includes("ipad")
                    ? "📱"
                    : deviceClassRaw.includes("ipod")
                      ? "🎵"
                      : deviceClassRaw.includes("appletv") ||
                          deviceClassRaw.includes("apple tv")
                        ? "📺"
                        : deviceClassRaw.includes("applewatch") ||
                            deviceClassRaw.includes("apple watch")
                          ? "⌚️"
                          : // Fall back to the generic Configurator glyph when
                            // cfgutil's deviceClass field came back empty (older
                            // builds, or the device went away after export).
                            "📱";
                return (
                  <>
                    {/*
                  Desktop auto-import panel. Only rendered inside the Tauri
                  shell (isDesktop() returns true), and only on a platform
                  where cfgutil can actually run — check_cfgutil reports
                  "macos" / "windows" / "linux" so we can tell the user
                  up-front that the auto path is macOS-only without
                  making them click the button first.

                  The panel walks the user through three discrete steps:
                    1. Install Apple Configurator from the App Store.
                    2. Check that cfgutil is reachable.
                    3. Export installed apps from any connected device.
                  Each step only unlocks once the previous one is clearly
                  satisfied, so the success path feels like a ladder rather
                  than a forest of buttons.

                  Hidden once the import has succeeded — the names list
                  below + the upload-summary card carry the rest of the
                  flow and the user shouldn't have to scroll past three
                  collapsed-but-still-visible affordances they're done
                  with.
                */}
                    {inDesktop && !cfgutilImportSuccessful && (
                      <section
                        aria-label={tCfg("panel_aria")}
                        className="cfgutil-panel"
                      >
                        <header className="cfgutil-panel-header">
                          <div>
                            <div className="cfgutil-panel-eyebrow">
                              {tCfg("eyebrow")}
                            </div>
                            <h2 className="cfgutil-panel-title">
                              {tCfg("title")}
                            </h2>
                            <p className="cfgutil-panel-copy">{tCfg("copy")}</p>
                          </div>
                        </header>

                        <ol className="cfgutil-steps">
                          {/* Step 1 — install Apple Configurator. We render this
                          whether or not cfgutilCheck has run yet; once it has
                          run and app_installed is true, the step is marked
                          "Installed" and the button flips to a quiet "Open
                          in App Store" link instead of the bright primary
                          CTA. */}
                          <li
                            className={
                              "cfgutil-step " +
                              (cfgutilCheck?.appInstalled
                                ? "cfgutil-step-done"
                                : "cfgutil-step-pending")
                            }
                          >
                            <div className="cfgutil-step-number">1</div>
                            <div className="cfgutil-step-body">
                              <div className="cfgutil-step-title">
                                {tCfg("step1_title")}
                                {cfgutilCheck?.appInstalled && (
                                  <span className="cfgutil-step-badge">
                                    {tCfg("step1_installed_badge")}
                                  </span>
                                )}
                              </div>
                              <p className="cfgutil-step-copy">
                                {tCfg("step1_copy_pre")}
                                <code>cfgutil</code>
                                {tCfg("step1_copy_post")}
                              </p>
                              <div className="cfgutil-step-actions">
                                <a
                                  className={
                                    cfgutilCheck?.appInstalled
                                      ? "link-button-inline"
                                      : "btn btn-primary btn-sm"
                                  }
                                  href={APPLE_CONFIGURATOR_MACAPPSTORE_URL}
                                  rel="noreferrer"
                                  // The macappstore:// protocol opens the App Store
                                  // app directly; target=_self keeps the webview from
                                  // spawning a new tab when the scheme handler fires.
                                  target="_self"
                                >
                                  {cfgutilCheck?.appInstalled
                                    ? tCfg("step1_open_installed")
                                    : tCfg("step1_open_new")}
                                </a>
                                <a
                                  className="link-button-inline"
                                  href={APPLE_CONFIGURATOR_HTTPS_URL}
                                  rel="noopener noreferrer"
                                  target="_blank"
                                >
                                  {tCfg("step1_view_listing")}
                                </a>
                              </div>
                            </div>
                          </li>

                          {/* Step 2 — detect cfgutil. Three visual states:
                          (a) no check yet → show "Check now" button.
                          (b) available → green badge with version string.
                          (c) unavailable → red-ish note with the reason and,
                              if the .app is installed but the symlink
                              isn't, specific "Install Automation Tools"
                              guidance. */}
                          <li
                            className={
                              "cfgutil-step " +
                              (cfgutilCheck?.available
                                ? "cfgutil-step-done"
                                : cfgutilCheck
                                  ? "cfgutil-step-error"
                                  : "cfgutil-step-pending")
                            }
                          >
                            <div className="cfgutil-step-number">2</div>
                            <div className="cfgutil-step-body">
                              <div className="cfgutil-step-title">
                                {tCfg("step2_title")}
                                {cfgutilCheck?.available && (
                                  <span className="cfgutil-step-badge">
                                    {cfgutilCheck.version
                                      ? tCfg("step2_badge_version", {
                                          version: cfgutilCheck.version,
                                        })
                                      : tCfg("step2_badge_ready")}
                                  </span>
                                )}
                              </div>
                              {!cfgutilCheck && (
                                <p className="cfgutil-step-copy">
                                  {tCfg("step2_copy_initial_pre")}
                                  <code>cfgutil --format JSON list</code>
                                  {tCfg("step2_copy_initial_post")}
                                </p>
                              )}
                              {cfgutilCheck && !cfgutilCheck.available && (
                                <>
                                  <p className="cfgutil-step-copy">
                                    {cfgutilCheck.appInstalled
                                      ? tCfg("step2_copy_app_installed")
                                      : (cfgutilCheck.error ??
                                        tCfg("step2_copy_not_found"))}
                                  </p>
                                  {cfgutilCheck.platform !== "macos" && (
                                    <p className="cfgutil-step-copy">
                                      {tCfg("step2_copy_not_macos")}
                                    </p>
                                  )}
                                </>
                              )}
                              <div className="cfgutil-step-actions">
                                <button
                                  className="btn btn-secondary btn-sm"
                                  disabled={cfgutilChecking}
                                  onClick={() => void runCfgutilCheck()}
                                  type="button"
                                >
                                  {cfgutilChecking ? (
                                    <>
                                      <span className="spinner" />{" "}
                                      {tCfg("step2_checking")}
                                    </>
                                  ) : cfgutilCheck ? (
                                    tCfg("step2_recheck")
                                  ) : (
                                    tCfg("step2_check")
                                  )}
                                </button>
                                {cfgutilCheck?.path && (
                                  <span className="cfgutil-step-sub">
                                    {tCfg("step2_path_pre")}
                                    <code>{cfgutilCheck.path}</code>
                                  </span>
                                )}
                              </div>
                              {/* Diagnostics-only probe: what properties this
                              cfgutil build can read off a device. The guardian
                              age-rating feature watches for the day Apple
                              exposes a child age-range / restrictions property
                              over USB (today DeclaredAgeRange is in-app only,
                              so the hit list is expected to be empty). */}
                              {cfgutilCheck?.supportedPropertyNames &&
                                (() => {
                                  const hits = findChildSafetyPropertyNames(
                                    cfgutilCheck.supportedPropertyNames
                                  );
                                  return (
                                    <p className="cfgutil-step-sub">
                                      {tCfg("step2_properties_probe", {
                                        count:
                                          cfgutilCheck.supportedPropertyNames
                                            .length,
                                      })}
                                      {hits.length > 0 && (
                                        <>
                                          {" "}
                                          {tCfg("step2_properties_child_hit")}{" "}
                                          <code>{hits.join(", ")}</code>
                                        </>
                                      )}
                                    </p>
                                  );
                                })()}
                              {/* Larger, more visible "we're working on it"
                              panel — the cfgutil probe shells out + checks
                              the Automation Tools install, which can take
                              5–30s on a cold call. The button's 16px
                              spinner alone isn't enough signal. Renders
                              only while cfgutilChecking is true; aria-live
                              announces the title to screen readers. */}
                              {cfgutilChecking && (
                                <div
                                  aria-live="polite"
                                  className="cfgutil-checking-status"
                                  role="status"
                                >
                                  <span aria-hidden className="spinner-lg" />
                                  <div className="cfgutil-checking-status-body">
                                    <div className="cfgutil-checking-status-title">
                                      {tCfg("checking_status_title")}
                                    </div>
                                    <div className="cfgutil-checking-status-copy">
                                      {tCfg("checking_status_body")}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          </li>

                          {/* Step 3 — run the export. Gated behind a successful
                          step-2 check. When disabled, the copy tells the
                          user what's missing rather than showing a dead
                          button. */}
                          <li
                            className={
                              "cfgutil-step " +
                              (cfgutilCheck?.available
                                ? "cfgutil-step-ready"
                                : "cfgutil-step-locked")
                            }
                          >
                            <div className="cfgutil-step-number">3</div>
                            <div className="cfgutil-step-body">
                              <div className="cfgutil-step-title">
                                {tCfg("step3_title")}
                              </div>
                              <p className="cfgutil-step-copy">
                                {tCfg("step3_copy_pre")}
                                <strong>{tCfg("step3_copy_trust")}</strong>
                                {tCfg("step3_copy_mid")}
                                <code>
                                  cfgutil --format JSON get installedApps
                                </code>
                                {tCfg("step3_copy_post")}
                              </p>
                              {cfgutilCheck?.available && (
                                <div className="cfgutil-device-picker">
                                  <div className="cfgutil-device-picker-header">
                                    <div>
                                      <div className="cfgutil-device-picker-title">
                                        {tCfg("device_picker_title")}
                                      </div>
                                      <div className="cfgutil-device-picker-sub">
                                        {cfgutilDevices.length > 1
                                          ? tCfg("device_picker_multi")
                                          : selectedCfgutilDevice
                                            ? tCfg("device_picker_selected", {
                                                device: describeCfgutilDevice(
                                                  selectedCfgutilDevice
                                                ),
                                              })
                                            : tCfg("device_picker_empty")}
                                      </div>
                                      {/* Prior-import badge — only renders when
                                       *  the connected device matches a row in
                                       *  the `devices` table AND we've seen at
                                       *  least one completed import for it.
                                       *  Signals "you've been here before,
                                       *  we'll diff against your last sync."
                                       *  The wizard auto-enters re-sync mode
                                       *  whenever this badge is visible (see
                                       *  the ECID lookup effect above). */}
                                      {priorImportHistory &&
                                        priorImportHistory.count > 0 && (
                                          <div
                                            className="cfgutil-device-picker-prior-badge"
                                            role="status"
                                          >
                                            <span
                                              aria-hidden="true"
                                              className="cfgutil-device-picker-prior-badge-icon"
                                            >
                                              ↻
                                            </span>
                                            <span>
                                              {tCfg("prior_imports_badge", {
                                                count: priorImportHistory.count,
                                                deviceName:
                                                  priorImportHistory.deviceName ||
                                                  tCfg("device_fallback"),
                                              })}
                                            </span>
                                          </div>
                                        )}
                                    </div>
                                    <button
                                      className="pill-button"
                                      disabled={cfgutilDevicesLoading}
                                      onClick={() =>
                                        void refreshCfgutilDevices()
                                      }
                                      type="button"
                                    >
                                      {cfgutilDevicesLoading ? (
                                        <>
                                          <span className="spinner-sm" />{" "}
                                          {tCfg("device_refreshing")}
                                        </>
                                      ) : (
                                        tCfg("device_refresh")
                                      )}
                                    </button>
                                  </div>

                                  {/* While refreshing, show skeleton rows in
                                  the same slot as the real device list so
                                  the panel itself reflects the loading
                                  state — not just the pill button up top.
                                  Once cfgutil returns and devices are
                                  populated, the skeleton block is
                                  replaced by the real radiogroup. */}
                                  {cfgutilDevicesLoading &&
                                    cfgutilDevices.length === 0 && (
                                      <div
                                        aria-label={tCfg(
                                          "device_skeleton_aria"
                                        )}
                                        aria-live="polite"
                                        className="cfgutil-device-list cfgutil-device-list--loading"
                                        role="status"
                                      >
                                        <div className="cfgutil-device-loading-banner">
                                          <span
                                            aria-hidden
                                            className="spinner-sm"
                                          />
                                          <span>
                                            {tCfg("devices_refreshing_status")}
                                          </span>
                                        </div>
                                        <div
                                          aria-hidden
                                          className="cfgutil-device-row cfgutil-device-row--skeleton"
                                        >
                                          <span className="cfgutil-device-dot" />
                                          <span className="cfgutil-device-text">
                                            <span className="cfgutil-device-skeleton cfgutil-device-skeleton--name" />
                                            <span className="cfgutil-device-skeleton cfgutil-device-skeleton--meta" />
                                          </span>
                                        </div>
                                        <div
                                          aria-hidden
                                          className="cfgutil-device-row cfgutil-device-row--skeleton"
                                        >
                                          <span className="cfgutil-device-dot" />
                                          <span className="cfgutil-device-text">
                                            <span className="cfgutil-device-skeleton cfgutil-device-skeleton--name" />
                                            <span className="cfgutil-device-skeleton cfgutil-device-skeleton--meta" />
                                          </span>
                                        </div>
                                      </div>
                                    )}
                                  {cfgutilDevices.length > 0 && (
                                    <div
                                      aria-label={tCfg("device_picker_aria")}
                                      className="cfgutil-device-list"
                                      onKeyDown={wizardRadioKeyDown}
                                      role="radiogroup"
                                    >
                                      {cfgutilDevices.map(
                                        (device, deviceIndex) => {
                                          const selectedDevice =
                                            selectedCfgutilEcid === device.ecid;
                                          return (
                                            <button
                                              aria-checked={selectedDevice}
                                              className={`cfgutil-device-row${selectedDevice ? " is-selected" : ""}`}
                                              key={device.ecid}
                                              onClick={() => {
                                                setSelectedCfgutilEcid(
                                                  device.ecid
                                                );
                                                if (
                                                  cfgutilError ===
                                                  tCfg("step3_select_required")
                                                ) {
                                                  setCfgutilError("");
                                                }
                                              }}
                                              role="radio"
                                              tabIndex={rovingTabIndex(
                                                selectedDevice,
                                                deviceIndex,
                                                cfgutilDevices.some(
                                                  (d) =>
                                                    d.ecid ===
                                                    selectedCfgutilEcid
                                                )
                                              )}
                                              type="button"
                                            >
                                              <span
                                                aria-hidden
                                                className="cfgutil-device-dot"
                                              />
                                              <span className="cfgutil-device-text">
                                                <span className="cfgutil-device-name">
                                                  {describeCfgutilDevice(
                                                    device
                                                  )}
                                                </span>
                                                <span className="cfgutil-device-meta">
                                                  {describeCfgutilDeviceMeta(
                                                    device
                                                  )}
                                                </span>
                                              </span>
                                            </button>
                                          );
                                        }
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                              <div className="cfgutil-step-actions">
                                <button
                                  className="btn btn-primary btn-sm"
                                  disabled={
                                    !cfgutilCheck?.available ||
                                    cfgutilExporting ||
                                    cfgutilDevicesLoading
                                  }
                                  onClick={() => void runCfgutilExportClick()}
                                  type="button"
                                >
                                  {cfgutilExporting ? (
                                    <>
                                      <span className="spinner" />{" "}
                                      {tCfg("step3_export_busy")}
                                    </>
                                  ) : selectedCfgutilDevice ? (
                                    tCfg("step3_export_selected")
                                  ) : (
                                    tCfg("step3_export")
                                  )}
                                </button>
                              </div>
                            </div>
                          </li>
                        </ol>

                        {/* Generic error surface. Rendered under the ladder so
                        both the check and the export pathways feed into the
                        same UI without needing two separate slots. */}
                        {cfgutilError && (
                          <div className="cfgutil-panel-error" role="alert">
                            <strong>{tCfg("error_title")}</strong>
                            <span>{cfgutilError}</span>
                            {cfgutilDiagnostic && (
                              <details className="cfgutil-diagnostic">
                                <summary>{tCfg("diagnostic_summary")}</summary>
                                <p className="cfgutil-diagnostic-hint">
                                  {tCfg("diagnostic_hint_pre")}
                                  <em>{tCfg("diagnostic_hint_trust")}</em>
                                  {tCfg("diagnostic_hint_post")}
                                </p>
                                <pre className="cfgutil-diagnostic-pre">
                                  {cfgutilDiagnostic.length > 4096
                                    ? cfgutilDiagnostic.slice(0, 4096) +
                                      "\n\n…(truncated, " +
                                      (cfgutilDiagnostic.length - 4096) +
                                      " bytes more)"
                                    : cfgutilDiagnostic}
                                </pre>
                              </details>
                            )}
                          </div>
                        )}

                        {/* Progress overlay while cfgutil is running. The
                        Rust command can spend 30-90 seconds talking to
                        a phone with a large library; the only existing
                        feedback was a tiny inline spinner inside the
                        button, which made the app look frozen behind
                        the macOS beach-ball cursor. The overlay covers
                        the panel (not the whole window) so the user
                        can see what action they're waiting on, and
                        carries copy that sets a realistic expectation
                        about how long it might take. Auto-dismisses
                        when `cfgutilExporting` flips back to false. */}
                        {cfgutilExporting && (
                          <div
                            aria-live="polite"
                            className="cfgutil-progress-overlay"
                            role="status"
                          >
                            <div className="cfgutil-progress-card">
                              <span
                                aria-hidden="true"
                                className="spinner spinner-large"
                              />
                              <h3 className="cfgutil-progress-title">
                                {tCfg("progress_title")}
                              </h3>
                              <p className="cfgutil-progress-body">
                                {tCfg("progress_body")}
                              </p>
                              <p className="cfgutil-progress-tip">
                                {tCfg("progress_tip")}
                              </p>
                            </div>
                          </div>
                        )}
                      </section>
                    )}

                    {/* Manual Apple Configurator export instructions —
                     *  kept around for when cfgutil isn't available or
                     *  threw an error. Hidden by default because the
                     *  cfgutil command path is the primary surface for
                     *  this method; we only surface the legacy CSV
                     *  pathway when something's gone wrong (cfgutil
                     *  missing on this Mac, off-desktop platform, USB
                     *  device refused, etc). A "Switch to file upload"
                     *  link routes the user to the proper `method =
                     *  'file'` panel so they don't have to live inside a
                     *  hybrid panel. */}
                    {!cfgutilImportSuccessful &&
                      (!inDesktop ||
                        cfgutilError ||
                        cfgutilCheck?.available === false) && (
                        <div
                          className="wizard-note wizard-note-info"
                          role="note"
                        >
                          <strong>
                            {inDesktop
                              ? tStep2("configurator_export_lead_desktop")
                              : tStep2("configurator_export_lead_other")}
                          </strong>
                          <ol style={{ margin: "8px 0 0 20px", padding: 0 }}>
                            <li>{tStep2("configurator_step_1")}</li>
                            <li>{tStep2("configurator_step_2")}</li>
                            <li>
                              {tStep2.rich("configurator_step_3", {
                                b: (chunks) => <strong>{chunks}</strong>,
                              })}
                            </li>
                            <li>
                              {tStep2.rich("configurator_step_4", {
                                b: (chunks) => <strong>{chunks}</strong>,
                              })}
                            </li>
                            <li>{tStep2("configurator_step_5")}</li>
                          </ol>
                          <button
                            aria-label={tStep2(
                              "configurator_switch_to_file_aria"
                            )}
                            className="link-button-inline"
                            onClick={() => {
                              // Route the user to the file-upload panel,
                              // which is where the CSV drag-drop belongs.
                              // `userSelectedMethodRef` keeps the wizard's
                              // method-picker from clobbering this on the
                              // next render.
                              userSelectedMethodRef.current = true;
                              setMethod("file");
                              setCfgutilError("");
                            }}
                            style={{ marginTop: 10, fontSize: 13 }}
                            type="button"
                          >
                            {tStep2("configurator_switch_to_file")}
                          </button>
                        </div>
                      )}

                    {uploadedFileName && (
                      <div className="upload-summary">
                        <div className="upload-summary-title">
                          <span
                            aria-hidden="true"
                            className="upload-summary-device-icon"
                          >
                            {deviceIcon}
                          </span>{" "}
                          {tStep2("imported_from", {
                            filename: uploadedFileName,
                          })}
                        </div>
                        <div className="upload-summary-copy">
                          {tStep2("imported_from_review_long")}
                        </div>
                        {importInfo && (
                          <div className="upload-summary-note">
                            {importInfo}
                          </div>
                        )}
                        {developerHints.size > 0 && (
                          <div className="upload-summary-note">
                            {tStep2("developer_hints_note")}
                          </div>
                        )}
                        {cfgutilImportSuccessful && inDesktop && (
                          <div className="upload-summary-actions">
                            <button
                              className="link-button-inline"
                              onClick={() => {
                                // Reset the cfgutil-side state so the
                                // ladder + how-to + dropzone reappear and
                                // the user can re-run the export. We don't
                                // wipe `namesText` itself — that's user
                                // data, and the textarea below is the
                                // editable representation of the same
                                // names; the "Re-run import" button just
                                // un-collapses the import surface so the
                                // ladder is accessible again.
                                setUploadedFileName("");
                                setImportInfo("");
                              }}
                              type="button"
                            >
                              ↺ Re-run import
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}

            {/* Auto-resync upfront diff: when the wizard detected a
             *  known cfgutil device (ECID match) and cfgutil has
             *  populated apps, REPLACE the normal "App names" list +
             *  AlreadyTrackedAccordion with the Step2DiffPanel. The
             *  user reviews adds + removes + already-tracked here,
             *  then clicks Continue → confirm modal → commit. The
             *  post-scrape DeviceSyncDiffOverlay only fires when the
             *  user came in via the Settings → Devices "Re-sync"
             *  button (URL-supplied `?resync=`). */}
            {isAutoResyncCfgutil && importedApps.length > 0 && (
              <>
                <Step2DiffPanel
                  deviceId={resyncDeviceId!}
                  deviceName={priorImportHistory?.deviceName ?? ""}
                  entries={importedApps.map((e) => ({
                    id: e.id,
                    name: e.name,
                    bundleId: e.bundleId ?? null,
                  }))}
                  onConfirm={(picked) => {
                    setStep2DiffPicked(picked);
                    // Nothing-to-do path: panel reports 0 adds + 0 removes
                    // (matched everything via bundleId or name fallback).
                    // Skip the confirm modal entirely — it would just ask
                    // "Removing 0, adding 0? Continue / Back" which is an
                    // anticlimax. The panel's own "Done" button fires
                    // this branch directly; the few link-only writes
                    // happen via commitStep2Diff's no-op path which
                    // routes the user to /dashboard.
                    if (picked.addCount === 0 && picked.removeCount === 0) {
                      void commitStep2Diff(picked);
                    } else {
                      setStep2DiffConfirmOpen(true);
                    }
                  }}
                />
                <Step2DiffConfirmModal
                  addCount={step2DiffPicked?.addCount ?? 0}
                  busy={step2DiffCommitting}
                  deviceName={priorImportHistory?.deviceName ?? ""}
                  onBack={() => setStep2DiffConfirmOpen(false)}
                  onConfirm={() => void commitStep2Diff()}
                  open={step2DiffConfirmOpen}
                  removeCount={step2DiffPicked?.removeCount ?? 0}
                />
              </>
            )}

            {/* Pre-cfgutil-run + non-auto-resync paths: render the
             *  normal "App names" list + table. The cfgutil method
             *  still hides the empty-state heading until cfgutil
             *  populates `importedApps`. */}
            {!(
              (isAutoResyncCfgutil && importedApps.length > 0) ||
              (method === "configurator" && importedApps.length === 0)
            ) && (
              <div className="wizard-list-header">
                <div>
                  <div className="wizard-list-title">
                    {tStep2("list_title")}
                  </div>
                  <div className="wizard-list-copy">
                    {selectedCount > 0
                      ? tStep2("list_count", { count: selectedCount })
                      : method === "screenshots"
                        ? tStep2("list_empty_screenshots")
                        : method === "configurator"
                          ? tStep2("list_empty_configurator")
                          : tStep2("list_empty_manual")}
                  </div>
                </div>
              </div>
            )}

            {/* AlreadyTrackedAccordion + ImportedAppsTable: shown on
             *  every path EXCEPT the auto-resync cfgutil flow (which
             *  has its own Step2DiffPanel above that subsumes both). */}
            {!(isAutoResyncCfgutil && importedApps.length > 0) && (
              <AlreadyTrackedAccordion
                deviceId={resyncDeviceId}
                deviceName={priorImportHistory?.deviceName}
                entries={importedApps}
              />
            )}

            {!(
              (isAutoResyncCfgutil && importedApps.length > 0) ||
              (method === "configurator" && importedApps.length === 0)
            ) && (
              <ImportedAppsTable
                entries={importedApps}
                onAdd={(rawText) => {
                  const names = parseManualAppText(rawText);
                  if (names.length === 0) {
                    return;
                  }
                  // Dedupe against the existing list (case-insensitive)
                  // so paste-bombing the same names doesn't multiply rows.
                  const existing = new Set(
                    importedApps.map((e) => e.name.toLowerCase())
                  );
                  const fresh = names
                    .filter((n) => !existing.has(n.toLowerCase()))
                    .map((name) =>
                      makeImportedAppEntry({ name, source: "manual" })
                    );
                  if (fresh.length > 0) {
                    setImportedApps((prev) => [...prev, ...fresh]);
                  }
                }}
                onPendingChange={setPendingAppText}
                onRemove={(id) =>
                  setImportedApps((prev) => prev.filter((e) => e.id !== id))
                }
                pending={pendingAppText}
              />
            )}

            {/* The "N of these are already tracked" banner that used to
                live here relied on a name-lowercase fuzzy match, which
                mis-counted common names (many apps share a title) and
                also missed misspellings. It has moved to the top of
                Step 3 — see the `trackedSelectedCount` banner there —
                where the App Store appleId of each chosen candidate
                gives us an exact, authoritative count. */}

            {searchError && (
              <p style={{ color: "var(--red)", fontSize: 13, marginTop: 12 }}>
                {searchError}
                {searchBlocked && (
                  <>
                    {" "}
                    <Link href="/dashboard/settings#deployment-diagnostics">
                      {tStatus("search_access_blocked_link")}
                    </Link>
                  </>
                )}
              </p>
            )}

            {/* Rate-limit banner above the "Find apps in App Store" CTA.

                When iTunes Search has been throttled, every name in the
                wizard's batch will fail with the same 429 — surfacing the
                cooldown here lets users see what's happening before they
                click and watch a long progress bar fail. The auto-retry
                callback re-runs `handleSearch` with the same selection,
                which kicks off a fresh batch through the existing
                queued-search path. */}
            <RateLimitBanner
              category="search"
              onResume={() => {
                if (selectedCount > 0 && !searching && !ocring) {
                  handleSearch();
                }
              }}
            />

            {/* In-flight search progress. Replaces the previous endless
                spinner with a live bar + count + cancel — phase-1
                bundle-ID lookup feeds the running matched count
                instantly, then phase-2 name search chunks tick the
                bar batch-by-batch (~50 names each). */}
            {searching && searchProgress && (
              <SearchProgressCard
                onCancel={cancelSearch}
                progress={searchProgress}
              />
            )}

            {/* Step-2 footer (Back + Find apps in App Store) — hidden
             *  on the auto-resync path. Step2DiffPanel surfaces its
             *  own Continue button which fires `commitStep2Diff`,
             *  which then drives `handleSearch` once removes have
             *  committed. The user only sees one primary action at a
             *  time. */}
            {!(isAutoResyncCfgutil && importedApps.length > 0) && (
              <div className="wizard-footer-actions">
                <button
                  className="btn btn-secondary"
                  disabled={searching}
                  onClick={() => setStep(1)}
                  type="button"
                >
                  {tStep2("back")}
                </button>
                <button
                  className="btn btn-primary btn-lg"
                  data-testid="onboard-search"
                  disabled={
                    searching ||
                    (selectedCount === 0 &&
                      pendingAppText.trim().length === 0) ||
                    ocring
                  }
                  onClick={handleSearch}
                  style={{ flex: 1 }}
                  type="button"
                >
                  {searching && searchProgress ? (
                    tStep2("search_busy_count", {
                      matched: searchProgress.matched,
                      total: searchProgress.total,
                    })
                  ) : searching ? (
                    <>
                      <span className="spinner" /> {tStep2("search_busy")}
                    </>
                  ) : (
                    tStep2("search")
                  )}
                </button>
              </div>
            )}
          </>
        )}

        {step === 3 &&
          onboardStepConfirmMatchesOn &&
          (() => {
            // ── Step 3 derived state ────────────────────────────────────
            //
            // `isCandidateTracked` — a candidate is "already tracked" if
            // EITHER its App Store track ID matches an existing row, OR
            // its bundle ID does. The bundle-ID fallback catches the
            // legacy-import duplicate where a previous name-search
            // import and a cfgutil bundle-ID import resolved the same
            // physical app to different track IDs. Without the bundle-
            // ID arm, Step 3's banner under-counts and the user clicks
            // "Import N apps" only to end up with duplicate rows in the
            // apps table.
            const isCandidateTracked = (candidate: AppCandidate): boolean => {
              if (trackedByAppleId.has(candidate.appleId)) {
                return true;
              }
              if (
                candidate.bundleId &&
                trackedByBundleId.has(candidate.bundleId)
              ) {
                return true;
              }
              return false;
            };

            // `trackedSelectedCount` counts how many of the user's chosen
            // candidates already exist in the local DB. Powers the
            // "N of these apps are already being tracked" banner at the
            // top of Step 3. Supersedes the Step 2 name-based nudge,
            // which could over-count because many apps share a common
            // name.
            const trackedSelectedCount = Array.from(selected.values()).filter(
              isCandidateTracked
            ).length;

            // `visibleResults` drives the rendered block list. When the
            // "Hide already-tracked apps" toggle is on, we drop any block
            // whose currently-chosen candidate matches a tracked app. If
            // no candidate is chosen yet (skipped / no matches), we keep
            // the block visible — there's nothing confident to hide.
            const visibleResults = hideTrackedBlocks
              ? searchResults.filter((result) => {
                  const chosen = selected.get(result.query);
                  return !(chosen && isCandidateTracked(chosen));
                })
              : searchResults;

            // `effectiveSelected` is what actually gets imported. When the
            // toggle is on, we exclude tracked rows from the import so the
            // button count and the follow-up scrape loop match what the
            // user sees. Selections for hidden rows stay in `selected` so
            // toggling back off restores the prior choices as-is.
            const effectiveSelected = hideTrackedBlocks
              ? new Map(
                  Array.from(selected.entries()).filter(
                    ([, candidate]) => !isCandidateTracked(candidate)
                  )
                )
              : selected;
            const effectiveCount = effectiveSelected.size;
            const statusFor = (
              result: SearchResult
            ): NonNullable<SearchResult["status"]> => {
              if (skippedQueries.has(result.query)) {
                return "skipped";
              }
              if (result.status) {
                return result.status;
              }
              if (selected.has(result.query)) {
                return "matched";
              }
              return result.candidates.length > 0 ? "matched" : "unmatched";
            };
            const pendingMatchCount = searchResults.filter(
              (result) => statusFor(result) === "pending"
            ).length;
            const summary = {
              total: searchResults.length,
              matched: searchResults.filter(
                (result) =>
                  statusFor(result) === "matched" && selected.has(result.query)
              ).length,
              bundle: searchResults.filter(
                (result) =>
                  statusFor(result) === "matched" &&
                  result.matchSource === "bundle"
              ).length,
              name: searchResults.filter(
                (result) =>
                  statusFor(result) === "matched" &&
                  result.matchSource !== "bundle"
              ).length,
              pending: pendingMatchCount,
              skipped: searchResults.filter(
                (result) => statusFor(result) === "skipped"
              ).length,
              unavailable: searchResults.filter(
                (result) => statusFor(result) === "unmatched"
              ).length,
            };
            // Group by the *initial* match shape, NOT by the current
            // checkbox state. Earlier versions filtered each section on
            // `selected.has(result.query)`, so unticking a row made it
            // jump from "Matched by bundle ID" to "Needs review" mid-
            // session — confusing because the user thinks they just
            // unchecked an import, not relocated the row. With the new
            // filter, deselecting toggles the row's checkbox but keeps
            // it visually anchored to its original section. The actual
            // selected-for-import set still drives the import via
            // `effectiveSelected`, and the summary counts still reflect
            // the live selection state for accuracy.
            const sectionDefs = [
              {
                id: "bundle",
                title: tStep3("bundle_title"),
                description: tStep3("bundle_description"),
                results: visibleResults.filter(
                  (result) =>
                    statusFor(result) === "matched" &&
                    result.matchSource === "bundle"
                ),
              },
              {
                id: "name",
                title: tStep3("name_title"),
                description: tStep3("name_description"),
                results: visibleResults.filter(
                  (result) =>
                    statusFor(result) === "matched" &&
                    result.matchSource !== "bundle"
                ),
              },
              {
                id: "review",
                title: tStep3("review_title"),
                description: tStep3("review_description"),
                results: visibleResults.filter(
                  (result) => statusFor(result) === "pending"
                ),
              },
              // "unavailable" used to bundle unmatched + skipped together,
              // but the actions a user wants on each are different: an
              // unmatched row is a candidate for the "save as manual app"
              // triage below, while a skipped row is intentionally out
              // of the import. Splitting them gives the triage a clean
              // surface and keeps skipped rows from cluttering it.
              {
                id: "unavailable",
                title: tStep3("unavailable_title"),
                description: tStep3("unavailable_description"),
                results: visibleResults.filter(
                  (result) => statusFor(result) === "unmatched"
                ),
              },
              {
                id: "skipped",
                title: tStep3("skipped_title"),
                description: tStep3("skipped_description"),
                results: visibleResults.filter(
                  (result) => statusFor(result) === "skipped"
                ),
              },
            ].filter((section) => section.results.length > 0);

            // List of query names that returned no App Store candidates,
            // and the subset that the user hasn't already skipped /
            // researched. Used for the bulk-action banner below the
            // tracked-banner — on a large cfgutil batch (200+ apps),
            // clicking "Skip this" per row is unworkable. The banner
            // gives a single "skip all" affordance and a count so the
            // user knows what they're collapsing.
            const unmatchedQueries = searchResults
              .filter((r) => r.candidates.length === 0)
              .map((r) => r.query);
            // Active = no candidate AND not already marked skipped. We
            // approximate "marked skipped" by checking whether the item
            // appears in itemIdByQuery (every block has an itemId; the
            // skip handler hits /api/imports/items/update without
            // removing the row, so this check is just a fuzz pass — the
            // bulk action below is idempotent against already-skipped
            // rows anyway, so a small over-count is harmless).
            const unmatchedCount = unmatchedQueries.length;

            return (
              <>
                <h1 className="wizard-title">{tWiz("confirm_matches")}</h1>
                <p className="wizard-subtitle">{tStep3("subtitle")}</p>

                {blockSearchError && (
                  <p
                    role="alert"
                    style={{ color: "var(--red)", fontSize: 13, marginTop: 12 }}
                  >
                    {blockSearchError}
                    {searchBlocked && (
                      <>
                        {" "}
                        <Link href="/dashboard/settings#deployment-diagnostics">
                          {tStatus("search_access_blocked_link")}
                        </Link>
                      </>
                    )}
                  </p>
                )}

                {/* Top summary + skip-to-import banner. Surfaces the "you can
                stop here" affordance so a 212-app review doesn't force
                the user to scroll the whole list. The button mirrors
                the footer's confirm CTA — both fire the same
                handleConfirm path. Hidden mid-search so the counts
                don't flicker during the iTunes lookup loop. */}
                {!searching && effectiveCount > 0 && (
                  <div
                    className="wizard-note"
                    role="status"
                    style={{
                      marginTop: 12,
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                      flexWrap: "wrap",
                      background: "var(--bg-2)",
                      border: "1px solid var(--border-strong)",
                      borderRadius: "var(--r-lg)",
                      padding: "14px 16px",
                    }}
                  >
                    <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        {tStep3("ready_lead", { count: effectiveCount })}
                      </div>
                      <div style={{ fontSize: 13, color: "var(--text-2)" }}>
                        {(() => {
                          const reviewable = visibleResults.filter(
                            (r) =>
                              statusFor(r) === "matched" &&
                              !selected.has(r.query) &&
                              r.candidates.length > 0
                          ).length;
                          const unmatched = visibleResults.filter(
                            (r) => statusFor(r) === "unmatched"
                          ).length;
                          const parts: string[] = [];
                          if (reviewable > 0) {
                            parts.push(
                              tStep3("ready_part_review", {
                                count: reviewable,
                              })
                            );
                          }
                          if (unmatched > 0) {
                            parts.push(
                              tStep3("ready_part_unmatched", {
                                count: unmatched,
                              })
                            );
                          }
                          if (parts.length === 0) {
                            return tStep3("ready_all_clear");
                          }
                          return tStep3("ready_more", {
                            parts: parts.join(", "),
                          });
                        })()}
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      disabled={pendingMatchCount > 0 || rematchingRegion}
                      onClick={() => void handleConfirm(effectiveSelected)}
                      style={{ whiteSpace: "nowrap" }}
                      type="button"
                    >
                      {pendingMatchCount > 0
                        ? tStep3("ready_waiting", { count: pendingMatchCount })
                        : tStep3("ready_import_now", {
                            count: effectiveCount,
                          })}
                    </button>
                  </div>
                )}

                {/* Already-tracked banner (moved from Step 2). Uses the exact
                appleId lookup so the count reflects the actual matches
                rather than a fuzzy name match.

                Two-phase render:
                  (a) while searches are still in flight — either the
                      initial request is pending (`searching`) or the
                      queued-search provider is sleeping through a rate
                      limit (`ratePending.pending`) — the duplicate
                      count is moving target, and flashing "3 already
                      tracked" → "7 already tracked" → "11 already
                      tracked" as each batch lands looks like a bug.
                      Show a neutral "Checking apps for duplicates…"
                      banner instead and leave the real count offstage.
                  (b) once everything has resolved, swap to the final
                      count + the hide-tracked toggle. If there's no
                      overlap at all, neither banner renders so the
                      review list stays uncluttered. */}
                {(() => {
                  const stillChecking = searching || ratePending.pending;
                  if (stillChecking) {
                    return (
                      <div
                        aria-live="polite"
                        className="wizard-note wizard-note-info"
                        role="status"
                        style={{
                          marginTop: 12,
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <span aria-hidden="true" className="spinner" />
                        <span>
                          <strong>{tStep3("checking_lead")}</strong>
                          {tStep3("checking_body")}
                        </span>
                      </div>
                    );
                  }
                  if (trackedSelectedCount === 0) {
                    return null;
                  }
                  return (
                    <div
                      className="wizard-note wizard-note-info"
                      style={{ marginTop: 12 }}
                    >
                      <strong>
                        {tStep3("tracked_lead", {
                          count: trackedSelectedCount,
                        })}
                      </strong>
                      {tStep3("tracked_body")}
                      {onboardHideTrackedToggleOn && (
                        <label
                          className="wizard-toggle-inline"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginTop: 10,
                            cursor: "pointer",
                            fontWeight: 500,
                          }}
                        >
                          <input
                            checked={hideTrackedBlocks}
                            onChange={(event) =>
                              setHideTrackedBlocks(event.target.checked)
                            }
                            type="checkbox"
                          />
                          <span>
                            {tStep3("hide_tracked_label")}{" "}
                            <span
                              style={{
                                color: "var(--text-3)",
                                fontWeight: 400,
                              }}
                            >
                              {tStep3("hide_tracked_hint")}
                            </span>
                          </span>
                        </label>
                      )}
                    </div>
                  );
                })()}

                {ratePending.pending &&
                  (() => {
                    // Read `rateTick` so the countdown re-renders every second while
                    // we wait. The actual queue + timer lives in QueuedSearchProvider
                    // (layout-level) so it keeps running even if the user navigates
                    // away — this banner is just a local view on to its state.
                    void rateTick;
                    const queuedCount = ratePending.remaining;
                    const resumeAt = ratePending.resumeAt;
                    const remainingMs =
                      resumeAt === null
                        ? null
                        : Math.max(0, resumeAt - Date.now());
                    const remainingSec =
                      remainingMs === null
                        ? null
                        : Math.ceil(remainingMs / 1000);
                    return (
                      <div
                        aria-live="polite"
                        className="wizard-rate-banner"
                        role="status"
                      >
                        <div aria-hidden className="wizard-rate-banner-icon">
                          ⏳
                        </div>
                        <div className="wizard-rate-banner-copy">
                          <div className="wizard-rate-banner-title">
                            {tStep3("rate_limit_title")}
                          </div>
                          <div className="wizard-rate-banner-sub">
                            {tStep3("rate_limit_queued", {
                              count: queuedCount,
                            })}
                            {remainingSec === null
                              ? tStep3("rate_limit_resume_soon")
                              : tStep3("rate_limit_resume_in", {
                                  sec: remainingSec,
                                })}
                            {tStep3("rate_limit_hint")}
                          </div>
                        </div>
                        <button
                          aria-label={tStep3("rate_limit_cancel_aria")}
                          className="wizard-rate-banner-cancel"
                          onClick={() => void handleCancelQueuedMatches()}
                          type="button"
                        >
                          {tStep3("rate_limit_cancel")}
                        </button>
                      </div>
                    );
                  })()}

                {/* Country-rematch toolbar (kept from our branch). Lets the
                user switch App Store storefront mid-match without
                losing manual choices or skipped rows. */}
                <div className="onboard-match-toolbar">
                  <div>
                    <div className="onboard-match-toolbar-title">
                      {tStep3("rematch_title", {
                        label: countryLabel(country),
                        code: country.toUpperCase(),
                      })}
                    </div>
                    <div className="onboard-match-toolbar-sub">
                      {tStep3("rematch_sub")}
                    </div>
                  </div>
                  <div className="onboard-match-region-controls">
                    <select
                      aria-label={tStep3("rematch_region_aria")}
                      className="settings-input settings-select"
                      disabled={rematchingRegion}
                      onChange={(event) =>
                        void handleRegionRematch(event.target.value)
                      }
                      value={country}
                    >
                      {COUNTRY_OPTIONS.map((option) => (
                        <option key={option.code} value={option.code}>
                          {option.label} ({option.code.toUpperCase()})
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={rematchingRegion}
                      onClick={() => void handleRegionRematch(country)}
                      type="button"
                    >
                      {rematchingRegion ? (
                        <>
                          <span className="spinner-sm" /> {tStep3("rematching")}
                        </>
                      ) : (
                        tStep3("rematch_button")
                      )}
                    </button>
                  </div>
                </div>

                {unmatchedCount > 0 && (
                  // Unmatched-apps banner (from main's PR #7). Big cfgutil
                  // imports routinely produce 50+ rows that didn't resolve
                  // to an App Store candidate (sideloaded, region-restricted,
                  // names too generic to disambiguate). One "skip all"
                  // affordance keeps the review list usable.
                  //
                  // Note: the flat `visibleResults.map(...)` rendering that
                  // originally followed this on main was dropped during the
                  // merge — our branch's grouped `sectionDefs` rendering
                  // below already renders the same blocks but organised by
                  // status, which is the superseding UX.
                  <div
                    className="wizard-note wizard-note-info"
                    style={{ marginTop: 12 }}
                  >
                    <strong>
                      {tStep3("unmatched_lead", { count: unmatchedCount })}
                    </strong>
                    {tStep3("unmatched_body")}
                    <div style={{ marginTop: 10 }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          for (const query of unmatchedQueries) {
                            void handleBlockSkip(query);
                          }
                        }}
                        type="button"
                      >
                        {tStep3("unmatched_skip_all", {
                          count: unmatchedCount,
                        })}
                      </button>
                    </div>
                  </div>
                )}

                <div className="onboard-match-summary">
                  <span>
                    {tStep3("summary_chip_imported", { count: summary.total })}
                  </span>
                  <span>
                    {tStep3("summary_chip_matched", { count: summary.matched })}
                  </span>
                  <span>
                    {tStep3("summary_chip_bundle", { count: summary.bundle })}
                  </span>
                  <span>
                    {tStep3("summary_chip_name", { count: summary.name })}
                  </span>
                  {summary.pending > 0 && (
                    <span>
                      {tStep3("summary_chip_pending", {
                        count: summary.pending,
                      })}
                    </span>
                  )}
                  {summary.skipped > 0 && (
                    <span>
                      {tStep3("summary_chip_skipped", {
                        count: summary.skipped,
                      })}
                    </span>
                  )}
                  {summary.unavailable > 0 && (
                    <span>
                      {tStep3("summary_chip_unavailable", {
                        count: summary.unavailable,
                      })}
                    </span>
                  )}
                  {webClipEntries.length > 0 && (
                    <span>
                      {tStep3("webclip_count_chip", {
                        count: webClipEntries.length,
                      })}
                    </span>
                  )}
                </div>

                {/* Safari web-shortcuts panel. Rendered above the section list
                so the user spots and dispatches them up front — saving as
                a batch of manual web-apps is the right action 99% of the
                time, and clearing them gets the panel out of the way for
                the App Store match review below. */}
                {webClipEntries.length > 0 && (
                  <section
                    aria-labelledby="webclip-section-heading"
                    className="onboard-match-section"
                  >
                    <div className="onboard-match-section-header">
                      <div>
                        <h2 id="webclip-section-heading">
                          {tStep3("webclip_title")}{" "}
                          <span
                            style={{ color: "var(--text-2)", fontWeight: 400 }}
                          >
                            {tStep3("webclip_title_suffix")}
                          </span>
                        </h2>
                        <p>
                          {webClipSaveState === "saved"
                            ? tStep3("webclip_saved", {
                                count: webClipSavedCount,
                              })
                            : tStep3("webclip_lead", {
                                count: webClipEntries.length,
                              })}
                        </p>
                      </div>
                      <span>{webClipEntries.length}</span>
                    </div>
                    {webClipSaveState !== "saved" && (
                      <>
                        <ul
                          className="onboard-webclip-list"
                          style={{
                            listStyle: "none",
                            margin: "0 0 12px",
                            padding: "0 0 0 4px",
                            maxHeight: 220,
                            overflowY: "auto",
                          }}
                        >
                          {webClipEntries.map((e) => (
                            <li
                              key={e.id}
                              style={{
                                padding: "6px 0",
                                fontSize: 13,
                                color: "var(--text)",
                                borderBottom: "1px solid var(--border)",
                              }}
                            >
                              <strong>{e.name}</strong>
                              {e.bundleId && (
                                <span
                                  style={{
                                    color: "var(--text-3)",
                                    marginLeft: 8,
                                    fontSize: 12,
                                  }}
                                >
                                  {e.bundleId.slice(0, 60)}
                                  {e.bundleId.length > 60 ? "…" : ""}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                        {webClipSaveError && (
                          <p
                            style={{
                              color: "var(--danger)",
                              fontSize: 13,
                              margin: "0 0 8px",
                            }}
                          >
                            {webClipSaveError}
                          </p>
                        )}
                        <div
                          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                        >
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={webClipSaveState === "saving"}
                            onClick={async () => {
                              setWebClipSaveState("saving");
                              setWebClipSaveError("");
                              try {
                                const res = await fetch(
                                  "/api/manual-apps/bulk",
                                  {
                                    method: "POST",
                                    headers: {
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                      apps: webClipEntries.map((e) => ({
                                        name: e.name,
                                        source: "web_clip" as const,
                                        developer: e.developer ?? null,
                                      })),
                                    }),
                                  }
                                );
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok) {
                                  throw new Error(
                                    data?.error ?? `HTTP ${res.status}`
                                  );
                                }
                                const created =
                                  typeof data.created === "number"
                                    ? data.created
                                    : 0;
                                setWebClipSavedCount(created);
                                setWebClipSaveState("saved");
                                // Drop the web-clip rows from importedApps so
                                // they no longer count toward summary.total and
                                // don't reappear if the user navigates back to
                                // Step 2.
                                setImportedApps((prev) =>
                                  prev.filter((e) => !e.likelyWebClip)
                                );
                              } catch (err) {
                                setWebClipSaveState("error");
                                setWebClipSaveError(
                                  err instanceof Error
                                    ? err.message
                                    : tStep3("webclip_save_failed")
                                );
                              }
                            }}
                            type="button"
                          >
                            {webClipSaveState === "saving" ? (
                              <>
                                <span className="spinner-sm" />{" "}
                                {tStep3("webclip_saving")}
                              </>
                            ) : (
                              tStep3("webclip_save_cta", {
                                count: webClipEntries.length,
                              })
                            )}
                          </button>
                        </div>
                      </>
                    )}
                  </section>
                )}

                <div className="search-result-list">
                  {sectionDefs.map((section) => {
                    // The "Not in the App Store" section needs a different row
                    // shape: each row offers a per-row triage dropdown
                    // (TestFlight / Sideloaded / Web app / Own build / Skip)
                    // and the whole section is finalised with a "Save all as
                    // manual apps" bulk CTA. The default-when-unset is
                    // `sideloaded` because it's the broadest "I know this
                    // app exists but it's not on the App Store" bucket.
                    if (section.id === "unavailable") {
                      return (
                        <section
                          className="onboard-match-section"
                          key={section.id}
                        >
                          <div className="onboard-match-section-header">
                            <div>
                              <h2>{section.title}</h2>
                              <p>
                                {unmatchedSaveState === "saved"
                                  ? tStep3("unavailable_saved", {
                                      count: unmatchedSavedCount,
                                    })
                                  : section.description}
                              </p>
                            </div>
                            <span>{section.results.length}</span>
                          </div>
                          {unmatchedSaveState !== "saved" && (
                            <>
                              <ul
                                style={{
                                  listStyle: "none",
                                  padding: 0,
                                  margin: "0 0 12px",
                                }}
                              >
                                {section.results.map((result) => {
                                  const choice =
                                    triageChoices.get(result.query) ??
                                    "sideloaded";
                                  const isEditing =
                                    editingBlock === result.query;
                                  return (
                                    <li
                                      key={result.query}
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 12,
                                        padding: "10px 12px",
                                        borderBottom: "1px solid var(--border)",
                                        flexWrap: "wrap",
                                      }}
                                    >
                                      {isEditing ? (
                                        <UnavailableRowEditor
                                          busyEditing={
                                            blockSearching === result.query
                                          }
                                          initialQuery={result.query}
                                          onCancel={() => setEditingBlock(null)}
                                          onRetry={(nextQuery) => {
                                            // force=true so an unchanged
                                            // name still replays the
                                            // search — without it the
                                            // "nothing changed" guard
                                            // silently no-ops and the
                                            // button feels broken.
                                            // handleBlockResearch flags
                                            // the row in-flight via
                                            // `blockSearching` and closes
                                            // the editor on completion.
                                            void handleBlockResearch(
                                              result.query,
                                              nextQuery,
                                              undefined,
                                              true
                                            );
                                          }}
                                        />
                                      ) : (
                                        <>
                                          <strong
                                            style={{
                                              flex: "1 1 220px",
                                              minWidth: 0,
                                            }}
                                          >
                                            {result.query}
                                          </strong>
                                          <button
                                            className="link-button-inline"
                                            disabled={blockSearching !== null}
                                            onClick={() =>
                                              void handleBlockResearch(
                                                result.query,
                                                result.query,
                                                undefined,
                                                true
                                              )
                                            }
                                            style={{ fontSize: 13 }}
                                            title={tSearchBlock("retry_title")}
                                            type="button"
                                          >
                                            {blockSearching === result.query ? (
                                              <>
                                                <span className="spinner-sm" />{" "}
                                                {tSearchBlock("retry_busy")}
                                              </>
                                            ) : (
                                              tSearchBlock("retry_search")
                                            )}
                                          </button>
                                          <button
                                            className="link-button-inline"
                                            disabled={blockSearching !== null}
                                            onClick={() =>
                                              setEditingBlock(result.query)
                                            }
                                            style={{ fontSize: 13 }}
                                            type="button"
                                          >
                                            {tSearchBlock("edit_retry")}
                                          </button>
                                          <label
                                            htmlFor={`triage-${result.query}`}
                                            style={{
                                              fontSize: 12,
                                              color: "var(--text-2)",
                                            }}
                                          >
                                            {tSearchBlock("save_as_label")}
                                          </label>
                                          <select
                                            className="settings-input settings-select"
                                            id={`triage-${result.query}`}
                                            onChange={(e) => {
                                              const next = new Map(
                                                triageChoices
                                              );
                                              next.set(
                                                result.query,
                                                e.target.value as TriageChoice
                                              );
                                              setTriageChoices(next);
                                            }}
                                            style={{ minWidth: 180 }}
                                            value={choice}
                                          >
                                            <option value="sideloaded">
                                              {tStep3("triage_sideloaded")}
                                            </option>
                                            <option value="testflight">
                                              {tStep3("triage_testflight")}
                                            </option>
                                            <option value="web_clip">
                                              {tStep3("triage_web_clip")}
                                            </option>
                                            <option value="own_build">
                                              {tStep3("triage_own_build")}
                                            </option>
                                            <option value="skip">
                                              {tStep3("triage_skip")}
                                            </option>
                                          </select>
                                        </>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                              {unmatchedSaveError && (
                                <p
                                  style={{
                                    color: "var(--danger)",
                                    fontSize: 13,
                                    margin: "0 0 8px",
                                  }}
                                >
                                  {unmatchedSaveError}
                                </p>
                              )}
                              <div
                                style={{
                                  display: "flex",
                                  gap: 8,
                                  flexWrap: "wrap",
                                }}
                              >
                                <button
                                  className="btn btn-primary btn-sm"
                                  disabled={unmatchedSaveState === "saving"}
                                  onClick={async () => {
                                    setUnmatchedSaveState("saving");
                                    setUnmatchedSaveError("");
                                    const payload = section.results
                                      .map((r) => {
                                        const choice =
                                          triageChoices.get(r.query) ??
                                          "sideloaded";
                                        if (choice === "skip") {
                                          return null;
                                        }
                                        return {
                                          name: r.query,
                                          source: choice,
                                          developer:
                                            developerHints.get(
                                              r.query.toLowerCase()
                                            ) ?? null,
                                        };
                                      })
                                      .filter(
                                        (row): row is NonNullable<typeof row> =>
                                          row !== null
                                      );
                                    if (payload.length === 0) {
                                      // All rows skipped — treat as save success
                                      // with count 0 so the section collapses.
                                      setUnmatchedSavedCount(0);
                                      setUnmatchedSaveState("saved");
                                      return;
                                    }
                                    try {
                                      const res = await fetch(
                                        "/api/manual-apps/bulk",
                                        {
                                          method: "POST",
                                          headers: {
                                            "Content-Type": "application/json",
                                          },
                                          body: JSON.stringify({
                                            apps: payload,
                                          }),
                                        }
                                      );
                                      const data = await res
                                        .json()
                                        .catch(() => ({}));
                                      if (!res.ok) {
                                        throw new Error(
                                          data?.error ?? `HTTP ${res.status}`
                                        );
                                      }
                                      const created =
                                        typeof data.created === "number"
                                          ? data.created
                                          : 0;
                                      setUnmatchedSavedCount(created);
                                      setUnmatchedSaveState("saved");
                                      // Skip the just-saved rows so they
                                      // disappear from this section and don't
                                      // count toward summary.unavailable.
                                      for (const row of payload) {
                                        void handleBlockSkip(row.name);
                                      }
                                    } catch (err) {
                                      setUnmatchedSaveState("error");
                                      setUnmatchedSaveError(
                                        err instanceof Error
                                          ? err.message
                                          : tStep3("unavailable_save_failed")
                                      );
                                    }
                                  }}
                                  type="button"
                                >
                                  {unmatchedSaveState === "saving" ? (
                                    <>
                                      <span className="spinner-sm" />{" "}
                                      {tStep3("unavailable_saving")}
                                    </>
                                  ) : (
                                    tStep3("unavailable_save_cta", {
                                      count: section.results.length,
                                    })
                                  )}
                                </button>
                              </div>
                            </>
                          )}
                        </section>
                      );
                    }
                    // Bundle-ID-matched rows are auto-resolved with the highest
                    // confidence we have (cfgutil supplied the bundleId; iTunes
                    // Lookup returned a direct hit). The user almost never
                    // needs to touch them, so render this section as a
                    // collapsed <details> accordion — header is always
                    // visible (count + "Show details" chevron) and the rows
                    // hide behind a single click. Other sections (Matched by
                    // name, Needs review, Skipped) stay inline because they
                    // are where the user's judgement is actually required.
                    // Bundle-ID-matched rows are auto-resolved with the
                    // highest confidence we have (cfgutil supplied the
                    // bundleId; iTunes Lookup returned a direct hit). The
                    // user almost never needs to touch them, so render
                    // this section as a collapsed <details> accordion —
                    // header is always visible (count + chevron) and the
                    // rows hide behind a single click. Other sections
                    // (Matched by name, Needs review, Skipped) stay inline
                    // because they're where the user's judgement is
                    // actually required.
                    const isBundle = section.id === "bundle";
                    const Wrapper: React.ElementType = isBundle
                      ? "details"
                      : "section";
                    const HeaderTag: React.ElementType = isBundle
                      ? "summary"
                      : "div";
                    const wrapperClass = isBundle
                      ? "onboard-match-section onboard-match-section-accordion"
                      : "onboard-match-section";
                    const headerClass = isBundle
                      ? "onboard-match-section-header onboard-match-section-summary"
                      : "onboard-match-section-header";
                    return (
                      <Wrapper className={wrapperClass} key={section.id}>
                        <HeaderTag className={headerClass}>
                          <div>
                            <h2>{section.title}</h2>
                            <p>{section.description}</p>
                          </div>
                          <span>{section.results.length}</span>
                          {isBundle && (
                            <span
                              aria-hidden="true"
                              className="onboard-match-section-chevron"
                            >
                              ▸
                            </span>
                          )}
                        </HeaderTag>
                        <div className="onboard-match-section-list">
                          {section.results.map((result) => (
                            <SearchResultBlock
                              chosen={selected.get(result.query) ?? null}
                              developerHint={
                                developerHints.get(
                                  result.query.toLowerCase()
                                ) ?? ""
                              }
                              editing={blockSearching === result.query}
                              key={result.query}
                              onChoose={(candidate) => {
                                if (candidate === null) {
                                  const next = new Map(selected);
                                  next.delete(result.query);
                                  setSelected(next);
                                  setManuallyChosenQueries((prev) => {
                                    const manual = new Set(prev);
                                    manual.delete(result.query);
                                    return manual;
                                  });
                                  setSearchResults((prev) =>
                                    prev.map((item) =>
                                      item.query === result.query
                                        ? {
                                            ...item,
                                            status:
                                              item.candidates.length > 0
                                                ? "matched"
                                                : "unmatched",
                                          }
                                        : item
                                    )
                                  );
                                  return;
                                }

                                setSelected(
                                  new Map(selected).set(result.query, candidate)
                                );
                                setSkippedQueries((prev) => {
                                  const next = new Set(prev);
                                  next.delete(result.query);
                                  return next;
                                });
                                setManuallyChosenQueries((prev) =>
                                  new Set(prev).add(result.query)
                                );
                                setSearchResults((prev) =>
                                  prev.map((item) =>
                                    item.query === result.query
                                      ? {
                                          ...item,
                                          status: "matched",
                                          matchSource: "manual",
                                        }
                                      : item
                                  )
                                );
                              }}
                              onResearch={(nextQuery, nextDeveloper, force) =>
                                handleBlockResearch(
                                  result.query,
                                  nextQuery,
                                  nextDeveloper,
                                  force
                                )
                              }
                              onSkip={() => handleBlockSkip(result.query)}
                              result={result}
                              trackedByAppleId={trackedByAppleId}
                              trackedByBundleId={trackedByBundleId}
                            />
                          ))}
                        </div>
                      </Wrapper>
                    );
                  })}
                  {visibleResults.length === 0 && searchResults.length > 0 && (
                    // Only reachable when "Hide already-tracked apps" has
                    // filtered every block out — tell the user what happened
                    // and offer them a one-click way back to the full list.
                    <div
                      className="wizard-note wizard-note-info"
                      style={{ textAlign: "center" }}
                    >
                      {tStep3("all_hidden")}{" "}
                      <button
                        className="link-button-inline"
                        onClick={() => setHideTrackedBlocks(false)}
                        type="button"
                      >
                        {tStep3("show_all")}
                      </button>
                    </div>
                  )}
                </div>

                <div className="wizard-footer-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => setStep(2)}
                    type="button"
                  >
                    {tStep3("back")}
                  </button>
                  <button
                    className="btn btn-primary"
                    data-testid="onboard-confirm-import"
                    disabled={
                      effectiveCount === 0 ||
                      pendingMatchCount > 0 ||
                      rematchingRegion
                    }
                    onClick={() => void handleConfirm(effectiveSelected)}
                    style={{ flex: 1 }}
                    type="button"
                  >
                    {pendingMatchCount > 0
                      ? tStep3("waiting_matches", { count: pendingMatchCount })
                      : tStep3("import_count", { count: effectiveCount })}
                  </button>
                </div>
              </>
            );
          })()}

        {step === 4 && onboardStepImportProgressOn && (
          <>
            <h1 className="wizard-title">
              {done ? tWiz("import_complete") : tWiz("import_running")}
            </h1>
            <p className="wizard-subtitle" style={{ marginBottom: 24 }}>
              {(() => {
                if (!done) {
                  return tStep4("subtitle_background");
                }
                const successCount = scrapeList.filter(
                  (item) => item.status === "success"
                ).length;
                const queuedCount = scrapeList.filter(
                  (item) => item.status === "queued"
                ).length;
                const base = tStep4("subtitle_done_base", {
                  success: successCount,
                  total: scrapeList.length,
                });
                if (queuedCount > 0) {
                  return (
                    base +
                    tStep4("subtitle_done_queued", { count: queuedCount })
                  );
                }
                return base;
              })()}
            </p>

            {(() => {
              void scrapeRateTick;
              const total = scrapeList.length;
              const successCount = scrapeList.filter(
                (item) => item.status === "success"
              ).length;
              const errorCount = scrapeList.filter(
                (item) => item.status === "error"
              ).length;
              const queuedCount = scrapeList.filter(
                (item) => item.status === "queued" || item.status === "pending"
              ).length;
              const completedCount = successCount + errorCount;
              const drainState = importQueue.drainState;
              const attemptedCount = drainState
                ? Math.min(
                    total,
                    Math.max(completedCount, drainState.processed)
                  )
                : completedCount;
              const drainPausedUntil = drainState?.pausedUntil ?? null;
              const drainPaused = Boolean(
                drainPausedUntil && drainPausedUntil > Date.now()
              );
              const drainPausedSec = drainPausedUntil
                ? Math.max(1, Math.ceil((drainPausedUntil - Date.now()) / 1000))
                : 0;
              const progressPct =
                total > 0
                  ? Math.max(4, Math.round((attemptedCount / total) * 100))
                  : 0;
              return (
                <div
                  aria-live="polite"
                  className="onboard-import-status-card"
                  role="status"
                >
                  <div className="onboard-import-status-topline">
                    <div>
                      <div className="onboard-import-status-title">
                        {done
                          ? tStep4("status_done", {
                              done: completedCount,
                              total,
                            })
                          : tStep4("status_running", {
                              done: attemptedCount,
                              total,
                            })}
                      </div>
                      <div className="onboard-import-status-sub">
                        {drainPaused
                          ? tStep4("rate_limit_sub", { sec: drainPausedSec })
                          : queuedCount > 0
                            ? tStep4("status_background_hint", {
                                count: queuedCount,
                              })
                            : errorCount > 0
                              ? tStep4("status_done_with_errors", {
                                  count: errorCount,
                                })
                              : tStep4("status_done_clean")}
                      </div>
                    </div>
                    {!done && <span aria-hidden className="spinner-sm" />}
                  </div>
                  <div aria-hidden className="onboard-import-progress">
                    <div
                      className="onboard-import-progress-fill"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <div className="onboard-import-status-meta">
                    <span>
                      {tStep4("status_imported", { count: successCount })}
                    </span>
                    <span>
                      {tStep4("status_waiting", { count: queuedCount })}
                    </span>
                    {errorCount > 0 && (
                      <span>
                        {tStep4("status_attention", { count: errorCount })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}

            {onboardImportRateLimitHandoffOn &&
              scrapeRateLimit &&
              (() => {
                // Touch `scrapeRateTick` so the seconds value re-renders every
                // second while we wait out Apple's cooldown.
                void scrapeRateTick;
                const remainingMs = Math.max(
                  0,
                  scrapeRateLimit.resumeAt - Date.now()
                );
                const remainingSec = Math.ceil(remainingMs / 1000);
                return (
                  <div
                    aria-live="polite"
                    className="wizard-rate-banner"
                    role="status"
                  >
                    <div aria-hidden className="wizard-rate-banner-icon">
                      ⏳
                    </div>
                    <div className="wizard-rate-banner-copy">
                      <div className="wizard-rate-banner-title">
                        {tStep4("rate_limit_title")}
                      </div>
                      <div className="wizard-rate-banner-sub">
                        {tStep4("rate_limit_sub", { sec: remainingSec })}
                      </div>
                    </div>
                    {onboardPostBackgroundWorkerOn && (
                      <button
                        aria-label={tStep4("rate_limit_handoff_aria")}
                        className="wizard-rate-banner-cancel"
                        onClick={() => {
                          scrapeCancelRef.current = true;
                        }}
                        type="button"
                      >
                        {tStep4("rate_limit_handoff")}
                      </button>
                    )}
                  </div>
                );
              })()}

            <details
              className="onboard-import-details"
              onToggle={(event) =>
                setImportDetailsOpen(event.currentTarget.open)
              }
              open={importDetailsOpen}
            >
              <summary>
                <span>
                  {tStep4("details_summary", { count: scrapeList.length })}
                </span>
                <span aria-hidden className="onboard-import-details-chevron">
                  ⌄
                </span>
              </summary>
              {scrapeList.length > 10 && !done && (
                <div className="scrape-jump-row">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      const el = scrapeListEndRef.current;
                      if (!el) {
                        return;
                      }
                      try {
                        el.scrollIntoView({ block: "end", behavior: "smooth" });
                      } catch {
                        el.scrollIntoView();
                      }
                    }}
                    type="button"
                  >
                    {tStep4("scroll_to_bottom")}
                  </button>
                </div>
              )}
              <div className="scrape-list-wrap">
                <div className="scrape-list">
                  {scrapeList.map((item, index) => (
                    <div
                      className={`scrape-row ${item.status === "error" ? "error" : ""} ${item.status === "queued" ? "queued" : ""}`}
                      key={`${item.url}-${index}`}
                      ref={
                        item.status === "scraping"
                          ? scrapeActiveRowRef
                          : undefined
                      }
                    >
                      <div className="scrape-status-icon">
                        {item.status === "pending" && (
                          <span style={{ color: "var(--text-3)" }}>○</span>
                        )}
                        {item.status === "scraping" && (
                          <span className="spinner-sm" />
                        )}
                        {item.status === "success" && (
                          <span style={{ color: "var(--green)" }}>✓</span>
                        )}
                        {item.status === "error" && (
                          <span
                            aria-label={tStep4("row_failed_aria")}
                            style={{ color: "var(--red)" }}
                          >
                            !
                          </span>
                        )}
                        {item.status === "queued" && (
                          <span
                            aria-label={tStep4("row_queued_aria")}
                            style={{ color: "var(--orange)" }}
                          >
                            ⏱
                          </span>
                        )}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="scrape-name">{item.name}</div>
                        {item.status === "error" && item.error && (
                          <div
                            className="scrape-sub"
                            style={{ color: "var(--red)" }}
                          >
                            {item.error}
                          </div>
                        )}
                        {item.status === "queued" && (
                          <div
                            className="scrape-sub"
                            style={{ color: "var(--orange)" }}
                          >
                            {item.error ?? tStep4("row_queued_default")}
                            {/*
                              `row_queued_retry_in` (a "Next retry in NNNs"
                              countdown) used to render here, derived from
                              the row's next_attempt_at. It was misleading:
                              once the server worker claims a row it pushes
                              next_attempt_at out by 10 minutes as an
                              in-flight fence (lib/imports.ts ::
                              claimQueuedBatch), so the user saw a 600s
                              countdown for a row that was actually about
                              to finish scraping in seconds. We drop the
                              timer entirely — the static "Queued / retrying"
                              copy is the truthful signal.
                            */}
                          </div>
                        )}
                        {item.status === "success" && item.changesDetected && (
                          <div
                            className="scrape-sub"
                            style={{ color: "var(--orange)" }}
                          >
                            {tStep4("row_changes_detected")}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div aria-hidden ref={scrapeListEndRef} />
              </div>
            </details>

            {(done || scrapeList.length > 0) && (
              <div className="wizard-footer-actions" style={{ marginTop: 28 }}>
                <button
                  className="btn btn-secondary btn-lg"
                  onClick={() => router.push("/dashboard")}
                  type="button"
                >
                  {tStep4("skip_dashboard")}
                </button>
                {!done && (
                  <button
                    className="btn btn-secondary btn-lg"
                    onClick={() =>
                      router.push("/dashboard/settings/import-history")
                    }
                    type="button"
                  >
                    {tStep4("view_history")}
                  </button>
                )}
                <button
                  className="btn btn-primary btn-lg"
                  data-testid="onboard-next-ai"
                  disabled={
                    scrapeList.filter((item) => item.status === "success")
                      .length === 0
                  }
                  onClick={() => setStep(5)}
                  style={{ flex: 1 }}
                  type="button"
                >
                  {tStep4("next_ai")}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {(restoreStage === "confirm" || restoreStage === "applying") &&
        restorePreview && (
          <RestoreBackupModal
            handleRestoreConfirm={handleRestoreConfirm}
            pendingRestoreFilename={pendingRestoreFilename}
            resetRestoreFlow={resetRestoreFlow}
            restoreConfirmText={restoreConfirmText}
            restoreError={restoreError}
            restoreModalCardRef={restoreModalCardRef}
            restorePreview={restorePreview}
            restoreStage={restoreStage}
            setRestoreConfirmText={setRestoreConfirmText}
            setRestoreError={setRestoreError}
          />
        )}

      <CancelSummariesModal
        cancelModalCardRef={cancelModalCardRef}
        cancelModalOpen={cancelModalOpen}
        requestStop={requestStop}
        setCancelModalOpen={setCancelModalOpen}
      />

      {/* Rate-limit pause modal. Opened by the scrape loop on the first
          Apple 429. Gives the user two concrete next steps so they don't
          just sit watching a frozen progress list:
            • "View Import History" — opens Settings → Import History so
              they can watch the background queue worker drain the rest.
            • "Summarise privacy policies" — advances the wizard to step 5
              (AI summaries) for whatever apps imported cleanly before the
              rate-limit hit. Hidden when nothing imported successfully,
              since there'd be nothing to summarise. */}
      <RateLimitPauseModal
        rateLimitModalCardRef={rateLimitModalCardRef}
        rateLimitPauseModal={rateLimitPauseModal}
        router={router}
        setRateLimitPauseModal={setRateLimitPauseModal}
        setStep={setStep}
      />

      <LiveTextModal
        onClose={() => setLiveTextModalOpen(false)}
        open={liveTextModalOpen}
      />

      {/* Re-sync diff overlay — only mounts when the wizard was opened
       *  with `?resync=<deviceId>` and the import has finished. The
       *  overlay drives /api/device-sync/preview + /api/device-sync/commit
       *  on top of the apps the import just resolved. */}
      {resyncDeviceId && (
        <DeviceSyncDiffOverlay
          currentImport={resyncOverlayApps}
          deviceId={resyncDeviceId}
          onClose={() => setResyncOverlayOpen(false)}
          onCommit={(result) => {
            setResyncOverlayOpen(false);
            // Bounce the user to the Devices page with a flash toast so
            // they see "Re-sync: 2 added, 3 removed." It's the natural
            // place to land — they came from there. `merged` counts
            // legacy duplicate rows collapsed during the commit (see
            // DiffBundleIdMerge in lib/device-sync.ts).
            const params = new URLSearchParams();
            params.set("resync_added", String(result.added));
            params.set("resync_removed", String(result.removed));
            params.set("resync_orphaned", String(result.orphanedAndDeleted));
            if (result.merged > 0) {
              params.set("resync_merged", String(result.merged));
            }
            router.push(`/dashboard/settings/devices?${params.toString()}`);
          }}
          open={resyncOverlayOpen}
        />
      )}
    </div>
  );
}

// --- PolicyRunPanel ---------------------------------------------------------
//
// Full-width progress panel shown on step 5 once a policy run kicks off.
// Replaces the config form so the user can't accidentally edit settings mid-run.

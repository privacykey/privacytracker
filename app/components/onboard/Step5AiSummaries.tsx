"use client";

/**
 * Step 5 — configure AI policy summaries, then watch the run.
 *
 * Rendered as three sibling blocks rather than one: the provider form,
 * the run panel that replaces it once a run starts, and the completion
 * state. Keeping them separate is what lets the run panel take over the
 * step without the config form staying mounted underneath, where a
 * mid-run edit could change the settings the run is using.
 */

import {
  AI_PROVIDER_OPTIONS as ONBOARD_AI_OPTIONS,
  providerRequiresApiKey,
  providerSupportsApiKey,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
} from "@/lib/ai-config";
import type { OnboardWizardState } from "@/lib/use-onboard-wizard";
import PolicyRunPanel from "./PolicyRunPanel";

export default function Step5AiSummaries({
  w,
}: {
  /** The whole `useOnboardWizard` return value — see ./README.md on
   *  why the steps take one object rather than their bindings. */
  w: OnboardWizardState;
}) {
  const {
    activePhase,
    aiApiKey,
    aiBaseUrl,
    aiError,
    aiModel,
    aiProvider,
    aiSettingsComplete,
    aiTestLatency,
    aiTestMessage,
    aiTestStatus,
    etaTick,
    onProviderChange,
    onboardPostDashboardSkipOn,
    onboardStepAiSummariesOn,
    phaseAvgMs,
    policyProgress,
    policyRunDone,
    providerOptions,
    router,
    runPolicyRegeneration,
    savingAi,
    scrapeList,
    selectedModelPreset,
    setAiApiKey,
    setAiBaseUrl,
    setAiModel,
    setCancelModalOpen,
    settingsLoaded,
    step,
    storedAi,
    tAiOptions,
    tAiStep,
    tOnboard,
    tWiz,
    testAiConnection,
    wizardRadioKeyDown,
  } = w;

  return (
    <>
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

                <div className="settings-field-grid" style={{ marginTop: 16 }}>
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
                    disabled={aiTestStatus === "testing" || !aiSettingsComplete}
                    onClick={() => void testAiConnection()}
                    type="button"
                  >
                    <span className={`ai-test-dot ai-test-dot-${aiTestStatus}`}>
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

      {step === 5 && onboardStepAiSummariesOn && policyProgress.length > 0 && (
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
    </>
  );
}

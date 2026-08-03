"use client";

/**
 * AI Policy Summaries — pick a provider, point it at an endpoint, test the
 * connection, and optionally dry-run a real policy through it before
 * trusting it with the whole library.
 *
 * The card is deliberately opt-in: the provider starts at `disabled`, and a
 * stored `disabled` is honoured on load. Nothing here talks to a model
 * until a user configures one.
 *
 * All of its state lives in `useAiSettings`, which SettingsView calls and
 * passes down whole as `ai`. The hook cannot be called here — Developer
 * Options needs the same blob for its debug-logging toggle, and the
 * timeouts panel reads `aiProvider` — and two call sites would mean two
 * independent copies of the state. One object prop beats thirty-five.
 *
 * The two sub-flags are resolved here rather than passed down: they decide
 * what is *inside* this card, while SettingsView keeps the section-level
 * `flag.settings.ai.enabled` gate. See ./README.md.
 *
 * Anchor id `ai-summaries` is a cross-page contract — /privacy-policy
 * deep-links to it, and SettingsView pulses it on that hash.
 */

import { useTranslations } from "next-intl";
import {
  AI_PROVIDER_OPTIONS,
  type AIProvider,
  providerRequiresApiKey,
  providerSupportsApiKey,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
} from "@/lib/ai-config";
import { useFlag } from "@/lib/feature-flags-hooks";
import type { PolicyLensKey, PolicyRating } from "@/lib/policy-summary-meta";
import type { useAiSettings } from "@/lib/use-ai-settings";
import { fmtDuration } from "./format";

export default function AiSummariesSection({
  ai,
}: {
  /** The whole `useAiSettings` return value — see the note above on why
   *  this is one prop rather than thirty-five. */
  ai: ReturnType<typeof useAiSettings>;
}) {
  const settingsAiProviderSelectorOn =
    useFlag("flag.settings.ai.provider_selector") === "on";
  const settingsAiSummarizeOnImportOn =
    useFlag("flag.settings.ai.summarize_on_import") === "on";

  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tAi = useTranslations("settings.ai");
  const tAiProvider = useTranslations("settings.ai.provider");
  const tAiConn = useTranslations("settings.ai.connection");
  const tAiModel = useTranslations("settings.ai.model");
  const tAiSample = useTranslations("settings.ai.sample");
  const tAiBehavior = useTranslations("settings.ai.behavior");
  const tAiFooter = useTranslations("settings.ai.footer");
  const tOllamaHelp = useTranslations("settings.ai.ollama_help");
  const tAiOptions = useTranslations("ai_options");
  const tLens = useTranslations("policy_lens");
  const tRating = useTranslations("policy_rating");
  const tPh = useTranslations("settings.placeholders");

  const {
    aiApiKey,
    aiBaseUrl,
    aiConfigChanged,
    aiModel,
    aiProvider,
    aiSampleMessage,
    aiSampleResult,
    aiSampleStatus,
    aiSettingsAutoSave,
    aiTestLatency,
    aiTestMessage,
    aiTestStatus,
    canDiscoverModels,
    canRunSamplePolicyTest,
    customApiKeyEnabled,
    customModelInputRef,
    discoveredModels,
    focusCustomModelOnNextRender,
    mergedModelValues,
    modelsError,
    modelsStatus,
    onProviderChange,
    providerOptions,
    refreshDiscoveredModels,
    runAiSampleSummaryTest,
    saveAiSettings,
    selectedModelPreset,
    setAiApiKey,
    setAiBaseUrl,
    setAiModel,
    setCustomApiKeyEnabled,
    setSummarizeOnImport,
    storedAi,
    summarizeOnImport,
    testAiConnection,
  } = ai;

  return (
    <div className="settings-section ai-settings-section" id="ai-summaries">
      <div className="settings-section-heading">
        <div>
          <h2 className="settings-section-title">
            {tSections("ai_summaries")}
          </h2>
          <p className="settings-section-subtitle" style={{ marginBottom: 0 }}>
            {tSub("ai_summaries")}
          </p>
        </div>
        <span
          className={`ai-status-pill ai-status-pill-${aiProvider === "disabled" ? "off" : "on"}`}
        >
          <span className="ai-status-dot" />
          {aiProvider === "disabled"
            ? tAi("status_off")
            : tAi("status_using", {
                provider: (() => {
                  const opt = AI_PROVIDER_OPTIONS.find(
                    (o) => o.value === aiProvider
                  );
                  if (!opt) {
                    return aiProvider;
                  }
                  return opt.labelKey ? tAiOptions(opt.labelKey) : opt.label;
                })(),
              })}
        </span>
      </div>

      {/* 1. Provider */}
      {settingsAiProviderSelectorOn && (
        <section className="settings-subsection">
          <header className="settings-subsection-header">
            <h3 className="settings-subsection-title">
              {tAiProvider("title")}
            </h3>
            <p className="settings-subsection-desc">{tAiProvider("desc")}</p>
          </header>

          <label className="settings-field">
            <span className="settings-field-label">
              {tAiProvider("backend_label")}
            </span>
            <select
              className="settings-input settings-select"
              onChange={(event) =>
                onProviderChange(event.target.value as AIProvider)
              }
              value={aiProvider}
            >
              {AI_PROVIDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.labelKey ? tAiOptions(option.labelKey) : option.label}
                </option>
              ))}
            </select>
            <span className="settings-field-help">
              {(() => {
                const opt = AI_PROVIDER_OPTIONS.find(
                  (o) => o.value === aiProvider
                );
                return opt ? tAiOptions(opt.descKey) : "";
              })()}
            </span>
          </label>

          {/* Ollama bootstrapping help, stashed behind a disclosure so it
              doesn't clutter the section for users who already know what
              they're doing. Only shown when the user has picked (or is on
              their way to picking) the "Own Model" backend — hosted providers
              like OpenAI and Anthropic don't need this guidance. */}
          {aiProvider === "custom" && (
            <details className="settings-help-card settings-help-details">
              <summary className="settings-help-summary">
                <span className="settings-help-title">
                  {tOllamaHelp("summary_title")}
                </span>
                <span className="settings-help-copy" style={{ marginLeft: 6 }}>
                  {tOllamaHelp("summary_copy")}
                </span>
              </summary>
              <div style={{ marginTop: 10 }}>
                <p className="settings-help-copy">
                  {tOllamaHelp.rich("intro", {
                    own: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
                <pre className="settings-code-block">
                  {`${tOllamaHelp("install_comment_1")}
${tOllamaHelp("install_comment_2")}
ollama pull gemma3n:e4b

${tOllamaHelp("install_comment_3")}
ollama serve`}
                </pre>
                <p className="settings-help-copy">
                  <strong>{tOllamaHelp("long_policies_lead")}</strong>
                  {tOllamaHelp("long_policies_body")}
                </p>
                <pre className="settings-code-block">
                  {"OLLAMA_CONTEXT_LENGTH=131072 ollama serve"}
                </pre>
                {/* System-spec guidance for the context windows we suggest. KV
                    cache grows roughly linearly with context, so memory is the
                    first thing to hit on consumer hardware. Numbers below are
                    safe ballparks for a ~7–8 B quantised model (Q4_K_M). */}
                <div className="settings-help-subnote">
                  <strong>{tOllamaHelp("memory_guide_lead")}</strong>
                  {tOllamaHelp("memory_guide_body")}
                  <ul className="settings-help-bullets">
                    <li>
                      {tOllamaHelp.rich("memory_32k", {
                        c: (chunks) => <code>{chunks}</code>,
                        s: (chunks) => <strong>{chunks}</strong>,
                      })}
                    </li>
                    <li>
                      {tOllamaHelp.rich("memory_128k", {
                        c: (chunks) => <code>{chunks}</code>,
                        s: (chunks) => <strong>{chunks}</strong>,
                      })}
                    </li>
                  </ul>
                  <span className="settings-help-copy">
                    {tOllamaHelp("memory_followup")}
                  </span>
                </div>
                <p className="settings-help-copy" style={{ marginBottom: 0 }}>
                  {tOllamaHelp.rich("verify", {
                    em: (chunks) => <em>{chunks}</em>,
                  })}
                </p>
              </div>
            </details>
          )}
        </section>
      )}

      {/* 2. Connection */}
      {aiProvider !== "disabled" && (
        <section className="settings-subsection">
          <header className="settings-subsection-header">
            <h3 className="settings-subsection-title">{tAiConn("title")}</h3>
            <p className="settings-subsection-desc">
              {providerSupportsApiKey(aiProvider)
                ? tAiConn("desc_with_key")
                : tAiConn("desc_base")}
              .
            </p>
          </header>

          <label className="settings-field">
            <span className="settings-field-label">
              {tAiConn("base_url_label")}
            </span>
            <input
              className="settings-input"
              // Auto-save on blur — we don't want to fire a POST per
              // keystroke while the user is typing the URL.
              onBlur={() => saveAiSettings({ baseUrl: aiBaseUrl })}
              onChange={(event) => setAiBaseUrl(event.target.value)}
              placeholder={resolveDefaultBaseUrl(aiProvider)}
              spellCheck={false}
              type="text"
              value={aiBaseUrl}
            />
            <span className="settings-field-help">
              {aiProvider === "anthropic"
                ? tAiConn("base_url_help_anthropic")
                : aiProvider === "custom"
                  ? tAiConn("base_url_help_custom")
                  : tAiConn("base_url_help_default")}
            </span>
          </label>

          {/* API-key disclosure, split by provider kind:
                • Hosted providers (OpenAI, Anthropic) always show the input — a
                  key is required, so hiding it behind a toggle is only friction.
                • Custom provider hides the input behind a checkbox because
                  Ollama / llama.cpp / LM Studio don't use a key. Toggling the
                  checkbox off clears whatever key was in state so the next save
                  persists an empty key. */}
          {aiProvider !== "custom" && providerSupportsApiKey(aiProvider) && (
            <label className="settings-field">
              <span className="settings-field-label">
                {tAiConn("api_key_label")}
                {providerRequiresApiKey(aiProvider) && (
                  <span className="settings-field-required">
                    {tAiConn("api_key_required")}
                  </span>
                )}
              </span>
              <input
                autoComplete="off"
                className="settings-input"
                // Auto-save on blur — never per-keystroke for an
                // API key (would 401 the route over and over while
                // the user pastes the value in).
                onBlur={() => saveAiSettings({ apiKey: aiApiKey })}
                onChange={(event) => setAiApiKey(event.target.value)}
                // i18n-exempt — literal API-key prefix formats ("sk-ant-...", "sk-..."), locale-neutral
                placeholder={
                  aiProvider === "anthropic" ? "sk-ant-..." : "sk-..."
                }
                spellCheck={false}
                type="password"
                value={aiApiKey}
              />
              <span className="settings-field-help">
                {tAiConn("api_key_help")}
              </span>
            </label>
          )}

          {aiProvider === "custom" && (
            <div className="settings-field">
              <label className="settings-checkbox-row">
                <input
                  checked={customApiKeyEnabled}
                  className="settings-checkbox"
                  onChange={(event) => {
                    const next = event.target.checked;
                    setCustomApiKeyEnabled(next);
                    if (!next) {
                      // Toggling off explicitly clears the key so save
                      // persists an empty key — WYSIWYG with the field
                      // being hidden. Save the cleared key immediately.
                      setAiApiKey("");
                      saveAiSettings({ apiKey: "" });
                    }
                  }}
                  type="checkbox"
                />
                <span>
                  {tAiConn("custom_key_label")}
                  <span
                    className="settings-field-help"
                    style={{ display: "block", marginTop: 4 }}
                  >
                    {tAiConn("custom_key_help")}
                  </span>
                </span>
              </label>

              {customApiKeyEnabled && (
                <label className="settings-field" style={{ marginTop: 10 }}>
                  <span className="settings-field-label">
                    {tAiConn("api_key_label")}
                  </span>
                  <input
                    autoComplete="off"
                    className="settings-input"
                    onBlur={() => saveAiSettings({ apiKey: aiApiKey })}
                    onChange={(event) => setAiApiKey(event.target.value)}
                    placeholder={tPh("api_key")}
                    spellCheck={false}
                    type="password"
                    value={aiApiKey}
                  />
                  <span className="settings-field-help">
                    {tAiConn("api_key_help")}
                  </span>
                </label>
              )}
            </div>
          )}

          <div className="ai-test-row">
            <button
              className="btn btn-secondary ai-test-button"
              disabled={
                aiTestStatus === "testing" ||
                !aiBaseUrl.trim() ||
                (providerRequiresApiKey(aiProvider) && !aiApiKey.trim())
              }
              onClick={() => void testAiConnection()}
              type="button"
            >
              <span className={`ai-test-dot ai-test-dot-${aiTestStatus}`}>
                {aiTestStatus === "testing" ? (
                  <span className="spinner-sm" />
                ) : null}
              </span>
              {aiTestStatus === "testing"
                ? tAiConn("test_busy")
                : aiTestStatus === "ok" || aiTestStatus === "fail"
                  ? tAiConn("test_retry")
                  : tAiConn("test_idle")}
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
                    ? tAiConn("test_reachable_fallback")
                    : "")}
                {aiTestLatency !== null && (
                  <span className="ai-test-latency">
                    {tAiConn("test_latency", { ms: aiTestLatency })}
                  </span>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 3. Model */}
      {aiProvider !== "disabled" && (
        <section className="settings-subsection">
          <header className="settings-subsection-header">
            <h3 className="settings-subsection-title">{tAiModel("title")}</h3>
            <p className="settings-subsection-desc">
              {aiProvider === "custom"
                ? tAiModel("desc_custom")
                : tAiModel("desc_default")}
            </p>
          </header>

          <label className="settings-field">
            <div className="settings-field-label-row">
              <span className="settings-field-label">{tAiModel("label")}</span>
              <button
                className="settings-field-refresh"
                disabled={modelsStatus === "loading" || !canDiscoverModels}
                onClick={() => void refreshDiscoveredModels()}
                title={tAiModel("refresh_title")}
                type="button"
              >
                {modelsStatus === "loading" ? (
                  <>
                    <span className="spinner-sm" /> {tAiModel("refresh_busy")}
                  </>
                ) : (
                  tAiModel("refresh")
                )}
              </button>
            </div>
            <select
              className="settings-input settings-select"
              onChange={(event) => {
                const next = event.target.value;
                if (next === "__custom__") {
                  // Reveal the input; clear the value if it was matching a
                  // preset so the user starts with a blank slate. Don't
                  // auto-save yet — wait for the user to type a value
                  // and blur out of the custom-model input.
                  if (mergedModelValues.has(aiModel)) {
                    setAiModel("");
                  }
                  // Mark that the user (not the initial render) asked for
                  // the custom input, so the effect below can focus it.
                  focusCustomModelOnNextRender.current = true;
                } else {
                  // Discrete preset selection → save immediately so the
                  // user gets the green pill and the AI calls start
                  // hitting the new model right away.
                  setAiModel(next);
                  saveAiSettings({ model: next });
                }
              }}
              value={selectedModelPreset}
            >
              {discoveredModels.length > 0 && (
                <optgroup
                  label={tAiModel("available_optgroup", {
                    count: discoveredModels.length,
                  })}
                >
                  {discoveredModels.map((option) => (
                    <option key={`d:${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              )}

              {aiProvider !== "custom" &&
                providerOptions
                  .filter(
                    (option) =>
                      !discoveredModels.some(
                        (discovered) => discovered.value === option.value
                      )
                  )
                  .map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}

              <option value="__custom__">{tAiModel("custom_option")}</option>
            </select>

            {modelsStatus === "error" && (
              <span className="settings-field-help settings-field-help-warn">
                {tAiModel("error_lead")}{" "}
                {modelsError || tAiModel("error_fallback")}{" "}
                {tAiModel("error_after")}
              </span>
            )}
            {modelsStatus === "ok" && discoveredModels.length > 0 && (
              <span className="settings-field-help">
                {tAiModel("found_count", {
                  count: discoveredModels.length,
                })}
                {selectedModelPreset === "__custom__"
                  ? tAiModel("found_custom_extra")
                  : ""}
              </span>
            )}
            {aiProvider === "custom" &&
              modelsStatus === "ok" &&
              discoveredModels.length === 0 && (
                <span className="settings-field-help settings-field-help-warn">
                  {tAiModel.rich("no_models", {
                    code: () => (
                      <code>ollama pull {resolveDefaultModel("custom")}</code>
                    ),
                  })}
                </span>
              )}
            {(modelsStatus === "idle" || modelsStatus === "loading") && (
              <span className="settings-field-help">
                {selectedModelPreset === "__custom__"
                  ? tAiModel("help_custom_input")
                  : (() => {
                      const opt = providerOptions.find(
                        (option) => option.value === aiModel
                      );
                      if (opt) {
                        return tAiOptions(opt.descKey);
                      }
                      return aiProvider === "custom" &&
                        modelsStatus === "loading"
                        ? tAiModel("help_scanning")
                        : tAiModel("help_pick");
                    })()}
              </span>
            )}
          </label>

          {selectedModelPreset === "__custom__" && (
            <label className="settings-field">
              <span className="settings-field-label">
                {tAiModel("custom_id_label")}
              </span>
              <input
                className="settings-input"
                // Auto-save on blur — typed model IDs can be long
                // (`mistral:7b-instruct-v0.2-q4_K_M`); save once when
                // the user finishes, not per-character.
                onBlur={() => saveAiSettings({ model: aiModel })}
                onChange={(event) => setAiModel(event.target.value)}
                placeholder={resolveDefaultModel(aiProvider)}
                ref={customModelInputRef}
                spellCheck={false}
                type="text"
                value={aiModel}
              />
              <span className="settings-field-help">
                {tAiModel("custom_id_help")}
              </span>
            </label>
          )}
        </section>
      )}

      {/* 4. Sample policy test */}
      {aiProvider !== "disabled" && (
        <section className="settings-subsection ai-sample-section">
          <header className="settings-subsection-header">
            <h3 className="settings-subsection-title">{tAiSample("title")}</h3>
            <p className="settings-subsection-desc">{tAiSample("desc")}</p>
          </header>

          <div
            aria-label={tAiSample("frame_aria")}
            className="ai-sample-framing"
          >
            <div>
              <span className="ai-sample-frame-label">
                {tAiSample("policy_label")}
              </span>
              <p>{tAiSample("policy_body")}</p>
            </div>
            <div>
              <span className="ai-sample-frame-label">
                {tAiSample("judging_label")}
              </span>
              <p>{tAiSample("judging_body")}</p>
            </div>
            <div>
              <span className="ai-sample-frame-label">
                {tAiSample("look_for_label")}
              </span>
              <p>{tAiSample("look_for_body")}</p>
            </div>
          </div>

          <div className="ai-test-row">
            <button
              className="btn btn-secondary ai-test-button"
              disabled={!canRunSamplePolicyTest || aiSampleStatus === "testing"}
              onClick={() => void runAiSampleSummaryTest()}
              type="button"
            >
              <span className={`ai-test-dot ai-test-dot-${aiSampleStatus}`}>
                {aiSampleStatus === "testing" ? (
                  <span className="spinner-sm" />
                ) : null}
              </span>
              {aiSampleStatus === "testing"
                ? tAiSample("run_busy")
                : aiSampleStatus === "ok" || aiSampleStatus === "fail"
                  ? tAiSample("run_retry")
                  : tAiSample("run_idle")}
            </button>
            {(aiSampleMessage || !canRunSamplePolicyTest) && (
              <div
                className={`ai-test-message ai-test-message-${aiSampleStatus}`}
              >
                {aiSampleStatus === "ok"
                  ? "✓ "
                  : aiSampleStatus === "fail"
                    ? "⚠ "
                    : ""}
                {aiSampleMessage || tAiSample("disabled_help")}
              </div>
            )}
          </div>

          {aiSampleResult ? (
            <div className="ai-sample-result">
              <div className="ai-sample-result-header">
                <div>
                  <div className="ai-sample-kicker">
                    {tAiSample("result_kicker")}
                  </div>
                  <h4 className="ai-sample-title">
                    {aiSampleResult.sample.appName}
                  </h4>
                  <p className="ai-sample-scenario">
                    {aiSampleResult.sample.scenario}
                  </p>
                </div>
                <div className="ai-sample-meta">
                  {tAiSample("meta", {
                    model: aiSampleResult.model,
                    duration: fmtDuration(aiSampleResult.durationMs),
                    words: aiSampleResult.sample.wordCount,
                  })}
                </div>
              </div>

              <div className="ai-sample-review-note">
                <span>{tAiSample("review_note_label")}</span>
                <ul>
                  {aiSampleResult.sample.reviewChecklist.map((item, index) => (
                    <li key={`${index}:${item}`}>{item}</li>
                  ))}
                </ul>
              </div>

              <h5 className="ai-sample-output-heading">
                {tAiSample("overview_title")}
              </h5>
              <p className="ai-sample-overview">
                {aiSampleResult.summary.overview}
              </p>

              <div className="ai-sample-columns">
                <div className="ai-sample-panel">
                  <h5>{tAiSample("highlights_title")}</h5>
                  <ul>
                    {aiSampleResult.summary.highlights.map(
                      (highlight, index) => (
                        <li key={`${index}:${highlight}`}>{highlight}</li>
                      )
                    )}
                  </ul>
                </div>
                <div className="ai-sample-panel">
                  <h5>{tAiSample("expected_title")}</h5>
                  <ul>
                    {aiSampleResult.sample.expectedSignals.map(
                      (signal, index) => (
                        <li key={`${index}:${signal}`}>{signal}</li>
                      )
                    )}
                  </ul>
                </div>
              </div>

              <h5 className="ai-sample-output-heading">
                {tAiSample("lenses_title")}
              </h5>
              <p className="ai-sample-lenses-help">
                {tAiSample("lenses_help")}
              </p>
              <div className="ai-sample-lens-grid">
                {aiSampleResult.summary.lenses.map((entry) => (
                  <div
                    className={`ai-sample-lens-row ai-sample-lens-row-${entry.rating}`}
                    key={entry.key}
                  >
                    <div className="ai-sample-lens-top">
                      <span>{tLens(entry.key as PolicyLensKey)}</span>
                      <span
                        className={`policy-rating-badge policy-rating-${entry.rating as PolicyRating}`}
                      >
                        {tRating(entry.rating as PolicyRating)}
                      </span>
                    </div>
                    <p>{entry.summary}</p>
                  </div>
                ))}
              </div>

              <details className="ai-sample-policy">
                <summary>{tAiSample("policy_summary")}</summary>
                <pre>{aiSampleResult.sample.policyText}</pre>
              </details>
            </div>
          ) : (
            <p className="settings-field-help ai-sample-empty">
              {tAiSample("empty_help")}
            </p>
          )}
        </section>
      )}

      {/* 5. Behavior */}
      <section className="settings-subsection">
        <header className="settings-subsection-header">
          <h3 className="settings-subsection-title">
            {aiProvider === "disabled"
              ? tAiBehavior("title_disabled")
              : tAiBehavior("title_full")}
          </h3>
          <p className="settings-subsection-desc">{tAiBehavior("desc")}</p>
        </header>

        {settingsAiSummarizeOnImportOn && (
          <label className="settings-checkbox-row">
            <input
              checked={summarizeOnImport}
              className="settings-checkbox"
              disabled={aiProvider === "disabled" || aiSettingsAutoSave.saving}
              onChange={(event) => {
                const next = event.target.checked;
                setSummarizeOnImport(next);
                saveAiSettings({ summarizeOnImport: next });
              }}
              type="checkbox"
            />
            <span>
              {tAiBehavior("summarize_on_import_label")}
              <span
                className="settings-field-help"
                style={{ display: "block", marginTop: 4 }}
              >
                {aiProvider === "disabled"
                  ? tAiBehavior("summarize_on_import_help_disabled")
                  : tAiBehavior("summarize_on_import_help_active")}
              </span>
            </span>
          </label>
        )}

        {/* AI request timeouts used to live here, but they're only useful
              when you've hit a timeout and need to tune the merge budget.
              They've been moved under Developer Options → "Advanced"
              accordion below. The bell notification still deep-links via
              #ai-timeouts and the accordion auto-opens when it sees that
              hash on mount. */}
      </section>

      {/* Save button removed — every field in this card auto-saves
            via `saveAiSettings({ ... })` from its own onChange / onBlur.
            The bottom-center toast is the success / failure indicator;
            we keep the "saved" / "unsaved" pill for users who scroll
            back through the form and want to confirm their state at a
            glance before the toast has had a chance to render. */}
      <footer className="settings-actions-footer">
        <div className="settings-actions-status">
          {storedAi && !aiConfigChanged ? (
            <span className="settings-actions-saved">{tAiFooter("saved")}</span>
          ) : aiConfigChanged ? (
            <span className="settings-actions-unsaved">
              {tAiFooter("unsaved")}
            </span>
          ) : null}
          {aiSettingsAutoSave.saving && (
            <span className="settings-actions-unsaved">
              <span className="spinner" /> {tAiFooter("saving")}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}

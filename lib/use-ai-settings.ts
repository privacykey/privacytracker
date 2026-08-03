"use client";

/**
 * The AI Summaries card's entire state machine: provider/base-URL/model/key
 * form state, the connection test, model discovery against a custom
 * endpoint, the sample-policy dry run, per-phase request timeouts, and the
 * debounced auto-save that writes the whole blob.
 *
 * This was ~480 lines spread across six regions of SettingsView. Almost all
 * of it is read by one card; the exceptions leak deliberately and are
 * returned rather than kept private:
 *
 *   - `aiProvider` — the timeouts panel disables its inputs when AI is off.
 *   - `saveAiSettings` + `debugLogging` — the AI debug-log toggle in
 *     Developer Options round-trips through this same settings blob.
 *   - the three `aiTimeout*` values and their auto-savers, which the
 *     timeouts panel owns visually but which are part of this blob.
 *
 * `hydrate()` is the entry point for the shared settings loader: it reads
 * every key at once, so it hands the AI slice over in one call rather than
 * this hook mounting its own duplicate fetch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AIProvider,
  getAiModelOptions,
  providerRequiresApiKey,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
} from "@/lib/ai-config";
import { useSettingsAutoSave } from "@/lib/use-settings-auto-save";
import { fmtDuration } from "@/app/components/settings/format";
import type { useTaskCenter } from "@/app/components/TaskCenter";
import { pushSettingsToast } from "@/app/components/SettingsAutoSaveToast";
import type {
  AiSamplePolicyResult,
  StoredAiSettings,
} from "@/app/components/settings/types";

type T = (key: string, values?: Record<string, string | number>) => string;

export function useAiSettings({
  showToast,
  tToast,
  tAiProvider,
  tAiSample,
  tDevAiTimeouts,
  taskCenter,
  loadSettings,
}: {
  showToast: (msg: string) => void;
  tToast: T;
  tAiProvider: T;
  tAiSample: T;
  tDevAiTimeouts: T;
  taskCenter: ReturnType<typeof useTaskCenter>;
  /** Re-pulls the canonical settings blob after a save that changes what
   *  the server reports back (e.g. the masked API key). */
  loadSettings: () => void;
}) {
  const [storedAi, setStoredAi] = useState<StoredAiSettings | null>(null);
  const [aiProvider, setAiProvider] = useState<AIProvider>("disabled");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiModel, setAiModel] = useState("");
  // Focus plumbing for the "Custom model ID" field. We don't want autoFocus
  // there, because if the user has a custom model saved the input renders on
  // page load and the browser scrolls it into view — which breaks deep-links
  // into other sections of the Settings page (e.g. #sync-schedule from the
  // Task Center). Instead we only focus when the user *actively* picks
  // "Custom model…" from the model dropdown.
  const customModelInputRef = useRef<HTMLInputElement>(null);
  const focusCustomModelOnNextRender = useRef(false);
  // UI-only toggle for the custom provider's API key input. Local LLM
  // endpoints (Ollama, llama.cpp) do not accept a key, so we hide the field
  // by default and only reveal it when the user checks "My endpoint
  // requires an API key". Hydrated from whether a key is currently stored.
  const [customApiKeyEnabled, setCustomApiKeyEnabled] = useState(false);
  const [summarizeOnImport, setSummarizeOnImport] = useState(false);
  const [debugLogging, setDebugLogging] = useState(false);
  // Per-phase AI timeouts. Strings so we can hold "" (= use default) mid-edit.
  const [aiTimeoutDirectMs, setAiTimeoutDirectMs] = useState("");
  const [aiTimeoutChunkMs, setAiTimeoutChunkMs] = useState("");
  const [aiTimeoutMergeMs, setAiTimeoutMergeMs] = useState("");

  // AI connection test
  type AiTestStatus = "idle" | "testing" | "ok" | "fail";
  const [aiTestStatus, setAiTestStatus] = useState<AiTestStatus>("idle");
  const [aiTestMessage, setAiTestMessage] = useState("");
  const [aiTestLatency, setAiTestLatency] = useState<number | null>(null);

  type AiSampleStatus = "idle" | "testing" | "ok" | "fail";
  const [aiSampleStatus, setAiSampleStatus] = useState<AiSampleStatus>("idle");
  const [aiSampleMessage, setAiSampleMessage] = useState("");
  const [aiSampleResult, setAiSampleResult] =
    useState<AiSamplePolicyResult | null>(null);

  // Discovered models for the "Own Model" (custom) provider — populated by
  // polling the endpoint's /models (OpenAI-compatible) or /api/tags (Ollama).
  type ModelsStatus = "idle" | "loading" | "ok" | "error";
  const [discoveredModels, setDiscoveredModels] = useState<
    { value: string; label: string }[]
  >([]);
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus>("idle");
  const [modelsError, setModelsError] = useState("");

  const aiTimeoutDirectAutoSave = useSettingsAutoSave<string>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ ai_timeout_direct_ms: value }),
    successMessage: (value) =>
      value === ""
        ? tDevAiTimeouts("toast_direct_reset")
        : tDevAiTimeouts("toast_direct_set", { value }),
    taskLabel: (value) =>
      tDevAiTimeouts("task_label_direct", {
        value: value || tDevAiTimeouts("task_label_default_value"),
      }),
  });
  const aiTimeoutChunkAutoSave = useSettingsAutoSave<string>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ ai_timeout_chunk_ms: value }),
    successMessage: (value) =>
      value === ""
        ? tDevAiTimeouts("toast_chunk_reset")
        : tDevAiTimeouts("toast_chunk_set", { value }),
    taskLabel: (value) =>
      tDevAiTimeouts("task_label_chunk", {
        value: value || tDevAiTimeouts("task_label_default_value"),
      }),
  });
  const aiTimeoutMergeAutoSave = useSettingsAutoSave<string>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ ai_timeout_merge_ms: value }),
    successMessage: (value) =>
      value === ""
        ? tDevAiTimeouts("toast_merge_reset")
        : tDevAiTimeouts("toast_merge_set", { value }),
    taskLabel: (value) =>
      tDevAiTimeouts("task_label_merge", {
        value: value || tDevAiTimeouts("task_label_default_value"),
      }),
  });

  // Reset the test indicator whenever the user edits any of the inputs the
  // test actually uses — provider, api key, base url.
  useEffect(() => {
    setAiTestStatus("idle");
    setAiTestMessage("");
    setAiTestLatency(null);
  }, [aiProvider, aiApiKey, aiBaseUrl]);

  useEffect(() => {
    setAiSampleStatus("idle");
    setAiSampleMessage("");
    setAiSampleResult(null);
  }, [aiProvider, aiApiKey, aiBaseUrl, aiModel]);

  const testAiConnection = async () => {
    setAiTestStatus("testing");
    setAiTestMessage("");
    setAiTestLatency(null);
    try {
      const res = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: aiProvider,
          apiKey: aiApiKey,
          baseUrl: aiProvider === "disabled" ? "" : aiBaseUrl,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        latencyMs?: number;
      };
      setAiTestStatus(data.ok ? "ok" : "fail");
      setAiTestMessage(typeof data.message === "string" ? data.message : "");
      setAiTestLatency(
        typeof data.latencyMs === "number" ? data.latencyMs : null
      );
    } catch (error) {
      console.error("[settings] AI connection test failed:", error);
      setAiTestStatus("fail");
      setAiTestMessage(error instanceof Error ? error.message : String(error));
      setAiTestLatency(null);
    }
  };

  const canDiscoverModels =
    aiProvider !== "disabled" &&
    !!aiBaseUrl.trim() &&
    (!providerRequiresApiKey(aiProvider) || !!aiApiKey.trim());

  const canRunSamplePolicyTest =
    aiProvider !== "disabled" &&
    !!aiBaseUrl.trim() &&
    !!aiModel.trim() &&
    (!providerRequiresApiKey(aiProvider) || !!aiApiKey.trim());

  const runAiSampleSummaryTest = async () => {
    if (!canRunSamplePolicyTest || aiSampleStatus === "testing") {
      return;
    }

    setAiSampleStatus("testing");
    setAiSampleMessage("");
    setAiSampleResult(null);

    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title: tAiSample("task_title"),
      subtitle: tAiSample("task_subtitle"),
      kind: "sync",
      href: "/dashboard/settings#ai-summaries",
      onCancel: () => controller.abort(),
    });

    try {
      const res = await fetch("/api/ai/policy-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          provider: aiProvider,
          apiKey: aiApiKey,
          baseUrl: aiBaseUrl,
          model: aiModel,
        }),
      });
      const data = (await res.json()) as
        | AiSamplePolicyResult
        | { ok: false; error?: string; durationMs?: number };

      if (!res.ok || data.ok !== true) {
        const message =
          "error" in data && typeof data.error === "string"
            ? data.error
            : tAiSample("error_fallback");
        setAiSampleStatus("fail");
        setAiSampleMessage(message);
        handle.complete("error", message);
        return;
      }

      setAiSampleStatus("ok");
      setAiSampleResult(data);
      const message = tAiSample("success", {
        model: data.model,
        duration: fmtDuration(data.durationMs),
      });
      setAiSampleMessage(message);
      handle.complete("done", message);
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError";
      const message = aborted
        ? tAiSample("cancelled")
        : error instanceof Error
          ? error.message
          : String(error);
      setAiSampleStatus("fail");
      setAiSampleMessage(message);
      handle.complete("error", message);
    }
  };

  // Fetch the list of models the configured provider actually exposes. Hosted
  // providers use their official models endpoints; custom providers try
  // OpenAI-compatible /models first, then Ollama /api/tags server-side.
  const refreshDiscoveredModels = useCallback(async () => {
    if (aiProvider === "disabled") {
      setDiscoveredModels([]);
      setModelsStatus("idle");
      setModelsError("");
      return;
    }
    if (!canDiscoverModels) {
      setDiscoveredModels([]);
      setModelsStatus("idle");
      setModelsError("");
      return;
    }

    setModelsStatus("loading");
    setModelsError("");
    try {
      const res = await fetch("/api/ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: aiProvider,
          apiKey: aiApiKey,
          baseUrl: aiBaseUrl,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        models?: { id?: string; label?: string }[];
      };
      if (data.ok && Array.isArray(data.models)) {
        const cleaned = data.models
          .map((m) => ({
            value: typeof m.id === "string" ? m.id : "",
            label:
              typeof m.label === "string" && m.label
                ? m.label
                : typeof m.id === "string"
                  ? m.id
                  : "",
          }))
          .filter((m) => m.value);
        setDiscoveredModels(cleaned);
        if (cleaned.length === 0) {
          setModelsStatus("error");
          setModelsError("No models returned from the endpoint.");
        } else {
          setModelsStatus("ok");
        }
      } else {
        setDiscoveredModels([]);
        setModelsStatus("error");
        setModelsError(
          typeof data.message === "string"
            ? data.message
            : "Could not list models."
        );
      }
    } catch (err) {
      setDiscoveredModels([]);
      setModelsStatus("error");
      setModelsError(
        err instanceof Error ? err.message : "Could not list models."
      );
    }
  }, [aiProvider, aiApiKey, aiBaseUrl, canDiscoverModels]);

  // Auto-fetch with a debounce so typing in the Base URL doesn't spam requests.
  useEffect(() => {
    if (aiProvider === "disabled" || !canDiscoverModels) {
      setDiscoveredModels([]);
      setModelsStatus("idle");
      setModelsError("");
      return;
    }
    const timer = setTimeout(() => {
      void refreshDiscoveredModels();
    }, 600);
    return () => clearTimeout(timer);
  }, [aiProvider, canDiscoverModels, refreshDiscoveredModels]);

  /**
   * Auto-save hook for the AI Summaries card. Holds the full provider
   * config — provider, key, model, baseUrl, behaviour toggles. Saved
   * as a single POST so server-side validation sees a coherent blob
   * (e.g. switching from openai to custom requires baseUrl to flip
   * to localhost; sending them separately would fail the route's
   * cross-field checks).
   *
   * Per-phase timeouts are NOT included here — they auto-save through
   * their own hooks (see `aiTimeoutDirectAutoSave` etc.) since they're
   * independent and safer to write granularly.
   */
  interface AiSettingsBlob {
    apiKey: string;
    baseUrl: string;
    debugLogging: boolean;
    model: string;
    provider: AIProvider;
    summarizeOnImport: boolean;
  }

  const aiSettingsAutoSave = useSettingsAutoSave<AiSettingsBlob>({
    endpoint: "/api/settings",
    buildBody: (v) => ({
      ai_provider: v.provider,
      ai_api_key: v.apiKey,
      ai_base_url: v.provider === "disabled" ? "" : v.baseUrl,
      ai_model: v.provider === "disabled" ? "" : v.model,
      ai_summarize_on_import: v.summarizeOnImport,
      ai_debug_logging: v.debugLogging,
    }),
    successMessage: (v) =>
      v.provider === "disabled"
        ? tAiProvider("toast_disabled")
        : tAiProvider("toast_saved", { provider: v.provider }),
    taskLabel: (v) =>
      v.provider === "disabled"
        ? tAiProvider("toast_disabled")
        : tAiProvider("task_label", { provider: v.provider }),
    onSaved: () => {
      // loadSettings re-pulls the canonical state including the masked
      // apiKey marker, so subsequent saves don't accidentally re-send
      // the placeholder.
      void loadSettings();
    },
  });

  /**
   * Compose the current AI settings blob from React state with optional
   * field overrides, then fire a save. Overrides exist because state
   * setters are async — after `setAiProvider(next)` the local
   * `aiProvider` is still the previous value within the same handler,
   * so per-event handlers must thread the new value through explicitly.
   *
   * Skip rule: when the provider isn't disabled but a required field
   * is missing (baseUrl, model, or apiKey for hosted providers), the
   * save would 400 anyway. Silently skipping keeps the bottom toast
   * quiet while the user is mid-edit.
   */
  const saveAiSettings = useCallback(
    (overrides: Partial<AiSettingsBlob> = {}) => {
      const blob: AiSettingsBlob = {
        provider: overrides.provider ?? aiProvider,
        apiKey: overrides.apiKey ?? aiApiKey,
        baseUrl: overrides.baseUrl ?? aiBaseUrl,
        model: overrides.model ?? aiModel,
        summarizeOnImport: overrides.summarizeOnImport ?? summarizeOnImport,
        debugLogging: overrides.debugLogging ?? debugLogging,
      };
      if (
        blob.provider !== "disabled" &&
        (!(blob.baseUrl.trim() && blob.model.trim()) ||
          (providerRequiresApiKey(blob.provider) && !blob.apiKey.trim()))
      ) {
        // Required field missing — wait for the user to fill it in.
        return;
      }
      void aiSettingsAutoSave.save(blob);
    },
    [
      aiProvider,
      aiApiKey,
      aiBaseUrl,
      aiModel,
      summarizeOnImport,
      debugLogging,
      aiSettingsAutoSave,
    ]
  );

  const providerOptions = getAiModelOptions(aiProvider);

  // For the custom provider the model list is driven entirely by what the
  // endpoint reports — we used to also render a curated "Suggestions" group
  // (llama3.2, qwen2.5, etc.) but that confused users whose endpoint didn't
  // actually have those pulled. If the endpoint returns nothing, the user
  // can pick "Custom model…" and type whatever ID they want.
  const mergedModelValues = useMemo(() => {
    const set = new Set<string>();
    if (aiProvider === "custom") {
      for (const m of discoveredModels) {
        set.add(m.value);
      }
    } else {
      for (const m of discoveredModels) {
        set.add(m.value);
      }
      for (const m of providerOptions) {
        set.add(m.value);
      }
    }
    return set;
  }, [aiProvider, discoveredModels, providerOptions]);

  const selectedModelPreset = mergedModelValues.has(aiModel)
    ? aiModel
    : "__custom__";

  // When the user picks "Custom model…" from the dropdown the input appears on
  // the next render. We focus it *only* in that case — never on initial load,
  // so deep-links like #sync-schedule aren't hijacked by the browser scrolling
  // this field into view.
  useEffect(() => {
    if (selectedModelPreset !== "__custom__") {
      return;
    }
    if (!focusCustomModelOnNextRender.current) {
      return;
    }
    focusCustomModelOnNextRender.current = false;
    customModelInputRef.current?.focus();
  }, [selectedModelPreset]);
  const aiConfigChanged = storedAi
    ? storedAi.provider !== aiProvider ||
      storedAi.apiKey !== aiApiKey ||
      storedAi.baseUrl !== (aiProvider === "disabled" ? "" : aiBaseUrl) ||
      storedAi.model !== (aiProvider === "disabled" ? "" : aiModel) ||
      storedAi.summarizeOnImport !== summarizeOnImport ||
      storedAi.debugLogging !== debugLogging ||
      storedAi.timeoutDirectMs !== aiTimeoutDirectMs.trim() ||
      storedAi.timeoutChunkMs !== aiTimeoutChunkMs.trim() ||
      storedAi.timeoutMergeMs !== aiTimeoutMergeMs.trim()
    : false;

  const onProviderChange = (nextProvider: AIProvider) => {
    setAiProvider(nextProvider);

    // When leaving the custom provider, collapse the API-key toggle back to
    // a clean slate so re-entering custom starts with the field hidden
    // again. Switching to a hosted provider doesn't need the toggle at all
    // (the input is always shown because a key is required).
    if (nextProvider !== "custom") {
      setCustomApiKeyEnabled(false);
    }

    if (nextProvider === "disabled") {
      // Disabling is a single-field intent — fire the save immediately.
      saveAiSettings({ provider: "disabled" });
      return;
    }

    const previousDefaultModel =
      aiProvider === "disabled" ? "" : resolveDefaultModel(aiProvider);
    const previousDefaultBaseUrl =
      aiProvider === "disabled" ? "" : resolveDefaultBaseUrl(aiProvider);

    // Compute the next model / baseUrl synchronously so we can thread
    // them into the save payload below. setState is async, so reading
    // `aiModel` after `setAiModel(...)` would still see the previous
    // value within this handler.
    let nextModel = aiModel;
    if (!aiModel || aiModel === previousDefaultModel) {
      nextModel = resolveDefaultModel(nextProvider);
      setAiModel(nextModel);
    }

    let nextBaseUrl = aiBaseUrl;
    if (!aiBaseUrl || aiBaseUrl === previousDefaultBaseUrl) {
      nextBaseUrl = resolveDefaultBaseUrl(nextProvider);
      setAiBaseUrl(nextBaseUrl);
    }

    // Save the full new triple at once so the route's cross-field
    // validation sees a coherent (provider, baseUrl, model) tuple.
    saveAiSettings({
      provider: nextProvider,
      baseUrl: nextBaseUrl,
      model: nextModel,
    });
  };

  // The legacy `aiSaveDisabled` flag is gone — there's no Save button
  // anymore. The same gating now lives inline in `saveAiSettings`,
  // which silently skips POSTs when required fields are missing.

  return {
    storedAi,
    setStoredAi,
    aiProvider,
    setAiProvider,
    aiApiKey,
    setAiApiKey,
    aiBaseUrl,
    setAiBaseUrl,
    aiModel,
    setAiModel,
    customModelInputRef,
    focusCustomModelOnNextRender,
    customApiKeyEnabled,
    setCustomApiKeyEnabled,
    summarizeOnImport,
    setSummarizeOnImport,
    debugLogging,
    setDebugLogging,
    aiTimeoutDirectMs,
    setAiTimeoutDirectMs,
    aiTimeoutChunkMs,
    setAiTimeoutChunkMs,
    aiTimeoutMergeMs,
    setAiTimeoutMergeMs,
    aiTestStatus,
    setAiTestStatus,
    aiTestMessage,
    setAiTestMessage,
    aiTestLatency,
    setAiTestLatency,
    aiSampleStatus,
    setAiSampleStatus,
    aiSampleMessage,
    setAiSampleMessage,
    aiSampleResult,
    setAiSampleResult,
    discoveredModels,
    setDiscoveredModels,
    modelsStatus,
    setModelsStatus,
    modelsError,
    setModelsError,
    aiTimeoutDirectAutoSave,
    aiTimeoutChunkAutoSave,
    aiTimeoutMergeAutoSave,
    testAiConnection,
    canDiscoverModels,
    canRunSamplePolicyTest,
    runAiSampleSummaryTest,
    refreshDiscoveredModels,
    aiSettingsAutoSave,
    saveAiSettings,
    providerOptions,
    mergedModelValues,
    selectedModelPreset,
    aiConfigChanged,
    onProviderChange,
  };
}

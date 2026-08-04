"use client";

/**
 * The onboarding wizard's entire state machine: device + method
 * selection, app entry (typed, file, screenshots/OCR, Apple
 * Configurator), the iTunes search-and-match pass, triage of unmatched
 * rows, the import/scrape run with Apple's rate-limit handling, the
 * optional AI policy-summary pass, and draft persistence across reloads.
 *
 * It is one hook rather than several because the wizard is one machine.
 * That was measured rather than assumed: the cfgutil export path looked
 * self-contained at ~450 lines but needs 19 bindings from the rest of
 * the flow, including handleSearch, createImportRecord and setStep. It
 * is an import *pathway* threaded through the wizard, not an isolated
 * subsystem — and the same holds for the OCR and search clusters.
 *
 * OnboardWizard.tsx keeps the markup and destructures what it renders.
 * See app/components/onboard/README.md for why the steps could not be
 * lifted as prop-taking components instead: they reference 32 / 72 / 53
 * / 39 component-scope bindings each, and a component taking 72 props is
 * not an improvement on inline JSX.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useImportQueue } from "@/app/components/ImportQueueProvider";
import {
  type ImportedAppEntry,
  type ImportMethod,
  METHOD_LAYOUT,
  makeImportedAppEntry,
} from "@/app/components/onboard/shared";
import type {
  AppCandidate,
  OnboardRestorePreview,
  PolicyPhaseStatus,
  PolicyRegenerateStatus,
  PolicyRunPhase,
  ScrapeStatus,
  SearchResult,
  Step,
  TrackedApp,
} from "@/app/components/onboard/types";
import {
  type SearchResultLike,
  useQueuedSearch,
} from "@/app/components/QueuedSearchProvider";
import { type TaskHandle, useTaskCenter } from "@/app/components/TaskCenter";
import {
  type AIProvider,
  getAiModelOptions,
  normalizeAiProvider,
  providerRequiresApiKey,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
} from "@/lib/ai-config";
import {
  extractAppNamesFromOcr,
  isLikelyWebClipBundle,
  MAX_IMPORT_ROWS,
  parseImportedAppRows,
  parseManualAppText,
} from "@/lib/app-import";
import { recordImportEvent } from "@/lib/client-diagnostics";
import {
  type CfgutilCheckResult,
  type ConnectedDevice,
  checkCfgutil,
  isDesktop,
  listConnectedDevices,
  runCfgutilExport,
} from "@/lib/desktop";
import { type DeviceClass, refineDeviceOnClient } from "@/lib/device";
import { useFlag } from "@/lib/feature-flags-hooks";
import {
  DEFAULT_COUNTRY,
  inferCountryFromLocale,
  normalizeCountry,
} from "@/lib/region";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useRovingRadioGroup } from "@/lib/use-roving-radiogroup";

class SearchAccessBlockedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`/api/search blocked with HTTP ${status}`);
    this.name = "SearchAccessBlockedError";
    this.status = status;
  }
}

interface ImportItemSnapshot {
  appName: string | null;
  editedQuery: string | null;
  id: string;
  nextAttemptAt: number | null;
  query: string;
  scrapeError: string | null;
  status: string;
  url: string | null;
}

interface StoredAiSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: AIProvider;
  summarizeOnImport: boolean;
}

type PolicyStopMode = "none" | "now" | "after-current";

const ONBOARDING_DRAFT_STORAGE_KEY = "privacytracker.onboarding.draft.v1";

/**
 * Imports backed by a CSV/TXT drop (including Apple Configurator exports) all
 * get persisted with `source = 'file'` so the history schema stays narrow; the
 * configurator variant is differentiated via the `sourceLabel` column.
 */
function persistedSourceForMethod(
  method: ImportMethod
): "screenshots" | "file" | "manual" {
  return method === "configurator" ? "file" : method;
}

type StatusT = (key: string) => string;

function describeFetchStatus(
  t: StatusT,
  status: string | undefined,
  error?: string
): string | undefined {
  switch (status) {
    case "ready":
      return t("fetch_ready");
    case "source_ready":
      return t("fetch_source_ready");
    case "fetch_error":
      return error || t("fetch_error");
    case "unsupported_content_type":
      return t("fetch_unsupported");
    case "too_short":
      return t("fetch_too_short");
    case "analysis_error":
      return error || t("fetch_analysis_error");
    case "needs_ai_config":
      return t("fetch_needs_ai");
    default:
      return status;
  }
}

function describeSummariseStatus(
  t: StatusT,
  status: string | undefined,
  error?: string
): string | undefined {
  switch (status) {
    case "ready":
      return t("summary_ready");
    case "source_ready":
      return t("summary_awaiting");
    case "analysis_error":
      return error || t("summary_analysis_error");
    case "needs_ai_config":
      return t("summary_needs_ai");
    default:
      return status;
  }
}

type MethodMetaMap = Record<
  ImportMethod,
  {
    title: string;
    eyebrow: string;
    blurb: string;
    hint: string;
  }
>;

type MethodAvailability = Record<ImportMethod, boolean>;

function orderedMethodsForDevice(device: DeviceClass): ImportMethod[] {
  const layout = METHOD_LAYOUT[device];
  return [layout.primary, ...layout.secondary, ...layout.advanced];
}

function pickFirstEnabledMethod(
  device: DeviceClass,
  availability: MethodAvailability
): ImportMethod {
  return (
    orderedMethodsForDevice(device).find((m) => availability[m]) ?? "manual"
  );
}

export /**
 * Triage choice for each "Not in the App Store" row. Keys are the
 * original search query (which equals the app name). Values:
 *   - one of the four ManualAppSource values to save as manual_apps
 *   - 'skip' to keep the row out of the bulk save entirely
 *   - undefined (not in map) means "use the default" — `sideloaded`
 *     is applied as the safe fallback when the bulk Save runs.
 */
type TriageChoice =
  | "web_clip"
  | "testflight"
  | "own_build"
  | "sideloaded"
  | "skip";

export function useOnboardWizard({
  initialDevice = "desktop",
  flags,
}: {
  initialDevice?: DeviceClass;
  /** Server-resolved flags whose first paint must match the runtime-aware
   *  resolver — client `useFlag` falls back to hard defaults before the
   *  cache hydrates, which is not enough for Tauri-only gates. */
  flags?: { methodConfigurator: boolean };
}) {
  const router = useRouter();
  const taskCenter = useTaskCenter();
  const importQueue = useImportQueue();
  // i18n — first-pass translation coverage. Currently wired through:
  //   - the four `<h1 className="wizard-title">` step headings, and
  //   - the method-card titles/eyebrows/blurbs/hints used by the
  //     step-1 method-card picker.
  // The rest of the wizard (button labels, inline form copy, modal
  // bodies) still renders English in v1 — passes are tracked in the
  // i18n migration. New keys here live under `onboard.*`.
  const tWiz = useTranslations("onboard.wizard_titles");
  const tMethod = useTranslations("onboard.methods");
  const tSearchBlock = useTranslations("onboard.search_block");
  const tStepLabels = useTranslations("onboard.step_labels");
  const tStepIndicator = useTranslations("onboard.step_indicator");
  const tOnboard = useTranslations("onboard");
  const tAiStep = useTranslations("onboard.ai_step");
  const tAiOptions = useTranslations("ai_options");
  const tStep1 = useTranslations("onboard.step1");
  const tStep2 = useTranslations("onboard.step2");
  const tStep3 = useTranslations("onboard.step3");
  const tStep4 = useTranslations("onboard.step4");
  const tCfg = useTranslations("onboard.cfgutil");
  const tStatus = useTranslations("onboard_status");
  const tPolicyRun = useTranslations("onboard.policy_run");
  // Localised method metadata. Returns the same shape the
  // original static lookup exposed so call-sites that read
  // `methodMeta[method].title` etc. don't have to know the
  // translation lives elsewhere. Built via useMemo so the lookup
  // table is stable across renders, only rebuilt when the locale
  // changes (which forces a full reload in this app, so in practice
  // the dependency is constant).
  const methodMeta = useMemo<MethodMetaMap>(
    () => ({
      screenshots: {
        title: tMethod("screenshots.title"),
        eyebrow: tMethod("screenshots.eyebrow"),
        blurb: tMethod("screenshots.blurb"),
        hint: tMethod("screenshots.hint"),
      },
      file: {
        title: tMethod("file.title"),
        eyebrow: tMethod("file.eyebrow"),
        blurb: tMethod("file.blurb"),
        hint: tMethod("file.hint"),
      },
      configurator: {
        title: tMethod("configurator.title"),
        eyebrow: tMethod("configurator.eyebrow"),
        blurb: tMethod("configurator.blurb"),
        hint: tMethod("configurator.hint"),
      },
      manual: {
        title: tMethod("manual.title"),
        eyebrow: tMethod("manual.eyebrow"),
        blurb: tMethod("manual.blurb"),
        hint: tMethod("manual.hint"),
      },
    }),
    [tMethod]
  );

  // Wave I: per-method onboarding flags. Each `flag.onboarding.method.*`
  // controls whether the matching `ImportMethod` card shows up on the
  // step-1 picker. The set is computed once per render and threaded into
  // the layout filter below; methods that resolve off are removed from
  // both the primary row and the Advanced drawer (and from auto-pick).
  const onboardMethodManualOn =
    useFlag("flag.onboarding.method.manual_entry") === "on";
  const onboardMethodFileOn =
    useFlag("flag.onboarding.method.file_upload") === "on";
  const onboardMethodConfiguratorResolvedOn =
    useFlag("flag.onboarding.method.configurator") === "on";
  const onboardMethodConfiguratorOn =
    flags?.methodConfigurator ?? onboardMethodConfiguratorResolvedOn;
  const onboardMethodScreenshotOn =
    useFlag("flag.onboarding.method.screenshot_ocr") === "on";
  const onboardMethodLiveTextOn =
    useFlag("flag.onboarding.method.live_text_help") === "on";
  // Step-3 "Hide already-tracked apps" inline toggle inside the
  // already-tracked banner. When off the banner shows the count
  // without the toggle (so the user can't filter the rescrape list).
  const onboardHideTrackedToggleOn =
    useFlag("flag.onboarding.confirm.hide_tracked_toggle") === "on";
  // Wave I — Step-5 AI summaries entry/skip + post-import flow flags.
  // Each gates a single inline affordance:
  //   step.ai_summaries — hides the AI-summaries step entirely (the
  //     wizard transitions straight to /dashboard from step 5 when off)
  //   post.dashboard_skip — hides the "Skip → dashboard" button so
  //     users finish the AI step deliberately
  //   post.background_worker — hides the "Hand off to background
  //     worker" button on the rate-limit banner (work still happens
  //     automatically, just not user-controllable)
  //   import.rate_limit_handoff — hides the entire scrape rate-limit
  //     banner during step 4 (the worker still resumes in the
  //     background; users just don't see the live countdown)
  const onboardStepAiSummariesOn =
    useFlag("flag.onboarding.step.ai_summaries") === "on";
  const onboardPostDashboardSkipOn =
    useFlag("flag.onboarding.post.dashboard_skip") === "on";
  const onboardPostBackgroundWorkerOn =
    useFlag("flag.onboarding.post.background_worker") === "on";
  const onboardImportRateLimitHandoffOn =
    useFlag("flag.onboarding.import.rate_limit_handoff") === "on";
  // Step-1 footer affordances. The "Restore from a backup file" link
  // and the (yet-to-render) "Import audit bundle" link sit below the
  // primary method picker — both are quiet escape hatches for users
  // arriving with existing exports.
  const onboardMethodRestoreBackupOn =
    useFlag("flag.onboarding.method.restore_backup") === "on";
  const onboardMethodImportAuditBundleOn =
    useFlag("flag.onboarding.method.import_audit_bundle") === "on";
  // Step-1 settings rows: the App Store region picker and the
  // "track accessibility labels" toggle each gate independently so a
  // curated focus can hide either without disturbing the other.
  const onboardStepAppStoreRegionOn =
    useFlag("flag.onboarding.step.app_store_region") === "on";
  const onboardStepAccessibilityToggleOn =
    useFlag("flag.onboarding.step.accessibility_toggle") === "on";
  // Wave I — wizard step body gates. Each one wraps the body of the
  // matching step so the section disappears under curated focus, while
  // the wizard's `step` state machine still allows back/next navigation
  // between the numbered steps. When a step body is gated off, the user
  // clicks Next past the empty step.
  const onboardStepChooseMethodOn =
    useFlag("flag.onboarding.step.choose_method") === "on";
  const onboardStepConfirmMatchesOn =
    useFlag("flag.onboarding.step.confirm_matches") === "on";
  const onboardStepImportProgressOn =
    useFlag("flag.onboarding.step.import_progress") === "on";
  // Onboarding-namespace twin of `flag.settings.ai.summarize_on_import`.
  // The settings flag controls whether the persisted preference (from
  // /api/settings) influences anything; this one is the wizard's own
  // gate so a curated focus can suppress on-import summaries even if
  // the user later flips the saved preference on. Currently treated as
  // an AND-gate against `summarizeOnImport` — flipping either off
  // cancels the auto-summarise behaviour during the wizard's first
  // import. Kept separate from the settings flag so the values aren't
  // accidentally yoked together when revisiting onboarding.
  const onboardAiSummarizeOnImportOn =
    useFlag("flag.onboarding.ai.summarize_on_import") === "on";
  // The remaining method flags (restore_backup, import_audit_bundle) are
  // routed via separate links/components — wired further below where they
  // surface, not via the method-card filter here.
  const methodAvailability = useMemo<MethodAvailability>(
    () => ({
      manual: onboardMethodManualOn,
      file: onboardMethodFileOn,
      configurator: onboardMethodConfiguratorOn,
      screenshots: onboardMethodScreenshotOn,
    }),
    [
      onboardMethodManualOn,
      onboardMethodFileOn,
      onboardMethodConfiguratorOn,
      onboardMethodScreenshotOn,
    ]
  );
  const policyTaskHandleRef = useRef<TaskHandle | null>(null);
  const textFileRef = useRef<HTMLInputElement>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>(1);
  /** Device class used to tailor the method picker. Starts from the SSR
   *  guess so hydration matches, then gets refined on the client. */
  const [deviceClass, setDeviceClass] = useState<DeviceClass>(initialDevice);
  useEffect(() => {
    // Web fallback path: refine via UA + viewport heuristics. The Tauri
    // override below runs second and wins if isDesktop() returns true
    // — see that effect for the full rationale.
    setDeviceClass((prev) => refineDeviceOnClient(prev));
    // One-shot; resize re-evaluation would change the primary method mid-
    // interaction, which is jarring. Users who rotate or resize can pick
    // whatever option they want manually from the Advanced drawer.
  }, []);
  /** Default the picker to the first flag-enabled method for this device class. */
  const [method, setMethod] = useState<ImportMethod>(() =>
    pickFirstEnabledMethod(initialDevice, methodAvailability)
  );
  /** Once the user picks a method deliberately, device-class refinements should
   *  not bounce them to a different recommendation unless their selected
   *  method becomes hidden by a feature flag. */
  const userSelectedMethodRef = useRef(false);
  // APG keyboard contract for the wizard radiogroups. AI-provider
  // cards + cfgutil device rows select as focus moves (local state,
  // instantly reversible). The import-method cards move focus only —
  // selecting a method wipes any in-progress import state, so
  // Enter/Space commits instead of every arrow press.
  const wizardRadioKeyDown = useRovingRadioGroup();
  const methodRadioKeyDown = useRovingRadioGroup({ followFocus: false });
  useEffect(() => {
    const visibleForDevice = orderedMethodsForDevice(deviceClass).filter(
      (m) => methodAvailability[m]
    );
    const recommended = visibleForDevice[0] ?? "manual";
    const currentStillVisible =
      methodAvailability[method] && visibleForDevice.includes(method);

    if (!currentStillVisible) {
      userSelectedMethodRef.current = false;
      setMethod(recommended);
      return;
    }

    if (!userSelectedMethodRef.current && method !== recommended) {
      setMethod(recommended);
    }
  }, [deviceClass, method, methodAvailability]);
  /** "How do I use Live Text?" modal visibility, launched from the manual
   *  step on phone + tablet layouts. */
  const [liveTextModalOpen, setLiveTextModalOpen] = useState(false);

  /**
   * App Store storefront to search. Users pick this on Step 1 because
   * Australian / regional apps don't exist in the US storefront and would
   * otherwise return zero candidates or the wrong app entirely. The value
   * hydrates from the saved `app_country` setting on mount, then any change
   * is saved back immediately so later re-syncs use the same region.
   */
  const [country, setCountry] = useState<string>(DEFAULT_COUNTRY);
  const [countryLoaded, setCountryLoaded] = useState(false);
  const [countryInferred, setCountryInferred] = useState(false);
  /**
   * Region → language suggestion. Same logic as the Settings page:
   * when the picked storefront's expected language differs from the
   * active UI locale, surface the LanguageSuggestionBanner under
   * the region row so the user can switch languages without leaving
   * the onboarding flow.
   *
   *   - 'cn' storefront + active locale 'en'  → suggest zh
   *   - non-'cn' storefront + active locale 'zh' → suggest en
   *   - all other combos → null (banner hidden)
   *
   * Stored as the *target* locale ('zh' | 'en') so the banner knows
   * which direction to render.
   */
  const [languageSuggestion, setLanguageSuggestion] = useState<
    "zh" | "en" | null
  >(null);

  /**
   * Whether to surface Apple's accessibility nutrition labels in the UI.
   * The scraper always captures the shelf regardless of this flag — the
   * toggle only gates display (app detail page chip, stats chart, grid
   * filter) — so flipping it on later reveals history that was silently
   * being collected the whole time. Defaults to on.
   */
  const [trackAccessibility, setTrackAccessibility] = useState<boolean>(true);

  /**
   * Rate-limit resume state lives in the layout-level QueuedSearchProvider,
   * so the retry loop survives the wizard unmounting (e.g. if the user
   * navigates to the dashboard while Apple's cooldown runs). We read the
   * shared state for the inline banner and keep a local 1-Hz tick so the
   * countdown label re-renders smoothly even though the underlying
   * `resumeAt` is stable.
   */
  const queuedSearch = useQueuedSearch();
  const ratePending = queuedSearch.state;
  const [rateTick, setRateTick] = useState(0);
  useEffect(() => {
    if (!ratePending.pending || ratePending.resumeAt === null) {
      return;
    }
    const id = setInterval(() => setRateTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [ratePending.pending, ratePending.resumeAt]);

  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [storedAi, setStoredAi] = useState<StoredAiSettings | null>(null);
  /* Default OFF, not OpenAI: sending every app's privacy policy to a
     third-party API is opt-in, and pre-selecting a provider the user
     has no key for meant the step opened in an unsatisfiable state. */
  const [aiProvider, setAiProvider] = useState<AIProvider>("disabled");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState(resolveDefaultBaseUrl("openai"));
  const [aiModel, setAiModel] = useState(resolveDefaultModel("openai"));
  const [summarizeOnImport, setSummarizeOnImport] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [aiError, setAiError] = useState("");

  // `namesText` (the old plain-string textarea state) is gone — the
  // table component below owns the imported-apps list, and the
  // bulk-paste textarea inside it carries its own local input buffer.
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [draftRestored, setDraftRestored] = useState(false);

  /**
   * Tauri desktop auto-import via Apple Configurator's `cfgutil`. We don't
   * probe at mount — the probe still shells out to list devices, and users
   * landing on the screenshots or manual methods never need the answer. The
   * Step-2 configurator panel renders an explicit "Check for cfgutil" button
   * that kicks off `runCfgutilCheck` below; the result is held here so the
   * panel can switch between its "checking…", "available — export now",
   * "missing — install these bits" and "error" surfaces without a second
   * round-trip.
   */
  const [inDesktop, setInDesktop] = useState(false);
  const [cfgutilCheck, setCfgutilCheck] = useState<CfgutilCheckResult | null>(
    null
  );
  const [cfgutilChecking, setCfgutilChecking] = useState(false);
  const [cfgutilExporting, setCfgutilExporting] = useState(false);
  const [cfgutilError, setCfgutilError] = useState("");
  /**
   * Raw stdout from the most recent cfgutil run, captured when the
   * import returned zero apps so the user can diagnose what happened
   * (locked device, trust prompt pending, malformed JSON, etc.).
   * Cleared on retry. Only populated on the empty-apps failure path —
   * a successful import doesn't surface this to keep the wizard's
   * happy path uncluttered.
   */
  const [cfgutilDiagnostic, setCfgutilDiagnostic] = useState<string | null>(
    null
  );
  const [cfgutilDevices, setCfgutilDevices] = useState<ConnectedDevice[]>([]);
  const [cfgutilDevicesLoading, setCfgutilDevicesLoading] = useState(false);
  const [selectedCfgutilEcid, setSelectedCfgutilEcid] = useState<string | null>(
    null
  );
  useEffect(() => {
    setInDesktop(isDesktop());
  }, []);

  // Tauri-desktop deviceClass override. When we're inside the Tauri
  // shell (`inDesktop` becomes true) we KNOW the user is on a desktop
  // Mac/Win/Linux build, regardless of what the WKWebView's UA /
  // viewport heuristics say. We override `deviceClass` here so the
  // Apple Configurator card — which `METHOD_LAYOUT.desktop.primary`
  // declares — actually renders. Without this override, edge cases
  // in `refineDeviceOnClient` (narrow Tauri window, WKWebView
  // reporting trackpad touch points, an unfamiliar UA) can land the
  // initial heuristic on `'tablet'` or `'phone'` and silently hide
  // configurator from the picker. Tauri's `__TAURI__` global is the
  // strongest signal we have for "this is a desktop binary that can
  // shell out to cfgutil", so we trust it over any UA guess.
  //
  // Note: we react to `inDesktop` rather than calling `isDesktop()`
  // synchronously inside the first useEffect because Tauri injects
  // `window.__TAURI__` after the page loads — there's a brief window
  // where the first useEffect runs before the global is present.
  // Reacting to `inDesktop` covers that race.
  useEffect(() => {
    if (inDesktop) {
      setDeviceClass("desktop");
    }
  }, [inDesktop]);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [isDraggingText, setIsDraggingText] = useState(false);
  const [isDraggingImages, setIsDraggingImages] = useState(false);
  const [ocring, setOcring] = useState(false);
  const [ocrMessage, setOcrMessage] = useState("");
  const [ocrError, setOcrError] = useState("");
  /** Captures the underlying OCR error for diagnostics, surfaced in a collapsed
   *  `<details>` under the red wizard note. Kept separate from `ocrError` so the
   *  human-readable message stays clean and the raw tesseract.js error (often
   *  something like "SharedArrayBuffer is not defined" or a CDN fetch failure)
   *  is only surfaced when the user actively asks for it. */
  const [ocrErrorDetail, setOcrErrorDetail] = useState("");
  /** Mobile Safari (iOS WKWebView / SFSafariViewController included) tends to
   *  choke on tesseract.js because the WASM core + English traineddata are
   *  pulled from external CDNs, SharedArrayBuffer requires COOP/COEP, and
   *  memory ceilings are low. We warn users up front rather than letting them
   *  discover it via a generic failure message. Detection is best-effort — we
   *  accept false positives (ipados desktop mode reports as macOS, which we
   *  already route past this path). */
  const [isIosSafari, setIsIosSafari] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined") {
      return;
    }
    const ua = navigator.userAgent || "";
    const platform = (navigator as any).platform || "";
    // iPhone / iPod always show up in UA. iPadOS 13+ lies about being Mac but
    // still exposes a touchscreen, which desktop Safari does not.
    const isIosDevice =
      /iP(hone|od|ad)/i.test(ua) ||
      (platform === "MacIntel" &&
        typeof (navigator as any).maxTouchPoints === "number" &&
        (navigator as any).maxTouchPoints > 1);
    // Safari on iOS: UA contains 'Safari' but not 'CriOS' (Chrome), 'FxiOS'
    // (Firefox), 'EdgiOS', 'OPiOS'. Third-party browsers on iOS all use WebKit
    // under the hood so the OCR limitations apply to them too — flag them all.
    const looksLikeMobileWebKit = isIosDevice && /WebKit/i.test(ua);
    setIsIosSafari(Boolean(looksLikeMobileWebKit));
  }, []);
  /**
   * Unified imported-app state. Replaces the previous three-state setup
   * (`namesText: string` + `bundleIdHints: Map` + `developerHints: Map`)
   * where bundle IDs and developer hints were keyed by lowercased name —
   * fragile because retyping a name in the textarea silently dropped the
   * hint. Each row now keeps its name, optional bundle ID, optional
   * developer, and import source together; edits are explicit row
   * operations (remove a row) so hints can't go silently missing.
   *
   * Order is preserved (insertion order). Duplicate names get separate
   * entries — the table renders them all and the user can remove the
   * one they didn't intend. /api/search dedupes on the server anyway.
   *
   * The view layer renders this as the `ImportedAppsTable`; the legacy
   * `namesText` state is gone, and a separate `bulkPasteInput` state
   * captures whatever the user is currently typing/pasting in the
   * table's "+ Add" input (committed to `importedApps` on submit).
   */
  const [importedApps, setImportedApps] = useState<ImportedAppEntry[]>([]);
  /**
   * Uncommitted draft text the user is typing/pasting into the
   * ImportedAppsTable's "+ Add" textarea. Lifted out of the child so
   * the search-button-disabled check can account for it (the button
   * should be live the moment the user types a name, even before they
   * click + Add) and so `handleSearch` can flush it inline before
   * reading the names list. Stays "" outside step 2.
   */
  const [pendingAppText, setPendingAppText] = useState("");
  // Derived adapter maps so the rest of the wizard (developerHint lookups,
  // existing test expectations) can keep calling `.get(name.toLowerCase())`
  // until the call sites get refactored. The arrays still live in
  // `importedApps` — these are just read views.
  const developerHints = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const e of importedApps) {
      if (e.developer) {
        m.set(e.name.toLowerCase(), e.developer);
      }
    }
    return m;
  }, [importedApps]);
  const bundleIdHints = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const e of importedApps) {
      // Skip web clips — Safari home-screen shortcuts (bundle IDs like
      // `com.apple.WebKit.PushBundle.<UUID>`) have no App Store record,
      // so a bundle-Lookup round-trip for them always fails and pushes
      // the row into the name-search fallback (which also fails, since
      // the name is whatever the site title was). They're routed
      // directly into the manual-apps web-clip pile on Step 3 below.
      if (e.likelyWebClip) {
        continue;
      }
      if (e.bundleId) {
        m.set(e.name.toLowerCase(), e.bundleId);
      }
    }
    return m;
  }, [importedApps]);

  /**
   * Apps imported from cfgutil whose bundle ID matches the Safari web-clip
   * pattern. Surfaced as a separate Step-3 section with a one-click
   * "Save as manual web apps" CTA — they bypass the App Store search
   * pipeline entirely because they have no App Store record.
   */
  const webClipEntries = useMemo<ImportedAppEntry[]>(
    () => importedApps.filter((e) => e.likelyWebClip === true),
    [importedApps]
  );
  /** Informational message about the imported file — e.g. "capped at 500 of 812 rows". */
  const [importInfo, setImportInfo] = useState("");

  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<Map<string, AppCandidate>>(
    new Map()
  );

  /**
   * Web-clip bulk-save state. Tracks the lifecycle of the Step-3
   * "Save Safari shortcuts as manual apps" CTA:
   *   - 'idle'   : the banner with a Save button is visible
   *   - 'saving' : Save button is spinning; CTA disabled
   *   - 'saved'  : success confirmation replaces the list
   *   - 'error'  : error message + retry option
   */
  const [webClipSaveState, setWebClipSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [webClipSavedCount, setWebClipSavedCount] = useState(0);
  const [webClipSaveError, setWebClipSaveError] = useState("");

  const [triageChoices, setTriageChoices] = useState<Map<string, TriageChoice>>(
    new Map()
  );
  const [unmatchedSaveState, setUnmatchedSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [unmatchedSavedCount, setUnmatchedSavedCount] = useState(0);
  const [unmatchedSaveError, setUnmatchedSaveError] = useState("");
  const [manuallyChosenQueries, setManuallyChosenQueries] = useState<
    Set<string>
  >(new Set());
  const [skippedQueries, setSkippedQueries] = useState<Set<string>>(new Set());
  const [rematchingRegion, setRematchingRegion] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  /**
   * True when the last search failed because the security gate rejected
   * the request (401/403 — non-local host without an admin token), as
   * opposed to a transport/server error. Drives the "log in via
   * Settings → Deployment" link rendered next to the error copy.
   */
  const [searchBlocked, setSearchBlocked] = useState(false);
  /**
   * Error from a single-block re-search on step 3 (`handleBlockResearch`).
   * Kept separate from `searchError`, which only renders on step 2 —
   * without this, a failed per-row retry was indistinguishable from
   * "no results" and the row silently kept its stale state.
   */
  const [blockSearchError, setBlockSearchError] = useState("");
  /**
   * Query whose single-block re-search (`handleBlockResearch`) is in
   * flight. Separate from `editingBlock` — which doubles as "this row's
   * edit form is open" — so the plain Retry buttons can show a spinner
   * without flipping their row into the editor UI.
   */
  const [blockSearching, setBlockSearching] = useState<string | null>(null);
  /**
   * Live progress for the chunked name-search loop. `null` whenever a
   * search isn't in flight; populated batch-by-batch so the user sees
   * "Searched N of M" instead of an endless spinner on large imports
   * (the user's 212-app case prompted this — at ~200ms/name iTunes
   * Search would otherwise sit silent for the better part of a minute).
   *
   * Phase 1 (bundle-ID lookup) finishes near-instantly and contributes
   * its matches to `matched` before phase 2 begins, so the count
   * tracks total apps confirmed across both phases.
   */
  const [searchProgress, setSearchProgress] = useState<{
    matched: number;
    total: number;
    currentBatch: number;
    totalBatches: number;
  } | null>(null);
  /** Active AbortController for the in-flight search; lets the cancel
   *  button stop the chunk loop after the current batch returns. */
  const searchAbortRef = useRef<AbortController | null>(null);
  /**
   * Step 3 toggle: when true, blocks whose chosen candidate is already
   * being tracked are hidden from view AND excluded from the import
   * action. The individual selections stay in `selected` so flipping the
   * toggle back off restores the user's earlier choices verbatim rather
   * than forcing them to re-pick. Defaults to false so the first-time
   * landing on Step 3 still shows everything.
   */
  const [hideTrackedBlocks, setHideTrackedBlocks] = useState(false);

  /**
   * Apps already persisted in the local DB. Loaded once on mount and used to
   *   (a) warn when a name on the Step 2 list is already being tracked, and
   *   (b) flag a Step 3 candidate that matches a known Apple trackId so the
   *       user knows the import will re-sync rather than duplicate the row.
   * Keyed twice for cheap O(1) lookup at both stages.
   */
  const [trackedByAppleId, setTrackedByAppleId] = useState<
    Map<string, TrackedApp>
  >(new Map());
  /**
   * Same set, keyed by `apps.bundleId`. Catches the legacy-import
   * duplicate where a previous name-search import + a cfgutil bundle-ID
   * import resolved the same physical app to different App Store track
   * IDs. Without this, Step 3's dedupe banner under-counts because it
   * only matches by `appleId` (track ID). Same nullability rules as
   * the underlying column — entries are absent when the apps row has
   * no bundle ID on file.
   */
  const [trackedByBundleId, setTrackedByBundleId] = useState<
    Map<string, TrackedApp>
  >(new Map());

  const [scrapeList, setScrapeList] = useState<ScrapeStatus[]>([]);
  const [done, setDone] = useState(false);
  const [importDetailsOpen, setImportDetailsOpen] = useState(false);
  const scrapeListRef = useRef<ScrapeStatus[]>([]);
  useEffect(() => {
    scrapeListRef.current = scrapeList;
  }, [scrapeList]);
  /**
   * When Apple 429s mid-scrape, we display an inline countdown banner and
   * the loop sleeps until `resumeAt` before taking another swing. `reason`
   * is the copy shown in the banner so we can be explicit about what the
   * wait buys the user (usually a full minute).
   *
   * The Task Center mirrors this state so the countdown is still visible
   * if the user navigates away from the wizard — the loop itself is owned
   * by this component though, so leaving the page cancels the inline retry
   * and hands the tail over to the server-side queue worker.
   */
  const [scrapeRateLimit, setScrapeRateLimit] = useState<{
    resumeAt: number;
    reason: string;
  } | null>(null);
  /**
   * Shown when Apple rate-limits the import. Instead of retrying inline
   * (which the loop used to do up to 3 times), we now pause immediately,
   * queue every remaining row for the background worker, and surface a
   * modal offering the user two next steps: jump to Import History to
   * watch the queue drain, or skip ahead to the AI policy-summary step
   * for the apps that already imported cleanly.
   *
   * `queuedCount` is how many rows we just flipped to `queued` (current
   * row + every `pending` after it). `retryAfterMs` is Apple's Retry-After
   * header value, pinned to whatever the first 429 returned — used in the
   * modal copy so the user knows roughly how long the wait is.
   */
  const [rateLimitPauseModal, setRateLimitPauseModal] = useState<{
    queuedCount: number;
    successCount: number;
    retryAfterMs: number;
  } | null>(null);
  /** Set by the Task Center cancel hook — flips the batched loop to the
   *  "queue the rest" path on the next iteration boundary. */
  const scrapeCancelRef = useRef(false);
  /** Re-render tick so the step-4 banner can show a ticking seconds value
   *  even while `scrapeRateLimit` itself is stable. */
  const [scrapeRateTick, setScrapeRateTick] = useState(0);
  const importDrainPausedUntil = importQueue.drainState?.pausedUntil ?? null;
  useEffect(() => {
    if (
      !(
        scrapeRateLimit ||
        (importDrainPausedUntil && importDrainPausedUntil > Date.now())
      )
    ) {
      return;
    }
    const id = setInterval(() => setScrapeRateTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [importDrainPausedUntil, scrapeRateLimit]);

  // Import-history plumbing
  const [importId, setImportId] = useState<string | null>(null);
  // Maps the current block-key (query-or-edited-query) to the server-side item id.
  const [itemIdByQuery, setItemIdByQuery] = useState<Map<string, string>>(
    new Map()
  );
  const itemIdByQueryRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    itemIdByQueryRef.current = itemIdByQuery;
  }, [itemIdByQuery]);
  // Per-block re-search state (key = current query for that block).
  const [editingBlock, setEditingBlock] = useState<string | null>(null);

  // AI step (now last, optional) — regeneration progress list
  const [policyProgress, setPolicyProgress] = useState<
    PolicyRegenerateStatus[]
  >([]);
  const [policyRunDone, setPolicyRunDone] = useState(false);
  const [activePhase, setActivePhase] = useState<PolicyRunPhase>(null);
  const [phaseAvgMs, setPhaseAvgMs] = useState<{
    fetch: number | null;
    summarise: number | null;
  }>({
    fetch: null,
    summarise: null,
  });
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const stopRequestedRef = useRef<PolicyStopMode>("none");
  const activeAbortRef = useRef<AbortController | null>(null);
  // Ref attached to the Step 4 row whose status is currently 'scraping' so
  // we can auto-scroll it into view as the importer advances down the list.
  const scrapeActiveRowRef = useRef<HTMLDivElement | null>(null);
  // Anchor placed after the last scrape row so the "Scroll to bottom"
  // button can fast-scroll to the end of the list — useful on 200+ app
  // Configurator imports where the active row sits well below the
  // viewport and the user wants to see where the list ends.
  const scrapeListEndRef = useRef<HTMLDivElement | null>(null);
  // Drive an ETA tick so elapsed / remaining numbers update without waiting for state changes.
  const [etaTick, setEtaTick] = useState(0);
  useEffect(() => {
    if (activePhase === null) {
      return;
    }
    const interval = setInterval(() => setEtaTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activePhase]);
  useEffect(() => {
    if (policyRunDone && cancelModalOpen) {
      setCancelModalOpen(false);
    }
  }, [policyRunDone, cancelModalOpen]);

  // When Step 4 advances to the next app, bring that row into view so the
  // user can watch progress without having to scroll long lists themselves.
  // `block: 'nearest'` avoids a disorienting jump when the row is already
  // visible, and a soft behaviour keeps the motion calm.
  useEffect(() => {
    if (step !== 4) {
      return;
    }
    const el = scrapeActiveRowRef.current;
    if (!el) {
      return;
    }
    try {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch {
      // Older browsers without smooth-scroll support — fall back silently.
      el.scrollIntoView();
    }
  }, [step, scrapeList]);

  // ── Restore-from-backup (Step 1 footer) ────────────────────────────────
  // Mirrors the Settings flow: pick → preview → typed-confirmation → apply.
  // Inline here because the onboarding shell has no SettingsView in scope.
  type OnboardRestoreStage = "idle" | "previewing" | "confirm" | "applying";
  const restoreFileRef = useRef<HTMLInputElement>(null);
  const [restoreStage, setRestoreStage] = useState<OnboardRestoreStage>("idle");
  const [restorePreview, setRestorePreview] =
    useState<OnboardRestorePreview | null>(null);
  const [pendingRestorePayload, setPendingRestorePayload] = useState<
    string | null
  >(null);
  const [pendingRestoreFilename, setPendingRestoreFilename] = useState<
    string | null
  >(null);
  const [restoreError, setRestoreError] = useState("");
  const [restoreConfirmText, setRestoreConfirmText] = useState("");

  const resetRestoreFlow = () => {
    setRestoreStage("idle");
    setRestorePreview(null);
    setPendingRestorePayload(null);
    setPendingRestoreFilename(null);
    setRestoreError("");
    setRestoreConfirmText("");
  };

  // ── Modal focus management (WCAG 2.4.3 / 2.1.2) ────────────────────────
  const restoreModalCardRef = useModalFocus<HTMLDivElement>({
    open:
      (restoreStage === "confirm" || restoreStage === "applying") &&
      restorePreview !== null,
    onClose: () => {
      if (restoreStage !== "applying") {
        resetRestoreFlow();
      }
    },
    closeOnEscape: true,
  });
  const cancelModalCardRef = useModalFocus<HTMLDivElement>({
    open: cancelModalOpen,
    onClose: () => setCancelModalOpen(false),
    closeOnEscape: true,
  });
  const rateLimitModalCardRef = useModalFocus<HTMLDivElement>({
    open: rateLimitPauseModal !== null,
    onClose: () => setRateLimitPauseModal(null),
    closeOnEscape: true,
  });

  const handleRestoreFileChosen = async (file: File) => {
    setRestoreError("");
    setRestoreStage("previewing");
    setPendingRestoreFilename(file.name);
    setRestoreConfirmText("");
    try {
      const text = await file.text();
      let previewBody: unknown;
      try {
        previewBody = JSON.parse(text);
      } catch {
        throw new Error(tStatus("restore_invalid_json"));
      }
      const res = await fetch("/api/backup/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(previewBody),
      });
      if (!res.ok) {
        let msg = tStatus("restore_validate_failed");
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        throw new Error(msg);
      }
      const preview = (await res.json()) as OnboardRestorePreview;
      setRestorePreview(preview);
      setPendingRestorePayload(text);
      setRestoreStage("confirm");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setRestoreError(msg);
      setPendingRestorePayload(null);
      setRestorePreview(null);
      setRestoreStage("idle");
    }
  };

  const handleRestoreConfirm = async () => {
    if (!pendingRestorePayload) {
      return;
    }
    if (restoreConfirmText.trim().toUpperCase() !== "RESTORE") {
      setRestoreError(tStatus("restore_type_to_confirm"));
      return;
    }
    setRestoreError("");
    setRestoreStage("applying");
    try {
      const res = await fetch("/api/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pendingRestorePayload,
      });
      if (!res.ok) {
        let msg = tStatus("restore_failed");
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        setRestoreError(msg);
        setRestoreStage("confirm");
        return;
      }
      // After a successful restore the onboarding flow is irrelevant — the
      // user already has data. Send them straight to the dashboard.
      window.location.href = "/dashboard";
    } catch (error) {
      setRestoreError(
        error instanceof Error ? error.message : tStatus("restore_failed")
      );
      setRestoreStage("confirm");
    }
  };

  // AI connection test (step 5)
  const [aiTestStatus, setAiTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");
  const [aiTestMessage, setAiTestMessage] = useState("");
  const [aiTestLatency, setAiTestLatency] = useState<number | null>(null);

  useEffect(() => {
    setAiTestStatus("idle");
    setAiTestMessage("");
    setAiTestLatency(null);
  }, [aiProvider, aiApiKey, aiBaseUrl]);

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
          baseUrl: aiBaseUrl,
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
      console.error("[wizard] AI connection test failed:", error);
      setAiTestStatus("fail");
      setAiTestMessage(error instanceof Error ? error.message : String(error));
      setAiTestLatency(null);
    }
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        const loadedProvider = normalizeAiProvider(
          data.ai_provider ?? "disabled"
        );
        /* Honour a stored "disabled" instead of flipping it back to
           OpenAI — that remap made the opt-out unrepresentable in the
           wizard, so a user who declined summaries saw a provider
           pre-selected again on their next visit. */
        const nextProvider = loadedProvider;
        const nextAi: StoredAiSettings = {
          provider: nextProvider,
          apiKey: data.ai_api_key ?? "",
          baseUrl:
            (data.ai_base_url ?? "") || resolveDefaultBaseUrl(nextProvider),
          model: (data.ai_model ?? "") || resolveDefaultModel(nextProvider),
          summarizeOnImport: data.ai_summarize_on_import === "true",
        };

        setStoredAi(loadedProvider === "disabled" ? null : nextAi);
        setAiProvider(nextAi.provider);
        setAiApiKey(nextAi.apiKey);
        setAiBaseUrl(nextAi.baseUrl);
        setAiModel(nextAi.model);
        setSummarizeOnImport(nextAi.summarizeOnImport);
        // Hydrate country last so the picker defaults to whatever the user
        // saved previously. On true first run, infer a better storefront from
        // browser locale/time zone so AU/NZ/etc. users don't silently search
        // the US App Store first.
        const explicitCountry = data.app_country_explicit === true;
        let nextCountry = normalizeCountry(data.app_country ?? DEFAULT_COUNTRY);
        let inferred = false;
        if (!explicitCountry && typeof window !== "undefined") {
          const locale = navigator.language;
          const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const inferredCountry = inferCountryFromLocale(locale, timeZone);
          if (inferredCountry) {
            nextCountry = inferredCountry;
            inferred =
              inferredCountry !==
              normalizeCountry(data.app_country ?? DEFAULT_COUNTRY);
          }
        }
        const draftHasCountry =
          typeof window !== "undefined" &&
          window.localStorage.getItem(ONBOARDING_DRAFT_STORAGE_KEY) !== null;
        if (!draftHasCountry) {
          setCountry(nextCountry);
          setCountryInferred(inferred);
        }
        setCountryLoaded(true);
        // Accessibility toggle: respect whatever is saved, defaulting to true
        // for first-run since the feature is opt-out rather than opt-in.
        if (typeof data.track_accessibility_labels === "boolean") {
          setTrackAccessibility(data.track_accessibility_labels);
        } else if (data.track_accessibility_labels !== undefined) {
          setTrackAccessibility(data.track_accessibility_labels !== "false");
        }
      } catch (error) {
        console.error("[wizard] Failed to load /api/settings:", error);
        setAiError(tStatus("ai_load_failed"));
        setCountryLoaded(true);
      } finally {
        setSettingsLoaded(true);
      }
    };

    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, []);

  // Persist country changes immediately so downstream routes (/api/scrape
  // -> iTunes lookup, background re-sync) see the new storefront even if
  // the user quits before finishing onboarding.
  const updateCountry = useCallback(async (next: string) => {
    const normalised = normalizeCountry(next);
    setCountry(normalised);
    setCountryInferred(false);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_country: normalised }),
      });
    } catch (error) {
      // Non-fatal — search still uses the local state value via POST body.
      console.warn("[wizard] Failed to persist country setting:", error);
    }

    // Region → language suggestion. Probes /api/locale (the same
    // source LocaleSwitcher reads) and surfaces the banner when
    // the storefront's expected language disagrees with the
    // active UI locale. Failure is silent — the country itself
    // saved fine; the user can still switch language manually
    // from Settings → Language.
    try {
      const r = await fetch("/api/locale");
      if (r.ok) {
        const body = (await r.json()) as { locale?: string };
        const active = body.locale === "zh" ? "zh" : "en";
        if (normalised === "cn" && active === "en") {
          setLanguageSuggestion("zh");
        } else if (normalised !== "cn" && active === "zh") {
          setLanguageSuggestion("en");
        } else {
          setLanguageSuggestion(null);
        }
      }
    } catch {
      /* drop suggestion silently */
    }
  }, []);

  // Persist the accessibility toggle immediately so SettingsView and the
  // dashboard reflect the same choice as soon as the user flips it — even
  // if they abandon the wizard before finishing onboarding.
  const updateTrackAccessibility = useCallback(async (next: boolean) => {
    setTrackAccessibility(next);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_accessibility_labels: next }),
      });
    } catch (error) {
      console.warn("[wizard] Failed to persist accessibility setting:", error);
    }
  }, []);

  // Snapshot the tracked app list once when the wizard opens. We don't refetch
  // in the middle of the flow — the "already tracked" hint is a soft nudge, and
  // staleness here just means a newly-added row isn't flagged for that session.
  useEffect(() => {
    const loadTracked = async () => {
      try {
        const res = await fetch("/api/apps");
        if (!res.ok) {
          return;
        }
        const apps = (await res.json()) as Array<{
          id?: unknown;
          name?: unknown;
          developer?: unknown;
          bundleId?: unknown;
        }>;
        const byId = new Map<string, TrackedApp>();
        const byBundle = new Map<string, TrackedApp>();
        for (const raw of apps) {
          if (typeof raw?.id !== "string" || typeof raw?.name !== "string") {
            continue;
          }
          const entry: TrackedApp = {
            id: raw.id,
            name: raw.name,
            developer: typeof raw.developer === "string" ? raw.developer : "",
            bundleId:
              typeof raw.bundleId === "string" && raw.bundleId.length > 0
                ? raw.bundleId
                : null,
          };
          byId.set(entry.id, entry);
          if (entry.bundleId) {
            byBundle.set(entry.bundleId, entry);
          }
        }
        setTrackedByAppleId(byId);
        setTrackedByBundleId(byBundle);
      } catch (error) {
        // Non-fatal — duplicate detection is a convenience, not a hard stop.
        console.warn("[wizard] Failed to load tracked apps:", error);
      }
    };
    void loadTracked();
  }, []);

  // Names we hand to the App Store search pipeline. Web clips never
  // resolve there (no App Store record), so we route them out of the
  // search at the source and surface them in their own Step-3 section
  // instead. Without this filter they'd waste a bundle-Lookup round-
  // trip and then a name-search call before landing in "Not found".
  const getNames = useCallback(
    () => importedApps.filter((e) => !e.likelyWebClip).map((e) => e.name),
    [importedApps]
  );

  /**
   * Commit any uncommitted text in the ImportedAppsTable's "+ Add"
   * textarea into `importedApps` and return the parsed names that
   * landed on the list (post-dedup). Returning the names synchronously
   * matters because `setImportedApps` doesn't flush before the calling
   * frame finishes — `handleSearch` splices the returned list into its
   * search batch inline so users who type names directly into the
   * textarea and hit Search don't get an empty result set.
   */
  const flushPendingAppText = useCallback((): string[] => {
    if (!pendingAppText.trim()) {
      return [];
    }
    const parsed = parseManualAppText(pendingAppText);
    if (parsed.length === 0) {
      setPendingAppText("");
      return [];
    }
    const existing = new Set(importedApps.map((e) => e.name.toLowerCase()));
    const fresh = parsed.filter((n) => !existing.has(n.toLowerCase()));
    if (fresh.length > 0) {
      setImportedApps((prev) => [
        ...prev,
        ...fresh.map((name) =>
          makeImportedAppEntry({ name, source: "manual" })
        ),
      ]);
    }
    setPendingAppText("");
    return fresh;
  }, [pendingAppText, importedApps]);

  const parseTextFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text =
        typeof event.target?.result === "string" ? event.target.result : "";
      const parsed = parseImportedAppRows(text);
      const names = parsed.rows.map((r) => r.name);

      // Replace `importedApps` with one entry per parsed row. Developer
      // hints from CSV columns ride along on the entry rather than
      // living in a parallel map; `likelyWebClip` propagates so the
      // search fallback can recommend the manual-apps editor for rows
      // that look like home-screen web clips.
      setImportedApps(
        parsed.rows.map((row) =>
          makeImportedAppEntry({
            name: row.name,
            developer: row.developer,
            likelyWebClip: row.likelyWebClip,
            source: "file",
          })
        )
      );
      setUploadedFileName(file.name);
      setOcrError("");
      setSearchError("");

      // Surface truncation to the user so a 213-row CSV doesn't silently
      // lose rows. We report against the cap so they know exactly what
      // they're looking at.
      if (parsed.truncated) {
        setImportInfo(
          tStep2("import_info_truncated", {
            count: names.length,
            total: parsed.totalRowsInSource,
            cap: MAX_IMPORT_ROWS,
          })
        );
      } else if (names.length < parsed.totalRowsInSource) {
        const dropped = parsed.totalRowsInSource - names.length;
        setImportInfo(
          tStep2("import_info_deduped", {
            count: names.length,
            dropped,
          })
        );
      } else {
        setImportInfo("");
      }
    };
    reader.onerror = () => {
      setSearchError(tStatus("search_file_unreadable"));
    };
    reader.readAsText(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, []);

  const describeCfgutilDevice = useCallback(
    (device: ConnectedDevice): string => {
      if (device.name) {
        return device.name;
      }
      if (device.model) {
        return device.model;
      }
      if (device.deviceClass) {
        return device.deviceClass;
      }
      return tCfg("device_fallback");
    },
    [tCfg]
  );

  const describeCfgutilDeviceMeta = useCallback(
    (device: ConnectedDevice): string => {
      const bits = [
        device.deviceClass,
        device.model,
        device.iosVersion
          ? tCfg("device_ios_version", { version: device.iosVersion })
          : null,
      ].filter(
        (bit): bit is string => typeof bit === "string" && bit.trim().length > 0
      );
      return bits.length > 0 ? bits.join(" · ") : tCfg("device_meta_unknown");
    },
    [tCfg]
  );

  const formatCfgutilError = useCallback(
    (message: string): string => {
      const trimmed = message.trim();
      const lower = trimmed.toLowerCase();
      if (
        lower.includes("unknown option '--version'") ||
        lower.includes("unknown option --version")
      ) {
        return tCfg("error_unknown_version");
      }
      if (
        lower.includes("no devices are connected") ||
        lower.includes("no connected devices")
      ) {
        return tCfg("step3_no_devices");
      }
      if (
        lower.includes("trust") ||
        lower.includes("pair") ||
        lower.includes("passcode")
      ) {
        return tCfg("error_trust");
      }
      if (lower.includes("timed out") || lower.includes("did not finish")) {
        return tCfg("error_timeout");
      }
      const detail =
        trimmed.length > 260 ? `${trimmed.slice(0, 257)}...` : trimmed;
      return tCfg("error_generic", { detail });
    },
    [tCfg]
  );

  const refreshCfgutilDevices = useCallback(async (): Promise<
    ConnectedDevice[]
  > => {
    setCfgutilDevicesLoading(true);
    try {
      const result = await listConnectedDevices();
      if (!result) {
        setCfgutilDevices([]);
        setSelectedCfgutilEcid(null);
        return [];
      }
      if (result.cfgutilUnavailable) {
        setCfgutilDevices([]);
        setSelectedCfgutilEcid(null);
        setCfgutilError(tCfg("step2_copy_not_found"));
        return [];
      }

      setCfgutilDevices(result.devices);
      setSelectedCfgutilEcid((prev) => {
        if (prev && result.devices.some((device) => device.ecid === prev)) {
          return prev;
        }
        if (result.devices.length === 1) {
          return result.devices[0].ecid;
        }
        return null;
      });
      return result.devices;
    } finally {
      setCfgutilDevicesLoading(false);
    }
  }, [tCfg]);

  /**
   * Trigger the Rust-side `check_cfgutil` probe. Kept as a dedicated callback
   * so the button can show a spinner while it's in flight, and so we can
   * reset `cfgutilError` on every click — users retry after installing the
   * automation tools, and a stale error message from the previous attempt
   * would be misleading.
   */
  const runCfgutilCheck = useCallback(async () => {
    setCfgutilChecking(true);
    setCfgutilError("");
    // Yield a frame so React paints the "Checking…" button state BEFORE
    // we hand control to the Tauri IPC bridge. Without this, the click
    // handler chain is: setState → microtask scheduling → await
    // checkCfgutil() → blocks for the lifetime of the Rust probe → set
    // state back. The browser never gets a chance to render the
    // spinner / disabled state, so users see a frozen button and assume
    // the app is broken. requestAnimationFrame guarantees one paint
    // frame happens between the state flip and the slow IPC.
    // (Same pattern used by runCfgutilExportClick below — keep them
    // in sync if either grows more complexity.)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
    try {
      const result = await checkCfgutil();
      setCfgutilCheck(result);
      if (result && !result.available && result.error) {
        // Surface the reason inline. We keep it on `cfgutilCheck.error` too,
        // but the wizard's error chip reads from `cfgutilError` so a fresh
        // "nothing connected" failure from a *later* export attempt doesn't
        // collide with the original detection message.
        setCfgutilError(formatCfgutilError(result.error));
        setCfgutilDevices([]);
        setSelectedCfgutilEcid(null);
      } else if (result?.available) {
        await refreshCfgutilDevices();
      }
    } catch (err) {
      console.error("[cfgutil] check failed", err);
      setCfgutilError(
        formatCfgutilError(err instanceof Error ? err.message : String(err))
      );
      setCfgutilDevices([]);
      setSelectedCfgutilEcid(null);
    } finally {
      setCfgutilChecking(false);
    }
  }, [formatCfgutilError, refreshCfgutilDevices]);

  /**
   * Invoke `run_cfgutil_export`, flatten the response into the Step-2 name
   * list, and carry the per-app vendor string across as a developer hint so
   * Step 3's ranking can prefer the right candidate when the App Store
   * returns multiple matches (common for generic names like "Calendar").
   *
   * The Rust command scopes to one selected device when we pass an ECID.
   * The onboarding button now requires that selection so a Mac with two
   * phones plugged in does not silently merge both app libraries.
   */
  const runCfgutilExportClick = useCallback(
    async (scopedEcid?: string) => {
      setCfgutilExporting(true);
      setCfgutilError("");
      setCfgutilDiagnostic(null);
      // Yield a frame so React paints the progress overlay BEFORE we
      // hand control to the Tauri IPC bridge. Without this, the click
      // handler chain looks like: setState → microtask scheduling →
      // await invoke('run_cfgutil_export') → 30-90s of sync wait → set
      // state back. The browser never gets a chance to lay out the
      // overlay element, so users only see the macOS beach-ball cursor
      // with no in-app indicator. requestAnimationFrame guarantees one
      // paint frame happens between flipping the boolean and starting
      // the slow IPC.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
      try {
        let targetEcid = scopedEcid ?? selectedCfgutilEcid ?? null;
        let devices = cfgutilDevices;
        if (!targetEcid) {
          devices = await refreshCfgutilDevices();
          if (devices.length === 1) {
            targetEcid = devices[0].ecid;
            setSelectedCfgutilEcid(targetEcid);
          } else if (devices.length > 1) {
            setCfgutilError(tCfg("step3_select_required"));
            return;
          } else {
            setCfgutilError(tCfg("step3_no_devices"));
            return;
          }
        }

        const selectedDevice = devices.find(
          (device) => device.ecid === targetEcid
        );
        const result = await runCfgutilExport(targetEcid);
        // Record that cfgutil was successfully used at least once on this
        // install. The device-connect toast on /onboard subscribes to USB
        // attach events only when this flag is set — keeps the cost off
        // users who never adopted the cfgutil workflow.
        if (result.apps.length > 0) {
          void fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cfgutil_imported_at: Date.now() }),
          }).catch(() => {
            // Non-fatal — the import succeeded; the gate just stays off
            // until the next successful cfgutil run.
          });
        }
        if (result.apps.length === 0) {
          setCfgutilError(
            result.deviceCount === 0
              ? tCfg("step3_no_devices")
              : tCfg("step3_no_apps")
          );
          // Stash the raw cfgutil JSON so the UI can render a "Show
          // diagnostic output" disclosure under the error. Truncated
          // upstream of display to keep the DOM cheap when a phone
          // with 400+ apps still came back parseable but our extractor
          // missed every row.
          if (result.rawStdout && result.rawStdout.trim().length > 0) {
            setCfgutilDiagnostic(result.rawStdout);
          }
          return;
        }

        // cfgutil's Rust side already dedupes by `bundleIdentifier` across
        // every connected device (see src-tauri/src/cfgutil.rs), so
        // `result.apps` holds N entries each representing a *distinct*
        // installed app. But two of those entries can still share the
        // same display name — e.g. Apple's Calculator + a third-party
        // "Calculator" with different bundleIDs, or a TestFlight beta
        // with the same `displayName` as the production install. The
        // wizard's downstream pipeline keys searches by name, so it
        // collapses those collisions case-insensitively in
        // `parseManualAppText` before issuing iTunes Search lookups —
        // otherwise the same query would run twice and almost certainly
        // map to the same App Store record anyway.
        //
        // We mirror that dedupe here so the upload-summary count and
        // the "X apps ready to match" header always agree. Without this
        // mirror, users see "Imported 214 apps" then "212 ready to
        // match" and (rightly) wonder where the 2 went. We also stash
        // the difference so the summary can explicitly call it out
        // ("2 duplicate names merged for matching") rather than
        // silently shrinking the count.
        // Dedupe by lowercased name so the "X apps ready to match"
        // count matches the user's "Imported N apps" expectation —
        // collapsing duplicates that crept in from cfgutil's per-device
        // listing.
        const seenLower = new Set<string>();
        const dedupedApps: typeof result.apps = [];
        for (const app of result.apps) {
          const trimmed = app.name?.trim() ?? "";
          if (!trimmed) {
            continue;
          }
          const key = trimmed.toLocaleLowerCase();
          if (seenLower.has(key)) {
            continue;
          }
          seenLower.add(key);
          dedupedApps.push(app);
        }
        const mergedDuplicates = result.apps.length - dedupedApps.length;

        // Replace `importedApps` with one structured entry per cfgutil
        // app. Bundle IDs and developer hints both ride on the entry, so
        // editing the list later (removing rows) can't silently drop the
        // bundle-lookup advantage that cfgutil imports get to enjoy in
        // handleSearch.
        setImportedApps(
          dedupedApps.map((app) => {
            const bundleId = app.bundleId?.trim() || undefined;
            // Safari web clips (`com.apple.WebKit.PushBundle.<UUID>` and the
            // older `com.apple.webapp.*` variant) sit on the device's
            // installed-apps list but have no App Store record. Mark them
            // here so the wizard can divert them into the manual-apps
            // pipeline instead of wasting a Lookup round-trip + name
            // search and then leaving them in "Not in App Store" limbo.
            const isWebClip = isLikelyWebClipBundle(bundleId);
            return makeImportedAppEntry({
              name: app.name.trim(),
              developer: app.developer?.trim() || undefined,
              bundleId,
              source: "cfgutil",
              likelyWebClip: isWebClip || undefined,
            });
          })
        );
        // Encode the device class as a structured " · "-delimited segment
        // ahead of the friendly name so the import-history renderer
        // (SettingsView) can pick out an icon for the entry. Format:
        //   "Apple Configurator · iPhone · Aria's iPhone"
        //                          ^^^^^^   ^^^^^^^^^^^^^
        //                          class    user-named device
        // Falls back to the bare friendly name when cfgutil didn't
        // surface a deviceClass (older builds or anonymous-device
        // states), so the label stays readable either way.
        const deviceFriendly = selectedDevice
          ? describeCfgutilDevice(selectedDevice)
          : null;
        const deviceClass = selectedDevice?.deviceClass?.trim() || null;
        const deviceLabel = selectedDevice
          ? deviceClass && deviceClass !== deviceFriendly
            ? `${deviceClass} · ${deviceFriendly}`
            : (deviceFriendly ?? "")
          : `${result.deviceCount} device${result.deviceCount === 1 ? "" : "s"}`;
        setUploadedFileName(
          selectedDevice
            ? `Apple Configurator · ${deviceLabel}`
            : `Apple Configurator (${deviceLabel})`
        );
        setOcrError("");
        setSearchError("");
        // Use the *deduped* count so this number agrees with the
        // "X apps ready to match" header that the wizard list renders
        // below — both come from the same set now.
        const importedSummary = tCfg("step3_imported_count", {
          count: dedupedApps.length,
          device: selectedDevice
            ? describeCfgutilDevice(selectedDevice)
            : tCfg("device_fallback"),
        });
        // When cfgutil reported more raw entries than we kept after the
        // case-insensitive name dedupe, append a one-line note so the
        // user knows where the missing rows went. Common causes are a
        // TestFlight beta + production with the same display name, or
        // two genuinely-different apps that happen to share a label
        // ("Calculator", "Notes"). The note uses a translator-friendly
        // sub-key so locales can phrase the parenthetical naturally.
        const summaryWithNote =
          mergedDuplicates > 0
            ? `${importedSummary} ${tCfg("step3_merged_duplicates", { count: mergedDuplicates })}`
            : importedSummary;
        setImportInfo(summaryWithNote);
      } catch (err) {
        console.error("[cfgutil] export failed", err);
        setCfgutilError(
          formatCfgutilError(err instanceof Error ? err.message : String(err))
        );
      } finally {
        setCfgutilExporting(false);
      }
    },
    [
      cfgutilDevices,
      describeCfgutilDevice,
      formatCfgutilError,
      refreshCfgutilDevices,
      selectedCfgutilEcid,
      tCfg,
    ]
  );

  // Phase 4 device-connect deep-link. The Apps grid renders a toast
  // when a device is plugged in; clicking "Import apps" routes here
  // with `?source=cfgutil`. We pick that up on mount, switch the
  // method picker to "configurator", and fire the existing export
  // flow once so the user lands on Step 2 with their device's apps
  // already populated. No-op when the param is absent. Runs once at
  // mount; the auto-trigger only fires for the cfgutil source so a
  // user navigating to /onboard via the normal "Add Apps" button
  // sees the unprimed picker as before.
  const searchParams = useSearchParams();

  /**
   * Dev-only preview mode — `/onboard?preview=fresh` from the dev menu
   * popover routes here. The wizard renders normally so devs can
   * walk through the same flow new users see, but the final
   * submit-to-server steps (Step 4 scrape batch) short-circuit so
   * clicking through doesn't actually commit any state. A banner
   * across the top makes the mode obvious; nothing else changes.
   * Read once via `?preview=fresh` so refreshing inside the wizard
   * keeps the mode active until the user navigates away manually.
   */
  const isPreviewMode = searchParams?.get("preview") === "fresh";

  /**
   * Re-sync mode — `/onboard?resync=<deviceId>` routes here from the
   * Settings → Devices page (or any other "re-sync this device" entry
   * point). When set, the wizard:
   *   - skips the device-resolution heuristics in createImportRecord
   *     and uses the pre-selected device id directly;
   *   - after the scrape finishes (done=true), opens the diff overlay
   *     so the user can choose which adds/removes to apply.
   *
   * Initial value comes from the URL on mount. Additionally, when the
   * cfgutil step detects a connected device whose ECID matches an
   * existing device row, the wizard *upgrades* into re-sync mode
   * programmatically — see the `priorImportHistory` effect below. */
  const initialResyncDeviceIdFromUrl = (() => {
    const raw = searchParams?.get("resync");
    if (typeof raw !== "string") {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  })();
  const [resyncDeviceId, setResyncDeviceId] = useState<string | null>(
    initialResyncDeviceIdFromUrl
  );
  const [resyncOverlayOpen, setResyncOverlayOpen] = useState(false);
  const [resyncOverlayApps, setResyncOverlayApps] = useState<
    Array<{ appId: string; name: string; developer?: string | null }>
  >([]);

  /**
   * Prior-import history for the cfgutil device the user has picked.
   * Populated by an effect (below) that hits `/api/devices?ecid=<ecid>`
   * whenever the selected ECID changes. Drives the "Previously imported
   * · N times" badge above the cfgutil app list. `null` means we
   * haven't checked yet OR no matching device row exists yet.
   */
  const [priorImportHistory, setPriorImportHistory] = useState<{
    deviceId: string;
    deviceName: string;
    count: number;
    lastCompletedAt: number | null;
  } | null>(null);

  // Step-2 upfront diff state. Lives only on the auto-resync path
  // (cfgutil detects a known ECID without an explicit `?resync=` URL
  // param). The URL-supplied entry point keeps the post-scrape overlay
  // — that's the Settings → Devices "Re-sync" flow. Here, the diff
  // happens BEFORE step 3 so removes apply atomically and only the
  // selected adds proceed through iTunes matching + scraping.
  const [step2DiffConfirmOpen, setStep2DiffConfirmOpen] = useState(false);
  const [step2DiffCommitting, setStep2DiffCommitting] = useState(false);
  const [step2DiffPicked, setStep2DiffPicked] = useState<{
    pickedEntryIds: string[];
    pickedRemoveAppIds: string[];
    addCount: number;
    removeCount: number;
  } | null>(null);

  /**
   * True iff the wizard is in the *auto-resync* mode (cfgutil detected
   * an ECID that matches an existing device, no `?resync=` URL param).
   * That entry point uses the upfront step-2 diff; the URL entry point
   * (Settings → Devices "Re-sync") keeps the post-scrape overlay.
   */
  const isAutoResyncCfgutil =
    method === "configurator" &&
    !!resyncDeviceId &&
    !initialResyncDeviceIdFromUrl;

  // Lookup the connected cfgutil device by ECID. When a match exists,
  // (a) cache the import-history summary for the badge, and (b) auto-
  // upgrade the wizard into re-sync mode so the post-scrape diff
  // overlay fires. Without this the user would silently get a new
  // device row + duplicate links each time they reconnect — defeating
  // the whole device-tracking story. URL-supplied resyncDeviceId still
  // wins over the auto-upgrade (treat manual entry-point as
  // authoritative).
  useEffect(() => {
    const ecid = selectedCfgutilEcid;
    if (!ecid) {
      setPriorImportHistory(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/devices?ecid=${encodeURIComponent(ecid)}`,
          {
            cache: "no-store",
          }
        );
        if (!res.ok) {
          return;
        }
        const json = await res.json();
        if (cancelled) {
          return;
        }
        if (json?.device?.id) {
          setPriorImportHistory({
            deviceId: json.device.id,
            deviceName: json.device.name ?? "",
            count: json.importHistory?.count ?? 0,
            lastCompletedAt: json.importHistory?.lastCompletedAt ?? null,
          });
          // Auto-upgrade: implicit re-sync when the ECID is known and no
          // explicit `?resync=` was supplied. The user is reconnecting a
          // known device, so the diff workflow is what they want.
          if (!initialResyncDeviceIdFromUrl) {
            setResyncDeviceId(json.device.id);
          }
        } else {
          setPriorImportHistory(null);
        }
      } catch (error) {
        console.warn("[wizard] device lookup by ECID failed:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCfgutilEcid, initialResyncDeviceIdFromUrl]);

  useEffect(() => {
    if (draftRestored) {
      return;
    }
    if (isPreviewMode || searchParams?.get("source") === "cfgutil") {
      setDraftRestored(true);
      return;
    }
    try {
      const raw = window.localStorage.getItem(ONBOARDING_DRAFT_STORAGE_KEY);
      if (!raw) {
        setDraftRestored(true);
        return;
      }
      const draft = JSON.parse(raw) as {
        step?: Step;
        method?: ImportMethod;
        country?: string;
        // Newer drafts persist the full structured list; older drafts
        // (pre-table refactor) only have `namesText`. Both shapes are
        // accepted so existing in-flight drafts don't silently fail to
        // restore.
        importedApps?: ImportedAppEntry[];
        namesText?: string;
        uploadedFileName?: string;
        importId?: string | null;
        searchResults?: SearchResult[];
        selected?: [string, string][];
        skipped?: string[];
        manual?: string[];
      };
      if (
        draft.method &&
        ["screenshots", "file", "configurator", "manual"].includes(draft.method)
      ) {
        setMethod(draft.method);
      }
      if (typeof draft.country === "string") {
        setCountry(normalizeCountry(draft.country));
      }
      if (Array.isArray(draft.importedApps) && draft.importedApps.length > 0) {
        // Re-generate ids so they're stable for the current render tree
        // (and so old non-UUID ids from a different session don't clash
        // with anything new). Other fields pass through unchanged.
        setImportedApps(
          draft.importedApps
            .map((entry) =>
              makeImportedAppEntry({
                name: typeof entry.name === "string" ? entry.name : "",
                developer: entry.developer,
                bundleId: entry.bundleId,
                likelyWebClip: entry.likelyWebClip,
                source: (
                  ["manual", "cfgutil", "file", "ocr"] as const
                ).includes(entry.source as never)
                  ? entry.source
                  : "manual",
              })
            )
            .filter((entry) => entry.name.trim().length > 0)
        );
      } else if (
        typeof draft.namesText === "string" &&
        draft.namesText.length > 0
      ) {
        // Back-compat: old draft with raw text; reconstitute as manual
        // entries. Names-only — any bundle ID / developer hints stored
        // separately on the old draft are lost on this read path, which
        // matches the existing fragility (the old maps were keyed by
        // lowercased name and didn't survive the textarea edits either).
        const names = parseManualAppText(draft.namesText);
        setImportedApps(
          names.map((name) => makeImportedAppEntry({ name, source: "manual" }))
        );
      }
      if (typeof draft.uploadedFileName === "string") {
        setUploadedFileName(draft.uploadedFileName);
      }
      if (typeof draft.importId === "string") {
        setImportId(draft.importId);
      }
      const restoredResults = Array.isArray(draft.searchResults)
        ? draft.searchResults.filter(
            (result) =>
              result &&
              typeof result.query === "string" &&
              Array.isArray(result.candidates)
          )
        : [];
      if (restoredResults.length > 0) {
        setSearchResults(restoredResults);
        const selectedIds = new Map(
          Array.isArray(draft.selected) ? draft.selected : []
        );
        const nextSelected = new Map<string, AppCandidate>();
        for (const result of restoredResults) {
          const selectedId = selectedIds.get(result.query);
          const candidate = selectedId
            ? result.candidates.find((c) => c.appleId === selectedId)
            : result.candidates[0];
          if (
            candidate &&
            result.status !== "skipped" &&
            result.status !== "pending"
          ) {
            nextSelected.set(result.query, candidate);
          }
        }
        setSelected(nextSelected);
        setSkippedQueries(
          new Set(Array.isArray(draft.skipped) ? draft.skipped : [])
        );
        setManuallyChosenQueries(
          new Set(Array.isArray(draft.manual) ? draft.manual : [])
        );
      }
      if (draft.step === 2 || draft.step === 3) {
        setStep(draft.step);
      }
    } catch (error) {
      console.warn("[wizard] Failed to restore onboarding draft:", error);
      window.localStorage.removeItem(ONBOARDING_DRAFT_STORAGE_KEY);
    } finally {
      setDraftRestored(true);
    }
  }, [draftRestored, isPreviewMode, searchParams]);

  useEffect(() => {
    if (!draftRestored || isPreviewMode) {
      return;
    }
    try {
      const hasUsefulDraft =
        importedApps.length > 0 || searchResults.length > 0;
      if (!hasUsefulDraft || step >= 4) {
        window.localStorage.removeItem(ONBOARDING_DRAFT_STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(
        ONBOARDING_DRAFT_STORAGE_KEY,
        JSON.stringify({
          step,
          method,
          country,
          // Persist the structured array directly so bundle IDs +
          // developer hints survive a reload. Drop the runtime `id`
          // field — it's regenerated on restore.
          importedApps: importedApps.map(({ id: _id, ...rest }) => rest),
          uploadedFileName,
          importId,
          searchResults,
          selected: Array.from(selected.entries()).map(([query, candidate]) => [
            query,
            candidate.appleId,
          ]),
          skipped: Array.from(skippedQueries),
          manual: Array.from(manuallyChosenQueries),
        })
      );
    } catch (error) {
      console.warn("[wizard] Failed to persist onboarding draft:", error);
    }
  }, [
    country,
    draftRestored,
    importId,
    importedApps,
    isPreviewMode,
    manuallyChosenQueries,
    method,
    searchResults,
    selected,
    skippedQueries,
    step,
    uploadedFileName,
  ]);

  const cfgutilAutoArmedRef = useRef(false);
  useEffect(() => {
    if (cfgutilAutoArmedRef.current) {
      return;
    }
    if (searchParams?.get("source") !== "cfgutil") {
      return;
    }
    if (!onboardMethodConfiguratorOn) {
      return;
    }
    cfgutilAutoArmedRef.current = true;
    userSelectedMethodRef.current = false;
    setMethod("configurator");
    // Land on Step 2 directly. The device-connect toast's "Import
    // apps" CTA is the user already saying "yes, configurator, this
    // device" — there's no value in showing them the method picker
    // again. Before this, the user clicked through from the toast and
    // saw the Step 1 "Continue with Apple Configurator" prompt as if
    // they hadn't already picked, which is the bug they reported.
    setStep(2);
    // ECID flows through as a query param on the toast's deep-link
    // so the export can scope to the specific device the user
    // clicked. Falling through to undefined when the param is absent
    // preserves the multi-device fan-out behaviour the wizard's
    // manual button has always had.
    const ecid = searchParams?.get("ecid") ?? undefined;
    // Defer the actual export by one tick so the method-card UI has
    // a chance to render the picker first — without this, the user
    // would see the export's loading spinner before the wizard
    // visibly switches modes, which feels broken.
    const timer = setTimeout(() => {
      runCfgutilExportClick(ecid);
    }, 80);
    return () => clearTimeout(timer);
  }, [searchParams, runCfgutilExportClick, onboardMethodConfiguratorOn]);

  const runOcr = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      setOcring(true);
      setOcrError("");
      setOcrErrorDetail("");
      setOcrMessage(tStatus("ocr_preparing"));
      setSearchError("");

      // Diagnostics: the OCR path has a lot of async hops that can hang
      // silently (tesseract.js dynamic import, WASM download, traineddata
      // fetch, per-image recognize, worker terminate). The hang in the
      // wild came with zero console output, so this function narrates
      // every step with timings. In dev builds the narration goes to the
      // devtools console; in production we stay quiet by default but
      // honour `localStorage.setItem('debug:ocr', '1')` for users who can
      // be asked to enable it when reporting "it just spun forever".
      const ocrDebug =
        process.env.NODE_ENV !== "production" ||
        (typeof window !== "undefined" &&
          window.localStorage?.getItem("debug:ocr") === "1");
      const t0 = performance.now();
      const mark = (label: string, extra?: Record<string, unknown>) => {
        if (!ocrDebug) {
          return;
        }
        const ms = Math.round(performance.now() - t0);
        if (extra) {
          console.log(`[ocr] +${ms}ms ${label}`, extra);
        } else {
          console.log(`[ocr] +${ms}ms ${label}`);
        }
      };

      mark("start", {
        fileCount: files.length,
        files: files.map((f) => ({
          name: f.name,
          type: f.type,
          bytes: f.size,
        })),
        isIosSafari,
        ua:
          typeof navigator === "undefined"
            ? "(no navigator)"
            : navigator.userAgent,
        crossOriginIsolated:
          typeof globalThis !== "undefined" &&
          "crossOriginIsolated" in globalThis
            ? (globalThis as { crossOriginIsolated?: boolean })
                .crossOriginIsolated
            : "(unknown)",
      });

      try {
        mark("dynamic-import tesseract.js: begin");
        const { createWorker } = await import("tesseract.js");
        mark("dynamic-import tesseract.js: resolved");

        mark("createWorker(eng): begin");
        // tesseract.js's createWorker accepts a logger callback which fires
        // for every phase transition (loading core, downloading traineddata,
        // recognizing). Wiring it to console lets us see whether the hang
        // is in the WASM download, the traineddata fetch, or the recognize
        // loop itself — the three places this most often stalls on flaky
        // networks / strict CSPs / iOS WebKit.
        const worker = await createWorker("eng", 1, {
          logger: (msg: {
            status?: string;
            progress?: number;
            [k: string]: unknown;
          }) => {
            if (!ocrDebug) {
              return;
            }
            const pct =
              typeof msg.progress === "number"
                ? `${Math.round(msg.progress * 100)}%`
                : "—";
            console.log(
              `[ocr] tesseract.logger status="${msg.status ?? "?"}" progress=${pct}`,
              msg
            );
          },
          errorHandler: (err: unknown) => {
            // Errors still surface unconditionally — silent failure is
            // exactly the diagnostic problem the rest of this gating was
            // introduced to *not* reintroduce.
            console.error("[ocr] tesseract.errorHandler", err);
          },
        });
        mark("createWorker(eng): resolved");

        try {
          const extractedBlocks: string[] = [];
          for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            setOcrMessage(
              tStep2("ocr_reading", {
                current: index + 1,
                total: files.length,
              })
            );
            mark(`recognize[${index + 1}/${files.length}]: begin`, {
              name: file.name,
              type: file.type,
              bytes: file.size,
            });
            const objectUrl = URL.createObjectURL(file);

            try {
              const result = await worker.recognize(objectUrl);
              const textLen = (result.data.text ?? "").length;
              mark(`recognize[${index + 1}/${files.length}]: resolved`, {
                textChars: textLen,
                confidence: result.data.confidence,
              });
              extractedBlocks.push(result.data.text ?? "");
            } catch (perImageError) {
              // Per-image errors used to blow out the whole loop and surface as
              // a single fatal message. Keep going — a single bad screenshot
              // shouldn't cost the user every other extraction — but log so we
              // can see exactly which image choked the worker.
              console.error(
                `[ocr] recognize[${index + 1}/${files.length}] threw`,
                perImageError
              );
            } finally {
              URL.revokeObjectURL(objectUrl);
            }
          }
          mark("recognize loop: done", { blocks: extractedBlocks.length });

          const names = extractAppNamesFromOcr(extractedBlocks.join("\n"));
          mark("extractAppNamesFromOcr: done", { names: names.length });
          if (names.length === 0) {
            setOcrError(tStatus("ocr_no_confident_matches"));
            setOcrMessage("");
            return;
          }

          setImportedApps(
            names.map((name) => makeImportedAppEntry({ name, source: "ocr" }))
          );
          // Heuristic: fewer than ~3 names per image usually means the user
          // screenshotted a Home Screen with icon-only folders. Nudge them to
          // try a flat list like iPhone Storage. We don't *block* — the names
          // we did find still go into the table for review.
          const namesPerImage = names.length / Math.max(1, files.length);
          if (namesPerImage < 3) {
            setOcrMessage(tStep2("ocr_light_result", { count: names.length }));
          } else {
            setOcrMessage(tStep2("ocr_extracted", { count: names.length }));
          }
        } finally {
          mark("worker.terminate: begin");
          await worker.terminate();
          mark("worker.terminate: done");
        }
      } catch (error) {
        mark("fatal error (outer catch)", {
          kind: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        });
        console.error("[ocr] fatal", error);
        // Expose the real error to the UI under a collapsed `<details>` so the
        // user (or us, when triaging a support report) can see the underlying
        // tesseract.js / WASM / network failure instead of just "it failed".
        const detail = (() => {
          if (error instanceof Error) {
            return error.message || error.name || String(error);
          }
          if (typeof error === "string") {
            return error;
          }
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();
        setOcrErrorDetail(detail.slice(0, 500));
        if (isIosSafari) {
          // iOS WebKit almost always falls through here — give the user a clear
          // recommendation to switch paths rather than retrying fruitlessly.
          setOcrError(tStatus("ocr_safari_help"));
        } else {
          setOcrError(tStatus("ocr_browser_failed"));
        }
        setOcrMessage("");
      } finally {
        mark("runOcr: finally (clearing ocring flag)");
        setOcring(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
    },
    [isIosSafari]
  );

  const handleTextDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDraggingText(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        parseTextFile(file);
      }
    },
    [parseTextFile]
  );

  const handleImageDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDraggingImages(false);
      const files = Array.from(event.dataTransfer.files ?? []).filter((file) =>
        file.type.startsWith("image/")
      );
      if (files.length === 0) {
        return;
      }
      setImageFiles(files);
      void runOcr(files);
    },
    [runOcr]
  );

  const handleImageSelection = useCallback(
    (files: FileList | null) => {
      const nextFiles = Array.from(files ?? []).filter((file) =>
        file.type.startsWith("image/")
      );
      if (nextFiles.length === 0) {
        return;
      }
      setImageFiles(nextFiles);
      void runOcr(nextFiles);
    },
    [runOcr]
  );

  const deriveImportLabel = useCallback((): string => {
    if (method === "configurator" && uploadedFileName) {
      return `Apple Configurator · ${uploadedFileName}`;
    }
    if (method === "configurator") {
      return `Apple Configurator export · ${new Date().toLocaleDateString()}`;
    }
    if (method === "file" && uploadedFileName) {
      return uploadedFileName;
    }
    if (method === "screenshots" && imageFiles.length > 0) {
      return `${imageFiles.length} screenshot${imageFiles.length === 1 ? "" : "s"}`;
    }
    return `Manual entry · ${new Date().toLocaleDateString()}`;
  }, [method, uploadedFileName, imageFiles.length]);

  /**
   * Resolve (or create) a device row for this import session. The
   * device-aware re-sync feature attaches every import to a device so we
   * can later compute "what's been added / removed since last time" for
   * that device.
   *
   *   - cfgutil: look up by ECID (Apple Configurator's stable per-device
   *     id) and refresh metadata. If first time, the device row is
   *     created with the user's chosen device name from cfgutil's
   *     `cfgutil get name` call.
   *   - file/manual/screenshots: derive a sensible default name from the
   *     context (filename / "Manual entry · DATE" / "{N} screenshots").
   *     Users can rename later from Settings → Devices.
   *
   * Best-effort: any failure resolves to `null` so the import still
   * completes (it just won't be device-attached, the same as legacy
   * imports before this feature shipped).
   */
  const resolveDeviceIdForImport = useCallback(async (): Promise<
    string | null
  > => {
    // Re-sync mode: caller already picked the device. Don't create a new
    // device row; just use the one being re-synced.
    if (resyncDeviceId) {
      return resyncDeviceId;
    }
    try {
      // Cfgutil path: prefer the live `selectedCfgutilDevice` reading.
      const cfgDevice =
        cfgutilDevices.find((d) => d.ecid === selectedCfgutilEcid) ?? null;
      if (method === "configurator" && cfgDevice?.ecid) {
        const res = await fetch("/api/devices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: cfgDevice.name?.trim() || cfgDevice.ecid,
            ecid: cfgDevice.ecid,
            model: cfgDevice.model ?? null,
            iosVersion: cfgDevice.iosVersion ?? null,
            deviceClass: cfgDevice.deviceClass ?? null,
          }),
        });
        const json = await res.json();
        if (res.ok && typeof json?.device?.id === "string") {
          return json.device.id;
        }
        return null;
      }
      // Non-cfgutil paths: derive a device label from the import context.
      let defaultName = "";
      if (method === "file" && uploadedFileName) {
        defaultName = uploadedFileName;
      } else if (method === "screenshots") {
        defaultName = `Screenshots · ${new Date().toLocaleDateString()}`;
      } else if (method === "manual") {
        defaultName = `Manual entry · ${new Date().toLocaleDateString()}`;
      } else {
        defaultName = deriveImportLabel();
      }
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: defaultName }),
      });
      const json = await res.json();
      if (res.ok && typeof json?.device?.id === "string") {
        return json.device.id;
      }
      return null;
    } catch (error) {
      console.warn("[wizard] resolveDeviceIdForImport failed:", error);
      return null;
    }
  }, [
    method,
    cfgutilDevices,
    selectedCfgutilEcid,
    uploadedFileName,
    deriveImportLabel,
    resyncDeviceId,
  ]);

  const createImportRecord = useCallback(
    async (total: number): Promise<string | null> => {
      const startedAt = performance.now();
      recordImportEvent("onboarding.import.create.start", { total, method });
      try {
        // Best-effort device resolution. Imports without a device still
        // work; they just don't participate in the re-sync diff flow.
        const deviceId = await resolveDeviceIdForImport();
        const res = await fetch("/api/imports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: persistedSourceForMethod(method),
            sourceLabel: deriveImportLabel(),
            total,
            deviceId,
          }),
        });
        const data = await res.json();
        if (!res.ok || typeof data?.id !== "string") {
          recordImportEvent("onboarding.import.create.error", {
            status: res.status,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return null;
        }
        recordImportEvent("onboarding.import.create.complete", {
          durationMs: Math.round(performance.now() - startedAt),
        });
        return data.id;
      } catch (error) {
        console.error("[wizard] Failed to create import record:", error);
        recordImportEvent("onboarding.import.create.error", {
          durationMs: Math.round(performance.now() - startedAt),
          error:
            error instanceof Error
              ? error.message.slice(0, 120)
              : String(error).slice(0, 120),
        });
        return null;
      }
    },
    [method, deriveImportLabel, resolveDeviceIdForImport]
  );

  const writeImportItems = useCallback(
    async (
      currentImportId: string,
      results: SearchResult[],
      autoSelected: Map<string, AppCandidate>,
      queuedRows?: { name: string; developer?: string }[],
      queuedRetryAfterMs?: number,
      /**
       * Every name the user submitted in this batch. When `/api/search`
       * returned a 500 (or Apple 429'd us before sending *any* candidates
       * back), the `results` array and the `queuedRows` tail can both be
       * empty — without `allNames` we'd end up writing zero items for
       * an import with `total = N`, which is exactly the "dev log shows
       * total=210 but matched=0/imported=0/errored=0" bug.
       *
       * Any names not present in `results` *or* `queuedRows` get persisted
       * as `status='unmatched'` placeholders so Import History shows a
       * complete picture of the batch and the user can re-run the search
       * on the missing rows from the "Resume matching" button.
       */
      allNames?: string[]
    ): Promise<Map<string, string>> => {
      interface ImportItemsPayloadEntry {
        appId?: string;
        appName?: string;
        country?: string;
        developer?: string | null;
        iconUrl?: string;
        query: string;
        retryAfterMs?: number | null;
        scrapeError?: string | null;
        status: "matched" | "unmatched" | "skipped" | "pending_search";
        url?: string;
      }
      const searchedPayload: ImportItemsPayloadEntry[] =
        results.flatMap<ImportItemsPayloadEntry>((result) => {
          if (result.status === "pending") {
            return [];
          }
          const chosen = autoSelected.get(result.query);
          if (!chosen) {
            return [
              {
                query: result.query,
                status:
                  result.status === "skipped"
                    ? ("skipped" as const)
                    : ("unmatched" as const),
                country,
              },
            ];
          }
          return [
            {
              query: result.query,
              status: "matched" as const,
              appId: chosen.appleId,
              appName: chosen.name,
              developer: chosen.developer,
              url: chosen.url,
              // Capture at match time so a later 'queued' row still has an icon
              // to render in Import History even if the scrape never succeeds.
              iconUrl: chosen.iconUrl,
              country,
            },
          ];
        });

      // Persist names the search couldn't process yet because Apple 429'd us
      // as `status='pending_search'` so they show up in Import History
      // immediately. When the QueuedSearchProvider retries later, the same
      // endpoint upserts by (importId, query), swapping the row to 'matched'
      // with the resolved `url` in place. Without this, a rate-limited batch
      // would leave the import with `itemCount === 0` and the user would see
      // the "No per-app history" empty state even though the import
      // genuinely has work in flight.
      //
      // Crucially this is NOT `status='queued'`: the server-side import-queue
      // worker only claims 'queued' rows (which always have a URL — they're
      // scrape retries). Mixing the two would cause the worker to mass-error
      // every URL-less row it claimed.
      const queuedPayload = (queuedRows ?? []).map((row) => ({
        query: row.name,
        status: "pending_search" as const,
        developer: row.developer ?? null,
        country,
        scrapeError: tStatus("scrape_error_rate_limited"),
        retryAfterMs: queuedRetryAfterMs ?? null,
      }));

      // Fallback: any name the user submitted that didn't end up in
      // `results` or `queuedRows` gets written as an `unmatched` placeholder.
      // The upsert in `addImportItems` keyed by (importId, query) makes this
      // safe — a later successful search rewrites the row in-place to
      // `matched` without creating duplicates.
      const alreadyRepresented = new Set<string>();
      for (const item of searchedPayload) {
        alreadyRepresented.add(item.query);
      }
      for (const item of queuedPayload) {
        alreadyRepresented.add(item.query);
      }
      const fallbackPayload = (allNames ?? [])
        .filter((name) => !alreadyRepresented.has(name))
        .map((name) => ({
          query: name,
          status: "unmatched" as const,
          country,
          scrapeError: tStatus("scrape_error_no_result"),
        }));

      const itemsPayload = [
        ...searchedPayload,
        ...queuedPayload,
        ...fallbackPayload,
      ];
      if (itemsPayload.length === 0) {
        return new Map();
      }

      const startedAt = performance.now();
      recordImportEvent("onboarding.items.initial_bulk.start", {
        items: itemsPayload.length,
        matched: searchedPayload.filter((item) => item.status === "matched")
          .length,
        queued: queuedPayload.length,
        fallback: fallbackPayload.length,
      });
      try {
        const res = await fetch("/api/imports/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            importId: currentImportId,
            items: itemsPayload,
          }),
        });
        if (!res.ok) {
          // Surface the failure — previously we silently returned an empty
          // map, which is why imports could complete with `itemCount = 0`.
          const errBody = await res.text().catch(() => "");
          console.error(
            `[wizard] /api/imports/items rejected (${res.status}): ${errBody.slice(0, 200)}`
          );
          recordImportEvent("onboarding.items.initial_bulk.error", {
            status: res.status,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return new Map();
        }
        const data = await res.json();
        const idMap = new Map<string, string>();
        if (Array.isArray(data?.items)) {
          for (const item of data.items) {
            if (
              typeof item?.query === "string" &&
              typeof item?.id === "string"
            ) {
              idMap.set(item.query, item.id);
            }
          }
        }
        recordImportEvent("onboarding.items.initial_bulk.complete", {
          items: idMap.size,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return idMap;
      } catch (error) {
        console.error("[wizard] Failed to write import items:", error);
        recordImportEvent("onboarding.items.initial_bulk.error", {
          durationMs: Math.round(performance.now() - startedAt),
          error:
            error instanceof Error
              ? error.message.slice(0, 120)
              : String(error).slice(0, 120),
        });
        return new Map();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
    [country]
  );

  const runMatchSearch = useCallback(
    async (
      names: string[],
      searchCountry: string
    ): Promise<{
      results: SearchResult[];
      autoSelected: Map<string, AppCandidate>;
      queuedRows: Array<{ name: string; developer?: string }>;
      queuedRetryAfterMs?: number;
      bundleMatched: number;
      bundleLookupTotal: number;
    }> => {
      const phase1Matches = new Map<string, AppCandidate>();
      const phase1NamesWithBundle: string[] = [];
      const bundleByLowerName = new Map<string, string>();
      const developerByLowerName = new Map<string, string>();
      const queuedByName = new Map<
        string,
        { name: string; developer?: string }
      >();
      const queuedRetryWindows: number[] = [];
      const holdForQueuedLookup = new Set<string>();

      for (const name of names) {
        const lower = name.toLowerCase();
        const developer = developerHints.get(lower);
        if (developer) {
          developerByLowerName.set(lower, developer);
        }
        const bundleId = bundleIdHints.get(lower);
        if (bundleId) {
          phase1NamesWithBundle.push(name);
          bundleByLowerName.set(lower, bundleId);
        }
      }

      if (phase1NamesWithBundle.length > 0) {
        try {
          const lookupIds = phase1NamesWithBundle
            .map((name) => bundleByLowerName.get(name.toLowerCase()))
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0
            );
          const lookupRes = await fetch("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bundleIds: lookupIds,
              country: searchCountry,
            }),
          });
          if (lookupRes.ok) {
            const lookupData = await lookupRes.json().catch(() => ({}));
            const byBundle = new Map<string, AppCandidate>();
            for (const r of (lookupData.results ?? []) as Array<{
              bundleId: string;
              match: AppCandidate | null;
            }>) {
              if (r.match) {
                byBundle.set(r.bundleId, r.match);
              }
            }

            for (const name of phase1NamesWithBundle) {
              const lower = name.toLowerCase();
              const bundleId = bundleByLowerName.get(lower);
              if (!bundleId) {
                continue;
              }
              const match = byBundle.get(bundleId);
              if (match) {
                phase1Matches.set(name, { ...match, searchQuery: name });
              }
            }

            const rateLimited = lookupData.rateLimited as
              | { retryAfterMs: number; queuedBundleIds?: string[] }
              | undefined;
            if (rateLimited && Array.isArray(rateLimited.queuedBundleIds)) {
              const queuedIds = new Set(rateLimited.queuedBundleIds);
              queuedRetryWindows.push(rateLimited.retryAfterMs);
              for (const name of phase1NamesWithBundle) {
                const lower = name.toLowerCase();
                const bundleId = bundleByLowerName.get(lower);
                if (!(bundleId && queuedIds.has(bundleId))) {
                  continue;
                }
                holdForQueuedLookup.add(name);
                queuedByName.set(name, {
                  name,
                  developer: developerByLowerName.get(lower),
                });
              }
            }
          } else if (lookupRes.status === 401 || lookupRes.status === 403) {
            // The security gate rejects bundle lookup and name search
            // alike — falling through to phase 2 would just fail every
            // chunk the same way.
            throw new SearchAccessBlockedError(lookupRes.status);
          } else {
            console.warn(
              `[wizard] bundle-ID lookup returned HTTP ${lookupRes.status}; falling back to name search`
            );
          }
        } catch (err) {
          if (err instanceof SearchAccessBlockedError) {
            throw err;
          }
          console.warn(
            "[wizard] bundle-ID lookup failed, falling back to name search:",
            err
          );
        }
      }

      const phase2Names = names.filter(
        (name) => !(phase1Matches.has(name) || holdForQueuedLookup.has(name))
      );
      const rowsPayload = phase2Names.map((name) => {
        const developer = developerByLowerName.get(name.toLowerCase());
        return developer ? { name, developer } : { name };
      });

      // Chunk phase 2 into batches so the user sees progress instead of
      // an endless spinner on large imports. /api/search itself is happy
      // up to 500 rows but Apple rate-limits aggressively past ~50; this
      // size also gives us 4-5 progress ticks for a typical 200-app
      // batch, which keeps the bar visibly moving.
      //
      // Phase 1 (bundle-ID lookup) already contributed its matches to
      // `phase1Matches`; we seed the running `matched` counter with that
      // count so the progress UI starts at the right place rather than
      // jumping when the first chunk lands.
      const SEARCH_CHUNK_SIZE = 50;
      const phase2Chunks: (typeof rowsPayload)[] = [];
      for (let i = 0; i < rowsPayload.length; i += SEARCH_CHUNK_SIZE) {
        phase2Chunks.push(rowsPayload.slice(i, i + SEARCH_CHUNK_SIZE));
      }
      const totalBatches = Math.max(1, phase2Chunks.length);
      let matchedRunning = phase1Matches.size;
      setSearchProgress({
        matched: matchedRunning,
        total: names.length,
        currentBatch: 0,
        totalBatches,
      });

      const phase2Results: SearchResult[] = [];
      let aborted = false;

      for (let i = 0; i < phase2Chunks.length; i++) {
        if (searchAbortRef.current?.signal.aborted) {
          aborted = true;
          break;
        }
        const chunk = phase2Chunks[i];
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: chunk, country: searchCountry }),
          signal: searchAbortRef.current?.signal,
        }).catch((err: unknown) => {
          if ((err as Error)?.name === "AbortError") {
            aborted = true;
            return null;
          }
          throw err;
        });
        if (aborted || !res) {
          break;
        }
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            throw new SearchAccessBlockedError(res.status);
          }
          if (res.status === 429) {
            // Our own /api/search rate limit (60 req/min per client) —
            // distinct from Apple's upstream throttle (which arrives as
            // a 200 with `rateLimited` in the body), but the remedy is
            // the same: park this chunk plus everything not yet sent
            // and let the QueuedSearchProvider replay after the window
            // clears. Unlike the Apple path, chunk i itself was never
            // processed, so it goes back in the queue too.
            const retryAfterSeconds = Number(res.headers.get("Retry-After"));
            const retryAfterMs =
              Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? retryAfterSeconds * 1000
                : 30_000;
            queuedRetryWindows.push(retryAfterMs);
            for (let j = i; j < phase2Chunks.length; j++) {
              for (const row of phase2Chunks[j]) {
                queuedByName.set(row.name, row);
              }
            }
            setSearchProgress((prev) =>
              prev ? { ...prev, currentBatch: i + 1 } : prev
            );
            break;
          }
          console.error(`[wizard] /api/search failed with ${res.status}`);
          setSearchError(
            tStatus("search_endpoint_error_prefix") +
              '"unmatched" in Import History — open Settings → Import history to retry.'
          );
          // Continue to the next chunk anyway — partial progress is
          // better than throwing away the entire batch on a single 5xx.
          setSearchProgress((prev) =>
            prev ? { ...prev, currentBatch: i + 1 } : prev
          );
          continue;
        }
        const data = await res.json().catch(() => ({}));
        const chunkResults: SearchResult[] = data.results ?? [];
        phase2Results.push(...chunkResults);
        // Tally matched apps from THIS chunk so the running total stays
        // accurate even if Apple rate-limits mid-loop.
        matchedRunning += chunkResults.filter(
          (r) => r.candidates.length > 0
        ).length;

        const chunkRateLimited = data.rateLimited as
          | {
              retryAfterMs: number;
              queued: Array<{ name: string; developer?: string }>;
            }
          | undefined;
        if (chunkRateLimited && Array.isArray(chunkRateLimited.queued)) {
          queuedRetryWindows.push(chunkRateLimited.retryAfterMs);
          for (const row of chunkRateLimited.queued) {
            if (!row?.name) {
              continue;
            }
            queuedByName.set(row.name, row);
          }
          // If Apple has queued some of the names in this chunk, the
          // remaining chunks are very likely to hit the same throttle.
          // Stop the loop here; the queued tail will replay through the
          // background QueuedSearchProvider just like the single-batch
          // path used to.
          for (let j = i + 1; j < phase2Chunks.length; j++) {
            for (const row of phase2Chunks[j]) {
              queuedByName.set(row.name, row);
            }
          }
          setSearchProgress((prev) =>
            prev
              ? { ...prev, matched: matchedRunning, currentBatch: i + 1 }
              : prev
          );
          break;
        }

        setSearchProgress((prev) =>
          prev
            ? { ...prev, matched: matchedRunning, currentBatch: i + 1 }
            : prev
        );
      }
      // Surface the abort signal so the caller knows the loop stopped
      // early — `handleSearch` already handles a partial result set
      // (some rows unmatched), so we just slot whatever we have in.
      if (aborted) {
        console.info(
          `[wizard] search cancelled after ${phase2Results.length} of ${rowsPayload.length} phase-2 names.`
        );
      }

      // Per-chunk rate-limiting was already captured inside the loop
      // above; the older single-batch path's post-loop `rateLimited`
      // handling is no longer needed here. `queuedByName` already
      // carries every name Apple deferred plus every name we never
      // got to (loop bailed mid-stream on rate-limit / abort).

      const phase2ByQuery = new Map<string, SearchResult>();
      for (const r of phase2Results) {
        phase2ByQuery.set(r.query, r);
      }
      const queuedNames = new Set(queuedByName.keys());
      const results: SearchResult[] = names.map((name) => {
        const lower = name.toLowerCase();
        const sourceBundleId = bundleByLowerName.get(lower) ?? null;
        const sourceDeveloper = developerByLowerName.get(lower) ?? null;
        const phase1 = phase1Matches.get(name);
        if (phase1) {
          return {
            query: name,
            candidates: [phase1],
            status: "matched",
            matchSource: "bundle",
            searchedCountry: searchCountry,
            sourceBundleId,
            sourceDeveloper,
          };
        }
        if (queuedNames.has(name)) {
          return {
            query: name,
            candidates: [],
            status: "pending",
            searchedCountry: searchCountry,
            sourceBundleId,
            sourceDeveloper,
            note: tStatus("search_apple_paused"),
          };
        }
        const phase2 = phase2ByQuery.get(name);
        if (phase2) {
          return {
            ...phase2,
            status: phase2.candidates.length > 0 ? "matched" : "unmatched",
            matchSource: phase2.candidates.length > 0 ? "name" : undefined,
            searchedCountry: searchCountry,
            sourceBundleId,
            sourceDeveloper,
          };
        }
        return {
          query: name,
          candidates: [],
          status: "unmatched",
          searchedCountry: searchCountry,
          sourceBundleId,
          sourceDeveloper,
        };
      });

      // Auto-select bundle-ID matches and single-candidate name matches.
      // Skip multi-candidate name matches so the user picks deliberately.
      //
      // - Bundle matches: Apple's iTunes Lookup returned the app for the
      //   exact bundle ID we sent, so the top candidate is the right one.
      // - Single-candidate name matches: only one app matched the name in
      //   the user's storefront — there's nothing else to pick.
      // - Multi-candidate name matches: e.g. "Calculator" returns dozens
      //   of candidates from various publishers. Leaving these unselected
      //   forces a deliberate pick and avoids silently importing the
      //   wrong "Calculator". The Step-3 top banner surfaces the count
      //   so the user can click "Import N selected" without scrolling
      //   to confirm, then iterate through the ambiguous rows later.
      const autoSelected = new Map<string, AppCandidate>();
      for (const result of results) {
        if (result.status === "pending" || result.candidates.length === 0) {
          continue;
        }
        const isBundle = result.matchSource === "bundle";
        const isUnambiguousNameMatch = result.candidates.length === 1;
        if (isBundle || isUnambiguousNameMatch) {
          autoSelected.set(result.query, result.candidates[0]);
        }
      }

      return {
        results,
        autoSelected,
        queuedRows: Array.from(queuedByName.values()),
        queuedRetryAfterMs:
          queuedRetryWindows.length > 0
            ? Math.max(...queuedRetryWindows)
            : undefined,
        bundleMatched: phase1Matches.size,
        bundleLookupTotal: phase1NamesWithBundle.length,
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is stable; including it recreates the search function every render
    },
    [bundleIdHints, developerHints]
  );

  /**
   * Commit the user's step-2 diff selection. Auto-resync only:
   *   1. Apply removes via /api/device-sync/commit (no `addAppIds` yet —
   *      we don't have appIds for the cfgutil entries; they come in
   *      step 3 after iTunes match).
   *   2. Filter `importedApps` down to just the picked adds.
   *   3. If nothing left to add, route to /dashboard with a toast.
   *   4. Otherwise, fire `handleSearch` to advance through step 3/4
   *      with the reduced list.
   */
  const commitStep2Diff = async (override?: {
    pickedEntryIds: string[];
    pickedRemoveAppIds: string[];
    addCount: number;
    removeCount: number;
  }) => {
    // Accept the picked-set as a param OR fall back to state. The
    // no-op path (added=0, removed=0) calls this synchronously right
    // after `setStep2DiffPicked(...)`, so state hasn't flushed yet —
    // pass `picked` through the param to avoid a tick of nullness.
    const picked = override ?? step2DiffPicked;
    if (!(picked && resyncDeviceId)) {
      return;
    }
    setStep2DiffCommitting(true);
    try {
      // Removes commit first so the device's app set is correct even if
      // the user bails before step 4. Empty addAppIds is fine — the
      // commit API treats it as a no-op for the add side.
      if (picked.pickedRemoveAppIds.length > 0) {
        const res = await fetch("/api/device-sync/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId: resyncDeviceId,
            addAppIds: [],
            removeAppIds: picked.pickedRemoveAppIds,
          }),
        });
        if (!res.ok) {
          throw new Error(`device-sync commit HTTP ${res.status}`);
        }
      }

      const pickedAddIds = new Set(picked.pickedEntryIds);
      const filtered = importedApps.filter((e) => pickedAddIds.has(e.id));
      setImportedApps(filtered);

      setStep2DiffConfirmOpen(false);
      setStep2DiffPicked(null);

      if (filtered.length === 0) {
        // Removes-only path — nothing to scrape, nothing to match.
        router.push("/dashboard");
        return;
      }
      // Hand off to the existing search flow, which will move the user
      // to step 3 with the iTunes search results.
      await handleSearch();
    } catch (error) {
      console.error("[wizard] commitStep2Diff failed:", error);
      setStep2DiffCommitting(false);
      setSearchError(error instanceof Error ? error.message : "commit failed");
      return;
    }
    setStep2DiffCommitting(false);
  };

  const handleSearch = async () => {
    // Commit any staged text in the ImportedAppsTable's "+ Add"
    // textarea before reading the search list. Users typing names
    // directly into that input frequently click "Search App Store"
    // expecting it to "just work" — without this auto-commit they'd
    // discover the staging quirk the hard way (button stays disabled
    // OR fires with empty input). `flushPendingAppText` returns the
    // names that landed in `importedApps`; we splice them into the
    // search list inline since `setImportedApps` doesn't settle
    // before the read below.
    const justCommitted = flushPendingAppText();
    const allNames = [...getNames(), ...justCommitted].filter(
      (n, i, arr) => arr.indexOf(n) === i
    );

    if (allNames.length === 0) {
      return;
    }

    // Only re-search names that don't already have a SearchResult.
    // Subsequent clicks of "Search App Store" (after the user has
    // come back to step 2 to add a few more apps) used to nuke
    // `searchResults` / `selected` / `skippedQueries` /
    // `manuallyChosenQueries` wholesale, losing every candidate pick
    // the user had made on the first pass. Merge mode preserves all
    // of that and only fetches results for names that don't yet have
    // a block, plus prunes results whose names the user removed from
    // step 2 between searches.
    const existingQueries = new Set(searchResults.map((r) => r.query));
    const freshNames = allNames.filter((n) => !existingQueries.has(n));

    // Also replay names whose previous search came back empty-handed —
    // zero candidates and not yet resolved another way (skipped, saved as
    // a manual app, or parked in the 429 replay queue). Coming back to
    // step 2 and clicking "Search App Store" again is the natural retry
    // gesture after a transient miss (iTunes hiccup, fixed typo upstream,
    // an unblocked security gate), and the merge below replaces those
    // blocks in place — a retry that still finds nothing is a UI no-op.
    const retryNames = allNames.filter((n) => {
      if (!existingQueries.has(n)) {
        return false;
      }
      const existing = searchResults.find((r) => r.query === n);
      return (
        existing !== undefined &&
        existing.candidates.length === 0 &&
        existing.status !== "skipped" &&
        !skippedQueries.has(n) &&
        !manuallyChosenQueries.has(n)
      );
    });
    const newNames = [...freshNames, ...retryNames];

    // Drop orphan results for names that are no longer in the list
    // (the user removed them in step 2). Computed synchronously so
    // the newNames-empty fast-path below reads the post-prune count
    // — setSearchResults wouldn't settle before the next statement
    // and we'd ship the user to step 3 with stale rows.
    const liveNamesSet = new Set(allNames);
    const prunedExisting = searchResults.filter((r) =>
      liveNamesSet.has(r.query)
    );
    if (prunedExisting.length !== searchResults.length) {
      setSearchResults(prunedExisting);
    }

    // No new names — every name is already searched. The user
    // probably clicked Search again to advance the wizard; carry
    // them forward to step 3 instead of refetching the world.
    if (newNames.length === 0) {
      if (prunedExisting.length > 0) {
        setStep(3);
      }
      return;
    }

    setSearching(true);
    setSearchError("");
    setSearchBlocked(false);
    // Fresh AbortController per run — `cancelSearch` reaches into this
    // ref to abort the in-flight chunk; `runMatchSearch` reads
    // `signal.aborted` between chunks to break the loop early.
    searchAbortRef.current = new AbortController();
    setSearchProgress({
      matched: 0,
      total: newNames.length,
      currentBatch: 0,
      totalBatches: 1,
    });

    try {
      if (countryInferred) {
        await updateCountry(country);
      }

      const {
        results,
        autoSelected,
        queuedRows,
        queuedRetryAfterMs,
        bundleMatched,
        bundleLookupTotal,
      } = await runMatchSearch(newNames, country);

      // Tell the console how many names the server failed to match so
      // power users can see the list in devtools. The split between
      // phase-1 hits and phase-2 misses is useful when debugging a
      // cfgutil import where lookup didn't return as many matches as
      // expected.
      const unmatched = results
        .filter((r) => r.candidates.length === 0)
        .map((r) => r.query);
      if (unmatched.length > 0) {
        console.warn(
          `[search] ${unmatched.length} / ${results.length} names returned no App Store matches:`,
          unmatched
        );
      }
      if (bundleMatched > 0) {
        console.info(
          `[search] bundle-ID lookup matched ${bundleMatched} / ${bundleLookupTotal} apps from cfgutil.`
        );
      }

      // Persist this onboarding attempt as an import so the user can review
      // matched/unmatched/imported counts from Settings later. We record the
      // *total* (including queued tail) so counts reflect user intent, and
      // we write every name as an import_item up front — names Apple
      // couldn't process yet go in as `status='queued'` with the retry
      // deadline, so the history view has a full record of the batch from
      // the moment it starts instead of waiting for the replay to land.
      const newImportId = await createImportRecord(newNames.length);
      if (newImportId) {
        setImportId(newImportId);
        const idMap = await writeImportItems(
          newImportId,
          results,
          autoSelected,
          queuedRows,
          queuedRetryAfterMs,
          // Hand the full submitted list through so names that neither
          // landed in `results` nor in the queued tail still get written as
          // `unmatched` placeholders. Fixes the "total=N but itemCount=0"
          // symptom when /api/search dies before returning anything usable.
          newNames
        );
        setItemIdByQuery((prev) => {
          const merged = new Map(prev);
          for (const [k, v] of idMap.entries()) {
            merged.set(k, v);
          }
          return merged;
        });
      }

      // Merge fresh results into the existing list. New blocks append;
      // any block whose query the server returned again (shouldn't
      // happen given the newNames filter above, but be robust) gets
      // replaced in place.
      setSearchResults((prev) => {
        const incoming = new Map(results.map((r) => [r.query, r]));
        const next = prev.map((r) => incoming.get(r.query) ?? r);
        for (const r of results) {
          if (!next.some((p) => p.query === r.query)) {
            next.push(r);
          }
        }
        return next;
      });
      // Merge selections — preserve any picks the user already made.
      setSelected((prev) => {
        const next = new Map(prev);
        for (const [query, candidate] of autoSelected) {
          if (!next.has(query)) {
            next.set(query, candidate);
          }
        }
        return next;
      });
      // Deliberately NOT resetting skippedQueries / manuallyChosenQueries —
      // any block the user explicitly skipped or chose on a prior search
      // stays in that state. Only orphaned skipped/manual entries (whose
      // query was removed from importedApps in step 2) need pruning to
      // avoid stale flags lingering across visits.
      const allNamesSet = new Set(allNames);
      setSkippedQueries((prev) => {
        const next = new Set<string>();
        for (const q of prev) {
          if (allNamesSet.has(q)) {
            next.add(q);
          }
        }
        return next;
      });
      setManuallyChosenQueries((prev) => {
        const next = new Set<string>();
        for (const q of prev) {
          if (allNamesSet.has(q)) {
            next.add(q);
          }
        }
        return next;
      });

      // Rate-limit path: hand the queued tail to the layout-level provider so
      // the retry loop keeps running if the user navigates away, and still
      // drop the user on Step 3 so they can confirm what we *did* match
      // while we wait out Apple's cooldown. The provider also registers a
      // Task Center entry with a live countdown for the notification area.
      if (queuedRows.length > 0 && queuedRetryAfterMs) {
        queuedSearch.enqueue({
          queued: queuedRows,
          country,
          importId: newImportId ?? null,
          retryAfterMs: queuedRetryAfterMs,
        });
        console.warn(
          `[search] iTunes rate-limited after ${results.length} of ${newNames.length} names; ` +
            `${queuedRows.length} queued for replay in ${Math.round(queuedRetryAfterMs / 1000)}s.`
        );
      }

      setStep(3);
    } catch (error) {
      if (error instanceof SearchAccessBlockedError) {
        // Nothing was matched — the gate rejected the request before any
        // lookup ran. Stay on step 2 with a message that says so, instead
        // of marking every row "Not in the App Store".
        console.error(
          `[wizard] /api/search blocked by the security gate (HTTP ${error.status})`
        );
        setSearchBlocked(true);
        setSearchError(
          tStatus("search_access_blocked", { status: error.status })
        );
      } else {
        console.error("[wizard] /api/search failed:", error);
        setSearchError(tStatus("search_failed"));
      }
    } finally {
      setSearching(false);
      setSearchProgress(null);
      searchAbortRef.current = null;
    }
  };

  /**
   * Abort the in-flight chunked search. The loop inside `runMatchSearch`
   * reads `signal.aborted` between chunks; whatever's already returned
   * is still committed (search progress isn't an all-or-nothing thing —
   * partial matches go through the same step-3 review flow as a full
   * batch). The button bound to this lives next to the progress bar.
   */
  const cancelSearch = useCallback(() => {
    searchAbortRef.current?.abort();
  }, []);

  /**
   * Subscribe to background results from the QueuedSearchProvider. Whenever
   * the hoisted retry loop produces a fresh batch we splice it into the
   * wizard's Step 3 list and auto-select the top candidate for each row, so
   * the UI behaves exactly like the initial search. If the wizard is not
   * mounted, the provider still writes matches to /api/imports/items, so the
   * Settings → Import History view sees the full batch either way.
   */
  useEffect(() => {
    const onResults = (fresh: SearchResultLike[]) => {
      if (fresh.length === 0) {
        return;
      }

      const freshSelected = new Map<string, AppCandidate>();
      for (const r of fresh) {
        if (r.candidates.length > 0) {
          freshSelected.set(r.query, r.candidates[0]);
        }
      }

      setSearchResults((prev) => {
        const byQuery = new Map(prev.map((result) => [result.query, result]));
        for (const r of fresh) {
          const previous = byQuery.get(r.query);
          byQuery.set(r.query, {
            ...previous,
            query: r.query,
            candidates: r.candidates,
            status: r.candidates.length > 0 ? "matched" : "unmatched",
            matchSource:
              r.candidates.length > 0 ? "name" : previous?.matchSource,
            searchedCountry: previous?.searchedCountry ?? country,
          });
        }
        return Array.from(byQuery.values());
      });
      setSelected((prev) => {
        const next = new Map(prev);
        freshSelected.forEach((value, key) => {
          next.set(key, value);
        });
        return next;
      });
    };
    const unsubscribe = queuedSearch.subscribe(onResults);
    return unsubscribe;
  }, [country, queuedSearch]);

  // Re-search a single block (used by the editable "Confirm" step). The
  // caller may pass `nextDeveloper` to override the CSV-sourced seller hint
  // — empty string means "clear the hint", undefined means "keep existing".
  // `force` lets a "Retry" button re-hit the API with the same query — useful
  // when the first batch was rate-limited (a 429 returns no candidates) so
  // the user can replay just that one block once the window has cleared.
  const handleBlockResearch = async (
    originalQuery: string,
    nextQuery: string,
    nextDeveloper?: string,
    force = false
  ) => {
    const trimmed = nextQuery.trim();
    const trimmedDev = nextDeveloper?.trim();
    const queryChanged = !!trimmed && trimmed !== originalQuery;
    // Whether the seller hint the user typed differs from what we already had
    // on file. We compare against the *original* query's hint — an edit that
    // also changes the name can still be driven by the same seller signal.
    const existingHint = developerHints.get(originalQuery.toLowerCase()) ?? "";
    const developerChanged =
      nextDeveloper !== undefined && trimmedDev !== existingHint;
    if (!(trimmed && (force || queryChanged || developerChanged))) {
      setEditingBlock(null);
      return;
    }

    setBlockSearching(originalQuery);
    setBlockSearchError("");
    try {
      // Resolution order for the seller hint the server uses to re-rank:
      //   1. An explicit value the user typed in the edit row.
      //   2. A CSV-imported hint keyed by the original query.
      //   3. A CSV-imported hint keyed by the edited name.
      const resolvedHint =
        nextDeveloper === undefined
          ? (developerHints.get(originalQuery.toLowerCase()) ??
            developerHints.get(trimmed.toLowerCase()))
          : trimmedDev;
      const payload = resolvedHint
        ? { rows: [{ name: trimmed, developer: resolvedHint }], country }
        : { rows: [{ name: trimmed }], country };

      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // Don't touch the block — leaving it as-is and surfacing the
        // failure beats silently keeping stale candidates (or worse,
        // implying the edited name isn't in the App Store).
        console.error(
          `[wizard] block re-search failed with HTTP ${res.status}`
        );
        if (res.status === 401 || res.status === 403) {
          setSearchBlocked(true);
          setBlockSearchError(
            tStatus("search_access_blocked", { status: res.status })
          );
        } else if (res.status === 429) {
          setBlockSearchError(tStatus("search_rate_limited_retry"));
        } else {
          setBlockSearchError(tStatus("search_failed"));
        }
        return;
      }
      const data = await res.json();
      const fresh: SearchResult | undefined = (data.results ?? [])[0];
      if (!fresh) {
        return;
      }

      // Replace this block in-place with the fresh results, keyed by the new query.
      setSearchResults((prev) =>
        prev.map((item) =>
          item.query === originalQuery
            ? {
                ...item,
                query: trimmed,
                candidates: fresh.candidates,
                status: fresh.candidates.length > 0 ? "matched" : "unmatched",
                matchSource: fresh.candidates.length > 0 ? "name" : undefined,
                searchedCountry: country,
                sourceDeveloper: resolvedHint ?? item.sourceDeveloper ?? null,
              }
            : item
        )
      );

      setSelected((prev) => {
        const next = new Map(prev);
        next.delete(originalQuery);
        if (fresh.candidates.length > 0) {
          next.set(trimmed, fresh.candidates[0]);
        }
        return next;
      });
      setSkippedQueries((prev) => {
        const next = new Set(prev);
        next.delete(originalQuery);
        next.delete(trimmed);
        return next;
      });
      setManuallyChosenQueries((prev) => {
        const next = new Set(prev);
        next.delete(originalQuery);
        return next;
      });

      // Also update the server-side item id map so the completion step knows
      // which item to patch by the new query name.
      setItemIdByQuery((prev) => {
        const existingId = prev.get(originalQuery);
        if (!existingId) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(originalQuery);
        next.set(trimmed, existingId);
        return next;
      });

      // Persist the user's explicit seller edit + any name change back
      // onto the matching `importedApps` entry so a re-search picks up
      // the fresh values. Matched by current name (case-insensitive)
      // since that's what the search produced from. When `nextDeveloper`
      // is undefined we leave the existing developer alone (the caller
      // didn't ask to change it).
      if (nextDeveloper !== undefined || queryChanged) {
        setImportedApps((prev) =>
          prev.map((entry) => {
            if (entry.name.toLowerCase() !== originalQuery.toLowerCase()) {
              return entry;
            }
            return {
              ...entry,
              name: queryChanged ? trimmed : entry.name,
              developer:
                nextDeveloper === undefined
                  ? entry.developer
                  : trimmedDev || undefined,
            };
          })
        );
      }

      // Patch the server-side import_item with the edited query + selection.
      if (importId) {
        const itemId = itemIdByQuery.get(originalQuery);
        if (itemId) {
          const top = fresh.candidates[0];
          await fetch("/api/imports/items/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              itemId,
              editedQuery: trimmed,
              status: top ? "matched" : "unmatched",
              appId: top?.appleId ?? null,
              appName: top?.name ?? null,
              developer: top?.developer ?? null,
              url: top?.url ?? null,
            }),
          });
        }
      }
    } catch (error) {
      // UI still shows the old block, but surface the reason in devtools.
      console.error("[wizard] handleBlockResearch failed:", error);
    } finally {
      setEditingBlock(null);
      setBlockSearching(null);
    }
  };

  const handleBlockSkip = async (query: string) => {
    // Drop the selection and mark skipped on the server.
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(query);
      return next;
    });
    setSkippedQueries((prev) => new Set(prev).add(query));
    setManuallyChosenQueries((prev) => {
      const next = new Set(prev);
      next.delete(query);
      return next;
    });
    setSearchResults((prev) =>
      prev.map((result) =>
        result.query === query ? { ...result, status: "skipped" } : result
      )
    );

    if (!importId) {
      return;
    }
    const itemId = itemIdByQuery.get(query);
    if (!itemId) {
      return;
    }

    await fetch("/api/imports/items/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, status: "skipped" }),
    });
  };

  const handleCancelQueuedMatches = async () => {
    queuedSearch.cancel();
    const pendingQueries = searchResults
      .filter((result) => result.status === "pending")
      .map((result) => result.query);
    if (pendingQueries.length === 0) {
      return;
    }

    setSearchResults((prev) =>
      prev.map((result) =>
        result.status === "pending"
          ? {
              ...result,
              status: "unmatched",
              note: tStatus("scrape_error_match_cancelled"),
            }
          : result
      )
    );

    if (!importId) {
      return;
    }
    const items = pendingQueries.map((query) => ({
      query,
      status: "unmatched" as const,
      country,
      scrapeError: tStatus("scrape_error_match_cancelled"),
    }));
    try {
      await fetch("/api/imports/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId, items }),
      });
    } catch (error) {
      console.warn("[wizard] Failed to mark cancelled queued matches:", error);
    }
  };

  const handleRegionRematch = async (nextCountry: string) => {
    const rematchCountry = normalizeCountry(nextCountry);
    const names = searchResults.map((result) => result.query);
    if (names.length === 0 || rematchingRegion) {
      return;
    }

    setRematchingRegion(true);
    setSearchError("");
    try {
      if (rematchCountry !== country || countryInferred) {
        await updateCountry(rematchCountry);
      }

      const preservedManual = new Map<string, AppCandidate>();
      for (const query of manuallyChosenQueries) {
        const chosen = selected.get(query);
        if (chosen) {
          preservedManual.set(query, chosen);
        }
      }

      const namesToSearch = names.filter(
        (name) => !(preservedManual.has(name) || skippedQueries.has(name))
      );
      const {
        results: freshResults,
        autoSelected,
        queuedRows,
        queuedRetryAfterMs,
      } = await runMatchSearch(namesToSearch, rematchCountry);
      const freshByQuery = new Map(
        freshResults.map((result) => [result.query, result])
      );

      const nextResults = searchResults.map((result) => {
        if (skippedQueries.has(result.query)) {
          return {
            ...result,
            status: "skipped" as const,
            searchedCountry: rematchCountry,
          };
        }
        if (preservedManual.has(result.query)) {
          return {
            ...result,
            status: "matched" as const,
            matchSource: "manual" as const,
            searchedCountry: rematchCountry,
          };
        }
        return (
          freshByQuery.get(result.query) ?? {
            ...result,
            candidates: [],
            status: "unmatched" as const,
            searchedCountry: rematchCountry,
          }
        );
      });

      const nextSelected = new Map<string, AppCandidate>();
      for (const [query, candidate] of preservedManual) {
        nextSelected.set(query, candidate);
      }
      for (const [query, candidate] of autoSelected) {
        nextSelected.set(query, candidate);
      }

      setSearchResults(nextResults);
      setSelected(nextSelected);

      if (importId) {
        const idMap = await writeImportItems(
          importId,
          nextResults,
          nextSelected,
          queuedRows,
          queuedRetryAfterMs,
          names
        );
        setItemIdByQuery((prev) => {
          const next = new Map(prev);
          for (const [query, id] of idMap) {
            next.set(query, id);
          }
          return next;
        });
      }

      if (queuedRows.length > 0 && queuedRetryAfterMs) {
        queuedSearch.enqueue({
          queued: queuedRows,
          country: rematchCountry,
          importId,
          retryAfterMs: queuedRetryAfterMs,
        });
      }
    } catch (error) {
      console.error("[wizard] region rematch failed:", error);
      setSearchError("Could not rematch this region. Try again in a moment.");
    } finally {
      setRematchingRegion(false);
    }
  };

  const handleConfirm = async (
    // When Step 3's "Hide already-tracked apps" toggle is on, the caller
    // passes a filtered copy of `selected` that excludes already-tracked
    // candidates. Falls back to the full `selected` map for any caller
    // (or future caller) that doesn't need the filter. The filtered map
    // only affects which rows are *scraped* — already-tracked blocks
    // still get their import_items status flipped to `skipped` below so
    // Import History remains a complete record of what the user saw.
    overrideSelected?: Map<string, AppCandidate>
  ) => {
    const workingSelected = overrideSelected ?? selected;
    const entries = [...workingSelected.entries()];
    if (entries.length === 0) {
      return;
    }
    if (searchResults.some((result) => result.status === "pending")) {
      return;
    }

    // Sync every visible block's status to the server before we start scraping,
    // so the import history reflects the user's final intent. A block that's
    // in `selected` but NOT in `workingSelected` was filtered out by the
    // hide-tracked toggle — those rows go to `skipped` so the user can see
    // in Import History that they deliberately opted not to re-import the
    // tracked app this time round.
    if (importId) {
      const statusPayload = searchResults.map((result) => {
        const chosen = workingSelected.get(result.query);
        const wasFiltered =
          selected.has(result.query) && !workingSelected.has(result.query);
        return chosen
          ? {
              query: result.query,
              status: "matched",
              appId: chosen.appleId,
              appName: chosen.name,
              developer: chosen.developer,
              url: chosen.url,
              iconUrl: chosen.iconUrl,
              country,
              scrapeError: null,
            }
          : wasFiltered
            ? { query: result.query, status: "skipped", country }
            : {
                query: result.query,
                status:
                  result.candidates.length === 0 ? "unmatched" : "skipped",
                country,
                scrapeError:
                  result.candidates.length === 0
                    ? tStatus("scrape_error_no_result")
                    : null,
              };
      });
      const startedAt = performance.now();
      recordImportEvent("onboarding.confirm.bulk_status.start", {
        items: statusPayload.length,
        selected: entries.length,
      });
      try {
        const res = await fetch("/api/imports/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ importId, items: statusPayload }),
        });
        if (!res.ok) {
          recordImportEvent("onboarding.confirm.bulk_status.error", {
            status: res.status,
            durationMs: Math.round(performance.now() - startedAt),
          });
          setSearchError(tStatus("background_import_start_failed"));
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data?.items)) {
          setItemIdByQuery((prev) => {
            const next = new Map(prev);
            for (const item of data.items) {
              if (
                typeof item?.query === "string" &&
                typeof item?.id === "string"
              ) {
                next.set(item.query, item.id);
              }
            }
            return next;
          });
        }
        recordImportEvent("onboarding.confirm.bulk_status.complete", {
          items: statusPayload.length,
          durationMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        console.error(
          "[wizard] Failed to persist final import selections:",
          error
        );
        recordImportEvent("onboarding.confirm.bulk_status.error", {
          durationMs: Math.round(performance.now() - startedAt),
          error:
            error instanceof Error
              ? error.message.slice(0, 120)
              : String(error).slice(0, 120),
        });
        setSearchError(tStatus("background_import_start_failed"));
        return;
      }
    }

    const list: ScrapeStatus[] = entries.map(([query, candidate]) => ({
      query,
      url: candidate.url,
      name: candidate.name,
      status: "pending",
    }));

    try {
      window.localStorage.removeItem(ONBOARDING_DRAFT_STORAGE_KEY);
    } catch {
      /* non-fatal */
    }
    setScrapeList(list);
    setDone(false);
    setStep(4);
    void startScraping(entries, list);
  };

  /**
   * Are the AI provider fields complete enough to save? Mirrors the
   * checks inside `saveAiSettings` so the primary CTA can be disabled
   * up-front instead of letting the user click into an inline error —
   * the same condition the "Test connection" button already used.
   * `disabled` needs no fields, so it is trivially valid.
   */
  const aiSettingsComplete =
    aiProvider === "disabled" ||
    (Boolean(aiBaseUrl.trim()) &&
      Boolean(aiModel.trim()) &&
      (!providerRequiresApiKey(aiProvider) || Boolean(aiApiKey.trim())));

  const saveAiSettings = async (): Promise<boolean> => {
    setAiError("");

    if (aiProvider !== "disabled") {
      if (!(aiBaseUrl.trim() && aiModel.trim())) {
        setAiError(tStatus("ai_base_url_model_required"));
        return false;
      }

      if (providerRequiresApiKey(aiProvider) && !aiApiKey.trim()) {
        setAiError(tStatus("ai_api_key_required"));
        return false;
      }
    }

    setSavingAi(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ai_provider: aiProvider,
          ai_api_key: aiApiKey,
          ai_base_url: aiBaseUrl,
          ai_model: aiModel,
          // Wave I — AND-gate the persisted preference with the
          // onboarding-namespace flag. Disabling
          // `flag.onboarding.ai.summarize_on_import` cancels the
          // wizard's first-import auto-summarise even if the user has
          // the saved preference on. The setting itself isn't
          // overwritten — flipping the flag back on restores the
          // previous behaviour.
          ai_summarize_on_import:
            summarizeOnImport && onboardAiSummarizeOnImportOn,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAiError(data.error ?? tStatus("ai_save_failed"));
        setSavingAi(false);
        return false;
      }

      setStoredAi({
        provider: aiProvider,
        apiKey: aiApiKey,
        baseUrl: aiBaseUrl,
        model: aiModel,
        summarizeOnImport,
      });
      setSavingAi(false);
      return true;
    } catch (error) {
      console.error("[wizard] Failed to save AI settings:", error);
      setAiError(tStatus("ai_save_failed"));
      setSavingAi(false);
      return false;
    }
  };

  // Step 5: generate policy summaries for the apps we just imported.
  //
  // Runs in two sequential phases so users can see what's happening and
  // stop mid-way if they need to:
  //   1. Fetch every app's privacy-policy text and validate it.
  //   2. Summarise each app whose fetch produced usable source text.
  //
  // Cancellation is cooperative: `stopRequestedRef.current = 'now' | 'after-current'`
  // is checked at every iteration boundary (`'now'` also aborts the in-flight
  // request via AbortController).
  const runPolicyRegeneration = async () => {
    const saved = await saveAiSettings();
    if (!saved || aiProvider === "disabled") {
      return;
    }

    const successes = scrapeList.filter((item) => item.status === "success");
    if (successes.length === 0) {
      return;
    }

    // Pair each successful scrape with the app id (pulled from import items map
    // indirectly by matching URL, or — more reliably — by re-reading /api/apps).
    const idLookup: Record<string, { id: string; name: string }> = {};
    try {
      const listRes = await fetch("/api/apps");
      const apps = (await listRes.json()) as Array<{
        id: string;
        name: string;
        url: string;
      }>;
      for (const app of apps) {
        idLookup[app.url] = { id: app.id, name: app.name };
      }
    } catch (error) {
      /* fall back to scrapeList names without ids */
      console.warn(
        "[wizard] Failed to load /api/apps for policy id lookup:",
        error
      );
    }

    const queue: PolicyRegenerateStatus[] = successes.map((item) => {
      const match = idLookup[item.url];
      return {
        appId: match?.id ?? item.url,
        name: match?.name ?? item.name,
        scrape: { status: "pending" },
        summarise: { status: "pending" },
      };
    });

    stopRequestedRef.current = "none";
    // Getter that returns the widened type so TS doesn't narrow away 'now' /
    // 'after-current' after the initial 'none' assignment above.
    const readStop = (): PolicyStopMode => stopRequestedRef.current;
    setPolicyProgress(queue);
    setPolicyRunDone(false);
    setPhaseAvgMs({ fetch: null, summarise: null });

    // Register a single parent task in the Task Center so the user can see
    // high-level progress + cancel from anywhere in the app. We own its
    // lifecycle — the wizard is still the authoritative UI for per-app detail.
    const totalSteps = queue.length * 2; // fetch + summarise per app
    const policyTask = taskCenter.startTask({
      title: tPolicyRun("task_title"),
      subtitle: tPolicyRun("task_subtitle", { count: queue.length }),
      kind: "policy",
      href: "/onboard",
      progress: {
        current: 0,
        total: totalSteps,
        label: tPolicyRun("task_steps_label", { done: 0, total: totalSteps }),
      },
      // `now` = immediate abort (matches the in-wizard "Stop now" button).
      onCancel: () => requestStop("now"),
    });
    policyTaskHandleRef.current = policyTask;

    const recomputeProgress = () => {
      let done = 0;
      for (const row of queue) {
        if (
          row.scrape.status === "done" ||
          row.scrape.status === "error" ||
          row.scrape.status === "skipped"
        ) {
          done += 1;
        }
        if (
          row.summarise.status === "done" ||
          row.summarise.status === "error" ||
          row.summarise.status === "skipped"
        ) {
          done += 1;
        }
      }
      policyTask.setProgress(
        done,
        totalSteps,
        tPolicyRun("task_steps_label", { done, total: totalSteps })
      );
    };

    // ---- Phase 1: fetch ----
    setActivePhase("fetch");
    let fetchTotalMs = 0;
    let fetchCompleted = 0;
    for (let index = 0; index < queue.length; index += 1) {
      if (readStop() === "now") {
        for (let j = index; j < queue.length; j += 1) {
          queue[j] = {
            ...queue[j],
            scrape: { status: "skipped", detail: tStatus("policy_cancelled") },
            summarise: {
              status: "skipped",
              detail: tStatus("policy_cancelled"),
            },
          };
        }
        setPolicyProgress([...queue]);
        recomputeProgress();
        break;
      }

      const startedAt = Date.now();
      queue[index] = {
        ...queue[index],
        scrape: { status: "working", startedAt },
      };
      setPolicyProgress([...queue]);
      recomputeProgress();

      if (!queue[index].appId || queue[index].appId.startsWith("http")) {
        queue[index] = {
          ...queue[index],
          scrape: {
            status: "error",
            detail: tStatus("policy_could_not_resolve"),
            startedAt,
            finishedAt: Date.now(),
          },
        };
        setPolicyProgress([...queue]);
        recomputeProgress();
        if (readStop() === "after-current") {
          break;
        }
        continue;
      }

      const abort = new AbortController();
      activeAbortRef.current = abort;

      try {
        const res = await fetch("/api/policy/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId: queue[index].appId, phase: "fetch" }),
          signal: abort.signal,
        });
        const data = await res.json();
        const finishedAt = Date.now();

        if (res.ok) {
          const analysisStatus: string | undefined = data?.analysis?.status;
          const scrapeStatus: PolicyPhaseStatus =
            analysisStatus === "ready" || analysisStatus === "source_ready"
              ? "done"
              : "error";
          queue[index] = {
            ...queue[index],
            scrape: {
              status: scrapeStatus,
              detail: describeFetchStatus(
                tStatus,
                analysisStatus,
                data?.analysis?.error
              ),
              startedAt,
              finishedAt,
            },
          };
          // If the cached analysis was already 'ready' we don't need to re-summarise.
          if (analysisStatus === "ready") {
            queue[index] = {
              ...queue[index],
              summarise: {
                status: "done",
                detail: tStatus("policy_already_up_to_date"),
                startedAt: finishedAt,
                finishedAt,
              },
            };
          }
        } else {
          queue[index] = {
            ...queue[index],
            scrape: {
              status: "error",
              detail:
                typeof data?.error === "string"
                  ? data.error
                  : `HTTP ${res.status}`,
              startedAt,
              finishedAt,
            },
          };
        }
      } catch (error) {
        const finishedAt = Date.now();
        const aborted =
          error instanceof DOMException && error.name === "AbortError";
        if (!aborted) {
          console.error(
            `[wizard] Policy fetch failed for ${queue[index]?.name ?? queue[index]?.appId}:`,
            error
          );
        }
        queue[index] = {
          ...queue[index],
          scrape: {
            status: aborted ? "skipped" : "error",
            detail: aborted
              ? tStatus("policy_cancelled")
              : error instanceof Error
                ? error.message
                : String(error),
            startedAt,
            finishedAt,
          },
        };
      } finally {
        activeAbortRef.current = null;
      }

      setPolicyProgress([...queue]);
      recomputeProgress();

      const finished = queue[index].scrape.finishedAt ?? Date.now();
      if (
        queue[index].scrape.status === "done" ||
        queue[index].scrape.status === "error"
      ) {
        fetchTotalMs += finished - startedAt;
        fetchCompleted += 1;
        setPhaseAvgMs((prev) => ({
          ...prev,
          fetch: fetchTotalMs / fetchCompleted,
        }));
      }

      if (readStop() === "after-current") {
        break;
      }
    }

    // ---- Phase 2: summarise ----
    if (readStop() === "none") {
      setActivePhase("summarise");
      let sumTotalMs = 0;
      let sumCompleted = 0;

      for (let index = 0; index < queue.length; index += 1) {
        if (readStop() === "now") {
          for (let j = index; j < queue.length; j += 1) {
            if (queue[j].summarise.status === "pending") {
              queue[j] = {
                ...queue[j],
                summarise: {
                  status: "skipped",
                  detail: tStatus("policy_cancelled"),
                },
              };
            }
          }
          setPolicyProgress([...queue]);
          recomputeProgress();
          break;
        }

        const entry = queue[index];

        // Only summarise apps that produced a usable scrape but haven't already
        // returned a cached 'ready' analysis (that case was short-circuited in phase 1).
        if (
          entry.scrape.status !== "done" ||
          entry.summarise.status === "done"
        ) {
          if (entry.summarise.status === "pending") {
            queue[index] = {
              ...entry,
              summarise: {
                status: "skipped",
                detail: tStatus("policy_no_text"),
              },
            };
            setPolicyProgress([...queue]);
            recomputeProgress();
          }
          continue;
        }

        const startedAt = Date.now();
        queue[index] = {
          ...entry,
          summarise: { status: "working", startedAt },
        };
        setPolicyProgress([...queue]);
        recomputeProgress();

        const abort = new AbortController();
        activeAbortRef.current = abort;

        try {
          const res = await fetch("/api/policy/regenerate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appId: entry.appId, phase: "summarise" }),
            signal: abort.signal,
          });
          const data = await res.json();
          const finishedAt = Date.now();

          if (res.ok) {
            const analysisStatus: string | undefined = data?.analysis?.status;
            queue[index] = {
              ...queue[index],
              summarise: {
                status: analysisStatus === "ready" ? "done" : "error",
                detail: describeSummariseStatus(
                  tStatus,
                  analysisStatus,
                  data?.analysis?.error
                ),
                startedAt,
                finishedAt,
              },
            };
          } else {
            queue[index] = {
              ...queue[index],
              summarise: {
                status: "error",
                detail:
                  typeof data?.error === "string"
                    ? data.error
                    : `HTTP ${res.status}`,
                startedAt,
                finishedAt,
              },
            };
          }
        } catch (error) {
          const finishedAt = Date.now();
          const aborted =
            error instanceof DOMException && error.name === "AbortError";
          if (!aborted) {
            console.error(
              `[wizard] Policy summarise failed for ${queue[index]?.name ?? queue[index]?.appId}:`,
              error
            );
          }
          queue[index] = {
            ...queue[index],
            summarise: {
              status: aborted ? "skipped" : "error",
              detail: aborted
                ? tStatus("policy_cancelled")
                : error instanceof Error
                  ? error.message
                  : String(error),
              startedAt,
              finishedAt,
            },
          };
        } finally {
          activeAbortRef.current = null;
        }

        setPolicyProgress([...queue]);
        recomputeProgress();

        const finished = queue[index].summarise.finishedAt ?? Date.now();
        if (
          queue[index].summarise.status === "done" ||
          queue[index].summarise.status === "error"
        ) {
          sumTotalMs += finished - startedAt;
          sumCompleted += 1;
          setPhaseAvgMs((prev) => ({
            ...prev,
            summarise: sumTotalMs / sumCompleted,
          }));
        }

        if (readStop() === "after-current") {
          break;
        }
      }
    }

    // Any summarise entries still pending after cancellation should flip to skipped.
    for (let j = 0; j < queue.length; j += 1) {
      if (queue[j].summarise.status === "pending") {
        queue[j] = {
          ...queue[j],
          summarise: {
            status: "skipped",
            detail:
              queue[j].scrape.status === "done"
                ? tStatus("policy_cancelled")
                : tStatus("policy_no_text"),
          },
        };
      }
    }
    setPolicyProgress([...queue]);
    recomputeProgress();
    setActivePhase(null);
    setPolicyRunDone(true);

    // Roll up outcome for the Task Center entry.
    const okCount = queue.filter((r) => r.summarise.status === "done").length;
    const errCount = queue.filter(
      (r) => r.scrape.status === "error" || r.summarise.status === "error"
    ).length;
    const skippedCount = queue.filter(
      (r) => r.summarise.status === "skipped"
    ).length;
    const wasCancelled = stopRequestedRef.current !== "none";
    if (wasCancelled) {
      policyTask.complete(
        "cancelled",
        `${okCount} finished · ${skippedCount} skipped · ${errCount} failed`
      );
    } else if (errCount > 0 && okCount === 0) {
      policyTask.complete(
        "error",
        `${errCount} app${errCount === 1 ? "" : "s"} failed`
      );
    } else {
      policyTask.complete(
        "done",
        `${okCount} of ${queue.length} app${queue.length === 1 ? "" : "s"} summarised`
      );
    }
    policyTaskHandleRef.current = null;
    stopRequestedRef.current = "none";
  };

  const requestStop = (mode: Exclude<PolicyStopMode, "none">) => {
    stopRequestedRef.current = mode;
    if (mode === "now" && activeAbortRef.current) {
      activeAbortRef.current.abort();
    }
    setCancelModalOpen(false);
  };

  const refreshBackgroundImportProgress = useCallback(async () => {
    if (!importId) {
      return;
    }

    try {
      const res = await fetch(
        `/api/imports?id=${encodeURIComponent(importId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as { items?: ImportItemSnapshot[] };
      const items = Array.isArray(data?.items) ? data.items : [];
      const byId = new Map(items.map((item) => [item.id, item]));
      const currentScrapeList = scrapeListRef.current;
      const currentItemIds = itemIdByQueryRef.current;
      const activeItemIds = currentScrapeList
        .map((row) => (row.query ? currentItemIds.get(row.query) : undefined))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const allTerminal =
        currentScrapeList.length > 0 &&
        activeItemIds.length === currentScrapeList.length &&
        activeItemIds.every((id) => {
          const status = byId.get(id)?.status;
          return (
            status === "imported" ||
            status === "error" ||
            status === "removed" ||
            status === "skipped" ||
            status === "unmatched"
          );
        });

      setScrapeList((prev) => {
        if (prev.length === 0) {
          return prev;
        }

        let changed = false;
        const next = prev.map((row) => {
          const itemId = row.query ? currentItemIds.get(row.query) : undefined;
          const item = itemId ? byId.get(itemId) : undefined;
          if (!item) {
            return row;
          }

          const retryAfterMs =
            typeof item.nextAttemptAt === "number" &&
            item.nextAttemptAt > Date.now()
              ? item.nextAttemptAt - Date.now()
              : undefined;

          if (item.status === "imported") {
            const nextRow = {
              ...row,
              name: item.appName ?? row.name,
              url: item.url ?? row.url,
              status: "success" as const,
              error: undefined,
              retryAfterMs: undefined,
            };
            if (
              nextRow.status !== row.status ||
              nextRow.error !== row.error ||
              nextRow.retryAfterMs !== row.retryAfterMs ||
              nextRow.name !== row.name ||
              nextRow.url !== row.url
            ) {
              changed = true;
            }
            return nextRow;
          }

          if (item.status === "error" || item.status === "removed") {
            const nextRow = {
              ...row,
              name: item.appName ?? row.name,
              url: item.url ?? row.url,
              status: "error" as const,
              error: item.scrapeError ?? tStatus("scrape_failed_fallback"),
              retryAfterMs: undefined,
            };
            if (
              nextRow.status !== row.status ||
              nextRow.error !== row.error ||
              nextRow.retryAfterMs !== row.retryAfterMs ||
              nextRow.name !== row.name ||
              nextRow.url !== row.url
            ) {
              changed = true;
            }
            return nextRow;
          }

          if (item.status === "skipped" || item.status === "unmatched") {
            const nextRow = {
              ...row,
              status: "error" as const,
              error: item.scrapeError ?? tStatus("scrape_failed_fallback"),
              retryAfterMs: undefined,
            };
            if (
              nextRow.status !== row.status ||
              nextRow.error !== row.error ||
              nextRow.retryAfterMs !== row.retryAfterMs
            ) {
              changed = true;
            }
            return nextRow;
          }

          const nextRow = {
            ...row,
            name: item.appName ?? row.name,
            url: item.url ?? row.url,
            status: "queued" as const,
            error: item.scrapeError ?? tStep4("row_queued_default"),
            retryAfterMs,
          };
          if (
            nextRow.status !== row.status ||
            nextRow.error !== row.error ||
            nextRow.retryAfterMs !== row.retryAfterMs ||
            nextRow.name !== row.name ||
            nextRow.url !== row.url
          ) {
            changed = true;
          }
          return nextRow;
        });
        scrapeListRef.current = changed ? next : prev;
        return changed ? next : prev;
      });

      if (allTerminal) {
        setDone(true);
      }
    } catch (error) {
      console.warn(
        "[wizard] Failed to refresh background import progress:",
        error
      );
    }
  }, [importId, tStatus, tStep4]);

  useEffect(() => {
    if (step !== 4 || !importId || scrapeList.length === 0 || done) {
      return;
    }
    void refreshBackgroundImportProgress();
    const id = setInterval(() => {
      void refreshBackgroundImportProgress();
    }, 3000);
    return () => clearInterval(id);
  }, [
    done,
    importId,
    refreshBackgroundImportProgress,
    scrapeList.length,
    step,
  ]);

  // Re-sync mode bridge: once the scrape finishes (done=true) and we're
  // in re-sync mode, fetch the just-imported app ids from the import
  // record and open the diff overlay. The overlay then drives the
  // device-sync preview + commit.
  //
  // ONLY fires for URL-supplied re-sync (Settings → Devices "Re-sync"
  // button → /onboard?resync=<id>). The auto-resync path (cfgutil ECID
  // match without an explicit URL param) does its diff upfront in
  // step 2 via Step2DiffPanel, so this post-scrape overlay would
  // duplicate that interaction. Gate on `initialResyncDeviceIdFromUrl`
  // — the only state that proves the URL entry-point.
  useEffect(() => {
    if (!initialResyncDeviceIdFromUrl) {
      return;
    }
    if (!(resyncDeviceId && done && importId) || resyncOverlayOpen) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/imports?id=${encodeURIComponent(importId)}`,
          {
            cache: "no-store",
          }
        );
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        const apps = items
          .filter(
            (it: { appId?: unknown; status?: unknown }) =>
              typeof it.appId === "string" &&
              it.appId.length > 0 &&
              it.status === "imported"
          )
          .map(
            (it: {
              appId: string;
              appName?: string | null;
              developer?: string | null;
            }) => ({
              appId: it.appId,
              name: it.appName ?? "",
              developer: it.developer ?? null,
            })
          );
        if (!cancelled) {
          setResyncOverlayApps(apps);
          setResyncOverlayOpen(true);
        }
      } catch (error) {
        console.warn(
          "[wizard] failed to load imported apps for resync overlay:",
          error
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    resyncDeviceId,
    done,
    importId,
    resyncOverlayOpen,
    initialResyncDeviceIdFromUrl,
  ]);

  const startScraping = async (
    entries: [string, AppCandidate][],
    items: ScrapeStatus[]
  ) => {
    // Dev-only short-circuit. When the wizard was opened from the
    // DevMenu's "Onboarding preview" button, we're walking through
    // the flow for visual review only — the final import batch skips
    // entirely. Each row gets stamped 'success' synthetically so the UI
    // animates exactly as it would in production, but no /api/apps writes
    // happen and the activity log stays clean.
    if (isPreviewMode) {
      const updated = items.map((it) => ({
        ...it,
        status: "success" as const,
      }));
      // Mirror the real-import branch below: auto-open the per-app
      // details for small batches so a developer running the preview
      // flow sees the rendered scrape rows instead of a collapsed
      // <details> summary. Without this, the rows are technically in
      // the DOM but display:none — which Playwright reports as hidden
      // and which doesn't match production UX.
      setImportDetailsOpen(items.length <= 8);
      setScrapeList(updated);
      setDone(true);
      return;
    }

    const queued = items.map((it) => ({
      ...it,
      status: "queued" as const,
      error: tStep4("row_queued_default"),
    }));
    setImportDetailsOpen(items.length <= 8);
    scrapeListRef.current = queued;
    setScrapeList(queued);
    setDone(false);
    setScrapeRateLimit(null);
    setRateLimitPauseModal(null);

    if (!importId) {
      const failed = items.map((it) => ({
        ...it,
        status: "error" as const,
        error: tStatus("background_import_unavailable"),
      }));
      scrapeListRef.current = failed;
      setScrapeList(failed);
      setDone(true);
      return;
    }

    let queueStartedAt: number | null = null;
    try {
      const queuePayload = entries.map(([query, candidate]) => ({
        query,
        status: "queued" as const,
        appId: candidate.appleId,
        appName: candidate.name,
        developer: candidate.developer,
        url: candidate.url,
        iconUrl: candidate.iconUrl,
        country,
        scrapeError: null,
      }));
      queueStartedAt = performance.now();
      recordImportEvent("onboarding.queue.bulk.start", {
        items: queuePayload.length,
      });
      if (queuePayload.length > 0) {
        const res = await fetch("/api/imports/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ importId, items: queuePayload }),
        });
        if (!res.ok) {
          throw new Error(`Queue update failed with HTTP ${res.status}`);
        }
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data?.items)) {
          setItemIdByQuery((prev) => {
            const next = new Map(prev);
            for (const item of data.items) {
              if (
                typeof item?.query === "string" &&
                typeof item?.id === "string"
              ) {
                next.set(item.query, item.id);
              }
            }
            return next;
          });
        }
      }
      recordImportEvent("onboarding.queue.bulk.complete", {
        items: queuePayload.length,
        durationMs: Math.round(performance.now() - queueStartedAt),
      });

      // Same path as Settings → Import History → Retry, but start the
      // provider-owned foreground drain loop instead of kicking one server
      // tick. The server still claims rows in 10-item chunks; the provider
      // immediately asks for the next chunk until Apple 429s, the queue
      // empties, or the user cancels.
      const kickStartedAt = performance.now();
      recordImportEvent("onboarding.queue.kick.start", {
        items: queuePayload.length,
      });
      const queueSnapshot = await importQueue.refresh();
      recordImportEvent("onboarding.queue.drain.start", {
        queued: queuePayload.length,
      });
      importQueue.startDrain({
        initialSnapshot: queueSnapshot,
        forceRefresh: queueSnapshot === null,
      });
      recordImportEvent("onboarding.queue.kick.complete", {
        durationMs: Math.round(performance.now() - kickStartedAt),
      });
      await refreshBackgroundImportProgress();
    } catch (error) {
      console.error("[wizard] Failed to queue import batch:", error);
      recordImportEvent("onboarding.queue.bulk.error", {
        items: entries.length,
        durationMs:
          queueStartedAt === null
            ? undefined
            : Math.round(performance.now() - queueStartedAt),
        error:
          error instanceof Error
            ? error.message.slice(0, 120)
            : String(error).slice(0, 120),
      });
      setScrapeList((prev) => {
        const failed = prev.map((item) =>
          item.status === "success"
            ? item
            : {
                ...item,
                status: "error" as const,
                error: tStatus("background_import_start_failed"),
              }
        );
        scrapeListRef.current = failed;
        return failed;
      });
      setDone(true);
    }
  };

  const stepLabels: [Step, string][] = [
    [1, tStepLabels("1")],
    [2, tStepLabels("2")],
    [3, tStepLabels("3")],
    [4, tStepLabels("4")],
    [5, tStepLabels("5")],
  ];

  const currentNames = getNames();
  const selectedCount = currentNames.length;
  const providerOptions = getAiModelOptions(aiProvider);
  const selectedModelPreset = providerOptions.some(
    (option) => option.value === aiModel
  )
    ? aiModel
    : "__custom__";
  const selectedCfgutilDevice =
    cfgutilDevices.find((device) => device.ecid === selectedCfgutilEcid) ??
    null;

  const onProviderChange = (nextProvider: AIProvider) => {
    setAiProvider(nextProvider);
    setAiError("");

    const previousDefaultModel = resolveDefaultModel(aiProvider);
    const previousDefaultBaseUrl = resolveDefaultBaseUrl(aiProvider);

    if (!aiModel || aiModel === previousDefaultModel) {
      setAiModel(resolveDefaultModel(nextProvider));
    }

    if (!aiBaseUrl || aiBaseUrl === previousDefaultBaseUrl) {
      setAiBaseUrl(resolveDefaultBaseUrl(nextProvider));
    }
  };

  return {
    stepLabels,
    router,
    taskCenter,
    importQueue,
    tWiz,
    tMethod,
    tSearchBlock,
    tStepLabels,
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
    tPolicyRun,
    methodMeta,
    onboardMethodManualOn,
    onboardMethodFileOn,
    onboardMethodConfiguratorResolvedOn,
    onboardMethodConfiguratorOn,
    onboardMethodScreenshotOn,
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
    onboardAiSummarizeOnImportOn,
    methodAvailability,
    policyTaskHandleRef,
    textFileRef,
    imageFileRef,
    step,
    setStep,
    deviceClass,
    setDeviceClass,
    method,
    setMethod,
    userSelectedMethodRef,
    wizardRadioKeyDown,
    methodRadioKeyDown,
    liveTextModalOpen,
    setLiveTextModalOpen,
    country,
    setCountry,
    countryLoaded,
    setCountryLoaded,
    countryInferred,
    setCountryInferred,
    languageSuggestion,
    setLanguageSuggestion,
    trackAccessibility,
    setTrackAccessibility,
    queuedSearch,
    ratePending,
    rateTick,
    setRateTick,
    settingsLoaded,
    setSettingsLoaded,
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
    summarizeOnImport,
    setSummarizeOnImport,
    savingAi,
    setSavingAi,
    aiError,
    setAiError,
    uploadedFileName,
    setUploadedFileName,
    draftRestored,
    setDraftRestored,
    inDesktop,
    setInDesktop,
    cfgutilCheck,
    setCfgutilCheck,
    cfgutilChecking,
    setCfgutilChecking,
    cfgutilExporting,
    setCfgutilExporting,
    cfgutilError,
    setCfgutilError,
    cfgutilDiagnostic,
    setCfgutilDiagnostic,
    cfgutilDevices,
    setCfgutilDevices,
    cfgutilDevicesLoading,
    setCfgutilDevicesLoading,
    selectedCfgutilEcid,
    setSelectedCfgutilEcid,
    imageFiles,
    setImageFiles,
    isDraggingText,
    setIsDraggingText,
    isDraggingImages,
    setIsDraggingImages,
    ocring,
    setOcring,
    ocrMessage,
    setOcrMessage,
    ocrError,
    setOcrError,
    ocrErrorDetail,
    setOcrErrorDetail,
    isIosSafari,
    setIsIosSafari,
    importedApps,
    setImportedApps,
    pendingAppText,
    setPendingAppText,
    developerHints,
    bundleIdHints,
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
    manuallyChosenQueries,
    setManuallyChosenQueries,
    skippedQueries,
    setSkippedQueries,
    rematchingRegion,
    setRematchingRegion,
    searching,
    setSearching,
    searchError,
    setSearchError,
    searchBlocked,
    setSearchBlocked,
    blockSearchError,
    setBlockSearchError,
    blockSearching,
    setBlockSearching,
    searchProgress,
    setSearchProgress,
    searchAbortRef,
    hideTrackedBlocks,
    setHideTrackedBlocks,
    trackedByAppleId,
    setTrackedByAppleId,
    trackedByBundleId,
    setTrackedByBundleId,
    scrapeList,
    setScrapeList,
    done,
    setDone,
    importDetailsOpen,
    setImportDetailsOpen,
    scrapeListRef,
    scrapeRateLimit,
    setScrapeRateLimit,
    rateLimitPauseModal,
    setRateLimitPauseModal,
    scrapeCancelRef,
    scrapeRateTick,
    setScrapeRateTick,
    importDrainPausedUntil,
    importId,
    setImportId,
    itemIdByQuery,
    setItemIdByQuery,
    itemIdByQueryRef,
    editingBlock,
    setEditingBlock,
    policyProgress,
    setPolicyProgress,
    policyRunDone,
    setPolicyRunDone,
    activePhase,
    setActivePhase,
    phaseAvgMs,
    setPhaseAvgMs,
    cancelModalOpen,
    setCancelModalOpen,
    stopRequestedRef,
    activeAbortRef,
    scrapeActiveRowRef,
    scrapeListEndRef,
    etaTick,
    setEtaTick,
    restoreFileRef,
    restoreStage,
    setRestoreStage,
    restorePreview,
    setRestorePreview,
    pendingRestorePayload,
    setPendingRestorePayload,
    pendingRestoreFilename,
    setPendingRestoreFilename,
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
    setAiTestStatus,
    aiTestMessage,
    setAiTestMessage,
    aiTestLatency,
    setAiTestLatency,
    testAiConnection,
    updateCountry,
    updateTrackAccessibility,
    getNames,
    flushPendingAppText,
    parseTextFile,
    describeCfgutilDevice,
    describeCfgutilDeviceMeta,
    formatCfgutilError,
    refreshCfgutilDevices,
    runCfgutilCheck,
    runCfgutilExportClick,
    searchParams,
    isPreviewMode,
    initialResyncDeviceIdFromUrl,
    resyncDeviceId,
    setResyncDeviceId,
    resyncOverlayOpen,
    setResyncOverlayOpen,
    resyncOverlayApps,
    setResyncOverlayApps,
    priorImportHistory,
    setPriorImportHistory,
    step2DiffConfirmOpen,
    setStep2DiffConfirmOpen,
    step2DiffCommitting,
    setStep2DiffCommitting,
    step2DiffPicked,
    setStep2DiffPicked,
    isAutoResyncCfgutil,
    cfgutilAutoArmedRef,
    runOcr,
    handleTextDrop,
    handleImageDrop,
    handleImageSelection,
    deriveImportLabel,
    resolveDeviceIdForImport,
    createImportRecord,
    writeImportItems,
    runMatchSearch,
    commitStep2Diff,
    handleSearch,
    cancelSearch,
    handleBlockResearch,
    handleBlockSkip,
    handleCancelQueuedMatches,
    handleRegionRematch,
    handleConfirm,
    aiSettingsComplete,
    saveAiSettings,
    runPolicyRegeneration,
    requestStop,
    refreshBackgroundImportProgress,
    startScraping,
    currentNames,
    selectedCount,
    providerOptions,
    selectedModelPreset,
    selectedCfgutilDevice,
    onProviderChange,
  };
}

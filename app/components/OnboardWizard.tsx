"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AI_PROVIDER_OPTIONS,
  type AIProvider,
  getAiModelOptions,
  normalizeAiProvider,
  providerRequiresApiKey,
  providerSupportsApiKey,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
} from "../../lib/ai-config";
import {
  extractAppNamesFromOcr,
  isLikelyWebClipBundle,
  MAX_IMPORT_ROWS,
  parseImportedAppRows,
  parseManualAppText,
} from "../../lib/app-import";
import { recordImportEvent } from "../../lib/client-diagnostics";
import {
  APPLE_CONFIGURATOR_HTTPS_URL,
  APPLE_CONFIGURATOR_MACAPPSTORE_URL,
  type CfgutilCheckResult,
  type ConnectedDevice,
  checkCfgutil,
  findChildSafetyPropertyNames,
  isDesktop,
  listConnectedDevices,
  runCfgutilExport,
} from "../../lib/desktop";
import { type DeviceClass, refineDeviceOnClient } from "../../lib/device";
import { useFlag } from "../../lib/feature-flags-hooks";
import {
  COUNTRY_OPTIONS,
  countryLabel,
  DEFAULT_COUNTRY,
  inferCountryFromLocale,
  normalizeCountry,
} from "../../lib/region";
import AlreadyTrackedAccordion from "./AlreadyTrackedAccordion";
import DeviceSyncDiffOverlay from "./DeviceSyncDiffOverlay";
import ImportedAppsTable from "./ImportedAppsTable";
import { useImportQueue } from "./ImportQueueProvider";
import LanguageSuggestionBanner from "./LanguageSuggestionBanner";
import LiveTextModal from "./LiveTextModal";
import { type SearchResultLike, useQueuedSearch } from "./QueuedSearchProvider";
import RateLimitBanner from "./RateLimitBanner";
import SearchProgressCard from "./SearchProgressCard";
import Step2DiffConfirmModal from "./Step2DiffConfirmModal";
import Step2DiffPanel from "./Step2DiffPanel";
import { type TaskHandle, useTaskCenter } from "./TaskCenter";

interface AppCandidate {
  appleId: string;
  bundleId: string;
  developer: string;
  iconUrl: string;
  name: string;
  searchQuery: string;
  url: string;
}

/**
 * Shape we need for duplicate detection. /api/apps returns a superset, but
 * the wizard only cares about how to identify an already-tracked app: by
 * Apple track id (same as the candidate's appleId) for post-match detection,
 * by bundle id (catches the legacy-import duplicate where a name-search
 * import + a cfgutil bundle-ID import landed on different track IDs for
 * the same physical app), and by lowercase name for pre-match duplicate
 * warnings on Step 2.
 */
interface TrackedApp {
  bundleId: string | null;
  developer: string;
  id: string;
  name: string;
}

/**
 * One row in the step-2 imported-apps table. Replaces the old
 * `namesText: string` + `bundleIdHints: Map` + `developerHints: Map`
 * trio with a single structured array so bundle IDs and developer
 * hints can't silently drift away from their names when the user
 * edits the list. Each row gets a stable client-side `id` so React
 * keys stay stable across renders even with duplicate names.
 *
 * `source` is a UX-facing pill: which import path produced this row.
 * Used to colour the source chip and to drive the "+ developer hint
 * present" / "+ bundle ID present" badges in the table.
 *
 * `likelyWebClip` propagates from the CSV parser so the search
 * fallback can suggest the manual-apps editor for rows that look like
 * home-screen web clips rather than App Store apps.
 */
interface ImportedAppEntry {
  bundleId?: string;
  developer?: string;
  /** Stable client-side id (`uuid-or-fallback()`); not persisted. */
  id: string;
  likelyWebClip?: boolean;
  name: string;
  source: "manual" | "cfgutil" | "file" | "ocr";
}

/**
 * Build an {@link ImportedAppEntry} with a stable client-side id.
 * Falls back to a non-crypto id when `crypto.randomUUID` is missing
 * (older browsers / non-secure contexts) — the id only needs to be
 * stable within the current render tree so React keys don't churn.
 */
function makeImportedAppEntry(
  input: Omit<ImportedAppEntry, "id">
): ImportedAppEntry {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `ie_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return { id, ...input };
}

interface SearchResult {
  candidates: AppCandidate[];
  matchSource?: "bundle" | "name" | "manual";
  note?: string | null;
  query: string;
  searchedCountry?: string;
  sourceBundleId?: string | null;
  sourceDeveloper?: string | null;
  status?: "pending" | "matched" | "unmatched" | "skipped";
}

/**
 * Thrown when /api/search is rejected by the security gate rather than
 * failing on its own — proxy.ts returns 401 when a non-local host is
 * missing the admin token, 403 for cross-origin mutations. These are
 * deterministic per-request (every subsequent chunk fails the same way),
 * so the search loop bails out immediately and `handleSearch` surfaces a
 * distinct "API access is blocked" message instead of letting every row
 * fall through to "Not in the App Store".
 */
class SearchAccessBlockedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`/api/search blocked with HTTP ${status}`);
    this.name = "SearchAccessBlockedError";
    this.status = status;
  }
}

interface ScrapeStatus {
  changesDetected?: boolean;
  error?: string;
  name: string;
  query?: string;
  /** How many seconds the row is expected to wait before the worker retries. */
  retryAfterMs?: number;
  /**
   * 'queued' here mirrors the server-side import_items status: Apple rate-
   * limited us mid-batch, so this row is parked for the background worker
   * to pick up later. The UI shows a "Queued for background import" pill.
   */
  status: "pending" | "scraping" | "success" | "error" | "queued";
  url: string;
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

type PolicyPhaseStatus = "pending" | "working" | "done" | "error" | "skipped";

interface PolicyPhaseResult {
  detail?: string;
  finishedAt?: number;
  startedAt?: number;
  status: PolicyPhaseStatus;
}

interface PolicyRegenerateStatus {
  appId: string;
  name: string;
  scrape: PolicyPhaseResult;
  summarise: PolicyPhaseResult;
}

type PolicyRunPhase = "fetch" | "summarise" | null;
type PolicyStopMode = "none" | "now" | "after-current";

type Step = 1 | 2 | 3 | 4 | 5;
type ImportMethod = "screenshots" | "file" | "configurator" | "manual";

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

const ONBOARD_AI_OPTIONS = AI_PROVIDER_OPTIONS;

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

function formatMs(ms: number): string {
  if (ms < 0) {
    ms = 0;
  }
  const secs = Math.round(ms / 1000);
  if (secs < 60) {
    return `${secs}s`;
  }
  const mins = Math.floor(secs / 60);
  const remSec = secs % 60;
  return remSec === 0 ? `${mins}m` : `${mins}m ${remSec}s`;
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

/**
 * Per-device method layout for the step-1 picker. Keys:
 *   - `primary`   recommended option, default selection, rendered full-width.
 *   - `secondary` also visible up front, but below the primary card.
 *   - `advanced`  tucked inside a <details> drawer so they don't distract
 *                 most users but stay accessible if someone really wants them.
 * We deliberately drop the in-browser screenshot OCR path from phone + tablet
 * layouts — it doesn't work on iOS Safari — and route users to Live Text
 * instead via the modal opened from the manual-entry panel.
 */
const METHOD_LAYOUT: Record<
  DeviceClass,
  {
    primary: ImportMethod;
    secondary: ImportMethod[];
    advanced: ImportMethod[];
  }
> = {
  phone: {
    primary: "manual",
    secondary: [],
    advanced: ["file"],
  },
  tablet: {
    primary: "manual",
    secondary: [],
    advanced: ["file", "configurator"],
  },
  desktop: {
    primary: "configurator",
    secondary: ["file"],
    advanced: ["manual", "screenshots"],
  },
};

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

export default function OnboardWizard({
  initialDevice = "desktop",
  flags,
}: OnboardWizardProps) {
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
  const tModalRestore = useTranslations("onboard.modals.restore_backup");
  const tModalCancel = useTranslations("onboard.modals.cancel_summaries");
  const tModalRate = useTranslations("onboard.modals.rate_limit_pause");
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
  const [aiProvider, setAiProvider] = useState<AIProvider>("openai");
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

  /**
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
  interface OnboardRestorePreview {
    exportedAt: number | null;
    perTable: { name: string; rows: number }[];
    totalRows: number;
    version: number;
    warnings: string[];
  }
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
        const nextProvider =
          loadedProvider === "disabled" ? "openai" : loadedProvider;
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
                        aiTestStatus === "testing" ||
                        !aiBaseUrl.trim() ||
                        (providerRequiresApiKey(aiProvider) && !aiApiKey.trim())
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
                    savingAi || !settingsLoaded || aiProvider === "disabled"
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
              href="/welcome?customize=1"
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
                  className={`file-drop ${isDraggingImages ? "over" : ""}`}
                  onClick={() => imageFileRef.current?.click()}
                  onDragLeave={() => setIsDraggingImages(false)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsDraggingImages(true);
                  }}
                  onDrop={handleImageDrop}
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
                  className={`file-drop ${isDraggingText ? "over" : ""}`}
                  onClick={() => textFileRef.current?.click()}
                  onDragLeave={() => setIsDraggingText(false)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsDraggingText(true);
                  }}
                  onDrop={handleTextDrop}
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
                                      role="radiogroup"
                                    >
                                      {cfgutilDevices.map((device) => {
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
                                            type="button"
                                          >
                                            <span
                                              aria-hidden
                                              className="cfgutil-device-dot"
                                            />
                                            <span className="cfgutil-device-text">
                                              <span className="cfgutil-device-name">
                                                {describeCfgutilDevice(device)}
                                              </span>
                                              <span className="cfgutil-device-meta">
                                                {describeCfgutilDeviceMeta(
                                                  device
                                                )}
                                              </span>
                                            </span>
                                          </button>
                                        );
                                      })}
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
          <div
            className="modal-overlay"
            onClick={() => {
              if (restoreStage !== "applying") {
                resetRestoreFlow();
              }
            }}
          >
            <div
              aria-labelledby="onboard-restore-title"
              aria-modal="true"
              className="modal-card"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="modal-badge">{tModalRestore("badge")}</div>
              <h2 className="modal-title" id="onboard-restore-title">
                {tModalRestore("title")}
              </h2>
              <p className="modal-copy">
                {pendingRestoreFilename ? (
                  <>
                    <strong>{pendingRestoreFilename}</strong>
                    {restorePreview.exportedAt
                      ? tModalRestore("exported_suffix", {
                          date: new Date(
                            restorePreview.exportedAt
                          ).toLocaleDateString(),
                        })
                      : null}{" "}
                    {tModalRestore("version_suffix", {
                      version: restorePreview.version,
                    })}{" "}
                    {tModalRestore("rows", { count: restorePreview.totalRows })}
                  </>
                ) : (
                  tModalRestore("no_filename", {
                    count: restorePreview.totalRows,
                    tables: restorePreview.perTable.length,
                  })
                )}
              </p>

              <div
                aria-label={tModalRestore("rows_per_table_aria")}
                className="backup-preview-table"
              >
                {restorePreview.perTable
                  .filter((row) => row.rows > 0)
                  .map((row) => (
                    <div className="backup-preview-row" key={row.name}>
                      <span className="backup-preview-name">{row.name}</span>
                      <span className="backup-preview-count">
                        {row.rows.toLocaleString()}
                      </span>
                    </div>
                  ))}
              </div>

              {restorePreview.warnings.length > 0 && (
                <ul className="backup-preview-warnings">
                  {restorePreview.warnings.map((warning, index) => (
                    <li key={index}>⚠ {warning}</li>
                  ))}
                </ul>
              )}

              <div className="modal-warning" style={{ marginTop: 12 }}>
                {tModalRestore("warning")}
              </div>

              <label
                className="modal-confirm-label"
                htmlFor="onboard-restore-input"
              >
                {tModalRestore.rich("confirm_label", {
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </label>
              <input
                autoComplete="off"
                autoCorrect="off"
                className="modal-confirm-input"
                disabled={restoreStage === "applying"}
                id="onboard-restore-input"
                onChange={(event) => {
                  setRestoreConfirmText(event.target.value);
                  if (restoreError) {
                    setRestoreError("");
                  }
                }}
                placeholder={tModalRestore("confirm_placeholder")}
                spellCheck={false}
                type="text"
                value={restoreConfirmText}
              />

              {restoreError && (
                <p
                  style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}
                >
                  {restoreError}
                </p>
              )}

              <div className="modal-actions">
                <button
                  className="btn btn-ghost"
                  disabled={restoreStage === "applying"}
                  onClick={resetRestoreFlow}
                  type="button"
                >
                  {tModalRestore("cancel")}
                </button>
                <button
                  className="btn btn-danger"
                  disabled={
                    restoreStage === "applying" ||
                    restoreConfirmText.trim().toUpperCase() !== "RESTORE"
                  }
                  onClick={handleRestoreConfirm}
                  type="button"
                >
                  {restoreStage === "applying"
                    ? tModalRestore("restoring")
                    : tModalRestore("confirm")}
                </button>
              </div>
            </div>
          </div>
        )}

      {cancelModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => setCancelModalOpen(false)}
        >
          <div
            aria-describedby="cancel-modal-copy"
            aria-labelledby="cancel-modal-title"
            aria-modal="true"
            className="modal-card cancel-confirm-modal"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setCancelModalOpen(false);
              }
            }}
            role="dialog"
          >
            <h2 className="modal-title" id="cancel-modal-title">
              {tModalCancel("title")}
            </h2>
            <p className="modal-copy" id="cancel-modal-copy">
              {tModalCancel("body")}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setCancelModalOpen(false)}
                type="button"
              >
                {tModalCancel("keep_going")}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => requestStop("after-current")}
                type="button"
              >
                {tModalCancel("stop_after_current")}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => requestStop("now")}
                type="button"
              >
                {tModalCancel("stop_now")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rate-limit pause modal. Opened by the scrape loop on the first
          Apple 429. Gives the user two concrete next steps so they don't
          just sit watching a frozen progress list:
            • "View Import History" — opens Settings → Import History so
              they can watch the background queue worker drain the rest.
            • "Summarise privacy policies" — advances the wizard to step 5
              (AI summaries) for whatever apps imported cleanly before the
              rate-limit hit. Hidden when nothing imported successfully,
              since there'd be nothing to summarise. */}
      {rateLimitPauseModal && (
        <div
          className="modal-overlay"
          onClick={() => setRateLimitPauseModal(null)}
        >
          <div
            aria-describedby="rate-limit-modal-copy"
            aria-labelledby="rate-limit-modal-title"
            aria-modal="true"
            className="modal-card rate-limit-pause-modal"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setRateLimitPauseModal(null);
              }
            }}
            role="dialog"
          >
            <div className="modal-badge">{tModalRate("badge")}</div>
            <h2 className="modal-title" id="rate-limit-modal-title">
              {tModalRate("title")}
            </h2>
            <p className="modal-copy" id="rate-limit-modal-copy">
              {tModalRate("body_lead")}
              {tModalRate.rich("body_queued", {
                count: rateLimitPauseModal.queuedCount,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
              {tModalRate("body_retry_minutes", {
                count: Math.max(
                  1,
                  Math.round(rateLimitPauseModal.retryAfterMs / 60_000)
                ),
              })}
              {rateLimitPauseModal.successCount > 0 &&
                tModalRate.rich("body_success", {
                  count: rateLimitPauseModal.successCount,
                  b: (chunks) => <strong>{chunks}</strong>,
                })}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setRateLimitPauseModal(null)}
                type="button"
              >
                {tModalRate("stay_here")}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setRateLimitPauseModal(null);
                  router.push("/dashboard/settings/import-history");
                }}
                type="button"
              >
                {tModalRate("view_history")}
              </button>
              {rateLimitPauseModal.successCount > 0 && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setRateLimitPauseModal(null);
                    // Step 5 = AI summaries. The button in the page
                    // footer does the same thing, but the modal makes
                    // it a one-click path from the pause itself.
                    setStep(5);
                  }}
                  type="button"
                >
                  {tModalRate("summarise")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

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
function PolicyRunPanel({
  progress,
  activePhase,
  runDone,
  phaseAvgMs,
  onCancelRequest,
  onViewDashboard,
}: {
  progress: PolicyRegenerateStatus[];
  activePhase: PolicyRunPhase;
  runDone: boolean;
  phaseAvgMs: { fetch: number | null; summarise: number | null };
  etaTick: number;
  onCancelRequest: () => void;
  onViewDashboard: () => void;
}) {
  const total = progress.length;

  const scrapeDone = progress.filter(
    (p) =>
      p.scrape.status === "done" ||
      p.scrape.status === "error" ||
      p.scrape.status === "skipped"
  ).length;
  const summariseDone = progress.filter(
    (p) =>
      p.summarise.status === "done" ||
      p.summarise.status === "error" ||
      p.summarise.status === "skipped"
  ).length;

  const overallCompleted = scrapeDone + summariseDone;
  const overallTotal = total * 2;
  const pct =
    overallTotal === 0
      ? 0
      : Math.round((overallCompleted / overallTotal) * 100);

  const t = useTranslations("onboard.policy_run");
  // ETA: use the active phase's rolling average × remaining.
  let etaText: string | null = null;
  if (activePhase === "fetch" && phaseAvgMs.fetch !== null) {
    const remaining = total - scrapeDone;
    if (remaining > 0) {
      etaText = t("eta_fetch", {
        time: formatMs(remaining * phaseAvgMs.fetch),
      });
    }
  } else if (activePhase === "summarise" && phaseAvgMs.summarise !== null) {
    const remainingSummarise = progress.filter(
      (p) =>
        p.summarise.status === "pending" || p.summarise.status === "working"
    ).length;
    if (remainingSummarise > 0) {
      etaText = t("eta_summarise", {
        time: formatMs(remainingSummarise * phaseAvgMs.summarise),
      });
    }
  }

  const phaseLabel =
    activePhase === "fetch"
      ? t("phase_fetch")
      : activePhase === "summarise"
        ? t("phase_summarise")
        : runDone
          ? t("phase_finished")
          : t("phase_starting");

  const totalsLabel =
    activePhase === "fetch"
      ? t("totals_fetch", { done: scrapeDone, total })
      : activePhase === "summarise"
        ? t("totals_summarise", { done: summariseDone, total })
        : runDone
          ? t("totals_done", { fetched: scrapeDone, summarised: summariseDone })
          : "";

  return (
    <div className="policy-run-panel">
      <div className="policy-run-header">
        <div>
          <div className="policy-run-eyebrow">{phaseLabel}</div>
          <div className="policy-run-title">
            {totalsLabel}
            {etaText && <span className="policy-run-eta"> · {etaText}</span>}
          </div>
        </div>
        {runDone ? (
          <button
            className="btn btn-primary"
            onClick={onViewDashboard}
            type="button"
          >
            {t("view_dashboard")}
          </button>
        ) : (
          <button
            className="btn btn-secondary"
            onClick={onCancelRequest}
            type="button"
          >
            {t("cancel")}
          </button>
        )}
      </div>

      <div className="policy-run-progress-bar">
        <div
          className="policy-run-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="policy-run-rows">
        {progress.map((item, index) => (
          <div className="policy-phase-row" key={`${item.appId}-${index}`}>
            <div className="policy-phase-app">
              <div className="policy-phase-app-name">{item.name}</div>
            </div>
            <PolicyPhaseCell
              kind="scrape"
              label={t("scrape_label")}
              result={item.scrape}
            />
            <PolicyPhaseCell
              kind="summarise"
              label={t("summarise_label")}
              result={item.summarise}
            />
          </div>
        ))}
      </div>

      {runDone && (
        <div className="policy-run-footer">
          <button
            className="btn btn-secondary"
            onClick={onViewDashboard}
            type="button"
          >
            {t("go_dashboard")}
          </button>
        </div>
      )}
    </div>
  );
}

function PolicyPhaseCell({
  label,
  kind,
  result,
}: {
  label: string;
  kind: "scrape" | "summarise";
  result: PolicyPhaseResult;
}) {
  const t = useTranslations("onboard.policy_run");
  const icon =
    result.status === "pending" ? (
      "○"
    ) : result.status === "working" ? (
      <span className="spinner-sm" />
    ) : result.status === "done" ? (
      "✓"
    ) : result.status === "error" ? (
      "✕"
    ) : (
      "—"
    );

  const verb =
    result.status === "pending"
      ? t("verb_pending")
      : result.status === "working"
        ? kind === "scrape"
          ? t("verb_fetching")
          : t("verb_summarising")
        : result.status === "done"
          ? t("verb_done")
          : result.status === "error"
            ? t("verb_failed")
            : t("verb_skipped");

  let timing: string | null = null;
  if (result.startedAt) {
    const end = result.finishedAt ?? Date.now();
    const elapsed = end - result.startedAt;
    if (result.status === "working") {
      timing = t("elapsed_suffix", { time: formatMs(elapsed) });
    } else if (result.finishedAt) {
      timing = formatMs(elapsed);
    }
  }

  return (
    <div className={`policy-phase-col policy-phase-${result.status}`}>
      <div className="policy-phase-col-label">{label}</div>
      <div className="policy-phase-col-state">
        <span className="policy-phase-icon">{icon}</span>
        <span className="policy-phase-verb">{verb}</span>
        {timing && <span className="policy-phase-timing">{timing}</span>}
      </div>
      {result.detail && (
        <div className="policy-phase-detail">{result.detail}</div>
      )}
    </div>
  );
}

/**
 * Inline "Edit name & retry" affordance for each row in the
 * "Not in the App Store" triage section. Lets the user fix
 * capitalisation / typos / add a developer hint on a query that
 * came back empty, and re-fire `/api/search` for JUST that one
 * block via the existing `handleBlockResearch` path. Mirrors the
 * matched-block edit affordance in `SearchResultBlock`; without
 * this, the only way to retry a single unmatched query was to
 * back out of step 3, fix the name in step 2's textarea, and
 * re-run the whole search — which used to nuke every other pick
 * the user had already made.
 */
function UnavailableRowEditor({
  initialQuery,
  busyEditing,
  onRetry,
  onCancel,
}: {
  busyEditing: boolean;
  initialQuery: string;
  onCancel: () => void;
  onRetry: (nextQuery: string) => void;
}) {
  const t = useTranslations("onboard.search_block");
  const [draft, setDraft] = useState(initialQuery);
  const trimmed = draft.trim();
  // Unchanged text is still submittable — the parent passes force=true,
  // so "Search again" replays the same query (useful after a transient
  // iTunes miss or a since-unblocked security gate).
  const canSubmit = !busyEditing && trimmed.length > 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flex: "1 1 100%",
        flexWrap: "wrap",
      }}
    >
      <input
        autoFocus
        className="settings-input"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSubmit) {
            e.preventDefault();
            onRetry(trimmed);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={t("edit_app_name")}
        style={{ flex: "1 1 220px", minWidth: 0 }}
        type="text"
        value={draft}
      />
      <button
        className="btn btn-primary btn-sm"
        disabled={!canSubmit}
        onClick={() => onRetry(trimmed)}
        type="button"
      >
        {busyEditing ? <span className="spinner-sm" /> : t("search_again")}
      </button>
      <button
        className="btn btn-secondary btn-sm"
        disabled={busyEditing}
        onClick={onCancel}
        type="button"
      >
        {t("cancel")}
      </button>
    </div>
  );
}

function SearchResultBlock({
  result,
  chosen,
  editing,
  developerHint,
  trackedByAppleId,
  trackedByBundleId,
  onChoose,
  onResearch,
  onSkip,
}: {
  result: SearchResult;
  chosen: AppCandidate | null;
  editing: boolean;
  /**
   * Seller / developer pre-filled from the CSV import (empty string when the
   * row had no vendor column or the user is on a manual path). Editable in
   * the edit row so users can nudge the ranking for vague names.
   */
  developerHint: string;
  trackedByAppleId: Map<string, TrackedApp>;
  /**
   * Same set, keyed by bundle ID. Catches legacy duplicates where the
   * existing app row has a different App Store track ID than the one
   * iTunes is returning for the cfgutil import. Optional so callers
   * that haven't been updated yet still render — the per-candidate
   * tracked badge just under-detects in that case.
   */
  trackedByBundleId?: Map<string, TrackedApp>;
  onChoose: (candidate: AppCandidate | null) => void;
  /**
   * `force` lets the no-matches Retry button replay the *same* query — useful
   * after an iTunes 429 wiped out this block's candidates. Without it, the
   * parent's "nothing changed" guard would short-circuit the call.
   */
  onResearch: (
    nextQuery: string,
    nextDeveloper?: string,
    force?: boolean
  ) => Promise<void> | void;
  onSkip: () => Promise<void> | void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(result.query);
  const [draftDeveloper, setDraftDeveloper] = useState(developerHint);

  // When collapsed and the user has chosen a candidate, show THAT one — not
  // the iTunes #1 pick — so "Show less" after selecting a non-top match
  // collapses to the user's actual choice instead of snapping back to #1.
  // Falls back to the first candidate for blocks the user hasn't touched.
  const chosenIsVisibleWhenCollapsed = chosen
    ? result.candidates.some((c) => c.appleId === chosen.appleId)
    : false;
  const candidates = showAll
    ? result.candidates
    : chosenIsVisibleWhenCollapsed
      ? [chosen!]
      : result.candidates.slice(0, 1);

  // A candidate is "tracked" if its App Store numeric id matches something
  // already in our DB. We surface this at two levels:
  //   • a block-level pill next to "Confirmed" when the chosen candidate is
  //     already tracked, so the user knows the import will re-sync not dupe;
  //   • a per-row chip so they can spot existing records while browsing
  //     alternate matches.
  const chosenTracked = chosen
    ? trackedByAppleId.get(chosen.appleId)
    : undefined;

  // Language for the toggle button. When a selection is confirmed, the "+X"
  // count describes "other" candidates so it stays honest.
  const t = useTranslations("onboard.search_block");
  const tPh = useTranslations("settings.placeholders");
  const otherCount = Math.max(0, result.candidates.length - 1);
  const moreLabel = chosen
    ? t("see_other_chosen", { count: otherCount })
    : t("see_other_unchosen", { count: otherCount });
  const status =
    result.status ??
    (chosen
      ? "matched"
      : result.candidates.length > 0
        ? "matched"
        : "unmatched");
  const matchMethodLabel =
    result.matchSource === "bundle"
      ? t("method_bundle")
      : result.matchSource === "manual"
        ? t("method_manual")
        : result.matchSource === "name"
          ? t("method_name")
          : null;
  const storefrontLabel = result.searchedCountry
    ? countryLabel(result.searchedCountry)
    : null;

  const beginEdit = () => {
    setDraft(result.query);
    // Sync the seller draft to the latest hint every time we open the editor,
    // so a CSV-imported value (or a prior manual edit that got persisted back
    // into developerHints) shows up pre-filled.
    setDraftDeveloper(developerHint);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setDraft(result.query);
    setDraftDeveloper(developerHint);
  };

  const commitEdit = async () => {
    const next = draft.trim();
    const nextDev = draftDeveloper.trim();
    const nameChanged = !!next && next !== result.query;
    const devChanged = nextDev !== developerHint;
    setIsEditing(false);
    if (!next) {
      return;
    }
    if (!(nameChanged || devChanged)) {
      return;
    }
    // Pass the seller draft through so the parent can push it into the
    // shared developerHints map and include it in the next /api/search.
    // Undefined = "leave hint alone"; we only send a value when the user
    // actually touched the field.
    await onResearch(next, devChanged ? nextDev : undefined);
  };

  return (
    <div className={`search-result-item ${chosen ? "selected" : ""}`}>
      <div className="search-result-query-row">
        {isEditing ? (
          <div className="search-result-edit-fields">
            <label className="search-result-edit-field">
              <span className="search-result-edit-label">
                {t("edit_app_name")}
              </span>
              <input
                autoFocus
                className="settings-input search-result-edit-input"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void commitEdit();
                  }
                  if (event.key === "Escape") {
                    cancelEdit();
                  }
                }}
                spellCheck={false}
                value={draft}
              />
            </label>
            <label className="search-result-edit-field">
              <span className="search-result-edit-label">
                {t("edit_seller")}{" "}
                <span className="search-result-edit-hint">
                  {developerHint
                    ? t("edit_seller_csv")
                    : t("edit_seller_optional")}
                </span>
              </span>
              <input
                className="settings-input search-result-edit-input"
                onChange={(event) => setDraftDeveloper(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void commitEdit();
                  }
                  if (event.key === "Escape") {
                    cancelEdit();
                  }
                }}
                placeholder={developerHint || tPh("developer_eg")}
                spellCheck={false}
                value={draftDeveloper}
              />
            </label>
            <div className="search-result-edit-actions">
              <button
                className="btn btn-secondary btn-sm"
                disabled={editing}
                onClick={() => void commitEdit()}
                type="button"
              >
                {editing ? (
                  <>
                    <span className="spinner-sm" /> {t("researching")}
                  </>
                ) : (
                  t("research")
                )}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={editing}
                onClick={cancelEdit}
                type="button"
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Top sub-row: app name on the left, status pills floated
                right via margin-left:auto on the pills wrapper. Title
                wraps to a second line on narrow viewports rather than
                colliding with the pill. */}
            <div className="search-result-query-top">
              <div className="search-result-query">
                &ldquo;{result.query}&rdquo;
              </div>
              {(chosen ||
                chosenTracked ||
                (developerHint && !chosen) ||
                status === "pending" ||
                matchMethodLabel) && (
                <div className="search-result-query-pills">
                  {status === "pending" && (
                    <span className="search-result-pending">
                      {t("pending_pill")}
                    </span>
                  )}
                  {chosen && (
                    <span
                      className="search-result-confirmed"
                      title={t("confirmed_title", {
                        name: chosen.name,
                        dev: chosen.developer,
                      })}
                    >
                      {t("confirmed")}
                    </span>
                  )}
                  {matchMethodLabel && (
                    <span className="search-result-method">
                      {matchMethodLabel}
                    </span>
                  )}
                  {chosenTracked && (
                    // Renamed from "Already tracking" to "Re-sync App info"
                    // because the former described the *state* (you
                    // already have this) while the latter describes
                    // the *action* that will happen if they import it
                    // again — which is what the user actually needs to
                    // know at this point in the flow. The old per-row
                    // "Tracked" chip that used to echo this on the
                    // candidate row has been removed in favour of this
                    // single block-level pill so the row stops showing
                    // two redundant tracking indicators.
                    <span
                      className="search-result-tracked"
                      title={t("tracked_pill_title", {
                        name: chosenTracked.name,
                      })}
                    >
                      {t("tracked_pill")}
                    </span>
                  )}
                  {developerHint && !chosen && (
                    <span
                      className="search-result-hint"
                      title={t("seller_chip_title")}
                    >
                      {t("seller_chip", { dev: developerHint })}
                    </span>
                  )}
                </div>
              )}
            </div>
            {/* Bottom sub-row: action buttons. On mobile this wraps
                under the title so the pill never gets crowded out. */}
            <div className="search-result-query-actions">
              <button
                className="btn btn-ghost btn-sm"
                disabled={editing}
                onClick={beginEdit}
                type="button"
              >
                {t("edit_button")}
              </button>
              {chosen && (
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={editing}
                  onClick={() => void onSkip()}
                  type="button"
                >
                  {t("skip_this")}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {status === "pending" ? (
        <div className="search-result-empty search-result-pending-body">
          <p className="search-result-empty-copy">
            {t("pending_copy")}
            {result.sourceBundleId
              ? t("pending_bundle_suffix", { id: result.sourceBundleId })
              : ""}
          </p>
          <div className="search-result-empty-actions">
            <button
              className="btn btn-ghost btn-sm"
              disabled={editing}
              onClick={() => void onSkip()}
              type="button"
            >
              {t("skip_this")}
            </button>
          </div>
        </div>
      ) : result.candidates.length === 0 ? (
        <div className="search-result-empty">
          <p className="search-result-empty-copy">
            {result.sourceBundleId
              ? storefrontLabel
                ? t("no_record_bundle_storefront", {
                    id: result.sourceBundleId,
                    storefront: storefrontLabel,
                  })
                : t("no_record_bundle", { id: result.sourceBundleId })
              : `${t("no_matches_lead")}${isEditing ? t("no_matches_editing") : t("no_matches_idle")}`}
          </p>
          {!isEditing && (
            <div className="search-result-empty-actions">
              <button
                className="btn btn-secondary btn-sm"
                disabled={editing}
                onClick={() => void onResearch(result.query, undefined, true)}
                title={t("retry_title")}
                type="button"
              >
                {editing ? (
                  <>
                    <span className="spinner-sm" /> {t("retry_busy")}
                  </>
                ) : (
                  t("retry_search")
                )}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={editing}
                onClick={beginEdit}
                type="button"
              >
                {t("edit_name_seller")}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={editing}
                onClick={() => void onSkip()}
                type="button"
              >
                {t("skip_this")}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {candidates.map((candidate) => {
            // Bundle-ID fallback catches the legacy-import duplicate
            // case where the same physical app exists under a
            // different App Store track ID — see TrackedApp comment.
            const candidateTracked =
              trackedByAppleId.get(candidate.appleId) ??
              (candidate.bundleId
                ? trackedByBundleId?.get(candidate.bundleId)
                : undefined);
            const bundleMismatch = Boolean(
              result.sourceBundleId &&
                candidate.bundleId &&
                result.sourceBundleId.toLowerCase() !==
                  candidate.bundleId.toLowerCase()
            );
            return (
              <div
                // The `tracked` modifier applies row-level styling (tint
                // + left border). The inline "Tracked" chip next to the
                // candidate name is back on top of that — removing it
                // made the selected-candidate case ambiguous when the
                // block-level "Re-sync App info" pill scrolled off-
                // screen on long lists, so the per-row chip earns its
                // keep even with some visual duplication.
                className={`candidate-row ${chosen?.appleId === candidate.appleId ? "chosen" : ""} ${candidateTracked ? "tracked" : ""}`}
                key={candidate.appleId}
                onClick={() =>
                  onChoose(
                    chosen?.appleId === candidate.appleId ? null : candidate
                  )
                }
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    border: `2px solid ${chosen?.appleId === candidate.appleId ? "var(--blue)" : "var(--border-strong)"}`,
                    background:
                      chosen?.appleId === candidate.appleId
                        ? "var(--blue)"
                        : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    color: "#fff",
                    flexShrink: 0,
                    transition: "all 0.15s",
                  }}
                >
                  {chosen?.appleId === candidate.appleId ? "✓" : ""}
                </span>

                {candidate.iconUrl && (
                  <Image
                    alt={candidate.name}
                    className="candidate-icon"
                    height={40}
                    src={candidate.iconUrl}
                    style={{ objectFit: "cover" }}
                    unoptimized
                    width={40}
                  />
                )}
                <div className="candidate-body">
                  <div className="candidate-name">
                    {candidate.name}
                    {/* Inline "already tracking" chip. Renders for every
                        tracked candidate (not just the chosen one) so
                        users browsing alternate matches can still tell
                        which rows would re-sync rather than add a
                        duplicate. When this candidate is the one the
                        user picked, we also show the block-level
                        "Re-sync App info" pill — the duplication is
                        deliberate: the chip is visible alongside the
                        name even on long lists where the block header
                        has scrolled off. */}
                    {candidateTracked && (
                      <span
                        aria-label={t("candidate_tracking_aria")}
                        className="candidate-tracked-chip"
                      >
                        {t("candidate_tracking_chip")}
                      </span>
                    )}
                    {bundleMismatch && (
                      <span className="candidate-bundle-warning">
                        Bundle differs
                      </span>
                    )}
                  </div>
                  <div className="candidate-dev">{candidate.developer}</div>
                  {result.sourceBundleId && (
                    <div className="candidate-dev">
                      Imported {result.sourceBundleId}
                      {candidate.bundleId
                        ? ` · App Store ${candidate.bundleId}`
                        : ""}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {result.candidates.length > 1 && (
            <button
              className="show-more-btn"
              onClick={() => setShowAll(!showAll)}
              type="button"
            >
              {showAll ? t("show_less") : moreLabel}
            </button>
          )}
        </>
      )}
    </div>
  );
}

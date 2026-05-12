'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import Link from 'next/link';
import { extractAppNamesFromOcr, parseImportedAppRows, parseManualAppText, MAX_IMPORT_ROWS } from '../../lib/app-import';
import { useTaskCenter, type TaskHandle } from './TaskCenter';
import { useQueuedSearch, type SearchResultLike } from './QueuedSearchProvider';
import { useImportQueue } from './ImportQueueProvider';
import {
  AI_PROVIDER_OPTIONS,
  getAiModelOptions,
  normalizeAiProvider,
  providerRequiresApiKey,
  providerSupportsApiKey,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
  type AIProvider,
} from '../../lib/ai-config';
import { COUNTRY_OPTIONS, DEFAULT_COUNTRY, normalizeCountry } from '../../lib/region';
import { refineDeviceOnClient, type DeviceClass } from '../../lib/device';
import {
  APPLE_CONFIGURATOR_HTTPS_URL,
  APPLE_CONFIGURATOR_MACAPPSTORE_URL,
  checkCfgutil,
  isDesktop,
  listConnectedDevices,
  runCfgutilExport,
  type ConnectedDevice,
  type CfgutilCheckResult,
} from '../../lib/desktop';
import LiveTextModal from './LiveTextModal';
import LanguageSuggestionBanner from './LanguageSuggestionBanner';
import RateLimitBanner from './RateLimitBanner';
import { useFlag } from '../../lib/feature-flags-hooks';
import { recordImportEvent } from '../../lib/client-diagnostics';

interface AppCandidate {
  appleId: string;
  name: string;
  developer: string;
  iconUrl: string;
  url: string;
  bundleId: string;
  searchQuery: string;
}

/**
 * Shape we need for duplicate detection. /api/apps returns a superset, but
 * the wizard only cares about how to identify an already-tracked app: by
 * Apple track id (same as the candidate's appleId) for post-match detection,
 * and by lowercase name for pre-match duplicate warnings on Step 2.
 */
interface TrackedApp {
  id: string;
  name: string;
  developer: string;
}

interface SearchResult {
  query: string;
  candidates: AppCandidate[];
}

interface ScrapeStatus {
  query?: string;
  url: string;
  name: string;
  /**
   * 'queued' here mirrors the server-side import_items status: Apple rate-
   * limited us mid-batch, so this row is parked for the background worker
   * to pick up later. The UI shows a "Queued for background import" pill.
   */
  status: 'pending' | 'scraping' | 'success' | 'error' | 'queued';
  error?: string;
  changesDetected?: boolean;
  /** How many seconds the row is expected to wait before the worker retries. */
  retryAfterMs?: number;
}

interface ImportItemSnapshot {
  id: string;
  query: string;
  editedQuery: string | null;
  status: string;
  appName: string | null;
  url: string | null;
  scrapeError: string | null;
  nextAttemptAt: number | null;
}

interface StoredAiSettings {
  provider: AIProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  summarizeOnImport: boolean;
}

type PolicyPhaseStatus = 'pending' | 'working' | 'done' | 'error' | 'skipped';

interface PolicyPhaseResult {
  status: PolicyPhaseStatus;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface PolicyRegenerateStatus {
  appId: string;
  name: string;
  scrape: PolicyPhaseResult;
  summarise: PolicyPhaseResult;
}

type PolicyRunPhase = 'fetch' | 'summarise' | null;
type PolicyStopMode = 'none' | 'now' | 'after-current';

type Step = 1 | 2 | 3 | 4 | 5;
type ImportMethod = 'screenshots' | 'file' | 'configurator' | 'manual';

/**
 * Imports backed by a CSV/TXT drop (including Apple Configurator exports) all
 * get persisted with `source = 'file'` so the history schema stays narrow; the
 * configurator variant is differentiated via the `sourceLabel` column.
 */
function persistedSourceForMethod(method: ImportMethod): 'screenshots' | 'file' | 'manual' {
  return method === 'configurator' ? 'file' : method;
}

const ONBOARD_AI_OPTIONS = AI_PROVIDER_OPTIONS;

type StatusT = (key: string) => string;

function describeFetchStatus(t: StatusT, status: string | undefined, error?: string): string | undefined {
  switch (status) {
    case 'ready':
      return t('fetch_ready');
    case 'source_ready':
      return t('fetch_source_ready');
    case 'fetch_error':
      return error || t('fetch_error');
    case 'unsupported_content_type':
      return t('fetch_unsupported');
    case 'too_short':
      return t('fetch_too_short');
    case 'analysis_error':
      return error || t('fetch_analysis_error');
    case 'needs_ai_config':
      return t('fetch_needs_ai');
    default:
      return status;
  }
}

function describeSummariseStatus(t: StatusT, status: string | undefined, error?: string): string | undefined {
  switch (status) {
    case 'ready':
      return t('summary_ready');
    case 'source_ready':
      return t('summary_awaiting');
    case 'analysis_error':
      return error || t('summary_analysis_error');
    case 'needs_ai_config':
      return t('summary_needs_ai');
    default:
      return status;
  }
}

function formatMs(ms: number): string {
  if (ms < 0) ms = 0;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSec = secs % 60;
  return remSec === 0 ? `${mins}m` : `${mins}m ${remSec}s`;
}

type MethodMetaMap = Record<ImportMethod, {
  title: string;
  eyebrow: string;
  blurb: string;
  hint: string;
}>;

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
const METHOD_LAYOUT: Record<DeviceClass, {
  primary: ImportMethod;
  secondary: ImportMethod[];
  advanced: ImportMethod[];
}> = {
  phone: {
    primary: 'manual',
    secondary: [],
    advanced: ['file'],
  },
  tablet: {
    primary: 'manual',
    secondary: [],
    advanced: ['file', 'configurator'],
  },
  desktop: {
    primary: 'configurator',
    secondary: ['file'],
    advanced: ['manual', 'screenshots'],
  },
};

interface OnboardWizardProps {
  /**
   * Server-sniffed device class from the UA header. Drives the initial
   * method-card layout so the first paint shows the right primary option
   * for this device. Refined client-side by `refineDeviceOnClient` once
   * viewport width / touch points become observable.
   */
  initialDevice?: DeviceClass;
  /**
   * Server-resolved flags whose first paint must match the runtime-aware
   * resolver. Client-side `useFlag` falls back to hard defaults before the
   * resolver cache is hydrated, which is not enough for Tauri-only gates.
   */
  flags?: {
    methodConfigurator: boolean;
  };
}

type MethodAvailability = Record<ImportMethod, boolean>;

function orderedMethodsForDevice(device: DeviceClass): ImportMethod[] {
  const layout = METHOD_LAYOUT[device];
  return [layout.primary, ...layout.secondary, ...layout.advanced];
}

function pickFirstEnabledMethod(
  device: DeviceClass,
  availability: MethodAvailability,
): ImportMethod {
  return orderedMethodsForDevice(device).find(m => availability[m]) ?? 'manual';
}

export default function OnboardWizard({ initialDevice = 'desktop', flags }: OnboardWizardProps) {
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
  const tWiz = useTranslations('onboard.wizard_titles');
  const tMethod = useTranslations('onboard.methods');
  const tStepLabels = useTranslations('onboard.step_labels');
  const tStepIndicator = useTranslations('onboard.step_indicator');
  const tOnboard = useTranslations('onboard');
  const tAiStep = useTranslations('onboard.ai_step');
  const tAiOptions = useTranslations('ai_options');
  const tStep1 = useTranslations('onboard.step1');
  const tStep2 = useTranslations('onboard.step2');
  const tStep3 = useTranslations('onboard.step3');
  const tStep4 = useTranslations('onboard.step4');
  const tModalRestore = useTranslations('onboard.modals.restore_backup');
  const tModalCancel = useTranslations('onboard.modals.cancel_summaries');
  const tModalRate = useTranslations('onboard.modals.rate_limit_pause');
  const tCfg = useTranslations('onboard.cfgutil');
  const tStatus = useTranslations('onboard_status');
  // Localised method metadata. Returns the same shape the
  // original static lookup exposed so call-sites that read
  // `methodMeta[method].title` etc. don't have to know the
  // translation lives elsewhere. Built via useMemo so the lookup
  // table is stable across renders, only rebuilt when the locale
  // changes (which forces a full reload in this app, so in practice
  // the dependency is constant).
  const methodMeta = useMemo<MethodMetaMap>(() => ({
    screenshots: {
      title: tMethod('screenshots.title'),
      eyebrow: tMethod('screenshots.eyebrow'),
      blurb: tMethod('screenshots.blurb'),
      hint: tMethod('screenshots.hint'),
    },
    file: {
      title: tMethod('file.title'),
      eyebrow: tMethod('file.eyebrow'),
      blurb: tMethod('file.blurb'),
      hint: tMethod('file.hint'),
    },
    configurator: {
      title: tMethod('configurator.title'),
      eyebrow: tMethod('configurator.eyebrow'),
      blurb: tMethod('configurator.blurb'),
      hint: tMethod('configurator.hint'),
    },
    manual: {
      title: tMethod('manual.title'),
      eyebrow: tMethod('manual.eyebrow'),
      blurb: tMethod('manual.blurb'),
      hint: tMethod('manual.hint'),
    },
  }), [tMethod]);

  // Wave I: per-method onboarding flags. Each `flag.onboarding.method.*`
  // controls whether the matching `ImportMethod` card shows up on the
  // step-1 picker. The set is computed once per render and threaded into
  // the layout filter below; methods that resolve off are removed from
  // both the primary row and the Advanced drawer (and from auto-pick).
  const onboardMethodManualOn = useFlag('flag.onboarding.method.manual_entry') === 'on';
  const onboardMethodFileOn = useFlag('flag.onboarding.method.file_upload') === 'on';
  const onboardMethodConfiguratorResolvedOn = useFlag('flag.onboarding.method.configurator') === 'on';
  const onboardMethodConfiguratorOn =
    flags?.methodConfigurator ?? onboardMethodConfiguratorResolvedOn;
  const onboardMethodScreenshotOn = useFlag('flag.onboarding.method.screenshot_ocr') === 'on';
  const onboardMethodLiveTextOn = useFlag('flag.onboarding.method.live_text_help') === 'on';
  // Step-3 "Hide already-tracked apps" inline toggle inside the
  // already-tracked banner. When off the banner shows the count
  // without the toggle (so the user can't filter the rescrape list).
  const onboardHideTrackedToggleOn = useFlag('flag.onboarding.confirm.hide_tracked_toggle') === 'on';
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
  const onboardStepAiSummariesOn = useFlag('flag.onboarding.step.ai_summaries') === 'on';
  const onboardPostDashboardSkipOn = useFlag('flag.onboarding.post.dashboard_skip') === 'on';
  const onboardPostBackgroundWorkerOn = useFlag('flag.onboarding.post.background_worker') === 'on';
  const onboardImportRateLimitHandoffOn = useFlag('flag.onboarding.import.rate_limit_handoff') === 'on';
  // Step-1 footer affordances. The "Restore from a backup file" link
  // and the (yet-to-render) "Import audit bundle" link sit below the
  // primary method picker — both are quiet escape hatches for users
  // arriving with existing exports.
  const onboardMethodRestoreBackupOn = useFlag('flag.onboarding.method.restore_backup') === 'on';
  const onboardMethodImportAuditBundleOn = useFlag('flag.onboarding.method.import_audit_bundle') === 'on';
  // Step-1 settings rows: the App Store region picker and the
  // "track accessibility labels" toggle each gate independently so a
  // curated focus can hide either without disturbing the other.
  const onboardStepAppStoreRegionOn = useFlag('flag.onboarding.step.app_store_region') === 'on';
  const onboardStepAccessibilityToggleOn = useFlag('flag.onboarding.step.accessibility_toggle') === 'on';
  // Wave I — wizard step body gates. Each one wraps the body of the
  // matching step so the section disappears under curated focus, while
  // the wizard's `step` state machine still allows back/next navigation
  // between the numbered steps. When a step body is gated off, the user
  // clicks Next past the empty step.
  const onboardStepChooseMethodOn = useFlag('flag.onboarding.step.choose_method') === 'on';
  const onboardStepConfirmMatchesOn = useFlag('flag.onboarding.step.confirm_matches') === 'on';
  const onboardStepImportProgressOn = useFlag('flag.onboarding.step.import_progress') === 'on';
  // Onboarding-namespace twin of `flag.settings.ai.summarize_on_import`.
  // The settings flag controls whether the persisted preference (from
  // /api/settings) influences anything; this one is the wizard's own
  // gate so a curated focus can suppress on-import summaries even if
  // the user later flips the saved preference on. Currently treated as
  // an AND-gate against `summarizeOnImport` — flipping either off
  // cancels the auto-summarise behaviour during the wizard's first
  // import. Kept separate from the settings flag so the values aren't
  // accidentally yoked together when revisiting onboarding.
  const onboardAiSummarizeOnImportOn = useFlag('flag.onboarding.ai.summarize_on_import') === 'on';
  // The remaining method flags (restore_backup, import_audit_bundle) are
  // routed via separate links/components — wired further below where they
  // surface, not via the method-card filter here.
  const methodAvailability = useMemo<MethodAvailability>(() => ({
    manual: onboardMethodManualOn,
    file: onboardMethodFileOn,
    configurator: onboardMethodConfiguratorOn,
    screenshots: onboardMethodScreenshotOn,
  }), [
    onboardMethodManualOn,
    onboardMethodFileOn,
    onboardMethodConfiguratorOn,
    onboardMethodScreenshotOn,
  ]);
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
    setDeviceClass(prev => refineDeviceOnClient(prev));
    // One-shot; resize re-evaluation would change the primary method mid-
    // interaction, which is jarring. Users who rotate or resize can pick
    // whatever option they want manually from the Advanced drawer.
  }, []);
  /** Default the picker to the first flag-enabled method for this device class. */
  const [method, setMethod] = useState<ImportMethod>(() =>
    pickFirstEnabledMethod(initialDevice, methodAvailability),
  );
  /** Once the user picks a method deliberately, device-class refinements should
   *  not bounce them to a different recommendation unless their selected
   *  method becomes hidden by a feature flag. */
  const userSelectedMethodRef = useRef(false);
  useEffect(() => {
    const visibleForDevice = orderedMethodsForDevice(deviceClass)
      .filter(m => methodAvailability[m]);
    const recommended = visibleForDevice[0] ?? 'manual';
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
    'zh' | 'en' | null
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
    if (!ratePending.pending || ratePending.resumeAt === null) return;
    const id = setInterval(() => setRateTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [ratePending.pending, ratePending.resumeAt]);

  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [storedAi, setStoredAi] = useState<StoredAiSettings | null>(null);
  const [aiProvider, setAiProvider] = useState<AIProvider>('openai');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState(resolveDefaultBaseUrl('openai'));
  const [aiModel, setAiModel] = useState(resolveDefaultModel('openai'));
  const [summarizeOnImport, setSummarizeOnImport] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [aiError, setAiError] = useState('');

  const [namesText, setNamesText] = useState('');
  const [uploadedFileName, setUploadedFileName] = useState('');

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
  const [cfgutilCheck, setCfgutilCheck] = useState<CfgutilCheckResult | null>(null);
  const [cfgutilChecking, setCfgutilChecking] = useState(false);
  const [cfgutilExporting, setCfgutilExporting] = useState(false);
  const [cfgutilError, setCfgutilError] = useState('');
  /**
   * Raw stdout from the most recent cfgutil run, captured when the
   * import returned zero apps so the user can diagnose what happened
   * (locked device, trust prompt pending, malformed JSON, etc.).
   * Cleared on retry. Only populated on the empty-apps failure path —
   * a successful import doesn't surface this to keep the wizard's
   * happy path uncluttered.
   */
  const [cfgutilDiagnostic, setCfgutilDiagnostic] = useState<string | null>(null);
  const [cfgutilDevices, setCfgutilDevices] = useState<ConnectedDevice[]>([]);
  const [cfgutilDevicesLoading, setCfgutilDevicesLoading] = useState(false);
  const [selectedCfgutilEcid, setSelectedCfgutilEcid] = useState<string | null>(null);
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
      setDeviceClass('desktop');
    }
  }, [inDesktop]);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [isDraggingText, setIsDraggingText] = useState(false);
  const [isDraggingImages, setIsDraggingImages] = useState(false);
  const [ocring, setOcring] = useState(false);
  const [ocrMessage, setOcrMessage] = useState('');
  const [ocrError, setOcrError] = useState('');
  /** Captures the underlying OCR error for diagnostics, surfaced in a collapsed
   *  `<details>` under the red wizard note. Kept separate from `ocrError` so the
   *  human-readable message stays clean and the raw tesseract.js error (often
   *  something like "SharedArrayBuffer is not defined" or a CDN fetch failure)
   *  is only surfaced when the user actively asks for it. */
  const [ocrErrorDetail, setOcrErrorDetail] = useState('');
  /** Mobile Safari (iOS WKWebView / SFSafariViewController included) tends to
   *  choke on tesseract.js because the WASM core + English traineddata are
   *  pulled from external CDNs, SharedArrayBuffer requires COOP/COEP, and
   *  memory ceilings are low. We warn users up front rather than letting them
   *  discover it via a generic failure message. Detection is best-effort — we
   *  accept false positives (ipados desktop mode reports as macOS, which we
   *  already route past this path). */
  const [isIosSafari, setIsIosSafari] = useState(false);
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const ua = navigator.userAgent || '';
    const platform = (navigator as any).platform || '';
    // iPhone / iPod always show up in UA. iPadOS 13+ lies about being Mac but
    // still exposes a touchscreen, which desktop Safari does not.
    const isIosDevice =
      /iP(hone|od|ad)/i.test(ua) ||
      (platform === 'MacIntel' && typeof (navigator as any).maxTouchPoints === 'number' && (navigator as any).maxTouchPoints > 1);
    // Safari on iOS: UA contains 'Safari' but not 'CriOS' (Chrome), 'FxiOS'
    // (Firefox), 'EdgiOS', 'OPiOS'. Third-party browsers on iOS all use WebKit
    // under the hood so the OCR limitations apply to them too — flag them all.
    const looksLikeMobileWebKit = isIosDevice && /WebKit/i.test(ua);
    setIsIosSafari(Boolean(looksLikeMobileWebKit));
  }, []);
  /** Optional developer hint per name, sourced from a CSV seller/vendor column.
   *  Keyed by the lowercased name so edits in the textarea still line up. */
  const [developerHints, setDeveloperHints] = useState<Map<string, string>>(new Map());
  /**
   * Optional bundle-ID hint per name, sourced from a cfgutil import only.
   * Keyed by the lowercased name (mirrors `developerHints`). Populated when
   * the wizard knows the user came in via Apple Configurator and we have
   * Apple's canonical bundle identifier for each app. Used by `handleSearch`
   * to issue an iTunes `lookup?bundleId=…` call (exact match per ID, no
   * fuzzy ranking) BEFORE falling back to name search for any unmatched
   * residual. CSV / OCR / manual paths leave this empty, so they continue
   * to take the name-search path as before.
   */
  const [bundleIdHints, setBundleIdHints] = useState<Map<string, string>>(new Map());
  /** Informational message about the imported file — e.g. "capped at 500 of 812 rows". */
  const [importInfo, setImportInfo] = useState('');

  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<Map<string, AppCandidate>>(new Map());
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
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
  const [trackedByAppleId, setTrackedByAppleId] = useState<Map<string, TrackedApp>>(new Map());

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
  const [scrapeRateLimit, setScrapeRateLimit] = useState<{ resumeAt: number; reason: string } | null>(null);
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
  const [rateLimitPauseModal, setRateLimitPauseModal] = useState<
    { queuedCount: number; successCount: number; retryAfterMs: number } | null
  >(null);
  /** Set by the Task Center cancel hook — flips the batched loop to the
   *  "queue the rest" path on the next iteration boundary. */
  const scrapeCancelRef = useRef(false);
  /** Re-render tick so the step-4 banner can show a ticking seconds value
   *  even while `scrapeRateLimit` itself is stable. */
  const [scrapeRateTick, setScrapeRateTick] = useState(0);
  useEffect(() => {
    if (!scrapeRateLimit) return;
    const id = setInterval(() => setScrapeRateTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [scrapeRateLimit]);

  // Import-history plumbing
  const [importId, setImportId] = useState<string | null>(null);
  // Maps the current block-key (query-or-edited-query) to the server-side item id.
  const [itemIdByQuery, setItemIdByQuery] = useState<Map<string, string>>(new Map());
  const itemIdByQueryRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    itemIdByQueryRef.current = itemIdByQuery;
  }, [itemIdByQuery]);
  // Per-block re-search state (key = current query for that block).
  const [editingBlock, setEditingBlock] = useState<string | null>(null);

  // AI step (now last, optional) — regeneration progress list
  const [policyProgress, setPolicyProgress] = useState<PolicyRegenerateStatus[]>([]);
  const [policyRunDone, setPolicyRunDone] = useState(false);
  const [activePhase, setActivePhase] = useState<PolicyRunPhase>(null);
  const [phaseAvgMs, setPhaseAvgMs] = useState<{ fetch: number | null; summarise: number | null }>({
    fetch: null,
    summarise: null,
  });
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const stopRequestedRef = useRef<PolicyStopMode>('none');
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
    if (activePhase === null) return;
    const interval = setInterval(() => setEtaTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activePhase]);
  useEffect(() => {
    if (policyRunDone && cancelModalOpen) setCancelModalOpen(false);
  }, [policyRunDone, cancelModalOpen]);

  // When Step 4 advances to the next app, bring that row into view so the
  // user can watch progress without having to scroll long lists themselves.
  // `block: 'nearest'` avoids a disorienting jump when the row is already
  // visible, and a soft behaviour keeps the motion calm.
  useEffect(() => {
    if (step !== 4) return;
    const el = scrapeActiveRowRef.current;
    if (!el) return;
    try {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch {
      // Older browsers without smooth-scroll support — fall back silently.
      el.scrollIntoView();
    }
  }, [step, scrapeList]);

  // ── Restore-from-backup (Step 1 footer) ────────────────────────────────
  // Mirrors the Settings flow: pick → preview → typed-confirmation → apply.
  // Inline here because the onboarding shell has no SettingsView in scope.
  type OnboardRestoreStage = 'idle' | 'previewing' | 'confirm' | 'applying';
  interface OnboardRestorePreview {
    version: number;
    exportedAt: number | null;
    perTable: { name: string; rows: number }[];
    totalRows: number;
    warnings: string[];
  }
  const restoreFileRef = useRef<HTMLInputElement>(null);
  const [restoreStage, setRestoreStage] = useState<OnboardRestoreStage>('idle');
  const [restorePreview, setRestorePreview] = useState<OnboardRestorePreview | null>(null);
  const [pendingRestorePayload, setPendingRestorePayload] = useState<string | null>(null);
  const [pendingRestoreFilename, setPendingRestoreFilename] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState('');
  const [restoreConfirmText, setRestoreConfirmText] = useState('');

  const resetRestoreFlow = () => {
    setRestoreStage('idle');
    setRestorePreview(null);
    setPendingRestorePayload(null);
    setPendingRestoreFilename(null);
    setRestoreError('');
    setRestoreConfirmText('');
  };

  const handleRestoreFileChosen = async (file: File) => {
    setRestoreError('');
    setRestoreStage('previewing');
    setPendingRestoreFilename(file.name);
    setRestoreConfirmText('');
    try {
      const text = await file.text();
      let previewBody: unknown;
      try {
        previewBody = JSON.parse(text);
      } catch {
        throw new Error(tStatus('restore_invalid_json'));
      }
      const res = await fetch('/api/backup/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewBody),
      });
      if (!res.ok) {
        let msg = tStatus('restore_validate_failed');
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch { /* no-op */ }
        throw new Error(msg);
      }
      const preview = (await res.json()) as OnboardRestorePreview;
      setRestorePreview(preview);
      setPendingRestorePayload(text);
      setRestoreStage('confirm');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setRestoreError(msg);
      setPendingRestorePayload(null);
      setRestorePreview(null);
      setRestoreStage('idle');
    }
  };

  const handleRestoreConfirm = async () => {
    if (!pendingRestorePayload) return;
    if (restoreConfirmText.trim().toUpperCase() !== 'RESTORE') {
      setRestoreError(tStatus('restore_type_to_confirm'));
      return;
    }
    setRestoreError('');
    setRestoreStage('applying');
    try {
      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: pendingRestorePayload,
      });
      if (!res.ok) {
        let msg = tStatus('restore_failed');
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch { /* no-op */ }
        setRestoreError(msg);
        setRestoreStage('confirm');
        return;
      }
      // After a successful restore the onboarding flow is irrelevant — the
      // user already has data. Send them straight to the dashboard.
      window.location.href = '/dashboard';
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : tStatus('restore_failed'));
      setRestoreStage('confirm');
    }
  };

  // AI connection test (step 5)
  const [aiTestStatus, setAiTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [aiTestMessage, setAiTestMessage] = useState('');
  const [aiTestLatency, setAiTestLatency] = useState<number | null>(null);

  useEffect(() => {
    setAiTestStatus('idle');
    setAiTestMessage('');
    setAiTestLatency(null);
  }, [aiProvider, aiApiKey, aiBaseUrl]);

  const testAiConnection = async () => {
    setAiTestStatus('testing');
    setAiTestMessage('');
    setAiTestLatency(null);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: aiProvider, apiKey: aiApiKey, baseUrl: aiBaseUrl }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        latencyMs?: number;
      };
      setAiTestStatus(data.ok ? 'ok' : 'fail');
      setAiTestMessage(typeof data.message === 'string' ? data.message : '');
      setAiTestLatency(typeof data.latencyMs === 'number' ? data.latencyMs : null);
    } catch (error) {
      console.error('[wizard] AI connection test failed:', error);
      setAiTestStatus('fail');
      setAiTestMessage(error instanceof Error ? error.message : String(error));
      setAiTestLatency(null);
    }
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        const loadedProvider = normalizeAiProvider(data.ai_provider ?? 'disabled');
        const nextProvider = loadedProvider === 'disabled' ? 'openai' : loadedProvider;
        const nextAi: StoredAiSettings = {
          provider: nextProvider,
          apiKey: data.ai_api_key ?? '',
          baseUrl: (data.ai_base_url ?? '') || resolveDefaultBaseUrl(nextProvider),
          model: (data.ai_model ?? '') || resolveDefaultModel(nextProvider),
          summarizeOnImport: data.ai_summarize_on_import === 'true',
        };

        setStoredAi(loadedProvider === 'disabled' ? null : nextAi);
        setAiProvider(nextAi.provider);
        setAiApiKey(nextAi.apiKey);
        setAiBaseUrl(nextAi.baseUrl);
        setAiModel(nextAi.model);
        setSummarizeOnImport(nextAi.summarizeOnImport);
        // Hydrate country last so the picker defaults to whatever the user
        // saved previously (e.g. 'au') instead of hard-coding 'us'.
        setCountry(normalizeCountry(data.app_country ?? DEFAULT_COUNTRY));
        setCountryLoaded(true);
        // Accessibility toggle: respect whatever is saved, defaulting to true
        // for first-run since the feature is opt-out rather than opt-in.
        if (typeof data.track_accessibility_labels === 'boolean') {
          setTrackAccessibility(data.track_accessibility_labels);
        } else if (data.track_accessibility_labels !== undefined) {
          setTrackAccessibility(data.track_accessibility_labels !== 'false');
        }
      } catch (error) {
        console.error('[wizard] Failed to load /api/settings:', error);
        setAiError(tStatus('ai_load_failed'));
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
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_country: normalised }),
      });
    } catch (error) {
      // Non-fatal — search still uses the local state value via POST body.
      console.warn('[wizard] Failed to persist country setting:', error);
    }

    // Region → language suggestion. Probes /api/locale (the same
    // source LocaleSwitcher reads) and surfaces the banner when
    // the storefront's expected language disagrees with the
    // active UI locale. Failure is silent — the country itself
    // saved fine; the user can still switch language manually
    // from Settings → Language.
    try {
      const r = await fetch('/api/locale');
      if (r.ok) {
        const body = (await r.json()) as { locale?: string };
        const active = body.locale === 'zh' ? 'zh' : 'en';
        if (normalised === 'cn' && active === 'en') {
          setLanguageSuggestion('zh');
        } else if (normalised !== 'cn' && active === 'zh') {
          setLanguageSuggestion('en');
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
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_accessibility_labels: next }),
      });
    } catch (error) {
      console.warn('[wizard] Failed to persist accessibility setting:', error);
    }
  }, []);

  // Snapshot the tracked app list once when the wizard opens. We don't refetch
  // in the middle of the flow — the "already tracked" hint is a soft nudge, and
  // staleness here just means a newly-added row isn't flagged for that session.
  useEffect(() => {
    const loadTracked = async () => {
      try {
        const res = await fetch('/api/apps');
        if (!res.ok) return;
        const apps = (await res.json()) as Array<{
          id?: unknown;
          name?: unknown;
          developer?: unknown;
        }>;
        const byId = new Map<string, TrackedApp>();
        for (const raw of apps) {
          if (typeof raw?.id !== 'string' || typeof raw?.name !== 'string') continue;
          const entry: TrackedApp = {
            id: raw.id,
            name: raw.name,
            developer: typeof raw.developer === 'string' ? raw.developer : '',
          };
          byId.set(entry.id, entry);
        }
        setTrackedByAppleId(byId);
      } catch (error) {
        // Non-fatal — duplicate detection is a convenience, not a hard stop.
        console.warn('[wizard] Failed to load tracked apps:', error);
      }
    };
    void loadTracked();
  }, []);

  const getNames = useCallback(() => parseManualAppText(namesText), [namesText]);

  const parseTextFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = event => {
      const text = typeof event.target?.result === 'string' ? event.target.result : '';
      const parsed = parseImportedAppRows(text);
      const names = parsed.rows.map(r => r.name);

      // Store developer hints keyed by lowercased name so they survive
      // whitespace / casing differences when we look them up at search time.
      const hints = new Map<string, string>();
      for (const row of parsed.rows) {
        if (row.developer) hints.set(row.name.toLowerCase(), row.developer);
      }
      setDeveloperHints(hints);

      setNamesText(names.join('\n'));
      setUploadedFileName(file.name);
      setOcrError('');
      setSearchError('');

      // Surface truncation to the user so a 213-row CSV doesn't silently
      // lose rows. We report against the cap so they know exactly what
      // they're looking at.
      if (parsed.truncated) {
        setImportInfo(
          `Imported the first ${names.length} app names of ${parsed.totalRowsInSource} rows in the file. ` +
          `The importer caps at ${MAX_IMPORT_ROWS} names per batch — re-run onboarding on the remaining rows to finish the audit.`,
        );
      } else if (names.length < parsed.totalRowsInSource) {
        const dropped = parsed.totalRowsInSource - names.length;
        setImportInfo(
          `Imported ${names.length} app name${names.length !== 1 ? 's' : ''} — ` +
          `${dropped} row${dropped !== 1 ? 's' : ''} looked like duplicates or non-name fields and were skipped.`,
        );
      } else {
        setImportInfo('');
      }
    };
    reader.onerror = () => {
      setSearchError(tStatus('search_file_unreadable'));
    };
    reader.readAsText(file);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, []);

  const describeCfgutilDevice = useCallback((device: ConnectedDevice): string => {
    if (device.name) return device.name;
    if (device.model) return device.model;
    if (device.deviceClass) return device.deviceClass;
    return tCfg('device_fallback');
  }, [tCfg]);

  const describeCfgutilDeviceMeta = useCallback((device: ConnectedDevice): string => {
    const bits = [
      device.deviceClass,
      device.model,
      device.iosVersion ? tCfg('device_ios_version', { version: device.iosVersion }) : null,
    ].filter((bit): bit is string => typeof bit === 'string' && bit.trim().length > 0);
    return bits.length > 0 ? bits.join(' · ') : tCfg('device_meta_unknown');
  }, [tCfg]);

  const formatCfgutilError = useCallback((message: string): string => {
    const trimmed = message.trim();
    const lower = trimmed.toLowerCase();
    if (lower.includes("unknown option '--version'") || lower.includes('unknown option --version')) {
      return tCfg('error_unknown_version');
    }
    if (lower.includes('no devices are connected') || lower.includes('no connected devices')) {
      return tCfg('step3_no_devices');
    }
    if (lower.includes('trust') || lower.includes('pair') || lower.includes('passcode')) {
      return tCfg('error_trust');
    }
    if (lower.includes('timed out') || lower.includes('did not finish')) {
      return tCfg('error_timeout');
    }
    const detail = trimmed.length > 260 ? `${trimmed.slice(0, 257)}...` : trimmed;
    return tCfg('error_generic', { detail });
  }, [tCfg]);

  const refreshCfgutilDevices = useCallback(async (): Promise<ConnectedDevice[]> => {
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
        setCfgutilError(tCfg('step2_copy_not_found'));
        return [];
      }

      setCfgutilDevices(result.devices);
      setSelectedCfgutilEcid(prev => {
        if (prev && result.devices.some(device => device.ecid === prev)) return prev;
        if (result.devices.length === 1) return result.devices[0].ecid;
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
    setCfgutilError('');
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
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
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
      console.error('[cfgutil] check failed', err);
      setCfgutilError(formatCfgutilError(err instanceof Error ? err.message : String(err)));
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
  const runCfgutilExportClick = useCallback(async (scopedEcid?: string) => {
    setCfgutilExporting(true);
    setCfgutilError('');
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
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    try {
      let targetEcid = scopedEcid ?? selectedCfgutilEcid ?? null;
      let devices = cfgutilDevices;
      if (!targetEcid) {
        devices = await refreshCfgutilDevices();
        if (devices.length === 1) {
          targetEcid = devices[0].ecid;
          setSelectedCfgutilEcid(targetEcid);
        } else if (devices.length > 1) {
          setCfgutilError(tCfg('step3_select_required'));
          return;
        } else {
          setCfgutilError(tCfg('step3_no_devices'));
          return;
        }
      }

      const selectedDevice = devices.find(device => device.ecid === targetEcid);
      const result = await runCfgutilExport(targetEcid);
      // Record that cfgutil was successfully used at least once on this
      // install. The device-connect toast on /onboard subscribes to USB
      // attach events only when this flag is set — keeps the cost off
      // users who never adopted the cfgutil workflow.
      if (result.apps.length > 0) {
        void fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cfgutil_imported_at: Date.now() }),
        }).catch(() => {
          // Non-fatal — the import succeeded; the gate just stays off
          // until the next successful cfgutil run.
        });
      }
      if (result.apps.length === 0) {
        setCfgutilError(
          result.deviceCount === 0
            ? tCfg('step3_no_devices')
            : tCfg('step3_no_apps'),
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
      const rawNames = result.apps.map(app => app.name).filter(n => n.trim().length > 0);
      const names: string[] = [];
      const seenLower = new Set<string>();
      for (const candidate of rawNames) {
        const key = candidate.toLocaleLowerCase();
        if (seenLower.has(key)) continue;
        seenLower.add(key);
        names.push(candidate);
      }
      const mergedDuplicates = rawNames.length - names.length;
      const hints = new Map<string, string>();
      // Capture bundleId-by-name so handleSearch can issue an iTunes
      // lookup-by-bundleId for cfgutil imports (exact match per ID, no
      // fuzzy ranking) before falling back to name search for any
      // residual. We key by lowercased name to match how
      // `developerHints` works — that lets a user who edits the
      // textarea name still hit the same hint, and lets handleSearch
      // do `bundleIdHints.get(name.toLowerCase())` without an extra
      // normalisation step.
      const bundles = new Map<string, string>();
      for (const app of result.apps) {
        if (app.developer && app.name) {
          hints.set(app.name.toLowerCase(), app.developer);
        }
        if (app.bundleId && app.name) {
          bundles.set(app.name.toLowerCase(), app.bundleId);
        }
      }
      setDeveloperHints(hints);
      setBundleIdHints(bundles);
      setNamesText(names.join('\n'));
      // Encode the device class as a structured " · "-delimited segment
      // ahead of the friendly name so the import-history renderer
      // (SettingsView) can pick out an icon for the entry. Format:
      //   "Apple Configurator · iPhone · Aria's iPhone"
      //                          ^^^^^^   ^^^^^^^^^^^^^
      //                          class    user-named device
      // Falls back to the bare friendly name when cfgutil didn't
      // surface a deviceClass (older builds or anonymous-device
      // states), so the label stays readable either way.
      const deviceFriendly = selectedDevice ? describeCfgutilDevice(selectedDevice) : null;
      const deviceClass = selectedDevice?.deviceClass?.trim() || null;
      const deviceLabel = selectedDevice
        ? deviceClass && deviceClass !== deviceFriendly
          ? `${deviceClass} · ${deviceFriendly}`
          : (deviceFriendly ?? '')
        : `${result.deviceCount} device${result.deviceCount !== 1 ? 's' : ''}`;
      setUploadedFileName(
        selectedDevice
          ? `Apple Configurator · ${deviceLabel}`
          : `Apple Configurator (${deviceLabel})`,
      );
      setOcrError('');
      setSearchError('');
      // Use the *deduped* count so this number agrees with the
      // "X apps ready to match" header that the wizard list renders
      // below — both come from the same `names` array now.
      const importedSummary = tCfg('step3_imported_count', {
        count: names.length,
        device: selectedDevice ? describeCfgutilDevice(selectedDevice) : tCfg('device_fallback'),
      });
      // When cfgutil reported more raw entries than we kept after the
      // case-insensitive name dedupe, append a one-line note so the
      // user knows where the missing rows went. Common causes are a
      // TestFlight beta + production with the same display name, or
      // two genuinely-different apps that happen to share a label
      // ("Calculator", "Notes"). The note uses a translator-friendly
      // sub-key so locales can phrase the parenthetical naturally.
      const summaryWithNote = mergedDuplicates > 0
        ? `${importedSummary} ${tCfg('step3_merged_duplicates', { count: mergedDuplicates })}`
        : importedSummary;
      setImportInfo(summaryWithNote);
    } catch (err) {
      console.error('[cfgutil] export failed', err);
      setCfgutilError(formatCfgutilError(err instanceof Error ? err.message : String(err)));
    } finally {
      setCfgutilExporting(false);
    }
  }, [
    cfgutilDevices,
    describeCfgutilDevice,
    formatCfgutilError,
    refreshCfgutilDevices,
    selectedCfgutilEcid,
    tCfg,
  ]);

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
  const isPreviewMode = searchParams?.get('preview') === 'fresh';

  const cfgutilAutoArmedRef = useRef(false);
  useEffect(() => {
    if (cfgutilAutoArmedRef.current) return;
    if (searchParams?.get('source') !== 'cfgutil') return;
    if (!onboardMethodConfiguratorOn) return;
    cfgutilAutoArmedRef.current = true;
    userSelectedMethodRef.current = false;
    setMethod('configurator');
    // ECID flows through as a query param on the toast's deep-link
    // so the export can scope to the specific device the user
    // clicked. Falling through to undefined when the param is absent
    // preserves the multi-device fan-out behaviour the wizard's
    // manual button has always had.
    const ecid = searchParams?.get('ecid') ?? undefined;
    // Defer the actual export by one tick so the method-card UI has
    // a chance to render the picker first — without this, the user
    // would see the export's loading spinner before the wizard
    // visibly switches modes, which feels broken.
    const timer = setTimeout(() => {
      runCfgutilExportClick(ecid);
    }, 80);
    return () => clearTimeout(timer);
  }, [searchParams, runCfgutilExportClick, onboardMethodConfiguratorOn]);

  const runOcr = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    setOcring(true);
    setOcrError('');
    setOcrErrorDetail('');
    setOcrMessage(tStatus('ocr_preparing'));
    setSearchError('');

    // Diagnostics: the OCR path has a lot of async hops that can hang
    // silently (tesseract.js dynamic import, WASM download, traineddata
    // fetch, per-image recognize, worker terminate). The hang in the
    // wild came with zero console output, so this function narrates
    // every step with timings. In dev builds the narration goes to the
    // devtools console; in production we stay quiet by default but
    // honour `localStorage.setItem('debug:ocr', '1')` for users who can
    // be asked to enable it when reporting "it just spun forever".
    const ocrDebug =
      process.env.NODE_ENV !== 'production' ||
      (typeof window !== 'undefined' &&
        window.localStorage?.getItem('debug:ocr') === '1');
    const t0 = performance.now();
    const mark = (label: string, extra?: Record<string, unknown>) => {
      if (!ocrDebug) return;
      const ms = Math.round(performance.now() - t0);
      if (extra) {
        console.log(`[ocr] +${ms}ms ${label}`, extra);
      } else {
        console.log(`[ocr] +${ms}ms ${label}`);
      }
    };

    mark('start', {
      fileCount: files.length,
      files: files.map(f => ({ name: f.name, type: f.type, bytes: f.size })),
      isIosSafari,
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : '(no navigator)',
      crossOriginIsolated:
        typeof globalThis !== 'undefined' && 'crossOriginIsolated' in globalThis
          ? (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
          : '(unknown)',
    });

    try {
      mark('dynamic-import tesseract.js: begin');
      const { createWorker } = await import('tesseract.js');
      mark('dynamic-import tesseract.js: resolved');

      mark('createWorker(eng): begin');
      // tesseract.js's createWorker accepts a logger callback which fires
      // for every phase transition (loading core, downloading traineddata,
      // recognizing). Wiring it to console lets us see whether the hang
      // is in the WASM download, the traineddata fetch, or the recognize
      // loop itself — the three places this most often stalls on flaky
      // networks / strict CSPs / iOS WebKit.
      const worker = await createWorker('eng', 1, {
        logger: (msg: { status?: string; progress?: number; [k: string]: unknown }) => {
          if (!ocrDebug) return;
          const pct =
            typeof msg.progress === 'number' ? `${Math.round(msg.progress * 100)}%` : '—';
          console.log(`[ocr] tesseract.logger status="${msg.status ?? '?'}" progress=${pct}`, msg);
        },
        errorHandler: (err: unknown) => {
          // Errors still surface unconditionally — silent failure is
          // exactly the diagnostic problem the rest of this gating was
          // introduced to *not* reintroduce.
          console.error('[ocr] tesseract.errorHandler', err);
        },
      });
      mark('createWorker(eng): resolved');

      try {
        const extractedBlocks: string[] = [];
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          setOcrMessage(`Reading screenshot ${index + 1} of ${files.length}…`);
          mark(`recognize[${index + 1}/${files.length}]: begin`, {
            name: file.name,
            type: file.type,
            bytes: file.size,
          });
          const objectUrl = URL.createObjectURL(file);

          try {
            const result = await worker.recognize(objectUrl);
            const textLen = (result.data.text ?? '').length;
            mark(`recognize[${index + 1}/${files.length}]: resolved`, {
              textChars: textLen,
              confidence: result.data.confidence,
            });
            extractedBlocks.push(result.data.text ?? '');
          } catch (perImageError) {
            // Per-image errors used to blow out the whole loop and surface as
            // a single fatal message. Keep going — a single bad screenshot
            // shouldn't cost the user every other extraction — but log so we
            // can see exactly which image choked the worker.
            console.error(
              `[ocr] recognize[${index + 1}/${files.length}] threw`,
              perImageError,
            );
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        }
        mark('recognize loop: done', { blocks: extractedBlocks.length });

        const names = extractAppNamesFromOcr(extractedBlocks.join('\n'));
        mark('extractAppNamesFromOcr: done', { names: names.length });
        if (names.length === 0) {
          setOcrError(tStatus('ocr_no_confident_matches'));
          setOcrMessage('');
          return;
        }

        setNamesText(names.join('\n'));
        // Heuristic: fewer than ~3 names per image usually means the user
        // screenshotted a Home Screen with icon-only folders. Nudge them to
        // try a flat list like iPhone Storage. We don't *block* — the names
        // we did find still go into the textarea for review.
        const namesPerImage = names.length / Math.max(1, files.length);
        if (namesPerImage < 3) {
          setOcrMessage(
            `Extracted ${names.length} app name${names.length !== 1 ? 's' : ''}, but this seems light. ` +
            `If any apps are hidden inside folders they won\u2019t be picked up — try Settings → General → iPhone Storage for a complete list.`
          );
        } else {
          setOcrMessage(`Extracted ${names.length} app name${names.length !== 1 ? 's' : ''}. Review the list below before searching.`);
        }
      } finally {
        mark('worker.terminate: begin');
        await worker.terminate();
        mark('worker.terminate: done');
      }
    } catch (error) {
      mark('fatal error (outer catch)', {
        kind: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      });
      console.error('[ocr] fatal', error);
      // Expose the real error to the UI under a collapsed `<details>` so the
      // user (or us, when triaging a support report) can see the underlying
      // tesseract.js / WASM / network failure instead of just "it failed".
      const detail = (() => {
        if (error instanceof Error) return error.message || error.name || String(error);
        if (typeof error === 'string') return error;
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
        setOcrError(
          tStatus('ocr_safari_help')
        );
      } else {
        setOcrError(tStatus('ocr_browser_failed'));
      }
      setOcrMessage('');
    } finally {
      mark('runOcr: finally (clearing ocring flag)');
      setOcring(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [isIosSafari]);

  const handleTextDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingText(false);
    const file = event.dataTransfer.files?.[0];
    if (file) parseTextFile(file);
  }, [parseTextFile]);

  const handleImageDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingImages(false);
    const files = Array.from(event.dataTransfer.files ?? []).filter(file => file.type.startsWith('image/'));
    if (files.length === 0) return;
    setImageFiles(files);
    void runOcr(files);
  }, [runOcr]);

  const handleImageSelection = useCallback((files: FileList | null) => {
    const nextFiles = Array.from(files ?? []).filter(file => file.type.startsWith('image/'));
    if (nextFiles.length === 0) return;
    setImageFiles(nextFiles);
    void runOcr(nextFiles);
  }, [runOcr]);

  const deriveImportLabel = useCallback((): string => {
    if (method === 'configurator' && uploadedFileName) return `Apple Configurator · ${uploadedFileName}`;
    if (method === 'configurator') return `Apple Configurator export · ${new Date().toLocaleDateString()}`;
    if (method === 'file' && uploadedFileName) return uploadedFileName;
    if (method === 'screenshots' && imageFiles.length > 0) {
      return `${imageFiles.length} screenshot${imageFiles.length !== 1 ? 's' : ''}`;
    }
    return `Manual entry · ${new Date().toLocaleDateString()}`;
  }, [method, uploadedFileName, imageFiles.length]);

  const createImportRecord = useCallback(
    async (total: number): Promise<string | null> => {
      const startedAt = performance.now();
      recordImportEvent('onboarding.import.create.start', { total, method });
      try {
        const res = await fetch('/api/imports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: persistedSourceForMethod(method),
            sourceLabel: deriveImportLabel(),
            total,
          }),
        });
        const data = await res.json();
        if (!res.ok || typeof data?.id !== 'string') {
          recordImportEvent('onboarding.import.create.error', {
            status: res.status,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return null;
        }
        recordImportEvent('onboarding.import.create.complete', {
          durationMs: Math.round(performance.now() - startedAt),
        });
        return data.id;
      } catch (error) {
        console.error('[wizard] Failed to create import record:', error);
        recordImportEvent('onboarding.import.create.error', {
          durationMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        });
        return null;
      }
    },
    [method, deriveImportLabel],
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
      allNames?: string[],
    ): Promise<Map<string, string>> => {
      const searchedPayload = results.map(result => {
        const chosen = autoSelected.get(result.query);
        if (!chosen) {
          return {
            query: result.query,
            status: 'unmatched' as const,
          };
        }
        return {
          query: result.query,
          status: 'matched' as const,
          appId: chosen.appleId,
          appName: chosen.name,
          developer: chosen.developer,
          url: chosen.url,
          // Capture at match time so a later 'queued' row still has an icon
          // to render in Import History even if the scrape never succeeds.
          iconUrl: chosen.iconUrl,
          country,
        };
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
      const queuedPayload = (queuedRows ?? []).map(row => ({
        query: row.name,
        status: 'pending_search' as const,
        developer: row.developer ?? null,
        country,
        scrapeError: tStatus('scrape_error_rate_limited'),
        retryAfterMs: queuedRetryAfterMs ?? null,
      }));

      // Fallback: any name the user submitted that didn't end up in
      // `results` or `queuedRows` gets written as an `unmatched` placeholder.
      // The upsert in `addImportItems` keyed by (importId, query) makes this
      // safe — a later successful search rewrites the row in-place to
      // `matched` without creating duplicates.
      const alreadyRepresented = new Set<string>();
      for (const item of searchedPayload) alreadyRepresented.add(item.query);
      for (const item of queuedPayload) alreadyRepresented.add(item.query);
      const fallbackPayload = (allNames ?? [])
        .filter(name => !alreadyRepresented.has(name))
        .map(name => ({
          query: name,
          status: 'unmatched' as const,
          country,
          scrapeError: tStatus('scrape_error_no_result'),
        }));

      const itemsPayload = [...searchedPayload, ...queuedPayload, ...fallbackPayload];
      if (itemsPayload.length === 0) return new Map();

      const startedAt = performance.now();
      recordImportEvent('onboarding.items.initial_bulk.start', {
        items: itemsPayload.length,
        matched: searchedPayload.filter(item => item.status === 'matched').length,
        queued: queuedPayload.length,
        fallback: fallbackPayload.length,
      });
      try {
        const res = await fetch('/api/imports/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ importId: currentImportId, items: itemsPayload }),
        });
        if (!res.ok) {
          // Surface the failure — previously we silently returned an empty
          // map, which is why imports could complete with `itemCount = 0`.
          const errBody = await res.text().catch(() => '');
          console.error(
            `[wizard] /api/imports/items rejected (${res.status}): ${errBody.slice(0, 200)}`,
          );
          recordImportEvent('onboarding.items.initial_bulk.error', {
            status: res.status,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return new Map();
        }
        const data = await res.json();
        const idMap = new Map<string, string>();
        if (Array.isArray(data?.items)) {
          for (const item of data.items) {
            if (typeof item?.query === 'string' && typeof item?.id === 'string') {
              idMap.set(item.query, item.id);
            }
          }
        }
        recordImportEvent('onboarding.items.initial_bulk.complete', {
          items: idMap.size,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return idMap;
      } catch (error) {
        console.error('[wizard] Failed to write import items:', error);
        recordImportEvent('onboarding.items.initial_bulk.error', {
          durationMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        });
        return new Map();
      }
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
    [country],
  );

  const handleSearch = async () => {
    const names = getNames();
    if (names.length === 0) return;

    setSearching(true);
    setSearchError('');

    try {
      // ── Phase 1: bundle-ID lookup (cfgutil-only path) ──────────────
      //
      // If we have bundleId hints from cfgutil, try the iTunes
      // lookup-by-bundleId endpoint first. It returns canonical App
      // Store records keyed by bundle ID — no name-collision
      // ambiguity, no developer-hint guessing, no per-name search
      // call. A single lookup request can resolve up to ~200 apps,
      // so a typical cfgutil import burns 1-2 requests instead of N.
      //
      // Names without a bundleId hint (because cfgutil's row had an
      // empty bundleId, or the name has been edited in the textarea
      // and no longer matches any hint) flow straight to phase 2.
      // Names whose lookup returned no record (delisted, sideloaded,
      // wrong storefront) also fall through to phase 2.
      const phase1Matches = new Map<string, AppCandidate>();
      const phase1NamesWithBundle: string[] = [];
      const bundleByLowerName = new Map<string, string>();
      for (const name of names) {
        const bundleId = bundleIdHints.get(name.toLowerCase());
        if (bundleId) {
          phase1NamesWithBundle.push(name);
          bundleByLowerName.set(name.toLowerCase(), bundleId);
        }
      }

      if (phase1NamesWithBundle.length > 0) {
        try {
          const lookupRes = await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bundleIds: phase1NamesWithBundle.map(
                name => bundleByLowerName.get(name.toLowerCase()),
              ),
              country,
            }),
          });
          if (lookupRes.ok) {
            const lookupData = await lookupRes.json().catch(() => ({}));
            // Lookup returns { results: [{ bundleId, match: AppCandidate | null }] }
            // — invert into a Map<bundleId, AppCandidate> for cheap join.
            const byBundle = new Map<string, AppCandidate>();
            for (const r of (lookupData.results ?? []) as Array<{
              bundleId: string;
              match: AppCandidate | null;
            }>) {
              if (r.match) byBundle.set(r.bundleId, r.match);
            }
            for (const name of phase1NamesWithBundle) {
              const bundleId = bundleByLowerName.get(name.toLowerCase());
              if (!bundleId) continue;
              const match = byBundle.get(bundleId);
              if (match) {
                // Use the user-facing name as the result key (not the
                // bundle ID) so the existing `results.query` →
                // `selected` → import-item map keeps working with one
                // string identifier across both code paths.
                phase1Matches.set(name, { ...match, searchQuery: name });
              }
            }
          } else {
            console.warn(`[wizard] bundle-ID lookup returned HTTP ${lookupRes.status}; falling back to name search`);
          }
        } catch (err) {
          // Network or transport error — fall through to phase 2.
          // Phase 2 will try every name (including those that had
          // bundle IDs) so nothing is silently dropped.
          console.warn('[wizard] bundle-ID lookup failed, falling back to name search:', err);
        }
      }

      // ── Phase 2: name search for everything bundle-ID lookup missed ─
      //
      // Names that still need a match — either because they had no
      // bundle ID hint, or because lookup returned no record. We send
      // these through the existing rows-payload path, which fans out
      // through iTunes Search and respects the developerHints
      // re-ranking.
      const phase2Names = names.filter(name => !phase1Matches.has(name));
      const rowsPayload = phase2Names.map(name => {
        const developer = developerHints.get(name.toLowerCase());
        return developer ? { name, developer } : { name };
      });

      // Avoid issuing an empty search request when phase 1 already
      // matched everything — common path for clean cfgutil imports.
      // We synthesise an empty results envelope so the rest of the
      // function can flow through unchanged.
      const res = phase2Names.length === 0
        ? new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: rowsPayload, country }),
          });
      // A 500 from /api/search used to silently fall through to an empty
      // `results` + empty `queued`, and we'd create an import row with 0
      // items — hence the "total=210 but 0 everywhere else" dev-log symptom.
      // Surface it, and still continue into writeImportItems so the batch
      // gets persisted as unmatched placeholders the user can retry.
      if (!res.ok) {
        console.error(`[wizard] /api/search failed with ${res.status}`);
        setSearchError(
          tStatus('search_endpoint_error_prefix') +
          '"unmatched" in Import History — open Settings → Import history to retry.',
        );
      }
      const data = await res.json().catch(() => ({}));
      const phase2Results: SearchResult[] = data.results ?? [];
      const rateLimited = data.rateLimited as
        | { retryAfterMs: number; queued: Array<{ name: string; developer?: string }> }
        | undefined;

      // Merge phase-1 (bundle-ID lookup) matches with phase-2 (name
      // search) results into a single SearchResult[] keyed by query
      // name, preserving the order of `names` so the UI list reads
      // top-down the way the user typed/imported them. Each phase-1
      // match becomes a SearchResult with exactly one candidate (the
      // canonical lookup hit); phase-2 results pass through unchanged
      // (each may have 0..N candidates).
      const phase2ByQuery = new Map<string, SearchResult>();
      for (const r of phase2Results) phase2ByQuery.set(r.query, r);
      const results: SearchResult[] = names.map(name => {
        const phase1 = phase1Matches.get(name);
        if (phase1) {
          return { query: name, candidates: [phase1] };
        }
        return phase2ByQuery.get(name) ?? { query: name, candidates: [] };
      });

      const autoSelected = new Map<string, AppCandidate>();
      for (const result of results) {
        if (result.candidates.length > 0) autoSelected.set(result.query, result.candidates[0]);
      }

      // Tell the console how many names the server failed to match so
      // power users can see the list in devtools. The split between
      // phase-1 hits and phase-2 misses is useful when debugging a
      // cfgutil import where lookup didn't return as many matches as
      // expected.
      const unmatched = results.filter(r => r.candidates.length === 0).map(r => r.query);
      if (unmatched.length > 0) {
        console.warn(
          `[search] ${unmatched.length} / ${results.length} names returned no App Store matches:`,
          unmatched,
        );
      }
      if (phase1Matches.size > 0) {
        console.info(
          `[search] bundle-ID lookup matched ${phase1Matches.size} / ${phase1NamesWithBundle.length} apps from cfgutil; ` +
          `${phase2Names.length} names fell through to name search.`,
        );
      }

      // Persist this onboarding attempt as an import so the user can review
      // matched/unmatched/imported counts from Settings later. We record the
      // *total* (including queued tail) so counts reflect user intent, and
      // we write every name as an import_item up front — names Apple
      // couldn't process yet go in as `status='queued'` with the retry
      // deadline, so the history view has a full record of the batch from
      // the moment it starts instead of waiting for the replay to land.
      const newImportId = await createImportRecord(names.length);
      if (newImportId) {
        setImportId(newImportId);
        const idMap = await writeImportItems(
          newImportId,
          results,
          autoSelected,
          rateLimited?.queued,
          rateLimited?.retryAfterMs,
          // Hand the full submitted list through so names that neither
          // landed in `results` nor in the queued tail still get written as
          // `unmatched` placeholders. Fixes the "total=N but itemCount=0"
          // symptom when /api/search dies before returning anything usable.
          names,
        );
        setItemIdByQuery(idMap);
      }

      setSearchResults(results);
      setSelected(autoSelected);

      // Rate-limit path: hand the queued tail to the layout-level provider so
      // the retry loop keeps running if the user navigates away, and still
      // drop the user on Step 3 so they can confirm what we *did* match
      // while we wait out Apple's cooldown. The provider also registers a
      // Task Center entry with a live countdown for the notification area.
      if (rateLimited && rateLimited.queued.length > 0) {
        queuedSearch.enqueue({
          queued: rateLimited.queued,
          country,
          importId: newImportId ?? null,
          retryAfterMs: rateLimited.retryAfterMs,
        });
        console.warn(
          `[search] iTunes rate-limited after ${results.length} of ${names.length} names; ` +
          `${rateLimited.queued.length} queued for replay in ${Math.round(rateLimited.retryAfterMs / 1000)}s.`,
        );
      }

      setStep(3);
    } catch (error) {
      console.error('[wizard] /api/search failed:', error);
      setSearchError(tStatus('search_failed'));
    } finally {
      setSearching(false);
    }
  };

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
      if (fresh.length === 0) return;

      const freshSelected = new Map<string, AppCandidate>();
      for (const r of fresh) {
        if (r.candidates.length > 0) freshSelected.set(r.query, r.candidates[0]);
      }

      setSearchResults(prev => [...prev, ...fresh]);
      setSelected(prev => {
        const next = new Map(prev);
        freshSelected.forEach((value, key) => next.set(key, value));
        return next;
      });
    };
    const unsubscribe = queuedSearch.subscribe(onResults);
    return unsubscribe;
  }, [queuedSearch]);

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
    force = false,
  ) => {
    const trimmed = nextQuery.trim();
    const trimmedDev = nextDeveloper?.trim();
    const queryChanged = !!trimmed && trimmed !== originalQuery;
    // Whether the seller hint the user typed differs from what we already had
    // on file. We compare against the *original* query's hint — an edit that
    // also changes the name can still be driven by the same seller signal.
    const existingHint = developerHints.get(originalQuery.toLowerCase()) ?? '';
    const developerChanged = nextDeveloper !== undefined && trimmedDev !== existingHint;
    if (!trimmed || (!force && !queryChanged && !developerChanged)) {
      setEditingBlock(null);
      return;
    }

    setEditingBlock(originalQuery);
    try {
      // Resolution order for the seller hint the server uses to re-rank:
      //   1. An explicit value the user typed in the edit row.
      //   2. A CSV-imported hint keyed by the original query.
      //   3. A CSV-imported hint keyed by the edited name.
      const resolvedHint = nextDeveloper !== undefined
        ? trimmedDev
        : (developerHints.get(originalQuery.toLowerCase())
            ?? developerHints.get(trimmed.toLowerCase()));
      const payload = resolvedHint
        ? { rows: [{ name: trimmed, developer: resolvedHint }], country }
        : { rows: [{ name: trimmed }], country };

      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      const fresh: SearchResult | undefined = (data.results ?? [])[0];
      if (!fresh) return;

      // Replace this block in-place with the fresh results, keyed by the new query.
      setSearchResults(prev =>
        prev.map(item =>
          item.query === originalQuery ? { query: trimmed, candidates: fresh.candidates } : item,
        ),
      );

      setSelected(prev => {
        const next = new Map(prev);
        next.delete(originalQuery);
        if (fresh.candidates.length > 0) next.set(trimmed, fresh.candidates[0]);
        return next;
      });

      // Also update the server-side item id map so the completion step knows
      // which item to patch by the new query name.
      setItemIdByQuery(prev => {
        const existingId = prev.get(originalQuery);
        if (!existingId) return prev;
        const next = new Map(prev);
        next.delete(originalQuery);
        next.set(trimmed, existingId);
        return next;
      });

      // Persist the user's explicit seller edit so follow-up re-searches and
      // the final /api/search "matched" ranking both see the same hint. We
      // only touch the map when the caller explicitly passed `nextDeveloper`
      // (undefined = "don't overwrite the CSV value").
      if (nextDeveloper !== undefined) {
        setDeveloperHints(prev => {
          const next = new Map(prev);
          next.delete(originalQuery.toLowerCase());
          if (trimmedDev) next.set(trimmed.toLowerCase(), trimmedDev);
          return next;
        });
      } else if (queryChanged) {
        // Name changed but seller didn't — carry the existing hint across to
        // the new key so future edits still benefit from it.
        setDeveloperHints(prev => {
          const carry = prev.get(originalQuery.toLowerCase());
          if (!carry) return prev;
          const next = new Map(prev);
          next.delete(originalQuery.toLowerCase());
          next.set(trimmed.toLowerCase(), carry);
          return next;
        });
      }

      // Patch the server-side import_item with the edited query + selection.
      if (importId) {
        const itemId = itemIdByQuery.get(originalQuery);
        if (itemId) {
          const top = fresh.candidates[0];
          await fetch('/api/imports/items/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              itemId,
              editedQuery: trimmed,
              status: top ? 'matched' : 'unmatched',
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
      console.error('[wizard] handleBlockResearch failed:', error);
    } finally {
      setEditingBlock(null);
    }
  };

  const handleBlockSkip = async (query: string) => {
    // Drop the selection and mark skipped on the server.
    setSelected(prev => {
      const next = new Map(prev);
      next.delete(query);
      return next;
    });

    if (!importId) return;
    const itemId = itemIdByQuery.get(query);
    if (!itemId) return;

    await fetch('/api/imports/items/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, status: 'skipped' }),
    });
  };

  const handleConfirm = async (
    // When Step 3's "Hide already-tracked apps" toggle is on, the caller
    // passes a filtered copy of `selected` that excludes already-tracked
    // candidates. Falls back to the full `selected` map for any caller
    // (or future caller) that doesn't need the filter. The filtered map
    // only affects which rows are *scraped* — already-tracked blocks
    // still get their import_items status flipped to `skipped` below so
    // Import History remains a complete record of what the user saw.
    overrideSelected?: Map<string, AppCandidate>,
  ) => {
    const workingSelected = overrideSelected ?? selected;
    const entries = [...workingSelected.entries()];
    if (entries.length === 0) return;

    // Sync every visible block's status to the server before we start scraping,
    // so the import history reflects the user's final intent. A block that's
    // in `selected` but NOT in `workingSelected` was filtered out by the
    // hide-tracked toggle — those rows go to `skipped` so the user can see
    // in Import History that they deliberately opted not to re-import the
    // tracked app this time round.
    if (importId) {
      const statusPayload = searchResults.map(result => {
        const chosen = workingSelected.get(result.query);
        const wasFiltered =
          selected.has(result.query) && !workingSelected.has(result.query);
        return chosen
          ? {
              query: result.query,
              status: 'matched',
              appId: chosen.appleId,
              appName: chosen.name,
              developer: chosen.developer,
              url: chosen.url,
              iconUrl: chosen.iconUrl,
              country,
              scrapeError: null,
            }
          : wasFiltered
            ? { query: result.query, status: 'skipped', country }
            : {
                query: result.query,
                status: result.candidates.length === 0 ? 'unmatched' : 'skipped',
                country,
                scrapeError: result.candidates.length === 0
                  ? tStatus('scrape_error_no_result')
                  : null,
              };
      });
      const startedAt = performance.now();
      recordImportEvent('onboarding.confirm.bulk_status.start', {
        items: statusPayload.length,
        selected: entries.length,
      });
      try {
        const res = await fetch('/api/imports/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ importId, items: statusPayload }),
        });
        if (!res.ok) {
          recordImportEvent('onboarding.confirm.bulk_status.error', {
            status: res.status,
            durationMs: Math.round(performance.now() - startedAt),
          });
          setSearchError(tStatus('background_import_start_failed'));
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data?.items)) {
          setItemIdByQuery(prev => {
            const next = new Map(prev);
            for (const item of data.items) {
              if (typeof item?.query === 'string' && typeof item?.id === 'string') {
                next.set(item.query, item.id);
              }
            }
            return next;
          });
        }
        recordImportEvent('onboarding.confirm.bulk_status.complete', {
          items: statusPayload.length,
          durationMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        console.error('[wizard] Failed to persist final import selections:', error);
        recordImportEvent('onboarding.confirm.bulk_status.error', {
          durationMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        });
        setSearchError(tStatus('background_import_start_failed'));
        return;
      }
    }

    const list: ScrapeStatus[] = entries.map(([query, candidate]) => ({
      query,
      url: candidate.url,
      name: candidate.name,
      status: 'pending',
    }));

    setScrapeList(list);
    setDone(false);
    setStep(4);
    void startScraping(entries, list);
  };

  const saveAiSettings = async (): Promise<boolean> => {
    setAiError('');

    if (aiProvider !== 'disabled') {
      if (!aiBaseUrl.trim() || !aiModel.trim()) {
        setAiError(tStatus('ai_base_url_model_required'));
        return false;
      }

      if (providerRequiresApiKey(aiProvider) && !aiApiKey.trim()) {
        setAiError(tStatus('ai_api_key_required'));
        return false;
      }
    }

    setSavingAi(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          ai_summarize_on_import: summarizeOnImport && onboardAiSummarizeOnImportOn,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAiError(data.error ?? tStatus('ai_save_failed'));
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
      console.error('[wizard] Failed to save AI settings:', error);
      setAiError(tStatus('ai_save_failed'));
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
    if (!saved || aiProvider === 'disabled') return;

    const successes = scrapeList.filter(item => item.status === 'success');
    if (successes.length === 0) return;

    // Pair each successful scrape with the app id (pulled from import items map
    // indirectly by matching URL, or — more reliably — by re-reading /api/apps).
    const idLookup: Record<string, { id: string; name: string }> = {};
    try {
      const listRes = await fetch('/api/apps');
      const apps = (await listRes.json()) as Array<{ id: string; name: string; url: string }>;
      for (const app of apps) idLookup[app.url] = { id: app.id, name: app.name };
    } catch (error) {
      /* fall back to scrapeList names without ids */
      console.warn('[wizard] Failed to load /api/apps for policy id lookup:', error);
    }

    const queue: PolicyRegenerateStatus[] = successes.map(item => {
      const match = idLookup[item.url];
      return {
        appId: match?.id ?? item.url,
        name: match?.name ?? item.name,
        scrape: { status: 'pending' },
        summarise: { status: 'pending' },
      };
    });

    stopRequestedRef.current = 'none';
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
      title: `Regenerating privacy policies`,
      subtitle: `${queue.length} app${queue.length !== 1 ? 's' : ''} · fetch + summarise`,
      kind: 'policy',
      href: '/onboard',
      progress: { current: 0, total: totalSteps, label: `0 / ${totalSteps} steps` },
      // `now` = immediate abort (matches the in-wizard "Stop now" button).
      onCancel: () => requestStop('now'),
    });
    policyTaskHandleRef.current = policyTask;

    const recomputeProgress = () => {
      let done = 0;
      for (const row of queue) {
        if (row.scrape.status === 'done' || row.scrape.status === 'error' || row.scrape.status === 'skipped') done += 1;
        if (row.summarise.status === 'done' || row.summarise.status === 'error' || row.summarise.status === 'skipped') done += 1;
      }
      policyTask.setProgress(done, totalSteps, `${done} / ${totalSteps} steps`);
    };

    // ---- Phase 1: fetch ----
    setActivePhase('fetch');
    let fetchTotalMs = 0;
    let fetchCompleted = 0;
    for (let index = 0; index < queue.length; index += 1) {
      if (readStop() === 'now') {
        for (let j = index; j < queue.length; j += 1) {
          queue[j] = {
            ...queue[j],
            scrape: { status: 'skipped', detail: tStatus('policy_cancelled') },
            summarise: { status: 'skipped', detail: tStatus('policy_cancelled') },
          };
        }
        setPolicyProgress([...queue]);
      recomputeProgress();
        break;
      }

      const startedAt = Date.now();
      queue[index] = {
        ...queue[index],
        scrape: { status: 'working', startedAt },
      };
      setPolicyProgress([...queue]);
      recomputeProgress();

      if (!queue[index].appId || queue[index].appId.startsWith('http')) {
        queue[index] = {
          ...queue[index],
          scrape: { status: 'error', detail: tStatus('policy_could_not_resolve'), startedAt, finishedAt: Date.now() },
        };
        setPolicyProgress([...queue]);
      recomputeProgress();
        if (readStop() === 'after-current') break;
        continue;
      }

      const abort = new AbortController();
      activeAbortRef.current = abort;

      try {
        const res = await fetch('/api/policy/regenerate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: queue[index].appId, phase: 'fetch' }),
          signal: abort.signal,
        });
        const data = await res.json();
        const finishedAt = Date.now();

        if (!res.ok) {
          queue[index] = {
            ...queue[index],
            scrape: {
              status: 'error',
              detail: typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`,
              startedAt,
              finishedAt,
            },
          };
        } else {
          const analysisStatus: string | undefined = data?.analysis?.status;
          const scrapeStatus: PolicyPhaseStatus =
            analysisStatus === 'ready' || analysisStatus === 'source_ready'
              ? 'done'
              : 'error';
          queue[index] = {
            ...queue[index],
            scrape: {
              status: scrapeStatus,
              detail: describeFetchStatus(tStatus, analysisStatus, data?.analysis?.error),
              startedAt,
              finishedAt,
            },
          };
          // If the cached analysis was already 'ready' we don't need to re-summarise.
          if (analysisStatus === 'ready') {
            queue[index] = {
              ...queue[index],
              summarise: {
                status: 'done',
                detail: tStatus('policy_already_up_to_date'),
                startedAt: finishedAt,
                finishedAt,
              },
            };
          }
        }
      } catch (error) {
        const finishedAt = Date.now();
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (!aborted) {
          console.error(
            `[wizard] Policy fetch failed for ${queue[index]?.name ?? queue[index]?.appId}:`,
            error,
          );
        }
        queue[index] = {
          ...queue[index],
          scrape: {
            status: aborted ? 'skipped' : 'error',
            detail: aborted ? tStatus('policy_cancelled') : error instanceof Error ? error.message : String(error),
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
      if (queue[index].scrape.status === 'done' || queue[index].scrape.status === 'error') {
        fetchTotalMs += finished - startedAt;
        fetchCompleted += 1;
        setPhaseAvgMs(prev => ({ ...prev, fetch: fetchTotalMs / fetchCompleted }));
      }

      if (readStop() === 'after-current') break;
    }

    // ---- Phase 2: summarise ----
    if (readStop() === 'none') {
      setActivePhase('summarise');
      let sumTotalMs = 0;
      let sumCompleted = 0;

      for (let index = 0; index < queue.length; index += 1) {
        if (readStop() === 'now') {
          for (let j = index; j < queue.length; j += 1) {
            if (queue[j].summarise.status === 'pending') {
              queue[j] = { ...queue[j], summarise: { status: 'skipped', detail: tStatus('policy_cancelled') } };
            }
          }
          setPolicyProgress([...queue]);
      recomputeProgress();
          break;
        }

        const entry = queue[index];

        // Only summarise apps that produced a usable scrape but haven't already
        // returned a cached 'ready' analysis (that case was short-circuited in phase 1).
        if (entry.scrape.status !== 'done' || entry.summarise.status === 'done') {
          if (entry.summarise.status === 'pending') {
            queue[index] = {
              ...entry,
              summarise: { status: 'skipped', detail: tStatus('policy_no_text') },
            };
            setPolicyProgress([...queue]);
      recomputeProgress();
          }
          continue;
        }

        const startedAt = Date.now();
        queue[index] = {
          ...entry,
          summarise: { status: 'working', startedAt },
        };
        setPolicyProgress([...queue]);
      recomputeProgress();

        const abort = new AbortController();
        activeAbortRef.current = abort;

        try {
          const res = await fetch('/api/policy/regenerate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId: entry.appId, phase: 'summarise' }),
            signal: abort.signal,
          });
          const data = await res.json();
          const finishedAt = Date.now();

          if (!res.ok) {
            queue[index] = {
              ...queue[index],
              summarise: {
                status: 'error',
                detail: typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`,
                startedAt,
                finishedAt,
              },
            };
          } else {
            const analysisStatus: string | undefined = data?.analysis?.status;
            queue[index] = {
              ...queue[index],
              summarise: {
                status: analysisStatus === 'ready' ? 'done' : 'error',
                detail: describeSummariseStatus(tStatus, analysisStatus, data?.analysis?.error),
                startedAt,
                finishedAt,
              },
            };
          }
        } catch (error) {
          const finishedAt = Date.now();
          const aborted = error instanceof DOMException && error.name === 'AbortError';
          if (!aborted) {
            console.error(
              `[wizard] Policy summarise failed for ${queue[index]?.name ?? queue[index]?.appId}:`,
              error,
            );
          }
          queue[index] = {
            ...queue[index],
            summarise: {
              status: aborted ? 'skipped' : 'error',
              detail: aborted ? tStatus('policy_cancelled') : error instanceof Error ? error.message : String(error),
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
        if (queue[index].summarise.status === 'done' || queue[index].summarise.status === 'error') {
          sumTotalMs += finished - startedAt;
          sumCompleted += 1;
          setPhaseAvgMs(prev => ({ ...prev, summarise: sumTotalMs / sumCompleted }));
        }

        if (readStop() === 'after-current') break;
      }
    }

    // Any summarise entries still pending after cancellation should flip to skipped.
    for (let j = 0; j < queue.length; j += 1) {
      if (queue[j].summarise.status === 'pending') {
        queue[j] = {
          ...queue[j],
          summarise: {
            status: 'skipped',
            detail: queue[j].scrape.status === 'done' ? tStatus('policy_cancelled') : tStatus('policy_no_text'),
          },
        };
      }
    }
    setPolicyProgress([...queue]);
    recomputeProgress();
    setActivePhase(null);
    setPolicyRunDone(true);

    // Roll up outcome for the Task Center entry.
    const okCount = queue.filter(r => r.summarise.status === 'done').length;
    const errCount = queue.filter(r => r.scrape.status === 'error' || r.summarise.status === 'error').length;
    const skippedCount = queue.filter(r => r.summarise.status === 'skipped').length;
    const wasCancelled = stopRequestedRef.current !== 'none';
    if (wasCancelled) {
      policyTask.complete('cancelled', `${okCount} finished · ${skippedCount} skipped · ${errCount} failed`);
    } else if (errCount > 0 && okCount === 0) {
      policyTask.complete('error', `${errCount} app${errCount !== 1 ? 's' : ''} failed`);
    } else {
      policyTask.complete('done', `${okCount} of ${queue.length} app${queue.length !== 1 ? 's' : ''} summarised`);
    }
    policyTaskHandleRef.current = null;
    stopRequestedRef.current = 'none';
  };

  const requestStop = (mode: Exclude<PolicyStopMode, 'none'>) => {
    stopRequestedRef.current = mode;
    if (mode === 'now' && activeAbortRef.current) {
      activeAbortRef.current.abort();
    }
    setCancelModalOpen(false);
  };

  const refreshBackgroundImportProgress = useCallback(async () => {
    if (!importId) return;

    try {
      const res = await fetch(`/api/imports?id=${encodeURIComponent(importId)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: ImportItemSnapshot[] };
      const items = Array.isArray(data?.items) ? data.items : [];
      const byId = new Map(items.map(item => [item.id, item]));
      const currentScrapeList = scrapeListRef.current;
      const currentItemIds = itemIdByQueryRef.current;
      const activeItemIds = currentScrapeList
        .map(row => (row.query ? currentItemIds.get(row.query) : undefined))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const allTerminal =
        currentScrapeList.length > 0 &&
        activeItemIds.length === currentScrapeList.length &&
        activeItemIds.every(id => {
          const status = byId.get(id)?.status;
          return status === 'imported' || status === 'error' || status === 'removed' ||
            status === 'skipped' || status === 'unmatched';
        });

      setScrapeList(prev => {
        if (prev.length === 0) return prev;

        let changed = false;
        const next = prev.map(row => {
          const itemId = row.query ? currentItemIds.get(row.query) : undefined;
          const item = itemId ? byId.get(itemId) : undefined;
          if (!item) return row;

          const retryAfterMs =
            typeof item.nextAttemptAt === 'number' && item.nextAttemptAt > Date.now()
              ? item.nextAttemptAt - Date.now()
              : undefined;

          if (item.status === 'imported') {
            const nextRow = {
              ...row,
              name: item.appName ?? row.name,
              url: item.url ?? row.url,
              status: 'success' as const,
              error: undefined,
              retryAfterMs: undefined,
            };
            if (nextRow.status !== row.status || nextRow.error !== row.error ||
                nextRow.retryAfterMs !== row.retryAfterMs || nextRow.name !== row.name ||
                nextRow.url !== row.url) changed = true;
            return nextRow;
          }

          if (item.status === 'error' || item.status === 'removed') {
            const nextRow = {
              ...row,
              name: item.appName ?? row.name,
              url: item.url ?? row.url,
              status: 'error' as const,
              error: item.scrapeError ?? tStatus('scrape_failed_fallback'),
              retryAfterMs: undefined,
            };
            if (nextRow.status !== row.status || nextRow.error !== row.error ||
                nextRow.retryAfterMs !== row.retryAfterMs || nextRow.name !== row.name ||
                nextRow.url !== row.url) changed = true;
            return nextRow;
          }

          if (item.status === 'skipped' || item.status === 'unmatched') {
            const nextRow = {
              ...row,
              status: 'error' as const,
              error: item.scrapeError ?? tStatus('scrape_failed_fallback'),
              retryAfterMs: undefined,
            };
            if (nextRow.status !== row.status || nextRow.error !== row.error ||
                nextRow.retryAfterMs !== row.retryAfterMs) changed = true;
            return nextRow;
          }

          const nextRow = {
            ...row,
            name: item.appName ?? row.name,
            url: item.url ?? row.url,
            status: 'queued' as const,
            error: item.scrapeError ?? tStep4('row_queued_default'),
            retryAfterMs,
          };
          if (nextRow.status !== row.status || nextRow.error !== row.error ||
              nextRow.retryAfterMs !== row.retryAfterMs || nextRow.name !== row.name ||
              nextRow.url !== row.url) changed = true;
          return nextRow;
        });
        scrapeListRef.current = changed ? next : prev;
        return changed ? next : prev;
      });

      if (allTerminal) {
        setDone(true);
      }
    } catch (error) {
      console.warn('[wizard] Failed to refresh background import progress:', error);
    }
  }, [importId, tStatus, tStep4]);

  useEffect(() => {
    if (step !== 4 || !importId || scrapeList.length === 0 || done) return;
    void refreshBackgroundImportProgress();
    const id = setInterval(() => {
      void refreshBackgroundImportProgress();
    }, 3_000);
    return () => clearInterval(id);
  }, [done, importId, refreshBackgroundImportProgress, scrapeList.length, step]);

  const startScraping = async (
    entries: [string, AppCandidate][],
    items: ScrapeStatus[],
  ) => {
    // Dev-only short-circuit. When the wizard was opened from the
    // DevMenu's "Onboarding preview" button, we're walking through
    // the flow for visual review only — the final import batch skips
    // entirely. Each row gets stamped 'success' synthetically so the UI
    // animates exactly as it would in production, but no /api/apps writes
    // happen and the activity log stays clean.
    if (isPreviewMode) {
      const updated = items.map((it) => ({ ...it, status: 'success' as const }));
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
      status: 'queued' as const,
      error: tStep4('row_queued_default'),
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
        status: 'error' as const,
        error: tStatus('background_import_unavailable'),
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
        status: 'queued' as const,
        appId: candidate.appleId,
        appName: candidate.name,
        developer: candidate.developer,
        url: candidate.url,
        iconUrl: candidate.iconUrl,
        country,
        scrapeError: null,
      }));
      queueStartedAt = performance.now();
      recordImportEvent('onboarding.queue.bulk.start', { items: queuePayload.length });
      if (queuePayload.length > 0) {
        const res = await fetch('/api/imports/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ importId, items: queuePayload }),
        });
        if (!res.ok) {
          throw new Error(`Queue update failed with HTTP ${res.status}`);
        }
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data?.items)) {
          setItemIdByQuery(prev => {
            const next = new Map(prev);
            for (const item of data.items) {
              if (typeof item?.query === 'string' && typeof item?.id === 'string') {
                next.set(item.query, item.id);
              }
            }
            return next;
          });
        }
      }
      recordImportEvent('onboarding.queue.bulk.complete', {
        items: queuePayload.length,
        durationMs: Math.round(performance.now() - queueStartedAt),
      });

      // Same path as Settings → Import History → Retry: refresh the shared
      // queue snapshot so Task Center sees the full backlog, then kick an
      // immediate server-side drain instead of waiting for the next ticker.
      const kickStartedAt = performance.now();
      recordImportEvent('onboarding.queue.kick.start', { items: queuePayload.length });
      await importQueue.refresh();
      // retryNow() now throws on HTTP failure (so a foreground drain
      // loop can react). Here we just want a fire-and-forget kick —
      // the import row is already saved, and a missed first tick is
      // recoverable via the next 30-min instrumentation tick or a
      // manual retry from Settings → Import History.
      try { await importQueue.retryNow(); } catch (err) {
        console.warn('[wizard] queue kick failed (will recover on next tick):', err);
        recordImportEvent('onboarding.queue.kick.error', {
          durationMs: Math.round(performance.now() - kickStartedAt),
          error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
        });
      }
      recordImportEvent('onboarding.queue.kick.complete', {
        durationMs: Math.round(performance.now() - kickStartedAt),
      });
      await refreshBackgroundImportProgress();
    } catch (error) {
      console.error('[wizard] Failed to queue import batch:', error);
      recordImportEvent('onboarding.queue.bulk.error', {
        items: entries.length,
        durationMs: queueStartedAt !== null
          ? Math.round(performance.now() - queueStartedAt)
          : undefined,
        error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
      });
      setScrapeList(prev => {
        const failed = prev.map(item =>
          item.status === 'success'
            ? item
            : {
                ...item,
                status: 'error' as const,
                error: tStatus('background_import_start_failed'),
              },
        );
        scrapeListRef.current = failed;
        return failed;
      });
      setDone(true);
    }
  };

  const stepLabels: [Step, string][] = [
    [1, tStepLabels('1')],
    [2, tStepLabels('2')],
    [3, tStepLabels('3')],
    [4, tStepLabels('4')],
    [5, tStepLabels('5')],
  ];

  const currentNames = getNames();
  const selectedCount = currentNames.length;
  const providerOptions = getAiModelOptions(aiProvider);
  const selectedModelPreset = providerOptions.some(option => option.value === aiModel) ? aiModel : '__custom__';
  const selectedCfgutilDevice = cfgutilDevices.find(device => device.ecid === selectedCfgutilEcid) ?? null;

  const onProviderChange = (nextProvider: AIProvider) => {
    setAiProvider(nextProvider);
    setAiError('');

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
            <span className="wizard-preview-banner-icon" aria-hidden="true">👁</span>
            <div>
              <strong>Preview mode</strong>
              <span className="wizard-preview-banner-sub">
                {' '}— you&rsquo;re viewing onboarding as a new user. The
                final &ldquo;import &amp; sync&rdquo; step is suppressed
                so nothing gets saved.
              </span>
            </div>
          </div>
        )}
        {/* Step indicator is informational only (not a navigation control),
            so expose it as an ordered list with aria-current="step" on the
            active one. Screen readers announce position in the sequence. */}
        <ol className="wizard-steps" aria-label={tStepIndicator('aria', { step, total: stepLabels.length })}>
          {stepLabels.map(([value, label], index) => {
            const isActive = step === value;
            const isDone = step > value;
            const statusWord = isDone ? tStepIndicator('completed') : isActive ? tStepIndicator('current') : tStepIndicator('upcoming');
            return (
              <li
                key={value}
                className="wizard-step-node"
                style={{ flex: index < stepLabels.length - 1 ? 1 : 'none' }}
                aria-current={isActive ? 'step' : undefined}
              >
                <span className="sr-only">{statusWord}: </span>
                <div
                  className={`wizard-step-circle ${isDone ? 'done' : isActive ? 'active' : 'inactive'}`}
                  aria-hidden="true"
                >
                  {isDone ? '✓' : value}
                </div>
                <span className={`wizard-step-label ${isActive ? 'active' : isDone ? 'done' : ''}`}>
                  {label}
                </span>
                {index < stepLabels.length - 1 && (
                  <div className={`wizard-step-line ${isDone ? 'done' : ''}`} aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ol>

        {step === 5 && !onboardStepAiSummariesOn && (() => {
          // Wave I: when `flag.onboarding.step.ai_summaries` resolves
          // off, the wizard skips the optional summary step entirely
          // and routes straight to the dashboard. The fire-once router
          // push happens inside an effect-style IIFE because `step ===
          // 5` only renders briefly before the navigation completes.
          if (typeof window !== 'undefined') {
            queueMicrotask(() => router.push('/dashboard'));
          }
          return (
            <div className="wizard-note wizard-note-info" style={{ marginTop: 16 }}>
              {tOnboard('skipping_ai')}
            </div>
          );
        })()}

        {step === 5 && onboardStepAiSummariesOn && policyProgress.length === 0 && (
          <>
            <div className="wizard-subtle-eyebrow">{tAiStep('eyebrow')}</div>
            <h1 className="wizard-title">{tWiz('ai_summarise')}</h1>
            {/*
              Two-paragraph lede explaining *why* the policy step exists at
              all. Privacy labels = what the developer tells Apple; privacy
              policies = the closer-to-complete picture (subprocessors,
              retention, sale-of-data, etc.). We surface the watch-for-
              changes promise here so users understand the value even if
              they say "no thanks" to the AI summarisation offer below.
            */}
            <p className="wizard-subtitle">
              {tAiStep('lede')}
            </p>
            <p className="wizard-subtitle">
              {tAiStep('lede_paragraph_2')}
            </p>

            <h2 className="wizard-section-heading" style={{ marginTop: 24 }}>
              {tAiStep('ai_offer_heading')}
            </h2>
            <p className="wizard-subtitle">
              {tAiStep('subtitle')}
            </p>

            <div className="method-grid" role="radiogroup" aria-label={tAiStep('provider_aria')}>
              {ONBOARD_AI_OPTIONS.map(option => {
                const selected = aiProvider === option.value;
                return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`method-card ${selected ? 'active' : ''}`}
                  onClick={() => onProviderChange(option.value)}
                >
                  <div className="method-card-top">
                    <span className="method-card-badge">{tAiStep('provider_badge')}</span>
                    <span className="method-card-radio" aria-hidden="true">{selected ? '✓' : ''}</span>
                  </div>
                  <div className="method-card-title">{option.labelKey ? tAiOptions(option.labelKey) : option.label}</div>
                  <p className="method-card-copy">{tAiOptions(option.descKey)}</p>
                  <div className="method-card-hint">
                    {option.value === 'openai'
                      ? tAiStep('hint_openai')
                      : option.value === 'anthropic'
                        ? tAiStep('hint_anthropic')
                        : tAiStep('hint_custom')}
                  </div>
                </button>
                );
              })}
            </div>

            {aiProvider !== 'disabled' && (
              <>
                <div className="settings-field-grid">
                  <label className="settings-field">
                    <span className="settings-field-label">{tAiStep('base_url_label')}</span>
                    <input
                      className="settings-input"
                      type="text"
                      value={aiBaseUrl}
                      onChange={event => setAiBaseUrl(event.target.value)}
                      placeholder={resolveDefaultBaseUrl(aiProvider)}
                      spellCheck={false}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">{tAiStep('popular_models_label')}</span>
                    <select
                      className="settings-input settings-select"
                      value={selectedModelPreset}
                      onChange={event => {
                        if (event.target.value !== '__custom__') setAiModel(event.target.value);
                      }}
                    >
                      {providerOptions.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      <option value="__custom__">{tAiStep('custom_model_option')}</option>
                    </select>
                  </label>
                </div>

                <div className="settings-field-grid" style={{ marginTop: 16 }}>
                  <label className="settings-field">
                    <span className="settings-field-label">{tAiStep('model_id_label')}</span>
                    <input
                      className="settings-input"
                      type="text"
                      value={aiModel}
                      onChange={event => setAiModel(event.target.value)}
                      placeholder={resolveDefaultModel(aiProvider)}
                      spellCheck={false}
                    />
                  </label>

                  {providerSupportsApiKey(aiProvider) && (
                    <label className="settings-field">
                      <span className="settings-field-label">{tAiStep('api_key_label')}</span>
                      <input
                        className="settings-input"
                        type="password"
                        value={aiApiKey}
                        onChange={event => setAiApiKey(event.target.value)}
                        placeholder={aiProvider === 'anthropic' ? 'sk-ant-...' : aiProvider === 'openai' ? 'sk-...' : tAiStep('api_key_placeholder_custom')}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <span className="settings-field-help">
                        {providerRequiresApiKey(aiProvider)
                          ? tAiStep('api_key_help_required')
                          : tAiStep('api_key_help_optional')}
                      </span>
                    </label>
                  )}
                </div>

                <div className="ai-test-row" style={{ marginTop: 16 }}>
                  <button
                    type="button"
                    className="btn btn-secondary ai-test-button"
                    onClick={() => void testAiConnection()}
                    disabled={
                      aiTestStatus === 'testing' ||
                      !aiBaseUrl.trim() ||
                      (providerRequiresApiKey(aiProvider) && !aiApiKey.trim())
                    }
                  >
                    <span className={`ai-test-dot ai-test-dot-${aiTestStatus}`}>
                      {aiTestStatus === 'testing' ? <span className="spinner-sm" /> : null}
                    </span>
                    {aiTestStatus === 'testing'
                      ? tAiStep('test_busy')
                      : aiTestStatus === 'ok' || aiTestStatus === 'fail'
                        ? tAiStep('test_retry')
                        : tAiStep('test_idle')}
                  </button>
                  {(aiTestMessage || aiTestLatency !== null) && (
                    <div className={`ai-test-message ai-test-message-${aiTestStatus}`}>
                      {aiTestStatus === 'ok' ? '✓ ' : aiTestStatus === 'fail' ? '⚠ ' : ''}
                      {aiTestMessage || (aiTestStatus === 'ok' ? tAiStep('test_reachable') : '')}
                      {aiTestLatency !== null && (
                        <span className="ai-test-latency">{tAiStep('test_latency', { ms: aiTestLatency })}</span>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {storedAi && !aiError && settingsLoaded && (
              <div className="wizard-note wizard-note-green" style={{ marginTop: 16 }}>
                {tAiStep('stored_loaded')}
              </div>
            )}

            {aiError && (
              <div className="wizard-note wizard-note-red" style={{ marginTop: 16 }}>{aiError}</div>
            )}

            <div className="wizard-footer-actions" style={{ marginTop: 28 }}>
              {onboardPostDashboardSkipOn && <button
                className="btn btn-secondary btn-lg"
                onClick={() => router.push('/dashboard')}
                disabled={savingAi}
              >
                {tAiStep('skip_dashboard')}
              </button>}
              <button
                className="btn btn-primary btn-lg"
                style={{ flex: 1 }}
                onClick={() => void runPolicyRegeneration()}
                disabled={
                  savingAi ||
                  !settingsLoaded ||
                  aiProvider === 'disabled'
                }
              >
                {savingAi
                  ? <><span className="spinner" /> {tAiStep('saving_ai')}</>
                  : tAiStep('save_and_generate', { count: scrapeList.filter(item => item.status === 'success').length })}
              </button>
            </div>
          </>
        )}

        {step === 5 && onboardStepAiSummariesOn && policyProgress.length > 0 && (
          <PolicyRunPanel
            progress={policyProgress}
            activePhase={activePhase}
            runDone={policyRunDone}
            phaseAvgMs={phaseAvgMs}
            etaTick={etaTick}
            onCancelRequest={() => setCancelModalOpen(true)}
            onViewDashboard={() => router.push('/dashboard')}
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
              href="/onboard/goals"
              className="wizard-back-link"
              aria-label={tStep1('back_aria')}
            >
              <span aria-hidden="true">←</span> {tStep1('back_to_goals')}
            </Link>
            <h1 className="wizard-title">{tWiz('add_apps')}</h1>
            <p className="wizard-subtitle">
              {tStep1('subtitle')}
            </p>

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
              const primaryMethods: ImportMethod[] = [layout.primary, ...layout.secondary]
                .filter(m => methodAvailability[m]);
              const advancedMethods = layout.advanced.filter(m => methodAvailability[m]);

              const renderMethodCard = (value: ImportMethod, extraClass: string = '') => {
                const selected = method === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`onboard-method-${value}`}
                    className={`method-card ${selected ? 'active' : ''} ${extraClass}`.trim()}
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
                      setDeveloperHints(new Map());
                      setBundleIdHints(new Map());
                      setImportInfo('');
                    }}
                  >
                    <div className="method-card-top">
                      <span className="method-card-badge">{methodMeta[value].eyebrow}</span>
                      <span className="method-card-radio" aria-hidden="true">{selected ? '✓' : ''}</span>
                    </div>
                    <div className="method-card-title">{methodMeta[value].title}</div>
                    <p className="method-card-copy">{methodMeta[value].blurb}</p>
                    <div className="method-card-hint">{methodMeta[value].hint}</div>

                    {/* Device-specific inline action rows. Rendered inside
                        the card but outside the copy blocks so the CTA sits
                        below the hint. Clicks bubble up to the card unless
                        explicitly stopped. */}
                    {value === 'manual' && onboardMethodLiveTextOn && (deviceClass === 'phone' || deviceClass === 'tablet') && (
                      <div className="method-card-action">
                        <button
                          type="button"
                          className="link-button-inline"
                          onClick={event => {
                            event.stopPropagation();
                            setLiveTextModalOpen(true);
                          }}
                        >
                          {tStep1('live_text_link')}
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
                  <div className="method-grid method-grid-primary" role="radiogroup" aria-label={tStep1('method_grid_aria')}>
                    {primaryMethods.map(value => renderMethodCard(value, primaryMethods.length === 1 ? 'method-card-wide' : ''))}
                  </div>

                  {advancedMethods.length > 0 && (
                    <details className="method-advanced">
                      <summary className="method-advanced-summary">
                        {tStep1('advanced_summary')}
                      </summary>
                      <div className="method-grid method-grid-advanced" role="radiogroup" aria-label={tStep1('advanced_grid_aria')}>
                        {advancedMethods.map(value => renderMethodCard(value))}
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
            {onboardStepAppStoreRegionOn && <div className="wizard-country-row">
              <div className="wizard-country-copy">
                <div className="wizard-country-label">{tStep1('country_label')}</div>
                <div className="wizard-country-sub">
                  {tStep1('country_sub')}
                </div>
              </div>
              <select
                className="settings-input settings-select wizard-country-select"
                value={country}
                onChange={event => void updateCountry(event.target.value)}
                disabled={!countryLoaded}
                aria-label={tStep1('country_aria')}
              >
                {COUNTRY_OPTIONS.map(option => (
                  <option key={option.code} value={option.code}>
                    {tStep1('country_option', { label: option.label, code: option.code.toUpperCase() })}
                  </option>
                ))}
              </select>
              {/* Region → language suggestion. Mirror of the Settings
                  banner: appears below the picker after a region change
                  whose expected language differs from the active UI
                  locale. Click "Switch" → POST /api/locale + reload;
                  Dismiss → just clears the suggestion (no persistence). */}
              {languageSuggestion && (
                <div className="wizard-country-language-suggestion">
                  <LanguageSuggestionBanner
                    target={languageSuggestion}
                    onDismiss={() => setLanguageSuggestion(null)}
                  />
                </div>
              )}
            </div>}

            {/*
              Accessibility-label tracking. Apple publishes an "Accessibility"
              shelf on each app listing declaring features the developer
              claims to support (VoiceOver, Voice Control, Larger Text…). We
              always capture this alongside privacy labels, but the user can
              hide the chip/chart/filter if they don't care about the signal.
            */}
            {onboardStepAccessibilityToggleOn && <div className="wizard-country-row wizard-a11y-row">
              <div className="wizard-country-copy">
                <div className="wizard-country-label">
                  <span aria-hidden="true" className="wizard-a11y-icon">
                    {/* SF-symbol-style accessibility person-in-a-circle */}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <circle cx="12" cy="7.2" r="1.4" fill="currentColor" />
                      <path d="M6.5 10.5h11" />
                      <path d="M12 10.5v4" />
                      <path d="M9 18l3-3.5L15 18" />
                    </svg>
                  </span>
                  {tStep1('a11y_label')}
                </div>
                <div className="wizard-country-sub">
                  {tStep1('a11y_sub')}
                </div>
              </div>
              <label className="wizard-a11y-toggle">
                <input
                  type="checkbox"
                  checked={trackAccessibility}
                  onChange={event => void updateTrackAccessibility(event.target.checked)}
                  aria-label={tStep1('a11y_aria')}
                />
                <span className="wizard-a11y-toggle-label">
                  {trackAccessibility ? tStep1('a11y_on') : tStep1('a11y_off')}
                </span>
              </label>
            </div>}

            <div className="wizard-footer-actions">
              <button
                className="btn btn-primary btn-lg"
                style={{ flex: 1 }}
                data-testid="onboard-step1-continue"
                onClick={() => setStep(2)}
              >
                {tStep1('continue_with', { method: methodMeta[method].title.toLowerCase() })}
              </button>
            </div>

            {/*
              Subtle "have a backup?" escape hatch. Users who are re-installing
              the app or migrating from another machine shouldn't have to walk
              through the whole import flow just to restore a JSON they already
              exported. Kept deliberately quiet so it doesn't compete with the
              primary CTA above.
            */}
            {(onboardMethodRestoreBackupOn || onboardMethodImportAuditBundleOn) && <div className="onboard-restore-footer">
              <p className="onboard-restore-footer-copy">
                {tStep1('restore_lead')}
              </p>
              {onboardMethodRestoreBackupOn && <button
                type="button"
                className="onboard-restore-footer-link"
                onClick={() => restoreFileRef.current?.click()}
                disabled={restoreStage === 'previewing' || restoreStage === 'applying'}
              >
                {restoreStage === 'previewing' ? tStep1('restore_busy') : tStep1('restore_link')}
              </button>}
              <input
                ref={restoreFileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={event => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) handleRestoreFileChosen(file);
                }}
              />
              {restoreError && restoreStage === 'idle' && (
                <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>
                  {restoreError}
                </p>
              )}
            </div>}
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="wizard-title">{methodMeta[method].title}</h1>
            <p className="wizard-subtitle">
              {method === 'screenshots'
                ? tStep2('subtitle_screenshots')
                : method === 'file'
                  ? tStep2('subtitle_file')
                  : method === 'configurator'
                    ? tStep2('subtitle_configurator')
                    : tStep2('subtitle_manual')}
            </p>

            {method === 'screenshots' && (
              <>
                {isIosSafari && (
                  <div className="wizard-note wizard-note-amber" role="note">
                    <strong>{tStep2('ios_safari_heads_up_lead')}</strong>{tStep2('ios_safari_heads_up_body_pre')}
                    <button
                      type="button"
                      className="link-button-inline"
                      onClick={() => { userSelectedMethodRef.current = true; setMethod('manual'); setImageFiles([]); setOcrError(''); setOcrErrorDetail(''); setOcrMessage(''); }}
                    >
                      {tStep2('ios_safari_link_manual')}
                    </button>{tStep2('ios_safari_between')}
                    <button
                      type="button"
                      className="link-button-inline"
                      onClick={() => { userSelectedMethodRef.current = true; setMethod('file'); setImageFiles([]); setOcrError(''); setOcrErrorDetail(''); setOcrMessage(''); }}
                    >
                      {tStep2('ios_safari_link_file')}
                    </button>{tStep2('ios_safari_end')}
                  </div>
                )}

                <div className="wizard-note wizard-note-info" role="note">
                  <strong>{tStep2('screenshot_tip_lead')}</strong>{tStep2('screenshot_tip_body')}
                  <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                    <li>{tStep2('screenshot_tip_li1')}</li>
                    <li>{tStep2('screenshot_tip_li2')}</li>
                    <li>{tStep2('screenshot_tip_li3')}</li>
                  </ul>
                </div>

                <div
                  className={`file-drop ${isDraggingImages ? 'over' : ''}`}
                  onDragOver={event => { event.preventDefault(); setIsDraggingImages(true); }}
                  onDragLeave={() => setIsDraggingImages(false)}
                  onDrop={handleImageDrop}
                  onClick={() => imageFileRef.current?.click()}
                >
                  <div style={{ fontSize: 28 }}>🖼</div>
                  <div className="file-drop-text">
                    {tStep2('drop_screenshots')}
                  </div>
                  <div className="file-drop-subtext">{tStep2('drop_screenshots_sub')}</div>
                  <input
                    ref={imageFileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: 'none' }}
                    onChange={event => handleImageSelection(event.target.files)}
                  />
                </div>

                {imageFiles.length > 0 && (
                  <div className="upload-summary">
                    <div className="upload-summary-title">
                      {tStep2('selected_count', { count: imageFiles.length })}
                    </div>
                    <div className="upload-chip-row">
                      {imageFiles.map(file => (
                        <span key={`${file.name}-${file.lastModified}`} className="upload-chip">
                          {file.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {ocring && (
                  <div className="wizard-note wizard-note-blue">
                    <span className="spinner-sm" />
                    <span>{ocrMessage || tStep2('scanning')}</span>
                  </div>
                )}

                {!ocring && ocrMessage && (
                  <div className="wizard-note wizard-note-green">{ocrMessage}</div>
                )}

                {ocrError && (
                  <div className="wizard-note wizard-note-red">
                    <div>{ocrError}</div>
                    {ocrErrorDetail && (
                      <details style={{ marginTop: 8 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.85 }}>
                          {tStep2('show_technical')}
                        </summary>
                        <pre
                          style={{
                            margin: '6px 0 0',
                            padding: 8,
                            background: 'rgba(0,0,0,0.18)',
                            borderRadius: 6,
                            fontSize: 11,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
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

            {method === 'file' && (
              <>
                <div className="wizard-inline-actions">
                  <Link href="/help/export-app-list" className="wizard-inline-link" target="_blank">
                    {tStep2('file_export_link')}
                  </Link>
                </div>

                <div
                  className={`file-drop ${isDraggingText ? 'over' : ''}`}
                  onDragOver={event => { event.preventDefault(); setIsDraggingText(true); }}
                  onDragLeave={() => setIsDraggingText(false)}
                  onDrop={handleTextDrop}
                  onClick={() => textFileRef.current?.click()}
                >
                  <div style={{ fontSize: 28 }}>📂</div>
                  <div className="file-drop-text">
                    {tStep2.rich('file_drop_text', { b: chunks => <strong>{chunks}</strong> })}
                  </div>
                  <div className="file-drop-subtext">{tStep2('file_drop_sub')}</div>
                  <input
                    ref={textFileRef}
                    type="file"
                    accept=".txt,.csv,text/plain,text/csv"
                    style={{ display: 'none' }}
                    onChange={event => {
                      const file = event.target.files?.[0];
                      if (file) parseTextFile(file);
                    }}
                  />
                </div>

                {uploadedFileName && (
                  <div className="upload-summary">
                    <div className="upload-summary-title">{tStep2('imported_from', { filename: uploadedFileName })}</div>
                    <div className="upload-summary-copy">
                      {tStep2('imported_from_review')}
                    </div>
                  </div>
                )}
              </>
            )}

            {method === 'configurator' && (() => {
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
                uploadedFileName !== '' && namesText.trim().length > 0;
              // Pick an emoji for the device class so the success
              // summary visually matches the import-history row
              // SettingsView renders. Uses the live `selectedCfgutilDevice`
              // (richer than the source-label parse SettingsView has
              // to do) when available.
              const deviceClassRaw = selectedCfgutilDevice?.deviceClass?.toLowerCase() ?? '';
              const deviceIcon =
                deviceClassRaw.includes('iphone') ? '📱'
                : deviceClassRaw.includes('ipad')   ? '📱'
                : deviceClassRaw.includes('ipod')   ? '🎵'
                : deviceClassRaw.includes('appletv') || deviceClassRaw.includes('apple tv') ? '📺'
                : deviceClassRaw.includes('applewatch') || deviceClassRaw.includes('apple watch') ? '⌚️'
                // Fall back to the generic Configurator glyph when
                // cfgutil's deviceClass field came back empty (older
                // builds, or the device went away after export).
                : '📱';
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
                  <section className="cfgutil-panel" aria-label={tCfg('panel_aria')}>
                    <header className="cfgutil-panel-header">
                      <div>
                        <div className="cfgutil-panel-eyebrow">{tCfg('eyebrow')}</div>
                        <h2 className="cfgutil-panel-title">
                          {tCfg('title')}
                        </h2>
                        <p className="cfgutil-panel-copy">
                          {tCfg('copy')}
                        </p>
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
                          'cfgutil-step ' +
                          (cfgutilCheck?.appInstalled ? 'cfgutil-step-done' : 'cfgutil-step-pending')
                        }
                      >
                        <div className="cfgutil-step-number">1</div>
                        <div className="cfgutil-step-body">
                          <div className="cfgutil-step-title">
                            {tCfg('step1_title')}
                            {cfgutilCheck?.appInstalled && (
                              <span className="cfgutil-step-badge">{tCfg('step1_installed_badge')}</span>
                            )}
                          </div>
                          <p className="cfgutil-step-copy">
                            {tCfg('step1_copy_pre')}<code>cfgutil</code>{tCfg('step1_copy_post')}
                          </p>
                          <div className="cfgutil-step-actions">
                            <a
                              className={
                                cfgutilCheck?.appInstalled
                                  ? 'link-button-inline'
                                  : 'btn btn-primary btn-sm'
                              }
                              href={APPLE_CONFIGURATOR_MACAPPSTORE_URL}
                              // The macappstore:// protocol opens the App Store
                              // app directly; target=_self keeps the webview from
                              // spawning a new tab when the scheme handler fires.
                              target="_self"
                              rel="noreferrer"
                            >
                              {cfgutilCheck?.appInstalled ? tCfg('step1_open_installed') : tCfg('step1_open_new')}
                            </a>
                            <a
                              className="link-button-inline"
                              href={APPLE_CONFIGURATOR_HTTPS_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {tCfg('step1_view_listing')}
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
                          'cfgutil-step ' +
                          (cfgutilCheck?.available
                            ? 'cfgutil-step-done'
                            : cfgutilCheck
                              ? 'cfgutil-step-error'
                              : 'cfgutil-step-pending')
                        }
                      >
                        <div className="cfgutil-step-number">2</div>
                        <div className="cfgutil-step-body">
                          <div className="cfgutil-step-title">
                            {tCfg('step2_title')}
                            {cfgutilCheck?.available && (
                              <span className="cfgutil-step-badge">
                                {cfgutilCheck.version
                                  ? tCfg('step2_badge_version', { version: cfgutilCheck.version })
                                  : tCfg('step2_badge_ready')}
                              </span>
                            )}
                          </div>
                          {!cfgutilCheck && (
                            <p className="cfgutil-step-copy">
                              {tCfg('step2_copy_initial_pre')}<code>cfgutil --format JSON list</code>{tCfg('step2_copy_initial_post')}
                            </p>
                          )}
                          {cfgutilCheck && !cfgutilCheck.available && (
                            <>
                              <p className="cfgutil-step-copy">
                                {cfgutilCheck.appInstalled
                                  ? tCfg('step2_copy_app_installed')
                                  : cfgutilCheck.error ?? tCfg('step2_copy_not_found')}
                              </p>
                              {cfgutilCheck.platform !== 'macos' && (
                                <p className="cfgutil-step-copy">
                                  {tCfg('step2_copy_not_macos')}
                                </p>
                              )}
                            </>
                          )}
                          <div className="cfgutil-step-actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void runCfgutilCheck()}
                              disabled={cfgutilChecking}
                            >
                              {cfgutilChecking ? (
                                <>
                                  <span className="spinner" /> {tCfg('step2_checking')}
                                </>
                              ) : cfgutilCheck ? (
                                tCfg('step2_recheck')
                              ) : (
                                tCfg('step2_check')
                              )}
                            </button>
                            {cfgutilCheck?.path && (
                              <span className="cfgutil-step-sub">
                                {tCfg('step2_path_pre')}<code>{cfgutilCheck.path}</code>
                              </span>
                            )}
                          </div>
                          {/* Larger, more visible "we're working on it"
                              panel — the cfgutil probe shells out + checks
                              the Automation Tools install, which can take
                              5–30s on a cold call. The button's 16px
                              spinner alone isn't enough signal. Renders
                              only while cfgutilChecking is true; aria-live
                              announces the title to screen readers. */}
                          {cfgutilChecking && (
                            <div
                              className="cfgutil-checking-status"
                              role="status"
                              aria-live="polite"
                            >
                              <span className="spinner-lg" aria-hidden />
                              <div className="cfgutil-checking-status-body">
                                <div className="cfgutil-checking-status-title">
                                  {tCfg('checking_status_title')}
                                </div>
                                <div className="cfgutil-checking-status-copy">
                                  {tCfg('checking_status_body')}
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
                          'cfgutil-step ' +
                          (cfgutilCheck?.available ? 'cfgutil-step-ready' : 'cfgutil-step-locked')
                        }
                      >
                        <div className="cfgutil-step-number">3</div>
                        <div className="cfgutil-step-body">
                          <div className="cfgutil-step-title">
                            {tCfg('step3_title')}
                          </div>
                          <p className="cfgutil-step-copy">
                            {tCfg('step3_copy_pre')}<strong>{tCfg('step3_copy_trust')}</strong>{tCfg('step3_copy_mid')}<code>cfgutil --format JSON get installedApps</code>{tCfg('step3_copy_post')}
                          </p>
                          {cfgutilCheck?.available && (
                            <div className="cfgutil-device-picker">
                              <div className="cfgutil-device-picker-header">
                                <div>
                                  <div className="cfgutil-device-picker-title">
                                    {tCfg('device_picker_title')}
                                  </div>
                                  <div className="cfgutil-device-picker-sub">
                                    {cfgutilDevices.length > 1
                                      ? tCfg('device_picker_multi')
                                      : selectedCfgutilDevice
                                        ? tCfg('device_picker_selected', { device: describeCfgutilDevice(selectedCfgutilDevice) })
                                        : tCfg('device_picker_empty')}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="pill-button"
                                  onClick={() => void refreshCfgutilDevices()}
                                  disabled={cfgutilDevicesLoading}
                                >
                                  {cfgutilDevicesLoading ? (
                                    <><span className="spinner-sm" /> {tCfg('device_refreshing')}</>
                                  ) : (
                                    tCfg('device_refresh')
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
                              {cfgutilDevicesLoading && cfgutilDevices.length === 0 && (
                                <div
                                  className="cfgutil-device-list cfgutil-device-list--loading"
                                  role="status"
                                  aria-label={tCfg('device_skeleton_aria')}
                                  aria-live="polite"
                                >
                                  <div className="cfgutil-device-loading-banner">
                                    <span className="spinner-sm" aria-hidden />
                                    <span>{tCfg('devices_refreshing_status')}</span>
                                  </div>
                                  <div className="cfgutil-device-row cfgutil-device-row--skeleton" aria-hidden>
                                    <span className="cfgutil-device-dot" />
                                    <span className="cfgutil-device-text">
                                      <span className="cfgutil-device-skeleton cfgutil-device-skeleton--name" />
                                      <span className="cfgutil-device-skeleton cfgutil-device-skeleton--meta" />
                                    </span>
                                  </div>
                                  <div className="cfgutil-device-row cfgutil-device-row--skeleton" aria-hidden>
                                    <span className="cfgutil-device-dot" />
                                    <span className="cfgutil-device-text">
                                      <span className="cfgutil-device-skeleton cfgutil-device-skeleton--name" />
                                      <span className="cfgutil-device-skeleton cfgutil-device-skeleton--meta" />
                                    </span>
                                  </div>
                                </div>
                              )}
                              {cfgutilDevices.length > 0 && (
                                <div className="cfgutil-device-list" role="radiogroup" aria-label={tCfg('device_picker_aria')}>
                                  {cfgutilDevices.map(device => {
                                    const selectedDevice = selectedCfgutilEcid === device.ecid;
                                    return (
                                      <button
                                        key={device.ecid}
                                        type="button"
                                        className={`cfgutil-device-row${selectedDevice ? ' is-selected' : ''}`}
                                        role="radio"
                                        aria-checked={selectedDevice}
                                        onClick={() => {
                                          setSelectedCfgutilEcid(device.ecid);
                                          if (cfgutilError === tCfg('step3_select_required')) setCfgutilError('');
                                        }}
                                      >
                                        <span className="cfgutil-device-dot" aria-hidden />
                                        <span className="cfgutil-device-text">
                                          <span className="cfgutil-device-name">
                                            {describeCfgutilDevice(device)}
                                          </span>
                                          <span className="cfgutil-device-meta">
                                            {describeCfgutilDeviceMeta(device)}
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
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => void runCfgutilExportClick()}
                              disabled={!cfgutilCheck?.available || cfgutilExporting || cfgutilDevicesLoading}
                            >
                              {cfgutilExporting ? (
                                <>
                                  <span className="spinner" /> {tCfg('step3_export_busy')}
                                </>
                              ) : selectedCfgutilDevice ? (
                                tCfg('step3_export_selected')
                              ) : (
                                tCfg('step3_export')
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
                        <strong>{tCfg('error_title')}</strong>
                        <span>{cfgutilError}</span>
                        {cfgutilDiagnostic && (
                          <details className="cfgutil-diagnostic">
                            <summary>Show diagnostic output</summary>
                            <p className="cfgutil-diagnostic-hint">
                              This is the raw output cfgutil produced. Common reasons for an empty result: the device is locked (cfgutil can&rsquo;t enumerate apps without a session), an unread <em>Trust This Computer?</em> prompt is sitting on the phone, or restrictions are filtering installed apps. Copy and share this block if you need help diagnosing.
                            </p>
                            <pre className="cfgutil-diagnostic-pre">
                              {cfgutilDiagnostic.length > 4096
                                ? cfgutilDiagnostic.slice(0, 4096) + '\n\n…(truncated, ' + (cfgutilDiagnostic.length - 4096) + ' bytes more)'
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
                      <div className="cfgutil-progress-overlay" role="status" aria-live="polite">
                        <div className="cfgutil-progress-card">
                          <span className="spinner spinner-large" aria-hidden="true" />
                          <h3 className="cfgutil-progress-title">
                            Reading apps from your iPhone&hellip;
                          </h3>
                          <p className="cfgutil-progress-body">
                            cfgutil is enumerating every installed app over USB. On a phone with 300&nbsp;+&nbsp;apps this can take up to a minute. The cursor may show a beach&nbsp;ball briefly &mdash; that&rsquo;s expected, the system call is synchronous.
                          </p>
                          <p className="cfgutil-progress-tip">
                            Tip: keep the device unlocked while this runs.
                          </p>
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {!cfgutilImportSuccessful && (
                  <div className="wizard-note wizard-note-info" role="note">
                    <strong>
                      {inDesktop ? tStep2('configurator_export_lead_desktop') : tStep2('configurator_export_lead_other')}
                    </strong>
                    <ol style={{ margin: '8px 0 0 20px', padding: 0 }}>
                      <li>{tStep2('configurator_step_1')}</li>
                      <li>{tStep2('configurator_step_2')}</li>
                      <li>{tStep2.rich('configurator_step_3', { b: chunks => <strong>{chunks}</strong> })}</li>
                      <li>{tStep2.rich('configurator_step_4', { b: chunks => <strong>{chunks}</strong> })}</li>
                      <li>{tStep2('configurator_step_5')}</li>
                    </ol>
                  </div>
                )}

                {!cfgutilImportSuccessful && (
                  <div
                    className={`file-drop ${isDraggingText ? 'over' : ''}`}
                    onDragOver={event => { event.preventDefault(); setIsDraggingText(true); }}
                    onDragLeave={() => setIsDraggingText(false)}
                    onDrop={handleTextDrop}
                    onClick={() => textFileRef.current?.click()}
                  >
                    <div style={{ fontSize: 28 }}>📋</div>
                    <div className="file-drop-text">
                      {tStep2('configurator_drop_text')}
                    </div>
                    <div className="file-drop-subtext">
                      {tStep2('configurator_drop_sub')}
                    </div>
                    <input
                      ref={textFileRef}
                      type="file"
                      accept=".csv,text/csv,.txt,text/plain"
                      style={{ display: 'none' }}
                      onChange={event => {
                        const file = event.target.files?.[0];
                        if (file) parseTextFile(file);
                      }}
                    />
                  </div>
                )}

                {uploadedFileName && (
                  <div className="upload-summary">
                    <div className="upload-summary-title">
                      <span className="upload-summary-device-icon" aria-hidden="true">{deviceIcon}</span>
                      {' '}
                      {tStep2('imported_from', { filename: uploadedFileName })}
                    </div>
                    <div className="upload-summary-copy">
                      {tStep2('imported_from_review_long')}
                    </div>
                    {importInfo && (
                      <div className="upload-summary-note">{importInfo}</div>
                    )}
                    {developerHints.size > 0 && (
                      <div className="upload-summary-note">
                        {tStep2('developer_hints_note')}
                      </div>
                    )}
                    {cfgutilImportSuccessful && inDesktop && (
                      <div className="upload-summary-actions">
                        <button
                          type="button"
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
                            setUploadedFileName('');
                            setImportInfo('');
                          }}
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

            <div className="wizard-list-header">
              <div>
                <div className="wizard-list-title">{tStep2('list_title')}</div>
                <div className="wizard-list-copy">
                  {selectedCount > 0
                    ? tStep2('list_count', { count: selectedCount })
                    : method === 'screenshots'
                      ? tStep2('list_empty_screenshots')
                      : method === 'configurator'
                        ? tStep2('list_empty_configurator')
                        : tStep2('list_empty_manual')}
                </div>
              </div>
            </div>

            <textarea
              className="textarea"
              data-testid="onboard-app-names"
              style={{ minHeight: 220 }}
              value={namesText}
              onChange={event => setNamesText(event.target.value)}
              placeholder={'Instagram\nTikTok\nSpotify\nWhatsApp'}
            />

            {/* The "N of these are already tracked" banner that used to
                live here relied on a name-lowercase fuzzy match, which
                mis-counted common names (many apps share a title) and
                also missed misspellings. It has moved to the top of
                Step 3 — see the `trackedSelectedCount` banner there —
                where the App Store appleId of each chosen candidate
                gives us an exact, authoritative count. */}

            {searchError && (
              <p style={{ color: 'var(--red)', fontSize: 13, marginTop: 12 }}>{searchError}</p>
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

            <div className="wizard-footer-actions">
              <button className="btn btn-secondary" onClick={() => setStep(1)}>
                {tStep2('back')}
              </button>
              <button
                className="btn btn-primary btn-lg"
                style={{ flex: 1 }}
                data-testid="onboard-search"
                onClick={handleSearch}
                  disabled={searching || selectedCount === 0 || ocring}
                >
                  {searching ? <><span className="spinner" /> {tStep2('search_busy')}</> : tStep2('search')}
                </button>
              </div>
          </>
        )}

        {step === 3 && onboardStepConfirmMatchesOn && (() => {
          // ── Step 3 derived state ────────────────────────────────────
          //
          // `trackedSelectedCount` counts how many of the user's chosen
          // candidates already exist in the local DB (looked up by the
          // App Store appleId — exact, not a fuzzy name match). This
          // powers the "N of these apps are already being tracked"
          // banner at the top of Step 3. It supersedes the Step 2 name-
          // based nudge, which could over-count because many apps share
          // a common name.
          const trackedSelectedCount = Array.from(selected.values()).filter(candidate =>
            trackedByAppleId.has(candidate.appleId),
          ).length;

          // `visibleResults` drives the rendered block list. When the
          // "Hide already-tracked apps" toggle is on, we drop any block
          // whose currently-chosen candidate matches a tracked app. If
          // no candidate is chosen yet (skipped / no matches), we keep
          // the block visible — there's nothing confident to hide.
          const visibleResults = hideTrackedBlocks
            ? searchResults.filter(result => {
                const chosen = selected.get(result.query);
                return !chosen || !trackedByAppleId.has(chosen.appleId);
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
                  ([, candidate]) => !trackedByAppleId.has(candidate.appleId),
                ),
              )
            : selected;
          const effectiveCount = effectiveSelected.size;

          // List of query names that returned no App Store candidates,
          // and the subset that the user hasn't already skipped /
          // researched. Used for the bulk-action banner below the
          // tracked-banner — on a large cfgutil batch (200+ apps),
          // clicking "Skip this" per row is unworkable. The banner
          // gives a single "skip all" affordance and a count so the
          // user knows what they're collapsing.
          const unmatchedQueries = searchResults
            .filter(r => r.candidates.length === 0)
            .map(r => r.query);
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
            <h1 className="wizard-title">{tWiz('confirm_matches')}</h1>
            <p className="wizard-subtitle">
              {tStep3('subtitle')}
            </p>

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
                    className="wizard-note wizard-note-info"
                    style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}
                    role="status"
                    aria-live="polite"
                  >
                    <span className="spinner" aria-hidden="true" />
                    <span>
                      <strong>{tStep3('checking_lead')}</strong>{tStep3('checking_body')}
                    </span>
                  </div>
                );
              }
              if (trackedSelectedCount === 0) return null;
              return (
                <div className="wizard-note wizard-note-info" style={{ marginTop: 12 }}>
                  <strong>{tStep3('tracked_lead', { count: trackedSelectedCount })}</strong>{tStep3('tracked_body')}
                  {onboardHideTrackedToggleOn && <label
                    className="wizard-toggle-inline"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginTop: 10,
                      cursor: 'pointer',
                      fontWeight: 500,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={hideTrackedBlocks}
                      onChange={event => setHideTrackedBlocks(event.target.checked)}
                    />
                    <span>
                      {tStep3('hide_tracked_label')}{' '}
                      <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>
                        {tStep3('hide_tracked_hint')}
                      </span>
                    </span>
                  </label>}
                </div>
              );
            })()}

            {ratePending.pending && (() => {
              // Read `rateTick` so the countdown re-renders every second while
              // we wait. The actual queue + timer lives in QueuedSearchProvider
              // (layout-level) so it keeps running even if the user navigates
              // away — this banner is just a local view on to its state.
              void rateTick;
              const queuedCount = ratePending.remaining;
              const resumeAt = ratePending.resumeAt;
              const remainingMs = resumeAt !== null ? Math.max(0, resumeAt - Date.now()) : null;
              const remainingSec = remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;
              return (
                <div className="wizard-rate-banner" role="status" aria-live="polite">
                  <div className="wizard-rate-banner-icon" aria-hidden>⏳</div>
                  <div className="wizard-rate-banner-copy">
                    <div className="wizard-rate-banner-title">
                      {tStep3('rate_limit_title')}
                    </div>
                    <div className="wizard-rate-banner-sub">
                      {tStep3('rate_limit_queued', { count: queuedCount })}
                      {remainingSec !== null
                        ? tStep3('rate_limit_resume_in', { sec: remainingSec })
                        : tStep3('rate_limit_resume_soon')}
                      {tStep3('rate_limit_hint')}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="wizard-rate-banner-cancel"
                    onClick={() => queuedSearch.cancel()}
                    aria-label={tStep3('rate_limit_cancel_aria')}
                  >
                    {tStep3('rate_limit_cancel')}
                  </button>
                </div>
              );
            })()}

            {unmatchedCount > 0 && (
              // Unmatched-apps banner. Big cfgutil imports routinely
              // produce 50+ rows that didn't resolve to an App Store
              // candidate (sideloaded apps, region-restricted apps,
              // names too generic for the search to disambiguate).
              // Clicking "Skip this" per block was unworkable. This
              // banner gives a single skip-all affordance with a count
              // so the user knows what they're collapsing, mirroring
              // the tracked-banner pattern above for visual symmetry.
              <div className="wizard-note wizard-note-info" style={{ marginTop: 12 }}>
                <strong>{tStep3('unmatched_lead', { count: unmatchedCount })}</strong>
                {tStep3('unmatched_body')}
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      for (const query of unmatchedQueries) {
                        void handleBlockSkip(query);
                      }
                    }}
                  >
                    {tStep3('unmatched_skip_all', { count: unmatchedCount })}
                  </button>
                </div>
              </div>
            )}

            <div className="search-result-list">
              {visibleResults.map(result => (
                <SearchResultBlock
                  key={result.query}
                  result={result}
                  chosen={selected.get(result.query) ?? null}
                  editing={editingBlock === result.query}
                  developerHint={developerHints.get(result.query.toLowerCase()) ?? ''}
                  trackedByAppleId={trackedByAppleId}
                  onChoose={candidate => {
                    if (candidate === null) {
                      const next = new Map(selected);
                      next.delete(result.query);
                      setSelected(next);
                      return;
                    }

                    setSelected(new Map(selected).set(result.query, candidate));
                  }}
                  onResearch={(nextQuery, nextDeveloper, force) =>
                    handleBlockResearch(result.query, nextQuery, nextDeveloper, force)
                  }
                  onSkip={() => handleBlockSkip(result.query)}
                />
              ))}
              {visibleResults.length === 0 && searchResults.length > 0 && (
                // Only reachable when "Hide already-tracked apps" has
                // filtered every block out — tell the user what happened
                // and offer them a one-click way back to the full list.
                <div
                  className="wizard-note wizard-note-info"
                  style={{ textAlign: 'center' }}
                >
                  {tStep3('all_hidden')}{' '}
                  <button
                    type="button"
                    className="link-button-inline"
                    onClick={() => setHideTrackedBlocks(false)}
                  >
                    {tStep3('show_all')}
                  </button>
                </div>
              )}
            </div>

            <div className="wizard-footer-actions">
              <button className="btn btn-secondary" onClick={() => setStep(2)}>
                {tStep3('back')}
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                data-testid="onboard-confirm-import"
                onClick={() => void handleConfirm(effectiveSelected)}
                disabled={effectiveCount === 0}
              >
                {tStep3('import_count', { count: effectiveCount })}
              </button>
            </div>
          </>
          );
        })()}

        {step === 4 && onboardStepImportProgressOn && (
          <>
            <h1 className="wizard-title">{done ? tWiz('import_complete') : tWiz('import_running')}</h1>
            <p className="wizard-subtitle" style={{ marginBottom: 24 }}>
              {(() => {
                if (!done) {
                  return tStep4('subtitle_background');
                }
                const successCount = scrapeList.filter(item => item.status === 'success').length;
                const queuedCount = scrapeList.filter(item => item.status === 'queued').length;
                const base = tStep4('subtitle_done_base', { success: successCount, total: scrapeList.length });
                if (queuedCount > 0) {
                  return base + tStep4('subtitle_done_queued', { count: queuedCount });
                }
                return base;
              })()}
            </p>

            {(() => {
              const total = scrapeList.length;
              const successCount = scrapeList.filter(item => item.status === 'success').length;
              const errorCount = scrapeList.filter(item => item.status === 'error').length;
              const queuedCount = scrapeList.filter(item => item.status === 'queued' || item.status === 'pending').length;
              const completedCount = successCount + errorCount;
              const progressPct = total > 0 ? Math.max(4, Math.round((completedCount / total) * 100)) : 0;
              return (
                <div className="onboard-import-status-card" role="status" aria-live="polite">
                  <div className="onboard-import-status-topline">
                    <div>
                      <div className="onboard-import-status-title">
                        {done
                          ? tStep4('status_done', { done: completedCount, total })
                          : tStep4('status_running', { done: completedCount, total })}
                      </div>
                      <div className="onboard-import-status-sub">
                        {queuedCount > 0
                          ? tStep4('status_background_hint', { count: queuedCount })
                          : errorCount > 0
                            ? tStep4('status_done_with_errors', { count: errorCount })
                            : tStep4('status_done_clean')}
                      </div>
                    </div>
                    {!done && <span className="spinner-sm" aria-hidden />}
                  </div>
                  <div className="onboard-import-progress" aria-hidden>
                    <div className="onboard-import-progress-fill" style={{ width: `${progressPct}%` }} />
                  </div>
                  <div className="onboard-import-status-meta">
                    <span>{tStep4('status_imported', { count: successCount })}</span>
                    <span>{tStep4('status_waiting', { count: queuedCount })}</span>
                    {errorCount > 0 && <span>{tStep4('status_attention', { count: errorCount })}</span>}
                  </div>
                </div>
              );
            })()}

            {onboardImportRateLimitHandoffOn && scrapeRateLimit && (() => {
              // Touch `scrapeRateTick` so the seconds value re-renders every
              // second while we wait out Apple's cooldown.
              void scrapeRateTick;
              const remainingMs = Math.max(0, scrapeRateLimit.resumeAt - Date.now());
              const remainingSec = Math.ceil(remainingMs / 1000);
              return (
                <div className="wizard-rate-banner" role="status" aria-live="polite">
                  <div className="wizard-rate-banner-icon" aria-hidden>⏳</div>
                  <div className="wizard-rate-banner-copy">
                    <div className="wizard-rate-banner-title">
                      {tStep4('rate_limit_title')}
                    </div>
                    <div className="wizard-rate-banner-sub">
                      {tStep4('rate_limit_sub', { sec: remainingSec })}
                    </div>
                  </div>
                  {onboardPostBackgroundWorkerOn && <button
                    type="button"
                    className="wizard-rate-banner-cancel"
                    onClick={() => {
                      scrapeCancelRef.current = true;
                    }}
                    aria-label={tStep4('rate_limit_handoff_aria')}
                  >
                    {tStep4('rate_limit_handoff')}
                  </button>}
                </div>
              );
            })()}

            <details
              className="onboard-import-details"
              open={importDetailsOpen}
              onToggle={event => setImportDetailsOpen(event.currentTarget.open)}
            >
              <summary>
                <span>{tStep4('details_summary', { count: scrapeList.length })}</span>
                <span className="onboard-import-details-chevron" aria-hidden>⌄</span>
              </summary>
              {scrapeList.length > 10 && !done && (
                <div className="scrape-jump-row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      const el = scrapeListEndRef.current;
                      if (!el) return;
                      try {
                        el.scrollIntoView({ block: 'end', behavior: 'smooth' });
                      } catch {
                        el.scrollIntoView();
                      }
                    }}
                  >
                    {tStep4('scroll_to_bottom')}
                  </button>
                </div>
              )}
              <div className="scrape-list-wrap">
                <div className="scrape-list">
                  {scrapeList.map((item, index) => (
                    <div
                      key={`${item.url}-${index}`}
                      ref={item.status === 'scraping' ? scrapeActiveRowRef : undefined}
                      className={`scrape-row ${item.status === 'error' ? 'error' : ''} ${item.status === 'queued' ? 'queued' : ''}`}
                    >
                      <div className="scrape-status-icon">
                        {item.status === 'pending' && <span style={{ color: 'var(--text-3)' }}>○</span>}
                        {item.status === 'scraping' && <span className="spinner-sm" />}
                        {item.status === 'success' && <span style={{ color: 'var(--green)' }}>✓</span>}
                        {item.status === 'error' && <span style={{ color: 'var(--red)' }} aria-label={tStep4('row_failed_aria')}>!</span>}
                        {item.status === 'queued' && <span style={{ color: 'var(--orange)' }} aria-label={tStep4('row_queued_aria')}>⏱</span>}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="scrape-name">{item.name}</div>
                        {item.status === 'error' && item.error && (
                          <div className="scrape-sub" style={{ color: 'var(--red)' }}>
                            {item.error}
                          </div>
                        )}
                        {item.status === 'queued' && (
                          <div className="scrape-sub" style={{ color: 'var(--orange)' }}>
                            {item.error ?? tStep4('row_queued_default')}
                            {item.retryAfterMs
                              ? tStep4('row_queued_retry_in', { sec: Math.max(1, Math.round(item.retryAfterMs / 1000)) })
                              : ''}
                          </div>
                        )}
                        {item.status === 'success' && item.changesDetected && (
                          <div className="scrape-sub" style={{ color: 'var(--orange)' }}>{tStep4('row_changes_detected')}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div ref={scrapeListEndRef} aria-hidden />
              </div>
            </details>

            {(done || scrapeList.length > 0) && (
              <div className="wizard-footer-actions" style={{ marginTop: 28 }}>
                <button
                  className="btn btn-secondary btn-lg"
                  onClick={() => router.push('/dashboard')}
                >
                  {tStep4('skip_dashboard')}
                </button>
                {!done && (
                  <button
                    className="btn btn-secondary btn-lg"
                    onClick={() => router.push('/dashboard/settings/import-history')}
                  >
                    {tStep4('view_history')}
                  </button>
                )}
                <button
                  className="btn btn-primary btn-lg"
                  style={{ flex: 1 }}
                  data-testid="onboard-next-ai"
                  onClick={() => setStep(5)}
                  disabled={scrapeList.filter(item => item.status === 'success').length === 0}
                >
                  {tStep4('next_ai')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {(restoreStage === 'confirm' || restoreStage === 'applying') && restorePreview && (
        <div
          className="modal-overlay"
          onClick={() => { if (restoreStage !== 'applying') resetRestoreFlow(); }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboard-restore-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="modal-badge">{tModalRestore('badge')}</div>
            <h2 id="onboard-restore-title" className="modal-title">
              {tModalRestore('title')}
            </h2>
            <p className="modal-copy">
              {pendingRestoreFilename ? (
                <>
                  <strong>{pendingRestoreFilename}</strong>
                  {restorePreview.exportedAt ? tModalRestore('exported_suffix', { date: new Date(restorePreview.exportedAt).toLocaleDateString() }) : null}
                  {' '}{tModalRestore('version_suffix', { version: restorePreview.version })}{' '}
                  {tModalRestore('rows', { count: restorePreview.totalRows })}
                </>
              ) : (
                <>{tModalRestore('no_filename', { count: restorePreview.totalRows, tables: restorePreview.perTable.length })}</>
              )}
            </p>

            <div className="backup-preview-table" role="table" aria-label={tModalRestore('rows_per_table_aria')}>
              {restorePreview.perTable
                .filter(row => row.rows > 0)
                .map(row => (
                  <div className="backup-preview-row" key={row.name} role="row">
                    <span className="backup-preview-name" role="cell">{row.name}</span>
                    <span className="backup-preview-count" role="cell">
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
              {tModalRestore('warning')}
            </div>

            <label className="modal-confirm-label" htmlFor="onboard-restore-input">
              {tModalRestore.rich('confirm_label', { code: chunks => <code>{chunks}</code> })}
            </label>
            <input
              id="onboard-restore-input"
              className="modal-confirm-input"
              type="text"
              value={restoreConfirmText}
              onChange={event => {
                setRestoreConfirmText(event.target.value);
                if (restoreError) setRestoreError('');
              }}
              placeholder={tModalRestore('confirm_placeholder')}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={restoreStage === 'applying'}
            />

            {restoreError && (
              <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>
                {restoreError}
              </p>
            )}

            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={resetRestoreFlow}
                disabled={restoreStage === 'applying'}
              >
                {tModalRestore('cancel')}
              </button>
              <button
                className="btn btn-danger"
                onClick={handleRestoreConfirm}
                disabled={
                  restoreStage === 'applying' ||
                  restoreConfirmText.trim().toUpperCase() !== 'RESTORE'
                }
              >
                {restoreStage === 'applying' ? tModalRestore('restoring') : tModalRestore('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelModalOpen && (
        <div className="modal-overlay" onClick={() => setCancelModalOpen(false)}>
          <div
            className="modal-card cancel-confirm-modal"
            onClick={event => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-modal-title"
            aria-describedby="cancel-modal-copy"
            onKeyDown={event => { if (event.key === 'Escape') setCancelModalOpen(false); }}
          >
            <h2 id="cancel-modal-title" className="modal-title">{tModalCancel('title')}</h2>
            <p id="cancel-modal-copy" className="modal-copy">
              {tModalCancel('body')}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setCancelModalOpen(false)}
              >
                {tModalCancel('keep_going')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => requestStop('after-current')}
              >
                {tModalCancel('stop_after_current')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => requestStop('now')}
              >
                {tModalCancel('stop_now')}
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
            className="modal-card rate-limit-pause-modal"
            onClick={event => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="rate-limit-modal-title"
            aria-describedby="rate-limit-modal-copy"
            onKeyDown={event => {
              if (event.key === 'Escape') setRateLimitPauseModal(null);
            }}
          >
            <div className="modal-badge">{tModalRate('badge')}</div>
            <h2 id="rate-limit-modal-title" className="modal-title">
              {tModalRate('title')}
            </h2>
            <p id="rate-limit-modal-copy" className="modal-copy">
              {tModalRate('body_lead')}
              {tModalRate.rich('body_queued', {
                count: rateLimitPauseModal.queuedCount,
                b: chunks => <strong>{chunks}</strong>,
              })}
              {tModalRate('body_retry_minutes', { count: Math.max(1, Math.round(rateLimitPauseModal.retryAfterMs / 60_000)) })}
              {rateLimitPauseModal.successCount > 0 && tModalRate.rich('body_success', {
                count: rateLimitPauseModal.successCount,
                b: chunks => <strong>{chunks}</strong>,
              })}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setRateLimitPauseModal(null)}
              >
                {tModalRate('stay_here')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setRateLimitPauseModal(null);
                  router.push('/dashboard/settings/import-history');
                }}
              >
                {tModalRate('view_history')}
              </button>
              {rateLimitPauseModal.successCount > 0 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setRateLimitPauseModal(null);
                    // Step 5 = AI summaries. The button in the page
                    // footer does the same thing, but the modal makes
                    // it a one-click path from the pause itself.
                    setStep(5);
                  }}
                >
                  {tModalRate('summarise')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <LiveTextModal
        open={liveTextModalOpen}
        onClose={() => setLiveTextModalOpen(false)}
      />
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
    p => p.scrape.status === 'done' || p.scrape.status === 'error' || p.scrape.status === 'skipped',
  ).length;
  const summariseDone = progress.filter(
    p => p.summarise.status === 'done' || p.summarise.status === 'error' || p.summarise.status === 'skipped',
  ).length;

  const overallCompleted = scrapeDone + summariseDone;
  const overallTotal = total * 2;
  const pct = overallTotal === 0 ? 0 : Math.round((overallCompleted / overallTotal) * 100);

  const t = useTranslations('onboard.policy_run');
  // ETA: use the active phase's rolling average × remaining.
  let etaText: string | null = null;
  if (activePhase === 'fetch' && phaseAvgMs.fetch !== null) {
    const remaining = total - scrapeDone;
    if (remaining > 0) etaText = t('eta_fetch', { time: formatMs(remaining * phaseAvgMs.fetch) });
  } else if (activePhase === 'summarise' && phaseAvgMs.summarise !== null) {
    const remainingSummarise = progress.filter(
      p => p.summarise.status === 'pending' || p.summarise.status === 'working',
    ).length;
    if (remainingSummarise > 0) etaText = t('eta_summarise', { time: formatMs(remainingSummarise * phaseAvgMs.summarise) });
  }

  const phaseLabel =
    activePhase === 'fetch'
      ? t('phase_fetch')
      : activePhase === 'summarise'
        ? t('phase_summarise')
        : runDone
          ? t('phase_finished')
          : t('phase_starting');

  const totalsLabel = activePhase === 'fetch'
    ? t('totals_fetch', { done: scrapeDone, total })
    : activePhase === 'summarise'
      ? t('totals_summarise', { done: summariseDone, total })
      : runDone
        ? t('totals_done', { fetched: scrapeDone, summarised: summariseDone })
        : '';

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
        {!runDone ? (
          <button type="button" className="btn btn-secondary" onClick={onCancelRequest}>
            {t('cancel')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onViewDashboard}>
            {t('view_dashboard')}
          </button>
        )}
      </div>

      <div className="policy-run-progress-bar">
        <div className="policy-run-progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="policy-run-rows">
        {progress.map((item, index) => (
          <div key={`${item.appId}-${index}`} className="policy-phase-row">
            <div className="policy-phase-app">
              <div className="policy-phase-app-name">{item.name}</div>
            </div>
            <PolicyPhaseCell label={t('scrape_label')} kind="scrape" result={item.scrape} />
            <PolicyPhaseCell label={t('summarise_label')} kind="summarise" result={item.summarise} />
          </div>
        ))}
      </div>

      {runDone && (
        <div className="policy-run-footer">
          <button type="button" className="btn btn-secondary" onClick={onViewDashboard}>
            {t('go_dashboard')}
          </button>
        </div>
      )}
    </div>
  );
}

function PolicyPhaseCell({ label, kind, result }: { label: string; kind: 'scrape' | 'summarise'; result: PolicyPhaseResult }) {
  const t = useTranslations('onboard.policy_run');
  const icon =
    result.status === 'pending' ? '○'
      : result.status === 'working' ? <span className="spinner-sm" />
        : result.status === 'done' ? '✓'
          : result.status === 'error' ? '✕'
            : '—';

  const verb =
    result.status === 'pending' ? t('verb_pending')
      : result.status === 'working' ? (kind === 'scrape' ? t('verb_fetching') : t('verb_summarising'))
        : result.status === 'done' ? t('verb_done')
          : result.status === 'error' ? t('verb_failed')
            : t('verb_skipped');

  let timing: string | null = null;
  if (result.startedAt) {
    const end = result.finishedAt ?? Date.now();
    const elapsed = end - result.startedAt;
    if (result.status === 'working') {
      timing = t('elapsed_suffix', { time: formatMs(elapsed) });
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

function SearchResultBlock({
  result,
  chosen,
  editing,
  developerHint,
  trackedByAppleId,
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
  onChoose: (candidate: AppCandidate | null) => void;
  /**
   * `force` lets the no-matches Retry button replay the *same* query — useful
   * after an iTunes 429 wiped out this block's candidates. Without it, the
   * parent's "nothing changed" guard would short-circuit the call.
   */
  onResearch: (nextQuery: string, nextDeveloper?: string, force?: boolean) => Promise<void> | void;
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
    ? result.candidates.some(c => c.appleId === chosen.appleId)
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
  const chosenTracked = chosen ? trackedByAppleId.get(chosen.appleId) : undefined;

  // Language for the toggle button. When a selection is confirmed, the "+X"
  // count describes "other" candidates so it stays honest.
  const t = useTranslations('onboard.search_block');
  const tPh = useTranslations('settings.placeholders');
  const otherCount = Math.max(0, result.candidates.length - 1);
  const moreLabel = chosen
    ? t('see_other_chosen', { count: otherCount })
    : t('see_other_unchosen', { count: otherCount });

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
    if (!next) return;
    if (!nameChanged && !devChanged) return;
    // Pass the seller draft through so the parent can push it into the
    // shared developerHints map and include it in the next /api/search.
    // Undefined = "leave hint alone"; we only send a value when the user
    // actually touched the field.
    await onResearch(next, devChanged ? nextDev : undefined);
  };

  return (
    <div className={`search-result-item ${chosen ? 'selected' : ''}`}>
      <div className="search-result-query-row">
        {isEditing ? (
          <div className="search-result-edit-fields">
            <label className="search-result-edit-field">
              <span className="search-result-edit-label">{t('edit_app_name')}</span>
              <input
                className="settings-input search-result-edit-input"
                value={draft}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void commitEdit();
                  if (event.key === 'Escape') cancelEdit();
                }}
                autoFocus
                spellCheck={false}
              />
            </label>
            <label className="search-result-edit-field">
              <span className="search-result-edit-label">
                {t('edit_seller')}{' '}
                <span className="search-result-edit-hint">
                  {developerHint
                    ? t('edit_seller_csv')
                    : t('edit_seller_optional')}
                </span>
              </span>
              <input
                className="settings-input search-result-edit-input"
                value={draftDeveloper}
                placeholder={developerHint || tPh('developer_eg')}
                onChange={event => setDraftDeveloper(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void commitEdit();
                  if (event.key === 'Escape') cancelEdit();
                }}
                spellCheck={false}
              />
            </label>
            <div className="search-result-edit-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void commitEdit()}
                disabled={editing}
              >
                {editing ? <><span className="spinner-sm" /> {t('researching')}</> : t('research')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={cancelEdit}
                disabled={editing}
              >
                {t('cancel')}
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
              <div className="search-result-query">&ldquo;{result.query}&rdquo;</div>
              {(chosen || chosenTracked || (developerHint && !chosen)) && (
                <div className="search-result-query-pills">
                  {chosen && (
                    <span
                      className="search-result-confirmed"
                      title={t('confirmed_title', { name: chosen.name, dev: chosen.developer })}
                    >
                      {t('confirmed')}
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
                      title={t('tracked_pill_title', { name: chosenTracked.name })}
                    >
                      {t('tracked_pill')}
                    </span>
                  )}
                  {developerHint && !chosen && (
                    <span
                      className="search-result-hint"
                      title={t('seller_chip_title')}
                    >
                      {t('seller_chip', { dev: developerHint })}
                    </span>
                  )}
                </div>
              )}
            </div>
            {/* Bottom sub-row: action buttons. On mobile this wraps
                under the title so the pill never gets crowded out. */}
            <div className="search-result-query-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={beginEdit}
                disabled={editing}
              >
                {t('edit_button')}
              </button>
              {chosen && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void onSkip()}
                  disabled={editing}
                >
                  {t('skip_this')}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {result.candidates.length === 0 ? (
        <div className="search-result-empty">
          <p className="search-result-empty-copy">
            {t('no_matches_lead')}
            {isEditing
              ? t('no_matches_editing')
              : t('no_matches_idle')}
          </p>
          {!isEditing && (
            <div className="search-result-empty-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void onResearch(result.query, undefined, true)}
                disabled={editing}
                title={t('retry_title')}
              >
                {editing ? <><span className="spinner-sm" /> {t('retry_busy')}</> : t('retry_search')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={beginEdit}
                disabled={editing}
              >
                {t('edit_name_seller')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void onSkip()}
                disabled={editing}
              >
                {t('skip_this')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {candidates.map(candidate => {
            const candidateTracked = trackedByAppleId.get(candidate.appleId);
            return (
              <div
                key={candidate.appleId}
                // The `tracked` modifier applies row-level styling (tint
                // + left border). The inline "Tracked" chip next to the
                // candidate name is back on top of that — removing it
                // made the selected-candidate case ambiguous when the
                // block-level "Re-sync App info" pill scrolled off-
                // screen on long lists, so the per-row chip earns its
                // keep even with some visual duplication.
                className={`candidate-row ${chosen?.appleId === candidate.appleId ? 'chosen' : ''} ${candidateTracked ? 'tracked' : ''}`}
                onClick={() => onChoose(chosen?.appleId === candidate.appleId ? null : candidate)}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    border: `2px solid ${chosen?.appleId === candidate.appleId ? 'var(--blue)' : 'var(--border-strong)'}`,
                    background: chosen?.appleId === candidate.appleId ? 'var(--blue)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    color: '#fff',
                    flexShrink: 0,
                    transition: 'all 0.15s',
                  }}
                >
                  {chosen?.appleId === candidate.appleId ? '✓' : ''}
                </span>

                {candidate.iconUrl && (
                  <Image
                    src={candidate.iconUrl}
                    alt={candidate.name}
                    width={40}
                    height={40}
                    className="candidate-icon"
                    unoptimized
                    style={{ objectFit: 'cover' }}
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
                      <span className="candidate-tracked-chip" aria-label={t('candidate_tracking_aria')}>
                        {t('candidate_tracking_chip')}
                      </span>
                    )}
                  </div>
                  <div className="candidate-dev">{candidate.developer}</div>
                </div>
              </div>
            );
          })}

          {result.candidates.length > 1 && (
            <button className="show-more-btn" onClick={() => setShowAll(!showAll)}>
              {showAll ? t('show_less') : moreLabel}
            </button>
          )}
        </>
      )}
    </div>
  );
}

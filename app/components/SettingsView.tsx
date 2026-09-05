"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDateFormat } from "../../lib/date-format-hook";
import { useFlag } from "../../lib/feature-flags-hooks";
import { scrollPulse } from "../../lib/scroll-pulse";
import { TOAST_HOLD_MS } from "../../lib/toast-timing";
import { useAiSettings } from "../../lib/use-ai-settings";
import { useBackup } from "../../lib/use-backup";
import { useDeployment } from "../../lib/use-deployment";
import { useImportHistory } from "../../lib/use-import-history";
import { useModalFocus } from "../../lib/use-modal-focus";
import { useProfiles } from "../../lib/use-profiles";
import { useRovingRadioGroup } from "../../lib/use-roving-radiogroup";
import { useSettingsAutoSave } from "../../lib/use-settings-auto-save";
import { useWayback } from "../../lib/use-wayback";
import DateFormatPicker from "./DateFormatPicker";
import { useImportQueue } from "./ImportQueueProvider";
import SettingsAutoSaveToast, {
  pushSettingsToast,
} from "./SettingsAutoSaveToast";
import SettingsSidebar from "./SettingsSidebar";
import AccessibilityLabelsSection from "./settings/AccessibilityLabelsSection";
import AiSummariesSection from "./settings/AiSummariesSection";
import BackupSection from "./settings/BackupSection";
import DeleteImportModal from "./settings/DeleteImportModal";
import DeploymentDiagnosticsSection from "./settings/DeploymentDiagnosticsSection";
import DeveloperSection from "./settings/DeveloperSection";
import ExportDataSection from "./settings/ExportDataSection";
import ImportHistoryLinkCard from "./settings/ImportHistoryLinkCard";
import ImportHistorySection from "./settings/ImportHistorySection";
import LanguageSection from "./settings/LanguageSection";
import NotificationPrefsSection from "./settings/NotificationPrefsSection";
import PolicyAlertsSection from "./settings/PolicyAlertsSection";
import PolicyScrapeKillSwitchSection from "./settings/PolicyScrapeKillSwitchSection";
import PolicyScrapeThrottleSection from "./settings/PolicyScrapeThrottleSection";
import PrivacyPoliciesBulkSection from "./settings/PrivacyPoliciesBulkSection";
import RegionSection from "./settings/RegionSection";
import RemoveItemModal from "./settings/RemoveItemModal";
import ResetAppModal from "./settings/ResetAppModal";
import ResetSection from "./settings/ResetSection";
import RestoreBackupModal from "./settings/RestoreBackupModal";
import ReviewQueuePrefsSection from "./settings/ReviewQueuePrefsSection";
import SyncScheduleSection from "./settings/SyncScheduleSection";
import SyncStatusSection from "./settings/SyncStatusSection";
import type { SettingsGroup } from "./settings/section-groups";
import type { Schedule, StoredAiSettings, SyncStatus } from "./settings/types";
import WaybackImportSection from "./settings/WaybackImportSection";
import WaybackRemoveModal from "./settings/WaybackRemoveModal";
import { useTaskCenter } from "./TaskCenter";
import Toast from "./Toast";

/**
 * localStorage key for the "Also log save events to Task Center"
 * preference. Per-browser toggle (not synced server-side) — it's a
 * UX nicety, not a data setting, so a localStorage round-trip is
 * the right scope. Read on mount, written when the user flips the
 * toggle.
 */
const AUTOSAVE_LOG_KEY = "settings-autosave-log-to-taskcenter";

import { sanitizeA11yProfile } from "../../lib/accessibility-profile";
import {
  normalizeAiProvider,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
} from "../../lib/ai-config";
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
  type NotificationTypeKey,
  resolvePrefs as resolveNotificationPrefs,
  sanitizePrefs as sanitizeNotificationPrefs,
} from "../../lib/notification-prefs";
import { sanitizeProfile } from "../../lib/privacy-profile";
import {
  COUNTRY_OPTIONS,
  DEFAULT_COUNTRY,
  normalizeCountry,
} from "../../lib/region";
import AccessibilityProfileEditor from "./AccessibilityProfileEditor";
// Intent picker state is gone — see the comment by `loadPreferences`
// for context. The exports are kept in `lib/preferences.ts` for any
// other consumer (e.g. the welcome splash) but Settings no longer
// needs them.
import PrivacyProfileEditor from "./PrivacyProfileEditor";

type BulkPhaseT = (key: string) => string;

function describeBulkPhase(
  t: BulkPhaseT,
  phase: string | undefined | null,
  note?: string
): string {
  if (!phase) {
    return t("working");
  }
  const base = (() => {
    switch (phase) {
      case "fetching":
        return t("fetching");
      case "fetch":
        return t("fetching");
      case "parse":
        return t("parse");
      case "archive":
        return t("archive");
      case "archive-existing":
        return t("archive_existing");
      case "summarise":
        return t("summarise");
      case "chunk":
        return t("chunk");
      case "chunk_summarise":
        return t("chunk_summarise");
      case "ai-direct":
        return t("summarise");
      case "ai-chunked":
        return t("chunk");
      case "merge":
        return t("merge");
      case "persist":
        return t("persist");
      case "throttled":
        return t("throttled");
      case "same":
        return t("same");
      case "cache-hit":
        return t("cache_hit");
      case "skip":
        return t("skip");
      case "needs-config":
        return t("needs_config");
      case "changelog":
        return t("changelog");
      case "version-store":
        return t("version_store");
      case "ready":
        return t("ready");
      default:
        return phase.replace(/_/g, " ");
    }
  })();
  if (note) {
    return `${base} — ${note}`.slice(0, 120);
  }
  return `${base}…`;
}

/**
 * `viewMode` lets the Settings page reuse SettingsView for the dedicated
 * /dashboard/settings/import-history sub-page without duplicating the
 * state machine. `'all'` (the default) renders the full settings screen;
 * `'import-history'` renders just the Import History section with a
 * "← Back to Settings" header so the nested page feels self-contained.
 *
 * Every state hook and handler below is still declared unconditionally
 * so React's hook order is stable across both modes — the cost of the
 * extra state in import-history mode is negligible compared to the
 * complexity a separate extracted component would introduce.
 */
interface SettingsViewProps {
  /**
   * Server-rendered Your Focus card (round 3 PR 3). Slots in at the top of
   * the settings stack above the legacy "Your Focus" radio picker. The
   * legacy picker stays in place during PR 3 — PR 5 removes it once the
   * Adjust flow is wired end-to-end. Passed in from the server-component
   * page so we can keep its DB read out of this client bundle.
   */
  focusCard?: React.ReactNode;
  /** Which slice of Settings to render. "all" is the landing page;
   *  "import-history" is its own route; the four group values back the
   *  per-group routes derived from SettingsSidebar's SECTION_GROUPS. */
  viewMode?: "all" | "import-history" | SettingsGroup;
}

export default function SettingsView({
  viewMode = "all",
  focusCard,
}: SettingsViewProps = {}) {
  // A group renders when the page is the full landing view, or when it is
  // that group's own route. Keeping the gate here rather than in each
  // section means the route split does not have to touch the sections.
  const showGroup = (group: SettingsGroup) =>
    viewMode === "all" || viewMode === group;

  const router = useRouter();
  const searchParams = useSearchParams();
  const taskCenter = useTaskCenter();
  // Settings → Appearance → Date format. Threaded into every
  // `fmtShortDate(...)` call below so the import-history list, the
  // backup-restore preview, and the delete-confirmation modal all
  // render dates in the user's chosen format.
  const dateMode = useDateFormat();

  /**
   * Per-browser toggle for "Also log save events to Task Center"
   * (deselected by default). When on, every settings auto-save toast
   * also writes a synthetic Task Center entry so the user has a
   * persistent audit trail of what changed and when. Stored in
   * localStorage rather than app_settings because it's a UX
   * preference per machine/browser, not a data setting.
   */
  const [autosaveLogToTaskCenter, setAutosaveLogToTaskCenter] = useState(false);
  useEffect(() => {
    try {
      setAutosaveLogToTaskCenter(
        localStorage.getItem(AUTOSAVE_LOG_KEY) === "true"
      );
    } catch {
      // localStorage may be unavailable in private mode — default off.
    }
  }, []);
  const onAutosaveLogToggle = (next: boolean) => {
    setAutosaveLogToTaskCenter(next);
    try {
      localStorage.setItem(AUTOSAVE_LOG_KEY, next ? "true" : "false");
    } catch {
      // Ignore — the in-memory state is enough to make the toggle feel
      // responsive even if persistence isn't available.
    }
  };

  // i18n: SettingsView is the largest single component (~7000 lines).
  // First extraction pass covers the section titles + most-prominent
  // aria-labels and placeholders. Inline copy + dev-options details
  // remain English for v1.x; tracked under the misc-extraction task.
  const tSettings = useTranslations("settings");
  const tSections = useTranslations("settings.sections");
  const tBulkPhase = useTranslations("settings.bulk_phase");
  const tBulkStream = useTranslations("settings.bulk_stream");
  // Per-section subtitle copy + the App Store Region card's controls
  // + the accessibility-labels card's checkbox copy. Pulled out of the
  // root `tSettings` so the call-sites in the JSX read short.
  const tSub = useTranslations("settings.subtitles");
  const tRegion = useTranslations("settings.region");
  const tA11yLabels = useTranslations("settings.accessibility_labels_card");
  const tReviewQueueSettings = useTranslations("settings.review_queue_card");
  const tSyncStatus = useTranslations("settings.sync_status");
  const tPolicyCard = useTranslations("settings.privacy_policies_card");
  const tNotifPrefsCard = useTranslations("settings.notification_prefs_card");
  const tSchedule = useTranslations("settings.schedule");
  const tAiProvider = useTranslations("settings.ai.provider");
  const tAiSample = useTranslations("settings.ai.sample");
  // Developer Options: the panels own their own namespaces now, but the
  // AI-timeout auto-save toasts are wired up here, so this one stays.
  const tDevAiTimeouts = useTranslations("settings.dev_options.ai_timeouts");
  // Bottom-of-page modals — restore backup, delete import, remove app.
  // Their reset/wayback siblings already live under settings.* and so
  // do these for symmetry.
  // Privacy & Accessibility profile cards — toggle hint, Save button,
  // saved-count summary, unsaved/empty hints.
  const tPrivProfile = useTranslations("settings.privacy_profile_card");
  const tA11yProfile = useTranslations("settings.accessibility_profile_card");
  // Inline Ollama bootstrapping help under the AI provider picker. Only
  // shown when provider === 'custom'; uses rich() for the inline <code>,
  // <strong>, <em> tags scattered through the long-form copy.
  // Policy Change Alerts + Policy Scrape Throttle cards.
  const tPolicyAlerts = useTranslations("settings.policy_alerts");
  const tPolicyThrottle = useTranslations("settings.policy_throttle");
  // Toast messages + compact time formatters. The time helpers (fmt*)
  // were refactored to take a translator argument; tToast routes the
  // showToast() call sites through next-intl.
  const tToast = useTranslations("settings.toasts");
  const tAria = useTranslations("settings.aria");
  // Per-row notification-preference labels + descriptions + example
  // hints. The seven preference keys map onto snake_case translation
  // keys via a regex inside the loop below.

  // Wave I: settings-card flags. Each card section in this view is gated
  // by exactly one flag so a profile can hide just the noisy bits without
  // gutting Settings entirely. The whole-page kill switch is the top-level
  // `flag.devopts.feature_flag_system.enabled` — these are the per-card
  // refinements layered on top. All default on; only the audit-bundle
  // and audit-PDF exports default off.
  const settingsSyncScheduleOn =
    useFlag("flag.settings.sync.schedule") === "on";
  const settingsSyncRegionOn = useFlag("flag.settings.sync.region") === "on";
  const settingsAiEnabledOn = useFlag("flag.settings.ai.enabled") === "on";
  const settingsPoliciesThrottleOn =
    useFlag("flag.settings.policies.throttle") === "on";
  const settingsPoliciesWaybackOn =
    useFlag("flag.settings.policies.wayback_import") === "on";
  const settingsNotificationsPrefsOn =
    useFlag("flag.settings.notifications.prefs") === "on";
  const settingsProfilesPrivacyOn =
    useFlag("flag.settings.profiles.privacy") === "on";
  const settingsProfilesAccessibilityOn =
    useFlag("flag.settings.profiles.accessibility") === "on";
  const settingsImportHistoryOn =
    useFlag("flag.settings.import.history") === "on";
  const settingsAdminBackupOn = useFlag("flag.settings.admin.backup") === "on";
  const settingsAdminExportOn = useFlag("flag.settings.admin.export") === "on";
  // The audit-bundle export gate (`flag.settings.admin.export.audit_bundle`)
  // is resolved INSIDE AuditBundleExport itself rather than here. The
  // client-side useFlag cache isn't bootstrapped from server state on
  // fresh page loads — it returns the hard default until an override
  // mutation fires — so flags whose default differs from their resolved
  // value (this one is 'off' by default and 'on' for loved_one) need a
  // client-side `/api/feature-flags` probe to read their real state.
  const settingsAdminResetOn = useFlag("flag.settings.admin.reset") === "on";
  const settingsAdminStartOverOn =
    useFlag("flag.settings.admin.start_over") === "on";
  // Wave I: top-level gate for the entire Developer Options section.
  // Mirrors the SettingsSidebar gate so the section disappears from
  // both the link rail and the rendered page in lockstep.
  const devOptsVisible = useFlag("flag.devopts.visible") === "on";
  // Wave I: Tauri-only "Desktop app" section. Off in the web build
  // (which is the only build today); the resolver-environment cascade
  // turns it on inside the desktop wrapper. Wiring it now means an
  // explicit override surfaces a placeholder so the gate is exercised
  // end-to-end.
  const desktopAppSectionOn = useFlag("flag.desktop.app_section") === "on";

  // Wave I: PDF audit-bundle export. The button below appears only when
  // its flag resolves on; default is off and the rule table doesn't
  // elevate it on any focus today. Wiring it now means a user with an
  // explicit `on` override sees the placeholder so the rendering path
  // is exercised.
  const settingsAdminExportAuditPdfOn =
    useFlag("flag.settings.admin.export.audit_pdf") === "on";
  // Wave I: per-user date-format override (auto / 24h / 12h). Off by
  // default; when on the user sees a small select inside the focus
  // card to override the locale-driven default (the actual preference
  // value persists via app_settings.date_format_preference).
  const settingsDateFormatPrefOn =
    useFlag("flag.settings.date_format.user_preference") === "on";
  // Focus card on Settings — driven separately from the per-page focus
  // surface so admins can hide the picker without disabling the focus
  // system itself.
  const settingsFocusPickerOn = useFlag("flag.settings.focus.picker") === "on";
  // Server-side import queue (for Apple 429 rate-limited items). We read the
  // global snapshot here so the Import History section can surface a banner
  // "Retry queue now" control + per-row retry countdowns without each row
  // re-polling its own status.
  const importQueue = useImportQueue();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [schedule, setSchedule] = useState<Schedule>("manual");
  // APG keyboard contract for the sync-schedule radiogroup: one tab
  // stop, arrows move focus only — the cards auto-save a POST on
  // selection, so Enter/Space commits instead of every arrow press.
  const scheduleRadioKeyDown = useRovingRadioGroup({ followFocus: false });
  const [country, setCountry] = useState<string>(DEFAULT_COUNTRY);
  const [savedCountry, setSavedCountry] = useState<string>(DEFAULT_COUNTRY);
  /**
   * After a successful region save, we may suggest a UI-language switch
   * if the storefront's expected language differs from the active
   * locale (cn → zh, anything-else → en when active is zh). Stored as
   * the *target* locale so the banner knows which direction to render.
   * `null` hides the banner. Resolution lives in saveCountry.
   */
  const [languageSuggestion, setLanguageSuggestion] = useState<
    "zh" | "en" | null
  >(null);
  // timeouts inputs stay out of the way. We auto-open it when the page is
  // opened with hash #ai-timeouts — that's what the bell notification deep
  // link uses when an AI call aborts mid-summary.
  const [advancedAiOpen, setAdvancedAiOpen] = useState(false);
  // Alert window (days) for the AI Policy tab's "policy changed recently"
  // banner. 0 disables the banner. Kept as a string in local state so the
  // input handles typing "" mid-edit without flipping to NaN.
  const [policyDiffAlertDays, setPolicyDiffAlertDays] = useState<string>("90");
  // Saving flag now lives on `policyDiffAlertDaysAutoSave.saving`.
  // Per-app scrape-throttle controls. The backend default is 60 minutes,
  // enabled. Kept as a string for the same reason as the alert window — the
  // number input needs to tolerate "" mid-edit without flipping to NaN.
  const [scrapeThrottleEnabled, setScrapeThrottleEnabled] =
    useState<boolean>(true);
  // Global kill-switch for policy scraping. When `true`, every fetch
  // path short-circuits and the manual sync buttons go inert. Separate
  // from the throttle (which just rate-limits) so users can stop all
  // background policy activity without flipping AI provider config.
  const [scrapeDisabled, setScrapeDisabled] = useState<boolean>(false);
  const [scrapeThrottleMinutes, setScrapeThrottleMinutes] =
    useState<string>("60");
  // Bulk "Privacy Policies" section. `policyBulkRunning` tracks the client-side
  // inflight state separate from the server-side mutex so we can disable both
  // buttons without another round-trip, and the forceBypassThrottle checkbox
  // drives the `force` flag on `POST /api/policy/sync-all`.
  const [policyBulkRunning, setPolicyBulkRunning] = useState<
    null | "fetch" | "all"
  >(null);
  const [policyBulkForce, setPolicyBulkForce] = useState(false);
  const [policyBulkSummary, setPolicyBulkSummary] = useState<string | null>(
    null
  );
  // Review-queue progress bar toggle. Defaults true; users can mute the
  // bar if they prefer the carousel chrome stripped back. Persisted in
  // app_settings under `queue_show_progress_bar` and read server-side
  // by /dashboard/apps/page.tsx.
  const [queueShowProgressBar, setQueueShowProgressBar] = useState(true);
  const [savedQueueShowProgressBar, setSavedQueueShowProgressBar] =
    useState(true);
  // The "is this toggle saving" flag now lives on `trackAccessibilityAutoSave.saving`.
  const [toast, setToast] = useState("");
  const [resetStep, setResetStep] = useState<0 | 1 | 2>(0);
  const [resetting, setResetting] = useState(false);

  // The legacy `userIntent` state used to drive a duplicate Your-Focus
  // radio group below. The card at the top of Settings (YourFocusCard
  // → /dashboard/settings/focus) replaces it; the state plumbing was
  // removed in the same pass that deleted the duplicate JSX. The
  // `/api/preferences` endpoint still exists for any other consumer
  // that reads the field, but Settings no longer reads or writes it.

  // Note: we don't render a dedicated "Restored …" flash here. The undo
  // path replays through privacyProfileAutoSave.save() / a11yProfileAutoSave.save()
  // which already surfaces a "Privacy profile saved" toast via the
  // TaskCenter. The user-visible "the panel just changed" signal is the
  // auto-save toast plus the picker chips snapping to the restored
  // values; an additional flash would be belt-and-braces noise.

  // Accessibility-profile saving flag now lives on `a11yProfileAutoSave.saving`.

  // Notification preferences — per-type on/off toggles for the bell. The
  // working copy is a fully-resolved map (every known key has a boolean) so
  // the rendering code never has to worry about defaults vs. overrides.
  // `savedNotificationPrefs` mirrors the resolved shape the server last
  // confirmed, used only to gate the "Save" button.
  const [notificationPrefs, setNotificationPrefs] = useState<
    Record<NotificationTypeKey, boolean>
  >({ ...DEFAULT_NOTIFICATION_PREFS });
  const [savedNotificationPrefs, setSavedNotificationPrefs] = useState<
    Record<NotificationTypeKey, boolean>
  >({ ...DEFAULT_NOTIFICATION_PREFS });
  // Notification-prefs save state lives on `notificationPrefsAutoSave.saving`
  // post-renovation (the Save button is gone; the Reset Defaults button
  // reads the hook directly).

  // Manual sync-in-flight flag for the Sync Status card's button.
  const [syncing, setSyncing] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), TOAST_HOLD_MS);
  };

  // Backup & Restore — export, three-phase restore, snapshots and the
  // restore modal focus live in lib/use-backup.ts.
  const {
    exportingBackup,
    restoreStage,
    restorePreview,
    pendingRestoreFilename,
    restoreError,
    setRestoreError,
    restoreConfirmText,
    setRestoreConfirmText,
    backupSnapshotSettings,
    setBackupSnapshotSettings,
    backupSnapshotDirectory,
    backupSnapshots,
    creatingBackupSnapshot,
    loadBackupSnapshots,
    handleCreateBackupSnapshot,
    backupSnapshotsAutoSave,
    saveBackupSnapshots,
    handleExportBackup,
    resetRestoreFlow,
    handleRestoreFileChosen,
    handleRestoreConfirm,
    restoreModalRef,
  } = useBackup({ showToast });

  // Deployment diagnostics + session admin token live in
  // lib/use-deployment.ts; the unlock flow re-pulls the backup list
  // through the loader handed in here.
  const {
    deploymentDiagnostics,
    deploymentDiagnosticsLoading,
    deploymentDiagnosticsError,
    deploymentDiagnosticsLocked,
    copyingDeploymentDiagnostics,
    adminTokenInput,
    setAdminTokenInput,
    adminTokenUnlocked,
    adminTokenConfigured,
    loadDeploymentDiagnostics,
    saveSessionAdminToken,
    clearSessionAdminToken,
    copyDeploymentSupportBundle,
  } = useDeployment({ showToast, loadBackupSnapshots });

  // Privacy + accessibility profiles — state, auto-saves, undo stack
  // and loaders live in lib/use-profiles.ts.
  const {
    profileEnabled,
    setProfileEnabled,
    profile,
    setProfile,
    savedProfile,
    a11yProfileEnabled,
    setA11yProfileEnabled,
    a11yProfile,
    setA11yProfile,
    savedA11yProfile,
    privacyProfileAutoSave,
    runPrivacyProfileSave,
    privacyProfileSaveTimer,
    schedulePrivacyProfileSave,
    a11yProfileAutoSave,
    runA11yProfileSave,
    scheduleA11yProfileSave,
  } = useProfiles({ router });

  // Wayback bulk import — run/stream state, controls, purge flow and
  // the show-imported toggle all live in lib/use-wayback.ts.
  const {
    hydrateShowImported,
    waybackRunning,
    waybackRunStatus,
    waybackControlBusy,
    waybackRemoving,
    waybackRemoveOpen,
    setWaybackRemoveOpen,
    waybackSummary,
    waybackShowImported,
    trackAccessibility,
    setTrackAccessibility,
    savedTrackAccessibility,
    setSavedTrackAccessibility,
    waybackProgress,
    waybackInitiator,
    waybackLastRun,
    runBulkWaybackImport,
    controlWaybackImport,
    closeWaybackRemoveModal,
    removeAllWaybackHistory,
    waybackToggleAutoSave,
    saveWaybackShowImported,
    waybackRemoveModalRef,
  } = useWayback({ showToast, taskCenter });

  // Import History — list, filters, queue drain, retries, change-match
  // and the two delete flows. `deleteTarget` comes back out because the
  // confirm modal renders as a page-level overlay at the bottom of this
  // file rather than inside the section.
  const ih = useImportHistory({
    importQueue,
    router,
    searchParams,
    showToast,
    tToast,
  });
  const {
    deleteTarget,
    setDeleteTarget,
    deleting,
    removingItemId,
    pendingItemRemoval,
    setPendingItemRemoval,
    loadImports,
    confirmRemoveItemFromDashboard,
    confirmDeleteImport,
  } = ih;

  const loadStatus = async () => {
    const res = await fetch("/api/sync/status");
    const data = await res.json();
    setStatus(data);
    setSchedule(data.schedule ?? "manual");
  };

  // The legacy `handleSaveBackupSnapshotSettings` writer is gone —
  // the three fields auto-save via `backupSnapshotsAutoSave` /
  // `saveBackupSnapshots` defined later in this component.

  const loadSettings = async () => {
    const res = await fetch("/api/settings");
    const data = await res.json();
    const provider = normalizeAiProvider(data.ai_provider ?? "disabled");
    // The API masks the raw key as "__SET__" — we never round-trip the real
    // key through the browser. When the user leaves the input alone, we
    // submit "__SET__" back, which the server ignores (keeping the key
    // intact). Typing a new value overrides it.
    const maskedKey =
      data.ai_api_key === "__SET__" ? "__SET__" : (data.ai_api_key ?? "");
    const nextAi: StoredAiSettings = {
      provider,
      apiKey: maskedKey,
      baseUrl:
        provider === "disabled"
          ? ""
          : (data.ai_base_url ?? "") || resolveDefaultBaseUrl(provider),
      model:
        provider === "disabled"
          ? ""
          : (data.ai_model ?? "") || resolveDefaultModel(provider),
      summarizeOnImport: data.ai_summarize_on_import === "true",
      debugLogging: data.ai_debug_logging === "true",
      timeoutDirectMs: String(data.ai_timeout_direct_ms ?? ""),
      timeoutChunkMs: String(data.ai_timeout_chunk_ms ?? ""),
      timeoutMergeMs: String(data.ai_timeout_merge_ms ?? ""),
    };

    hydrate(nextAi);

    // Hydrate the policy-diff alert window. Server default is "90"; keep
    // the input in sync even when the API returns a different stored value.
    const rawAlert = String(data.policy_diff_alert_days ?? "90");
    const parsedAlert = Number.parseInt(rawAlert, 10);
    setPolicyDiffAlertDays(
      Number.isFinite(parsedAlert) && parsedAlert >= 0
        ? String(parsedAlert)
        : "90"
    );

    // Hydrate the scrape-throttle controls. The backend emits the enabled
    // flag as a boolean (not a string), and the minutes as a stringified
    // integer. Fall back to the defaults (enabled, 60) whenever either is
    // missing so a fresh install lands in a sensible place.
    const enabledRaw = data.policy_scrape_throttle_enabled;
    setScrapeThrottleEnabled(enabledRaw === undefined ? true : !!enabledRaw);
    const rawMinutes = String(data.policy_scrape_throttle_minutes ?? "60");
    const parsedMinutes = Number.parseInt(rawMinutes, 10);
    setScrapeThrottleMinutes(
      Number.isFinite(parsedMinutes) && parsedMinutes >= 0
        ? String(parsedMinutes)
        : "60"
    );
    // Hydrate the global "disable policy scraping" kill-switch. Defaults
    // to false (scraping enabled) so existing installs continue working.
    const disabledRaw = data.policy_scrape_disabled;
    setScrapeDisabled(disabledRaw === undefined ? false : !!disabledRaw);

    const nextCountry = normalizeCountry(data.app_country ?? DEFAULT_COUNTRY);
    setCountry(nextCountry);
    setSavedCountry(nextCountry);

    // Hydrate the Wayback "show imported history" toggle. Defaults to `true`
    // when the setting is missing so installations that predate the feature
    // still see imported rows after a bulk run.
    const rawShow = data.wayback_show_imported;
    const nextShow = rawShow === undefined ? true : !!rawShow;
    hydrateShowImported(nextShow);

    // Hydrate the accessibility-labels UI toggle. Defaults to `true` so the
    // feature is discoverable on first run; users can still opt out here.
    const rawAccess = data.track_accessibility_labels;
    const nextAccess = rawAccess === undefined ? true : !!rawAccess;
    setTrackAccessibility(nextAccess);
    setSavedTrackAccessibility(nextAccess);

    // Review-queue progress bar toggle.
    const rawQueueBar = data.queue_show_progress_bar;
    const nextQueueBar = rawQueueBar === undefined ? true : !!rawQueueBar;
    setQueueShowProgressBar(nextQueueBar);
    setSavedQueueShowProgressBar(nextQueueBar);
  };

  // AI Summaries — provider form, connection test, model discovery,
  // sample run, per-phase timeouts and the debounced blob auto-save.
  // Renamed back on destructure so the JSX below is untouched by this
  // commit; the markup moves next.
  const ai = useAiSettings({
    loadSettings,
    tAiProvider,
    tAiSample,
    tDevAiTimeouts,
    taskCenter,
  });
  const {
    hydrate,
    aiProvider,
    debugLogging,
    setDebugLogging,
    aiTimeoutDirectMs,
    setAiTimeoutDirectMs,
    aiTimeoutChunkMs,
    setAiTimeoutChunkMs,
    aiTimeoutMergeMs,
    setAiTimeoutMergeMs,
    aiTimeoutDirectAutoSave,
    aiTimeoutChunkAutoSave,
    aiTimeoutMergeAutoSave,
    saveAiSettings,
  } = ai;

  /**
   * Fetch the user's archetype from the welcome splash. Lives behind its own
   * endpoint so we don't pollute /api/settings with UI preferences.
   */
  const loadPreferences = async () => {
    // Was: read `/api/preferences.userIntent` to seed the legacy
    // Your-Focus radio group. That picker has been removed in favour
    // of YourFocusCard / FocusEditForm, which read the new audience +
    // goals tables directly. Kept as a no-op so the existing call
    // sites stay valid; remove entirely once we're confident no other
    // surface needs preference loading at this scope.
  };

  /**
   * Pull the saved notification preferences. The API always returns the
   * fully-resolved shape (every known type has a boolean), so the UI can
   * render toggles directly without worrying about defaults.
   */
  const loadNotificationPrefs = async () => {
    try {
      const res = await fetch("/api/notification-prefs");
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      const resolved =
        data?.prefs && typeof data.prefs === "object" ? data.prefs : null;
      if (resolved) {
        // Trust but verify — merge again locally in case the server is ahead
        // of the client's NOTIFICATION_TYPE_KEYS list on a partial deploy.
        const merged = resolveNotificationPrefs(resolved as NotificationPrefs);
        setNotificationPrefs(merged);
        setSavedNotificationPrefs(merged);
      }
    } catch (error) {
      console.warn("[settings] loadNotificationPrefs failed:", error);
    }
  };

  /**
   * Auto-save hook for notification preferences. PUTs the full sanitized
   * prefs map to `/api/notification-prefs` (sparse diffs aren't supported
   * by the route — server stores the explicit choices wholesale). We
   * always send what the user sees, so "what's on disk" matches "what's
   * in the UI".
   *
   * `onSaved` advances the savedNotificationPrefs watermark using the
   * server's resolved response if available, otherwise the payload we
   * sent. That keeps the "up to date" pill accurate and the diff-based
   * debounce check below correct.
   */
  const notificationPrefsAutoSave = useSettingsAutoSave<NotificationPrefs>({
    endpoint: "/api/notification-prefs",
    method: "PUT",
    buildBody: (value) => ({ prefs: sanitizeNotificationPrefs(value) }),
    successMessage: tNotifPrefsCard("toast_saved"),
    taskLabel: tNotifPrefsCard("task_label_saved"),
    onSaved: (value, response) => {
      const fromResponse = (response as { prefs?: NotificationPrefs } | null)
        ?.prefs;
      const resolved = fromResponse
        ? resolveNotificationPrefs(fromResponse)
        : resolveNotificationPrefs(sanitizeNotificationPrefs(value));
      setNotificationPrefs(resolved);
      setSavedNotificationPrefs(resolved);
    },
  });

  /**
   * Debounce window for notification-pref checkbox flips. Multiple
   * toggles within 400 ms collapse into a single PUT — the user
   * experience is "click click click → one toast" rather than
   * three cascading toasts and three round-trips.
   */
  const notificationPrefsSaveTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const scheduleNotificationPrefsSave = useCallback(
    (next: NotificationPrefs) => {
      if (notificationPrefsSaveTimer.current) {
        clearTimeout(notificationPrefsSaveTimer.current);
      }
      notificationPrefsSaveTimer.current = setTimeout(() => {
        notificationPrefsSaveTimer.current = null;
        void notificationPrefsAutoSave.save(next);
      }, 400);
    },
    [notificationPrefsAutoSave]
  );
  // Cancel any pending save on unmount so we don't fire after the
  // component is gone.
  useEffect(
    () => () => {
      if (notificationPrefsSaveTimer.current) {
        clearTimeout(notificationPrefsSaveTimer.current);
        notificationPrefsSaveTimer.current = null;
      }
    },
    []
  );

  useEffect(
    () => () => {
      if (privacyProfileSaveTimer.current) {
        clearTimeout(privacyProfileSaveTimer.current);
        privacyProfileSaveTimer.current = null;
      }
    },
    []
  );

  // ───────────────────────────────────────────────────────────────────
  // Throttle + AI-timeout numeric inputs — Section 6 of the renovation.
  //
  // Strategy: validate-then-save-on-blur. Numeric inputs commonly carry
  // mid-edit invalid states ("4" → "42" → "4200" → "42000") so saving
  // per keystroke would either fire 5 invalid POSTs or constantly toast
  // "invalid". Blur is the right semantic: "I'm done typing this value".
  //
  // Each hook owns its own validator that returns a string error (shown
  // inline under the input) or null (pass). On success the hook re-runs
  // any side effects via onSaved.
  // ───────────────────────────────────────────────────────────────────

  /**
   * Privacy-policy "alert me when a tracked policy hasn't been
   * re-summarised in N days" cooldown. 0 disables the alert; the route
   * accepts any int from 0..3650 (≈ 10 years).
   */
  const policyDiffAlertDaysAutoSave = useSettingsAutoSave<number>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ policy_diff_alert_days: value }),
    successMessage: (value) =>
      value === 0
        ? tPolicyAlerts("toast_disabled")
        : tPolicyAlerts("toast_set", { days: value }),
    taskLabel: (value) => tPolicyAlerts("task_label", { days: value }),
    onSaved: (value) => {
      // Re-baseline the input so the user sees the canonical integer
      // form (no leading zeros, etc.).
      setPolicyDiffAlertDays(String(value));
    },
  });

  /**
   * Helper that parses + validates the policy-diff-alert input on blur.
   * Empty / NaN / out-of-range strings are flagged via the hook's
   * `error` (rendered inline under the field). Within-range integers
   * fire the POST.
   */
  const handlePolicyDiffAlertBlur = useCallback(() => {
    const trimmed = policyDiffAlertDays.trim();
    if (trimmed === "") {
      return; // empty is "no change"; let user keep typing
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 3650) {
      // Push an explicit error toast since we don't have a place under
      // this input for inline errors yet (the JSX is dense).
      pushSettingsToast({
        kind: "error",
        message: tPolicyAlerts("invalid_range"),
      });
      return;
    }
    void policyDiffAlertDaysAutoSave.save(parsed);
  }, [policyDiffAlertDays, policyDiffAlertDaysAutoSave]);

  /**
   * Policy scrape throttle. Two fields write together: an enabled
   * checkbox + a cooldown integer (0..10080 minutes = 7 days). The
   * route accepts both keys in one POST so we batch them.
   */
  const scrapeThrottleAutoSave = useSettingsAutoSave<{
    enabled: boolean;
    minutes: number;
  }>({
    endpoint: "/api/settings",
    buildBody: ({ enabled, minutes }) => ({
      policy_scrape_throttle_enabled: enabled,
      policy_scrape_throttle_minutes: minutes,
    }),
    successMessage: ({ enabled, minutes }) =>
      enabled
        ? minutes === 0
          ? tPolicyThrottle("toast_no_cooldown")
          : tPolicyThrottle("toast_set", { minutes })
        : tPolicyThrottle("toast_disabled"),
    taskLabel: ({ enabled, minutes }) =>
      enabled
        ? tPolicyThrottle("task_label_on", { minutes })
        : tPolicyThrottle("task_label_off"),
    onSaved: ({ minutes }) => setScrapeThrottleMinutes(String(minutes)),
  });

  /**
   * Global kill-switch for policy scraping. Persists a single boolean —
   * the server-side gate in `lib/privacy-policy.ts` reads it before
   * every fetch. Saves immediately on toggle.
   */
  const scrapeDisabledAutoSave = useSettingsAutoSave<{ disabled: boolean }>({
    endpoint: "/api/settings",
    buildBody: ({ disabled }) => ({ policy_scrape_disabled: disabled }),
    successMessage: ({ disabled }) =>
      disabled
        ? tPolicyThrottle("scrape_disabled_toast_on")
        : tPolicyThrottle("scrape_disabled_toast_off"),
    taskLabel: ({ disabled }) =>
      disabled
        ? tPolicyThrottle("scrape_disabled_task_label_on")
        : tPolicyThrottle("scrape_disabled_task_label_off"),
  });

  /** Compose the current scrape-throttle pair from React state and
   * fire a save. Used by both the checkbox onChange (immediate) and
   * the minutes-input onBlur (validated). */
  const saveScrapeThrottle = useCallback(
    (next: { enabled: boolean; minutes: number }) => {
      void scrapeThrottleAutoSave.save(next);
    },
    [scrapeThrottleAutoSave]
  );

  const handleScrapeThrottleBlur = useCallback(() => {
    const trimmed = scrapeThrottleMinutes.trim();
    if (trimmed === "") {
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_080) {
      pushSettingsToast({
        kind: "error",
        message: tPolicyThrottle("invalid_range"),
      });
      return;
    }
    saveScrapeThrottle({ enabled: scrapeThrottleEnabled, minutes: parsed });
  }, [scrapeThrottleMinutes, scrapeThrottleEnabled, saveScrapeThrottle]);

  /**
   * AI per-phase request timeouts (`direct`, `chunk`, `merge`). Each
   * is a millisecond integer or empty string — empty means "use server
   * default". We persist via /api/settings keys
   * `ai_timeout_{direct,chunk,merge}_ms` (route accepts strings; server
   * normalises to int or null).
   *
   * One hook per timeout so a tabbed-out direct field doesn't accidentally
   * resave a half-edited merge value. All three save on blur.
   */

  // The legacy `saveUserIntent` writer has been removed alongside the
  // duplicate Your-Focus picker. Focus changes now happen via
  // FocusEditForm at /dashboard/settings/focus, which writes to the
  // audience + goals storage modules directly.

  // ── Change-match / re-add inline widget ────────────────────────────────

  useEffect(() => {
    void Promise.all([
      loadStatus(),
      loadSettings(),
      loadImports(),
      loadPreferences(),
      loadNotificationPrefs(),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once effect
  }, []);

  // Auto-open the Developer Options → Advanced accordion when the page is
  // loaded with the #ai-timeouts hash. NotificationBell routes users here
  // when an AI call aborts mid-summary, and the hash is the target anchor
  // for the timeouts inputs. Also respond to hashchange so an in-page
  // re-navigation still opens the accordion.
  //
  // The same useEffect handles the `#ai-summaries` deep-link from the
  // /privacy-policy page — it scrolls the card into view and flashes it
  // with the same pulse animation as the Privacy Map cards. The pulse is
  // fired by toggling the `.settings-section-pulse` class (defined in
  // globals.css) via the shared scroll-pulse helper, which owns the
  // re-trigger / cleanup choreography.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let cancelPulse: (() => void) | null = null;
    const syncFromHash = () => {
      const hash = window.location.hash;
      if (hash === "#ai-timeouts") {
        setAdvancedAiOpen(true);
      }
      // Each hash that targets a section by id — scroll + flash. Apply
      // the same pulse animation the Privacy Map deep-links use so the
      // user can see WHERE on the page they landed.
      //
      // - #ai-summaries — flagged from /privacy-policy and the AI debug
      //   menu item.
      // - #developer / #dev-options — the Dev menu (Tauri shell) and
      //   the in-app `g f` shortcut both deep-link here. The DOM id is
      //   `#developer`; `#dev-options` is accepted as an alias so the
      //   menu entry and any older bookmarks still work.
      const sectionHashTargets: Record<string, string> = {
        "#ai-summaries": "ai-summaries",
        "#developer": "developer",
        "#dev-options": "developer",
      };
      const targetId = sectionHashTargets[hash];
      if (targetId) {
        const el = document.getElementById(targetId);
        if (!el) {
          return;
        }
        cancelPulse?.();
        cancelPulse = scrollPulse(el, {
          className: "settings-section-pulse",
          block: "start",
        });
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      // Without this, navigating away mid-pulse left the class-removal
      // timeout running against a detached node.
      cancelPulse?.();
    };
  }, []);

  /**
   * Auto-save hook for the Sync Schedule selector. Triggered the
   * moment a user clicks one of the three radio cards (manual / daily
   * / weekly) — no Save button. The Schedule value is the union
   * `'manual' | 'daily' | 'weekly'`, so no validation needed; the
   * type narrows for us.
   *
   * `onSaved` runs the downstream refresh: `loadStatus` to repopulate
   * the "Last sync / Next auto sync"
   * card, `loadSettings` for misc app_settings parity, and
   * `taskCenter.refreshScheduler` so the nav "upcoming sync" row
   * picks up the new cadence within ~16 ms instead of waiting up to
   * 60 s for the next background poll.
   */
  const scheduleAutoSave = useSettingsAutoSave<Schedule>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ sync_schedule: value }),
    successMessage: (value) =>
      value === "manual"
        ? tSchedule("toast_manual")
        : value === "daily"
          ? tSchedule("toast_daily")
          : tSchedule("toast_weekly"),
    taskLabel: (value) =>
      value === "manual"
        ? tSchedule("task_label_manual")
        : value === "daily"
          ? tSchedule("task_label_daily")
          : tSchedule("task_label_weekly"),
    onSaved: () => {
      void Promise.all([
        loadStatus(),
        loadSettings(),
        taskCenter.refreshScheduler(),
      ]);
    },
  });

  /**
   * Auto-save hook for the App Store Region dropdown. Triggered on
   * `<select>` change — no Save button.
   *
   * On success we (a) move the savedCountry watermark forward so the
   * "current" pill snaps to the new selection, and (b) re-run the
   * language-suggestion probe against `/api/locale`. The probe used to
   * sit inside the imperative `saveCountry`; lifting it into `onSaved`
   * keeps behaviour identical while letting the hook own the toast +
   * Task Center mirror.
   *
   *   - 'cn' storefront + active locale = 'en'  → suggest zh
   *   - non-'cn' storefront + active locale = 'zh' → suggest en
   *
   * No suggestion when the user is already on the matching locale, and
   * no suggestion path for region/locale combos outside the two-language
   * v1 (no Spanish/etc. yet).
   */
  const countryAutoSave = useSettingsAutoSave<string>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ app_country: value }),
    successMessage: (value) => {
      const opt = COUNTRY_OPTIONS.find((o) => o.code === value);
      return opt
        ? tRegion("toast_set", { label: opt.label })
        : tRegion("toast_saved");
    },
    taskLabel: (value) => tRegion("task_label", { code: value.toUpperCase() }),
    onSaved: (value) => {
      setSavedCountry(value);
      void (async () => {
        try {
          const localeRes = await fetch("/api/locale");
          if (!localeRes.ok) {
            return;
          }
          const body = (await localeRes.json()) as { locale?: string };
          const active = body.locale === "zh" ? "zh" : "en";
          if (value === "cn" && active === "en") {
            setLanguageSuggestion("zh");
          } else if (value !== "cn" && active === "zh") {
            setLanguageSuggestion("en");
          } else {
            setLanguageSuggestion(null);
          }
        } catch {
          // Locale probe failed — drop the suggestion silently.
          // The Region save itself succeeded; the user can still
          // change language manually from Settings → Language.
        }
      })();
    },
  });

  const triggerSync = async () => {
    setSyncing(true);
    // The sync runs server-side regardless of page navigation, but we still
    // register with the Task Center so the user can see "Syncing all apps"
    // from any page and cancel the client-side wait (the server-side job is
    // protected by its own sync_running mutex).
    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title: tSyncStatus("task_title"),
      subtitle: tSyncStatus("task_subtitle"),
      kind: "sync",
      href: "/dashboard/settings",
      onCancel: () => controller.abort(),
    });

    try {
      const res = await fetch("/api/sync/trigger", {
        method: "POST",
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.skipped) {
        showToast(tToast("sync_already_running"));
        handle.complete("done", tSyncStatus("task_already_running"));
      } else {
        const msg = tSyncStatus("task_done", {
          synced: data.synced,
          changes: data.changes,
        });
        showToast(
          tToast("sync_done", { synced: data.synced, changes: data.changes })
        );
        handle.complete("done", msg);
      }
      // A successful trigger moves lastRun/nextRun forward, so the nav
      // countdown row is wrong until we push the fresh status into the
      // TaskCenter context. Fire alongside the local loadStatus() refresh.
      await Promise.all([loadStatus(), taskCenter.refreshScheduler()]);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        console.error("[settings] Manual sync trigger failed:", err);
        showToast(tToast("sync_failed"));
        handle.complete(
          "error",
          (err as Error)?.message ?? tSyncStatus("task_failed")
        );
      }
    }
    setSyncing(false);
  };

  /**
   * Drive `POST /api/policy/sync-all` in streaming mode. We parse NDJSON
   * line-by-line and feed per-app progress events into the TaskCenter
   * subtitle so the user can navigate away and still watch progress from
   * the background-task tray. The per-app AI Policy tabs already poll
   * `/api/policy/status/[id]` on mount, so they'll pick up live progress
   * for their specific app without us re-wiring anything here.
   */
  const runBulkPolicySync = async (phase: "fetch" | "all") => {
    if (policyBulkRunning) {
      return;
    }
    setPolicyBulkRunning(phase);
    setPolicyBulkSummary(null);

    const controller = new AbortController();
    const taskTitle =
      phase === "all"
        ? tPolicyCard("task_title_summarise")
        : tPolicyCard("task_title_scrape");
    const handle = taskCenter.startTask({
      title: taskTitle,
      subtitle: tPolicyCard("task_preparing"),
      kind: "sync",
      href: "/dashboard/settings/policies#privacy-policies-bulk",
      onCancel: () => controller.abort(),
    });

    let totals: {
      attempted: number;
      succeeded: number;
      failed: number;
      throttled: number;
      skipped: number;
    } | null = null;

    try {
      const res = await fetch("/api/policy/sync-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ phase, force: policyBulkForce, stream: true }),
      });

      if (!(res.ok && res.body)) {
        // The endpoint emits JSON even on 409 (in-progress) / 429 (rate
        // limited) / 500 — surface the message verbatim.
        const errBody = await res.json().catch(() => null);
        const message =
          errBody?.error ??
          tPolicyCard("bulk_failed_http", { status: res.status });
        showToast(tToast("save_failed_with_message", { message }));
        handle.complete("error", message);
        setPolicyBulkSummary(message);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffered = "";

      // NDJSON: split on newlines, parse each line. `buffered` keeps the
      // partial tail between chunks.
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          let event: any;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (event.type === "batch-start") {
            handle.update({
              subtitle: tBulkStream("queued_subtitle", {
                total: Number(event.total ?? 0),
              }),
            });
          } else if (event.type === "app-start") {
            const n = (event.index ?? 0) + 1;
            const total = event.total ?? "?";
            handle.update({
              subtitle: tBulkStream("progress_subtitle", {
                current: n,
                total,
                name: event.name,
              }),
            });
          } else if (event.type === "phase") {
            const inner = event.phase ?? {};
            const label = describeBulkPhase(
              tBulkPhase,
              inner.phase,
              inner.note
            );
            // Don't overwrite the "n/total · app name" header — we blend
            // the phase as a tail. Keep the app name we last emitted in
            // app-start by re-emitting with a suffix if the server hasn't
            // advanced the index. This matches the per-app tab UX.
            handle.update({
              subtitle: `${label}`.slice(0, 120),
            });
          } else if (event.type === "app-done") {
            // Advance count-based progress. We can't use handle.update
            // progress because the TaskCenter subtitle is our single knob.
            const n = (event.index ?? 0) + 1;
            const total = event.total ?? "?";
            const badge = event.throttled
              ? "⏸"
              : event.status === "ready" || event.status === "source_ready"
                ? "✓"
                : "⚠";
            handle.update({
              subtitle: tBulkStream("progress_subtitle_badged", {
                current: n,
                total,
                badge,
                name: event.name,
              }),
            });
          } else if (event.type === "summary") {
            totals = event.totals;
          } else if (event.type === "error") {
            throw new Error(event.error ?? tPolicyCard("bulk_stream_error"));
          }
        }
      }

      if (totals) {
        const parts = [
          tPolicyCard("bulk_part_ok", { count: totals.succeeded }),
        ];
        if (totals.failed) {
          parts.push(tPolicyCard("bulk_part_failed", { count: totals.failed }));
        }
        if (totals.throttled) {
          parts.push(
            tPolicyCard("bulk_part_throttled", { count: totals.throttled })
          );
        }
        const line = tPolicyCard(
          phase === "all" ? "bulk_line_summarise" : "bulk_line_scrape",
          { parts: parts.join(", ") }
        );
        setPolicyBulkSummary(line);
        handle.complete(totals.failed > 0 ? "error" : "done", line);
        showToast(totals.failed > 0 ? `⚠ ${line}` : `✓ ${line}`);
      } else {
        handle.complete("done", tPolicyCard("task_finished"));
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        handle.complete("error", tPolicyCard("task_cancelled"));
      } else {
        console.error("[settings] Bulk policy sync failed:", err);
        const message = (err as Error)?.message ?? tPolicyCard("bulk_failed");
        showToast(tToast("save_failed_with_message", { message }));
        handle.complete("error", message);
        setPolicyBulkSummary(message);
      }
    } finally {
      setPolicyBulkRunning(null);
    }
  };

  /**
   * Auto-save hook for the "track accessibility labels" UI toggle.
   * Scraping is unaffected — this only controls whether the chip, grid
   * filter, and stats chart render the captured feature set. Same
   * optimistic-with-rollback pattern as the Wayback toggle above so
   * both behave identically from the user's POV.
   */
  const trackAccessibilityAutoSave = useSettingsAutoSave<boolean>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ track_accessibility_labels: value }),
    successMessage: (value) =>
      value ? tA11yLabels("toast_visible") : tA11yLabels("toast_hidden"),
    taskLabel: (value) =>
      value
        ? tA11yLabels("task_label_visible")
        : tA11yLabels("task_label_hidden"),
    onSaved: (value) => setSavedTrackAccessibility(value),
  });
  const saveTrackAccessibility = async (next: boolean) => {
    setTrackAccessibility(next);
    const result = await trackAccessibilityAutoSave.save(next);
    if (result !== "ok") {
      setTrackAccessibility(savedTrackAccessibility);
    }
  };

  const queueShowProgressBarAutoSave = useSettingsAutoSave<boolean>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ queue_show_progress_bar: value }),
    successMessage: (value) =>
      tReviewQueueSettings(value ? "toast_visible" : "toast_hidden"),
    taskLabel: (value) =>
      tReviewQueueSettings(value ? "task_label_visible" : "task_label_hidden"),
    onSaved: (value) => setSavedQueueShowProgressBar(value),
  });
  const saveQueueShowProgressBar = async (next: boolean) => {
    setQueueShowProgressBar(next);
    const result = await queueShowProgressBarAutoSave.save(next);
    if (result !== "ok") {
      setQueueShowProgressBar(savedQueueShowProgressBar);
    }
  };

  const closeResetModal = () => {
    if (resetting) {
      return;
    }
    setResetStep(0);
  };

  const resetAllData = async () => {
    setResetting(true);
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        showToast(
          tToast("save_failed_with_message", {
            message: data.error ?? tToast("reset_failed_fallback"),
          })
        );
        setResetting(false);
        return;
      }

      router.push("/onboard");
      router.refresh();
    } catch (error) {
      console.error("[settings] Reset failed:", error);
      showToast(tToast("reset_failed"));
      setResetting(false);
    }
  };

  const deleteImportModalRef = useModalFocus<HTMLDivElement>({
    open: deleteTarget !== null,
    onClose: () => {
      if (!deleting) {
        setDeleteTarget(null);
      }
    },
  });
  const removeItemModalRef = useModalFocus<HTMLDivElement>({
    open: pendingItemRemoval !== null,
    onClose: () => {
      if (removingItemId === null) {
        setPendingItemRemoval(null);
      }
    },
  });
  const resetModalRef = useModalFocus<HTMLDivElement>({
    open: resetStep > 0,
    onClose: closeResetModal,
  });

  return (
    <div className="page-container">
      {/* Bottom-center toast that confirms inline auto-saves. The
          renovated SettingsView removes per-section "Save" buttons
          in favour of save-on-blur / save-on-change semantics — this
          toast is the user's signal that a save landed (green) or
          failed (red). Mirrors to Task Center when the user opts
          into the toggle below the page subtitle. */}
      <SettingsAutoSaveToast mirrorToTaskCenter={autosaveLogToTaskCenter} />

      <div className="page-header">
        {viewMode === "import-history" ? (
          <div>
            <Link
              aria-label={tSettings("back_aria")}
              className="page-header-back"
              href="/dashboard/settings"
            >
              {tSettings("back_to_settings")}
            </Link>
            <h1 className="page-title">{tSettings("import_history_title")}</h1>
            <p className="page-subtitle">
              {tSettings("import_history_subtitle")}
            </p>
          </div>
        ) : (
          <div>
            <h1 className="page-title">{tSettings("page_title")}</h1>
            <p className="page-subtitle">{tSettings("page_subtitle")}</p>
            {/* The "Also log settings auto-saves to the Task Center"
                toggle used to live here as a small chip beneath the
                page subtitle. It's been moved into the Notifications
                section — that's where users naturally look for "where
                does this notice show up" controls. */}
          </div>
        )}
      </div>

      <div
        className={`settings-layout${viewMode === "import-history" ? " settings-layout-standalone" : ""}`}
      >
        {/* The sidebar is the cross-route navigation, so every group
            route needs it — only import-history is standalone, with its
            own back link. */}
        {viewMode !== "import-history" && <SettingsSidebar />}

        <div className="settings-content">
          {showGroup("you") && (
            <>
              {/* Round 3 PR 3: server-rendered Your Focus card sits at the top of
          Settings. Mounts before the "You" heading so it reads as the
          primary control. The legacy intent picker below stays in place
          during PR 3 (existing behaviour preserved); PR 5 removes it. */}
              {settingsFocusPickerOn && focusCard}
              {desktopAppSectionOn && (
                <div
                  className="settings-section"
                  id="desktop-app"
                  style={{
                    background: "rgba(99, 102, 241, 0.06)",
                    border: "1px dashed rgba(99, 102, 241, 0.35)",
                  }}
                >
                  <h2 className="settings-section-title">
                    {tSections("desktop_app")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("desktop_app")}
                  </p>
                </div>
              )}
              {/* Date format picker — gated by `flag.settings.date_format.user_preference`.
          The value lives in `app_settings.date_format` (one of 'auto' / 'dmy' /
          'mdy' / 'iso') and feeds the shared `formatDate(ms, mode)` helper that
          every dashboard surface (changelog rows, app detail timestamps, focus
          card "updated at", etc.) calls into. Live-applies via
          `broadcastDateFormat()` so changes show across mounted hooks without a
          reload. */}
              {settingsDateFormatPrefOn && (
                <div className="settings-section" id="date-format">
                  <DateFormatPicker />
                </div>
              )}
              <h3 className="settings-group-heading">
                {tSettings("sidebar.group_you")}
              </h3>
              {/* The legacy "Your Focus" intent picker used to render here. It was
          superseded by the YourFocusCard at the top of the page (chip
          strip + Adjust → /dashboard/settings/focus) per
          https://docs.privacytracker.privacykey.org/develop/feature-flags, and the duplicate radio
          group was scheduled for removal in PR 5 but had stuck around.
          Removed in this pass; YourFocusCard owns the focus surface. */}
              <LanguageSection />

              {/* Privacy Profile — the per-category threshold picker from onboarding.
          Lives on its own endpoint so we don't bloat /api/settings; see
          lib/privacy-profile-server.ts. */}
              {settingsProfilesPrivacyOn && (
                <div
                  className="settings-section privacy-profile-section"
                  id="privacy-profile"
                >
                  <h2 className="settings-section-title">
                    {tSections("privacy_profile")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("privacy_profile")}
                  </p>

                  {/* Master on/off for the whole profile. Rendered as a custom switch
            (not a .settings-checkbox-row) so the control visually reads as a
            primary power toggle for the whole section — distinct from the
            per-item checkbox rows used for notifications below. */}
                  <div className="privacy-profile-toggle-row">
                    <button
                      aria-checked={profileEnabled}
                      aria-label={tAria("use_privacy_profile")}
                      className={`switch-toggle${profileEnabled ? " is-on" : ""}`}
                      disabled={privacyProfileAutoSave.saving}
                      // Master switch: flipping triggers an immediate save
                      // (skip the editor debounce — toggle is a discrete user
                      // intent). The skip rules in `runPrivacyProfileSave`
                      // still apply: nothing saves if the dirty / empty checks
                      // say there's nothing meaningful to persist.
                      onClick={() => {
                        const next = !profileEnabled;
                        setProfileEnabled(next);
                        runPrivacyProfileSave(next, profile);
                      }}
                      role="switch"
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="switch-toggle-thumb"
                      />
                    </button>
                    <div className="privacy-profile-toggle-label">
                      <div className="privacy-profile-toggle-title">
                        {tPrivProfile("toggle_title")}
                      </div>
                      <div className="privacy-profile-toggle-hint">
                        {profileEnabled
                          ? tPrivProfile("hint_on")
                          : tPrivProfile("hint_off")}
                      </div>
                    </div>
                  </div>

                  {profileEnabled && (
                    <PrivacyProfileEditor
                      disabled={privacyProfileAutoSave.saving}
                      // Field edits are debounced — typing through the editor
                      // emits one onChange per keystroke; we wait 500 ms after
                      // the last edit before saving. No more Save button.
                      onChange={(next) => {
                        setProfile(next);
                        schedulePrivacyProfileSave(profileEnabled, next);
                      }}
                      value={profile}
                    />
                  )}

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                      marginTop: 12,
                    }}
                  >
                    {(() => {
                      const currentPayload = profileEnabled
                        ? sanitizeProfile(profile)
                        : null;
                      const isDirty =
                        JSON.stringify(currentPayload) !==
                        JSON.stringify(savedProfile);
                      const emptyProfile =
                        profileEnabled &&
                        Object.values(profile).every(
                          (v) => typeof v !== "string"
                        );
                      // Save button removed — toggle saves on click,
                      // editor saves on debounced change. The status pills
                      // below stay for at-a-glance feedback when the
                      // bottom-center toast has already faded out.
                      return (
                        <>
                          {!isDirty && savedProfile && (
                            <span
                              style={{ fontSize: 13, color: "var(--text-2)" }}
                            >
                              {tPrivProfile("saved_count", {
                                count: Object.values(savedProfile).filter(
                                  (v) => typeof v === "string"
                                ).length,
                              })}
                            </span>
                          )}
                          {!(isDirty || savedProfile) && (
                            <span
                              style={{ fontSize: 13, color: "var(--text-2)" }}
                            >
                              {tPrivProfile("unsaved_no_profile")}
                            </span>
                          )}
                          {emptyProfile && (
                            <span
                              style={{ fontSize: 13, color: "var(--warning)" }}
                            >
                              {tPrivProfile("empty_warn")}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}

              {/* Accessibility Profile — per-feature required / nice picker. Parallels
          Privacy Profile but targets the accessibility shelf. Lives on its own
          endpoint (see lib/accessibility-profile-server.ts). Missing keys =
          "no preference" so only the features the user explicitly cares about
          contribute to mismatch calculations. */}
              {settingsProfilesAccessibilityOn && (
                <div
                  className="settings-section privacy-profile-section"
                  id="accessibility-profile"
                >
                  <h2 className="settings-section-title">
                    {tSections("accessibility_profile")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("accessibility_profile")}
                  </p>

                  <div className="privacy-profile-toggle-row">
                    <button
                      aria-checked={a11yProfileEnabled}
                      aria-label={tAria("use_a11y_profile")}
                      className={`switch-toggle${a11yProfileEnabled ? " is-on" : ""}`}
                      disabled={a11yProfileAutoSave.saving}
                      onClick={() => {
                        const next = !a11yProfileEnabled;
                        setA11yProfileEnabled(next);
                        runA11yProfileSave(next, a11yProfile);
                      }}
                      role="switch"
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="switch-toggle-thumb"
                      />
                    </button>
                    <div className="privacy-profile-toggle-label">
                      <div className="privacy-profile-toggle-title">
                        {tA11yProfile("toggle_title")}
                      </div>
                      <div className="privacy-profile-toggle-hint">
                        {a11yProfileEnabled
                          ? tA11yProfile("hint_on")
                          : tA11yProfile("hint_off")}
                      </div>
                    </div>
                  </div>

                  {a11yProfileEnabled && (
                    <AccessibilityProfileEditor
                      disabled={a11yProfileAutoSave.saving}
                      onChange={(next) => {
                        setA11yProfile(next);
                        scheduleA11yProfileSave(a11yProfileEnabled, next);
                      }}
                      value={a11yProfile}
                    />
                  )}

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                      marginTop: 12,
                    }}
                  >
                    {(() => {
                      const currentPayload = a11yProfileEnabled
                        ? sanitizeA11yProfile(a11yProfile)
                        : null;
                      const isDirty =
                        JSON.stringify(currentPayload) !==
                        JSON.stringify(savedA11yProfile);
                      const emptyProfile =
                        a11yProfileEnabled &&
                        Object.values(a11yProfile).every(
                          (v) => typeof v !== "string"
                        );
                      // Save button removed — same auto-save pattern as Privacy
                      // Profile above. Status pills remain for offline-after-fade
                      // feedback.
                      return (
                        <>
                          {!isDirty && savedA11yProfile && (
                            <span
                              style={{ fontSize: 13, color: "var(--text-2)" }}
                            >
                              {tA11yProfile("saved_count", {
                                count: Object.values(savedA11yProfile).filter(
                                  (v) => typeof v === "string"
                                ).length,
                              })}
                            </span>
                          )}
                          {!(isDirty || savedA11yProfile) && (
                            <span
                              style={{ fontSize: 13, color: "var(--text-2)" }}
                            >
                              {tA11yProfile("unsaved_no_profile")}
                            </span>
                          )}
                          {emptyProfile && (
                            <span
                              style={{ fontSize: 13, color: "var(--warning)" }}
                            >
                              {tA11yProfile("empty_warn")}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}

              {/* Notifications — choose which types the bell surfaces. Stored as a
          single JSON blob under `notification_prefs` in app_settings (see
          lib/notification-prefs.ts). Toggling a type off just hides it in
          the bell — the underlying notification row is still written to the
          DB, so turning the toggle back on immediately re-surfaces anything
          that fired while the type was muted. */}
              {settingsNotificationsPrefsOn && (
                <NotificationPrefsSection
                  autosaveLogToTaskCenter={autosaveLogToTaskCenter}
                  notificationPrefs={notificationPrefs}
                  notificationPrefsAutoSave={notificationPrefsAutoSave}
                  onAutosaveLogToggle={onAutosaveLogToggle}
                  savedNotificationPrefs={savedNotificationPrefs}
                  scheduleNotificationPrefsSave={scheduleNotificationPrefsSave}
                  setNotificationPrefs={setNotificationPrefs}
                />
              )}
            </>
          )}
          {showGroup("sync") && (
            <>
              <h3 className="settings-group-heading">
                {tSettings("sidebar.group_data_sync")}
              </h3>

              {/* Sync Schedule */}
              {settingsSyncScheduleOn && (
                <SyncScheduleSection
                  autoSave={scheduleAutoSave}
                  onRadioKeyDown={scheduleRadioKeyDown}
                  schedule={schedule}
                  setSchedule={setSchedule}
                  status={status}
                />
              )}

              {/* App Store Region */}
              {settingsSyncRegionOn && (
                <RegionSection
                  autoSave={countryAutoSave}
                  country={country}
                  languageSuggestion={languageSuggestion}
                  onDismissLanguageSuggestion={() =>
                    setLanguageSuggestion(null)
                  }
                  savedCountry={savedCountry}
                  setCountry={setCountry}
                />
              )}

              {/*
        Accessibility Labels. Apple started publishing an "Accessibility"
        nutrition-label shelf in 2025 (VoiceOver / Voice Control / Larger
        Text / etc.). The scraper always captures it so the data is
        retained; this toggle only decides whether the chip, stats card,
        and grid filter are rendered. Sits between the App Store Region
        section (which shapes what we scrape) and Sync Status (which shapes
        when) because it straddles both.
      */}
              <AccessibilityLabelsSection
                saveTrackAccessibility={saveTrackAccessibility}
                trackAccessibility={trackAccessibility}
                trackAccessibilityAutoSave={trackAccessibilityAutoSave}
              />

              {/* Review-queue preferences — single toggle for the progress bar
          shown in the Tinder-style review carousel. Tiny standalone
          section so users can find it via "queue" search; expand later
          if more queue prefs land. */}
              <ReviewQueuePrefsSection
                queueShowProgressBar={queueShowProgressBar}
                queueShowProgressBarAutoSave={queueShowProgressBarAutoSave}
                saveQueueShowProgressBar={saveQueueShowProgressBar}
              />

              {/* Sync Status — manual "Sync Now" trigger + last-sync info. Shares
          the `flag.settings.sync.schedule` gate because the manual button
          is just an "override the timer right now" affordance for the
          schedule above. Hiding the schedule card without hiding this one
          would leave a dangling action with no context. */}
              {settingsSyncScheduleOn && (
                <SyncStatusSection
                  status={status}
                  syncing={syncing}
                  triggerSync={triggerSync}
                />
              )}
            </>
          )}
          {showGroup("policies") && (
            <>
              <h3 className="settings-group-heading">
                {tSettings("sidebar.group_policies_ai")}
              </h3>

              {settingsAiEnabledOn && <AiSummariesSection ai={ai} />}

              {/*
        Bulk "Privacy Policies" operations. Distinct from the App Store Sync
        Status block above — App Store sync just refreshes the privacy-type
        labels Apple exposes on the store page, whereas this section actually
        fetches each developer's privacy-policy URL and (optionally) re-runs
        the AI summary. Kept visually adjacent to "AI Policy Summaries" so
        users discover it right where they configure the AI provider.
        Wave I: gated behind `flag.settings.policies.throttle` since the
        throttle config is the most visible per-card control here. The bulk
        run-now buttons share the same gate — they're inseparable from the
        settings card from the user's POV.
      */}
              {settingsPoliciesThrottleOn && (
                <PrivacyPoliciesBulkSection
                  force={policyBulkForce}
                  onRun={runBulkPolicySync}
                  running={policyBulkRunning}
                  setForce={setPolicyBulkForce}
                  summary={policyBulkSummary}
                />
              )}

              {/* Policy Change Alerts */}
              <PolicyAlertsSection
                autoSave={policyDiffAlertDaysAutoSave}
                days={policyDiffAlertDays}
                onBlur={handlePolicyDiffAlertBlur}
                setDays={setPolicyDiffAlertDays}
              />

              {/* Policy Scraping Kill-Switch — global on/off. Stronger than the
          throttle (which just rate-limits). When on, every code path
          that would fetch a privacy-policy URL is silenced, the manual
          sync buttons return 409, and a crashed bulk-policy resume on
          next boot is cancelled cleanly with an activity-log entry. */}
              <PolicyScrapeKillSwitchSection
                scrapeDisabled={scrapeDisabled}
                scrapeDisabledAutoSave={scrapeDisabledAutoSave}
                setScrapeDisabled={setScrapeDisabled}
              />

              {/* Policy Scrape Throttle */}
              <PolicyScrapeThrottleSection
                handleScrapeThrottleBlur={handleScrapeThrottleBlur}
                saveScrapeThrottle={saveScrapeThrottle}
                scrapeDisabled={scrapeDisabled}
                scrapeThrottleAutoSave={scrapeThrottleAutoSave}
                scrapeThrottleEnabled={scrapeThrottleEnabled}
                scrapeThrottleMinutes={scrapeThrottleMinutes}
                setScrapeThrottleEnabled={setScrapeThrottleEnabled}
                setScrapeThrottleMinutes={setScrapeThrottleMinutes}
              />
            </>
          )}
          {viewMode === "import-history" && settingsImportHistoryOn && (
            <ImportHistorySection ih={ih} />
          )}

          {showGroup("admin") && (
            <>
              <h3 className="settings-group-heading">
                {tSettings("sidebar.group_admin")}
              </h3>

              {/* Import History — full section on the standalone page, otherwise
          a compact link card in the main Settings view. Keeping the big
          review-and-retry UI on its own page lets the Settings landing
          stay scannable and gives the history enough room for the
          expandable rows + inline change-match flow. */}
              {showGroup("admin") && settingsImportHistoryOn && (
                <ImportHistoryLinkCard />
              )}

              <DeploymentDiagnosticsSection
                adminTokenConfigured={adminTokenConfigured}
                adminTokenInput={adminTokenInput}
                adminTokenUnlocked={adminTokenUnlocked}
                copying={copyingDeploymentDiagnostics}
                diagnostics={deploymentDiagnostics}
                error={deploymentDiagnosticsError}
                loading={deploymentDiagnosticsLoading}
                locked={deploymentDiagnosticsLocked}
                onClearAdminToken={clearSessionAdminToken}
                onCopySupportBundle={copyDeploymentSupportBundle}
                onReload={loadDeploymentDiagnostics}
                onSaveAdminToken={saveSessionAdminToken}
                setAdminTokenInput={setAdminTokenInput}
              />

              {/* Backup & Restore */}
              {settingsAdminBackupOn && (
                <BackupSection
                  backupSnapshotDirectory={backupSnapshotDirectory}
                  backupSnapshotSettings={backupSnapshotSettings}
                  backupSnapshots={backupSnapshots}
                  backupSnapshotsAutoSave={backupSnapshotsAutoSave}
                  creatingBackupSnapshot={creatingBackupSnapshot}
                  exportingBackup={exportingBackup}
                  handleCreateBackupSnapshot={handleCreateBackupSnapshot}
                  handleExportBackup={handleExportBackup}
                  handleRestoreFileChosen={handleRestoreFileChosen}
                  restoreError={restoreError}
                  restoreStage={restoreStage}
                  saveBackupSnapshots={saveBackupSnapshots}
                  setBackupSnapshotSettings={setBackupSnapshotSettings}
                  status={status}
                />
              )}

              {/*
        Historical Import (Wayback Machine). Apple launched the web App Store
        on 5 November 2025, which is when archive.org started indexing
        product pages. For each app we pull the closest capture to every
        quarter between then and today, reconstructing privacy-label history
        without needing to have been running this tool back then.
        Rows are tagged `source='wayback'` so the changelog timeline can
        show them with a clock icon and purple accent; they never bump
        `apps.changeCount` because they aren't new changes — they're
        history the user has already lived through.
      */}
              {settingsPoliciesWaybackOn && (
                <WaybackImportSection
                  controlWaybackImport={controlWaybackImport}
                  runBulkWaybackImport={runBulkWaybackImport}
                  saveWaybackShowImported={saveWaybackShowImported}
                  setWaybackRemoveOpen={setWaybackRemoveOpen}
                  waybackControlBusy={waybackControlBusy}
                  waybackInitiator={waybackInitiator}
                  waybackLastRun={waybackLastRun}
                  waybackProgress={waybackProgress}
                  waybackRemoving={waybackRemoving}
                  waybackRunning={waybackRunning}
                  waybackRunStatus={waybackRunStatus}
                  waybackShowImported={waybackShowImported}
                  waybackSummary={waybackSummary}
                  waybackToggleAutoSave={waybackToggleAutoSave}
                />
              )}
              {/* Data Export */}
              {settingsAdminExportOn && (
                <ExportDataSection auditPdfOn={settingsAdminExportAuditPdfOn} />
              )}

              {/* Developer Options — AI call logging, the operational activity
          log, per-phase AI timeouts, and the feature-flag panel. Each of
          those owns its own sub-flag; this gate decides only whether the
          section exists at all. `debugLogging` is passed down rather than
          owned by the panel because it round-trips through the AI settings
          blob saved above. */}
              {devOptsVisible && (
                <DeveloperSection
                  advancedAiOpen={advancedAiOpen}
                  aiProvider={aiProvider}
                  aiTimeoutChunkAutoSave={aiTimeoutChunkAutoSave}
                  aiTimeoutChunkMs={aiTimeoutChunkMs}
                  aiTimeoutDirectAutoSave={aiTimeoutDirectAutoSave}
                  aiTimeoutDirectMs={aiTimeoutDirectMs}
                  aiTimeoutMergeAutoSave={aiTimeoutMergeAutoSave}
                  aiTimeoutMergeMs={aiTimeoutMergeMs}
                  debugLogging={debugLogging}
                  saveAiSettings={saveAiSettings}
                  setAdvancedAiOpen={setAdvancedAiOpen}
                  setAiTimeoutChunkMs={setAiTimeoutChunkMs}
                  setAiTimeoutDirectMs={setAiTimeoutDirectMs}
                  setAiTimeoutMergeMs={setAiTimeoutMergeMs}
                  setDebugLogging={setDebugLogging}
                  showToast={showToast}
                />
              )}

              {/* Reset App — destructive danger zone, deliberately the last
          section on the page (and in the sidebar) so it never sits between
          routine admin actions like Export Data. Keep this position in sync
          with the link order in SettingsSidebar.tsx — the scroll-spy walks
          sections in sidebar order and assumes it matches document order. */}
              {(settingsAdminResetOn || settingsAdminStartOverOn) && (
                <ResetSection
                  exportingBackup={exportingBackup}
                  handleExportBackup={handleExportBackup}
                  setResetStep={setResetStep}
                  settingsAdminResetOn={settingsAdminResetOn}
                  settingsAdminStartOverOn={settingsAdminStartOverOn}
                  status={status}
                />
              )}
            </>
          )}
        </div>
      </div>

      <Toast>{toast}</Toast>

      <RestoreBackupModal
        dateMode={dateMode}
        exportingBackup={exportingBackup}
        handleExportBackup={handleExportBackup}
        handleRestoreConfirm={handleRestoreConfirm}
        pendingRestoreFilename={pendingRestoreFilename}
        resetRestoreFlow={resetRestoreFlow}
        restoreConfirmText={restoreConfirmText}
        restoreError={restoreError}
        restoreModalRef={restoreModalRef}
        restorePreview={restorePreview}
        restoreStage={restoreStage}
        setRestoreConfirmText={setRestoreConfirmText}
        setRestoreError={setRestoreError}
      />

      <DeleteImportModal
        confirmDeleteImport={confirmDeleteImport}
        dateMode={dateMode}
        deleteImportModalRef={deleteImportModalRef}
        deleteTarget={deleteTarget}
        deleting={deleting}
        setDeleteTarget={setDeleteTarget}
      />

      <WaybackRemoveModal
        closeWaybackRemoveModal={closeWaybackRemoveModal}
        removeAllWaybackHistory={removeAllWaybackHistory}
        waybackRemoveModalRef={waybackRemoveModalRef}
        waybackRemoveOpen={waybackRemoveOpen}
        waybackRemoving={waybackRemoving}
      />

      <RemoveItemModal
        confirmRemoveItemFromDashboard={confirmRemoveItemFromDashboard}
        pendingItemRemoval={pendingItemRemoval}
        removeItemModalRef={removeItemModalRef}
        removingItemId={removingItemId}
        setPendingItemRemoval={setPendingItemRemoval}
      />

      <ResetAppModal
        closeResetModal={closeResetModal}
        exportingBackup={exportingBackup}
        handleExportBackup={handleExportBackup}
        resetAllData={resetAllData}
        resetModalRef={resetModalRef}
        resetStep={resetStep}
        resetting={resetting}
        setResetStep={setResetStep}
      />
    </div>
  );
}

// ── Start Over button ─────────────────────────────────────────────────────
//
// Round 3 PR 5: lives in the Reset section's button row. Differs from
// "Reset all data" by preserving the DB schema + migration version — same
// scope of data wipe, but the next page load can render onboarding cleanly
// without re-running migrations on a freshly-blank DB. Calls
// /api/admin/start-over and routes to /welcome on success.

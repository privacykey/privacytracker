"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DateFormatMode,
  formatDate as formatDateWithMode,
} from "../../lib/date-format";
import { useDateFormat } from "../../lib/date-format-hook";
import { useFlag } from "../../lib/feature-flags-hooks";
import { useSettingsAutoSave } from "../../lib/use-settings-auto-save";
import AuditBundleExport from "./AuditBundleExport";
import AuditBundleImport from "./AuditBundleImport";
import DateFormatPicker from "./DateFormatPicker";
import DevOptionsFeatureFlagPanel from "./DevOptionsFeatureFlagPanel";
import { useImportQueue } from "./ImportQueueProvider";
import LanguageSuggestionBanner from "./LanguageSuggestionBanner";
import LocaleSwitcher from "./LocaleSwitcher";
import RateLimitBanner from "./RateLimitBanner";
import SettingsAutoSaveToast, {
  pushSettingsToast,
} from "./SettingsAutoSaveToast";
import SettingsSidebar from "./SettingsSidebar";
import { useTaskCenter } from "./TaskCenter";
import TasksResetRow from "./TasksResetRow";

/**
 * localStorage key for the "Also log save events to Task Center"
 * preference. Per-browser toggle (not synced server-side) — it's a
 * UX nicety, not a data setting, so a localStorage round-trip is
 * the right scope. Read on mount, written when the user flips the
 * toggle.
 */
const AUTOSAVE_LOG_KEY = "settings-autosave-log-to-taskcenter";

import {
  type AccessibilityProfile,
  DEFAULT_A11Y_PROFILE,
  sanitizeA11yProfile,
} from "../../lib/accessibility-profile";
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
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_TYPE_KEYS,
  type NotificationPrefs,
  type NotificationTypeKey,
  resolvePrefs as resolveNotificationPrefs,
  sanitizePrefs as sanitizeNotificationPrefs,
} from "../../lib/notification-prefs";
import type {
  PolicyLensKey,
  PolicyRating,
  PolicySummary,
} from "../../lib/policy-summary-meta";
import {
  DEFAULT_PROFILE,
  type PrivacyProfile,
  sanitizeProfile,
} from "../../lib/privacy-profile";
import {
  COUNTRY_OPTIONS,
  DEFAULT_COUNTRY,
  normalizeCountry,
} from "../../lib/region";
import AccessibilityProfileEditor from "./AccessibilityProfileEditor";
import { ADMIN_TOKEN_CHANGED_EVENT } from "./AdminTokenBridge";
// Intent picker state is gone — see the comment by `loadPreferences`
// for context. The exports are kept in `lib/preferences.ts` for any
// other consumer (e.g. the welcome splash) but Settings no longer
// needs them.
import PrivacyProfileEditor from "./PrivacyProfileEditor";

type Schedule = "manual" | "daily" | "weekly";
type WaybackRunStatus =
  | "idle"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "stale";

interface StoredAiSettings {
  apiKey: string;
  baseUrl: string;
  debugLogging: boolean;
  model: string;
  provider: AIProvider;
  summarizeOnImport: boolean;
  timeoutChunkMs: string;
  // Per-phase AI request timeouts, persisted as strings so the input can
  // hold "" while the user is mid-edit. Empty string = server default.
  timeoutDirectMs: string;
  timeoutMergeMs: string;
}

/** One row persisted in the `ai_debug_log` table (see lib/privacy-policy.ts). */
interface AiDebugLogRow {
  appId?: string;
  appName?: string;
  createdAt: number;
  durationMs?: number;
  error?: string;
  id: string;
  model?: string;
  phase?: string;
  prompt?: string;
  provider?: string;
  response?: string;
}

interface AiSamplePolicyResult {
  durationMs: number;
  mode: "direct" | "chunked";
  model: string;
  ok: true;
  provider: string;
  sample: {
    appName: string;
    developer: string;
    policyUrl: string;
    policyText: string;
    scenario: string;
    wordCount: number;
    reviewChecklist: string[];
    expectedSignals: string[];
  };
  summary: PolicySummary;
}

/**
 * Activity row returned by /api/activity. Mirrors lib/activity.ts
 * ActivityRow, but kept duplicated here so the client bundle doesn't pull the
 * server-only `db` import chain via that module.
 */
interface ActivityLogRow {
  appId: string | null;
  appName: string | null;
  detail: Record<string, unknown> | null;
  durationMs: number | null;
  endedAt: number | null;
  id: string;
  startedAt: number;
  status: string;
  summary: string | null;
  type: string;
}

interface SyncStatus {
  isRunning: boolean;
  lastRun: number;
  nextRun: number | null;
  schedule: Schedule;
}

type DeploymentCheckStatus = "ok" | "info" | "warn" | "bad";

interface DeploymentDiagnosticCheck {
  detail: string;
  id: string;
  label: string;
  status: DeploymentCheckStatus;
}

interface DeploymentDiagnostics {
  app: {
    name: string;
    version: string;
    nodeEnv: string;
    runtime: "desktop" | "web";
    containerLikely: boolean;
    platform: string;
    arch: string;
    node: string;
    uptimeSeconds: number;
  };
  checks: DeploymentDiagnosticCheck[];
  database: {
    path: string;
    dataDir: string;
    dataDirSource: "env" | "cwd" | "memory";
    exists: boolean;
    sizeBytes: number | null;
    writable: boolean;
    journalMode: string | null;
    error: string | null;
  };
  generatedAt: string;
  health: {
    status: "ok" | "degraded";
    dbPingMs: number | null;
    error: string | null;
  };
  network: {
    host: string | null;
    forwardedHost: string | null;
    forwardedProto: string | null;
    forwardedForPresent: boolean;
    realIpPresent: boolean;
    proxyDetected: boolean;
    protocol: "http" | "https" | "unknown";
    localOnlyHost: boolean;
    lanOrDomainHost: boolean;
  };
  security: {
    adminTokenConfigured: boolean;
    adminTokenRequired: boolean;
  };
}

interface BackupSnapshotSettings {
  enabled: boolean;
  intervalHours: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  retentionCount: number;
}

interface BackupSnapshotRow {
  createdAt: number;
  filename: string;
  path: string;
  sizeBytes: number;
}

interface BackupSnapshotsPayload {
  created?: BackupSnapshotRow;
  directory: string;
  pruned?: BackupSnapshotRow[];
  settings: BackupSnapshotSettings;
  snapshots: BackupSnapshotRow[];
}

const DEFAULT_BACKUP_SNAPSHOT_SETTINGS: BackupSnapshotSettings = {
  enabled: false,
  intervalHours: 24,
  retentionCount: 10,
  lastRunAt: null,
  nextRunAt: null,
};

type ImportSource = "screenshots" | "file" | "manual";
type ImportItemStatus =
  | "matched"
  | "unmatched"
  | "skipped"
  | "imported"
  | "error"
  // `queued` marks an item where Apple rate-limited us during the initial
  // import. The background worker drains these automatically on a timer;
  // the user can also kick a retry from this UI.
  | "queued"
  // `removed` marks an item whose app was imported once but later removed from
  // tracking. We keep the full history row so the user can still see what was
  // matched and optionally re-add it, but a background sync won't resurrect it.
  | "removed";

interface ImportRow {
  completedAt: number | null;
  createdAt: number;
  errored: number;
  id: string;
  imported: number;
  itemCount: number;
  matched: number;
  /**
   * Live counters joined in from `import_items` at query time (see
   * `listImports` / `getImportRow` in `lib/imports.ts`). These let the
   * collapsed summary row decide whether to show problem badges or the
   * "Resume matching" button without first fetching the item list.
   *
   * `itemCount` diverges from `total` only for legacy imports that ran
   * before the items-write code path existed — we use that gap to show
   * a clearer empty state on View.
   */
  queued: number;
  removed: number;
  source: ImportSource;
  sourceLabel: string | null;
  total: number;
  unmatched: number;
}

interface ImportItemRow {
  appId: string | null;
  appName: string | null;
  attemptCount?: number;
  country?: string | null;
  developer: string | null;
  editedQuery: string | null;
  iconUrl?: string | null;
  id: string;
  importId: string;
  nextAttemptAt?: number | null;
  query: string;
  removedAppId: string | null;
  scrapeError: string | null;
  status: ImportItemStatus;
  url: string | null;
}

/** iTunes Search candidate — minimal shape; matches /api/search responses. */
interface AppCandidate {
  appleId: string;
  developer: string;
  iconUrl: string;
  name: string;
  url: string;
}

/**
 * When the user opens the "Change match" / "Re-add" inline widget on a row,
 * we stash the widget state here. Only one row can be editing at a time.
 */
interface ChangeMatchState {
  applyingAppleId: string | null;
  /**
   * Optional seller / developer hint. Mirrors the `developer` column in the
   * onboarding CSV import — when set, the iTunes Search API is called with a
   * `rows: [{ name, developer }]` payload so the server can re-rank
   * candidates whose developer matches. Blank string means "no hint, rank
   * purely on name" (same behaviour as the old single-input search).
   */
  developer: string;
  error: string;
  itemId: string;
  /** 'change' for currently-imported items; 're-add' for removed items. */
  mode: "change" | "readd";
  query: string;
  results: AppCandidate[] | null;
  searching: boolean;
}

type DeleteMode = "history-only" | "with-apps";

interface DeleteTarget {
  importRow: ImportRow;
  mode: DeleteMode;
}

/**
 * Status filter applied to the Import History item list. Drives the clickable
 * summary badges (click "3 unmatched" → filter=unmatched) and the notification
 * deep-links ("Unmatched apps to review" → ?filter=unmatched; "Import needs
 * attention" → ?filter=problems).
 *
 * `problems` is the union of unmatched + error rows — used when the user just
 * wants "show me everything that didn't land" without committing to a single
 * status.
 */
type ItemStatusFilter =
  | "unmatched"
  | "error"
  | "removed"
  | "queued"
  | "problems";

/** Does the given item pass the given filter? null filter always passes. */
function itemMatchesFilter(
  status: ImportItemStatus,
  filter: ItemStatusFilter | null
): boolean {
  if (!filter) {
    return true;
  }
  if (filter === "problems") {
    return status === "unmatched" || status === "error";
  }
  return status === filter;
}

/** Short label + tone for the filter banner. Keyed by filter id. */
const FILTER_META: Record<ItemStatusFilter, { label: string; tone: string }> = {
  unmatched: { label: "Unmatched", tone: "warn" },
  error: { label: "Errors", tone: "bad" },
  removed: { label: "Removed", tone: "mute" },
  queued: { label: "Queued", tone: "warn" },
  problems: { label: "Problems (unmatched + error)", tone: "warn" },
};

// Status icons are deliberately light on ✗. An errored import row is still
// eligible for retry (the Retry import button on the detail row, the bulk
// Retry all on the filter banner, or the server-side queue worker), so a
// clock ("will retry") reads more accurately than a dead X. The stronger
// error tone is still carried by `tone: 'bad'` so the row shows red.
const STATUS_META: Record<
  ImportItemStatus,
  { label: string; tone: string; icon: string }
> = {
  imported: { label: "Imported", tone: "ok", icon: "✓" },
  matched: { label: "Matched", tone: "ok", icon: "✓" },
  unmatched: { label: "Unmatched", tone: "warn", icon: "⚠" },
  skipped: { label: "Skipped", tone: "mute", icon: "–" },
  error: { label: "Error", tone: "bad", icon: "⏱" },
  queued: { label: "Queued", tone: "warn", icon: "⏱" },
  removed: { label: "Removed", tone: "mute", icon: "∅" },
};

const SCHEDULE_OPTIONS: { value: Schedule; label: string; desc: string }[] = [
  { value: "manual", label: "Manual", desc: "Only sync when you ask" },
  { value: "daily", label: "Daily", desc: "Every 24 hours automatically" },
  { value: "weekly", label: "Weekly", desc: "Once a week automatically" },
];

type DateT = (key: string, values?: Record<string, string | number>) => string;

/**
 * Format an epoch-ms as a localised "5 Apr 2025, 14:30" string. Translator
 * arg supplies the localised "Never" placeholder for unset (0) values; the
 * surrounding numeric formatting is handed to Intl.DateTimeFormat with the
 * `en-AU` locale so the date string keeps its day/month/year ordering
 * regardless of UI locale (zh users still see "5 Apr 2025" etc.).
 */
function fmtDate(t: DateT, ts: number) {
  if (!ts) {
    return t("fmt_never");
  }
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

/** Human-readable type labels + emoji icons for the activity log rows. */
const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  scrape: "Initial scrape",
  resync: "Re-sync",
  policy_summary: "Policy summary",
  scheduled_sync: "Scheduled sync",
  manual_sync: "Manual sync",
  import: "Import",
  backup_export: "Backup export",
  backup_restore: "Backup restore",
  reset: "Reset",
};

const ACTIVITY_TYPE_ICONS: Record<string, string> = {
  scrape: "📥",
  resync: "↻",
  policy_summary: "📝",
  scheduled_sync: "⏰",
  manual_sync: "▶",
  import: "📦",
  backup_export: "💾",
  backup_restore: "⟲",
  reset: "⚠",
};

/** Rough "N minutes ago" formatter — coarse enough for a log view. */
function fmtRelativeTime(t: TimeT, tDate: DateT, ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 0) {
    return fmtDate(tDate, ts);
  }
  if (diff < 45_000) {
    return t("rel_just_now");
  }
  if (diff < 90_000) {
    return t("rel_one_min");
  }
  if (diff < 60 * 60_000) {
    return t("rel_mins_ago", { count: Math.round(diff / 60_000) });
  }
  if (diff < 2 * 60 * 60_000) {
    return t("rel_one_hr");
  }
  if (diff < 24 * 60 * 60_000) {
    return t("rel_hrs_ago", { count: Math.round(diff / (60 * 60_000)) });
  }
  if (diff < 2 * 24 * 60 * 60_000) {
    return t("rel_yesterday");
  }
  if (diff < 7 * 24 * 60 * 60_000) {
    return t("rel_days_ago", { count: Math.round(diff / (24 * 60 * 60_000)) });
  }
  return fmtDate(tDate, ts);
}

/** Duration in a compact form: 430ms / 3.2s / 1m 20s. */
function fmtDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  }
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function fmtRelative(t: TimeT, ts: number | null) {
  if (!ts) {
    return "—";
  }
  const diff = ts - Date.now();
  if (diff <= 0) {
    return t("due_now");
  }
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 24) {
    return t("in_days", { count: Math.floor(h / 24) });
  }
  if (h > 0) {
    return t("in_hours_minutes", { hours: h, minutes: m });
  }
  return t("in_minutes", { minutes: m });
}

function fmtShortDate(ts: number, mode: DateFormatMode) {
  if (!ts) {
    return "—";
  }
  // Delegates to the shared formatter so the import-history rows, the
  // backup-restore "exported on" line, and the delete-confirmation
  // dialog all honour Settings → Appearance → Date format. Was a
  // hard-coded `'en-AU'` Intl.DateTimeFormat before.
  return formatDateWithMode(ts, mode);
}

/**
 * Format a short countdown to a future timestamp for queue retry UX.
 * `~5s`, `~2m 10s`, `~1h 05m`. Returns `now` if the timestamp is in the past.
 */
/**
 * `t` is the translator namespaced at `settings.time`. Module-level so the
 * function signature stays stable for callers, but the strings now route
 * through the locale bundle. Numerals stay numeric — Intl.PluralRules
 * isn't useful for these compact countdowns since neither English nor
 * Mandarin distinguish them.
 */
type TimeT = (key: string, values?: Record<string, string | number>) => string;
function fmtQueueCountdown(t: TimeT, ts: number | null | undefined): string {
  if (!ts) {
    return t("queue_now");
  }
  const diff = ts - Date.now();
  if (diff <= 0) {
    return t("queue_now");
  }
  const secs = Math.ceil(diff / 1000);
  if (secs < 60) {
    return t("queue_seconds", { seconds: secs });
  }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) {
    return s > 0
      ? t("queue_minutes_seconds", { minutes: m, seconds: s })
      : t("queue_minutes", { minutes: m });
  }
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return t("queue_hours_minutes", {
    hours: h,
    minutes: String(mm).padStart(2, "0"),
  });
}

/**
 * Short label for a PolicyRunPhase `phase` field, used to keep the bulk
 * "Privacy Policies" TaskCenter subtitle moving while the stream is
 * running. Mirrors `describePolicyPhase` in AppDetailView but kept local
 * here so SettingsView doesn't pull in a client component just for the
 * helper.
 */
/**
 * Map a known iOS / macOS / Apple device class to a small emoji glyph
 * for the import-history list. Returns null when the label doesn't
 * carry a recognisable class — callers fall back to no icon, which
 * matches the current behaviour for non-cfgutil sources (manual entry,
 * file upload, screenshot OCR).
 *
 * The OnboardWizard's cfgutil-export path encodes the class as a
 * structured " · " segment in the source label, e.g.
 *   "Apple Configurator · iPhone · Aria's iPhone"
 * so we just split, look for any segment that matches the known set,
 * and pick the matching glyph. macOS / iOS don't have great emoji for
 * iPad and Apple Watch specifically, so we use 📱 for the iPhone
 * family, 🟦 as a placeholder for iPad-shape devices, ⌚️ for Watch,
 * and 📺 for Apple TV. Unicode 16's `iPad` glyph isn't widely
 * deployed yet — fall back to 📱 if you see weird boxes on older
 * macOS versions and the prefix vanishes silently.
 */
function pickSourceIcon(
  sourceLabel: string | null,
  source: string
): { glyph: string; title: string } | null {
  if (!sourceLabel) {
    return null;
  }
  // Cheap class detection — split on the same separator OnboardWizard
  // uses, plus a few inline-prefix variants other importers might
  // produce (e.g. "iPhone backup file" from a future Configurator
  // CSV export). Case-insensitive to absorb formatting drift.
  const segments = sourceLabel.split("·").map((s) => s.trim().toLowerCase());
  const has = (needle: string) =>
    segments.some((seg) => seg === needle || seg.startsWith(`${needle} `));

  if (has("iphone")) {
    return { glyph: "📱", title: "iPhone" };
  }
  if (has("ipad")) {
    return { glyph: "📱", title: "iPad" };
  }
  if (has("ipod")) {
    return { glyph: "🎵", title: "iPod" };
  }
  if (has("appletv") || has("apple tv")) {
    return { glyph: "📺", title: "Apple TV" };
  }
  if (has("applewatch") || has("apple watch")) {
    return { glyph: "⌚️", title: "Apple Watch" };
  }

  // Source-keyed fallbacks. When the label doesn't carry a class
  // (manual entry, file upload, the import was created before this
  // feature shipped), pick a glyph from the import's `source` value
  // so the row at least has *some* visual anchor matching the
  // surrounding affordances.
  if (source === "configurator") {
    return { glyph: "📱", title: "Apple Configurator" };
  }
  if (source === "file") {
    return { glyph: "📄", title: "File upload" };
  }
  if (source === "manual") {
    return { glyph: "⌨️", title: "Manual entry" };
  }
  if (source === "screenshot" || source === "screenshots") {
    return { glyph: "📷", title: "Screenshot OCR" };
  }

  return null;
}

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
  viewMode?: "all" | "import-history";
}

export default function SettingsView({
  viewMode = "all",
  focusCard,
}: SettingsViewProps = {}) {
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
  const tAiOptions = useTranslations("ai_options");
  // Per-section subtitle copy + the App Store Region card's controls
  // + the accessibility-labels card's checkbox copy. Pulled out of the
  // root `tSettings` so the call-sites in the JSX read short.
  const tSub = useTranslations("settings.subtitles");
  const tRegion = useTranslations("settings.region");
  const tA11yLabels = useTranslations("settings.accessibility_labels_card");
  const tReviewQueueSettings = useTranslations("settings.review_queue_card");
  const tSyncStatus = useTranslations("settings.sync_status");
  const tDeploy = useTranslations("settings.deployment_diagnostics_card");
  const tPolicyCard = useTranslations("settings.privacy_policies_card");
  const tBackupCard = useTranslations("settings.backup_card");
  const tExportCard = useTranslations("settings.export_card");
  const tNotifPrefsCard = useTranslations("settings.notification_prefs_card");
  const tSchedule = useTranslations("settings.schedule");
  const tResetCard = useTranslations("settings.reset_app_card");
  const tWayback = useTranslations("settings.wayback");
  const tWaybackRemove = useTranslations("settings.wayback.remove_modal");
  const tAi = useTranslations("settings.ai");
  const tAiProvider = useTranslations("settings.ai.provider");
  const tAiConn = useTranslations("settings.ai.connection");
  const tAiModel = useTranslations("settings.ai.model");
  const tAiSample = useTranslations("settings.ai.sample");
  const tAiBehavior = useTranslations("settings.ai.behavior");
  const tAiFooter = useTranslations("settings.ai.footer");
  const tLens = useTranslations("policy_lens");
  const tRating = useTranslations("policy_rating");
  // Developer Options card sub-namespaces — split per sub-block so the
  // call-sites stay short. activity_types/* is a 1:1 map onto the
  // module-level ACTIVITY_TYPE_LABELS keys.
  const tDevAiDebug = useTranslations("settings.dev_options.ai_debug");
  const tDevActivity = useTranslations("settings.dev_options.activity_log");
  const tDevActivityTypes = useTranslations(
    "settings.dev_options.activity_types"
  );
  const tDevAiTimeouts = useTranslations("settings.dev_options.ai_timeouts");
  const tDevPresets = useTranslations("settings.dev_options.presets");
  // Bottom-of-page modals — restore backup, delete import, remove app.
  // Their reset/wayback siblings already live under settings.* and so
  // do these for symmetry.
  const tModalRestore = useTranslations("settings.modals.restore_backup");
  const tModalDelete = useTranslations("settings.modals.delete_import");
  const tModalRemoveApp = useTranslations("settings.modals.remove_app");
  // Privacy & Accessibility profile cards — toggle hint, Save button,
  // saved-count summary, unsaved/empty hints.
  const tPrivProfile = useTranslations("settings.privacy_profile_card");
  const tA11yProfile = useTranslations("settings.accessibility_profile_card");
  // Inline Ollama bootstrapping help under the AI provider picker. Only
  // shown when provider === 'custom'; uses rich() for the inline <code>,
  // <strong>, <em> tags scattered through the long-form copy.
  const tOllamaHelp = useTranslations("settings.ai.ollama_help");
  // Policy Change Alerts + Policy Scrape Throttle cards.
  const tPolicyAlerts = useTranslations("settings.policy_alerts");
  const tPolicyThrottle = useTranslations("settings.policy_throttle");
  // Import History view (single big surface — banners, filter chrome,
  // per-row stats, expanded items, change-match panel, legacy/empty
  // states). Sub-namespaces let call-sites stay short.
  const tImpHistory = useTranslations("settings.import_history");
  const tImpHistoryCard = useTranslations("settings.import_history_card");
  const tImpQueue = useTranslations("settings.import_history.queue_banner");
  const tImpFilterBanner = useTranslations(
    "settings.import_history.filter_banner"
  );
  const tImpFilterMeta = useTranslations("settings.import_history.filter_meta");
  const tImpSource = useTranslations("settings.import_history.source");
  const tImpStatusMeta = useTranslations("settings.import_history.status_meta");
  const tImpActions = useTranslations("settings.import_history.actions");
  const tImpItem = useTranslations("settings.import_history.item");
  const tImpChangeMatch = useTranslations(
    "settings.import_history.change_match"
  );
  const tImpLegacy = useTranslations("settings.import_history.legacy");
  const tImpCouldntLoad = useTranslations(
    "settings.import_history.couldnt_load"
  );
  // Toast messages + compact time formatters. The time helpers (fmt*)
  // were refactored to take a translator argument; tToast routes the
  // showToast() call sites through next-intl.
  const tToast = useTranslations("settings.toasts");
  const tTime = useTranslations("settings.time");
  const tAria = useTranslations("settings.aria");
  const tPh = useTranslations("settings.placeholders");
  // Per-row notification-preference labels + descriptions + example
  // hints. The seven preference keys map onto snake_case translation
  // keys via a regex inside the loop below.
  const tNotifPrefs = useTranslations("notification_prefs");

  // Wave I: gate the Dev Options sub-panels behind their flags. The
  // top-level dev-opts entry is gated separately (`flag.devopts.visible`
  // in the sidebar); these flags toggle the inner accordions/panels so
  // a guardian audience can see the dev-opts sidebar entry but not the
  // full debug surface area.
  const devActivityLogOn = useFlag("flag.devopts.activity_log") === "on";
  const devAdvancedAccordionFlag = useFlag("flag.devopts.advanced_accordion");
  const devAdvancedAccordionOn = devAdvancedAccordionFlag !== "off";
  const devAiDebugLoggingOn = useFlag("flag.devopts.ai.debug_logging") === "on";

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
  // Wave I: activity-log retention-days input. Surface a placeholder
  // input only when the flag is on so the rendering path stays
  // exercised; v1 keeps the rolling log uncapped.
  const devActivityLogRetentionDaysOn =
    useFlag("flag.devopts.activity_log.retention_days") === "on";
  // Wave I: feature-flag presets row above the Dev Options panel
  // ("Self · understand", "Loved one · declutter" etc.). v1 ships a
  // placeholder note when the flag is on; the preset-apply logic
  // lands later.
  const devFeatureFlagPresetsOn =
    useFlag("flag.devopts.feature_flag_presets") === "on";

  // Wave I: AI Settings sub-flags. These nest inside the AI Policy
  // Summaries card (already gated by `flag.settings.ai.enabled` above)
  // so flipping the parent off hides them all; flipping a child off
  // surgically removes that one input while leaving the rest of the
  // card visible.
  const settingsAiProviderSelectorOn =
    useFlag("flag.settings.ai.provider_selector") === "on";
  const settingsAiTimeoutConfigOn =
    useFlag("flag.settings.ai.timeout_config") === "on";
  const settingsAiSummarizeOnImportOn =
    useFlag("flag.settings.ai.summarize_on_import") === "on";
  const settingsAiDebugLoggingOn =
    useFlag("flag.settings.ai.debug_logging") === "on";
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
  const [deploymentDiagnostics, setDeploymentDiagnostics] =
    useState<DeploymentDiagnostics | null>(null);
  const [deploymentDiagnosticsLoading, setDeploymentDiagnosticsLoading] =
    useState(false);
  const [deploymentDiagnosticsError, setDeploymentDiagnosticsError] =
    useState("");
  const [copyingDeploymentDiagnostics, setCopyingDeploymentDiagnostics] =
    useState(false);
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [adminTokenUnlocked, setAdminTokenUnlocked] = useState(false);
  const [schedule, setSchedule] = useState<Schedule>("manual");
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
  // Advanced accordion in Developer Options is collapsed by default so the
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
  // Saving flag now lives on `scrapeThrottleAutoSave.saving`.
  const [debugLog, setDebugLog] = useState<AiDebugLogRow[] | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugExpandedId, setDebugExpandedId] = useState<string | null>(null);

  // Activity log (server-side operational timeline). Lazy-loaded on first
  // accordion open; `activityLog` stays null until then so we don't pay the
  // network round-trip on every Settings visit.
  const [activityLog, setActivityLog] = useState<ActivityLogRow[] | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [activityTotal, setActivityTotal] = useState(0);
  const [activityTypeFilter, setActivityTypeFilter] = useState<string>("");
  // Secondary filters — all three are empty string = "no filter", so the
  // existing loaders can treat absence the same way they already treat
  // `activityTypeFilter === ''`. Time window is expressed as a preset key
  // that the loader converts into an absolute `since` timestamp at request
  // time (computed client-side to keep the API stateless).
  const [activityStatusFilter, setActivityStatusFilter] = useState<string>("");
  const [activityTimeWindow, setActivityTimeWindow] = useState<string>(""); // '', '5m', '15m', '1h', '6h', '24h', '7d'
  const [activitySortBy, setActivitySortBy] = useState<
    "started_at" | "ended_at" | "duration_ms"
  >("started_at");
  const [activitySortDir, setActivitySortDir] = useState<"asc" | "desc">(
    "desc"
  );
  const [activityExpandedId, setActivityExpandedId] = useState<string | null>(
    null
  );
  const [activityOpen, setActivityOpen] = useState(false);
  // `saving`/`setSaving` used to gate the Sync Schedule Save button.
  // The auto-save renovation moved that to `scheduleAutoSave.saving`,
  // so the standalone state is gone. Other sections still keep their
  // own `savingX` flags for now until they're auto-save'd in turn.
  // Saving flag now lives on `aiSettingsAutoSave.saving` (post-Section 7
  // of the renovation).
  const [syncing, setSyncing] = useState(false);
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
  // Historical import (Wayback Machine). `waybackRunning` tracks whether a
  // streaming bulk import is in flight so we can disable both buttons. The
  // `waybackShowImported` toggle is persisted via the settings API and flows
  // through to the per-app ChangelogTimeline as a visibility filter — when
  // off, the imported rows stay in the DB but the timeline hides them.
  const [waybackRunning, setWaybackRunning] = useState(false);
  const [waybackRunStatus, setWaybackRunStatus] =
    useState<WaybackRunStatus>("idle");
  const [waybackControlBusy, setWaybackControlBusy] = useState<
    null | "pause" | "resume" | "cancel" | "force"
  >(null);
  const [waybackRemoving, setWaybackRemoving] = useState(false);
  // Controls the in-app confirm modal for "Remove all imported history".
  // We avoid `window.confirm` so the UX matches the rest of the app — the
  // reset and delete-import modals use the same `.modal-overlay` pattern.
  const [waybackRemoveOpen, setWaybackRemoveOpen] = useState(false);
  // Ref tracks whether *this* tab currently owns the active bulk-import
  // stream (vs. having rehydrated `waybackRunning` from the server's
  // persisted mutex after a navigation). Used to suppress the GET-poller
  // while the local NDJSON stream is actively updating the same state —
  // otherwise both sources race and the "12/34 · Netflix" line flickers.
  const waybackLocalStreamRef = useRef(false);
  const [waybackSummary, setWaybackSummary] = useState<string | null>(null);
  const [waybackShowImported, setWaybackShowImported] = useState(true);
  const [savedWaybackShowImported, setSavedWaybackShowImported] =
    useState(true);
  // The "is this toggle saving" flag now lives on `waybackToggleAutoSave.saving`.
  // Accessibility nutrition labels UI toggle. The scraper always collects the
  // "Accessibility" shelf (VoiceOver, Voice Control, Larger Text, …) regardless
  // of this flag — it just gates whether the chip on the detail page, the
  // grid filter, and the stats chart are rendered. Default on for new installs
  // so users discover the feature; flipping it off hides everything without
  // stopping data collection, so re-enabling later brings history back.
  const [trackAccessibility, setTrackAccessibility] = useState(true);
  const [savedTrackAccessibility, setSavedTrackAccessibility] = useState(true);

  // Review-queue progress bar toggle. Defaults true; users can mute the
  // bar if they prefer the carousel chrome stripped back. Persisted in
  // app_settings under `queue_show_progress_bar` and read server-side
  // by /dashboard/apps/page.tsx.
  const [queueShowProgressBar, setQueueShowProgressBar] = useState(true);
  const [savedQueueShowProgressBar, setSavedQueueShowProgressBar] =
    useState(true);
  // The "is this toggle saving" flag now lives on `trackAccessibilityAutoSave.saving`.
  // Live-progress tracker, populated from the NDJSON stream so the status
  // block can show "12/34 · Netflix" while the run is in flight. `null`
  // means no run is active (or we're between two app-start events at the
  // start of a run before the first progress tick). Running totals mirror
  // the server-side `BulkTotals` shape so the status card doesn't have to
  // reach into the final summary row to render.
  const [waybackProgress, setWaybackProgress] = useState<{
    index: number;
    total: number;
    currentAppName: string | null;
    imported: number;
    unchanged: number;
    skipped: number;
    failed: number;
  } | null>(null);
  // Tracks whether the currently-running bulk import was triggered manually
  // by this user (the normal case) or auto-resumed by instrumentation.ts
  // after a server restart. The status card shows a distinct "↻ Resumed
  // after restart" banner for the resume case so users understand why a
  // run is in flight without them having clicked anything. `null` means
  // we haven't probed the server yet (or no run is active).
  const [waybackInitiator, setWaybackInitiator] = useState<
    "manual" | "resume" | null
  >(null);
  // Snapshot of the most recent bulk import's summary row, hydrated from
  // /api/activity on mount so reloading the Settings page still shows
  // "last run: 3 imported, 1 failed". Cleared after a fresh run completes
  // so the live tally takes over without mixing stale totals.
  const [waybackLastRun, setWaybackLastRun] = useState<{
    status: "ok" | "partial" | "error" | "cancelled";
    startedAt: number;
    endedAt: number | null;
    summary: string | null;
    totals: {
      appsAttempted: number;
      appsWithImports: number;
      targetsAttempted: number;
      imported: number;
      unchanged: number;
      skipped: number;
      failed: number;
    } | null;
  } | null>(null);
  const [toast, setToast] = useState("");
  const [resetStep, setResetStep] = useState<0 | 1 | 2>(0);
  const [resetting, setResetting] = useState(false);

  // The legacy `userIntent` state used to drive a duplicate Your-Focus
  // radio group below. The card at the top of Settings (YourFocusCard
  // → /dashboard/settings/focus) replaces it; the state plumbing was
  // removed in the same pass that deleted the duplicate JSX. The
  // `/api/preferences` endpoint still exists for any other consumer
  // that reads the field, but Settings no longer reads or writes it.

  // Privacy profile — optional per-category threshold picker. The "enabled"
  // toggle is a UI-only flag: when off, we save `null` (no profile) on Save.
  // When on, we save whatever the editor has. `savedProfile` is what the
  // server last confirmed; `profile` is the working copy the editor mutates.
  const [profileEnabled, setProfileEnabled] = useState(false);
  const [profile, setProfile] = useState<PrivacyProfile>({
    ...DEFAULT_PROFILE,
  });
  const [savedProfile, setSavedProfile] = useState<PrivacyProfile | null>(null);
  // Privacy-profile saving flag now lives on `privacyProfileAutoSave.saving`.

  // ── Cmd+Z undo for privacy-profile + accessibility-profile changes ──
  // Each successful PUT to /api/privacy-profile or /api/accessibility-profile
  // pushes the PRIOR persisted value onto a bounded undo stack. The
  // window-level `app:undo` event (dispatched by KeyboardShortcuts.tsx
  // outside text inputs) replays the top op via the same auto-save
  // pipeline, which keeps the success/error UX consistent with a normal
  // edit. Every category tweak is its own undo step rather than the
  // whole "session of edits", matching the expectation set by the
  // ShortlistView / ChangeReviewPanel undo stacks. We use a ref-backed
  // ring rather than React state because the undo handler reads the
  // stack inside a `useEffect` listener — state would force a fresh
  // listener on every push, the ref doesn't.
  type ProfileUndoOp =
    | { kind: "privacy"; prior: PrivacyProfile | null }
    | { kind: "accessibility"; prior: AccessibilityProfile | null };
  const MAX_PROFILE_UNDO_OPS = 20;
  const profileUndoStackRef = useRef<ProfileUndoOp[]>([]);
  const pushProfileUndo = useCallback((op: ProfileUndoOp) => {
    const stack = profileUndoStackRef.current;
    stack.push(op);
    if (stack.length > MAX_PROFILE_UNDO_OPS) {
      stack.shift();
    }
  }, []);
  // Note: we don't render a dedicated "Restored …" flash here. The undo
  // path replays through privacyProfileAutoSave.save() / a11yProfileAutoSave.save()
  // which already surfaces a "Privacy profile saved" toast via the
  // TaskCenter. The user-visible "the panel just changed" signal is the
  // auto-save toast plus the picker chips snapping to the restored
  // values; an additional flash would be belt-and-braces noise.

  // Accessibility profile — per-feature required/nice picker. Mirrors the
  // privacy profile state machine: the toggle is a UI-only flag that gates
  // whether we save `null` (no profile) or the sanitised editor contents.
  const [a11yProfileEnabled, setA11yProfileEnabled] = useState(false);
  const [a11yProfile, setA11yProfile] = useState<AccessibilityProfile>({
    ...DEFAULT_A11Y_PROFILE,
  });
  const [savedA11yProfile, setSavedA11yProfile] =
    useState<AccessibilityProfile | null>(null);
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

  // Import history state
  const [imports, setImports] = useState<ImportRow[] | null>(null);
  const [expandedImportId, setExpandedImportId] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<
    Record<string, ImportItemRow[]>
  >({});
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  // One-at-a-time inline change-match / re-add widget. When null, no row is
  // being edited.
  const [changeMatch, setChangeMatch] = useState<ChangeMatchState | null>(null);

  // Tick counter used to re-render queued-row countdowns every second. We
  // only bump it while the user has queued items and an import expanded,
  // otherwise the interval is a no-op. The counter value is never read — it
  // just forces a render so `fmtQueueCountdown` recomputes against Date.now().
  const [, setNowTick] = useState(0);
  // Set true while we're kicking a manual drain (bulk "Retry queue now" /
  // per-row retry), so the UI can show a spinner + disable concurrent clicks.
  const [retryingQueue, setRetryingQueue] = useState(false);
  /**
   * Progress state for the foreground drain loop now lives in
   * `ImportQueueProvider` so it survives intra-app navigation — leaving
   * Import History and coming back finds the same progress UI waiting
   * (the provider sits in app/layout.tsx and never unmounts on route
   * change). We just observe `importQueue.drainState` here and call
   * `importQueue.startDrain()` / `importQueue.cancelDrain()` to drive it.
   *
   * The ref + local state from before were removed; this file no longer
   * owns the loop at all. We only register a per-tick callback (below)
   * so the imports list + expanded rows refresh after each tick.
   */
  // Global status filter applied across every expanded import row. null =
  // no filter (default). Read from the `?filter=` URL param on mount so
  // notification deep-links can land pre-filtered; also settable by the
  // clickable summary badges on each import row.
  const [itemStatusFilter, setItemStatusFilter] =
    useState<ItemStatusFilter | null>(null);
  // Bookkeeping: we only want to auto-expand the "most relevant" import
  // *once* per filter change, not on every render. Otherwise the user
  // collapsing the row would just get re-expanded on the next render.
  const autoExpandedForFilter = useRef<string | null>(null);
  // Deep-link focus target: the per-app provenance footer links here with
  // `?importId=…&item=…`, and we auto-expand the row + scroll/highlight the
  // specific item once per landing so the user lands exactly on the row
  // they want to fix. Ref-guarded so a later re-render (e.g. the user
  // collapses the row) doesn't fight them.
  const deepLinkTargetRef = useRef<string | null>(null);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(null);
  // Id of the import item currently being removed from the dashboard. Used to
  // disable + spinner the inline "Remove from dashboard" button on the
  // expanded import-history row (per-item, not per-import — a user may remove
  // several items in quick succession and each row manages its own state).
  const [removingItemId, setRemovingItemId] = useState<string | null>(null);
  /**
   * Confirm-modal target for the inline "Remove from Apps" button on
   * an import-history row. Stages the import row + item + appId so the
   * dialog body can show what will be deleted, and so the same modal
   * can drive the actual deletion via `confirmRemoveItemFromDashboard`.
   * Mirrors the `.modal-overlay` / `.modal-card` pattern used elsewhere
   * in this view (wayback-remove, reset-app).
   */
  const [pendingItemRemoval, setPendingItemRemoval] = useState<null | {
    importRow: ImportRow;
    item: ImportItemRow;
    appId: string;
  }>(null);
  // Id of the import item currently re-scraping its existing App Store URL.
  // Drives the spinner on the "Retry import" button — separate from the
  // change-match apply state so a bare retry (no search UI) doesn't need to
  // open the change-match panel just to reuse its loading state.
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  // Bulk-retry state for the "Retry all" button on the filter banner. We
  // run the retries in sequence on the client (one per request) so Apple
  // doesn't see us hammer it in parallel. Progress is reported in the
  // button label + a post-run toast summary.
  interface RetryAllProgress {
    done: number;
    failed: number;
    succeeded: number;
    total: number;
  }
  const [retryingAll, setRetryingAll] = useState(false);
  const [retryAllProgress, setRetryAllProgress] =
    useState<RetryAllProgress | null>(null);

  // ── Backup & Restore state ─────────────────────────────────────────────
  // The restore flow is three-phase: (1) pick a file, (2) the server previews
  // it and we show counts + a typed-confirmation input, (3) the user types
  // RESTORE and commits. Phase state lives in `restoreStage`; the parsed
  // payload is stashed in `pendingRestore` so we don't re-read the file.
  type BackupRestoreStage = "idle" | "previewing" | "confirm" | "applying";
  interface BackupRestorePreview {
    exportedAt: number | null;
    perTable: { name: string; rows: number }[];
    totalRows: number;
    version: number;
    warnings: string[];
  }
  const [exportingBackup, setExportingBackup] = useState(false);
  const [restoreStage, setRestoreStage] = useState<BackupRestoreStage>("idle");
  const [restorePreview, setRestorePreview] =
    useState<BackupRestorePreview | null>(null);
  const [pendingRestorePayload, setPendingRestorePayload] = useState<
    string | null
  >(null);
  const [pendingRestoreFilename, setPendingRestoreFilename] = useState<
    string | null
  >(null);
  const [restoreError, setRestoreError] = useState<string>("");
  const [restoreConfirmText, setRestoreConfirmText] = useState("");
  const [backupSnapshotSettings, setBackupSnapshotSettings] =
    useState<BackupSnapshotSettings>(DEFAULT_BACKUP_SNAPSHOT_SETTINGS);
  const [backupSnapshotDirectory, setBackupSnapshotDirectory] = useState("");
  const [backupSnapshots, setBackupSnapshots] = useState<BackupSnapshotRow[]>(
    []
  );
  // Saving flag now lives on `backupSnapshotsAutoSave.saving`.
  const [creatingBackupSnapshot, setCreatingBackupSnapshot] = useState(false);

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

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  const loadStatus = async () => {
    const res = await fetch("/api/sync/status");
    const data = await res.json();
    setStatus(data);
    setSchedule(data.schedule ?? "manual");
  };

  const loadDeploymentDiagnostics = async () => {
    setDeploymentDiagnosticsLoading(true);
    try {
      const res = await fetch("/api/deployment/diagnostics", {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as DeploymentDiagnostics;
      setDeploymentDiagnostics(data);
      setDeploymentDiagnosticsError("");
    } catch (error) {
      console.warn("[settings] loadDeploymentDiagnostics failed:", error);
      setDeploymentDiagnosticsError(tDeploy("load_failed"));
    } finally {
      setDeploymentDiagnosticsLoading(false);
    }
  };

  const refreshAdminUnlockState = async () => {
    try {
      const res = await fetch("/api/auth/admin-token/status", {
        cache: "no-store",
      });
      if (!res.ok) {
        setAdminTokenUnlocked(false);
        return;
      }
      const data = (await res.json()) as { unlocked?: boolean };
      setAdminTokenUnlocked(Boolean(data.unlocked));
    } catch {
      setAdminTokenUnlocked(false);
    }
  };

  const saveSessionAdminToken = async () => {
    const token = adminTokenInput.trim();
    if (!token) {
      return;
    }
    try {
      const res = await fetch("/api/auth/admin-token/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        showToast(tDeploy("admin_unlock_failed"));
        return;
      }
      window.dispatchEvent(new Event(ADMIN_TOKEN_CHANGED_EVENT));
      setAdminTokenInput("");
      setAdminTokenUnlocked(true);
      showToast(tDeploy("admin_unlock_saved"));
    } catch {
      showToast(tDeploy("admin_unlock_failed"));
    }
  };

  const clearSessionAdminToken = async () => {
    try {
      await fetch("/api/auth/admin-token/logout", { method: "POST" });
      window.dispatchEvent(new Event(ADMIN_TOKEN_CHANGED_EVENT));
    } catch {
      /* no-op */
    }
    setAdminTokenUnlocked(false);
    setAdminTokenInput("");
    showToast(tDeploy("admin_unlock_cleared"));
  };

  const writeClipboardText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };

  const copyDeploymentSupportBundle = async () => {
    if (copyingDeploymentDiagnostics) {
      return;
    }
    setCopyingDeploymentDiagnostics(true);
    try {
      const res = await fetch("/api/deployment/support-bundle", {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const bundle = await res.json();
      await writeClipboardText(JSON.stringify(bundle, null, 2));
      showToast(tDeploy("copy_success"));
    } catch (error) {
      console.warn("[settings] copyDeploymentSupportBundle failed:", error);
      showToast(tDeploy("copy_failed"));
    } finally {
      setCopyingDeploymentDiagnostics(false);
    }
  };

  const applyBackupSnapshotPayload = (payload: BackupSnapshotsPayload) => {
    setBackupSnapshotSettings(
      payload.settings ?? DEFAULT_BACKUP_SNAPSHOT_SETTINGS
    );
    setBackupSnapshotDirectory(payload.directory ?? "");
    setBackupSnapshots(
      Array.isArray(payload.snapshots) ? payload.snapshots : []
    );
  };

  const loadBackupSnapshots = async () => {
    try {
      const res = await fetch("/api/backup/snapshots", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      applyBackupSnapshotPayload((await res.json()) as BackupSnapshotsPayload);
    } catch (error) {
      console.warn("[settings] loadBackupSnapshots failed:", error);
      showToast(tToast("backup_snapshots_load_failed"));
    }
  };

  // The legacy `handleSaveBackupSnapshotSettings` writer is gone —
  // the three fields auto-save via `backupSnapshotsAutoSave` /
  // `saveBackupSnapshots` defined later in this component.

  const handleCreateBackupSnapshot = async () => {
    if (creatingBackupSnapshot) {
      return;
    }
    setCreatingBackupSnapshot(true);
    try {
      const res = await fetch("/api/backup/snapshots", { method: "POST" });
      if (!res.ok) {
        let msg = tToast("backup_snapshot_create_failed");
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        showToast(msg);
        return;
      }
      applyBackupSnapshotPayload((await res.json()) as BackupSnapshotsPayload);
      showToast(tToast("backup_snapshot_created"));
    } catch (error) {
      console.warn("[settings] createBackupSnapshot failed:", error);
      showToast(tToast("backup_snapshot_create_failed"));
    } finally {
      setCreatingBackupSnapshot(false);
    }
  };

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

    setStoredAi(nextAi);
    setAiProvider(nextAi.provider);
    setAiApiKey(nextAi.apiKey);
    setAiBaseUrl(nextAi.baseUrl);
    setAiModel(nextAi.model);
    // Reveal the API-key field for the custom provider only when the server
    // already has a key stored (round-trips as "__SET__"). Otherwise the
    // field stays hidden — which is the right default for local LLM
    // endpoints that don't use a key at all.
    setCustomApiKeyEnabled(nextAi.provider === "custom" && !!nextAi.apiKey);
    setSummarizeOnImport(nextAi.summarizeOnImport);
    setDebugLogging(nextAi.debugLogging);
    setAiTimeoutDirectMs(nextAi.timeoutDirectMs);
    setAiTimeoutChunkMs(nextAi.timeoutChunkMs);
    setAiTimeoutMergeMs(nextAi.timeoutMergeMs);

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
    setWaybackShowImported(nextShow);
    setSavedWaybackShowImported(nextShow);

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
   * Pull the saved privacy profile from its own endpoint. Missing / cleared
   * profiles come back as `null`; in that case we pre-seed the editor with
   * the DEFAULT_PROFILE so the user sees a sensible starting point the
   * moment they flip the toggle on.
   */
  const loadPrivacyProfile = async () => {
    try {
      const res = await fetch("/api/privacy-profile");
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      // API returns `{ profile: PrivacyProfile | null }` as an already-parsed
      // object, not a JSON string. sanitise to drop any stale/unknown keys
      // before we let the editor render them.
      const rawProfile = data?.profile;
      const parsed = rawProfile ? sanitizeProfile(rawProfile) : null;
      if (parsed && Object.values(parsed).some((v) => typeof v === "string")) {
        setProfile(parsed);
        setSavedProfile(parsed);
        setProfileEnabled(true);
      } else {
        // No profile stored — leave the seed profile in place but mark the
        // toggle off so the editor stays collapsed until the user opts in.
        setSavedProfile(null);
        setProfileEnabled(false);
      }
    } catch (error) {
      console.warn("[settings] loadPrivacyProfile failed:", error);
    }
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
    successMessage: "Notifications saved",
    taskLabel: "Notification preferences updated",
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

  /**
   * Auto-save hook for the Privacy Profile editor. The save shape is
   * the union `PrivacyProfile | null`: `null` means "profile disabled",
   * otherwise it's the sanitized field map. We send the whole thing on
   * every save (the route doesn't support patches) and the server
   * returns the persisted profile so we can re-baseline `savedProfile`.
   *
   * `router.refresh()` runs in onSaved to re-render server components
   * that render the profile chip / mismatch banner with the new data.
   */
  const privacyProfileAutoSave = useSettingsAutoSave<PrivacyProfile | null>({
    endpoint: "/api/privacy-profile",
    method: "PUT",
    buildBody: (value) => ({ profile: value }),
    successMessage: (value) =>
      value ? "Privacy profile saved" : "Privacy profile cleared",
    taskLabel: (value) =>
      value ? "Privacy profile updated" : "Privacy profile cleared",
    onSaved: (value) => {
      // Capture what was on the server BEFORE this save committed so
      // Cmd-Z can replay it. We read off `savedProfile` (the watermark
      // we maintain in this component) and only push when the new
      // value actually differs — saves triggered by unrelated state
      // changes shouldn't pollute the undo stack with no-op ops the
      // user has no mental model for.
      setSavedProfile((prev) => {
        const isDifferent = JSON.stringify(prev) !== JSON.stringify(value);
        if (isDifferent) {
          pushProfileUndo({ kind: "privacy", prior: prev });
        }
        return value;
      });
      router.refresh();
    },
  });

  /**
   * Decide whether the current Privacy Profile state warrants a save,
   * and fire it if so. Skips no-op cases:
   *   - clean (matches savedProfile) → nothing to do
   *   - enabled with all-blank fields → nothing meaningful to persist;
   *     the empty-warning chip in the JSX surfaces this to the user.
   * Called from both the master toggle (immediate, debounce ignored)
   * and the editor onChange (debounced via privacyProfileSaveTimer).
   */
  const runPrivacyProfileSave = useCallback(
    (nextEnabled: boolean, nextProfile: PrivacyProfile) => {
      const payload: PrivacyProfile | null = nextEnabled
        ? sanitizeProfile(nextProfile)
        : null;
      const isDirty = JSON.stringify(payload) !== JSON.stringify(savedProfile);
      if (!isDirty) {
        return;
      }
      const emptyEnabled =
        nextEnabled &&
        Object.values(nextProfile).every((v) => typeof v !== "string");
      if (emptyEnabled) {
        return;
      }
      void privacyProfileAutoSave.save(payload);
    },
    [privacyProfileAutoSave, savedProfile]
  );

  const privacyProfileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const schedulePrivacyProfileSave = useCallback(
    (nextEnabled: boolean, nextProfile: PrivacyProfile) => {
      if (privacyProfileSaveTimer.current) {
        clearTimeout(privacyProfileSaveTimer.current);
      }
      privacyProfileSaveTimer.current = setTimeout(() => {
        privacyProfileSaveTimer.current = null;
        runPrivacyProfileSave(nextEnabled, nextProfile);
      }, 500);
    },
    [runPrivacyProfileSave]
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

  /**
   * Pull the saved accessibility profile. Mirrors loadPrivacyProfile — missing
   * profiles come back as `null` and we leave the DEFAULT_A11Y_PROFILE seed in
   * the editor so the moment the user flips the toggle on they see a sensible
   * starting point.
   */
  const loadA11yProfile = async () => {
    try {
      const res = await fetch("/api/accessibility-profile");
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      const rawProfile = data?.profile;
      const parsed = rawProfile ? sanitizeA11yProfile(rawProfile) : null;
      if (parsed && Object.values(parsed).some((v) => typeof v === "string")) {
        setA11yProfile(parsed);
        setSavedA11yProfile(parsed);
        setA11yProfileEnabled(true);
      } else {
        setSavedA11yProfile(null);
        setA11yProfileEnabled(false);
      }
    } catch (error) {
      console.warn("[settings] loadA11yProfile failed:", error);
    }
  };

  /**
   * Auto-save hook for the Accessibility Profile editor. Mirrors
   * Privacy Profile in shape and lifecycle — same skip rules in
   * `runA11yProfileSave`, same 500 ms debounce on field edits, same
   * router.refresh() on success so the chip / banner pick up the new
   * mismatch counts immediately.
   */
  const a11yProfileAutoSave = useSettingsAutoSave<AccessibilityProfile | null>({
    endpoint: "/api/accessibility-profile",
    method: "PUT",
    buildBody: (value) => ({ profile: value }),
    successMessage: (value) =>
      value ? "Accessibility profile saved" : "Accessibility profile cleared",
    taskLabel: (value) =>
      value ? "Accessibility profile updated" : "Accessibility profile cleared",
    onSaved: (value) => {
      // Mirror the privacy-profile undo capture above. Pushing onto
      // the same stack lets a single Cmd-Z handler replay either
      // kind without us having to grow per-profile listeners that
      // race each other.
      setSavedA11yProfile((prev) => {
        const isDifferent = JSON.stringify(prev) !== JSON.stringify(value);
        if (isDifferent) {
          pushProfileUndo({ kind: "accessibility", prior: prev });
        }
        return value;
      });
      router.refresh();
    },
  });

  const runA11yProfileSave = useCallback(
    (nextEnabled: boolean, nextProfile: AccessibilityProfile) => {
      const payload: AccessibilityProfile | null = nextEnabled
        ? sanitizeA11yProfile(nextProfile)
        : null;
      const isDirty =
        JSON.stringify(payload) !== JSON.stringify(savedA11yProfile);
      if (!isDirty) {
        return;
      }
      const emptyEnabled =
        nextEnabled &&
        Object.values(nextProfile).every((v) => typeof v !== "string");
      if (emptyEnabled) {
        return;
      }
      void a11yProfileAutoSave.save(payload);
    },
    [a11yProfileAutoSave, savedA11yProfile]
  );

  const a11yProfileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const scheduleA11yProfileSave = useCallback(
    (nextEnabled: boolean, nextProfile: AccessibilityProfile) => {
      if (a11yProfileSaveTimer.current) {
        clearTimeout(a11yProfileSaveTimer.current);
      }
      a11yProfileSaveTimer.current = setTimeout(() => {
        a11yProfileSaveTimer.current = null;
        runA11yProfileSave(nextEnabled, nextProfile);
      }, 500);
    },
    [runA11yProfileSave]
  );
  useEffect(
    () => () => {
      if (a11yProfileSaveTimer.current) {
        clearTimeout(a11yProfileSaveTimer.current);
        a11yProfileSaveTimer.current = null;
      }
    },
    []
  );

  // Cmd-Z handler for the profile-undo stack. Pops the top op and
  // replays its prior value through the same auto-save pipeline, which
  // means the success/error toast UX is identical to a normal user
  // edit (no special-case "this came from undo" wording on the
  // server-side activity log either). The handler also re-syncs the
  // editor state — `setProfile`/`setA11yProfile` and the
  // *Enabled toggles — so the UI immediately reflects the restored
  // value without waiting for the auto-save's onSaved to fire.
  //
  // Race note: the user can keep editing while an undo is in flight.
  // The auto-save hook serialises its own writes (latest-wins), so a
  // mid-flight undo can't get clobbered by a fresh edit landing first
  // — both are PUTs to the same endpoint, and the server's UPSERT key
  // collapses them in submission order.
  const handleProfileUndo = useCallback(() => {
    const stack = profileUndoStackRef.current;
    if (stack.length === 0) {
      return;
    }
    const top = stack.pop()!;
    if (top.kind === "privacy") {
      const restored = top.prior;
      // Re-baseline the editor + the enabled toggle so the panel
      // re-paints with the restored values *before* the round-trip
      // returns. This avoids a flash of the post-action state while
      // the PUT is in flight.
      setProfile(restored ?? { ...DEFAULT_PROFILE });
      setProfileEnabled(restored !== null);
      // Same auto-save call the editor uses — it will fire onSaved
      // again with `restored` and naturally push ANOTHER undo op
      // capturing what we're now replacing (i.e. redo via Cmd-Z works
      // out of the box).
      void privacyProfileAutoSave.save(restored);
    } else {
      const restored = top.prior;
      setA11yProfile(restored ?? { ...DEFAULT_A11Y_PROFILE });
      setA11yProfileEnabled(restored !== null);
      void a11yProfileAutoSave.save(restored);
    }
  }, [privacyProfileAutoSave, a11yProfileAutoSave]);

  useEffect(() => {
    const handler = () => {
      handleProfileUndo();
    };
    window.addEventListener("app:undo", handler);
    return () => window.removeEventListener("app:undo", handler);
  }, [handleProfileUndo]);

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
        ? "Policy alert disabled"
        : `Policy alert set to ${value} days`,
    taskLabel: (value) => `Policy alert → ${value} days`,
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
        message: "Policy alert must be 0–3650 days",
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
          ? "Policy throttle: no cooldown"
          : `Policy throttle set to ${minutes} min`
        : "Policy throttle disabled",
    taskLabel: ({ enabled, minutes }) =>
      `Policy throttle → ${enabled ? `${minutes} min` : "off"}`,
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
      disabled ? "Policy scraping disabled" : "Policy scraping re-enabled",
    taskLabel: ({ disabled }) =>
      `Policy scraping → ${disabled ? "disabled" : "enabled"}`,
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
        message: "Policy throttle must be 0–10080 min",
      });
      return;
    }
    saveScrapeThrottle({ enabled: scrapeThrottleEnabled, minutes: parsed });
  }, [scrapeThrottleMinutes, scrapeThrottleEnabled, saveScrapeThrottle]);

  /**
   * Backup snapshot settings live behind PUT `/api/backup/snapshots`,
   * which expects the full `{ enabled, intervalHours, retentionCount }`
   * blob. The route returns the persisted payload so we re-baseline
   * via `applyBackupSnapshotPayload` (covers retention clamps + lastRunAt).
   *
   * Save lifecycle:
   *  - Toggle enabled → immediate save
   *  - Interval dropdown → immediate save (discrete)
   *  - Retention number → save on blur (numeric edit)
   */
  const backupSnapshotsAutoSave = useSettingsAutoSave<{
    enabled: boolean;
    intervalHours: number;
    retentionCount: number;
  }>({
    endpoint: "/api/backup/snapshots",
    method: "PUT",
    buildBody: (value) => value,
    successMessage: (value) =>
      value.enabled
        ? `Backup snapshots: every ${value.intervalHours}h, keep ${value.retentionCount}`
        : "Backup snapshots disabled",
    taskLabel: "Backup snapshot settings updated",
    onSaved: (_value, response) => {
      if (response) {
        applyBackupSnapshotPayload(response as BackupSnapshotsPayload);
      }
    },
  });

  const saveBackupSnapshots = useCallback(
    (next: {
      enabled: boolean;
      intervalHours: number;
      retentionCount: number;
    }) => {
      void backupSnapshotsAutoSave.save(next);
    },
    [backupSnapshotsAutoSave]
  );

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
  const aiTimeoutDirectAutoSave = useSettingsAutoSave<string>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ ai_timeout_direct_ms: value }),
    successMessage: (value) =>
      value === ""
        ? "Direct timeout reset to default"
        : `Direct timeout set to ${value} ms`,
    taskLabel: (value) => `AI direct timeout → ${value || "default"}`,
  });
  const aiTimeoutChunkAutoSave = useSettingsAutoSave<string>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ ai_timeout_chunk_ms: value }),
    successMessage: (value) =>
      value === ""
        ? "Chunk timeout reset to default"
        : `Chunk timeout set to ${value} ms`,
    taskLabel: (value) => `AI chunk timeout → ${value || "default"}`,
  });
  const aiTimeoutMergeAutoSave = useSettingsAutoSave<string>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ ai_timeout_merge_ms: value }),
    successMessage: (value) =>
      value === ""
        ? "Merge timeout reset to default"
        : `Merge timeout set to ${value} ms`,
    taskLabel: (value) => `AI merge timeout → ${value || "default"}`,
  });

  /** Validator shared by all three AI timeout fields. Empty → ok (means
   * "use default"). Non-empty must be an int between 10s and 15min. */
  const validateAiTimeout = useCallback((raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      return null; // empty = default, allowed
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000 || parsed > 15 * 60_000) {
      return "Timeout must be 10000–900000 ms";
    }
    return null;
  }, []);

  const makeAiTimeoutBlurHandler =
    (raw: string, saver: (value: string) => Promise<unknown>) => () => {
      const err = validateAiTimeout(raw);
      if (err) {
        pushSettingsToast({ kind: "error", message: err });
        return;
      }
      void saver(raw.trim());
    };

  // The legacy `saveUserIntent` writer has been removed alongside the
  // duplicate Your-Focus picker. Focus changes now happen via
  // FocusEditForm at /dashboard/settings/focus, which writes to the
  // audience + goals storage modules directly.

  const loadImports = async () => {
    try {
      const res = await fetch("/api/imports");
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as ImportRow[];
      setImports(data);
    } catch (error) {
      // Leave existing state; a toast would be noisy on first load.
      console.warn("[settings] Failed to load import history:", error);
    }
  };

  /**
   * Read `?filter=` on mount (and whenever the query changes) and mirror it
   * into the filter state. Valid values are the `ItemStatusFilter` keys.
   * Anything else is ignored so a malformed deep-link doesn't crash the page.
   */
  useEffect(() => {
    if (!searchParams) {
      return;
    }
    const raw = searchParams.get("filter");
    const valid: ItemStatusFilter[] = [
      "unmatched",
      "error",
      "removed",
      "queued",
      "problems",
    ];
    if (raw && (valid as string[]).includes(raw)) {
      setItemStatusFilter(raw as ItemStatusFilter);
    } else if (raw === null) {
      setItemStatusFilter(null);
    }
  }, [searchParams]);

  /**
   * Deep-link handler for `?importId=…&item=…`, used by the single-app
   * detail page's provenance footer. Two phases:
   *
   *   1) Once `imports` has loaded, expand the matching row via the normal
   *      `toggleImportRow` path so the items fetch runs through the same
   *      spinner + error handling as a manual click.
   *   2) Once that import's items array is available, scroll the target
   *      item into view and flag it for a temporary highlight border.
   *
   * `deepLinkTargetRef` keys both phases off the composite "importId|itemId"
   * so the effect is a one-shot — a later state change (user collapsing
   * the row, clicking another link) doesn't fight them. Highlighting is
   * cleared after ~2.5s so the flash is noticeable without being noisy.
   */
  useEffect(() => {
    if (!searchParams) {
      return;
    }
    const deepImportId = searchParams.get("importId");
    const deepItemId = searchParams.get("item");
    if (!deepImportId) {
      return;
    }
    const key = `${deepImportId}|${deepItemId ?? ""}`;
    if (deepLinkTargetRef.current === key) {
      return;
    }

    if (!imports) {
      return; // still loading — try again after loadImports resolves
    }
    const target = imports.find((row) => row.id === deepImportId);
    if (!target) {
      // Import referenced by the link no longer exists (user deleted it).
      // Mark the deep-link as "done" so we don't loop; the filter banner
      // / toast on the fixed row was always optional.
      deepLinkTargetRef.current = key;
      return;
    }

    deepLinkTargetRef.current = key;
    if (expandedImportId !== target.id) {
      // toggleImportRow is hoisted from below; the immutability rule's
      // stale-closure concern doesn't apply inside useEffect (the body
      // re-runs on each effect invocation, capturing the latest binding).
      // eslint-disable-next-line react-hooks/immutability
      void toggleImportRow(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, imports]);

  // Phase 2 of the deep-link: items finished loading, now scroll to the
  // requested item and flash it. `expandedItems[importId]` becoming truthy
  // is the signal that the fetch resolved.
  useEffect(() => {
    if (!searchParams) {
      return;
    }
    const deepImportId = searchParams.get("importId");
    const deepItemId = searchParams.get("item");
    if (!(deepImportId && deepItemId)) {
      return;
    }
    const items = expandedItems[deepImportId];
    if (!items || items.length === 0) {
      return;
    }
    if (!items.some((it) => it.id === deepItemId)) {
      return;
    }

    // Defer to the next frame so React has actually committed the rendered
    // <li> for the target — without this, getElementById can return null on
    // the first pass.
    const handle = window.requestAnimationFrame(() => {
      const node = document.getElementById(`import-item-${deepItemId}`);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setHighlightItemId(deepItemId);
    });
    const clear = window.setTimeout(() => setHighlightItemId(null), 2500);
    return () => {
      window.cancelAnimationFrame(handle);
      window.clearTimeout(clear);
    };
  }, [searchParams, expandedItems]);

  /**
   * Count attention-worthy items on an import row for a given filter. Used
   * to drive both the "auto-expand the most recent matching import" effect
   * and the "hide imports with zero matches" filter banner.
   *
   * The math mirrors the summary-row badge computation: `unmatchedOnly`
   * subtracts out errored + removed because the server aggregates those
   * into the `unmatched` column.
   */
  const countItemsMatchingFilter = useCallback(
    (row: ImportRow, filter: ItemStatusFilter | null): number => {
      if (!filter) {
        return row.total;
      }
      const errored = row.errored ?? 0;
      const removed = row.removed ?? 0;
      const unmatchedOnly = Math.max(
        0,
        (row.unmatched ?? 0) - errored - removed
      );
      if (filter === "unmatched") {
        return unmatchedOnly;
      }
      if (filter === "error") {
        return errored;
      }
      if (filter === "removed") {
        return removed;
      }
      if (filter === "queued") {
        return row.queued ?? 0;
      }
      if (filter === "problems") {
        return unmatchedOnly + errored;
      }
      return 0;
    },
    []
  );

  /**
   * When the filter changes, auto-expand the most-recent import that has
   * matching items. Tracked via a ref so the expansion only happens *once*
   * per filter change — otherwise collapsing the row would just get re-
   * expanded on the next render.
   */
  useEffect(() => {
    if (!itemStatusFilter) {
      autoExpandedForFilter.current = null;
      return;
    }
    if (!imports || imports.length === 0) {
      return;
    }
    // Key the guard on the specific filter value so switching from
    // `unmatched` to `error` re-triggers the auto-expand against the new
    // filter's best candidate.
    if (autoExpandedForFilter.current === itemStatusFilter) {
      return;
    }
    const target = imports.find(
      (row) => countItemsMatchingFilter(row, itemStatusFilter) > 0
    );
    if (!target) {
      autoExpandedForFilter.current = itemStatusFilter;
      return;
    }
    autoExpandedForFilter.current = itemStatusFilter;
    // Reuse toggleImportRow so the items are fetched through the same
    // path as a manual click (including the loading spinner).
    if (expandedImportId !== target.id) {
      void toggleImportRow(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemStatusFilter, imports, countItemsMatchingFilter]);

  /**
   * Toggle-or-set a filter from a summary-row badge click. Clicking the
   * already-active filter clears it (second click = "oh, never mind").
   * Also mirrors the change into the URL so reloads and shares keep it.
   */
  const handleBadgeClick = (next: ItemStatusFilter) => {
    const resolved = itemStatusFilter === next ? null : next;
    setItemStatusFilter(resolved);
    // Reset the auto-expand guard so the newly-selected filter can expand
    // its most-relevant import next tick.
    autoExpandedForFilter.current = null;
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (resolved) {
        url.searchParams.set("filter", resolved);
      } else {
        url.searchParams.delete("filter");
      }
      window.history.replaceState(null, "", url.toString());
    }
  };

  /** Clear the filter (banner "Clear" button). Mirrors out of the URL too. */
  const clearItemFilter = () => {
    setItemStatusFilter(null);
    autoExpandedForFilter.current = null;
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("filter");
      window.history.replaceState(null, "", url.toString());
    }
  };

  // Load the most recent captured prompt/response pairs. The endpoint already
  // caps the rolling window, so we don't paginate here — one shot is enough
  // for the small "what did I just send?" use case this panel is for.
  const loadDebugLog = async () => {
    setDebugLoading(true);
    try {
      const res = await fetch("/api/ai/debug-log");
      if (!res.ok) {
        showToast(tToast("debug_log_load_failed"));
        setDebugLoading(false);
        return;
      }
      const data = (await res.json()) as { rows?: AiDebugLogRow[] };
      setDebugLog(Array.isArray(data.rows) ? data.rows : []);
    } catch (error) {
      console.error("[settings] Failed to load debug log:", error);
      showToast(tToast("debug_log_load_failed"));
    }
    setDebugLoading(false);
  };

  const clearDebugLog = async () => {
    setDebugLoading(true);
    try {
      const res = await fetch("/api/ai/debug-log", { method: "DELETE" });
      if (!res.ok) {
        showToast(tToast("debug_log_clear_failed"));
        setDebugLoading(false);
        return;
      }
      setDebugLog([]);
      setDebugExpandedId(null);
      showToast(tToast("debug_log_cleared"));
    } catch (error) {
      console.error("[settings] Failed to clear debug log:", error);
      showToast(tToast("debug_log_clear_failed"));
    }
    setDebugLoading(false);
  };

  /**
   * Load the first page of the activity log (or a refreshed page when the
   * filter changes). `append` is for the Load more button; when true we fetch
   * the next page and concat, otherwise we replace.
   */
  // When any of the filters or sort order change, refresh from scratch (but
  // only after the panel has been opened at least once — otherwise the
  // dropdowns firing on mount would kick a spurious fetch).
  useEffect(() => {
    if (activityLog === null) {
      return;
    }
    // loadActivityLog is hoisted from below; same false-positive pattern
    // as the toggleImportRow effect above (immutability's stale-closure
    // concern applies to useCallback, not useEffect).
    // eslint-disable-next-line react-hooks/immutability
    void loadActivityLog(false);
    setActivityExpandedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activityTypeFilter,
    activityStatusFilter,
    activityTimeWindow,
    activitySortBy,
    activitySortDir,
  ]);

  const ACTIVITY_PAGE = 40;

  /**
   * Convert the user-facing time-window preset into an absolute epoch-ms
   * lower bound at request time. We compute `since` here (not on the
   * server) so the API stays fully stateless — no "since-now" semantics
   * tucked away behind a server-clock assumption.
   */
  const timeWindowToSince = (window: string): number | null => {
    if (!window) {
      return null;
    }
    const now = Date.now();
    const units: Record<string, number> = {
      "5m": 5 * 60 * 1000,
      "15m": 15 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "6h": 6 * 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
    };
    const delta = units[window];
    return typeof delta === "number" ? now - delta : null;
  };

  /**
   * Apply all active activity filters + sort to the URLSearchParams used by
   * both `loadActivityLog` and `pollActivityLog`. Pulled into a helper so the
   * two stay in lockstep — drift here was how an earlier iteration ended up
   * polling for unfiltered rows while the user was looking at an "errors
   * only" view.
   */
  const applyActivityQueryParams = (
    params: URLSearchParams,
    overrides?: {
      type?: string;
      status?: string;
      timeWindow?: string;
      sortBy?: string;
      sortDir?: string;
    }
  ) => {
    const type = overrides?.type ?? activityTypeFilter;
    const status = overrides?.status ?? activityStatusFilter;
    const timeWindow = overrides?.timeWindow ?? activityTimeWindow;
    const sortBy = overrides?.sortBy ?? activitySortBy;
    const sortDir = overrides?.sortDir ?? activitySortDir;
    if (type) {
      params.set("type", type);
    }
    if (status) {
      params.set("status", status);
    }
    const since = timeWindowToSince(timeWindow);
    if (since !== null) {
      params.set("since", String(since));
    }
    if (sortBy) {
      params.set("sortBy", sortBy);
    }
    if (sortDir) {
      params.set("sortDir", sortDir);
    }
  };

  const loadActivityLog = async (append = false) => {
    setActivityLoading(true);
    try {
      const offset = append ? (activityLog?.length ?? 0) : 0;
      const params = new URLSearchParams();
      params.set("limit", String(ACTIVITY_PAGE));
      params.set("offset", String(offset));
      applyActivityQueryParams(params);
      const res = await fetch(`/api/activity?${params.toString()}`);
      if (!res.ok) {
        showToast(tToast("activity_log_load_failed"));
        setActivityLoading(false);
        return;
      }
      const data = (await res.json()) as {
        rows?: ActivityLogRow[];
        total?: number;
      };
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const total = typeof data.total === "number" ? data.total : rows.length;
      setActivityTotal(total);
      setActivityLog((prev) => (append && prev ? [...prev, ...rows] : rows));
      const loadedCount =
        (append && activityLog ? activityLog.length : 0) + rows.length;
      setActivityHasMore(loadedCount < total);
    } catch (error) {
      console.error("[settings] Failed to load activity log:", error);
      showToast(tToast("activity_log_load_failed"));
    }
    setActivityLoading(false);
  };

  // ── Live activity polling ─────────────────────────────────────────────
  //
  // While the accordion is open we re-fetch the first page every few seconds
  // and prepend rows we haven't seen yet (keyed by id). This keeps the list
  // feeling live without a server-side event channel.
  //
  // Refs are used so the polling effect can close over the latest filter +
  // loading flag without rebuilding the interval on every state change (which
  // would reset the timer mid-tick and make polling irregular).
  const activityTypeFilterRef = useRef<string>(activityTypeFilter);
  useEffect(() => {
    activityTypeFilterRef.current = activityTypeFilter;
  }, [activityTypeFilter]);
  const activityStatusFilterRef = useRef<string>(activityStatusFilter);
  useEffect(() => {
    activityStatusFilterRef.current = activityStatusFilter;
  }, [activityStatusFilter]);
  const activityTimeWindowRef = useRef<string>(activityTimeWindow);
  useEffect(() => {
    activityTimeWindowRef.current = activityTimeWindow;
  }, [activityTimeWindow]);
  const activitySortByRef = useRef<typeof activitySortBy>(activitySortBy);
  useEffect(() => {
    activitySortByRef.current = activitySortBy;
  }, [activitySortBy]);
  const activitySortDirRef = useRef<typeof activitySortDir>(activitySortDir);
  useEffect(() => {
    activitySortDirRef.current = activitySortDir;
  }, [activitySortDir]);
  const activityLoadingRef = useRef<boolean>(activityLoading);
  useEffect(() => {
    activityLoadingRef.current = activityLoading;
  }, [activityLoading]);

  // User-facing pause switch. Polling also yields to manual-action inflight
  // state (activityLoadingRef) and to `document.hidden` so background tabs
  // don't spam the server.
  const [activityLivePaused, setActivityLivePaused] = useState(false);
  // When a poll prepends a new row we briefly flash the "Live" indicator so
  // the user gets visual confirmation that a fresh row just landed — not just
  // that polling is wired up. `activityFlashing` is flipped true on arrival
  // and auto-cleared ~1.2s later by the effect below.
  const [activityFlashing, setActivityFlashing] = useState(false);

  const ACTIVITY_POLL_MS = 3000;

  const pollActivityLog = useCallback(async () => {
    // Yield to user-initiated fetches so we don't prepend rows mid-scroll
    // or clobber a "Load more" result that's still in flight.
    if (activityLoadingRef.current) {
      return;
    }
    try {
      const params = new URLSearchParams();
      params.set("limit", String(ACTIVITY_PAGE));
      params.set("offset", "0");
      applyActivityQueryParams(params, {
        type: activityTypeFilterRef.current,
        status: activityStatusFilterRef.current,
        timeWindow: activityTimeWindowRef.current,
        sortBy: activitySortByRef.current,
        sortDir: activitySortDirRef.current,
      });
      const res = await fetch(`/api/activity?${params.toString()}`);
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as {
        rows?: ActivityLogRow[];
        total?: number;
      };
      const fresh = Array.isArray(data.rows) ? data.rows : [];
      const total = typeof data.total === "number" ? data.total : fresh.length;
      // `total` may legitimately decrease (retention trims the table at
      // 2,000 rows), so we always sync the footer to the server's latest.
      setActivityTotal(total);
      setActivityLog((prev) => {
        if (prev === null) {
          return prev;
        }
        const existingIds = new Set(prev.map((r) => r.id));
        const newOnly = fresh.filter((r) => !existingIds.has(r.id));
        if (newOnly.length === 0) {
          return prev;
        }
        // Fire the visual pulse from within the state updater so we only
        // flash when a prepend actually happens.
        setActivityFlashing(true);
        return [...newOnly, ...prev];
      });
    } catch {
      // Swallow transient polling errors — the "↻ Refresh" button is still
      // available if the connection stays down, and noisy console logs on
      // every failed tick would bury real problems.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyActivityQueryParams is stable from closure
  }, []);

  // Boolean gate rather than depending on `activityLog` directly — otherwise
  // the effect tears down and resets the timer on every successful prepend.
  const activityLogLoaded = activityLog !== null;

  // Auto-clear the "just-pulsed" flash ~1.2s after the most recent prepend.
  // Decoupled from the polling effect so rapid back-to-back arrivals still
  // reset the timer cleanly without disturbing the interval.
  useEffect(() => {
    if (!activityFlashing) {
      return;
    }
    const t = window.setTimeout(() => setActivityFlashing(false), 1200);
    return () => window.clearTimeout(t);
  }, [activityFlashing]);

  useEffect(() => {
    if (!(activityOpen && activityLogLoaded) || activityLivePaused) {
      return;
    }
    const tick = () => {
      // Hidden tabs: skip the fetch but keep the interval ticking so we
      // resume immediately on visibility change (via the listener below).
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void pollActivityLog();
    };
    const interval = window.setInterval(tick, ACTIVITY_POLL_MS);
    // Immediate catch-up poll when the tab regains focus so the list
    // reflects anything that landed while we were backgrounded.
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        void pollActivityLog();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activityOpen, activityLogLoaded, activityLivePaused, pollActivityLog]);

  const toggleImportRow = async (importRow: ImportRow) => {
    if (expandedImportId === importRow.id) {
      setExpandedImportId(null);
      return;
    }

    setExpandedImportId(importRow.id);

    if (expandedItems[importRow.id]) {
      return;
    }

    setExpandingId(importRow.id);
    try {
      const res = await fetch(
        `/api/imports?id=${encodeURIComponent(importRow.id)}`
      );
      if (!res.ok) {
        showToast(tToast("import_details_load_failed"));
        setExpandingId(null);
        return;
      }
      const data = (await res.json()) as {
        import: ImportRow;
        items: ImportItemRow[];
      };
      setExpandedItems((prev) => ({ ...prev, [importRow.id]: data.items }));
    } catch (error) {
      console.error("[settings] Failed to load import details:", error);
      showToast(tToast("import_details_load_failed"));
    }
    setExpandingId(null);
  };

  const handleRetryItem = (_importRow: ImportRow, item: ImportItemRow) => {
    // Previously: bounced the user back to /onboard with ?retry=&item=.
    // Now that Import History has its own page with a fully-inline
    // change-match search (see `openChangeMatch` + the `change-match-panel`
    // JSX on each expanded row), the redirect is a worse experience —
    // the user loses their place in the history, the onboarding wizard
    // is geared toward first-run, and the fix lands in the same table
    // they're already looking at. So 'Change match' now opens the same
    // search-and-apply flow used on matched/imported rows.
    openChangeMatch(item, "change");
  };

  /**
   * Re-scrape an import item against the App Store URL it already has on
   * record — the "optimistic retry" path. Used for rows that failed to
   * import the first time *despite* having a URL (typically status=error
   * with a transient scrape failure: Apple 5xx, HTML shape drift that's
   * since been fixed, a flaky network on the user's end).
   *
   * Piggy-backs on the change-match endpoint because it already does
   * exactly this — scrape a URL, replace the item's match, flip status
   * to `imported`. We just reuse `item.url` as the target so there's no
   * user choice involved. If the retry fails again, the error bubbles
   * into `scrapeError` the same way the first attempt did, and the user
   * can fall through to "Change match" for a different URL.
   */
  const handleRetryImport = async (
    importRow: ImportRow,
    item: ImportItemRow
  ) => {
    if (!item.url) {
      showToast(tToast("no_url_for_retry"));
      return;
    }
    if (retryingItemId) {
      return;
    }
    setRetryingItemId(item.id);
    try {
      const res = await fetch("/api/imports/items/change-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, url: item.url }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.error ?? `Retry failed (HTTP ${res.status})`;
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }
      const updated = data?.item as ImportItemRow | undefined;
      if (updated) {
        // Splice the refreshed row back in so the status chip flips from
        // error/unmatched → imported without a full list reload.
        setExpandedItems((prev) => {
          const current = prev[importRow.id];
          if (!current) {
            return prev;
          }
          return {
            ...prev,
            [importRow.id]: current.map((row) =>
              row.id === item.id ? updated : row
            ),
          };
        });
      }
      showToast(
        tToast("reimported", {
          name: updated?.appName ?? item.appName ?? item.query ?? "",
        })
      );
      // Counters moved — refresh the summary row + the dashboard's app list.
      await loadImports();
      router.refresh();
    } catch (error) {
      console.error("[settings] retry import failed:", error);
      showToast(tToast("retry_import_failed"));
    } finally {
      setRetryingItemId(null);
    }
  };

  /**
   * Bulk-retry every retryable item in the current filter. Only error and
   * unmatched items with an App Store URL qualify — the rest (no URL at
   * all, or statuses the filter includes that aren't retryable in this
   * sense, like `removed`) are left alone.
   *
   * Runs sequentially so we don't parallel-hammer Apple. Each successful
   * retry splices the refreshed row into `expandedItems` just like the
   * single-item path does, so any open detail pane updates live. Counters
   * and the outer dashboard are refreshed once at the very end.
   *
   * Strategy: we walk every import that has problems according to its
   * summary counters, fetching its items on demand if we don't already
   * have them cached in `expandedItems`, then filter the result to
   * (status ∈ {error, unmatched}) ∧ url ∧ matches-active-filter.
   */
  const handleRetryAllErrors = async () => {
    if (retryingAll) {
      return;
    }
    if (imports === null || imports.length === 0) {
      return;
    }
    // Scope: when a filter is active we use it; otherwise we default to the
    // widest retryable set (unmatched + error). This keeps the button useful
    // when the banner is triggered by "problems" but also lets a power user
    // shift-click it from the `error` filter to retry only errors.
    const scope: ItemStatusFilter = itemStatusFilter ?? "problems";
    const isRetryableStatus = (status: ImportItemStatus) =>
      status === "error" || status === "unmatched";

    setRetryingAll(true);
    setRetryAllProgress(null);

    try {
      // Pass 1: for every import that reports problems in its counters,
      // make sure we have its items in memory. Fetch missing ones in
      // parallel (small N — one per import row) but cap concurrency with
      // a simple Promise.all; per-item retries still run serially below.
      const candidateImports = imports.filter((row) => {
        if (
          !(
            itemMatchesFilter("error", scope) ||
            itemMatchesFilter("unmatched", scope)
          )
        ) {
          return false;
        }
        return (row.errored ?? 0) + (row.unmatched ?? 0) > 0;
      });

      // Collect retryable items from the cache, then fetch anything that
      // isn't cached yet.
      const itemsToRetry: Array<{ importRow: ImportRow; item: ImportItemRow }> =
        [];
      const needFetch: ImportRow[] = [];
      for (const row of candidateImports) {
        const cached = expandedItems[row.id];
        if (cached) {
          for (const item of cached) {
            if (
              isRetryableStatus(item.status) &&
              itemMatchesFilter(item.status, scope) &&
              item.url
            ) {
              itemsToRetry.push({ importRow: row, item });
            }
          }
        } else {
          needFetch.push(row);
        }
      }

      if (needFetch.length > 0) {
        const fetched = await Promise.all(
          needFetch.map(async (row) => {
            try {
              const res = await fetch(
                `/api/imports?id=${encodeURIComponent(row.id)}`
              );
              if (!res.ok) {
                return { row, items: [] as ImportItemRow[] };
              }
              const data = (await res.json()) as { items?: ImportItemRow[] };
              return { row, items: data.items ?? [] };
            } catch (error) {
              console.warn(
                "[settings] retry-all fetch failed for",
                row.id,
                error
              );
              return { row, items: [] as ImportItemRow[] };
            }
          })
        );
        for (const { row, items } of fetched) {
          for (const item of items) {
            if (
              isRetryableStatus(item.status) &&
              itemMatchesFilter(item.status, scope) &&
              item.url
            ) {
              itemsToRetry.push({ importRow: row, item });
            }
          }
        }
      }

      if (itemsToRetry.length === 0) {
        showToast(tToast("no_matching_to_retry"));
        return;
      }

      setRetryAllProgress({
        done: 0,
        total: itemsToRetry.length,
        succeeded: 0,
        failed: 0,
      });

      let succeeded = 0;
      let failed = 0;
      for (let i = 0; i < itemsToRetry.length; i++) {
        const { importRow, item } = itemsToRetry[i];
        try {
          const res = await fetch("/api/imports/items/change-match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemId: item.id, url: item.url }),
          });
          const data = await res.json().catch(() => null);
          if (res.ok) {
            succeeded++;
            const updated = data?.item as ImportItemRow | undefined;
            if (updated) {
              setExpandedItems((prev) => {
                const current = prev[importRow.id];
                if (!current) {
                  return prev;
                }
                return {
                  ...prev,
                  [importRow.id]: current.map((row) =>
                    row.id === item.id ? updated : row
                  ),
                };
              });
            }
          } else {
            failed++;
          }
        } catch (error) {
          console.warn("[settings] retry-all item failed:", item.id, error);
          failed++;
        }
        setRetryAllProgress({
          done: i + 1,
          total: itemsToRetry.length,
          succeeded,
          failed,
        });
      }

      // Refresh counters + outer dashboard once at the end.
      await loadImports();
      router.refresh();

      if (failed === 0) {
        showToast(
          `✓ Retried ${succeeded} import${succeeded === 1 ? "" : "s"} successfully`
        );
      } else if (succeeded === 0) {
        showToast(
          `❌ Retry failed for all ${failed} item${failed === 1 ? "" : "s"}`
        );
      } else {
        showToast(`⚠ Retried ${succeeded} — ${failed} still failing`);
      }
    } catch (error) {
      console.error("[settings] retry-all failed:", error);
      showToast(tToast("bulk_retry_failed"));
    } finally {
      setRetryingAll(false);
      setRetryAllProgress(null);
    }
  };

  /**
   * Kick the server-side import queue worker immediately. Used both by the
   * bulk "Retry queue now" header button and the per-row retry button on
   * queued items (clearing the global pause + zeroing per-item
   * `nextAttemptAt` is a single server-side operation).
   */
  /**
   * Kick the provider's drain loop. The actual orchestration lives in
   * ImportQueueProvider so the progress UI survives navigation. This
   * function just delegates and waits long enough to flip the
   * `retryingQueue` button-busy flag back off when the drain ends.
   *
   * Used to be a 100-line foreground loop in this file — that whole
   * block moved to the provider. See ImportQueueProvider.startDrain
   * for the loop invariants and rate-limit handling.
   */
  const handleRetryQueue = async () => {
    if (retryingQueue) {
      return;
    }
    setRetryingQueue(true);
    importQueue.startDrain();
    // The provider sets drainState=null when its loop exits; we watch
    // that via a useEffect below to flip retryingQueue back off.
  };

  /**
   * Retry a single queued import item — distinct from `handleRetryQueue`
   * which kicks the global drain. The per-row "Retry now" button used to
   * call handleRetryQueue, which meant clicking retry on ONE row started
   * EVERY queued row draining at once. Now this just scrapes the one
   * item and updates that row's status.
   *
   * Falls into the same Apple-rate-limit framework as the global drain
   * (the scraper records a 429 centrally), so a 429 here surfaces in
   * the same RateLimitBanner the global drain uses. The row's status
   * stays `queued` with a fresh next_attempt_at so the next global
   * drain will pick it up after the cooldown.
   */
  const handleRetrySingleItem = async (
    importRow: ImportRow,
    item: ImportItemRow
  ) => {
    if (retryingItemId !== null) {
      return;
    }
    setRetryingItemId(item.id);
    try {
      const res = await fetch("/api/imports/items/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.error ?? `Retry failed (HTTP ${res.status})`;
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }
      // Splice the updated item back into the expanded list so the row
      // visibly transitions queued → imported / error / queued-again.
      const updated = data?.item as ImportItemRow | undefined;
      if (updated) {
        setExpandedItems((prev) => {
          const current = prev[importRow.id];
          if (!current) {
            return prev;
          }
          return {
            ...prev,
            [importRow.id]: current.map((row) =>
              row.id === item.id ? updated : row
            ),
          };
        });
      }
      // Refresh the import-row counters so "X queued / Y errored" badges
      // reflect the change.
      await loadImports();
      // Toast the outcome so the user has clear feedback even when the
      // row is offscreen / collapsed.
      if (data?.status === "imported") {
        showToast(`✓ Imported "${updated?.appName ?? item.query}"`);
      } else if (data?.status === "error") {
        showToast("Retry failed — see row for details");
      } else if (data?.rateLimited?.retryAfterMs) {
        const sec = Math.round(data.rateLimited.retryAfterMs / 1000);
        showToast(`Apple rate-limited us — auto-retry in ~${sec}s`);
      }
    } catch (err) {
      console.error("[settings] single-item retry failed:", err);
      showToast(
        tToast("save_failed_with_message", {
          message: "Retry failed. Check your connection.",
        })
      );
    } finally {
      setRetryingItemId(null);
    }
  };

  /**
   * Cancel a foreground drain in progress. Sets both the ref-backed
   * flag (which the loop checks every iteration) and the React state
   * (which drives the UI feedback). Already-claimed items finish
   * their scrape — we don't try to abort the network call mid-flight,
   * just stop claiming new rows.
   */
  const handleCancelDrain = () => {
    importQueue.cancelDrain();
  };

  // Watch the provider's drainState so we can flip retryingQueue back
  // off when the loop ends (either naturally — queue empty — or
  // because the user cancelled). The provider clears drainState to
  // null on loop exit; this effect fires on that transition.
  useEffect(() => {
    if (importQueue.drainState === null && retryingQueue) {
      setRetryingQueue(false);
    }
  }, [importQueue.drainState, retryingQueue]);

  // Per-tick refresh — register a callback the provider invokes after
  // every tick. Refreshes the imports list (so per-row counts update
  // live during the drain) and any expanded items (so individual
  // rows visibly transition queued → imported / error in real time).
  useEffect(() => {
    // The tick result is unused here — we only need to know that
    // *some* tick completed so we can refresh local state. Drop the
    // parameter entirely to keep the lint clean.
    const unsubscribe = importQueue.onTickComplete(async () => {
      // Refresh the parent imports list (queued / errored / imported
      // counts on each row). Kept lightweight — server returns just
      // counts + meta, not the full item lists.
      try {
        await loadImports();
      } catch (e) {
        console.warn("[settings] loadImports refresh after tick failed:", e);
      }
      // Refresh expanded items so individual rows update in place.
      const expandedIds = Object.keys(expandedItems);
      if (expandedIds.length > 0) {
        await Promise.all(
          expandedIds.map(async (id) => {
            try {
              const res = await fetch(
                `/api/imports?id=${encodeURIComponent(id)}`
              );
              if (!res.ok) {
                return;
              }
              const data = (await res.json()) as {
                import: ImportRow;
                items: ImportItemRow[];
              };
              setExpandedItems((prev) =>
                prev[id] ? { ...prev, [id]: data.items } : prev
              );
            } catch (error) {
              console.warn("[settings] tick refresh failed for", id, error);
            }
          })
        );
      }
    });
    return unsubscribe;
    // expandedItems is referenced inside the callback but we DON'T
    // want to re-register on every expand/collapse — that'd recreate
    // the subscription mid-drain. Reading the latest value works fine
    // because the callback fires ad-hoc, not from a stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importQueue]);

  /**
   * Remove a single imported app from the dashboard without touching the rest
   * of the import batch. The server-side DELETE /api/apps?id=… cascades the
   * app row out of the privacy tables and flips every import item that
   * pointed at it to `status = 'removed'` (via `markImportItemsRemovedForApp`)
   * so the history row remembers what was deleted and a future retry won't
   * silently re-add it.
   *
   * Intended for the inline "Remove from Apps" button on an import item
   * that has a real `appId` attached — matched/imported/queued/error rows
   * that somehow got an app_id all qualify. The user asked for the ability
   * to either fix a bad match OR delete it outright from the same row.
   */
  const handleRemoveItemFromDashboard = async (
    importRow: ImportRow,
    item: ImportItemRow
  ) => {
    const appId = item.appId;
    if (!appId) {
      return;
    }
    if (removingItemId) {
      return;
    }
    // Stage the modal — the actual deletion runs from
    // `confirmRemoveItemFromDashboard` once the user clicks Confirm.
    setPendingItemRemoval({ importRow, item, appId });
  };

  /**
   * Stage 2 of the import-item removal flow. Same network code as the
   * old inline `handleRemoveItemFromDashboard` body — only the `confirm`
   * gate moved out into a real modal owned by `pendingItemRemoval`.
   */
  const confirmRemoveItemFromDashboard = async () => {
    const target = pendingItemRemoval;
    if (!target) {
      return;
    }
    const { importRow, item, appId } = target;
    if (removingItemId) {
      return;
    }
    setRemovingItemId(item.id);
    try {
      const res = await fetch(`/api/apps?id=${encodeURIComponent(appId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        let msg = "Could not remove app";
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }
      // Refresh this import's items + the top-level list so counters + the
      // row's status pill move in lockstep.
      try {
        const detail = await fetch(
          `/api/imports?id=${encodeURIComponent(importRow.id)}`
        );
        if (detail.ok) {
          const data = (await detail.json()) as {
            import: ImportRow;
            items: ImportItemRow[];
          };
          setExpandedItems((prev) =>
            prev[importRow.id] ? { ...prev, [importRow.id]: data.items } : prev
          );
        }
      } catch (err) {
        console.warn("[settings] remove refresh failed:", err);
      }
      await loadImports();
      showToast(tToast("removed_from_apps"));
      setPendingItemRemoval(null);
    } catch (error) {
      console.error("[settings] remove app failed:", error);
      showToast(tToast("remove_app_failed"));
    }
    setRemovingItemId(null);
  };

  // ── Backup & Restore handlers ──────────────────────────────────────────
  /**
   * Download a full-DB backup as JSON. We fetch through JS (instead of a plain
   * <a download> link) so we can surface server-side errors (rate-limit, admin
   * token missing, etc.) without letting the browser dump an error page into
   * a file.
   */
  const handleExportBackup = async () => {
    if (exportingBackup) {
      return;
    }
    setExportingBackup(true);
    try {
      const res = await fetch("/api/backup/export");
      if (!res.ok) {
        let msg = "Export failed";
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }
      const blob = await res.blob();
      // Prefer the server-assigned filename from Content-Disposition so the
      // ISO timestamp matches what the server recorded in audit_log.
      let filename = "privacytracker-backup.json";
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^";]+)"?/i);
      if (match) {
        filename = match[1];
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showToast(tToast("backup_downloaded"));
    } catch (error) {
      console.error("[settings] backup export failed:", error);
      showToast(tToast("backup_download_failed"));
    } finally {
      setExportingBackup(false);
    }
  };

  const resetRestoreFlow = () => {
    setRestoreStage("idle");
    setRestorePreview(null);
    setPendingRestorePayload(null);
    setPendingRestoreFilename(null);
    setRestoreError("");
    setRestoreConfirmText("");
  };

  /**
   * Handle the chosen backup file: read it, POST to /api/backup/preview for
   * validation, and move the flow into the typed-confirmation stage. We stash
   * the raw text so the commit step doesn't need to re-read the file.
   */
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
        throw new Error("File is not valid JSON.");
      }
      const res = await fetch("/api/backup/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(previewBody),
      });
      if (!res.ok) {
        let msg = "Could not validate backup";
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        throw new Error(msg);
      }
      const preview = (await res.json()) as BackupRestorePreview;
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

  /**
   * Commit the stashed backup payload. On success, reload imports + schedule
   * status so the UI reflects the restored state — the user may have landed
   * in a completely different data world than the one they were looking at.
   */
  const handleRestoreConfirm = async () => {
    if (!pendingRestorePayload) {
      return;
    }
    if (restoreConfirmText.trim().toUpperCase() !== "RESTORE") {
      setRestoreError("Type RESTORE to confirm.");
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
        let msg = "Restore failed";
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
      showToast(tToast("backup_restored"));
      // Small delay so the toast is visible before the hard reload.
      setTimeout(() => {
        window.location.reload();
      }, 600);
    } catch (error) {
      console.error("[settings] restore commit failed:", error);
      setRestoreError(
        error instanceof Error ? error.message : "Restore failed"
      );
      setRestoreStage("confirm");
    }
  };

  // ── Change-match / re-add inline widget ────────────────────────────────

  const openChangeMatch = (item: ImportItemRow, mode: "change" | "readd") => {
    setChangeMatch({
      itemId: item.id,
      mode,
      query: item.editedQuery || item.query,
      // Pre-fill the seller hint from whatever the item already has on it —
      // either the developer we resolved the last time we scraped this row,
      // or the hint carried in from the original CSV import. Falls back to
      // empty string so the input is controlled.
      developer: item.developer ?? "",
      results: null,
      searching: false,
      error: "",
      applyingAppleId: null,
    });
  };

  const closeChangeMatch = () => setChangeMatch(null);

  const runChangeMatchSearch = async () => {
    if (!changeMatch) {
      return;
    }
    const name = changeMatch.query.trim();
    if (!name) {
      setChangeMatch((prev) =>
        prev ? { ...prev, error: "Enter an app name to search." } : prev
      );
      return;
    }
    const developer = changeMatch.developer.trim();
    setChangeMatch((prev) =>
      prev ? { ...prev, searching: true, error: "", results: null } : prev
    );
    try {
      // When the user has provided a seller hint, send the structured `rows`
      // payload so the server can re-rank iTunes candidates against the
      // developer — same treatment the onboarding import gives CSV rows that
      // carry a seller column. Falling back to `names` preserves the old
      // behaviour for name-only searches.
      const body = developer
        ? { rows: [{ name, developer }] }
        : { names: [name] };
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setChangeMatch((prev) =>
          prev
            ? {
                ...prev,
                searching: false,
                error: data?.error ?? "Search failed.",
              }
            : prev
        );
        return;
      }
      const results =
        Array.isArray(data.results) && data.results[0]?.candidates
          ? (data.results[0].candidates as AppCandidate[])
          : [];
      setChangeMatch((prev) =>
        prev ? { ...prev, searching: false, results, error: "" } : prev
      );
    } catch (error) {
      console.error("[settings] change-match search failed:", error);
      setChangeMatch((prev) =>
        prev
          ? {
              ...prev,
              searching: false,
              error: "Search failed. Check your connection.",
            }
          : prev
      );
    }
  };

  const applyChangeMatch = async (
    importRow: ImportRow,
    item: ImportItemRow,
    candidate: AppCandidate
  ) => {
    if (!changeMatch) {
      return;
    }
    setChangeMatch((prev) =>
      prev ? { ...prev, applyingAppleId: candidate.appleId, error: "" } : prev
    );
    try {
      const editedQuery = changeMatch.query.trim();
      const res = await fetch("/api/imports/items/change-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          url: candidate.url,
          editedQuery:
            editedQuery && editedQuery !== item.query ? editedQuery : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.error ?? `Change-match failed (HTTP ${res.status})`;
        setChangeMatch((prev) =>
          prev ? { ...prev, applyingAppleId: null, error: msg } : prev
        );
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }

      const updated = data?.item as ImportItemRow | undefined;
      // Splice the updated item back into the expanded list so the UI reflects
      // the new match without a full reload of every item in the batch.
      if (updated) {
        setExpandedItems((prev) => {
          const current = prev[importRow.id];
          if (!current) {
            return prev;
          }
          return {
            ...prev,
            [importRow.id]: current.map((row) =>
              row.id === item.id ? updated : row
            ),
          };
        });
      }
      showToast(
        changeMatch.mode === "readd"
          ? `✓ Re-added "${candidate.name}"`
          : `✓ Match updated to "${candidate.name}"`
      );
      closeChangeMatch();
      // Counters moved (imported/removed/matched) — refresh the summary row.
      await loadImports();
      // Dashboard's app list changed as well (new app added, possibly old
      // one removed) — nudge a revalidation.
      router.refresh();
    } catch (error) {
      console.error("[settings] apply change-match failed:", error);
      setChangeMatch((prev) =>
        prev
          ? { ...prev, applyingAppleId: null, error: "Could not apply match." }
          : prev
      );
      showToast(tToast("apply_match_failed"));
    }
  };

  const confirmDeleteImport = async () => {
    if (!deleteTarget) {
      return;
    }
    setDeleting(true);
    try {
      const query = new URLSearchParams({
        id: deleteTarget.importRow.id,
        removeApps: deleteTarget.mode === "with-apps" ? "true" : "false",
      });
      const res = await fetch(`/api/imports?${query.toString()}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(
          tToast("save_failed_with_message", {
            message: data?.error ?? tToast("delete_failed_fallback"),
          })
        );
        setDeleting(false);
        return;
      }

      if (deleteTarget.mode === "with-apps") {
        const count = data?.deletedApps ?? 0;
        showToast(
          count
            ? `✓ Import removed · ${count} app${count === 1 ? "" : "s"} deleted`
            : "✓ Import removed"
        );
      } else {
        showToast(tToast("import_entry_removed"));
      }

      setDeleteTarget(null);
      setExpandedImportId((prev) =>
        prev === deleteTarget.importRow.id ? null : prev
      );
      setExpandedItems((prev) => {
        if (!prev[deleteTarget.importRow.id]) {
          return prev;
        }
        const next = { ...prev };
        delete next[deleteTarget.importRow.id];
        return next;
      });
      await loadImports();

      // If apps were deleted, the dashboard's app list is stale; nudge a refresh
      // on navigation by requesting the router to revalidate.
      if (deleteTarget.mode === "with-apps") {
        router.refresh();
      }
    } catch (error) {
      console.error("[settings] Import delete failed:", error);
      showToast(tToast("delete_failed"));
    }
    setDeleting(false);
  };

  /**
   * Probe the Wayback import-all GET endpoint to find out whether a bulk run
   * is currently in flight. Used on mount to rehydrate the status card after
   * a navigation: if the server-side mutex is still set we can't reattach
   * to the original POST body (it closed when the user navigated away), but
   * we *can* read the persisted progress blob and keep polling until the
   * run finishes. When the poller observes `running === false`, it calls
   * `loadWaybackLastRun()` so the card flips from "in progress" to the
   * final summary without a reload.
   */
  const loadWaybackProgress = async (): Promise<{
    running: boolean;
    status: WaybackRunStatus;
    initiator: "manual" | "resume" | null;
    progress: {
      index: number;
      total: number;
      currentAppName: string | null;
      imported: number;
      unchanged: number;
      skipped: number;
      failed: number;
    } | null;
  } | null> => {
    try {
      const res = await fetch("/api/wayback/import-all");
      if (!res.ok) {
        return null;
      }
      const data = await res.json();
      const running = !!data?.running;
      const rawStatus = typeof data?.status === "string" ? data.status : "";
      const status: WaybackRunStatus =
        rawStatus === "running" ||
        rawStatus === "pause_requested" ||
        rawStatus === "paused" ||
        rawStatus === "cancel_requested" ||
        rawStatus === "stale"
          ? rawStatus
          : running
            ? "running"
            : "idle";
      // Derive initiator from the state blob. When no blob exists (e.g. a
      // stale mutex mid-heal) we fall back to null so the UI doesn't claim
      // "resumed" for a run we can't characterise.
      const rawInitiator = (data?.state as { initiator?: unknown } | null)
        ?.initiator;
      const initiator: "manual" | "resume" | null =
        rawInitiator === "manual" || rawInitiator === "resume"
          ? rawInitiator
          : null;
      let progress: {
        index: number;
        total: number;
        currentAppName: string | null;
        imported: number;
        unchanged: number;
        skipped: number;
        failed: number;
      } | null = null;
      // Map the runner's richer response onto the card's existing shape so
      // we don't have to rewrite every consumer:
      //   index  = summary.done + summary.inProgress  (apps we've reached)
      //   total  = summary.total
      //   totals = state.totals  (imported/unchanged/skipped/failed)
      // This keeps live-stream updates (coming from `setWaybackProgress` in
      // the POST handler below) and poll-driven updates on the same shape.
      if (data?.summary && data?.state) {
        const summary = data.summary as {
          total?: number;
          done?: number;
          inProgress?: number;
        };
        const totals =
          (data.state as { totals?: Record<string, unknown> }).totals ?? {};
        progress = {
          index: Number(summary.done ?? 0) + Number(summary.inProgress ?? 0),
          total: Number(summary.total ?? 0),
          currentAppName:
            typeof data.currentAppName === "string"
              ? data.currentAppName
              : null,
          imported: Number(totals.imported ?? 0),
          unchanged: Number(totals.unchanged ?? 0),
          skipped: Number(totals.skipped ?? 0),
          failed: Number(totals.failed ?? 0),
        };
      }
      return { running, status, initiator, progress };
    } catch (error) {
      console.warn("[settings] loadWaybackProgress failed:", error);
      return null;
    }
  };

  /**
   * Hydrate the Wayback "last run" status block from the activity log. We
   * fetch the most recent N wayback_import rows and pick the newest one
   * whose detail blob has `mode: 'bulk'` — that's the batch-summary row
   * inserted by `/api/wayback/import-all`. The per-app rows (mode: 'app'
   * or 'bulk-app') are intentionally skipped here because the status card
   * is describing the whole batch, not individual scrapes.
   */
  const loadWaybackLastRun = async () => {
    try {
      const res = await fetch("/api/activity?type=wayback_import&limit=30");
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const summaryRow = rows.find(
        (row: { detail?: { mode?: string; removed?: boolean } | null }) =>
          row.detail?.mode === "bulk" && !row.detail?.removed
      );
      if (!summaryRow) {
        return;
      }
      const detailTotals =
        (summaryRow.detail as { totals?: Record<string, unknown> } | null)
          ?.totals ?? null;
      const normalisedTotals = detailTotals
        ? {
            appsAttempted: Number(detailTotals.appsAttempted ?? 0),
            appsWithImports: Number(detailTotals.appsWithImports ?? 0),
            targetsAttempted: Number(detailTotals.targetsAttempted ?? 0),
            imported: Number(detailTotals.imported ?? 0),
            unchanged: Number(detailTotals.unchanged ?? 0),
            skipped: Number(detailTotals.skipped ?? 0),
            failed: Number(detailTotals.failed ?? 0),
          }
        : null;
      const status = summaryRow.status as
        | "ok"
        | "partial"
        | "error"
        | "cancelled"
        | undefined;
      setWaybackLastRun({
        status: status ?? "ok",
        startedAt: Number(summaryRow.startedAt ?? 0),
        endedAt:
          typeof summaryRow.endedAt === "number" ? summaryRow.endedAt : null,
        summary:
          typeof summaryRow.summary === "string" ? summaryRow.summary : null,
        totals: normalisedTotals,
      });
    } catch (error) {
      console.warn("[settings] loadWaybackLastRun failed:", error);
    }
  };

  useEffect(() => {
    void Promise.all([
      loadStatus(),
      loadSettings(),
      loadImports(),
      loadPreferences(),
      loadPrivacyProfile(),
      loadA11yProfile(),
      loadNotificationPrefs(),
      loadWaybackLastRun(),
      loadDeploymentDiagnostics(),
      loadBackupSnapshots(),
    ]);
    // Rehydrate the live bulk-import status card if a run was already in
    // flight when the user navigated back to Settings. If the server-side
    // mutex is set, we know something is running; we can't reattach to the
    // original streaming body (it belonged to another tab / navigation) so
    // we fall back to polling the persisted progress blob until the mutex
    // clears, at which point we refresh `waybackLastRun` to flip the card
    // to its final-summary state.
    let cancelled = false;
    (async () => {
      const snap = await loadWaybackProgress();
      if (!snap || cancelled) {
        return;
      }
      setWaybackRunStatus(snap.status);
      setWaybackRunning(snap.running);
      setWaybackInitiator(snap.initiator);
      if (snap.progress) {
        setWaybackProgress(snap.progress);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once effect
  }, []);

  useEffect(() => {
    refreshAdminUnlockState();
    window.addEventListener(ADMIN_TOKEN_CHANGED_EVENT, refreshAdminUnlockState);
    return () =>
      window.removeEventListener(
        ADMIN_TOKEN_CHANGED_EVENT,
        refreshAdminUnlockState
      );
  }, []);

  // Poll the GET endpoint while the persisted mutex reports a run in flight
  // that *this tab* didn't start. Stops the moment we observe `running ===
  // false` and re-hydrates the "Last run" summary so the status card flips
  // cleanly from "3/12 · Netflix" → "Last run: 3 imported, 1 failed".
  // The local `runBulkWaybackImport` path already keeps its own state fresh
  // from the NDJSON stream, so we skip the poller while *this* tab owns the
  // active fetch — otherwise we'd double-update `waybackProgress` from two
  // sources at slightly different cadences and see the values flicker.
  useEffect(() => {
    if (!waybackRunning) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      // Skip the network call while the local stream owns the state —
      // otherwise both sources race on setWaybackProgress and the status
      // numbers flicker as they converge.
      if (waybackLocalStreamRef.current) {
        return;
      }
      const snap = await loadWaybackProgress();
      if (cancelled || !snap) {
        return;
      }
      setWaybackRunStatus(snap.status);
      if (snap.running) {
        setWaybackInitiator(snap.initiator);
        if (snap.progress) {
          setWaybackProgress(snap.progress);
        }
      } else {
        // Run finished on the server (or was aborted). Release our local
        // "running" flag and pull the final summary into the card.
        setWaybackRunning(false);
        if (snap.status !== "paused" && snap.status !== "pause_requested") {
          setWaybackProgress(null);
        }
        setWaybackInitiator(null);
        if (snap.status !== "paused" && snap.status !== "pause_requested") {
          void loadWaybackLastRun();
        }
      }
    };
    const id = window.setInterval(() => {
      void tick();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [waybackRunning]);

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
  // globals.css) for 1.6s. We force a reflow between remove→add so
  // re-clicking the same anchor re-triggers the animation.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
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
        // Smooth-scroll via rAF so the pulse starts after the scroll
        // begins, not in the middle of the initial paint. Without this
        // the animation occasionally gets clobbered by the browser's
        // scroll-restoration before the class applies.
        requestAnimationFrame(() => {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.remove("settings-section-pulse");
          // Force reflow so the re-added class restarts the keyframes.
          void el.offsetWidth;
          el.classList.add("settings-section-pulse");
          window.setTimeout(
            () => el.classList.remove("settings-section-pulse"),
            1900
          );
        });
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  // One-second tick to keep queued-row countdowns ("next retry in ~42s")
  // fresh between the 10s provider polls. We only run the interval while
  // there are queued items — no point re-rendering otherwise.
  const hasQueuedItems =
    importQueue.state.queued > 0 ||
    Object.values(expandedItems).some((list) =>
      list.some((i) => i.status === "queued")
    );
  useEffect(() => {
    if (!hasQueuedItems) {
      return;
    }
    const id = setInterval(() => setNowTick((t) => (t + 1) & 0xff_ff), 1000);
    return () => clearInterval(id);
  }, [hasQueuedItems]);

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
        ? "Sync set to manual"
        : value === "daily"
          ? "Sync scheduled daily"
          : "Sync scheduled weekly",
    taskLabel: (value) => `Sync schedule → ${value}`,
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
      return opt ? `Region set to ${opt.label}` : "Region saved";
    },
    taskLabel: (value) => `Region → ${value.toUpperCase()}`,
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
        ? "AI summaries disabled"
        : `AI provider saved (${v.provider})`,
    taskLabel: (v) =>
      v.provider === "disabled"
        ? "AI summaries disabled"
        : `AI provider → ${v.provider}`,
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

  const triggerSync = async () => {
    setSyncing(true);
    // The sync runs server-side regardless of page navigation, but we still
    // register with the Task Center so the user can see "Syncing all apps"
    // from any page and cancel the client-side wait (the server-side job is
    // protected by its own sync_running mutex).
    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title: "Syncing App Store pages",
      subtitle: "Scanning App Store for label changes",
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
        handle.complete("done", "Another sync was already running");
      } else {
        const msg = `${data.synced} apps synced · ${data.changes} change${data.changes === 1 ? "" : "s"}`;
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
        handle.complete("error", (err as Error)?.message ?? "Sync failed");
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
        ? "Summarising all privacy policies"
        : "Re-scraping all privacy policies";
    const handle = taskCenter.startTask({
      title: taskTitle,
      subtitle: "Preparing…",
      kind: "sync",
      href: "/dashboard/settings#privacy-policies-bulk",
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
          errBody?.error ?? `Bulk policy sync failed (${res.status})`;
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
              subtitle: `Queued ${event.total} app${event.total === 1 ? "" : "s"}…`,
            });
          } else if (event.type === "app-start") {
            const n = (event.index ?? 0) + 1;
            const total = event.total ?? "?";
            handle.update({
              subtitle: `${n}/${total} · ${event.name}`,
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
              subtitle: `${n}/${total} · ${badge} ${event.name}`,
            });
          } else if (event.type === "summary") {
            totals = event.totals;
          } else if (event.type === "error") {
            throw new Error(event.error ?? "Bulk sync failed");
          }
        }
      }

      if (totals) {
        const parts = [`${totals.succeeded} ok`];
        if (totals.failed) {
          parts.push(`${totals.failed} failed`);
        }
        if (totals.throttled) {
          parts.push(`${totals.throttled} throttled`);
        }
        const verb = phase === "all" ? "summarise" : "scrape";
        const line = `Bulk policy ${verb}: ${parts.join(", ")}`;
        setPolicyBulkSummary(line);
        handle.complete(totals.failed > 0 ? "error" : "done", line);
        showToast(totals.failed > 0 ? `⚠ ${line}` : `✓ ${line}`);
      } else {
        handle.complete("done", "Finished");
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        handle.complete("error", "Cancelled");
      } else {
        console.error("[settings] Bulk policy sync failed:", err);
        const message = (err as Error)?.message ?? "Bulk policy sync failed";
        showToast(tToast("save_failed_with_message", { message }));
        handle.complete("error", message);
        setPolicyBulkSummary(message);
      }
    } finally {
      setPolicyBulkRunning(null);
    }
  };

  /**
   * Drive `POST /api/wayback/import-all?stream=1` in NDJSON streaming mode.
   * Same TaskCenter wiring as the policy-sync path so the user can navigate
   * away — the bulk import can take a while, since archive.org's Save/
   * availability endpoints add tens of seconds per app and we run
   * sequentially to stay polite. Totals are displayed inline once the
   * stream closes; anything that arrives on the wire mid-run is relayed
   * into the task subtitle as "n/N · AppName".
   */
  const runBulkWaybackImport = async (options: { force?: boolean } = {}) => {
    if (waybackRunning && !options.force) {
      return;
    }
    if (options.force) {
      setWaybackControlBusy("force");
    }
    // Mark this tab as the owner of the active stream so the cross-tab
    // rehydration poller gets out of the way. Cleared in `finally`.
    waybackLocalStreamRef.current = true;
    setWaybackRunning(true);
    setWaybackRunStatus("running");
    setWaybackInitiator("manual");
    setWaybackSummary(null);
    // Reset any stale live state from a prior run. Note we deliberately
    // don't clear `waybackLastRun` here — keeping the previous summary
    // visible alongside "in progress…" helps users confirm a new run is
    // actually replacing the right one.
    setWaybackProgress({
      index: 0,
      total: 0,
      currentAppName: null,
      imported: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });

    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title: "Importing privacy-label history",
      subtitle: "Preparing…",
      kind: "sync",
      href: "/dashboard/settings#wayback-import",
      onCancel: () => {
        void controlWaybackImport("cancel");
      },
    });

    let totals: {
      appsAttempted: number;
      appsWithImports: number;
      targetsAttempted: number;
      imported: number;
      unchanged: number;
      skipped: number;
      failed: number;
    } | null = null;
    let terminalStatus: WaybackRunStatus | null = null;

    try {
      const params = new URLSearchParams({ stream: "1" });
      if (options.force) {
        params.set("force", "1");
      }
      const res = await fetch(`/api/wayback/import-all?${params.toString()}`, {
        method: "POST",
        signal: controller.signal,
      });

      if (!(res.ok && res.body)) {
        const errBody = await res.json().catch(() => null);
        const message =
          errBody?.error ?? `Wayback import failed (${res.status})`;
        showToast(tToast("save_failed_with_message", { message }));
        handle.complete("error", message);
        setWaybackSummary(message);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffered = "";

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
            setWaybackRunStatus("running");
            handle.update({
              subtitle: `Queued ${event.total} app${event.total === 1 ? "" : "s"}…`,
            });
            setWaybackProgress((prev) => ({
              ...(prev ?? {
                imported: 0,
                unchanged: 0,
                skipped: 0,
                failed: 0,
              }),
              index: 0,
              total: Number(event.total ?? 0),
              currentAppName: null,
              imported: 0,
              unchanged: 0,
              skipped: 0,
              failed: 0,
            }));
          } else if (event.type === "app-start") {
            const n = (event.index ?? 0) + 1;
            const total = event.total ?? "?";
            handle.update({ subtitle: `${n}/${total} · ${event.name}` });
            setWaybackProgress((prev) =>
              prev
                ? {
                    ...prev,
                    index: n,
                    total: Number(event.total ?? prev.total),
                    currentAppName: String(event.name ?? ""),
                  }
                : prev
            );
          } else if (event.type === "target") {
            // `target` events are high-volume (one per quarter per app); we
            // don't push them into the task subtitle to avoid flickering,
            // but they drive the overall progress on the in-memory totals.
          } else if (event.type === "app-done") {
            const n = (event.index ?? 0) + 1;
            const total = event.total ?? "?";
            const imported = event.result?.imported ?? 0;
            const failed = event.result?.failed ?? 0;
            const badge =
              event.error || failed > 0 ? "⚠" : imported > 0 ? "⟳" : "✓";
            handle.update({
              subtitle: `${n}/${total} · ${badge} ${event.name}`,
            });
            setWaybackProgress((prev) =>
              prev
                ? {
                    ...prev,
                    index: n,
                    imported:
                      prev.imported + Number(event.result?.imported ?? 0),
                    unchanged:
                      prev.unchanged + Number(event.result?.unchanged ?? 0),
                    skipped: prev.skipped + Number(event.result?.skipped ?? 0),
                    // A top-level `event.error` means the entire app call
                    // threw — count it as a single failed app alongside the
                    // per-target failed counts so "Failed: N" on the status
                    // card always adds up to the number of apps the user
                    // should investigate.
                    failed:
                      prev.failed +
                      Number(event.result?.failed ?? 0) +
                      (event.error ? 1 : 0),
                  }
                : prev
            );
          } else if (event.type === "summary") {
            totals = event.totals;
          } else if (event.type === "paused") {
            terminalStatus = "paused";
            const remaining = Number(event.summary?.remaining ?? 0);
            const total = Number(event.summary?.total ?? 0);
            const line = `Wayback import paused — ${remaining} of ${total} app${total === 1 ? "" : "s"} remaining`;
            setWaybackSummary(line);
            handle.complete("cancelled", line);
            showToast(line);
          } else if (event.type === "cancelled") {
            terminalStatus = "idle";
            const remaining = Number(event.summary?.remaining ?? 0);
            const total = Number(event.summary?.total ?? 0);
            const line = `Wayback import cancelled — ${remaining} of ${total} app${total === 1 ? "" : "s"} not processed`;
            setWaybackSummary(line);
            handle.complete("cancelled", line);
            showToast(line);
          } else if (event.type === "error") {
            throw new Error(event.error ?? "Wayback import failed");
          }
        }
      }

      if (totals) {
        const parts: string[] = [];
        parts.push(`${totals.imported} imported`);
        if (totals.unchanged) {
          parts.push(`${totals.unchanged} no-op`);
        }
        if (totals.skipped) {
          parts.push(`${totals.skipped} skipped`);
        }
        if (totals.failed) {
          parts.push(`${totals.failed} failed`);
        }
        const line = `Wayback import across ${totals.appsAttempted} app${totals.appsAttempted === 1 ? "" : "s"}: ${parts.join(", ")}`;
        setWaybackSummary(line);
        terminalStatus = "idle";
        handle.complete(totals.failed > 0 ? "error" : "done", line);
        showToast(totals.failed > 0 ? `⚠ ${line}` : `✓ ${line}`);
      } else if (!terminalStatus) {
        terminalStatus = "idle";
        handle.complete("done", "Finished");
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        terminalStatus = "cancel_requested";
        setWaybackRunStatus("cancel_requested");
        handle.complete("cancelled", "Cancelling Wayback import…");
      } else {
        console.error("[settings] Wayback import failed:", err);
        const message = (err as Error)?.message ?? "Wayback import failed";
        showToast(tToast("save_failed_with_message", { message }));
        handle.complete("error", message);
        setWaybackSummary(message);
      }
    } finally {
      waybackLocalStreamRef.current = false;
      setWaybackRunning(false);
      setWaybackControlBusy(null);
      // Clear the in-flight progress tracker and re-hydrate the last-run
      // summary from the activity log so the status card transitions from
      // "12/34 · Netflix" to "Last run: 3 imported, 1 failed — just now"
      // without needing a page reload. The activity row is written by the
      // server before the stream closes, so by the time we land here the
      // new summary should be queryable.
      if (terminalStatus !== "paused") {
        setWaybackProgress(null);
      }
      setWaybackRunStatus(terminalStatus ?? "idle");
      setWaybackInitiator(null);
      if (terminalStatus !== "paused") {
        void loadWaybackLastRun();
      }
    }
  };

  const controlWaybackImport = async (
    action: "pause" | "resume" | "cancel"
  ) => {
    if (waybackControlBusy) {
      return;
    }
    setWaybackControlBusy(action);
    try {
      const res = await fetch("/api/wayback/import-all", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          data?.error ?? `Wayback ${action} failed (${res.status})`;
        showToast(tToast("save_failed_with_message", { message }));
        return;
      }
      const nextStatus =
        typeof data?.status === "string"
          ? (data.status as WaybackRunStatus)
          : null;
      if (nextStatus) {
        setWaybackRunStatus(nextStatus);
      }
      if (action === "pause") {
        showToast(
          tWayback(
            nextStatus === "paused" ? "toast_paused" : "toast_pause_requested"
          )
        );
      } else if (action === "resume") {
        setWaybackRunning(true);
        setWaybackRunStatus("running");
        setWaybackInitiator("manual");
        showToast(tWayback("toast_resumed"));
        const snap = await loadWaybackProgress();
        if (snap?.progress) {
          setWaybackProgress(snap.progress);
        }
      } else {
        setWaybackRunStatus(
          nextStatus === "cancel_requested" ? "cancel_requested" : "idle"
        );
        if (nextStatus !== "cancel_requested") {
          setWaybackRunning(false);
          setWaybackProgress(null);
          void loadWaybackLastRun();
        }
        showToast(
          tWayback(
            nextStatus === "cancel_requested"
              ? "toast_cancel_requested"
              : "toast_cancelled"
          )
        );
      }
    } catch (err) {
      const message = (err as Error)?.message ?? `Wayback ${action} failed`;
      showToast(tToast("save_failed_with_message", { message }));
    } finally {
      setWaybackControlBusy(null);
    }
  };

  /**
   * Purge every wayback-sourced snapshot row across the database. Guarded
   * behind a `window.confirm` because the deletion is permanent — the user
   * would need to re-run the import to get the rows back. We intentionally
   * don't offer an undo since `privacy_snapshots` rows are cheap to
   * reconstruct and more complicated rollback would mask bugs.
   */
  /**
   * Dismiss the confirm modal. Guarded so we don't let the user close it
   * while a DELETE is in flight — otherwise clicking outside the card
   * would hide the spinner mid-request and leave the UI in a confusing
   * "did that actually work?" state.
   */
  const closeWaybackRemoveModal = () => {
    if (waybackRemoving) {
      return;
    }
    setWaybackRemoveOpen(false);
  };

  const removeAllWaybackHistory = async () => {
    if (waybackRemoving) {
      return;
    }

    setWaybackRemoving(true);
    try {
      const res = await fetch("/api/wayback/import-all", { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = body?.error ?? `Remove failed (${res.status})`;
        showToast(tToast("save_failed_with_message", { message }));
        setWaybackSummary(message);
        return;
      }
      const data = await res.json();
      const deleted = Number(data?.deleted ?? 0);
      const line = `Removed ${deleted} imported history row${deleted === 1 ? "" : "s"}`;
      setWaybackSummary(line);
      showToast(tToast("saved_value", { message: line }));
      // A delete writes its own `wayback_import` activity row (mode: 'bulk',
      // removed: true), which `loadWaybackLastRun` filters out — so the
      // status card keeps showing the *import* summary, not the deletion.
      // No refresh needed.
    } catch (err) {
      const message = (err as Error)?.message ?? "Remove failed";
      showToast(tToast("save_failed_with_message", { message }));
      setWaybackSummary(message);
    } finally {
      setWaybackRemoving(false);
      setWaybackRemoveOpen(false);
    }
  };

  /**
   * Auto-save hook for the "show imported Wayback history in timelines"
   * toggle. The toggle flips imported rows on/off in every per-app
   * ChangelogTimeline without re-importing — server keeps the rows; the
   * UI just respects the flag.
   *
   * The hook itself doesn't manage local state, so the wrapper below
   * does the optimistic update + rollback dance: flip state synchronously
   * for instant feedback, await the POST, revert if the hook reports a
   * non-`ok` outcome (the hook also emits the red toast). On success we
   * advance the savedX watermark so the "current" / dirty checks stay
   * correct.
   */
  const waybackToggleAutoSave = useSettingsAutoSave<boolean>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ wayback_show_imported: value }),
    successMessage: (value) =>
      value ? "Showing imported Wayback rows" : "Hiding imported Wayback rows",
    taskLabel: (value) => `Wayback rows → ${value ? "visible" : "hidden"}`,
    onSaved: (value) => setSavedWaybackShowImported(value),
  });
  const saveWaybackShowImported = async (next: boolean) => {
    setWaybackShowImported(next);
    const result = await waybackToggleAutoSave.save(next);
    if (result !== "ok") {
      // Revert optimistic state so the checkbox doesn't lie. The hook
      // already pushed the red error toast.
      setWaybackShowImported(savedWaybackShowImported);
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
      value ? "Tracking accessibility labels" : "Hiding accessibility labels",
    taskLabel: (value) =>
      `Accessibility labels → ${value ? "visible" : "hidden"}`,
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
        className={`settings-layout${viewMode === "import-history" ? "settings-layout-standalone" : ""}`}
      >
        {viewMode === "all" && <SettingsSidebar />}

        <div className="settings-content">
          {viewMode === "all" && (
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
          https://privacytracker-docs.privacykey.org/develop/feature-flags, and the duplicate radio
          group was scheduled for removal in PR 5 but had stuck around.
          Removed in this pass; YourFocusCard owns the focus surface. */}
              {/* Language picker — moved out of the global footer so it lives
          alongside other personalisation controls inside the "You"
          group. The component itself fetches the active locale from
          `/api/locale`; this card is just chrome around it. Anchor id
          `language` matches the SettingsSidebar entry. */}
              <div className="settings-section" id="language">
                <h2 className="settings-section-title">
                  {tSections("language")}
                </h2>
                <p className="settings-section-subtitle">
                  {tSettings("language_section.subtitle")}
                </p>
                <LocaleSwitcher />
              </div>

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
                      className={`switch-toggle${profileEnabled ? "is-on" : ""}`}
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
                      className={`switch-toggle${a11yProfileEnabled ? "is-on" : ""}`}
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
                <div className="settings-section" id="notifications">
                  <h2 className="settings-section-title">
                    {tSections("notifications")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("notifications")}
                  </p>

                  <div
                    aria-label={tAria("notification_types")}
                    className="notification-prefs-list"
                    role="group"
                  >
                    {NOTIFICATION_TYPE_KEYS.map((key) => {
                      const enabled = notificationPrefs[key];
                      const inputId = `notif-pref-${key}`;
                      // Map the camelCase enum key onto the snake_case
                      // translation-key prefix used in the locale bundle
                      // (e.g. `labelChanges` → `label_changes`).
                      const tKey = key.replace(
                        /[A-Z]/g,
                        (m) => `_${m.toLowerCase()}`
                      );
                      return (
                        <label
                          className="notification-prefs-row"
                          htmlFor={inputId}
                          key={key}
                        >
                          <input
                            checked={enabled}
                            className="notification-prefs-toggle"
                            id={inputId}
                            onChange={(event) => {
                              const next = {
                                ...notificationPrefs,
                                [key]: event.target.checked,
                              };
                              setNotificationPrefs(next);
                              // Auto-save: debounced PUT so rapid toggling
                              // collapses into one server write + one toast.
                              scheduleNotificationPrefsSave(next);
                            }}
                            type="checkbox"
                          />
                          <span className="notification-prefs-copy">
                            <span className="notification-prefs-label">
                              {tNotifPrefs(`${tKey}_label`)}
                            </span>
                            <span className="notification-prefs-description">
                              {tNotifPrefs(`${tKey}_desc`)}
                            </span>
                            <span className="notification-prefs-example">
                              {tNotifPrefs(`${tKey}_example`)}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                      marginTop: 14,
                    }}
                  >
                    {/* Save button removed — checkboxes auto-save via debounced
              `scheduleNotificationPrefsSave`. The Reset Defaults helper
              stays so power users can wipe to baseline in one click; it
              also routes through the same debounced save path. */}
                    <button
                      className="btn btn-ghost"
                      disabled={
                        notificationPrefsAutoSave.saving ||
                        NOTIFICATION_TYPE_KEYS.every(
                          (key) =>
                            notificationPrefs[key] ===
                            DEFAULT_NOTIFICATION_PREFS[key]
                        )
                      }
                      onClick={() => {
                        const next = { ...DEFAULT_NOTIFICATION_PREFS };
                        setNotificationPrefs(next);
                        scheduleNotificationPrefsSave(next);
                      }}
                      type="button"
                    >
                      {tNotifPrefsCard("reset_defaults")}
                    </button>
                    {NOTIFICATION_TYPE_KEYS.every(
                      (key) =>
                        notificationPrefs[key] === savedNotificationPrefs[key]
                    ) && (
                      <span style={{ fontSize: 13, color: "var(--text-2)" }}>
                        {tNotifPrefsCard("up_to_date")}
                      </span>
                    )}
                  </div>

                  {/* Settings-autosave Task Center mirror. Lives at the bottom of
            the Notifications section because it's a "where does this
            notice show up" control — the bell vs. the Task Center
            dropdown — rather than a per-event toggle like the rows
            above. localStorage-backed, per-browser. */}
                  <label
                    className="settings-checkbox-row"
                    style={{ marginTop: 14 }}
                  >
                    <input
                      checked={autosaveLogToTaskCenter}
                      className="settings-checkbox"
                      onChange={(e) => onAutosaveLogToggle(e.target.checked)}
                      type="checkbox"
                    />
                    <span>
                      {tNotifPrefsCard("autosave_log_label")}
                      <span
                        className="settings-field-help"
                        style={{ display: "block", marginTop: 4 }}
                      >
                        {tNotifPrefsCard("autosave_log_help")}
                      </span>
                    </span>
                  </label>
                </div>
              )}
              <h3 className="settings-group-heading">
                {tSettings("sidebar.group_data_sync")}
              </h3>

              {/* Sync Schedule */}
              {settingsSyncScheduleOn && (
                <div className="settings-section" id="sync-schedule">
                  <h2 className="settings-section-title">
                    {tSections("sync_schedule")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("sync_schedule")}
                  </p>

                  {/* Semantically these are single-select options, so model them
            as a radiogroup: each card is a radio in the group and screen
            readers will announce "selected 1 of 4" etc. */}
                  <div
                    aria-label={tAria("sync_interval")}
                    className="schedule-options"
                    role="radiogroup"
                  >
                    {SCHEDULE_OPTIONS.map((opt) => {
                      const selected = schedule === opt.value;
                      // Localise label + desc per option. The English fallback
                      // ("opt.label" / "opt.desc") covers the case where a new
                      // schedule value lands in SCHEDULE_OPTIONS without a
                      // matching translation key.
                      const localisedLabel = (() => {
                        try {
                          return tSchedule(`${opt.value}_label`);
                        } catch {
                          return opt.label;
                        }
                      })();
                      const localisedDesc = (() => {
                        try {
                          return tSchedule(`${opt.value}_desc`);
                        } catch {
                          return opt.desc;
                        }
                      })();
                      return (
                        <button
                          aria-checked={selected}
                          className={`schedule-option ${selected ? "active" : ""}`}
                          disabled={scheduleAutoSave.saving}
                          key={opt.value}
                          // Auto-save semantics: clicking a radio card flips
                          // the local `schedule` state AND fires the POST. The
                          // toast surfaces success/failure; no Save button.
                          onClick={() => {
                            setSchedule(opt.value);
                            void scheduleAutoSave.save(opt.value);
                          }}
                          role="radio"
                          type="button"
                        >
                          <div className="schedule-option-label">
                            {localisedLabel}
                          </div>
                          <div className="schedule-option-desc">
                            {localisedDesc}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* Save button removed — radio cards above auto-save on
              click via `scheduleAutoSave`. The "current" badge below
              still renders so the user can tell at a glance which
              cadence is currently persisted. */}

                    {status && schedule === status.schedule && (
                      <span style={{ fontSize: 13, color: "var(--text-2)" }}>
                        {tSchedule("current")}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* App Store Region */}
              {settingsSyncRegionOn && (
                <div className="settings-section" id="region">
                  <h2 className="settings-section-title">
                    {tSections("app_store_region")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("app_store_region")}
                  </p>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 12,
                      alignItems: "center",
                    }}
                  >
                    <label
                      htmlFor="app-country"
                      style={{ fontSize: 14, color: "var(--text-2)" }}
                    >
                      {tRegion("storefront_label")}
                    </label>
                    <select
                      className="settings-select"
                      disabled={countryAutoSave.saving}
                      id="app-country"
                      // Auto-save: changing the storefront immediately POSTs the
                      // new code. We update local state synchronously so the
                      // dropdown stays responsive, then fire `save` — its toast
                      // surfaces success / failure. No Save button.
                      onChange={(e) => {
                        const next = normalizeCountry(e.target.value);
                        setCountry(next);
                        void countryAutoSave.save(next);
                      }}
                      style={{ minWidth: 220 }}
                      value={country}
                    >
                      {COUNTRY_OPTIONS.map((opt) => (
                        <option key={opt.code} value={opt.code}>
                          {opt.label} ({opt.code.toUpperCase()})
                        </option>
                      ))}
                    </select>

                    {country === savedCountry && (
                      <span style={{ fontSize: 13, color: "var(--text-2)" }}>
                        {tRegion("current")}
                      </span>
                    )}
                  </div>

                  {/* Language suggestion — appears after a successful region save
            when the new storefront's expected language differs from
            the active UI locale. The banner hits /api/locale on click
            (same path as the LocaleSwitcher) and reloads. Dismiss
            clears the suggestion until the next region change. */}
                  {languageSuggestion && (
                    <LanguageSuggestionBanner
                      onDismiss={() => setLanguageSuggestion(null)}
                      target={languageSuggestion}
                    />
                  )}
                </div>
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
              <div className="settings-section" id="accessibility-labels">
                <h2 className="settings-section-title">
                  {tSections("accessibility_labels")}
                </h2>
                <p className="settings-section-subtitle">
                  {tSub("accessibility_labels")}
                </p>

                <label className="settings-checkbox-row">
                  <input
                    checked={trackAccessibility}
                    className="settings-checkbox"
                    disabled={trackAccessibilityAutoSave.saving}
                    onChange={(event) =>
                      void saveTrackAccessibility(event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>
                    {tA11yLabels("checkbox_lead")}
                    <span
                      className="settings-field-help"
                      style={{ display: "block", marginTop: 4 }}
                    >
                      {tA11yLabels("checkbox_help")}
                    </span>
                  </span>
                </label>
              </div>

              {/* Review-queue preferences — single toggle for the progress bar
          shown in the Tinder-style review carousel. Tiny standalone
          section so users can find it via "queue" search; expand later
          if more queue prefs land. */}
              <div className="settings-section" id="review-queue-preferences">
                <h2 className="settings-section-title">
                  {tSections("review_queue")}
                </h2>
                <p className="settings-section-subtitle">
                  {tSub("review_queue")}
                </p>
                <label className="settings-checkbox-row">
                  <input
                    checked={queueShowProgressBar}
                    className="settings-checkbox"
                    disabled={queueShowProgressBarAutoSave.saving}
                    onChange={(event) =>
                      void saveQueueShowProgressBar(event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>
                    {tReviewQueueSettings("progress_bar_label")}
                    <span
                      className="settings-field-help"
                      style={{ display: "block", marginTop: 4 }}
                    >
                      {tReviewQueueSettings("progress_bar_help")}
                    </span>
                  </span>
                </label>
              </div>

              {/* Sync Status — manual "Sync Now" trigger + last-sync info. Shares
          the `flag.settings.sync.schedule` gate because the manual button
          is just an "override the timer right now" affordance for the
          schedule above. Hiding the schedule card without hiding this one
          would leave a dangling action with no context. */}
              {settingsSyncScheduleOn && (
                <div className="settings-section" id="sync-status">
                  <h2 className="settings-section-title">
                    {tSections("app_store_sync_status")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("app_store_sync_status")}
                  </p>

                  {/* Rate-limit banner — when bulk sync is throttled, the "Sync Now"
            button bounces every click into a 429 until the cooldown lifts.
            Surface that here so users don't spam the button thinking it's
            broken. We poll-while-idle so a 429 generated by another surface
            (App Detail re-sync, scheduled background tick) still shows up
            without requiring a button click first. */}
                  <RateLimitBanner category="scrape" pollWhenIdle />

                  {status ? (
                    <div className="settings-status-grid">
                      <div className="settings-status-item">
                        <div className="settings-status-label">
                          {tSyncStatus("last_sync")}
                        </div>
                        <div className="settings-status-value">
                          {fmtDate(tSettings, status.lastRun)}
                        </div>
                      </div>
                      <div className="settings-status-item">
                        <div className="settings-status-label">
                          {tSyncStatus("next_auto_sync")}
                        </div>
                        <div className="settings-status-value">
                          {status.schedule === "manual"
                            ? tSyncStatus("not_scheduled")
                            : fmtRelative(tTime, status.nextRun)}
                        </div>
                      </div>
                      <div className="settings-status-item">
                        <div className="settings-status-label">
                          {tSyncStatus("status_label")}
                        </div>
                        <div
                          className="settings-status-value"
                          style={{
                            color: status.isRunning
                              ? "var(--orange)"
                              : "var(--green)",
                          }}
                        >
                          {status.isRunning
                            ? tSyncStatus("running")
                            : tSyncStatus("idle")}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        color: "var(--text-3)",
                      }}
                    >
                      <span className="spinner-sm" /> {tSyncStatus("loading")}
                    </div>
                  )}

                  <button
                    className="btn btn-secondary"
                    disabled={syncing || status?.isRunning}
                    onClick={triggerSync}
                    style={{ marginTop: 20 }}
                    type="button"
                  >
                    {syncing ? (
                      <>
                        <span className="spinner" /> {tSyncStatus("syncing")}
                      </>
                    ) : (
                      tSyncStatus("sync_now")
                    )}
                  </button>
                </div>
              )}
              <h3 className="settings-group-heading">
                {tSettings("sidebar.group_policies_ai")}
              </h3>

              {settingsAiEnabledOn && (
                <div
                  className="settings-section ai-settings-section"
                  id="ai-summaries"
                >
                  <div className="settings-section-heading">
                    <div>
                      <h2 className="settings-section-title">
                        {tSections("ai_summaries")}
                      </h2>
                      <p
                        className="settings-section-subtitle"
                        style={{ marginBottom: 0 }}
                      >
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
                              return opt.labelKey
                                ? tAiOptions(opt.labelKey)
                                : opt.label;
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
                        <p className="settings-subsection-desc">
                          {tAiProvider("desc")}
                        </p>
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
                              {option.labelKey
                                ? tAiOptions(option.labelKey)
                                : option.label}
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
                            <span
                              className="settings-help-copy"
                              style={{ marginLeft: 6 }}
                            >
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
                              <strong>
                                {tOllamaHelp("long_policies_lead")}
                              </strong>
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
                              <strong>
                                {tOllamaHelp("memory_guide_lead")}
                              </strong>
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
                            <p
                              className="settings-help-copy"
                              style={{ marginBottom: 0 }}
                            >
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
                        <h3 className="settings-subsection-title">
                          {tAiConn("title")}
                        </h3>
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
                      {aiProvider !== "custom" &&
                        providerSupportsApiKey(aiProvider) && (
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
                              onBlur={() =>
                                saveAiSettings({ apiKey: aiApiKey })
                              }
                              onChange={(event) =>
                                setAiApiKey(event.target.value)
                              }
                              placeholder={
                                aiProvider === "anthropic"
                                  ? "sk-ant-..."
                                  : "sk-..."
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
                            <label
                              className="settings-field"
                              style={{ marginTop: 10 }}
                            >
                              <span className="settings-field-label">
                                {tAiConn("api_key_label")}
                              </span>
                              <input
                                autoComplete="off"
                                className="settings-input"
                                onBlur={() =>
                                  saveAiSettings({ apiKey: aiApiKey })
                                }
                                onChange={(event) =>
                                  setAiApiKey(event.target.value)
                                }
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
                            (providerRequiresApiKey(aiProvider) &&
                              !aiApiKey.trim())
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
                        <h3 className="settings-subsection-title">
                          {tAiModel("title")}
                        </h3>
                        <p className="settings-subsection-desc">
                          {aiProvider === "custom"
                            ? tAiModel("desc_custom")
                            : tAiModel("desc_default")}
                        </p>
                      </header>

                      <label className="settings-field">
                        <div className="settings-field-label-row">
                          <span className="settings-field-label">
                            {tAiModel("label")}
                          </span>
                          <button
                            className="settings-field-refresh"
                            disabled={
                              modelsStatus === "loading" || !canDiscoverModels
                            }
                            onClick={() => void refreshDiscoveredModels()}
                            title={tAiModel("refresh_title")}
                            type="button"
                          >
                            {modelsStatus === "loading" ? (
                              <>
                                <span className="spinner-sm" />{" "}
                                {tAiModel("refresh_busy")}
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
                                <option
                                  key={`d:${option.value}`}
                                  value={option.value}
                                >
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
                                    (discovered) =>
                                      discovered.value === option.value
                                  )
                              )
                              .map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}

                          <option value="__custom__">
                            {tAiModel("custom_option")}
                          </option>
                        </select>

                        {modelsStatus === "error" && (
                          <span className="settings-field-help settings-field-help-warn">
                            {tAiModel("error_lead")}{" "}
                            {modelsError || tAiModel("error_fallback")}{" "}
                            {tAiModel("error_after")}
                          </span>
                        )}
                        {modelsStatus === "ok" &&
                          discoveredModels.length > 0 && (
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
                                  <code>
                                    ollama pull {resolveDefaultModel("custom")}
                                  </code>
                                ),
                              })}
                            </span>
                          )}
                        {(modelsStatus === "idle" ||
                          modelsStatus === "loading") && (
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
                        <h3 className="settings-subsection-title">
                          {tAiSample("title")}
                        </h3>
                        <p className="settings-subsection-desc">
                          {tAiSample("desc")}
                        </p>
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
                          disabled={
                            !canRunSamplePolicyTest ||
                            aiSampleStatus === "testing"
                          }
                          onClick={() => void runAiSampleSummaryTest()}
                          type="button"
                        >
                          <span
                            className={`ai-test-dot ai-test-dot-${aiSampleStatus}`}
                          >
                            {aiSampleStatus === "testing" ? (
                              <span className="spinner-sm" />
                            ) : null}
                          </span>
                          {aiSampleStatus === "testing"
                            ? tAiSample("run_busy")
                            : aiSampleStatus === "ok" ||
                                aiSampleStatus === "fail"
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
                                duration: fmtDuration(
                                  aiSampleResult.durationMs
                                ),
                                words: aiSampleResult.sample.wordCount,
                              })}
                            </div>
                          </div>

                          <div className="ai-sample-review-note">
                            <span>{tAiSample("review_note_label")}</span>
                            <ul>
                              {aiSampleResult.sample.reviewChecklist.map(
                                (item, index) => (
                                  <li key={`${index}:${item}`}>{item}</li>
                                )
                              )}
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
                                    <li key={`${index}:${highlight}`}>
                                      {highlight}
                                    </li>
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
                                  <span>
                                    {tLens(entry.key as PolicyLensKey)}
                                  </span>
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
                      <p className="settings-subsection-desc">
                        {tAiBehavior("desc")}
                      </p>
                    </header>

                    {settingsAiSummarizeOnImportOn && (
                      <label className="settings-checkbox-row">
                        <input
                          checked={summarizeOnImport}
                          className="settings-checkbox"
                          disabled={
                            aiProvider === "disabled" ||
                            aiSettingsAutoSave.saving
                          }
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
                        <span className="settings-actions-saved">
                          {tAiFooter("saved")}
                        </span>
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
              )}

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
                <div className="settings-section" id="privacy-policies-bulk">
                  <h2 className="settings-section-title">
                    {tSections("privacy_policies")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("privacy_policies")}
                  </p>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 10,
                      marginTop: 12,
                    }}
                  >
                    <button
                      className="btn btn-secondary"
                      disabled={policyBulkRunning !== null}
                      onClick={() => runBulkPolicySync("fetch")}
                      title={tPolicyCard("rescrape_title")}
                      type="button"
                    >
                      {policyBulkRunning === "fetch" ? (
                        <>
                          <span className="spinner" />{" "}
                          {tPolicyCard("rescrape_busy")}
                        </>
                      ) : (
                        tPolicyCard("rescrape")
                      )}
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={policyBulkRunning !== null}
                      onClick={() => runBulkPolicySync("all")}
                      title={tPolicyCard("summarise_title")}
                      type="button"
                    >
                      {policyBulkRunning === "all" ? (
                        <>
                          <span className="spinner" />{" "}
                          {tPolicyCard("summarise_busy")}
                        </>
                      ) : (
                        tPolicyCard("summarise")
                      )}
                    </button>
                  </div>

                  <label
                    className="settings-checkbox-row"
                    style={{ marginTop: 14 }}
                  >
                    <input
                      checked={policyBulkForce}
                      className="settings-checkbox"
                      disabled={policyBulkRunning !== null}
                      onChange={(event) =>
                        setPolicyBulkForce(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>
                      {tPolicyCard("force_label")}
                      <span
                        className="settings-field-help"
                        style={{ display: "block", marginTop: 4 }}
                      >
                        {tPolicyCard("force_help")}
                      </span>
                    </span>
                  </label>

                  {policyBulkSummary ? (
                    <p
                      style={{
                        marginTop: 12,
                        fontSize: 13,
                        color: "var(--text-2)",
                      }}
                    >
                      {tPolicyCard("last_run_lead")} {policyBulkSummary}
                    </p>
                  ) : null}
                </div>
              )}

              {/* Policy Change Alerts */}
              <div className="settings-section" id="policy-alerts">
                <h2 className="settings-section-title">
                  {tSections("policy_change_alerts")}
                </h2>
                <p className="settings-section-subtitle">
                  {tSub("policy_change_alerts")}
                </p>

                <label className="settings-field" style={{ maxWidth: 320 }}>
                  <span className="settings-field-label">
                    {tPolicyAlerts("field_label")}
                  </span>
                  <input
                    aria-describedby="policy-diff-alert-days-help"
                    className="settings-input"
                    disabled={policyDiffAlertDaysAutoSave.saving}
                    max={3650}
                    min={0}
                    // Auto-save on blur. Save button removed; the bottom-center
                    // toast surfaces success/failure. Mid-edit garbage stays
                    // local until the field loses focus.
                    onBlur={handlePolicyDiffAlertBlur}
                    onChange={(event) =>
                      setPolicyDiffAlertDays(event.target.value)
                    }
                    step={1}
                    type="number"
                    value={policyDiffAlertDays}
                  />
                  <span
                    className="settings-field-help"
                    id="policy-diff-alert-days-help"
                    style={{ display: "block", marginTop: 4 }}
                  >
                    {tPolicyAlerts.rich("field_help", {
                      strong: (chunks) => <strong>{chunks}</strong>,
                    })}
                  </span>
                </label>
              </div>

              {/* Policy Scraping Kill-Switch — global on/off. Stronger than the
          throttle (which just rate-limits). When on, every code path
          that would fetch a privacy-policy URL is silenced, the manual
          sync buttons return 409, and a crashed bulk-policy resume on
          next boot is cancelled cleanly with an activity-log entry. */}
              <div className="settings-section" id="policy-scrape-disabled">
                <h2 className="settings-section-title">
                  {tSections("policy_scrape_disabled")}
                </h2>
                <p className="settings-section-subtitle">
                  {tSub("policy_scrape_disabled")}
                </p>

                <label
                  className="settings-field"
                  style={{
                    maxWidth: 480,
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <input
                    aria-describedby="policy-scrape-disabled-help"
                    checked={scrapeDisabled}
                    className="settings-checkbox"
                    disabled={scrapeDisabledAutoSave.saving}
                    onChange={(event) => {
                      const disabled = event.target.checked;
                      setScrapeDisabled(disabled);
                      void scrapeDisabledAutoSave.save({ disabled });
                    }}
                    type="checkbox"
                  />
                  <span className="settings-field-label" style={{ margin: 0 }}>
                    {tPolicyThrottle("scrape_disabled_label")}
                  </span>
                </label>
                <span
                  className="settings-field-help"
                  id="policy-scrape-disabled-help"
                  style={{ display: "block", marginTop: 8, maxWidth: 600 }}
                >
                  {tPolicyThrottle.rich("scrape_disabled_help", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    em: (chunks) => <em>{chunks}</em>,
                  })}
                </span>
              </div>

              {/* Policy Scrape Throttle */}
              <div className="settings-section" id="policy-scrape-throttle">
                <h2 className="settings-section-title">
                  {tSections("policy_scrape_throttle")}
                </h2>
                <p className="settings-section-subtitle">
                  {tSub("policy_scrape_throttle")}
                </p>
                {scrapeDisabled && (
                  <p
                    className="settings-section-subtitle"
                    style={{ fontStyle: "italic", opacity: 0.7 }}
                  >
                    {tPolicyThrottle("throttle_inert_when_disabled")}
                  </p>
                )}

                <label
                  className="settings-field"
                  style={{
                    maxWidth: 420,
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <input
                    checked={scrapeThrottleEnabled}
                    disabled={scrapeThrottleAutoSave.saving || scrapeDisabled}
                    // Checkbox flips save immediately — discrete intent. Use
                    // the latest minutes value (already validated on its own
                    // blur) so toggling enabled→disabled→enabled keeps the
                    // cooldown the user typed.
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setScrapeThrottleEnabled(enabled);
                      const parsed = Number.parseInt(scrapeThrottleMinutes, 10);
                      const minutes = Number.isFinite(parsed)
                        ? Math.min(10_080, Math.max(0, parsed))
                        : 0;
                      saveScrapeThrottle({ enabled, minutes });
                    }}
                    type="checkbox"
                  />
                  <span className="settings-field-label" style={{ margin: 0 }}>
                    {tPolicyThrottle("enabled_label")}
                  </span>
                </label>

                <label
                  className="settings-field"
                  style={{ maxWidth: 320, marginTop: 12 }}
                >
                  <span className="settings-field-label">
                    {tPolicyThrottle("cooldown_label")}
                  </span>
                  <input
                    aria-describedby="policy-scrape-throttle-help"
                    className="settings-input"
                    disabled={
                      !scrapeThrottleEnabled ||
                      scrapeThrottleAutoSave.saving ||
                      scrapeDisabled
                    }
                    max={10_080}
                    min={0}
                    // Auto-save on blur with validation. Same as the alert
                    // input above — keystrokes update local state freely;
                    // the POST only fires when the user tabs away.
                    onBlur={handleScrapeThrottleBlur}
                    onChange={(event) =>
                      setScrapeThrottleMinutes(event.target.value)
                    }
                    step={1}
                    type="number"
                    value={scrapeThrottleMinutes}
                  />
                  <span
                    className="settings-field-help"
                    id="policy-scrape-throttle-help"
                    style={{ display: "block", marginTop: 4 }}
                  >
                    {tPolicyThrottle.rich("cooldown_help", {
                      strong: (chunks) => <strong>{chunks}</strong>,
                    })}
                  </span>
                </label>
              </div>
            </>
          )}
          {viewMode === "import-history" && settingsImportHistoryOn && (
            <div className="settings-section" id="import-history">
              <h2 className="settings-section-title">
                {tSections("import_history")}
              </h2>
              <p className="settings-section-subtitle">
                {tSub("import_history")}
              </p>

              {/* Live rate-limit banners.

            Surfaces an *active* iTunes Search or App Store HTML cooldown so
            users can immediately see when "0 results" or "scrape failed"
            messages on this page are due to Apple throttling rather than
            broken matching or network errors. Polls /api/rate-limit/status
            in the background; renders nothing when idle.

            Both categories shown here because Import History is the surface
            where users land after a problem and need to understand what's
            happening — search throttling affects change-match lookups,
            scrape throttling affects the queued retry worker. They're
            shown in separate banners so each can resolve independently. */}
              <RateLimitBanner category="search" pollWhenIdle />
              <RateLimitBanner category="scrape" pollWhenIdle />

              {/* Queue status banner. Only shown when the background import worker
            still has work queued (typically because Apple rate-limited us
            during onboarding). The "Retry now" button kicks a foreground
            drain loop (handleRetryQueue) that keeps calling retryNow() until
            the queue empties, the user cancels, or Apple rate-limits us
            (in which case it waits out the cooldown automatically and
            resumes — see the auto-retry path in handleRetryQueue).

            Three render modes:
            1. Idle (no drainState): the original "X queued / next retry in Ns"
               summary + "Retry queue now" CTA.
            2. Draining (drainState != null, not paused): live progress bar
               showing "N of M done", the per-tick spinner, and a Cancel
               button.
            3. Draining + paused: progress bar PLUS a countdown to when the
               drain will auto-resume after Apple's cooldown elapses. We
               compute the countdown locally off `pausedUntil - Date.now()`
               so it ticks at 1Hz without the server having to push updates. */}
              {importQueue.state.queued > 0 &&
                (() => {
                  // Bind the provider's drainState into a local for readable
                  // JSX. Same shape, different owner — survives navigation.
                  const drainState = importQueue.drainState;
                  return (
                    <div className="import-queue-banner" role="status">
                      <div className="import-queue-banner-body">
                        <span aria-hidden className="import-queue-banner-icon">
                          ⏳
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="import-queue-banner-title">
                            {drainState
                              ? tImpQueue("draining_title", {
                                  done: Math.min(
                                    drainState.processed,
                                    drainState.initialTotal
                                  ),
                                  total: drainState.initialTotal,
                                })
                              : tImpQueue("title", {
                                  count: importQueue.state.queued,
                                })}
                          </div>
                          <div className="import-queue-banner-sub">
                            {drainState?.pausedUntil &&
                            drainState.pausedUntil > Date.now()
                              ? tImpQueue("drain_paused", {
                                  countdown: fmtQueueCountdown(
                                    tTime,
                                    drainState.pausedUntil
                                  ),
                                })
                              : drainState
                                ? tImpQueue("drain_running")
                                : importQueue.state.pausedUntil &&
                                    importQueue.state.pausedUntil > Date.now()
                                  ? tImpQueue("paused", {
                                      countdown: fmtQueueCountdown(
                                        tTime,
                                        importQueue.state.pausedUntil
                                      ),
                                    })
                                  : importQueue.state.soonestNextAttemptAt &&
                                      importQueue.state.soonestNextAttemptAt >
                                        Date.now()
                                    ? tImpQueue("next_retry", {
                                        countdown: fmtQueueCountdown(
                                          tTime,
                                          importQueue.state.soonestNextAttemptAt
                                        ),
                                      })
                                    : tImpQueue("retrying_now")}
                          </div>
                          {drainState && (
                            <div
                              aria-valuemax={drainState.initialTotal}
                              aria-valuemin={0}
                              aria-valuenow={drainState.processed}
                              className="import-queue-progress"
                              role="progressbar"
                            >
                              <div
                                className="import-queue-progress-fill"
                                style={{
                                  width: `${Math.min(100, Math.round((drainState.processed / drainState.initialTotal) * 100))}%`,
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        {drainState ? (
                          <button
                            className="pill-button"
                            disabled={drainState.cancelled}
                            onClick={handleCancelDrain}
                            type="button"
                          >
                            {drainState.cancelled
                              ? tImpQueue("cancelling")
                              : tImpQueue("cancel_drain")}
                          </button>
                        ) : (
                          <button
                            className="pill-button"
                            disabled={retryingQueue}
                            onClick={() => void handleRetryQueue()}
                            type="button"
                          >
                            {retryingQueue ? (
                              <>
                                <span className="spinner-sm" />{" "}
                                {tImpQueue("retrying")}
                              </>
                            ) : (
                              tImpQueue("retry_button")
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}

              {/* Active-filter banner. Shown whenever the user has arrived here
            from a notification (?filter=…) or clicked one of the per-row
            status badges. Imports with zero matching items collapse away
            while the filter is active — clear the filter to see the full
            history again.

            When the filter covers a retryable status (error / unmatched /
            problems), the banner also gets a "Retry all" button that
            sweeps every retryable item in the filter through the same
            change-match endpoint the single-row "Retry import" uses. */}
              {itemStatusFilter &&
                (() => {
                  // A filter is retry-eligible if any of the statuses it covers
                  // is a retryable one (error or unmatched). `problems` covers
                  // both; `error` and `unmatched` cover themselves. `queued`
                  // items use the queue-retry path instead, and `removed` can't
                  // be retried at all.
                  const filterCoversRetryable =
                    itemMatchesFilter("error", itemStatusFilter) ||
                    itemMatchesFilter("unmatched", itemStatusFilter);
                  // Only offer the bulk button when at least one import-row has
                  // counters suggesting retryable items. Avoids offering a
                  // useless button for a filter like `removed` or an empty state.
                  const retryableImportsPresent = (imports ?? []).some(
                    (row) => (row.errored ?? 0) + (row.unmatched ?? 0) > 0
                  );
                  const showRetryAll =
                    filterCoversRetryable && retryableImportsPresent;
                  return (
                    <div
                      className={`import-history-filter-banner import-history-filter-banner-${FILTER_META[itemStatusFilter].tone}`}
                      role="status"
                    >
                      <div className="import-history-filter-banner-body">
                        <span
                          aria-hidden
                          className="import-history-filter-banner-icon"
                        >
                          🔎
                        </span>
                        <div>
                          <div className="import-history-filter-banner-title">
                            {tImpFilterBanner("showing", {
                              label: tImpFilterMeta(itemStatusFilter),
                            })}
                          </div>
                          <div className="import-history-filter-banner-sub">
                            {retryingAll && retryAllProgress
                              ? tImpFilterBanner("retrying", {
                                  done: retryAllProgress.done,
                                  total: retryAllProgress.total,
                                })
                              : tImpFilterBanner("hidden")}
                          </div>
                        </div>
                      </div>
                      <div className="import-history-filter-banner-actions">
                        {showRetryAll && (
                          <button
                            className="pill-button pill-button-primary"
                            disabled={retryingAll}
                            onClick={() => void handleRetryAllErrors()}
                            title={tImpFilterBanner("retry_all_title")}
                            type="button"
                          >
                            {retryingAll && retryAllProgress ? (
                              <>
                                <span className="spinner-sm" />{" "}
                                {tImpFilterBanner("retry_all_busy", {
                                  done: retryAllProgress.done,
                                  total: retryAllProgress.total,
                                })}
                              </>
                            ) : (
                              tImpFilterBanner("retry_all")
                            )}
                          </button>
                        )}
                        <button
                          className="pill-button"
                          disabled={retryingAll}
                          onClick={clearItemFilter}
                          type="button"
                        >
                          {tImpFilterBanner("clear_filter")}
                        </button>
                      </div>
                    </div>
                  );
                })()}

              {imports === null ? (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    color: "var(--text-3)",
                  }}
                >
                  <span className="spinner-sm" />{" "}
                  {tImpHistory("loading_imports")}
                </div>
              ) : imports.length === 0 ? (
                <div className="import-history-empty">
                  {tImpHistory("empty_no_imports")}
                </div>
              ) : (
                (() => {
                  // When a filter is active, hide imports that have no matching
                  // items. Keeps the user focused on the rows they asked to see
                  // (e.g. only imports with unmatched apps when they clicked the
                  // bell's "Unmatched apps to review" notification).
                  const visibleImports = itemStatusFilter
                    ? imports.filter(
                        (r) => countItemsMatchingFilter(r, itemStatusFilter) > 0
                      )
                    : imports;
                  if (visibleImports.length === 0) {
                    return (
                      <div className="import-history-empty">
                        {tImpHistory("empty_filter_lead")}{" "}
                        <button
                          className="btn btn-link"
                          onClick={clearItemFilter}
                          style={{ padding: 0 }}
                          type="button"
                        >
                          {tImpHistory("empty_filter_action")}
                        </button>
                        {tImpHistory("empty_filter_post")}
                      </div>
                    );
                  }
                  return (
                    <ul className="import-history-list">
                      {visibleImports.map((importRow) => {
                        const isExpanded = expandedImportId === importRow.id;
                        const items = expandedItems[importRow.id];
                        const loadingItems =
                          expandingId === importRow.id && !items;
                        const sourceText = importRow.sourceLabel
                          ? `"${importRow.sourceLabel}"`
                          : tImpSource(importRow.source);
                        // Pick a glyph based on the device class baked into the
                        // source label. The OnboardWizard's cfgutil path now
                        // formats labels as "Apple Configurator · <class> · <name>"
                        // so we can recognise iPhone / iPad / iPod / AppleTV /
                        // AppleWatch and render an emoji prefix without needing
                        // a separate database column. Returns null when no class
                        // is detectable, which preserves the current "no icon"
                        // behaviour for legacy rows + non-cfgutil sources (file
                        // upload, manual entry, screenshot).
                        const sourceIcon = pickSourceIcon(
                          importRow.sourceLabel,
                          importRow.source
                        );
                        // Live counters come from the `/api/imports` list payload, so
                        // the summary row can render problem badges and the "Resume
                        // matching" button without expanding the row first.
                        //
                        // `importRow.unmatched` is an aggregate server counter that
                        // includes unmatched, error, and removed items; the individual
                        // `queued` / `errored` / `removed` columns are joined in at
                        // query time. We surface only the attention-worthy counters
                        // (per user feedback: "only show something about apps not
                        // imported, or errors" — the old `✓ N` tick was confusing).
                        const queuedCount = importRow.queued;
                        const erroredCount = importRow.errored;
                        const removedCount = importRow.removed;
                        const unmatchedOnly = Math.max(
                          0,
                          importRow.unmatched - erroredCount - removedCount
                        );
                        const hasUnmatched = unmatchedOnly > 0;
                        const hasErrored = erroredCount > 0;
                        const hasRemoved = removedCount > 0;
                        const hasQueued = queuedCount > 0;
                        // A clean import (everything imported successfully, nothing
                        // pending or erroring, nothing later removed) shows no badges
                        // at all — the user only sees row-level counters when there's
                        // something to act on.
                        const hasProblems =
                          hasQueued || hasUnmatched || hasErrored || hasRemoved;

                        return (
                          <li
                            className={`import-history-row${isExpanded ? "is-open" : ""}`}
                            key={importRow.id}
                          >
                            <div className="import-history-summary">
                              <div className="import-history-meta">
                                <span className="import-history-date">
                                  {fmtShortDate(importRow.createdAt, dateMode)}
                                </span>
                                <span className="import-history-sep">·</span>
                                <span className="import-history-count">
                                  {tImpHistory("meta_apps_count", {
                                    count: importRow.total,
                                  })}
                                </span>
                                <span className="import-history-sep">·</span>
                                <span className="import-history-source">
                                  {sourceIcon && (
                                    <span
                                      aria-hidden="true"
                                      className="import-history-source-icon"
                                      title={sourceIcon.title}
                                    >
                                      {sourceIcon.glyph}
                                    </span>
                                  )}
                                  {sourceText}
                                </span>
                              </div>

                              {hasProblems && (
                                <div className="import-history-stats">
                                  {hasQueued && (
                                    <button
                                      aria-pressed={
                                        itemStatusFilter === "queued"
                                      }
                                      className={`import-history-stat import-history-stat-warn${itemStatusFilter === "queued" ? "is-active" : ""}`}
                                      onClick={() => handleBadgeClick("queued")}
                                      title={tImpHistory("stat_queued_title")}
                                      type="button"
                                    >
                                      {tImpHistory("stat_queued", {
                                        count: queuedCount,
                                      })}
                                    </button>
                                  )}
                                  {hasUnmatched && (
                                    <button
                                      aria-pressed={
                                        itemStatusFilter === "unmatched"
                                      }
                                      className={`import-history-stat import-history-stat-warn${itemStatusFilter === "unmatched" ? "is-active" : ""}`}
                                      onClick={() =>
                                        handleBadgeClick("unmatched")
                                      }
                                      title={tImpHistory(
                                        "stat_unmatched_title"
                                      )}
                                      type="button"
                                    >
                                      {tImpHistory("stat_unmatched", {
                                        count: unmatchedOnly,
                                      })}
                                    </button>
                                  )}
                                  {hasErrored && (
                                    <button
                                      aria-pressed={
                                        itemStatusFilter === "error"
                                      }
                                      className={`import-history-stat import-history-stat-bad${itemStatusFilter === "error" ? "is-active" : ""}`}
                                      onClick={() => handleBadgeClick("error")}
                                      title={tImpHistory("stat_error_title")}
                                      type="button"
                                    >
                                      {tImpHistory("stat_error", {
                                        count: erroredCount,
                                      })}
                                    </button>
                                  )}
                                  {hasRemoved && (
                                    <button
                                      aria-pressed={
                                        itemStatusFilter === "removed"
                                      }
                                      className={`import-history-stat import-history-stat-mute${itemStatusFilter === "removed" ? "is-active" : ""}`}
                                      onClick={() =>
                                        handleBadgeClick("removed")
                                      }
                                      title={tImpHistory("stat_removed_title")}
                                      type="button"
                                    >
                                      {tImpHistory("stat_removed", {
                                        count: removedCount,
                                      })}
                                    </button>
                                  )}
                                </div>
                              )}

                              <div className="import-history-actions">
                                {hasQueued && (
                                  <button
                                    className="pill-button pill-button-primary"
                                    disabled={retryingQueue}
                                    onClick={() => void handleRetryQueue()}
                                    title={tImpActions("resume_matching_title")}
                                    type="button"
                                  >
                                    {retryingQueue ? (
                                      <>
                                        <span className="spinner-sm" />{" "}
                                        {tImpActions("resuming")}
                                      </>
                                    ) : (
                                      tImpActions("resume_matching")
                                    )}
                                  </button>
                                )}
                                <button
                                  aria-expanded={isExpanded}
                                  className="pill-button"
                                  onClick={() =>
                                    void toggleImportRow(importRow)
                                  }
                                  type="button"
                                >
                                  {isExpanded
                                    ? tImpActions("hide")
                                    : tImpActions("view")}
                                </button>
                                <button
                                  className="pill-button pill-button-danger"
                                  onClick={() =>
                                    setDeleteTarget({
                                      importRow,
                                      mode: "history-only",
                                    })
                                  }
                                  type="button"
                                >
                                  {tImpActions("delete")}
                                </button>
                              </div>
                            </div>

                            {isExpanded && (
                              <div className="import-history-detail">
                                {loadingItems ? (
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: 8,
                                      alignItems: "center",
                                      color: "var(--text-3)",
                                      padding: "12px 2px",
                                    }}
                                  >
                                    <span className="spinner-sm" />{" "}
                                    {tImpHistory("loading_items")}
                                  </div>
                                ) : items && items.length > 0 ? (
                                  (() => {
                                    // When a filter is active, the expanded detail only
                                    // shows items whose status matches. We still keep
                                    // the import-row itself visible because the parent
                                    // list has already screened it with
                                    // countItemsMatchingFilter > 0.
                                    const visibleItems = itemStatusFilter
                                      ? items.filter((it) =>
                                          itemMatchesFilter(
                                            it.status,
                                            itemStatusFilter
                                          )
                                        )
                                      : items;
                                    if (visibleItems.length === 0) {
                                      return (
                                        <div
                                          className="import-history-empty"
                                          style={{ margin: 0 }}
                                        >
                                          {tImpHistory("empty_no_match_filter")}
                                        </div>
                                      );
                                    }
                                    return (
                                      <ul className="import-item-list">
                                        {visibleItems.map((item) => {
                                          const meta = STATUS_META[item.status];
                                          const displayQuery =
                                            item.editedQuery || item.query;
                                          // `queued` gets its own retry button (kicks the
                                          // server-side worker). `unmatched`/`error` rows
                                          // get the inline change-match UI and, when a URL
                                          // is already on file, an optimistic "Retry import"
                                          // that re-scrapes the same URL.
                                          const canEditRetry =
                                            item.status === "unmatched" ||
                                            item.status === "error";
                                          const canQueueRetry =
                                            item.status === "queued";
                                          const canChangeMatch =
                                            item.status === "matched" ||
                                            item.status === "imported";
                                          const canReAdd =
                                            item.status === "removed";
                                          const editing =
                                            changeMatch?.itemId === item.id;
                                          const hasMatch = Boolean(
                                            item.appName
                                          );
                                          // Only worth offering "Retry import" when we have
                                          // a URL to hit — otherwise there's nothing to
                                          // retry and the user has to go through
                                          // Change match instead.
                                          const canRetryImport =
                                            canEditRetry && Boolean(item.url);
                                          const retryingThisItem =
                                            retryingItemId === item.id;
                                          const applying =
                                            editing &&
                                            changeMatch?.applyingAppleId !==
                                              null;
                                          // Deep-link imported items straight to the dashboard
                                          // app detail page. `matched` items don't have a
                                          // dashboard entry yet (still scraping), so we keep
                                          // the App Store link for those.
                                          const dashboardHref =
                                            item.status === "imported" &&
                                            item.appId
                                              ? `/apps/${encodeURIComponent(item.appId)}`
                                              : null;
                                          const isDeepLinkTarget =
                                            highlightItemId === item.id;
                                          return (
                                            <li
                                              className={`import-item-row import-item-row-${item.status}${isDeepLinkTarget ? " import-item-row-focused" : ""}`}
                                              id={`import-item-${item.id}`}
                                              key={item.id}
                                            >
                                              <span
                                                className={`import-item-chip import-item-chip-${meta.tone}`}
                                              >
                                                <span aria-hidden>
                                                  {meta.icon}
                                                </span>{" "}
                                                {tImpStatusMeta(item.status)}
                                              </span>
                                              <div className="import-item-body">
                                                <div className="import-item-query-line">
                                                  {item.iconUrl ? (
                                                    <img
                                                      alt=""
                                                      className="import-item-icon"
                                                      height={22}
                                                      loading="lazy"
                                                      src={item.iconUrl}
                                                      width={22}
                                                    />
                                                  ) : null}
                                                  <div className="import-item-query">
                                                    {displayQuery}
                                                  </div>
                                                </div>
                                                {item.editedQuery &&
                                                  item.editedQuery !==
                                                    item.query && (
                                                    <div className="import-item-sub">
                                                      {tImpItem(
                                                        "originally_prefix"
                                                      )}
                                                      <em>{item.query}</em>
                                                    </div>
                                                  )}
                                                {hasMatch ? (
                                                  <div className="import-item-sub">
                                                    {item.status === "removed"
                                                      ? tImpItem("was_prefix")
                                                      : tImpItem(
                                                          "arrow_prefix"
                                                        )}
                                                    {dashboardHref ? (
                                                      <Link
                                                        className="import-item-match-link"
                                                        href={dashboardHref}
                                                      >
                                                        {item.appName}
                                                      </Link>
                                                    ) : item.url ? (
                                                      <a
                                                        className="import-item-match-link"
                                                        href={item.url}
                                                        rel="noopener noreferrer"
                                                        target="_blank"
                                                      >
                                                        {item.appName}
                                                      </a>
                                                    ) : (
                                                      <span>
                                                        {item.appName}
                                                      </span>
                                                    )}
                                                    {item.developer ? (
                                                      <span
                                                        style={{
                                                          color:
                                                            "var(--text-3)",
                                                        }}
                                                      >
                                                        {" "}
                                                        · {item.developer}
                                                      </span>
                                                    ) : null}
                                                    {/* Secondary App Store link for imported
                                          rows — the app name now points to
                                          the dashboard, so we keep a
                                          discreet "↗ App Store" link for
                                          users who still want the Apple page. */}
                                                    {dashboardHref &&
                                                      item.url && (
                                                        <>
                                                          {" · "}
                                                          <a
                                                            className="import-item-external"
                                                            href={item.url}
                                                            rel="noopener noreferrer"
                                                            target="_blank"
                                                          >
                                                            {tImpItem(
                                                              "app_store_link"
                                                            )}
                                                          </a>
                                                        </>
                                                      )}
                                                  </div>
                                                ) : (
                                                  <div
                                                    className="import-item-sub"
                                                    style={{
                                                      color: "var(--text-3)",
                                                    }}
                                                  >
                                                    {tImpItem(
                                                      "no_match_recorded"
                                                    )}
                                                  </div>
                                                )}
                                                {item.status === "queued" && (
                                                  <div className="import-item-sub import-item-queued-note">
                                                    {tImpItem("queued_lead")}{" "}
                                                    {item.nextAttemptAt &&
                                                    item.nextAttemptAt >
                                                      Date.now()
                                                      ? tImpItem(
                                                          "queued_next",
                                                          {
                                                            countdown:
                                                              fmtQueueCountdown(
                                                                tTime,
                                                                item.nextAttemptAt
                                                              ),
                                                          }
                                                        )
                                                      : tImpItem(
                                                          "queued_retry_now"
                                                        )}
                                                    {typeof item.attemptCount ===
                                                      "number" &&
                                                      item.attemptCount > 0 && (
                                                        <span
                                                          style={{
                                                            color:
                                                              "var(--text-3)",
                                                          }}
                                                        >
                                                          {tImpItem(
                                                            "queued_attempt",
                                                            {
                                                              n:
                                                                item.attemptCount +
                                                                1,
                                                            }
                                                          )}
                                                        </span>
                                                      )}
                                                  </div>
                                                )}
                                                {item.status === "removed" && (
                                                  <div
                                                    className="import-item-sub"
                                                    style={{
                                                      color: "var(--text-3)",
                                                    }}
                                                  >
                                                    {tImpItem("removed_note")}
                                                  </div>
                                                )}
                                                {item.scrapeError &&
                                                  item.status !== "queued" && (
                                                    <div className="import-item-error">
                                                      {item.scrapeError}
                                                    </div>
                                                  )}
                                              </div>
                                              <div className="import-item-actions">
                                                {/* "Retry import" sits first (left-most)
                                      so it's the default action for a row
                                      that already has an App Store URL but
                                      failed to scrape — most of the time the
                                      user just wants another go at the same
                                      URL (transient Apple 5xx, etc.) rather
                                      than digging through search results. */}
                                                {canRetryImport && !editing && (
                                                  <button
                                                    className="pill-button pill-button-primary"
                                                    disabled={retryingThisItem}
                                                    onClick={() =>
                                                      void handleRetryImport(
                                                        importRow,
                                                        item
                                                      )
                                                    }
                                                    type="button"
                                                  >
                                                    {retryingThisItem ? (
                                                      <>
                                                        <span className="spinner-sm" />{" "}
                                                        {tImpActions(
                                                          "retrying"
                                                        )}
                                                      </>
                                                    ) : (
                                                      tImpActions(
                                                        "retry_import"
                                                      )
                                                    )}
                                                  </button>
                                                )}
                                                {canChangeMatch && !editing && (
                                                  <button
                                                    className="pill-button"
                                                    onClick={() =>
                                                      openChangeMatch(
                                                        item,
                                                        "change"
                                                      )
                                                    }
                                                    type="button"
                                                  >
                                                    {tImpActions(
                                                      "change_match"
                                                    )}
                                                  </button>
                                                )}
                                                {/* Per-item delete escape hatch. Available
                                      any time the item still points at a
                                      real app row — so matched / imported
                                      rows (most common), but also error /
                                      unmatched / queued rows that somehow
                                      ended up with an app_id set (partial
                                      scrape, optimistic pre-match, etc.).
                                      `removed` rows already have no app to
                                      delete. Text reads "Remove from Apps"
                                      rather than "… from dashboard" — the
                                      user thinks in "Apps", which is how
                                      the sidebar labels it. */}
                                                {!editing &&
                                                  item.appId &&
                                                  item.status !== "removed" && (
                                                    <button
                                                      className="pill-button pill-button-danger"
                                                      disabled={
                                                        removingItemId ===
                                                        item.id
                                                      }
                                                      onClick={() =>
                                                        void handleRemoveItemFromDashboard(
                                                          importRow,
                                                          item
                                                        )
                                                      }
                                                      type="button"
                                                    >
                                                      {removingItemId ===
                                                      item.id ? (
                                                        <>
                                                          <span className="spinner-sm" />{" "}
                                                          {tImpActions(
                                                            "removing"
                                                          )}
                                                        </>
                                                      ) : (
                                                        tImpActions(
                                                          "remove_from_apps"
                                                        )
                                                      )}
                                                    </button>
                                                  )}
                                                {canReAdd && !editing && (
                                                  <button
                                                    className="pill-button"
                                                    onClick={() =>
                                                      openChangeMatch(
                                                        item,
                                                        "readd"
                                                      )
                                                    }
                                                    type="button"
                                                  >
                                                    {tImpActions("re_add")}
                                                  </button>
                                                )}
                                                {canQueueRetry && !editing && (
                                                  <button
                                                    className="pill-button"
                                                    disabled={
                                                      retryingItemId ===
                                                        item.id || retryingQueue
                                                    }
                                                    // Per-item retry: only this row, not
                                                    // a global drain. Used to call
                                                    // handleRetryQueue() which kicked the
                                                    // entire backlog — confusing because
                                                    // clicking "Retry" on one row started
                                                    // hundreds of others. Now scoped to
                                                    // exactly this item via the new
                                                    // /api/imports/items/retry endpoint.
                                                    onClick={() =>
                                                      void handleRetrySingleItem(
                                                        importRow,
                                                        item
                                                      )
                                                    }
                                                    type="button"
                                                  >
                                                    {retryingItemId ===
                                                    item.id ? (
                                                      <>
                                                        <span className="spinner-sm" />{" "}
                                                        {tImpActions(
                                                          "retrying"
                                                        )}
                                                      </>
                                                    ) : (
                                                      tImpActions("retry_now")
                                                    )}
                                                  </button>
                                                )}
                                                {canEditRetry && !editing && (
                                                  <button
                                                    className="pill-button"
                                                    onClick={() =>
                                                      handleRetryItem(
                                                        importRow,
                                                        item
                                                      )
                                                    }
                                                    type="button"
                                                  >
                                                    {tImpActions(
                                                      "change_match"
                                                    )}
                                                  </button>
                                                )}
                                                {/* Escape hatch for rows the App Store search
                                      can't reach — Safari web clips, TestFlight
                                      betas, personal builds, sideloaded apps.
                                      Deep-links to the manual-apps editor with
                                      the name prefilled. The form defaults its
                                      source to 'web_clip', which is the most
                                      common reason a Configurator row has no
                                      App Store match; users can flip the
                                      source on the next screen if needed. */}
                                                {canEditRetry && !editing && (
                                                  <Link
                                                    className="pill-button"
                                                    href={{
                                                      pathname:
                                                        "/dashboard/manual-apps",
                                                      query: {
                                                        prefillName:
                                                          displayQuery,
                                                      },
                                                    }}
                                                  >
                                                    {tImpActions(
                                                      "mark_manual_app"
                                                    )}
                                                  </Link>
                                                )}
                                                {editing && (
                                                  <button
                                                    className="pill-button pill-button-ghost"
                                                    disabled={applying}
                                                    onClick={closeChangeMatch}
                                                    type="button"
                                                  >
                                                    {tImpActions("cancel")}
                                                  </button>
                                                )}
                                              </div>

                                              {editing && changeMatch && (
                                                <div className="change-match-panel">
                                                  <div className="change-match-title">
                                                    {changeMatch.mode ===
                                                    "readd"
                                                      ? tImpChangeMatch(
                                                          "title_readd"
                                                        )
                                                      : tImpChangeMatch(
                                                          "title_change"
                                                        )}
                                                  </div>
                                                  {/* Rate-limit banner — surfaces an active iTunes
                                        Search cooldown so a user staring at "0 results"
                                        understands it's Apple, not their typo. The
                                        onResume callback re-runs the same query the
                                        user already typed, so the auto-retry path
                                        feels like the search "just resumed" rather
                                        than requiring a manual click. */}
                                                  <RateLimitBanner
                                                    category="search"
                                                    onResume={() => {
                                                      if (
                                                        changeMatch.query.trim()
                                                      ) {
                                                        void runChangeMatchSearch();
                                                      }
                                                    }}
                                                  />
                                                  {/* Two-field search to mirror the CSV
                                        import flow: the iTunes Search API
                                        accepts a developer/seller hint that
                                        re-ranks candidates, which is critical
                                        for common app names (e.g. "Camera"
                                        or "Notes" where many apps share the
                                        title). Leaving Seller blank is fine —
                                        the server just ranks on name only. */}
                                                  <div className="change-match-search">
                                                    <label className="change-match-field">
                                                      <span className="change-match-label">
                                                        {tImpChangeMatch(
                                                          "app_name_label"
                                                        )}
                                                      </span>
                                                      <input
                                                        className="change-match-input"
                                                        disabled={applying}
                                                        onChange={(event) =>
                                                          setChangeMatch(
                                                            (prev) =>
                                                              prev
                                                                ? {
                                                                    ...prev,
                                                                    query:
                                                                      event
                                                                        .target
                                                                        .value,
                                                                    error: "",
                                                                  }
                                                                : prev
                                                          )
                                                        }
                                                        onKeyDown={(event) => {
                                                          if (
                                                            event.key ===
                                                            "Enter"
                                                          ) {
                                                            event.preventDefault();
                                                            void runChangeMatchSearch();
                                                          }
                                                        }}
                                                        placeholder={tPh(
                                                          "app_name_eg"
                                                        )}
                                                        type="text"
                                                        value={
                                                          changeMatch.query
                                                        }
                                                      />
                                                    </label>
                                                    <label className="change-match-field">
                                                      <span className="change-match-label">
                                                        {tImpChangeMatch(
                                                          "seller_label"
                                                        )}
                                                      </span>
                                                      <input
                                                        className="change-match-input"
                                                        disabled={applying}
                                                        onChange={(event) =>
                                                          setChangeMatch(
                                                            (prev) =>
                                                              prev
                                                                ? {
                                                                    ...prev,
                                                                    developer:
                                                                      event
                                                                        .target
                                                                        .value,
                                                                    error: "",
                                                                  }
                                                                : prev
                                                          )
                                                        }
                                                        onKeyDown={(event) => {
                                                          if (
                                                            event.key ===
                                                            "Enter"
                                                          ) {
                                                            event.preventDefault();
                                                            void runChangeMatchSearch();
                                                          }
                                                        }}
                                                        placeholder={tPh(
                                                          "developer_eg"
                                                        )}
                                                        type="text"
                                                        value={
                                                          changeMatch.developer
                                                        }
                                                      />
                                                    </label>
                                                    <button
                                                      className="btn btn-secondary btn-sm change-match-search-btn"
                                                      disabled={
                                                        applying ||
                                                        changeMatch.searching ||
                                                        !changeMatch.query.trim()
                                                      }
                                                      onClick={() =>
                                                        void runChangeMatchSearch()
                                                      }
                                                      type="button"
                                                    >
                                                      {changeMatch.searching ? (
                                                        <>
                                                          <span className="spinner-sm" />{" "}
                                                          {tImpChangeMatch(
                                                            "searching"
                                                          )}
                                                        </>
                                                      ) : (
                                                        tImpChangeMatch(
                                                          "search"
                                                        )
                                                      )}
                                                    </button>
                                                  </div>

                                                  {changeMatch.error && (
                                                    <div className="import-item-error">
                                                      {changeMatch.error}
                                                    </div>
                                                  )}

                                                  {changeMatch.results !==
                                                    null &&
                                                    !changeMatch.searching &&
                                                    (changeMatch.results
                                                      .length === 0 ? (
                                                      <div className="change-match-empty">
                                                        {tImpChangeMatch(
                                                          "empty"
                                                        )}
                                                      </div>
                                                    ) : (
                                                      <ul className="change-match-results">
                                                        {changeMatch.results.map(
                                                          (candidate) => {
                                                            const isCurrent =
                                                              item.appId ===
                                                                candidate.appleId ||
                                                              item.removedAppId ===
                                                                candidate.appleId;
                                                            const isApplying =
                                                              changeMatch.applyingAppleId ===
                                                              candidate.appleId;
                                                            return (
                                                              <li
                                                                className="change-match-result"
                                                                key={
                                                                  candidate.appleId
                                                                }
                                                              >
                                                                {candidate.iconUrl ? (
                                                                  <img
                                                                    alt=""
                                                                    className="change-match-icon"
                                                                    height={36}
                                                                    src={
                                                                      candidate.iconUrl
                                                                    }
                                                                    width={36}
                                                                  />
                                                                ) : (
                                                                  <div className="change-match-icon change-match-icon-empty" />
                                                                )}
                                                                <div className="change-match-result-body">
                                                                  <div className="change-match-result-name">
                                                                    {
                                                                      candidate.name
                                                                    }
                                                                  </div>
                                                                  <div className="change-match-result-dev">
                                                                    {
                                                                      candidate.developer
                                                                    }
                                                                  </div>
                                                                  <a
                                                                    className="change-match-result-link"
                                                                    href={
                                                                      candidate.url
                                                                    }
                                                                    rel="noopener noreferrer"
                                                                    target="_blank"
                                                                  >
                                                                    {tImpChangeMatch(
                                                                      "view_app_store"
                                                                    )}
                                                                  </a>
                                                                </div>
                                                                <button
                                                                  className="pill-button"
                                                                  disabled={
                                                                    applying
                                                                  }
                                                                  onClick={() =>
                                                                    void applyChangeMatch(
                                                                      importRow,
                                                                      item,
                                                                      candidate
                                                                    )
                                                                  }
                                                                  type="button"
                                                                >
                                                                  {isApplying ? (
                                                                    <>
                                                                      <span className="spinner-sm" />{" "}
                                                                      {tImpChangeMatch(
                                                                        "applying"
                                                                      )}
                                                                    </>
                                                                  ) : isCurrent &&
                                                                    changeMatch.mode ===
                                                                      "change" ? (
                                                                    tImpChangeMatch(
                                                                      "rescrape"
                                                                    )
                                                                  ) : changeMatch.mode ===
                                                                    "readd" ? (
                                                                    tImpChangeMatch(
                                                                      "re_add"
                                                                    )
                                                                  ) : (
                                                                    tImpChangeMatch(
                                                                      "use_this"
                                                                    )
                                                                  )}
                                                                </button>
                                                              </li>
                                                            );
                                                          }
                                                        )}
                                                      </ul>
                                                    ))}
                                                </div>
                                              )}
                                            </li>
                                          );
                                        })}
                                      </ul>
                                    );
                                  })()
                                ) : /* Empty-state for expanded imports. Split into two
                           cases so the user understands *why* the list is
                           empty:
                             (1) legacy imports that predate the items-write
                                 path (`itemCount === 0` server-side). We
                                 can't rebuild them — tell the user plainly.
                             (2) fetch returned but with `items === []` (rare
                                 — usually a race between the expand and a
                                 concurrent delete). Offer a reload. */
                                importRow.itemCount === 0 ? (
                                  <div className="import-history-items-empty">
                                    <div
                                      style={{
                                        fontWeight: 500,
                                        marginBottom: 4,
                                      }}
                                    >
                                      {tImpLegacy("title")}
                                    </div>
                                    <div
                                      style={{
                                        fontSize: 13,
                                        color: "var(--text-3)",
                                      }}
                                    >
                                      {tImpLegacy("body")}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="import-history-items-empty">
                                    <div
                                      style={{
                                        fontWeight: 500,
                                        marginBottom: 4,
                                      }}
                                    >
                                      {tImpCouldntLoad("title")}
                                    </div>
                                    <div
                                      style={{
                                        fontSize: 13,
                                        color: "var(--text-3)",
                                        marginBottom: 8,
                                      }}
                                    >
                                      {tImpCouldntLoad("body", {
                                        count: importRow.itemCount,
                                      })}
                                    </div>
                                    <button
                                      className="pill-button"
                                      onClick={() => {
                                        // Drop any cached (empty) entry so
                                        // toggleImportRow re-fetches.
                                        setExpandedItems((prev) => {
                                          const next = { ...prev };
                                          delete next[importRow.id];
                                          return next;
                                        });
                                        setExpandedImportId(null);
                                        setTimeout(
                                          () => void toggleImportRow(importRow),
                                          0
                                        );
                                      }}
                                      type="button"
                                    >
                                      {tImpCouldntLoad("retry")}
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()
              )}
            </div>
          )}

          {viewMode === "all" && (
            <>
              <h3 className="settings-group-heading">
                {tSettings("sidebar.group_admin")}
              </h3>

              {/* Import History — full section on the standalone page, otherwise
          a compact link card in the main Settings view. Keeping the big
          review-and-retry UI on its own page lets the Settings landing
          stay scannable and gives the history enough room for the
          expandable rows + inline change-match flow. */}
              {viewMode === "all" && settingsImportHistoryOn && (
                <div className="settings-section" id="import-history">
                  <h2 className="settings-section-title">
                    {tSections("import_history")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tImpHistoryCard("subtitle")}
                  </p>
                  <Link
                    className="btn btn-secondary"
                    href="/dashboard/settings/import-history"
                  >
                    {tImpHistoryCard("open_link")}
                  </Link>
                  {importQueue.state.queued > 0 && (
                    <p
                      style={{
                        fontSize: 12,
                        color: "var(--orange)",
                        marginTop: 10,
                      }}
                    >
                      {tImpHistoryCard("queue_note", {
                        count: importQueue.state.queued,
                      })}
                    </p>
                  )}
                </div>
              )}

              <div className="settings-section" id="deployment-diagnostics">
                <h2 className="settings-section-title">
                  {tSections("deployment_diagnostics")}
                </h2>
                <p className="settings-section-subtitle">
                  {tSub("deployment_diagnostics")}
                </p>

                {deploymentDiagnosticsLoading && !deploymentDiagnostics ? (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      color: "var(--text-3)",
                    }}
                  >
                    <span className="spinner-sm" /> {tDeploy("loading")}
                  </div>
                ) : deploymentDiagnostics ? (
                  <>
                    <div className="settings-status-grid deployment-diagnostics-grid">
                      <div className="settings-status-item">
                        <div className="settings-status-label">
                          {tDeploy("version")}
                        </div>
                        <div className="settings-status-value">
                          {deploymentDiagnostics.app.version}
                        </div>
                      </div>
                      <div className="settings-status-item">
                        <div className="settings-status-label">
                          {tDeploy("health")}
                        </div>
                        <div
                          className="settings-status-value"
                          style={{
                            color:
                              deploymentDiagnostics.health.status === "ok"
                                ? "var(--green)"
                                : "var(--danger)",
                          }}
                        >
                          {deploymentDiagnostics.health.status === "ok"
                            ? tDeploy("health_ok")
                            : tDeploy("health_degraded")}
                        </div>
                      </div>
                      <div className="settings-status-item">
                        <div className="settings-status-label">
                          {tDeploy("database")}
                        </div>
                        <div
                          className="settings-status-value"
                          style={{
                            color: deploymentDiagnostics.database.writable
                              ? "var(--green)"
                              : "var(--danger)",
                          }}
                        >
                          {deploymentDiagnostics.database.writable
                            ? tDeploy("writable")
                            : tDeploy("not_writable")}
                        </div>
                      </div>
                      <div className="settings-status-item">
                        <div className="settings-status-label">
                          {tDeploy("access")}
                        </div>
                        <div className="settings-status-value">
                          {deploymentDiagnostics.network.localOnlyHost
                            ? tDeploy("access_local")
                            : tDeploy("access_lan")}
                        </div>
                      </div>
                    </div>

                    <div className="deployment-admin-card">
                      <div>
                        <div className="deployment-admin-title">
                          {tDeploy("admin_unlock_title")}
                        </div>
                        <p className="deployment-admin-copy">
                          {deploymentDiagnostics.security.adminTokenConfigured
                            ? tDeploy("admin_unlock_body_configured")
                            : tDeploy("admin_unlock_body_off")}
                        </p>
                        <div
                          className={`deployment-admin-state${adminTokenUnlocked ? "is-unlocked" : ""}`}
                          role="status"
                        >
                          {adminTokenUnlocked
                            ? tDeploy("session_unlocked")
                            : tDeploy("session_locked")}
                        </div>
                      </div>
                      {deploymentDiagnostics.security.adminTokenConfigured ? (
                        <div className="deployment-admin-controls">
                          <label className="settings-field" style={{ gap: 6 }}>
                            <span className="settings-field-label">
                              {tDeploy("admin_token_input")}
                            </span>
                            <input
                              autoComplete="off"
                              className="settings-input"
                              onChange={(event) =>
                                setAdminTokenInput(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  saveSessionAdminToken();
                                }
                              }}
                              placeholder={tDeploy("admin_token_placeholder")}
                              type="password"
                              value={adminTokenInput}
                            />
                          </label>
                          <div className="deployment-admin-actions">
                            <button
                              className="btn btn-secondary"
                              disabled={!adminTokenInput.trim()}
                              onClick={saveSessionAdminToken}
                              type="button"
                            >
                              {tDeploy("admin_unlock")}
                            </button>
                            <button
                              className="btn btn-ghost"
                              disabled={!adminTokenUnlocked}
                              onClick={clearSessionAdminToken}
                              type="button"
                            >
                              {tDeploy("admin_lock")}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div
                      aria-label={tDeploy("checks_aria")}
                      className="deployment-check-list"
                    >
                      {deploymentDiagnostics.checks.map((check) => (
                        <div
                          className={`deployment-check deployment-check-${check.status}`}
                          key={check.id}
                        >
                          <div className="deployment-check-main">
                            <span
                              aria-hidden="true"
                              className="deployment-check-dot"
                            />
                            <div>
                              <div className="deployment-check-title">
                                {check.label}
                              </div>
                              <div className="deployment-check-detail">
                                {check.detail}
                              </div>
                            </div>
                          </div>
                          <span className="deployment-check-status">
                            {tDeploy(`status_${check.status}`)}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="deployment-detail-grid">
                      <div className="deployment-detail-row">
                        <span>{tDeploy("db_path")}</span>
                        <code>{deploymentDiagnostics.database.path}</code>
                      </div>
                      <div className="deployment-detail-row">
                        <span>{tDeploy("db_size")}</span>
                        <strong>
                          {fmtBytes(deploymentDiagnostics.database.sizeBytes)}
                        </strong>
                      </div>
                      <div className="deployment-detail-row">
                        <span>{tDeploy("host")}</span>
                        <code>
                          {deploymentDiagnostics.network.host ??
                            tDeploy("unknown")}
                        </code>
                      </div>
                      <div className="deployment-detail-row">
                        <span>{tDeploy("proxy")}</span>
                        <strong>
                          {deploymentDiagnostics.network.proxyDetected
                            ? tDeploy("proxy_detected")
                            : tDeploy("proxy_not_detected")}
                        </strong>
                      </div>
                      <div className="deployment-detail-row">
                        <span>{tDeploy("admin_token")}</span>
                        <strong>
                          {deploymentDiagnostics.security.adminTokenConfigured
                            ? tDeploy("admin_token_on")
                            : tDeploy("admin_token_off")}
                        </strong>
                      </div>
                      <div className="deployment-detail-row">
                        <span>{tDeploy("runtime")}</span>
                        <strong>
                          {deploymentDiagnostics.app.runtime === "desktop"
                            ? tDeploy("runtime_desktop")
                            : deploymentDiagnostics.app.containerLikely
                              ? tDeploy("runtime_container")
                              : tDeploy("runtime_web")}
                        </strong>
                      </div>
                    </div>

                    <button
                      className="btn btn-secondary"
                      disabled={deploymentDiagnosticsLoading}
                      onClick={() => void loadDeploymentDiagnostics()}
                      style={{ marginTop: 16 }}
                      type="button"
                    >
                      {deploymentDiagnosticsLoading ? (
                        <>
                          <span className="spinner" /> {tDeploy("refreshing")}
                        </>
                      ) : (
                        tDeploy("refresh")
                      )}
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={copyingDeploymentDiagnostics}
                      onClick={() => void copyDeploymentSupportBundle()}
                      style={{ marginTop: 16, marginLeft: 8 }}
                      type="button"
                    >
                      {copyingDeploymentDiagnostics ? (
                        <>
                          <span className="spinner" /> {tDeploy("copying")}
                        </>
                      ) : (
                        tDeploy("copy_bundle")
                      )}
                    </button>
                  </>
                ) : (
                  <div className="settings-help-card" role="status">
                    <div className="settings-help-title">
                      {tDeploy("unavailable_title")}
                    </div>
                    <p className="settings-help-copy">
                      {deploymentDiagnosticsError ||
                        tDeploy("unavailable_body")}
                    </p>
                    <button
                      className="btn btn-secondary"
                      disabled={deploymentDiagnosticsLoading}
                      onClick={() => void loadDeploymentDiagnostics()}
                      type="button"
                    >
                      {deploymentDiagnosticsLoading ? (
                        <>
                          <span className="spinner" /> {tDeploy("refreshing")}
                        </>
                      ) : (
                        tDeploy("try_again")
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Backup & Restore */}
              {settingsAdminBackupOn && (
                <div className="settings-section" id="backup">
                  <h2 className="settings-section-title">
                    {tSections("backup_restore")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("backup_restore")}
                  </p>

                  <div className="backup-grid">
                    <div className="backup-card">
                      <div className="backup-card-title">
                        {tBackupCard("download_title")}
                      </div>
                      <p className="backup-card-copy">
                        {tBackupCard("download_copy")}
                      </p>
                      <button
                        className="btn btn-secondary"
                        disabled={exportingBackup}
                        onClick={handleExportBackup}
                        type="button"
                      >
                        {exportingBackup
                          ? tBackupCard("download_busy")
                          : tBackupCard("download_button")}
                      </button>
                    </div>

                    <div className="backup-card">
                      <div className="backup-card-title">
                        {tBackupCard("restore_title")}
                      </div>
                      <p className="backup-card-copy">
                        {tBackupCard("restore_copy_lead")}{" "}
                        <strong>{tBackupCard("restore_copy_strong")}</strong>{" "}
                        {tBackupCard("restore_copy_after")}
                      </p>
                      <label
                        className={`btn btn-secondary${status?.isRunning || restoreStage === "previewing" || restoreStage === "applying" ? "is-disabled" : ""}`}
                        style={{
                          cursor: status?.isRunning ? "not-allowed" : "pointer",
                        }}
                      >
                        {restoreStage === "previewing"
                          ? tBackupCard("restore_busy")
                          : tBackupCard("restore_choose")}
                        <input
                          accept="application/json,.json"
                          disabled={
                            Boolean(status?.isRunning) ||
                            restoreStage === "previewing" ||
                            restoreStage === "applying"
                          }
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            // Clear the input so choosing the same filename twice still
                            // triggers onChange (common UX pain with <input type="file">).
                            event.target.value = "";
                            if (file) {
                              handleRestoreFileChosen(file);
                            }
                          }}
                          style={{ display: "none" }}
                          type="file"
                        />
                      </label>
                      {status?.isRunning && (
                        <p
                          style={{
                            fontSize: 12,
                            color: "var(--text-3)",
                            marginTop: 8,
                          }}
                        >
                          {tBackupCard("wait_for_sync")}
                        </p>
                      )}
                      {restoreError && restoreStage === "idle" && (
                        <p
                          style={{
                            fontSize: 12,
                            color: "var(--danger)",
                            marginTop: 8,
                          }}
                        >
                          {restoreError}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="backup-snapshot-panel">
                    <div className="backup-snapshot-header">
                      <div>
                        <div className="backup-card-title">
                          {tBackupCard("snapshots_title")}
                        </div>
                        <p className="backup-snapshot-copy">
                          {tBackupCard("snapshots_copy")}
                        </p>
                      </div>
                      <span
                        className={`backup-snapshot-state${backupSnapshotSettings.enabled ? "is-on" : ""}`}
                      >
                        {backupSnapshotSettings.enabled
                          ? tBackupCard("snapshots_state_on")
                          : tBackupCard("snapshots_state_off")}
                      </span>
                    </div>

                    <label className="settings-checkbox-row backup-snapshot-toggle">
                      <input
                        checked={backupSnapshotSettings.enabled}
                        className="settings-checkbox"
                        disabled={backupSnapshotsAutoSave.saving}
                        // Auto-save: flipping enabled saves immediately with the
                        // existing interval/retention values. The PUT route
                        // returns the persisted blob which we re-baseline via
                        // applyBackupSnapshotPayload (handles clamping etc.).
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setBackupSnapshotSettings((prev) => ({
                            ...prev,
                            enabled,
                          }));
                          saveBackupSnapshots({
                            enabled,
                            intervalHours: backupSnapshotSettings.intervalHours,
                            retentionCount:
                              backupSnapshotSettings.retentionCount,
                          });
                        }}
                        type="checkbox"
                      />
                      <span>
                        <span className="settings-field-label">
                          {tBackupCard("snapshots_enabled_label")}
                        </span>
                        <span
                          className="settings-field-help"
                          style={{ display: "block", marginTop: 4 }}
                        >
                          {tBackupCard("snapshots_enabled_help")}
                        </span>
                      </span>
                    </label>

                    <div className="settings-field-grid backup-snapshot-controls">
                      <label className="settings-field">
                        <span className="settings-field-label">
                          {tBackupCard("snapshots_interval_label")}
                        </span>
                        <select
                          className="settings-input settings-select"
                          disabled={backupSnapshotsAutoSave.saving}
                          // Discrete dropdown → save on change.
                          onChange={(event) => {
                            const intervalHours = Number(event.target.value);
                            setBackupSnapshotSettings((prev) => ({
                              ...prev,
                              intervalHours,
                            }));
                            saveBackupSnapshots({
                              enabled: backupSnapshotSettings.enabled,
                              intervalHours,
                              retentionCount:
                                backupSnapshotSettings.retentionCount,
                            });
                          }}
                          value={backupSnapshotSettings.intervalHours}
                        >
                          <option value={6}>
                            {tBackupCard("snapshots_interval_6h")}
                          </option>
                          <option value={12}>
                            {tBackupCard("snapshots_interval_12h")}
                          </option>
                          <option value={24}>
                            {tBackupCard("snapshots_interval_24h")}
                          </option>
                          <option value={168}>
                            {tBackupCard("snapshots_interval_168h")}
                          </option>
                        </select>
                      </label>

                      <label className="settings-field">
                        <span className="settings-field-label">
                          {tBackupCard("snapshots_retention_label")}
                        </span>
                        <input
                          className="settings-input"
                          disabled={backupSnapshotsAutoSave.saving}
                          max={100}
                          min={1}
                          // Numeric → save on blur. The clamp above already
                          // guarantees 1..100 by the time we get here.
                          onBlur={() => {
                            saveBackupSnapshots({
                              enabled: backupSnapshotSettings.enabled,
                              intervalHours:
                                backupSnapshotSettings.intervalHours,
                              retentionCount:
                                backupSnapshotSettings.retentionCount,
                            });
                          }}
                          onChange={(event) => {
                            const raw = Number.parseInt(event.target.value, 10);
                            const retentionCount = Number.isFinite(raw)
                              ? Math.min(100, Math.max(1, raw))
                              : 1;
                            setBackupSnapshotSettings((prev) => ({
                              ...prev,
                              retentionCount,
                            }));
                          }}
                          type="number"
                          value={backupSnapshotSettings.retentionCount}
                        />
                      </label>
                    </div>

                    <div className="backup-snapshot-actions">
                      {/* Save button removed — fields auto-save above. The
                "Create snapshot now" button stays since it's a
                separate action (POST creates a fresh snapshot rather
                than persisting settings). */}
                      <button
                        className="btn btn-secondary"
                        disabled={creatingBackupSnapshot}
                        onClick={() => void handleCreateBackupSnapshot()}
                        type="button"
                      >
                        {creatingBackupSnapshot
                          ? tBackupCard("snapshots_creating")
                          : tBackupCard("snapshots_create")}
                      </button>
                    </div>

                    <dl className="backup-snapshot-meta">
                      <div>
                        <dt>{tBackupCard("snapshots_directory")}</dt>
                        <dd>
                          <code title={backupSnapshotDirectory}>
                            {backupSnapshotDirectory ||
                              tBackupCard("snapshots_directory_empty")}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>{tBackupCard("snapshots_last")}</dt>
                        <dd>
                          {backupSnapshotSettings.lastRunAt
                            ? fmtDate(
                                tSettings,
                                backupSnapshotSettings.lastRunAt
                              )
                            : tBackupCard("snapshots_never")}
                        </dd>
                      </div>
                      <div>
                        <dt>{tBackupCard("snapshots_next")}</dt>
                        <dd>
                          {backupSnapshotSettings.enabled
                            ? backupSnapshotSettings.nextRunAt
                              ? fmtDate(
                                  tSettings,
                                  backupSnapshotSettings.nextRunAt
                                )
                              : tBackupCard("snapshots_next_due")
                            : tBackupCard("snapshots_not_scheduled")}
                        </dd>
                      </div>
                    </dl>

                    <div className="backup-snapshot-list-heading">
                      {tBackupCard("snapshots_latest")}
                    </div>
                    {backupSnapshots.length === 0 ? (
                      <p className="backup-snapshot-empty">
                        {tBackupCard("snapshots_none")}
                      </p>
                    ) : (
                      <div className="backup-snapshot-list">
                        {backupSnapshots.slice(0, 5).map((row) => (
                          <div
                            className="backup-snapshot-row"
                            key={row.filename}
                          >
                            <div className="backup-snapshot-file">
                              <strong>{row.filename}</strong>
                              <span>
                                {tBackupCard("snapshots_file_meta", {
                                  date: fmtDate(tSettings, row.createdAt),
                                  size: fmtBytes(row.sizeBytes),
                                })}
                              </span>
                            </div>
                            <a
                              className="btn btn-secondary backup-snapshot-download"
                              download={row.filename}
                              href={`/api/backup/snapshots/${encodeURIComponent(row.filename)}`}
                            >
                              {tBackupCard("snapshots_download")}
                            </a>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--text-3)",
                      marginTop: 12,
                    }}
                  >
                    {tBackupCard("destructive_hint")}
                  </p>

                  {/*
          Audit-bundle import — counterpart to the export button down in
          "Export Data". Lives in the Backup & Restore section because
          (a) it's the symmetric "receive a file someone shared with
          you" surface, and (b) it shares the same ?confirm=preview-then-
          commit pattern as the database restore flow above. The
          underlying merge is non-destructive (apps you have stay,
          notes get appended) — see lib/audit-bundle-import.ts §4.8.
        */}
                  <div
                    style={{
                      marginTop: 18,
                      paddingTop: 16,
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <AuditBundleImport />
                  </div>
                </div>
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
                <div className="settings-section" id="wayback-import">
                  <h2 className="settings-section-title">
                    <span
                      aria-hidden="true"
                      className="wayback-icon-inline"
                      style={{ marginRight: 8 }}
                    >
                      🕰
                    </span>
                    {tWayback("title")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tWayback("subtitle")}
                  </p>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 10,
                      marginTop: 12,
                    }}
                  >
                    <button
                      className="btn btn-secondary"
                      disabled={
                        waybackRunning ||
                        waybackRemoving ||
                        waybackControlBusy !== null ||
                        waybackRunStatus === "paused" ||
                        waybackRunStatus === "pause_requested" ||
                        waybackRunStatus === "cancel_requested"
                      }
                      onClick={() => void runBulkWaybackImport()}
                      title={tWayback("import_title")}
                      type="button"
                    >
                      {waybackRunning ? (
                        <>
                          <span className="spinner" /> {tWayback("import_busy")}
                        </>
                      ) : (
                        tWayback("import_button")
                      )}
                    </button>
                    {(waybackRunStatus === "running" ||
                      waybackRunStatus === "pause_requested") && (
                      <button
                        className="btn btn-secondary"
                        disabled={
                          waybackControlBusy !== null ||
                          waybackRunStatus === "pause_requested"
                        }
                        onClick={() => void controlWaybackImport("pause")}
                        title={tWayback("pause_title")}
                        type="button"
                      >
                        {waybackControlBusy === "pause" ||
                        waybackRunStatus === "pause_requested" ? (
                          <>
                            <span className="spinner" />{" "}
                            {tWayback("pause_busy")}
                          </>
                        ) : (
                          tWayback("pause_button")
                        )}
                      </button>
                    )}
                    {waybackRunStatus === "paused" && (
                      <button
                        className="btn btn-secondary"
                        disabled={waybackControlBusy !== null}
                        onClick={() => void controlWaybackImport("resume")}
                        title={tWayback("resume_title")}
                        type="button"
                      >
                        {waybackControlBusy === "resume" ? (
                          <>
                            <span className="spinner" />{" "}
                            {tWayback("resume_busy")}
                          </>
                        ) : (
                          tWayback("resume_button")
                        )}
                      </button>
                    )}
                    {(waybackRunStatus === "running" ||
                      waybackRunStatus === "pause_requested" ||
                      waybackRunStatus === "paused" ||
                      waybackRunStatus === "cancel_requested") && (
                      <button
                        className="btn btn-secondary"
                        disabled={
                          waybackControlBusy !== null ||
                          waybackRunStatus === "cancel_requested"
                        }
                        onClick={() => void controlWaybackImport("cancel")}
                        title={tWayback("cancel_title")}
                        type="button"
                      >
                        {waybackControlBusy === "cancel" ||
                        waybackRunStatus === "cancel_requested" ? (
                          <>
                            <span className="spinner" />{" "}
                            {tWayback("cancel_busy")}
                          </>
                        ) : (
                          tWayback("cancel_button")
                        )}
                      </button>
                    )}
                    {(waybackRunStatus === "paused" ||
                      waybackRunStatus === "stale") && (
                      <button
                        className="btn btn-secondary"
                        disabled={
                          waybackControlBusy !== null || waybackRemoving
                        }
                        onClick={() =>
                          void runBulkWaybackImport({ force: true })
                        }
                        title={tWayback("force_title")}
                        type="button"
                      >
                        {waybackControlBusy === "force" ? (
                          <>
                            <span className="spinner" />{" "}
                            {tWayback("force_busy")}
                          </>
                        ) : (
                          tWayback("force_button")
                        )}
                      </button>
                    )}
                    <button
                      className="btn btn-secondary"
                      disabled={
                        waybackRunning ||
                        waybackRemoving ||
                        waybackControlBusy !== null
                      }
                      onClick={() => setWaybackRemoveOpen(true)}
                      title={tWayback("remove_title")}
                      type="button"
                    >
                      {waybackRemoving ? (
                        <>
                          <span className="spinner" /> {tWayback("remove_busy")}
                        </>
                      ) : (
                        tWayback("remove_button")
                      )}
                    </button>
                  </div>

                  <label
                    className="settings-checkbox-row"
                    style={{ marginTop: 14 }}
                  >
                    <input
                      checked={waybackShowImported}
                      className="settings-checkbox"
                      disabled={waybackToggleAutoSave.saving}
                      onChange={(event) =>
                        void saveWaybackShowImported(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>
                      {tWayback("show_imported_label")}
                      <span
                        className="settings-field-help"
                        style={{ display: "block", marginTop: 4 }}
                      >
                        {tWayback("show_imported_help")}
                      </span>
                    </span>
                  </label>

                  {/*
          Status card for the Historical Import. Three display modes, in
          priority order:
            1. A run is actively streaming (waybackRunning + waybackProgress):
               show a live "Importing n/N · AppName" line plus running
               tallies for imported / no-op / skipped / failed.
            2. A run finished during this page visit (waybackRunning=false
               and waybackProgress is still populated for a split second
               before the finally-block clears it) — treated the same as #1
               for rendering purposes.
            3. Otherwise, hydrate from `waybackLastRun` (loaded on mount
               and refreshed at the end of every run) so reloading the page
               still shows "Last run: 3 imported, 1 failed — 2 hr ago".
          The surrounding block only renders when we have something to say,
          so first-visit users with no runs yet see nothing extra.
        */}
                  {waybackProgress || waybackLastRun || waybackSummary ? (
                    <div
                      className="settings-status-card"
                      style={{
                        marginTop: 14,
                        padding: 12,
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        background: "var(--surface-2, rgba(0,0,0,0.02))",
                        fontSize: 13,
                        color: "var(--text-2)",
                      }}
                    >
                      {waybackProgress ? (
                        <div>
                          {/*
                  Resume banner — only rendered when this run was picked up
                  automatically by instrumentation.ts after a server restart.
                  Distinct from the "live tally" line below so users
                  understand a background import is in flight that nobody
                  on this page clicked. Uses the purple accent already used
                  for Wayback-sourced rows in the changelog timeline so the
                  visual language is consistent.
                */}
                          {waybackInitiator === "resume" ? (
                            <div
                              role="status"
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "6px 10px",
                                marginBottom: 8,
                                borderRadius: 6,
                                background: "rgba(124, 58, 237, 0.10)",
                                color: "var(--accent-wayback, #6d28d9)",
                                fontSize: 12,
                                lineHeight: 1.35,
                              }}
                            >
                              <span aria-hidden="true">↻</span>
                              <span>
                                <strong style={{ marginRight: 4 }}>
                                  {tWayback("resume_label")}
                                </strong>
                                {tWayback("resume_body")}
                              </span>
                            </div>
                          ) : null}
                          {waybackRunStatus === "paused" ? (
                            <div
                              role="status"
                              style={{
                                padding: "6px 10px",
                                marginBottom: 8,
                                borderRadius: 6,
                                background: "rgba(217, 119, 6, 0.12)",
                                color: "var(--warning, #b45309)",
                                fontSize: 12,
                                lineHeight: 1.35,
                              }}
                            >
                              <strong style={{ marginRight: 4 }}>
                                {tWayback("paused_label")}
                              </strong>
                              {tWayback("paused_body")}
                            </div>
                          ) : null}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              marginBottom: 6,
                            }}
                          >
                            {waybackRunStatus === "paused" ? (
                              <span aria-hidden="true">Ⅱ</span>
                            ) : (
                              <span aria-hidden="true" className="spinner" />
                            )}
                            <strong style={{ color: "var(--text-1)" }}>
                              {waybackRunStatus === "pause_requested"
                                ? tWayback("pause_requested")
                                : waybackRunStatus === "cancel_requested"
                                  ? tWayback("cancel_requested")
                                  : waybackRunStatus === "paused"
                                    ? tWayback("paused_progress")
                                    : waybackProgress.total > 0
                                      ? tWayback("progress_lead", {
                                          current: Math.min(
                                            waybackProgress.index,
                                            waybackProgress.total
                                          ),
                                          total: waybackProgress.total,
                                        })
                                      : tWayback("starting")}
                            </strong>
                            {waybackProgress.currentAppName ? (
                              <span style={{ color: "var(--text-2)" }}>
                                · {waybackProgress.currentAppName}
                              </span>
                            ) : null}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 12,
                              color: "var(--text-2)",
                            }}
                          >
                            <span>
                              <strong style={{ color: "var(--text-1)" }}>
                                {waybackProgress.imported}
                              </strong>{" "}
                              {tWayback("stat_imported")}
                            </span>
                            {waybackProgress.unchanged > 0 ? (
                              <span>
                                <strong style={{ color: "var(--text-1)" }}>
                                  {waybackProgress.unchanged}
                                </strong>{" "}
                                {tWayback("stat_no_op")}
                              </span>
                            ) : null}
                            {waybackProgress.skipped > 0 ? (
                              <span>
                                <strong style={{ color: "var(--text-1)" }}>
                                  {waybackProgress.skipped}
                                </strong>{" "}
                                {tWayback("stat_skipped")}
                              </span>
                            ) : null}
                            <span
                              style={{
                                color:
                                  waybackProgress.failed > 0
                                    ? "var(--danger, #b91c1c)"
                                    : undefined,
                              }}
                            >
                              <strong
                                style={{
                                  color:
                                    waybackProgress.failed > 0
                                      ? "var(--danger, #b91c1c)"
                                      : "var(--text-1)",
                                }}
                              >
                                {waybackProgress.failed}
                              </strong>{" "}
                              {tWayback("stat_failed")}
                            </span>
                          </div>
                        </div>
                      ) : waybackLastRun ? (
                        <div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              flexWrap: "wrap",
                              marginBottom: 6,
                            }}
                          >
                            <span
                              aria-label={tWayback("status_aria", {
                                status: waybackLastRun.status,
                              })}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                padding: "2px 8px",
                                borderRadius: 999,
                                fontSize: 11,
                                fontWeight: 600,
                                textTransform: "uppercase",
                                letterSpacing: 0.3,
                                background:
                                  waybackLastRun.status === "ok"
                                    ? "rgba(22,163,74,0.12)"
                                    : waybackLastRun.status === "partial"
                                      ? "rgba(217,119,6,0.14)"
                                      : "rgba(220,38,38,0.14)",
                                color:
                                  waybackLastRun.status === "ok"
                                    ? "var(--success, #15803d)"
                                    : waybackLastRun.status === "partial"
                                      ? "var(--warning, #b45309)"
                                      : "var(--danger, #b91c1c)",
                              }}
                            >
                              {waybackLastRun.status === "ok"
                                ? tWayback("status_ok")
                                : waybackLastRun.status === "partial"
                                  ? tWayback("status_partial")
                                  : waybackLastRun.status === "cancelled"
                                    ? tWayback("status_cancelled")
                                    : tWayback("status_error")}
                            </span>
                            <strong style={{ color: "var(--text-1)" }}>
                              {tWayback("last_run")}
                            </strong>
                            {waybackLastRun.startedAt ? (
                              <span style={{ color: "var(--text-3)" }}>
                                ·{" "}
                                {fmtRelativeTime(
                                  tTime,
                                  tSettings,
                                  waybackLastRun.startedAt
                                )}
                              </span>
                            ) : null}
                          </div>
                          {waybackLastRun.totals ? (
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 12,
                              }}
                            >
                              <span>
                                <strong style={{ color: "var(--text-1)" }}>
                                  {waybackLastRun.totals.imported}
                                </strong>{" "}
                                {tWayback("stat_imported")}
                              </span>
                              {waybackLastRun.totals.unchanged > 0 ? (
                                <span>
                                  <strong style={{ color: "var(--text-1)" }}>
                                    {waybackLastRun.totals.unchanged}
                                  </strong>{" "}
                                  {tWayback("stat_no_op")}
                                </span>
                              ) : null}
                              {waybackLastRun.totals.skipped > 0 ? (
                                <span>
                                  <strong style={{ color: "var(--text-1)" }}>
                                    {waybackLastRun.totals.skipped}
                                  </strong>{" "}
                                  {tWayback("stat_skipped")}
                                </span>
                              ) : null}
                              <span
                                style={{
                                  color:
                                    waybackLastRun.totals.failed > 0
                                      ? "var(--danger, #b91c1c)"
                                      : undefined,
                                }}
                              >
                                <strong
                                  style={{
                                    color:
                                      waybackLastRun.totals.failed > 0
                                        ? "var(--danger, #b91c1c)"
                                        : "var(--text-1)",
                                  }}
                                >
                                  {waybackLastRun.totals.failed}
                                </strong>{" "}
                                {tWayback("stat_failed")}
                              </span>
                              <span style={{ color: "var(--text-3)" }}>
                                {tWayback("across_apps", {
                                  count: waybackLastRun.totals.appsAttempted,
                                })}
                              </span>
                            </div>
                          ) : waybackLastRun.summary ? (
                            <div>{waybackLastRun.summary}</div>
                          ) : null}
                        </div>
                      ) : waybackSummary ? (
                        <div>
                          {tWayback("summary_lead")} {waybackSummary}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
              {/* Data Export */}
              {settingsAdminExportOn && (
                <div className="settings-section" id="export">
                  <h2 className="settings-section-title">
                    {tSections("export_data")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("export_data")}
                  </p>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <a
                      className="btn btn-secondary"
                      download
                      href="/api/export?format=csv"
                    >
                      {tExportCard("csv")}
                    </a>
                    <a
                      className="btn btn-secondary"
                      download
                      href="/api/export?format=json"
                    >
                      {tExportCard("json")}
                    </a>
                  </div>
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--text-3)",
                      marginTop: 12,
                    }}
                  >
                    CSV includes one row per data type. JSON includes the full
                    nested structure.
                  </p>

                  {/* Round 3 PR 5: audit-bundle export. Gated by
            flag.settings.admin.export.audit_bundle (default off — on for
            audience.loved_one). The component does its own client-side
            flag probe via /api/feature-flags because the client useFlag
            cache returns hard defaults on fresh loads — see the comment
            on settingsAdminExportOn above. The server enforces the same
            gate authoritatively, so the UI gate is just for show. */}
                  <AuditBundleExport />
                  {/* Wave I — `flag.settings.admin.export.audit_pdf` placeholder.
            The flag is wired so users who flip it on see a "coming soon"
            affordance and the rendering path stays exercised. */}
                  {settingsAdminExportAuditPdfOn && (
                    <button
                      className="btn btn-secondary"
                      disabled
                      style={{ marginLeft: 8 }}
                      title="PDF audit-bundle export is not available yet."
                      type="button"
                    >
                      ⬇ Audit bundle (PDF) — coming soon
                    </button>
                  )}
                </div>
              )}

              {(settingsAdminResetOn || settingsAdminStartOverOn) && (
                <div
                  className="settings-section settings-section-danger"
                  id="reset"
                >
                  <h2 className="settings-section-title">
                    {tSections("reset_app")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("reset_app")}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    {settingsAdminResetOn && (
                      <button
                        className="btn btn-danger"
                        disabled={Boolean(status?.isRunning)}
                        onClick={() => setResetStep(1)}
                        type="button"
                      >
                        {tResetCard("reset_button")}
                      </button>
                    )}

                    {/* Round 3 PR 5: Start Over — same scope as Reset, but preserves
                the DB schema + migration version. Routes to /welcome on
                completion via the §4.10 hybrid-redirect. */}
                    {settingsAdminStartOverOn && (
                      <StartOverButton
                        backupBusy={exportingBackup}
                        backupBusyLabel={tBackupCard("download_busy")}
                        backupLabel={tBackupCard("download_before_destructive")}
                        disabled={Boolean(status?.isRunning)}
                        onDownloadBackup={handleExportBackup}
                      />
                    )}
                  </div>
                  {status?.isRunning && (
                    <p
                      style={{
                        fontSize: 12,
                        color: "var(--text-3)",
                        marginTop: 12,
                      }}
                    >
                      {tResetCard("wait_for_sync")}
                    </p>
                  )}
                </div>
              )}

              {/* Developer Options — only useful when debugging why an AI call is
          stuck or returning garbage. The toggle is saved alongside the rest
          of the AI settings; the log panel queries the server-side rolling
          window written by lib/privacy-policy.ts. */}
              {devOptsVisible && (
                <div className="settings-section" id="developer">
                  <h2 className="settings-section-title">
                    {tSections("developer_options")}
                  </h2>
                  <p className="settings-section-subtitle">
                    {tSub("developer_options")}
                  </p>

                  <TasksResetRow />

                  {/* Wave I: the whole AI debug-logging surface — toggle, load/clear
            buttons, and the rolling log list — is gated behind two flags:
            `flag.devopts.ai.debug_logging` (the dev-opts visibility) and
            `flag.settings.ai.debug_logging` (the per-Settings card flag).
            Both have to resolve on for the block to show; either off
            collapses it. */}
                  {devAiDebugLoggingOn && settingsAiDebugLoggingOn && (
                    <>
                      <label className="settings-checkbox-row">
                        <input
                          checked={debugLogging}
                          className="settings-checkbox"
                          onChange={(event) => {
                            const next = event.target.checked;
                            setDebugLogging(next);
                            saveAiSettings({ debugLogging: next });
                          }}
                          type="checkbox"
                        />
                        <span>
                          {tDevAiDebug("label")}
                          <span
                            className="settings-field-help"
                            style={{ display: "block", marginTop: 4 }}
                          >
                            {tDevAiDebug("help")}
                          </span>
                        </span>
                      </label>

                      <div
                        style={{
                          display: "flex",
                          gap: 10,
                          flexWrap: "wrap",
                          marginTop: 16,
                        }}
                      >
                        <button
                          className="btn btn-secondary"
                          disabled={debugLoading}
                          onClick={() => void loadDebugLog()}
                          type="button"
                        >
                          {debugLoading ? (
                            <>
                              <span className="spinner-sm" />{" "}
                              {tDevAiDebug("loading")}
                            </>
                          ) : debugLog === null ? (
                            tDevAiDebug("load")
                          ) : (
                            tDevAiDebug("refresh")
                          )}
                        </button>
                        {debugLog !== null && debugLog.length > 0 && (
                          <button
                            className="btn btn-secondary"
                            disabled={debugLoading}
                            onClick={() => void clearDebugLog()}
                            type="button"
                          >
                            {tDevAiDebug("clear")}
                          </button>
                        )}
                      </div>

                      {debugLog !== null && (
                        <div style={{ marginTop: 16 }}>
                          {debugLog.length === 0 ? (
                            <div
                              style={{
                                fontSize: 13,
                                color: "var(--text-3)",
                                padding: "12px 2px",
                              }}
                            >
                              {debugLogging
                                ? tDevAiDebug("empty_active")
                                : tDevAiDebug("empty_off")}
                            </div>
                          ) : (
                            <ul
                              style={{
                                listStyle: "none",
                                margin: 0,
                                padding: 0,
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                              }}
                            >
                              {debugLog.map((row) => {
                                const isExpanded = debugExpandedId === row.id;
                                const label = row.appName
                                  ? `${row.appName} · ${row.phase ?? tDevAiDebug("unknown_phase")}`
                                  : (row.phase ??
                                    tDevAiDebug("fallback_label"));
                                const providerLabel = row.provider
                                  ? `${row.provider}${row.model ? ` / ${row.model}` : ""}`
                                  : "";
                                return (
                                  <li
                                    key={row.id}
                                    style={{
                                      border: "1px solid var(--border)",
                                      borderRadius: 8,
                                      padding: 12,
                                      background: row.error
                                        ? "rgba(255, 80, 80, 0.04)"
                                        : "var(--surface-2)",
                                    }}
                                  >
                                    <button
                                      aria-expanded={isExpanded}
                                      onClick={() =>
                                        setDebugExpandedId((prev) =>
                                          prev === row.id ? null : row.id
                                        )
                                      }
                                      style={{
                                        all: "unset",
                                        cursor: "pointer",
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 4,
                                        width: "100%",
                                      }}
                                      type="button"
                                    >
                                      <div
                                        style={{
                                          display: "flex",
                                          gap: 10,
                                          alignItems: "center",
                                          flexWrap: "wrap",
                                        }}
                                      >
                                        <span
                                          style={{
                                            fontWeight: 600,
                                            fontSize: 13,
                                          }}
                                        >
                                          {row.error ? "⚠ " : "✓ "}
                                          {label}
                                        </span>
                                        {providerLabel && (
                                          <span
                                            style={{
                                              fontSize: 12,
                                              color: "var(--text-3)",
                                            }}
                                          >
                                            · {providerLabel}
                                          </span>
                                        )}
                                        <span
                                          style={{
                                            marginLeft: "auto",
                                            fontSize: 12,
                                            color: "var(--text-3)",
                                          }}
                                        >
                                          {fmtDate(tSettings, row.createdAt)}
                                          {typeof row.durationMs === "number" &&
                                            tDevAiDebug("duration_suffix", {
                                              ms: row.durationMs,
                                            })}
                                        </span>
                                      </div>
                                      {row.error && !isExpanded && (
                                        <div
                                          style={{
                                            fontSize: 12,
                                            color: "var(--red, #c03)",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                          }}
                                        >
                                          {row.error}
                                        </div>
                                      )}
                                    </button>

                                    {isExpanded && (
                                      <div
                                        style={{
                                          marginTop: 12,
                                          display: "flex",
                                          flexDirection: "column",
                                          gap: 10,
                                        }}
                                      >
                                        {row.error && (
                                          <div
                                            style={{
                                              fontSize: 12,
                                              color: "var(--red, #c03)",
                                              background:
                                                "rgba(255, 80, 80, 0.08)",
                                              padding: "8px 10px",
                                              borderRadius: 6,
                                              whiteSpace: "pre-wrap",
                                              wordBreak: "break-word",
                                            }}
                                          >
                                            {row.error}
                                          </div>
                                        )}
                                        <div>
                                          <div
                                            style={{
                                              fontSize: 12,
                                              color: "var(--text-3)",
                                              marginBottom: 4,
                                            }}
                                          >
                                            {tDevAiDebug("prompt_heading")}
                                          </div>
                                          <pre
                                            style={{
                                              margin: 0,
                                              padding: 10,
                                              background: "var(--surface-1)",
                                              border: "1px solid var(--border)",
                                              borderRadius: 6,
                                              fontSize: 12,
                                              lineHeight: 1.45,
                                              maxHeight: 320,
                                              overflow: "auto",
                                              whiteSpace: "pre-wrap",
                                              wordBreak: "break-word",
                                            }}
                                          >
                                            {row.prompt ||
                                              tDevAiDebug("empty_value")}
                                          </pre>
                                        </div>
                                        <div>
                                          <div
                                            style={{
                                              fontSize: 12,
                                              color: "var(--text-3)",
                                              marginBottom: 4,
                                            }}
                                          >
                                            {tDevAiDebug("response_heading")}
                                          </div>
                                          <pre
                                            style={{
                                              margin: 0,
                                              padding: 10,
                                              background: "var(--surface-1)",
                                              border: "1px solid var(--border)",
                                              borderRadius: 6,
                                              fontSize: 12,
                                              lineHeight: 1.45,
                                              maxHeight: 320,
                                              overflow: "auto",
                                              whiteSpace: "pre-wrap",
                                              wordBreak: "break-word",
                                            }}
                                          >
                                            {row.response ||
                                              tDevAiDebug("empty_value")}
                                          </pre>
                                        </div>
                                      </div>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {/* Activity log — always-on operational timeline of scrapes, re-syncs,
            policy summaries, and scheduled runs. Distinct from the AI debug
            log above (which is opt-in and captures full prompt/response
            payloads); this one is a user-friendly audit of boundary events so
            a user can spot bugs or confirm their apps are being refreshed. */}
                  {devActivityLogRetentionDaysOn && (
                    <div
                      className="settings-field"
                      style={{
                        marginBottom: 8,
                        padding: "6px 0",
                        fontSize: 12,
                        color: "var(--text-3)",
                      }}
                    >
                      <strong>{tDevActivity("retention_lead")}</strong>
                      {tDevActivity("retention_body")}
                    </div>
                  )}
                  {devActivityLogOn && (
                    <details
                      className="settings-advanced-details"
                      id="activity-log"
                      onToggle={(event) => {
                        const isOpen = (event.target as HTMLDetailsElement)
                          .open;
                        setActivityOpen(isOpen);
                        if (isOpen && activityLog === null) {
                          void loadActivityLog(false);
                        }
                      }}
                      open={activityOpen}
                      style={{
                        marginTop: 24,
                        borderTop: "1px solid var(--border)",
                        paddingTop: 16,
                      }}
                    >
                      <summary
                        style={{
                          cursor: "pointer",
                          fontSize: 14,
                          fontWeight: 600,
                          userSelect: "none",
                        }}
                      >
                        {tDevActivity("summary")}
                      </summary>
                      <p
                        className="settings-field-help"
                        style={{ marginTop: 12, marginBottom: 12 }}
                      >
                        {tDevActivity("help")}
                      </p>

                      <div className="activity-log-toolbar">
                        <label className="activity-log-filter">
                          <span>{tDevActivity("filter_activity")}</span>
                          <select
                            className="settings-input"
                            onChange={(event) =>
                              setActivityTypeFilter(event.target.value)
                            }
                            value={activityTypeFilter}
                          >
                            <option value="">
                              {tDevActivity("all_activity")}
                            </option>
                            <option value="scrape">
                              {tDevActivityTypes("scrape")}
                            </option>
                            <option value="resync">
                              {tDevActivityTypes("resync")}
                            </option>
                            <option value="policy_summary">
                              {tDevActivityTypes("policy_summary")}
                            </option>
                            <option value="scheduled_sync">
                              {tDevActivityTypes("scheduled_sync")}
                            </option>
                            <option value="manual_sync">
                              {tDevActivityTypes("manual_sync")}
                            </option>
                            <option value="import">
                              {tDevActivityTypes("import")}
                            </option>
                            <option value="backup_export">
                              {tDevActivityTypes("backup_export")}
                            </option>
                            <option value="backup_restore">
                              {tDevActivityTypes("backup_restore")}
                            </option>
                            <option value="reset">
                              {tDevActivityTypes("reset")}
                            </option>
                          </select>
                        </label>
                        <label className="activity-log-filter">
                          <span>{tDevActivity("filter_status")}</span>
                          <select
                            className="settings-input"
                            onChange={(event) =>
                              setActivityStatusFilter(event.target.value)
                            }
                            value={activityStatusFilter}
                          >
                            <option value="">
                              {tDevActivity("all_statuses")}
                            </option>
                            <option value="ok">
                              {tDevActivity("status_ok")}
                            </option>
                            <option value="error">
                              {tDevActivity("status_error")}
                            </option>
                            <option value="partial">
                              {tDevActivity("status_partial")}
                            </option>
                            <option value="cancelled">
                              {tDevActivity("status_cancelled")}
                            </option>
                          </select>
                        </label>
                        <label className="activity-log-filter">
                          <span>{tDevActivity("filter_since")}</span>
                          <select
                            className="settings-input"
                            onChange={(event) =>
                              setActivityTimeWindow(event.target.value)
                            }
                            value={activityTimeWindow}
                          >
                            <option value="">{tDevActivity("any_time")}</option>
                            <option value="5m">
                              {tDevActivity("last_5m")}
                            </option>
                            <option value="15m">
                              {tDevActivity("last_15m")}
                            </option>
                            <option value="1h">
                              {tDevActivity("last_1h")}
                            </option>
                            <option value="6h">
                              {tDevActivity("last_6h")}
                            </option>
                            <option value="24h">
                              {tDevActivity("last_24h")}
                            </option>
                            <option value="7d">
                              {tDevActivity("last_7d")}
                            </option>
                          </select>
                        </label>
                        <label className="activity-log-filter">
                          <span>{tDevActivity("filter_sort")}</span>
                          <select
                            className="settings-input"
                            onChange={(event) => {
                              const [field, dir] = event.target.value.split(
                                ":"
                              ) as [
                                "started_at" | "ended_at" | "duration_ms",
                                "asc" | "desc",
                              ];
                              setActivitySortBy(field);
                              setActivitySortDir(dir);
                            }}
                            value={`${activitySortBy}:${activitySortDir}`}
                          >
                            <option value="started_at:desc">
                              {tDevActivity("sort_started_desc")}
                            </option>
                            <option value="started_at:asc">
                              {tDevActivity("sort_started_asc")}
                            </option>
                            <option value="ended_at:desc">
                              {tDevActivity("sort_ended_desc")}
                            </option>
                            <option value="ended_at:asc">
                              {tDevActivity("sort_ended_asc")}
                            </option>
                            <option value="duration_ms:desc">
                              {tDevActivity("sort_duration_desc")}
                            </option>
                            <option value="duration_ms:asc">
                              {tDevActivity("sort_duration_asc")}
                            </option>
                          </select>
                        </label>
                        <button
                          className="btn btn-secondary"
                          disabled={activityLoading}
                          onClick={() => void loadActivityLog(false)}
                          type="button"
                        >
                          {activityLoading && activityLog === null ? (
                            <>
                              <span className="spinner-sm" />{" "}
                              {tDevActivity("loading")}
                            </>
                          ) : activityLog === null ? (
                            tDevActivity("load")
                          ) : (
                            tDevActivity("refresh")
                          )}
                        </button>
                        {/* Live-polling indicator. Only meaningful once the log has been
                loaded at least once — before that the toolbar just shows the
                "Load activity" button. Clicking toggles the pause state; the
                dot pulses while live and goes grey when paused. */}
                        {activityLog !== null && (
                          <button
                            aria-pressed={!activityLivePaused}
                            className={
                              // Brief flash when a new row was just prepended — purely
                              // cosmetic, auto-cleared ~1.2s later by the flashing effect.
                              `activity-log-live-toggle${activityLivePaused ? "is-paused" : ""}${
                                !activityLivePaused && activityFlashing
                                  ? "just-pulsed"
                                  : ""
                              }`
                            }
                            onClick={() =>
                              setActivityLivePaused((prev) => !prev)
                            }
                            title={
                              activityLivePaused
                                ? tDevActivity("live_title_paused")
                                : tDevActivity("live_title_active")
                            }
                            type="button"
                          >
                            <span
                              aria-hidden
                              className="activity-log-live-dot"
                            />
                            {activityLivePaused
                              ? tDevActivity("paused")
                              : tDevActivity("live")}
                          </button>
                        )}
                      </div>

                      {activityLog !== null && (
                        <div style={{ marginTop: 12 }}>
                          {activityLog.length === 0 ? (
                            <div className="activity-log-empty">
                              {(() => {
                                const parts: string[] = [];
                                if (activityStatusFilter) {
                                  parts.push(`${activityStatusFilter}`);
                                }
                                if (activityTypeFilter) {
                                  parts.push(
                                    activityTypeFilter.replace(/_/g, " ")
                                  );
                                }
                                if (parts.length > 0) {
                                  return tDevActivity("empty_filter", {
                                    filter: parts.join(" "),
                                  });
                                }
                                return tDevActivity("empty_default");
                              })()}
                            </div>
                          ) : (
                            <>
                              <ul className="activity-log-list">
                                {activityLog.map((row) => {
                                  const isExpanded =
                                    activityExpandedId === row.id;
                                  const typeLabel = ACTIVITY_TYPE_LABELS[
                                    row.type
                                  ]
                                    ? tDevActivityTypes(
                                        row.type as Parameters<
                                          typeof tDevActivityTypes
                                        >[0]
                                      )
                                    : row.type;
                                  const typeIcon =
                                    ACTIVITY_TYPE_ICONS[row.type] ?? "·";
                                  const statusClass = `activity-status-pill activity-status-${row.status}`;
                                  return (
                                    <li
                                      className={`activity-log-row activity-status-row-${row.status}`}
                                      key={row.id}
                                    >
                                      <button
                                        aria-expanded={isExpanded}
                                        className="activity-log-header"
                                        onClick={() =>
                                          setActivityExpandedId((prev) =>
                                            prev === row.id ? null : row.id
                                          )
                                        }
                                        type="button"
                                      >
                                        <span
                                          aria-hidden
                                          className="activity-log-icon"
                                        >
                                          {typeIcon}
                                        </span>
                                        <span className="activity-log-title">
                                          <span className="activity-log-type">
                                            {typeLabel}
                                          </span>
                                          {row.appName && (
                                            <span className="activity-log-appname">
                                              {" "}
                                              · {row.appName}
                                            </span>
                                          )}
                                        </span>
                                        <span className={statusClass}>
                                          {row.status}
                                        </span>
                                        <span className="activity-log-meta">
                                          {fmtRelativeTime(
                                            tTime,
                                            tSettings,
                                            row.startedAt
                                          )}
                                          {typeof row.durationMs === "number" &&
                                            row.durationMs > 0 && (
                                              <>
                                                {" "}
                                                · {fmtDuration(row.durationMs)}
                                              </>
                                            )}
                                        </span>
                                      </button>
                                      {row.summary && (
                                        <div className="activity-log-summary">
                                          {row.summary}
                                        </div>
                                      )}
                                      {isExpanded && row.detail && (
                                        <ActivityRowDetail row={row} />
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                              <div className="activity-log-footer">
                                <span className="activity-log-count">
                                  {tDevActivity("showing", {
                                    current: activityLog.length,
                                    total: activityTotal,
                                  })}
                                </span>
                                {activityHasMore && (
                                  <button
                                    className="btn btn-secondary"
                                    disabled={activityLoading}
                                    onClick={() => void loadActivityLog(true)}
                                    type="button"
                                  >
                                    {activityLoading ? (
                                      <>
                                        <span className="spinner-sm" />{" "}
                                        {tDevActivity("loading")}
                                      </>
                                    ) : (
                                      tDevActivity("load_more")
                                    )}
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </details>
                  )}

                  {/* Advanced — per-phase AI request timeouts. Collapsed by default
            because the defaults work for hosted providers and most local
            setups; only becomes interesting once a user hits a timeout
            (the bell notification routes them straight here via
            #ai-timeouts, and the accordion auto-opens on that hash).
            Wave I — gated behind `flag.devopts.advanced_accordion`; the
            'collapsed' default surfaces the accordion but keeps it shut
            on first paint so users without focus tweaks don't see it
            sprawling open. */}
                  {devAdvancedAccordionOn && settingsAiTimeoutConfigOn && (
                    <details
                      className="settings-advanced-details"
                      id="ai-timeouts"
                      onToggle={(event) =>
                        setAdvancedAiOpen(
                          (event.target as HTMLDetailsElement).open
                        )
                      }
                      open={devAdvancedAccordionFlag === "on" || advancedAiOpen}
                      style={{
                        marginTop: 24,
                        borderTop: "1px solid var(--border)",
                        paddingTop: 16,
                      }}
                    >
                      <summary
                        style={{
                          cursor: "pointer",
                          fontSize: 14,
                          fontWeight: 600,
                          userSelect: "none",
                        }}
                      >
                        {tDevAiTimeouts("summary")}
                      </summary>
                      <p
                        className="settings-field-help"
                        style={{ marginTop: 12, marginBottom: 12 }}
                      >
                        {tDevAiTimeouts("help")}
                      </p>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 12,
                        }}
                      >
                        <label
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          <span style={{ fontSize: 13, fontWeight: 500 }}>
                            {tDevAiTimeouts("direct_label")}
                          </span>
                          <input
                            className="settings-input"
                            disabled={
                              aiProvider === "disabled" ||
                              aiTimeoutDirectAutoSave.saving
                            }
                            max={15 * 60_000}
                            min={10_000}
                            // Auto-save on blur — empty allowed (= server default),
                            // otherwise must be 10000–900000 ms (validateAiTimeout).
                            onBlur={makeAiTimeoutBlurHandler(
                              aiTimeoutDirectMs,
                              aiTimeoutDirectAutoSave.save
                            )}
                            onChange={(event) =>
                              setAiTimeoutDirectMs(event.target.value)
                            }
                            placeholder={tPh("default")}
                            step={1000}
                            type="number"
                            value={aiTimeoutDirectMs}
                          />
                          <span className="settings-field-help">
                            {tDevAiTimeouts("direct_help")}
                          </span>
                        </label>

                        <label
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          <span style={{ fontSize: 13, fontWeight: 500 }}>
                            {tDevAiTimeouts("chunk_label")}
                          </span>
                          <input
                            className="settings-input"
                            disabled={
                              aiProvider === "disabled" ||
                              aiTimeoutChunkAutoSave.saving
                            }
                            max={15 * 60_000}
                            min={10_000}
                            onBlur={makeAiTimeoutBlurHandler(
                              aiTimeoutChunkMs,
                              aiTimeoutChunkAutoSave.save
                            )}
                            onChange={(event) =>
                              setAiTimeoutChunkMs(event.target.value)
                            }
                            placeholder={tPh("default")}
                            step={1000}
                            type="number"
                            value={aiTimeoutChunkMs}
                          />
                          <span className="settings-field-help">
                            {tDevAiTimeouts("chunk_help")}
                          </span>
                        </label>

                        <label
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          <span style={{ fontSize: 13, fontWeight: 500 }}>
                            {tDevAiTimeouts("merge_label")}
                          </span>
                          <input
                            className="settings-input"
                            disabled={
                              aiProvider === "disabled" ||
                              aiTimeoutMergeAutoSave.saving
                            }
                            max={15 * 60_000}
                            min={10_000}
                            onBlur={makeAiTimeoutBlurHandler(
                              aiTimeoutMergeMs,
                              aiTimeoutMergeAutoSave.save
                            )}
                            onChange={(event) =>
                              setAiTimeoutMergeMs(event.target.value)
                            }
                            placeholder={tPh("default")}
                            step={1000}
                            type="number"
                            value={aiTimeoutMergeMs}
                          />
                          <span className="settings-field-help">
                            {tDevAiTimeouts("merge_help")}
                          </span>
                        </label>
                      </div>

                      <p
                        className="settings-field-help"
                        style={{ marginTop: 12 }}
                      >
                        {tDevAiTimeouts.rich("footer", {
                          save: (chunks) => <strong>{chunks}</strong>,
                        })}
                      </p>
                    </details>
                  )}

                  {/* Round 3 PR 5: feature-flag panel inside the existing Developer
            Options section. Pulls flag list + override state from
            /api/feature-flags on mount; toggle/reset hit the override
            endpoints. Sits below the AI debug log so users who only need
            debug logging aren't scrolled past it. */}
                  <div
                    style={{
                      marginTop: 32,
                      paddingTop: 24,
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    {devFeatureFlagPresetsOn && (
                      <div
                        className="settings-field"
                        style={{
                          marginBottom: 12,
                          padding: "8px 12px",
                          background: "rgba(59, 130, 246, 0.06)",
                          border: "1px dashed rgba(59, 130, 246, 0.35)",
                          borderRadius: 8,
                          fontSize: 12,
                          color: "var(--text-2)",
                        }}
                      >
                        <strong>{tDevPresets("lead")}</strong>
                        {tDevPresets("body")}
                      </div>
                    )}
                    {/* Authoring tool: write-down-the-spec matrix for which
              flags should resolve to what under each (audience × goals)
              combo. Sits above the live-overrides panel because it's
              a planning surface — authors typically iterate the spec
              first, then promote a column into live overrides via the
              matrix's "Apply combo" buttons or paste the generated TS
              patch into lib/feature-flag-rules.ts. */}
                    <div
                      className="settings-field"
                      style={{
                        marginBottom: 16,
                        padding: "10px 12px",
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        display: "flex",
                        gap: 12,
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ flex: "1 1 240px", minWidth: 240 }}>
                        <strong style={{ fontSize: 13 }}>
                          Focus × Flags matrix
                        </strong>
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--text-3)",
                            marginTop: 2,
                          }}
                        >
                          Author the desired flag value for every (audience ×
                          goals) combo. Saves a draft locally; export as JSON or
                          a TS patch when you&rsquo;re ready.
                        </div>
                      </div>
                      <Link
                        className="btn btn-secondary"
                        href="/dashboard/settings/focus-matrix"
                        style={{ fontSize: 13 }}
                      >
                        Open matrix →
                      </Link>
                    </div>
                    <DevOptionsFeatureFlagPanel />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}

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
              aria-labelledby="restore-backup-title"
              aria-modal="true"
              className="modal-card"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="modal-badge">{tModalRestore("badge")}</div>
              <h2 className="modal-title" id="restore-backup-title">
                {tModalRestore("title")}
              </h2>
              <p className="modal-copy">
                {pendingRestoreFilename ? (
                  <>
                    <strong>{pendingRestoreFilename}</strong>
                    {restorePreview.exportedAt
                      ? tModalRestore("exported_suffix", {
                          date: fmtShortDate(
                            restorePreview.exportedAt,
                            dateMode
                          ),
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
                aria-label={tAria("rows_per_table")}
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
                <strong>{tModalRestore("warning_lead")}</strong>
                {tModalRestore("warning_body")}
              </div>

              <div className="destructive-backup-offer">
                <div className="destructive-backup-copy">
                  {tBackupCard("download_current_before_restore")}
                </div>
                <button
                  className="btn btn-secondary"
                  disabled={exportingBackup || restoreStage === "applying"}
                  onClick={handleExportBackup}
                  type="button"
                >
                  {exportingBackup
                    ? tBackupCard("download_busy")
                    : tBackupCard("download_before_destructive")}
                </button>
              </div>

              <label
                className="modal-confirm-label"
                htmlFor="restore-confirm-input"
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
                id="restore-confirm-input"
                onChange={(event) => {
                  setRestoreConfirmText(event.target.value);
                  if (restoreError) {
                    setRestoreError("");
                  }
                }}
                placeholder={tPh("restore_confirm")}
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

      {deleteTarget && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!deleting) {
              setDeleteTarget(null);
            }
          }}
        >
          <div
            aria-labelledby="delete-import-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-badge">{tModalDelete("badge")}</div>
            <h2 className="modal-title" id="delete-import-title">
              {tModalDelete("title")}
            </h2>
            <p className="modal-copy">
              {tModalDelete("meta", {
                date: fmtShortDate(deleteTarget.importRow.createdAt, dateMode),
                total: deleteTarget.importRow.total,
                imported: deleteTarget.importRow.imported,
              })}
            </p>

            <div className="delete-import-options">
              <label
                className={`delete-import-option${deleteTarget.mode === "history-only" ? "is-active" : ""}`}
              >
                <input
                  checked={deleteTarget.mode === "history-only"}
                  disabled={deleting}
                  name="delete-import-mode"
                  onChange={() =>
                    setDeleteTarget({ ...deleteTarget, mode: "history-only" })
                  }
                  type="radio"
                  value="history-only"
                />
                <div>
                  <div className="delete-import-option-label">
                    {tModalDelete("option_history_only_label")}
                  </div>
                  <div className="delete-import-option-desc">
                    {tModalDelete("option_history_only_desc")}
                  </div>
                </div>
              </label>

              <label
                className={`delete-import-option${deleteTarget.mode === "with-apps" ? "is-active" : ""}`}
              >
                <input
                  checked={deleteTarget.mode === "with-apps"}
                  disabled={deleting}
                  name="delete-import-mode"
                  onChange={() =>
                    setDeleteTarget({ ...deleteTarget, mode: "with-apps" })
                  }
                  type="radio"
                  value="with-apps"
                />
                <div>
                  <div className="delete-import-option-label">
                    {tModalDelete("option_with_apps_label")}
                  </div>
                  <div className="delete-import-option-desc">
                    {tModalDelete("option_with_apps_desc", {
                      count: deleteTarget.importRow.imported,
                    })}
                  </div>
                </div>
              </label>
            </div>

            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                type="button"
              >
                {tModalDelete("cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={deleting}
                onClick={() => void confirmDeleteImport()}
                type="button"
              >
                {deleting ? (
                  <>
                    <span className="spinner-sm" /> {tModalDelete("deleting")}
                  </>
                ) : deleteTarget.mode === "with-apps" ? (
                  tModalDelete("confirm_with_apps")
                ) : (
                  tModalDelete("confirm_history")
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {waybackRemoveOpen && (
        <div className="modal-overlay" onClick={closeWaybackRemoveModal}>
          <div
            aria-describedby="wayback-remove-copy"
            aria-labelledby="wayback-remove-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                closeWaybackRemoveModal();
              }
            }}
            role="dialog"
          >
            <div className="modal-badge">{tWaybackRemove("badge")}</div>
            <h2 className="modal-title" id="wayback-remove-title">
              {tWaybackRemove("title")}
            </h2>
            <p className="modal-copy" id="wayback-remove-copy">
              {tWaybackRemove("body")}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={waybackRemoving}
                onClick={closeWaybackRemoveModal}
                type="button"
              >
                {tWaybackRemove("cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={waybackRemoving}
                onClick={() => void removeAllWaybackHistory()}
                type="button"
              >
                {waybackRemoving ? (
                  <>
                    <span className="spinner-sm" /> {tWaybackRemove("removing")}
                  </>
                ) : (
                  tWaybackRemove("confirm")
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        Confirm modal for the inline "Remove from Apps" button on an
        import-history row. Replaces the previous `window.confirm` so
        the destructive UX matches the wayback-remove + reset-app
        dialogs above.
      */}
      {pendingItemRemoval &&
        (() => {
          const { item } = pendingItemRemoval;
          const label = item.appName || item.editedQuery || item.query;
          const closing = removingItemId !== null;
          return (
            <div
              className="modal-overlay"
              onClick={() => {
                if (!closing) {
                  setPendingItemRemoval(null);
                }
              }}
            >
              <div
                aria-describedby="remove-item-copy"
                aria-labelledby="remove-item-title"
                aria-modal="true"
                className="modal-card"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !closing) {
                    setPendingItemRemoval(null);
                  }
                }}
                role="dialog"
              >
                <div className="modal-badge">{tModalRemoveApp("badge")}</div>
                <h2 className="modal-title" id="remove-item-title">
                  {tModalRemoveApp("title", { name: label })}
                </h2>
                <p className="modal-copy" id="remove-item-copy">
                  {tModalRemoveApp("body")}
                </p>
                <div className="modal-actions">
                  <button
                    className="btn btn-secondary"
                    disabled={closing}
                    onClick={() => setPendingItemRemoval(null)}
                    type="button"
                  >
                    {tModalRemoveApp("cancel")}
                  </button>
                  <button
                    autoFocus
                    className="btn btn-danger"
                    disabled={closing}
                    onClick={() => void confirmRemoveItemFromDashboard()}
                    type="button"
                  >
                    {closing ? (
                      <>
                        <span aria-hidden="true" className="spinner-sm" />{" "}
                        {tModalRemoveApp("removing")}
                      </>
                    ) : (
                      tModalRemoveApp("confirm")
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {resetStep > 0 && (
        <div className="modal-overlay" onClick={closeResetModal}>
          <div
            aria-describedby="reset-app-copy"
            aria-labelledby="reset-app-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                closeResetModal();
              }
            }}
            role="dialog"
          >
            <div className="modal-badge">{tResetCard("modal_badge")}</div>
            <h2 className="modal-title" id="reset-app-title">
              {resetStep === 1
                ? tResetCard("modal_title_step_1")
                : tResetCard("modal_title_step_2")}
            </h2>
            <p className="modal-copy" id="reset-app-copy">
              {resetStep === 1
                ? tResetCard("modal_body_step_1")
                : tResetCard("modal_body_step_2")}
            </p>
            {resetStep === 2 && (
              <div className="destructive-backup-offer">
                <div className="destructive-backup-copy">
                  {tBackupCard("download_before_reset")}
                </div>
                <button
                  className="btn btn-secondary"
                  disabled={exportingBackup || resetting}
                  onClick={handleExportBackup}
                  type="button"
                >
                  {exportingBackup
                    ? tBackupCard("download_busy")
                    : tBackupCard("download_before_destructive")}
                </button>
              </div>
            )}
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={resetting}
                onClick={closeResetModal}
                type="button"
              >
                {tResetCard("cancel")}
              </button>

              {resetStep === 1 ? (
                <button
                  className="btn btn-danger"
                  onClick={() => setResetStep(2)}
                  type="button"
                >
                  {tResetCard("continue")}
                </button>
              ) : (
                <button
                  className="btn btn-danger"
                  disabled={resetting}
                  onClick={() => void resetAllData()}
                  type="button"
                >
                  {resetting ? (
                    <>
                      <span className="spinner-sm" /> {tResetCard("resetting")}
                    </>
                  ) : (
                    tResetCard("delete_and_restart")
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the expanded detail panel for one activity-log row.
 *
 * For rows with `status === 'error'` and a `detail.fetchDiagnostics` block
 * (populated by lib/privacy-policy.ts → PolicyFetchError, or lib/scraper.ts'
 * HTTP-aware catch block), we render a structured troubleshoot panel —
 * HTTP status, requested/final URL, origin, content-type, and any
 * remediation hints. Every other row falls back to the pre-existing
 * raw JSON dump so we don't regress the debug visibility the dev log
 * always had.
 */
function ActivityRowDetail({ row }: { row: ActivityLogRow }) {
  const detail = row.detail;
  if (!detail) {
    return null;
  }

  const fetchDiag = (detail as Record<string, unknown>).fetchDiagnostics as
    | Record<string, unknown>
    | undefined;
  const errorMessage =
    typeof (detail as Record<string, unknown>).errorMessage === "string"
      ? ((detail as Record<string, unknown>).errorMessage as string)
      : null;

  // Scalar info rows rendered as a small definition list. Kept as a plain
  // array so we can filter out absent fields in one pass rather than
  // wrapping each in its own conditional JSX block.
  const diagnosticLines: Array<{ label: string; value: string }> = [];
  if (fetchDiag) {
    if (typeof fetchDiag.httpStatus === "number") {
      diagnosticLines.push({
        label: "HTTP status",
        value: String(fetchDiag.httpStatus),
      });
    }
    if (typeof fetchDiag.origin === "string") {
      const ORIGIN_LABELS: Record<string, string> = {
        direct: "Direct fetch (Safari UA)",
        browser_retry: "Browser retry (Chrome headers)",
        wayback: "Wayback Machine fallback",
        normalize: "Locale-normalised URL",
      };
      diagnosticLines.push({
        label: "Which attempt failed",
        value:
          ORIGIN_LABELS[fetchDiag.origin as string] ?? String(fetchDiag.origin),
      });
    }
    if (typeof fetchDiag.contentType === "string" && fetchDiag.contentType) {
      diagnosticLines.push({
        label: "Content-Type",
        value: fetchDiag.contentType as string,
      });
    }
    if (typeof fetchDiag.networkHint === "string" && fetchDiag.networkHint) {
      const NETWORK_HINT_LABELS: Record<string, string> = {
        timeout: "Timeout (no response in time)",
        dns: "DNS lookup failure",
        connection_reset: "Connection reset mid-request",
        network: "Generic network failure",
      };
      diagnosticLines.push({
        label: "Network",
        value:
          NETWORK_HINT_LABELS[fetchDiag.networkHint as string] ??
          String(fetchDiag.networkHint),
      });
    }
  }

  const requestedUrl =
    fetchDiag && typeof fetchDiag.requestedUrl === "string"
      ? (fetchDiag.requestedUrl as string)
      : typeof (detail as Record<string, unknown>).url === "string"
        ? ((detail as Record<string, unknown>).url as string)
        : null;
  const finalUrl =
    fetchDiag && typeof fetchDiag.finalUrl === "string"
      ? (fetchDiag.finalUrl as string)
      : null;
  const troubleshoot =
    fetchDiag && Array.isArray(fetchDiag.troubleshoot)
      ? ((fetchDiag.troubleshoot as unknown[]).filter(
          (x) => typeof x === "string"
        ) as string[])
      : [];

  const showTroubleshoot =
    row.status === "error" &&
    (fetchDiag || errorMessage) &&
    (diagnosticLines.length > 0 ||
      troubleshoot.length > 0 ||
      requestedUrl ||
      errorMessage);

  return (
    <div className="activity-log-detail-wrap">
      {showTroubleshoot && (
        <div className="activity-log-troubleshoot">
          <div className="activity-log-troubleshoot-title">Troubleshoot</div>
          {errorMessage && (
            <div className="activity-log-troubleshoot-message">
              {errorMessage}
            </div>
          )}
          {diagnosticLines.length > 0 && (
            <dl className="activity-log-troubleshoot-facts">
              {diagnosticLines.map((line) => (
                <div
                  className="activity-log-troubleshoot-fact"
                  key={line.label}
                >
                  <dt>{line.label}</dt>
                  <dd>{line.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {(requestedUrl || finalUrl) && (
            <dl className="activity-log-troubleshoot-facts">
              {requestedUrl && (
                <div className="activity-log-troubleshoot-fact">
                  <dt>Requested URL</dt>
                  <dd>
                    <a
                      href={requestedUrl}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {requestedUrl}
                    </a>
                  </dd>
                </div>
              )}
              {finalUrl && finalUrl !== requestedUrl && (
                <div className="activity-log-troubleshoot-fact">
                  <dt>Final URL</dt>
                  <dd>
                    <a
                      href={finalUrl}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {finalUrl}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          )}
          {troubleshoot.length > 0 && (
            <>
              <div className="activity-log-troubleshoot-subtitle">Try</div>
              <ul className="activity-log-troubleshoot-hints">
                {troubleshoot.map((hint, index) => (
                  <li key={index}>{hint}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <details className="activity-log-detail-raw">
        <summary>Raw JSON</summary>
        <pre className="activity-log-detail">
          {JSON.stringify(detail, null, 2)}
        </pre>
      </details>
    </div>
  );
}

// AuditBundleExport extracted to ./AuditBundleExport.tsx — the inline
// helper that used to live here is now imported at the top of the file.

// ── Start Over button ─────────────────────────────────────────────────────
//
// Round 3 PR 5: lives in the Reset section's button row. Differs from
// "Reset all data" by preserving the DB schema + migration version — same
// scope of data wipe, but the next page load can render onboarding cleanly
// without re-running migrations on a freshly-blank DB. Calls
// /api/admin/start-over and routes to /welcome on success.

function StartOverButton({
  disabled,
  onDownloadBackup,
  backupBusy,
  backupLabel,
  backupBusyLabel,
}: {
  disabled: boolean;
  onDownloadBackup: () => void | Promise<void>;
  backupBusy: boolean;
  backupLabel: string;
  backupBusyLabel: string;
}) {
  const router = useRouter();
  // i18n — namespace lives next to the Reset App card so the two
  // danger-zone components share the same vocabulary in both
  // locale bundles.
  const t = useTranslations("settings.start_over");
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStartOver() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/start-over", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      router.push("/welcome");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("default_error"));
      setSubmitting(false);
    }
  }

  if (step === 0) {
    return (
      <button
        className="btn btn-secondary"
        disabled={disabled}
        onClick={() => setStep(1)}
        type="button"
      >
        {t("trigger")}
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 13 }}>
        {step === 1 ? t("step_1_prompt") : t("step_2_prompt")}
      </span>
      {step === 2 && (
        <div className="destructive-backup-offer destructive-backup-offer-inline">
          <div className="destructive-backup-copy">{t("backup_hint")}</div>
          <button
            className="btn btn-secondary"
            disabled={backupBusy || submitting}
            onClick={() => void onDownloadBackup()}
            type="button"
          >
            {backupBusy ? backupBusyLabel : backupLabel}
          </button>
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        {step === 1 ? (
          <button
            className="btn btn-danger"
            disabled={submitting}
            onClick={() => setStep(2)}
            type="button"
          >
            {t("step_1_confirm")}
          </button>
        ) : (
          <button
            className="btn btn-danger"
            disabled={submitting}
            onClick={() => void handleStartOver()}
            type="button"
          >
            {submitting ? t("wiping") : t("step_2_confirm")}
          </button>
        )}
        <button
          className="btn btn-ghost"
          disabled={submitting}
          onClick={() => setStep(0)}
          type="button"
        >
          {t("cancel")}
        </button>
      </div>
      {error && (
        <span role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
          {error}
        </span>
      )}
    </div>
  );
}

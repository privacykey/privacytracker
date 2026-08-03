import type { AIProvider } from "@/lib/ai-config";
import type { PolicySummary } from "@/lib/policy-summary-meta";

/**
 * Types shared between SettingsView and the extracted section components.
 *
 * These live here rather than in SettingsView so a section can import them
 * without importing its own parent — that would be a cycle, and it would
 * also mean every extracted section drags the 11k-line module into its
 * bundle graph.
 *
 * Only put things here that genuinely cross the boundary. Section-local
 * types belong in the section's own file.
 */

/** Background-sync cadence, persisted in `app_settings`. */
export type Schedule = "manual" | "daily" | "weekly";

/** Shape returned by `GET /api/sync/status`. Fetched once by
 *  SettingsView's `loadStatus()` and read by the sync-related sections. */
export interface SyncStatus {
  isRunning: boolean;
  lastRun: number;
  nextRun: number | null;
  schedule: Schedule;
}

/** Which UI language the post-region-change banner suggests switching to.
 *  Mirrors LanguageSuggestionBanner's `target` prop. */
export type LanguageSuggestion = "zh" | "en";

/** Which bulk privacy-policy run is in flight. `fetch` re-scrapes source
 *  text only; `all` re-scrapes and re-summarises. They share one
 *  server-side mutex, so only one can run at a time. */
export type PolicyBulkPhase = "fetch" | "all";

export interface DeploymentDiagnosticCheck {
  detail: string;
  id: string;
  label: string;
  status: DeploymentCheckStatus;
}
export type DeploymentCheckStatus = "ok" | "info" | "warn" | "bad";

/** Shape returned by `GET /api/diagnostics/database` — rendered by the
 *  Deployment Diagnostics card and copied into the support bundle. */
export interface DeploymentDiagnostics {
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

/** One captured AI call from the opt-in debug log. Every field but
 *  `id`/`createdAt` is optional — a failed call may have a prompt and an
 *  error but no response. */
export interface AiDebugLogRow {
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

/** Where the three-phase backup restore currently is. Not a boolean:
 *  restoring the wrong backup is unrecoverable, so the preview step
 *  between "picked a file" and "applied it" is not skippable. */
export type BackupRestoreStage = "idle" | "previewing" | "confirm" | "applying";

/** Lifecycle of a bulk Wayback import. `*_requested` are the windows
 *  between the user clicking and the runner reaching its next app
 *  boundary — the only points where it can safely stop. */
export type WaybackRunStatus =
  | "idle"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "stale";

/** Live tally while a bulk Wayback import runs; null when idle. */
export interface WaybackProgress {
  currentAppName: string | null;
  failed: number;
  imported: number;
  index: number;
  skipped: number;
  total: number;
  unchanged: number;
}

/** Summary of the previous bulk Wayback run, as persisted server-side. */
export interface WaybackLastRun {
  endedAt: number | null;
  startedAt: number;
  status: "ok" | "partial" | "error" | "cancelled";
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
}

export interface BackupSnapshotSettings {
  enabled: boolean;
  intervalHours: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  retentionCount: number;
}

export interface BackupSnapshotRow {
  createdAt: number;
  filename: string;
  path: string;
  sizeBytes: number;
}

/** Response shape of the backup-snapshots endpoints. */
export interface BackupSnapshotsPayload {
  created?: BackupSnapshotRow;
  directory: string;
  pruned?: BackupSnapshotRow[];
  settings: BackupSnapshotSettings;
  snapshots: BackupSnapshotRow[];
}

/** The AI settings blob as the server reports it back — the baseline the
 *  editor diffs against to decide whether anything changed. */
export interface StoredAiSettings {
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

/** Result of the sample-policy dry run in the AI Summaries card. */
export interface AiSamplePolicyResult {
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

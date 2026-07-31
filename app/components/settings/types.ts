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

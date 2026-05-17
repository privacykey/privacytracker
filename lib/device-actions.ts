/**
 * Server-side helpers for Phase 3 device actions (cfgutil backup +
 * uninstall). Owns three concerns:
 *
 *   1. Audience + flag gating — the hard "is this allowed?" check
 *      that the API endpoints run before logging any device action.
 *   2. Backup-freshness tracking — stamps the last successful backup
 *      timestamp per device into `app_settings` and answers "is the
 *      most recent backup younger than the freshness window?".
 *   3. Activity logging — writes `cfgutil_backup` and
 *      `cfgutil_uninstall` rows so the Dev Options audit log has a
 *      forensic record of every destructive action.
 *
 * Kept out of `lib/scheduler.ts` so this module can grow without
 * dragging the scheduler's import surface; consumers are the two
 * thin API routes in `/api/device-actions/*` and the wizard server
 * loader in the route page.
 */

import "server-only";

import { recordActivity } from "./activity";
import { getActiveFocus } from "./feature-flag-storage";
import { resolveFlagFromDb } from "./feature-flags-server";
import { getSetting, setSetting } from "./scheduler";

/** Default freshness window — backups older than this disqualify uninstall. */
export const BACKUP_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

const SETTINGS_BACKUP_PREFIX = "cfgutil_last_backup_";

/**
 * Apple ECIDs are hex strings (typically 12-20 chars). Validate at every
 * TS-side entry point even though the Rust command also char-allowlists,
 * so a stray caller can't synthesise a key like
 * `cfgutil_last_backup_flag.devopts.cfgutil_uninstall` via string
 * concatenation and collide with another setting key. Defence in depth
 * — if the Rust validator changes or another TS entry point is added,
 * this still keeps the namespace unambiguous.
 */
function isValidEcid(value: string): boolean {
  return /^[A-Fa-f0-9]{8,24}$/.test(value);
}

interface BackupStamp {
  /** Epoch ms when the backup completed. */
  finishedAt: number;
  /** Filesystem path the backup landed at. */
  path: string;
}

/**
 * Reasons the uninstall path can be denied. Returned in a structured
 * shape so the API can render distinct copy per case rather than
 * collapsing them into a generic "not allowed".
 */
export type DeviceActionGate =
  | { allowed: true }
  | { allowed: false; reason: "audience"; activeAudience: string }
  | { allowed: false; reason: "flag" }
  | { allowed: false; reason: "backup_missing" }
  | { allowed: false; reason: "backup_stale"; agedMs: number };

/**
 * Resolve whether the user can currently invoke the uninstall path.
 * Three gates, evaluated in order:
 *
 *   1. Audience must be 'self'. Loved-one and guardian can build
 *      verdicts and export bundles, but cannot trigger device-side
 *      changes. This is the most important gate — a guardian
 *      auditing a child's apps must never accidentally execute on
 *their own* device. Cannot be bypassed.
 *   2. The `flag.devopts.cfgutil_uninstall` flag must be 'on'. Off by
 *      default, surfaced under Developer Options so the user has
 *      explicitly opted in to the destructive feature. Cannot be
 *      bypassed.
 *   3. A successful backup against the target ECID must exist within
 *      `BACKUP_FRESHNESS_WINDOW_MS`. Backup before destruction is
 *      strongly recommended, but the user can opt out per-call by
 *      passing `acknowledgeNoBackup: true` — the wizard's "Type DELETE
 *      to confirm without a backup" modal sets this. The bypass is
 *      activity-logged separately (see `recordUninstall.detail`).
 */
export function checkUninstallGate(
  ecid: string,
  opts: { acknowledgeNoBackup?: boolean } = {}
): DeviceActionGate {
  const focus = getActiveFocus();
  if (focus.audience !== "self") {
    return {
      allowed: false,
      reason: "audience",
      activeAudience: focus.audience,
    };
  }

  if (resolveFlagFromDb("flag.devopts.cfgutil_uninstall") !== "on") {
    return { allowed: false, reason: "flag" };
  }

  // Per-call user opt-out of the backup-freshness check. The audience +
  // flag gates above stay enforced — we only relax the backup
  // requirement, and only when the caller explicitly acknowledges the
  // risk. The wizard's no-backup modal types DELETE to set this.
  if (opts.acknowledgeNoBackup) {
    return { allowed: true };
  }

  const stamp = getLastBackup(ecid);
  if (!stamp) {
    return { allowed: false, reason: "backup_missing" };
  }
  const aged = Date.now() - stamp.finishedAt;
  if (aged > BACKUP_FRESHNESS_WINDOW_MS) {
    return { allowed: false, reason: "backup_stale", agedMs: aged };
  }

  return { allowed: true };
}

/** Most recent backup stamp for the given ECID, or null. */
export function getLastBackup(ecid: string): BackupStamp | null {
  if (!isValidEcid(ecid)) {
    return null;
  }
  const key = SETTINGS_BACKUP_PREFIX + ecid;
  const raw = getSetting(key, "");
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BackupStamp>;
    if (typeof parsed.finishedAt !== "number") {
      return null;
    }
    return {
      finishedAt: parsed.finishedAt,
      path: typeof parsed.path === "string" ? parsed.path : "",
    };
  } catch {
    return null;
  }
}

/** Record a successful backup. Overwrites any previous stamp for this device. */
export function recordBackup(opts: {
  ecid: string;
  path: string;
  finishedAt: number;
  deviceName: string | null;
}): void {
  if (!isValidEcid(opts.ecid)) {
    throw new Error(`recordBackup: invalid ECID ${opts.ecid}`);
  }
  const key = SETTINGS_BACKUP_PREFIX + opts.ecid;
  const stamp: BackupStamp = {
    finishedAt: opts.finishedAt,
    path: opts.path,
  };
  setSetting(key, JSON.stringify(stamp));

  try {
    recordActivity({
      type: "cfgutil_backup",
      status: "ok",
      appId: null,
      summary: opts.deviceName?.trim()
        ? `Backed up ${opts.deviceName.trim()}`
        : "Device backup completed",
      detail: {
        ecid: opts.ecid,
        path: opts.path,
        deviceName: opts.deviceName,
        finishedAt: opts.finishedAt,
      },
      startedAt: opts.finishedAt,
    });
  } catch (e) {
    console.warn("[device-actions] activity log failed:", e);
  }
}

/**
 * Record an uninstall outcome. Always writes an activity row,
 * regardless of whether the cfgutil call succeeded — a failure is as
 * important to log as a success ("Mum tried to uninstall TikTok but
 * cfgutil errored out" is meaningful audit data).
 */
export function recordUninstall(opts: {
  ecid: string;
  bundleId: string;
  appId: string | null;
  appName: string | null;
  ok: boolean;
  error: string | null;
  /**
   * Set when the user opted out of the backup-freshness check via the
   * wizard's "delete without a backup" modal. Mirrored into the
   * activity log so an audit of destructive actions can distinguish
   * "deleted with a fresh backup" from "deleted at the user's risk".
   */
  acknowledgedNoBackup?: boolean;
}): void {
  try {
    recordActivity({
      type: "cfgutil_uninstall",
      status: opts.ok ? "ok" : "error",
      appId: opts.appId,
      summary: opts.ok
        ? `Uninstalled ${opts.appName ?? opts.bundleId}${
            opts.acknowledgedNoBackup ? " (no backup, acknowledged)" : ""
          }`
        : `Uninstall failed for ${opts.appName ?? opts.bundleId}`,
      detail: {
        ecid: opts.ecid,
        bundleId: opts.bundleId,
        appName: opts.appName,
        error: opts.error,
        acknowledgedNoBackup: opts.acknowledgedNoBackup === true,
      },
      startedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[device-actions] activity log failed:", e);
  }
}

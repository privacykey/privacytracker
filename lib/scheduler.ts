import db from "./db";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  SECRET_SETTING_KEYS,
} from "./secret-settings";
import {
  canStartSyncManualRun,
  type RunSyncBulkResult,
  runBulkSync,
} from "./sync-bulk-runner";

export type SyncSchedule = "manual" | "daily" | "weekly";

const INTERVALS_MS: Record<SyncSchedule, number> = {
  manual: 0,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function getSetting(key: string, defaultValue = ""): string {
  const stored = (
    db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined
  )?.value;
  if (stored === undefined) {
    return defaultValue;
  }
  if (!(stored && SECRET_SETTING_KEYS.has(key))) {
    return stored;
  }
  if (!isEncryptedSecret(stored)) {
    db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(
      encryptSecret(key, stored),
      key
    );
    return stored;
  }
  try {
    return decryptSecret(key, stored);
  } catch (error) {
    console.error(`[settings] unable to decrypt ${key}:`, error);
    return defaultValue;
  }
}

export function setSetting(key: string, value: string): void {
  const stored =
    value && SECRET_SETTING_KEYS.has(key) ? encryptSecret(key, value) : value;
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
  ).run(key, stored);
}

/**
 * Write `value` to `key` only if no row exists yet. Used for first-visit
 * markers (e.g. `task_visit.privacy_map_at`) where we want the very first
 * page render to stamp the time and every subsequent render to be a cheap
 * no-op — one SELECT, no write.
 */
export function setSettingIfUnset(key: string, value: string): void {
  const existing = (
    db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      | { value?: string }
      | undefined
  )?.value;
  if (existing !== undefined && existing !== "") {
    return;
  }
  setSetting(key, value);
}

export function getSchedulerStatus() {
  const schedule = getSetting("sync_schedule", "manual") as SyncSchedule;
  const lastRun = Number.parseInt(getSetting("last_auto_sync", "0"), 10) || 0;
  const isRunning = getSetting("sync_running", "false") === "true";
  const interval = INTERVALS_MS[schedule] ?? 0;
  const nextRun = interval > 0 ? lastRun + interval : null;
  const isDue = interval > 0 && Date.now() >= lastRun + interval;

  return { schedule, lastRun, nextRun, isDue, isRunning };
}

/**
 * Thin adapter over `runBulkSync` that preserves the historical return
 * shape `{ synced, changes, skipped? }` used by `POST /api/sync/trigger`
 * and `instrumentation.ts`. New entry points should call `runBulkSync`
 * directly — that path also exposes `rateLimited` + `durationMs`.
 *
 * The mutex + resume-state handling lives in the runner, so this wrapper
 * only needs to honour the "busy → skipped" precedent. `canStartSyncManualRun`
 * also rejects when a crash-left state blob is present; the next startup
 * tick will resume it cleanly before anyone sees it.
 */
export async function runScheduledSync(
  options: { manual?: boolean } = {}
): Promise<{ synced: number; changes: number; skipped?: boolean }> {
  if (!canStartSyncManualRun().ok) {
    return { synced: 0, changes: 0, skipped: true };
  }

  const result: RunSyncBulkResult = await runBulkSync({
    initiator: options.manual ? "manual" : "scheduled",
  });
  return { synced: result.synced, changes: result.changes };
}

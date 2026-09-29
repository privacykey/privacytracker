import db from "./db";
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
  return (
    (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as any)
      ?.value ?? defaultValue
  );
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
  ).run(key, value);
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
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
  ).run(key, value);
}

/** The schedule the Monitor goal implies for a user who never picked one. */
export const MONITOR_DEFAULT_SYNC_SCHEDULE: SyncSchedule = "daily";
/** When the Monitor default turned daily sync on (epoch ms). */
export const MONITOR_DEFAULT_AT_KEY = "sync_schedule_default_at";

/**
 * "Sync daily when Monitor is chosen": called by `POST /api/focus` when the
 * saved focus includes the Monitor goal. The Monitor tile promises "we'll
 * tell you when one starts asking for more", which needs the apps to be
 * re-checked; a new install's schedule is Manual until someone picks one.
 *
 * A stored `sync_schedule` is the user's own choice: only `POST
 * /api/settings` writes it (Settings → Sync schedule, the desktop
 * Background Mode wizard), and it validates the value, so an existing row
 * means someone chose. This writes "daily" only when there is no row (or
 * an empty one), in one statement, so it never overrides an explicit
 * choice, "manual" included. Nothing ever reverts it: turning Monitor off
 * later leaves the schedule as it is. Returns whether it wrote.
 *
 * When it writes, it also records when (MONITOR_DEFAULT_AT_KEY), and the
 * schedule counts its first day from then: see getSchedulerStatus. Without
 * that, an install that has never synced is due at once, so the first tick
 * after onboarding re-fetched every app the import had just fetched.
 *
 * Mirrored in core/src/server/writes.rs (`focus`), statement for statement.
 */
export function applyMonitorSyncDefault(now = Date.now()): boolean {
  const result = db
    .prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value = ''"
    )
    .run("sync_schedule", MONITOR_DEFAULT_SYNC_SCHEDULE);
  if (result.changes === 0) {
    return false;
  }
  setSetting(MONITOR_DEFAULT_AT_KEY, String(now));
  return true;
}

export function getSchedulerStatus() {
  const schedule = getSetting("sync_schedule", "manual") as SyncSchedule;
  const lastRun = Number.parseInt(getSetting("last_auto_sync", "0"), 10) || 0;
  // A schedule the Monitor default turned on counts from that moment until
  // a sync runs; `lastRun` itself stays the last real sync.
  const defaultAt =
    Number.parseInt(getSetting(MONITOR_DEFAULT_AT_KEY, "0"), 10) || 0;
  const since = Math.max(lastRun, defaultAt);
  const isRunning = getSetting("sync_running", "false") === "true";
  const interval = INTERVALS_MS[schedule] ?? 0;
  const nextRun = interval > 0 ? since + interval : null;
  const isDue = interval > 0 && Date.now() >= since + interval;

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

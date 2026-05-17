/**
 * Server-side worker that drains the `import_items` queue. Picks up rows
 * that the wizard flipped to `status = 'queued'` after Apple rate-limited
 * a batch, and retries them on a cron-style tick.
 *
 * Concurrency:
 * - `import_queue_running` mutex in `app_settings` blocks concurrent ticks.
 * - `claimQueuedBatch` atomically bumps `attempt_count` and pushes
 *   `next_attempt_at` ~10 minutes out so a second tick can't double-grab.
 * - On 429 we persist a global `import_queue_paused_until` fence so the
 *   next few ticks no-op until Apple's rolling-minute window clears.
 */

import db from "./db";
import {
  claimQueuedBatch,
  completeImportIfSettled,
  getQueueStatus,
  type ImportItemRow,
  recordItemError,
  recordItemRetry,
  recordItemSuccess,
} from "./imports";
import { getSetting, setSetting } from "./scheduler";

// Queued rows attempted per tick. The soft rate-limit pacer in
// lib/rate-limit.ts enforces Apple's rolling-minute limit regardless of
// batch size — auto-paces later requests in the burst.
const BATCH_SIZE = 10;

// Stale-lock safety: clear the mutex if a tick has been "running" longer
// than this. A real tick takes 5-30s on a slow Apple round-trip; 90s is
// generous headroom. instrumentation.ts handles the process-died case.
const RUNNING_LOCK_STALE_MS = 90 * 1000;

const SETTING_RUNNING = "import_queue_running";
const SETTING_RUNNING_SINCE = "import_queue_running_since";
const SETTING_PAUSED_UNTIL = "import_queue_paused_until";
const SETTING_LAST_RUN = "import_queue_last_run";

export interface ImportQueueTickResult {
  failed: number;
  pausedUntil?: number;
  processed: number;
  rateLimited: number;
  skipped?: "paused" | "busy" | "empty";
  succeeded: number;
}

/**
 * Drain due queued rows. Safe to call on every instrumentation tick; no-ops
 * when the queue is empty, another tick is in flight, or a previous 429
 * hasn't expired. Logs at least one [ImportQueue] line per tick (or one
 * skip reason for quiet ticks) so operators can grep tauri:dev.
 */
export async function runImportQueueTick(): Promise<ImportQueueTickResult> {
  // Respect a prior 429 pause before touching the mutex.
  const pausedUntil =
    Number.parseInt(getSetting(SETTING_PAUSED_UNTIL, "0"), 10) || 0;
  if (pausedUntil > Date.now()) {
    console.info(
      `[ImportQueue] tick skipped — paused for ${Math.round((pausedUntil - Date.now()) / 1000)}s more (Apple 429 cooldown)`
    );
    return {
      skipped: "paused",
      processed: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
      pausedUntil,
    };
  }

  // Stale-lock: if the running stamp is old, assume the previous tick died
  // and release the lock so a crash-loop doesn't wedge the queue.
  if (getSetting(SETTING_RUNNING) === "true") {
    const runningSince =
      Number.parseInt(getSetting(SETTING_RUNNING_SINCE, "0"), 10) || 0;
    if (runningSince > 0 && Date.now() - runningSince > RUNNING_LOCK_STALE_MS) {
      console.warn(
        `[ImportQueue] Clearing stale running lock (${Math.round((Date.now() - runningSince) / 60_000)}m old)`
      );
      setSetting(SETTING_RUNNING, "false");
    } else {
      console.info(
        "[ImportQueue] tick skipped — another tick is running (mutex held)"
      );
      return {
        skipped: "busy",
        processed: 0,
        succeeded: 0,
        failed: 0,
        rateLimited: 0,
      };
    }
  }

  setSetting(SETTING_RUNNING, "true");
  setSetting(SETTING_RUNNING_SINCE, Date.now().toString());

  const tickStartedAt = Date.now();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let rateLimited = 0;
  let newPausedUntil: number | undefined;

  try {
    // Lazy-import to break any circular init between scraper → policy → db.
    const { fetchAndParseApp, AppleRateLimitError } = await import("./scraper");

    const claimed = claimQueuedBatch(BATCH_SIZE);
    if (claimed.length === 0) {
      console.info("[ImportQueue] tick skipped — no due queued rows");
      return {
        skipped: "empty",
        processed: 0,
        succeeded: 0,
        failed: 0,
        rateLimited: 0,
      };
    }

    console.info(
      `[ImportQueue] tick start — claimed ${claimed.length}/${BATCH_SIZE} rows (importIds: ${Array.from(
        new Set(claimed.map((c) => c.importId))
      ).join(", ")})`
    );

    for (const item of claimed) {
      processed += 1;
      const itemStart = Date.now();
      const itemLabel = `[${item.id} → ${item.url ?? "<no url>"}]`;

      if (!item.url) {
        // A queued row without a URL is unfetchable; flip to error so we
        // don't re-claim it every tick.
        console.warn(
          `[ImportQueue] item error ${itemLabel} — no URL on row; flipping to error`
        );
        recordItemError(item.id, "Queued item has no URL to scrape");
        completeImportIfSettled(item.importId);
        failed += 1;
        continue;
      }

      try {
        // Tag the snapshot as 'import' so the history timeline can
        // distinguish it from a later manual rescrape.
        const result = await fetchAndParseApp(item.url, false, false, "import");
        // Flip the import_item to imported using the returned id + name.
        if (
          result &&
          typeof result === "object" &&
          "id" in result &&
          "name" in result
        ) {
          recordItemSuccess(item.id, {
            id: String(result.id),
            name: String(result.name),
            developer: item.developer,
            url: item.url,
            iconUrl: item.iconUrl,
          });
          completeImportIfSettled(item.importId);
          succeeded += 1;
          console.info(
            `[ImportQueue] item ok ${itemLabel} — "${String(result.name)}" in ${Date.now() - itemStart}ms`
          );
        } else {
          console.warn(
            `[ImportQueue] item error ${itemLabel} — scraper returned unexpected shape:`,
            result
          );
          recordItemError(item.id, "Scraper returned an unexpected shape");
          completeImportIfSettled(item.importId);
          failed += 1;
        }
      } catch (err: unknown) {
        if (err instanceof AppleRateLimitError) {
          // Hard stop: every remaining row would trip the same limit. Push
          // everyone out to the Retry-After fence and set the global pause.
          const retryAfterMs = err.retryAfterMs;
          rateLimited += 1;
          recordItemRetry(item.id, {
            retryAfterMs,
            scrapeError: "Apple rate-limited the queue; will retry later",
          });
          newPausedUntil = Date.now() + retryAfterMs;
          setSetting(SETTING_PAUSED_UNTIL, newPausedUntil.toString());
          console.warn(
            `[ImportQueue] item rate-limit ${itemLabel} — Apple 429; pausing queue for ${Math.round(retryAfterMs / 1000)}s. ` +
              "Items still queued at this point will resume automatically when the cooldown elapses."
          );
          break;
        }
        // Non-rate-limit errors are likely permanent (404, parse failure, etc.).
        // Flip to error rather than loop-retrying forever.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[ImportQueue] item error ${itemLabel} — ${message}`);
        recordItemError(item.id, message);
        completeImportIfSettled(item.importId);
        failed += 1;
      }
    }

    console.info(
      `[ImportQueue] tick end — processed ${processed}, succeeded ${succeeded}, failed ${failed}, rateLimited ${rateLimited} ` +
        `in ${Date.now() - tickStartedAt}ms${newPausedUntil ? ` (paused until ${new Date(newPausedUntil).toISOString()})` : ""}`
    );

    return {
      processed,
      succeeded,
      failed,
      rateLimited,
      pausedUntil: newPausedUntil,
    };
  } finally {
    setSetting(SETTING_RUNNING, "false");
    setSetting(SETTING_LAST_RUN, Date.now().toString());
  }
}

/**
 * Augments `getQueueStatus` with worker metadata (rate-limit window, busy
 * tick, last run) so the UI can explain why a row isn't moving. Called
 * from /api/imports/queue/status and the Task Center.
 */
export function getImportQueueStatus(): {
  queued: number;
  oldestNextAttemptAt: number | null;
  soonestNextAttemptAt: number | null;
  items: ImportItemRow[];
  pausedUntil: number | null;
  running: boolean;
  lastRunAt: number | null;
} {
  const base = getQueueStatus();
  const pausedUntilRaw =
    Number.parseInt(getSetting(SETTING_PAUSED_UNTIL, "0"), 10) || 0;
  const lastRunRaw =
    Number.parseInt(getSetting(SETTING_LAST_RUN, "0"), 10) || 0;
  const pausedUntil = pausedUntilRaw > Date.now() ? pausedUntilRaw : null;
  return {
    ...base,
    pausedUntil,
    running: getSetting(SETTING_RUNNING, "false") === "true",
    lastRunAt: lastRunRaw || null,
  };
}

/**
 * Called by /api/imports/queue/retry when the user clicks "Retry queue now".
 * Clears the global pause fence and kicks a tick immediately.
 */
export async function forceImportQueueRun(): Promise<ImportQueueTickResult> {
  setSetting(SETTING_PAUSED_UNTIL, "0");
  // Clear item-level backoff so every queued row is eligible now.
  db.prepare(
    "UPDATE import_items SET next_attempt_at = 0 WHERE status = 'queued'"
  ).run();
  return runImportQueueTick();
}

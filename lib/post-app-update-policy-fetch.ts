/**
 * Deferred privacy-policy source refresh after app-label updates.
 *
 * Import and App Store sync should make the tracked-app rows usable first.
 * Policy pages are slower, less reliable, and can be very large, so this
 * helper coalesces "labels changed" events into one background fetch-only
 * policy run after the importing/syncing path has returned.
 */

export type PostAppUpdatePolicyReason = "import" | "sync";

const DEFAULT_DELAY_MS = 2000;
const BUSY_RETRY_DELAY_MS = 5 * 60_000;
const MAX_BUSY_RETRIES = 3;

let timer: ReturnType<typeof setTimeout> | null = null;
let busyRetries = 0;
const pendingReasons = new Set<PostAppUpdatePolicyReason>();

function armTimer(delayMs: number): void {
  if (timer) {
    return;
  }
  timer = setTimeout(
    () => {
      timer = null;
      void drainPolicyFetchQueue();
    },
    Math.max(0, delayMs)
  );
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

export function schedulePostAppUpdatePolicyFetch(
  reason: PostAppUpdatePolicyReason,
  options: { delayMs?: number } = {}
): void {
  pendingReasons.add(reason);
  armTimer(options.delayMs ?? DEFAULT_DELAY_MS);
}

async function drainPolicyFetchQueue(): Promise<void> {
  if (pendingReasons.size === 0) {
    return;
  }

  const reasons = Array.from(pendingReasons);
  pendingReasons.clear();
  const reasonLabel = reasons.sort().join("+");

  try {
    const { canStartPolicyManualRun, runBulkPolicySync } = await import(
      "./policy-bulk-runner"
    );
    if (!canStartPolicyManualRun().ok) {
      if (busyRetries < MAX_BUSY_RETRIES) {
        busyRetries += 1;
        for (const reason of reasons) {
          pendingReasons.add(reason);
        }
        console.info(
          `[PolicyFetch] Deferred ${reasonLabel} policy fetch waiting for current policy run; retry ${busyRetries}/${MAX_BUSY_RETRIES}`
        );
        armTimer(BUSY_RETRY_DELAY_MS);
      } else {
        busyRetries = 0;
        console.info(
          `[PolicyFetch] Deferred ${reasonLabel} policy fetch skipped because another policy run stayed busy`
        );
      }
      return;
    }

    busyRetries = 0;
    console.info(
      `[PolicyFetch] Starting deferred ${reasonLabel} policy source fetch`
    );
    const result = await runBulkPolicySync({
      initiator: "automatic",
      phase: "fetch",
      force: false,
    });
    console.info(
      `[PolicyFetch] Deferred ${reasonLabel} policy source fetch complete: ` +
        `${result.totals.succeeded} ok, ${result.totals.failed} failed, ` +
        `${result.totals.throttled} throttled, ${result.totals.skipped} skipped`
    );
  } catch (error) {
    console.warn(
      `[PolicyFetch] Deferred ${reasonLabel} policy source fetch failed:`,
      error
    );
  }
}

/**
 * The bulk runs executing in this process right now.
 *
 * The boot-time resume checks in `instrumentation.ts` take over a run whose
 * runner died with the previous process: its state blob still has pending
 * work and its mutex is still held. A run this process started after boot
 * looks exactly the same from the database, so a bulk run started in the
 * first seconds after boot (Settings' "Sync now", or the deferred policy
 * fetch that a single app's sync schedules) used to be "resumed" by its own
 * process: a second runner walking the same queue, a "resumed after server
 * restart" notification with no restart, and every app still pending
 * fetched twice. The resume checks skip a job that is live here.
 *
 * In memory on purpose: a crash clears it along with the runner it
 * describes, which is exactly when a resume check should act. Kept on
 * `globalThis`, like the CSP report ring, so `instrumentation.ts` and the
 * routes that start runs read one registry however the server build splits
 * modules into chunks.
 */

export type BulkJob = "policy" | "sync" | "wayback";

const live: Map<BulkJob, number> = ((globalThis as any).__pt_live_bulk_runs ??=
  new Map());

/**
 * Run `body` as a live `job` run until it settles, whether it returns or
 * throws. Counted rather than flagged, so an overlapping run of the same
 * job keeps the job live until the last one ends.
 */
export async function withLiveBulkRun<T>(
  job: BulkJob,
  body: () => Promise<T>
): Promise<T> {
  live.set(job, (live.get(job) ?? 0) + 1);
  try {
    return await body();
  } finally {
    const left = (live.get(job) ?? 1) - 1;
    if (left > 0) {
      live.set(job, left);
    } else {
      live.delete(job);
    }
  }
}

/** Is a `job` runner executing in this process? */
export function isBulkRunLive(job: BulkJob): boolean {
  return (live.get(job) ?? 0) > 0;
}

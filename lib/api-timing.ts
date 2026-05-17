/**
 * Server-side API-request timing ring. Pairs with the client-side
 * client-diagnostics longtask/fetch rings so the Diagnostics page can
 * answer "which API call took 4 seconds while the page was hung?".
 *
 * Process-local + in-memory. Restart clears the ring.
 *
 * Route handlers opt in by wrapping their export with `withApiTiming`:
 *
 *   export const POST = withApiTiming('/api/imports/queue', async (req) => {...});
 */

const RING_SIZE = 200;

/** Requests at or above this duration are always recorded; faster ones
 *  are sampled (every Nth) to keep the ring useful for high-traffic
 *  routes without flooding it. */
const SLOW_THRESHOLD_MS = 100;

/** 1-in-N sampling for fast requests. */
const SAMPLE_EVERY = 5;

export interface ApiTimingRecord {
  /** Epoch ms at the time the response was sent. */
  at: number;
  durationMs: number;
  /** Truncated error message if the handler threw. */
  error?: string;
  method: string;
  /** Route label — usually the static pathname. */
  route: string;
  /** HTTP status; 0 on thrown error before the response was built. */
  status: number;
}

const ring: Array<ApiTimingRecord | undefined> = new Array(RING_SIZE);
let writeIndex = 0;
let totalCount = 0;
let slowCount = 0;
let sampleCounter = 0;

function record(rec: ApiTimingRecord): void {
  ring[writeIndex % RING_SIZE] = rec;
  writeIndex += 1;
  totalCount += 1;
  if (rec.durationMs >= SLOW_THRESHOLD_MS || rec.error) {
    slowCount += 1;
  }
}

export function getRecentApiTimings(limit = RING_SIZE): ApiTimingRecord[] {
  const wrapped = writeIndex >= RING_SIZE;
  const start = wrapped ? writeIndex % RING_SIZE : 0;
  const liveCount = wrapped ? RING_SIZE : writeIndex;
  const want = Math.min(limit, liveCount);
  const out: ApiTimingRecord[] = [];
  for (let i = liveCount - want; i < liveCount; i++) {
    const slot = ring[(start + i) % RING_SIZE];
    if (slot) {
      out.push(slot);
    }
  }
  return out;
}

export function snapshotApiTimings(limit = RING_SIZE): {
  thresholdMs: number;
  totalSinceStart: number;
  slowSinceStart: number;
  recent: ApiTimingRecord[];
} {
  return {
    thresholdMs: SLOW_THRESHOLD_MS,
    totalSinceStart: totalCount,
    slowSinceStart: slowCount,
    recent: getRecentApiTimings(limit),
  };
}

export function clearApiTimings(): void {
  ring.fill(undefined);
  writeIndex = 0;
  totalCount = 0;
  slowCount = 0;
  sampleCounter = 0;
}

/**
 * Wrap a route handler so its duration + status is captured into the ring.
 * The wrapped handler keeps the original signature so Next can mount it.
 * Always records slow requests + errors; fast successful requests are
 * 1-in-N sampled so the ring isn't dominated by status pollers.
 */
export function withApiTiming<
  TArgs extends unknown[],
  TResult extends Response | Promise<Response>,
>(
  route: string,
  handler: (...args: TArgs) => TResult
): (...args: TArgs) => Promise<Response> {
  return async function timedHandler(...args: TArgs): Promise<Response> {
    const t0 = performance.now();
    const req = args[0] as { method?: string } | undefined;
    const method = (req?.method ?? "GET").toUpperCase();
    try {
      const res = await handler(...args);
      const durationMs = Math.round(performance.now() - t0);
      const status = res.status;
      const slow = durationMs >= SLOW_THRESHOLD_MS;
      const erroring = status >= 400;
      if (slow || erroring || ++sampleCounter % SAMPLE_EVERY === 0) {
        record({ at: Date.now(), route, method, durationMs, status });
      }
      return res;
    } catch (err) {
      const durationMs = Math.round(performance.now() - t0);
      record({
        at: Date.now(),
        route,
        method,
        durationMs,
        status: 0,
        error:
          err instanceof Error
            ? err.message.slice(0, 200)
            : String(err).slice(0, 200),
      });
      throw err;
    }
  };
}

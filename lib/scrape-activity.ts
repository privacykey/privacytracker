/**
 * Per-scrape activity ring + in-progress map. Lets the Diagnostics page
 * answer "what was the scraper doing when the app hung?".
 *
 * Each scrape gets a stable id, a startedAt timestamp, and a list of
 * phase marks (ms-offsets from scrape start). When the scrape completes
 * or errors, the entry moves from the in-progress map to a fixed-size
 * ring of recent scrapes.
 *
 * Phase names are free-form so callers can mark anything useful, but
 * `fetchAndParseApp` uses a stable set: 'apple_fetched', 'parsed',
 * 'committed', 'policy_done'. A scrape currently sitting in 'apple_fetched'
 * with no later phase tells you the parser or DB step is what's slow.
 */

const RING_SIZE = 50;

export interface ScrapePhaseMark {
  /** Milliseconds since the scrape started. */
  atOffsetMs: number;
  phase: string;
}

export interface InProgressScrape {
  id: string;
  phases: ScrapePhaseMark[];
  resync: boolean;
  /** Wall-clock duration so far at read time. */
  runningMs: number;
  startedAt: number;
  url: string;
}

export interface ScrapeRecord {
  appName?: string;
  error?: string;
  id: string;
  outcome: "success" | "error" | "rate_limited";
  phases: ScrapePhaseMark[];
  resync: boolean;
  startedAt: number;
  totalMs: number;
  url: string;
}

interface InProgressEntry {
  phases: ScrapePhaseMark[];
  resync: boolean;
  startedAt: number;
  url: string;
}

const inProgress = new Map<string, InProgressEntry>();
const ring: Array<ScrapeRecord | undefined> = new Array(RING_SIZE);
let writeIndex = 0;
let totalCount = 0;

let nextScrapeId = 1;

/** Allocate a fresh scrape id. Monotonic + process-local. */
export function newScrapeId(): string {
  return `s${nextScrapeId++}`;
}

/** Record the start of a scrape. */
export function beginScrape(id: string, url: string, resync: boolean): void {
  inProgress.set(id, {
    url,
    startedAt: Date.now(),
    phases: [],
    resync,
  });
}

/**
 * Mark a phase transition. Cheap (one allocation) — safe to call from
 * inside hot loops. No-op if the id isn't currently in-progress (e.g.
 * the scrape ended early due to an early throw).
 */
export function markScrapePhase(id: string, phase: string): void {
  const entry = inProgress.get(id);
  if (!entry) {
    return;
  }
  entry.phases.push({ phase, atOffsetMs: Date.now() - entry.startedAt });
}

/** Move an in-progress scrape into the ring. */
export function endScrape(
  id: string,
  outcome: "success" | "error" | "rate_limited",
  extra?: { appName?: string; error?: string }
): void {
  const entry = inProgress.get(id);
  if (!entry) {
    return;
  }
  inProgress.delete(id);
  const record: ScrapeRecord = {
    id,
    startedAt: entry.startedAt,
    url: entry.url,
    appName: extra?.appName,
    totalMs: Date.now() - entry.startedAt,
    phases: entry.phases,
    outcome,
    error: extra?.error,
    resync: entry.resync,
  };
  ring[writeIndex % RING_SIZE] = record;
  writeIndex += 1;
  totalCount += 1;
}

export interface ScrapeActivitySnapshot {
  /** Live, currently-running scrapes — read time computes runningMs. */
  inProgress: InProgressScrape[];
  /** Completed scrapes, newest first. */
  recent: ScrapeRecord[];
  /** Number of scrapes captured since process start. */
  totalSinceStart: number;
}

export function snapshotScrapeActivity(
  limit = RING_SIZE
): ScrapeActivitySnapshot {
  const now = Date.now();
  const inProgressList: InProgressScrape[] = Array.from(inProgress.entries())
    .map(([id, v]) => ({
      id,
      url: v.url,
      startedAt: v.startedAt,
      runningMs: now - v.startedAt,
      phases: v.phases,
      resync: v.resync,
    }))
    .sort((a, b) => b.runningMs - a.runningMs);

  // Walk the ring newest-first up to `limit`.
  const wrapped = writeIndex >= RING_SIZE;
  const start = wrapped ? writeIndex % RING_SIZE : 0;
  const liveCount = wrapped ? RING_SIZE : writeIndex;
  const want = Math.min(limit, liveCount);
  const recent: ScrapeRecord[] = [];
  for (let i = liveCount - 1; i >= liveCount - want; i--) {
    const slot = ring[(start + i) % RING_SIZE];
    if (slot) {
      recent.push(slot);
    }
  }

  return {
    totalSinceStart: totalCount,
    inProgress: inProgressList,
    recent,
  };
}

export function clearScrapeActivity(): void {
  inProgress.clear();
  ring.fill(undefined);
  writeIndex = 0;
  totalCount = 0;
}

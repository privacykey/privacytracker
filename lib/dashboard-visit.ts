/** One comparison baseline per device view and browser-tab session. Successful
 * dashboard reads update the next visit's timestamp without moving this tab's
 * baseline. sessionStorage keeps it through navigation and reloads; memory is
 * the fallback when browser storage is unavailable. */
type VisitStorage = Pick<Storage, "getItem" | "setItem">;
export interface DashboardVisit {
  key: string;
  since: number | null;
  startedAt: number;
}

function timestamp(value: unknown, now: number): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= now
  );
}

export class DashboardVisits {
  private readonly visits = new Map<string, DashboardVisit>();

  constructor(
    private readonly history: () => VisitStorage,
    private readonly session: () => VisitStorage
  ) {}

  begin(scope: string | null, now = Date.now()): DashboardVisit {
    const key = `privacytracker.dashboard.visit.${scope ?? "all"}`;
    const existing = this.visits.get(key);
    if (existing) {
      return existing;
    }
    let since: number | null = null;
    try {
      const saved = JSON.parse(this.session().getItem(key) ?? "null");
      if (
        saved?.v === 1 &&
        timestamp(saved.startedAt, now) &&
        (saved.since === null || timestamp(saved.since, saved.startedAt))
      ) {
        const visit = { key, since: saved.since, startedAt: saved.startedAt };
        this.visits.set(key, visit);
        return visit;
      }
    } catch {
      // A corrupt or unavailable session must not prevent a dashboard read.
    }
    try {
      const previous = Number(this.history().getItem(key));
      if (timestamp(previous, now)) {
        since = previous;
      }
    } catch {
      // First-visit presentation is also usable without persistent storage.
    }
    const visit = { key, since, startedAt: now };
    this.visits.set(key, visit);
    return visit;
  }

  /** Call only after a successful read, using its start time so changes that
   * arrived while loading remain new on the next visit. */
  record(visit: DashboardVisit, readStartedAt: number): void {
    try {
      this.session().setItem(
        visit.key,
        JSON.stringify({ v: 1, since: visit.since, startedAt: visit.startedAt })
      );
    } catch {
      // In-memory continuity still covers navigation in this tab.
    }
    try {
      this.history().setItem(visit.key, String(readStartedAt));
    } catch {
      // Browser storage is optional.
    }
  }
}

// Created without touching window; only HomeLoader's client effect reads it.
export const dashboardVisits = new DashboardVisits(
  () => window.localStorage,
  () => window.sessionStorage
);

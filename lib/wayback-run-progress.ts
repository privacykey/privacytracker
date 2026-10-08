/**
 * The bulk Wayback import as Settings → Historical Import sees it: the
 * persisted run (`GET /api/wayback/import-all`), the NDJSON frames of a
 * run this tab started (`POST ?stream=1`), and the activity row a
 * finished run leaves behind.
 *
 * The Rust runner's redesign (docs/WAYBACK_IMPORT.md, P3) adds a survey
 * phase, a time estimate, waits instead of pauses, and totals in apps and
 * label changes: state v3, the `phase` / `survey-app` / `survey-done` /
 * `waiting` / `estimate` frames, and new keys on the totals. Every one of
 * them is optional here. The Node rollback sends none of them, and with
 * none present every derivation below returns null and the card renders
 * exactly as it did before the redesign.
 *
 * Pure and client-safe, so the frame handling is testable without a
 * browser: `lib/use-wayback.ts` keeps the side effects (task subtitles,
 * toasts) and stores what `reduceWaybackFrame` returns.
 */

/** The run's phase. `survey` lists every app's captures once; `reading`
 *  reads archived pages for the apps that have any. */
export type WaybackPhase = "survey" | "reading";

/** What the survey found, as `state.survey` and the `survey-done` frame
 *  carry it. `completedAt` is null while the survey is still running. */
export interface WaybackSurvey {
  appsSurveyed: number;
  appsWithCaptures: number;
  appsWithoutCaptures: number;
  capturesTotal: number;
  completedAt: number | null;
  estimatedReads: number;
}

/** The runner's estimate, recomputed at every app boundary. */
export interface WaybackEstimate {
  /** Time left in ms. A value that reads as an epoch timestamp (anything
   *  past 2001) is taken as the finish time instead; see `waybackEtaMs`. */
  etaMs: number | null;
  perMinute: number | null;
  readsDone: number;
  readsRemaining: number;
}

/** The run's totals in apps and label changes (v3 keys on `totals`). */
export interface WaybackAppTotals {
  appsDone: number;
  appsNoArchive: number;
  appsWithHistory: number;
  changes: number;
  labelVersions: number;
  reads: number;
}

/** The tally the card has always shown, counted in checkpoints. Same
 *  shape as `WaybackProgress` in `app/components/settings/types.ts`. */
export interface WaybackLegacyTally {
  currentAppName: string | null;
  failed: number;
  imported: number;
  index: number;
  skipped: number;
  total: number;
  unchanged: number;
}

/** The redesign's additions. Absent on the Node rollback. */
export interface WaybackRunExtras {
  /** Apps whose import failed outright (not throttled). */
  appsFailed?: number;
  appTotals?: WaybackAppTotals | null;
  estimate?: WaybackEstimate | null;
  /** Stream bookkeeping: the app between its `app-start` and `app-done`. */
  inFlightAppId?: string | null;
  /** Stream bookkeeping: apps the survey found no captures for. */
  noArchiveIds?: string[];
  phase?: WaybackPhase | null;
  /** Apps with archived pages that have finished reading. */
  readingDone?: number;
  /** Whether an app with archived pages is being read right now. */
  readingInFlight?: boolean;
  /** Apps with archived pages, when known exactly. */
  readingTotal?: number | null;
  survey?: WaybackSurvey | null;
  /** Apps the survey has listed so far, and how many it will list. */
  surveyDone?: number;
  surveyTotal?: number;
  /** Epoch ms the runner resumes at; present only while it waits. */
  waitingUntil?: number | null;
  waitReason?: string | null;
}

export type WaybackLiveProgress = WaybackLegacyTally & WaybackRunExtras;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number {
  const n = finite(value);
  return n !== null && n > 0 ? n : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsePhase(value: unknown): WaybackPhase | null {
  return value === "survey" || value === "reading" ? value : null;
}

export function parseWaybackSurvey(raw: unknown): WaybackSurvey | null {
  if (!isObject(raw)) {
    return null;
  }
  const withCaptures = finite(raw.appsWithCaptures);
  const withoutCaptures = finite(raw.appsWithoutCaptures);
  const surveyed = finite(raw.appsSurveyed);
  if (withCaptures === null && withoutCaptures === null && surveyed === null) {
    return null;
  }
  const completedAt = finite(raw.completedAt);
  return {
    appsSurveyed: count(surveyed),
    appsWithCaptures: count(withCaptures),
    appsWithoutCaptures: count(withoutCaptures),
    capturesTotal: count(raw.capturesTotal),
    estimatedReads: count(raw.estimatedReads),
    completedAt: completedAt !== null && completedAt > 0 ? completedAt : null,
  };
}

export function parseWaybackEstimate(raw: unknown): WaybackEstimate | null {
  if (!isObject(raw)) {
    return null;
  }
  const remaining = finite(raw.readsRemaining);
  const eta = finite(raw.etaMs);
  if (remaining === null && eta === null) {
    return null;
  }
  const perMinute = finite(raw.perMinute);
  return {
    readsDone: count(raw.readsDone),
    readsRemaining: count(remaining),
    perMinute: perMinute !== null && perMinute > 0 ? perMinute : null,
    etaMs: eta,
  };
}

/** The v3 totals keys, or null when `totals` predates them (Node, or a
 *  v2 run before its first app finishes on the new runner). */
export function parseWaybackAppTotals(raw: unknown): WaybackAppTotals | null {
  if (!isObject(raw)) {
    return null;
  }
  const keys = [
    "appsDone",
    "appsWithHistory",
    "appsNoArchive",
    "reads",
    "changes",
    "labelVersions",
  ] as const;
  if (!keys.some((key) => finite(raw[key]) !== null)) {
    return null;
  }
  return {
    appsDone: count(raw.appsDone),
    appsWithHistory: count(raw.appsWithHistory),
    appsNoArchive: count(raw.appsNoArchive),
    reads: count(raw.reads),
    changes: count(raw.changes),
    labelVersions: count(raw.labelVersions),
  };
}

/**
 * The redesign's fields from a `GET /api/wayback/import-all` payload:
 * `state` is the persisted blob (v3 keys optional), `summary` the
 * server's queue counts. Reading progress comes from the queue when the
 * payload carries it, else from the queue counts less the apps that
 * finished with no archived pages.
 */
export function parseWaybackRunExtras(
  state: unknown,
  summary: unknown
): WaybackRunExtras {
  const s = isObject(state) ? state : {};
  const sum = isObject(summary) ? summary : {};
  const survey = parseWaybackSurvey(s.survey);
  const appTotals = parseWaybackAppTotals(s.totals);
  const waitingUntil = finite(s.waitingUntil);
  const extras: WaybackRunExtras = {
    phase: parsePhase(s.phase),
    survey,
    estimate: parseWaybackEstimate(s.estimate),
    waitingUntil:
      waitingUntil !== null && waitingUntil > 0 ? waitingUntil : null,
    waitReason: text(s.waitReason),
    appTotals,
    appsFailed: count(sum.failed),
    surveyDone: survey?.appsSurveyed ?? 0,
    surveyTotal: count(sum.total),
  };
  if (Array.isArray(s.queue)) {
    let done = 0;
    let total = 0;
    let inFlight = false;
    for (const entry of s.queue) {
      if (!isObject(entry) || entry.noArchive === true) {
        continue;
      }
      total += 1;
      if (entry.status === "done" || entry.status === "failed") {
        done += 1;
      } else if (entry.status === "in_progress") {
        inFlight = true;
      }
    }
    extras.readingDone = done;
    extras.readingTotal = total;
    extras.readingInFlight = inFlight;
  } else {
    const finished = count(sum.done) + count(sum.failed);
    extras.readingDone = Math.max(
      0,
      finished - (appTotals?.appsNoArchive ?? 0)
    );
    extras.readingTotal = survey ? survey.appsWithCaptures : null;
    extras.readingInFlight = count(sum.inProgress) > 0;
  }
  return extras;
}

function zeroAppTotals(): WaybackAppTotals {
  return {
    appsDone: 0,
    appsWithHistory: 0,
    appsNoArchive: 0,
    reads: 0,
    changes: 0,
    labelVersions: 0,
  };
}

/** A per-app result from the change-finding import (P2) carries these. */
function isChangeFindingResult(result: unknown): result is Json {
  return (
    isObject(result) &&
    (finite(result.changes) !== null || finite(result.reads) !== null)
  );
}

/** The tally a fresh run starts from, before its `batch-start`. */
export function startingWaybackProgress(): WaybackLiveProgress {
  return {
    index: 0,
    total: 0,
    currentAppName: null,
    imported: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };
}

/**
 * The progress after one NDJSON frame. The pre-redesign frames
 * (`batch-start`, `app-start`, `app-done`) update the checkpoint tally
 * exactly as they always have; the redesign's frames and fields only
 * ever add keys beside it. Frames that change nothing (`target`,
 * `backoff`, the terminal ones the hook handles) return `prev` itself.
 */
export function reduceWaybackFrame(
  prev: WaybackLiveProgress | null,
  event: unknown
): WaybackLiveProgress | null {
  if (!isObject(event)) {
    return prev;
  }
  const ev = event as Record<string, any>;
  switch (ev.type) {
    case "batch-start": {
      const next: WaybackLiveProgress = {
        ...startingWaybackProgress(),
        total: Number(ev.total ?? 0),
      };
      if (prev?.phase) {
        next.phase = prev.phase;
      }
      return next;
    }
    case "app-start": {
      if (!prev) {
        return prev;
      }
      const next: WaybackLiveProgress = {
        ...prev,
        index: (ev.index ?? 0) + 1,
        total: Number(ev.total ?? prev.total),
        currentAppName: String(ev.name ?? ""),
      };
      if (prev.phase) {
        // Reading starts with the first app; the wait it may follow is over.
        next.phase = "reading";
        next.waitingUntil = null;
        next.waitReason = null;
        next.inFlightAppId = text(ev.appId);
        next.readingInFlight = !(prev.noArchiveIds ?? []).includes(
          String(ev.appId ?? "")
        );
      }
      return next;
    }
    case "app-done": {
      if (!prev) {
        return prev;
      }
      const result = ev.result;
      const next: WaybackLiveProgress = {
        ...prev,
        index: (ev.index ?? 0) + 1,
        imported: prev.imported + Number(result?.imported ?? 0),
        unchanged: prev.unchanged + Number(result?.unchanged ?? 0),
        skipped: prev.skipped + Number(result?.skipped ?? 0),
        // A top-level `error` means the whole app call threw: one failed
        // app on top of its per-target failures.
        failed: prev.failed + Number(result?.failed ?? 0) + (ev.error ? 1 : 0),
      };
      if (!(prev.phase || isChangeFindingResult(result))) {
        return next;
      }
      const noArchive =
        result?.noArchive === true ||
        ev.noArchive === true ||
        (prev.noArchiveIds ?? []).includes(String(ev.appId ?? ""));
      const totals = { ...(prev.appTotals ?? zeroAppTotals()) };
      totals.appsDone += 1;
      if (noArchive) {
        totals.appsNoArchive += 1;
      }
      if (isChangeFindingResult(result)) {
        totals.reads += count(result.reads);
        totals.changes += count(result.changes);
        totals.labelVersions += count(result.labelVersions);
        if (count(result.labelVersions) > 0) {
          totals.appsWithHistory += 1;
        }
      }
      next.appTotals = totals;
      next.appsFailed = (prev.appsFailed ?? 0) + (ev.error ? 1 : 0);
      next.readingDone = (prev.readingDone ?? 0) + (noArchive ? 0 : 1);
      next.readingInFlight = false;
      next.inFlightAppId = null;
      next.waitingUntil = null;
      next.waitReason = null;
      return next;
    }
    case "phase": {
      const phase = parsePhase(ev.phase);
      if (!(prev && phase)) {
        return prev;
      }
      return { ...prev, phase, waitingUntil: null, waitReason: null };
    }
    case "survey-app": {
      if (!prev) {
        return prev;
      }
      const index = finite(ev.index);
      const total = finite(ev.total);
      const appId = text(ev.appId);
      const noArchiveIds = prev.noArchiveIds ?? [];
      const surveyed = prev.surveyDone ?? 0;
      return {
        ...prev,
        phase: "survey",
        surveyDone:
          index === null ? surveyed + 1 : Math.max(surveyed, index + 1),
        surveyTotal: total !== null && total > 0 ? total : prev.surveyTotal,
        currentAppName: text(ev.name) ?? prev.currentAppName,
        noArchiveIds:
          appId &&
          finite(ev.captureCount) === 0 &&
          !noArchiveIds.includes(appId)
            ? [...noArchiveIds, appId]
            : noArchiveIds,
        waitingUntil: null,
        waitReason: null,
      };
    }
    case "survey-done":
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        phase: "reading",
        survey: parseWaybackSurvey(ev.survey) ?? prev.survey ?? null,
        estimate: parseWaybackEstimate(ev.estimate) ?? prev.estimate ?? null,
        currentAppName: null,
        waitingUntil: null,
        waitReason: null,
      };
    case "waiting": {
      const until = finite(ev.until);
      if (!(prev && until !== null && until > 0)) {
        return prev;
      }
      return {
        ...prev,
        waitingUntil: until,
        waitReason: text(ev.reason),
        currentAppName: text(ev.name) ?? prev.currentAppName,
      };
    }
    case "estimate": {
      const estimate = parseWaybackEstimate(ev.estimate);
      return prev && estimate ? { ...prev, estimate } : prev;
    }
    case "summary":
    case "paused":
    case "cancelled": {
      // The server's own totals replace what the stream added up.
      const totals = parseWaybackAppTotals(ev.totals);
      return prev && totals ? { ...prev, appTotals: totals } : prev;
    }
    default:
      return prev;
  }
}

/** The run line's lead, or null for the pre-redesign "Importing n of N". */
export type WaybackLead =
  | { key: "phase_survey"; values: { current: number; total: number } }
  | { key: "phase_reading"; values: { current: number; total: number } };

/**
 * "Checking the archive index: 37 of 201 apps" / "Reading archived
 * pages: 12 of 143 apps". Like the old "Importing n of N", `current` is
 * the app being worked on, so it counts the one in flight.
 */
export function waybackLead(
  progress: WaybackLiveProgress | null
): WaybackLead | null {
  if (!progress?.phase) {
    return null;
  }
  if (progress.phase === "survey") {
    const total = progress.surveyTotal || progress.total;
    if (!(total > 0)) {
      return null;
    }
    const done = Math.min(progress.surveyDone ?? 0, total);
    return {
      key: "phase_survey",
      values: { current: done < total ? done + 1 : total, total },
    };
  }
  // Exact from the queue when the payload carried it, else what the survey
  // found, else the queue less the apps known to have no archived pages.
  const noArchive =
    progress.appTotals?.appsNoArchive ?? progress.noArchiveIds?.length ?? 0;
  const total =
    progress.readingTotal ??
    progress.survey?.appsWithCaptures ??
    Math.max(0, progress.total - noArchive);
  if (!(total > 0)) {
    return null;
  }
  const current =
    (progress.readingDone ?? 0) + (progress.readingInFlight ? 1 : 0);
  return {
    key: "phase_reading",
    values: { current: Math.min(current, total), total },
  };
}

/** "143 apps have archived pages, 58 have none", once the survey is done. */
export type WaybackSurveyLine =
  | {
      key: "survey_result";
      values: { withPages: number; withoutPages: number };
    }
  | { key: "survey_result_none"; values: { count: number } };

export function waybackSurveyLine(
  progress: WaybackLiveProgress | null
): WaybackSurveyLine | null {
  const survey = progress?.survey;
  if (
    !survey ||
    (survey.completedAt === null && progress?.phase !== "reading")
  ) {
    return null;
  }
  if (survey.appsWithCaptures === 0) {
    const apps = survey.appsWithoutCaptures || survey.appsSurveyed;
    return apps > 0
      ? { key: "survey_result_none", values: { count: apps } }
      : null;
  }
  return {
    key: "survey_result",
    values: {
      withPages: survey.appsWithCaptures,
      withoutPages: survey.appsWithoutCaptures,
    },
  };
}

/** Epoch timestamps are larger than any duration the runner can report. */
const EPOCH_FLOOR_MS = 1_000_000_000_000;

/**
 * The time left, in ms, while the run reads pages. `etaMs` is the time
 * left; should it arrive as a finish time instead, it is told apart by
 * size (no duration reaches 2001 in epoch terms). With no `etaMs`, the
 * reads left at the runner's pace stand in. Null when there is nothing
 * to estimate.
 */
export function waybackEtaMs(
  progress: WaybackLiveProgress | null,
  now: number = Date.now()
): number | null {
  const estimate = progress?.estimate;
  if (!estimate || progress?.phase !== "reading") {
    return null;
  }
  if (estimate.readsRemaining <= 0 && estimate.etaMs === null) {
    return null;
  }
  let ms = estimate.etaMs;
  if (ms !== null && ms >= EPOCH_FLOOR_MS) {
    ms -= now;
  }
  if (ms === null && estimate.perMinute) {
    ms = (estimate.readsRemaining / estimate.perMinute) * 60_000;
  }
  return ms !== null && ms > 0 ? ms : null;
}

/** When the runner resumes, while it is waiting out archive.org. */
export function waybackWaitUntil(
  progress: WaybackLiveProgress | null,
  now: number = Date.now()
): number | null {
  const until = progress?.waitingUntil;
  return typeof until === "number" && until > now ? until : null;
}

/** The live tally in apps and label changes, or null for the old one. */
export interface WaybackAppTally {
  appsFailed: number;
  changes: number;
  reads: number;
}

export function waybackAppTally(
  progress: WaybackLiveProgress | null
): WaybackAppTally | null {
  if (!progress?.appTotals) {
    return null;
  }
  return {
    changes: progress.appTotals.changes,
    reads: progress.appTotals.reads,
    appsFailed: progress.appsFailed ?? 0,
  };
}

/** The activity rows the card reads its "Last run" block from. */
interface ActivityRowLike {
  detail?: { mode?: unknown; removed?: unknown } | null;
}

/**
 * The newest batch-summary row: `mode: 'bulk'` for a run someone
 * started, `'bulk-resumed'` for one the server resumed after a restart.
 * A purge writes a `bulk` row too, flagged `removed`, which never counts.
 */
export function pickWaybackLastRunRow<T extends ActivityRowLike>(
  rows: readonly T[]
): T | null {
  return (
    rows.find(
      (row) =>
        (row.detail?.mode === "bulk" || row.detail?.mode === "bulk-resumed") &&
        !row.detail?.removed
    ) ?? null
  );
}

/** What a finished run's summary line says, in apps or in checkpoints. */
export type WaybackRunSummary =
  | {
      kind: "apps";
      appsDone: number;
      appsNoArchive: number;
      changes: number;
    }
  | { kind: "legacy" };

export function waybackRunSummary(totals: unknown): WaybackRunSummary {
  const apps = parseWaybackAppTotals(totals);
  return apps
    ? {
        kind: "apps",
        appsDone: apps.appsDone,
        appsNoArchive: apps.appsNoArchive,
        changes: apps.changes,
      }
    : { kind: "legacy" };
}

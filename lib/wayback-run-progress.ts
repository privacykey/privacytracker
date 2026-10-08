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

/**
 * What the survey found, as `state.survey` and the `survey-done` frame
 * carry it. `completedAt` is null while the survey is still running.
 * `appsSurveyed` includes apps whose listing failed, which are neither
 * with nor without captures.
 */
export interface WaybackSurvey {
  appsSurveyed: number;
  appsWithCaptures: number;
  appsWithoutCaptures: number;
  capturesTotal: number;
  completedAt: number | null;
  estimatedReads: number;
}

/** The runner's estimate, recomputed at every reading-phase app boundary. */
export interface WaybackEstimate {
  /** Time left, in ms. */
  etaMs: number | null;
  perMinute: number | null;
  readsDone: number;
  readsRemaining: number;
}

/**
 * The run's totals in apps and label changes (v3 keys on `totals`).
 * `appsDone` counts every app finished (no archived pages and failed
 * listings included), `appsRead` only those finished in the reading
 * phase, which ends at the survey's `appsWithCaptures`.
 */
export interface WaybackAppTotals {
  appsDone: number;
  /** Apps whose archived history starts late (P5), present only once the
   *  runner reports it or the stream has seen one. */
  appsHistoryLate?: number;
  appsNoArchive: number;
  appsRead: number;
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
  /** Apps that failed outright: a listing the survey could not read, or
   *  an app whose reading threw. Throttling is never a failure. */
  appsFailed?: number;
  appTotals?: WaybackAppTotals | null;
  estimate?: WaybackEstimate | null;
  phase?: WaybackPhase | null;
  /** Apps finished in the reading phase (`totals.appsRead`). */
  readingDone?: number;
  /** Whether an app is being read right now. */
  readingInFlight?: boolean;
  survey?: WaybackSurvey | null;
  /** Apps the survey has passed so far, and how many it will pass. */
  surveyDone?: number;
  surveyTotal?: number;
  /** Stream bookkeeping: apps the survey says will not be read (no
   *  captures, or a listing that failed). */
  unreadIds?: string[];
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

const APP_TOTAL_KEYS = [
  "appsDone",
  "appsHistoryLate",
  "appsRead",
  "appsWithHistory",
  "appsNoArchive",
  "reads",
  "changes",
  "labelVersions",
] as const;

/** The v3 totals keys, or null when `totals` predates them (Node). */
export function parseWaybackAppTotals(raw: unknown): WaybackAppTotals | null {
  if (!(isObject(raw) && APP_TOTAL_KEYS.some((k) => finite(raw[k]) !== null))) {
    return null;
  }
  const totals: WaybackAppTotals = {
    appsDone: count(raw.appsDone),
    appsRead: count(raw.appsRead),
    appsWithHistory: count(raw.appsWithHistory),
    appsNoArchive: count(raw.appsNoArchive),
    reads: count(raw.reads),
    changes: count(raw.changes),
    labelVersions: count(raw.labelVersions),
  };
  if (finite(raw.appsHistoryLate) !== null) {
    totals.appsHistoryLate = count(raw.appsHistoryLate);
  }
  return totals;
}

/**
 * The redesign's fields from a `GET /api/wayback/import-all` payload:
 * `state` is the persisted blob's projection (v3 keys optional, never the
 * queue), `summary` the server's queue counts. Reading progress is
 * `totals.appsRead`; the queue counts less the apps with no archived
 * pages stand in only for totals without it.
 */
export function parseWaybackRunExtras(
  state: unknown,
  summary: unknown
): WaybackRunExtras {
  const s = isObject(state) ? state : {};
  const sum = isObject(summary) ? summary : {};
  const survey = parseWaybackSurvey(s.survey);
  const appTotals = parseWaybackAppTotals(s.totals);
  const appsRead = isObject(s.totals) ? finite(s.totals.appsRead) : null;
  const waitingUntil = finite(s.waitingUntil);
  return {
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
    readingDone:
      appsRead === null
        ? Math.max(
            0,
            count(sum.done) +
              count(sum.failed) -
              (appTotals?.appsNoArchive ?? 0)
          )
        : Math.max(0, appsRead),
    readingInFlight: count(sum.inProgress) > 0,
  };
}

function zeroAppTotals(): WaybackAppTotals {
  return {
    appsDone: 0,
    appsRead: 0,
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

/**
 * 1 when a frame reports an app that failed outright, else 0: a
 * `survey-app` whose listing could not be read (it carries an `error`
 * and is never read), or an `app-done` whose reading threw.
 */
export function waybackFailedAppsInFrame(event: unknown): number {
  if (!isObject(event)) {
    return 0;
  }
  if (event.type === "survey-app") {
    return text(event.error) === null ? 0 : 1;
  }
  return event.type === "app-done" && event.error ? 1 : 0;
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
 *
 * Apps with no captures and apps whose listing failed finish during the
 * survey, with no `app-start` or `app-done`; their `survey-app` frame is
 * where they are counted. The stream counts `appsDone`, `appsNoArchive`,
 * `appsRead`, `reads`, `changes` and `labelVersions`; the closing frame's
 * totals replace them all.
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
        next.readingInFlight = !(prev.unreadIds ?? []).includes(
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
      const totals = { ...(prev.appTotals ?? zeroAppTotals()) };
      // An app the survey already finished is not counted twice.
      if (!(prev.unreadIds ?? []).includes(String(ev.appId ?? ""))) {
        totals.appsDone += 1;
        totals.appsRead += 1;
      }
      if (isChangeFindingResult(result)) {
        totals.reads += count(result.reads);
        totals.changes += count(result.changes);
        totals.labelVersions += count(result.labelVersions);
      }
      if (result?.historyStartsLate === true) {
        totals.appsHistoryLate = (totals.appsHistoryLate ?? 0) + 1;
      }
      next.appTotals = totals;
      next.appsFailed = (prev.appsFailed ?? 0) + waybackFailedAppsInFrame(ev);
      next.readingDone = totals.appsRead;
      next.readingInFlight = false;
      next.waitingUntil = null;
      next.waitReason = null;
      return next;
    }
    case "phase": {
      const phase = parsePhase(ev.phase);
      if (!(prev && phase)) {
        return prev;
      }
      // A phase means the redesigned runner: count in apps from here on.
      return {
        ...prev,
        phase,
        appTotals: prev.appTotals ?? zeroAppTotals(),
        waitingUntil: null,
        waitReason: null,
      };
    }
    case "survey-app": {
      if (!prev) {
        return prev;
      }
      const index = finite(ev.index);
      const total = finite(ev.total);
      const appId = text(ev.appId);
      const unreadIds = prev.unreadIds ?? [];
      const surveyed = prev.surveyDone ?? 0;
      const failedListing = waybackFailedAppsInFrame(ev) === 1;
      const noCaptures = finite(ev.captureCount) === 0;
      const totals = { ...(prev.appTotals ?? zeroAppTotals()) };
      let appsFailed = prev.appsFailed ?? 0;
      let nextUnread = unreadIds;
      if (
        (failedListing || noCaptures) &&
        !(appId && unreadIds.includes(appId))
      ) {
        // Finished here: never read.
        totals.appsDone += 1;
        totals.appsNoArchive += noCaptures ? 1 : 0;
        appsFailed += failedListing ? 1 : 0;
        nextUnread = appId ? [...unreadIds, appId] : unreadIds;
      }
      return {
        ...prev,
        phase: "survey",
        surveyDone:
          index === null ? surveyed + 1 : Math.max(surveyed, index + 1),
        surveyTotal: total !== null && total > 0 ? total : prev.surveyTotal,
        currentAppName: text(ev.name) ?? prev.currentAppName,
        unreadIds: nextUnread,
        appTotals: totals,
        appsFailed,
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
        appTotals: prev.appTotals ?? zeroAppTotals(),
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
      // The server's own totals replace what the stream added up, except
      // a late-start count the runner does not report.
      const totals = parseWaybackAppTotals(ev.totals);
      if (!(prev && totals)) {
        return prev;
      }
      const late = totals.appsHistoryLate ?? prev.appTotals?.appsHistoryLate;
      if (late !== undefined) {
        totals.appsHistoryLate = late;
      }
      return { ...prev, appTotals: totals };
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
  // The apps the survey found pages for; a run resumed from before the
  // survey existed reads its whole queue.
  const total =
    progress.survey?.appsWithCaptures ??
    Math.max(0, progress.total - (progress.appTotals?.appsNoArchive ?? 0));
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

/** "143 apps have archived pages, 58 have none", once the survey is done.
 *  `failed` counts listings archive.org could not give. */
export type WaybackSurveyLine =
  | {
      key: "survey_result";
      values: { failed: number; withPages: number; withoutPages: number };
    }
  | { key: "survey_result_none"; values: { count: number; failed: number } };

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
  const failed = Math.max(
    0,
    survey.appsSurveyed - survey.appsWithCaptures - survey.appsWithoutCaptures
  );
  if (survey.appsWithCaptures === 0) {
    return survey.appsWithoutCaptures > 0 || failed > 0
      ? {
          key: "survey_result_none",
          values: { count: survey.appsWithoutCaptures, failed },
        }
      : null;
  }
  return {
    key: "survey_result",
    values: {
      withPages: survey.appsWithCaptures,
      withoutPages: survey.appsWithoutCaptures,
      failed,
    },
  };
}

/**
 * The time left, in ms, while the run reads pages: the runner's `etaMs`,
 * or the reads left at its pace when that is missing. Null when there is
 * nothing to estimate.
 */
export function waybackEtaMs(
  progress: WaybackLiveProgress | null
): number | null {
  const estimate = progress?.estimate;
  if (!estimate || progress?.phase !== "reading") {
    return null;
  }
  let ms = estimate.etaMs;
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

/**
 * The live tally: in apps and label changes on the redesigned runner,
 * nothing at all while its survey runs (no page has been read yet), and
 * the old checkpoint counts otherwise.
 */
export type WaybackTally =
  | { kind: "legacy" }
  | { kind: "none" }
  | { kind: "apps"; appsFailed: number; changes: number; reads: number };

export function waybackTally(
  progress: WaybackLiveProgress | null
): WaybackTally {
  if (progress?.phase === "survey") {
    return { kind: "none" };
  }
  if (!progress?.appTotals) {
    return { kind: "legacy" };
  }
  return {
    kind: "apps",
    changes: progress.appTotals.changes,
    reads: progress.appTotals.reads,
    appsFailed: progress.appsFailed ?? 0,
  };
}

/**
 * Apps whose archived history starts late (P5): each can be checked on its
 * own page, where an older App Store address can be added. Null when the
 * count is zero or unknown (the runner predates coverage).
 */
export function waybackLateStartApps(
  totals: WaybackAppTotals | null | undefined
): number | null {
  const late = totals?.appsHistoryLate;
  return typeof late === "number" && late > 0 ? late : null;
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

"use client";

/**
 * ShortlistView — the /dashboard/shortlist page.
 *
 * Purpose: review every alternative the user has stashed while comparing
 * tracked apps against App Store candidates. Entries are grouped by source
 * app ("Alternatives to Uber", "Alternatives to Strava", …) so a dense
 * shortlist still reads at a glance.
 *
 * Three main affordances per row:
 *   - Open App Store link (external, `target="_blank"`)
 *   - Preview inside a side drawer — calls /api/preview for a fresh, non-
 *     persisting scrape and renders privacy labels + the developer policy
 *     link, the same signal the tracked-app detail page leads with.
 *   - Remove from shortlist — DELETE /api/shortlist.
 *
 * Toolbar actions (page-level):
 *   - Download .md     → /api/shortlist/export?format=md (triggers download)
 *   - Print / PDF       → window.print(); page uses .shortlist-print class
 *                         to hide chrome and lay the groups out continuously.
 */

import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PrivacyTypeSnapshot } from "../../lib/changelog-types";
import {
  categoryLabel as i18nCategoryLabel,
  localiseBadgeDescription,
  localiseBadgeLabel,
} from "../../lib/i18n-meta";
import { formatPriceLine, priceTooltip } from "../../lib/price-display";
import { CATEGORY_META, SEVERITY_CONFIG } from "../../lib/privacy-meta";
import type {
  AppProfileBadge,
  AppProfileFootprint,
  PrivacyProfile,
  ProfileMismatchResult,
  ProfileTier,
} from "../../lib/privacy-profile";
import {
  computeProfileMismatch,
  describeWorstMismatchLocalised,
  summariseBadge,
  TIER_META,
  TIER_RANK,
  TYPE_IDENTIFIER_TO_TIER,
} from "../../lib/privacy-profile";
import type { ShortlistEntry, ShortlistGroup } from "../../lib/shortlist-types";
import AccessibilityFigureGlyph from "./AccessibilityFigureGlyph";
import { SocialShareModal } from "./SocialShareModal";
import { useTaskCenter } from "./TaskCenter";

/**
 * Per-surface flag state for the shortlist view. All `flag.shortlist.*`
 * keys are resolved server-side and projected into this object so the
 * client component never has to hit the resolver. Missing flags fall back
 * to `true` so legacy callers (none after wave I) stay rendering as
 * before.
 */
export interface ShortlistFlagState {
  actionsExport: boolean;
  actionsPreview: boolean;
  actionsPrint: boolean;
  actionsRemove: boolean;
  actionsReset: boolean;
  actionsShare: boolean;
  actionsUndo: boolean;
  detailedView: boolean;
  installedGrouping: boolean;
  liveBadgePrefetch: boolean;
  profileMismatchPill: boolean;
}

interface ShortlistViewProps {
  /**
   * Wave-I flag state. Pass undefined to render every surface visible
   * (legacy default). Each key flips a single button / row affordance.
   */
  flags?: ShortlistFlagState;
  initialGroups: ShortlistGroup[];
  /**
   * Currently-saved privacy profile, hydrated server-side on the page so
   * the drawer can show a match verdict without an extra round-trip when
   * the user opens a preview. `null` = no profile set; drawers fall back
   * to the generic privacy-labels view.
   */
  initialProfile: PrivacyProfile | null;
}

/**
 * Build an {@link AppProfileFootprint} from the freshly-scraped privacy
 * labels returned by /api/preview. Mirrors rowsToFootprint in
 * lib/privacy-profile-server.ts but operates on the client-facing
 * PrivacyTypeSnapshot shape instead of SQL rows so the drawer can compute
 * the match for candidates that aren't in the tracked DB.
 */
function footprintFromPreviewTypes(
  privacyTypes: PrivacyTypeSnapshot[]
): AppProfileFootprint {
  const worst: Record<string, Exclude<ProfileTier, "not_collected">> = {};
  for (const type of privacyTypes) {
    const tier = TYPE_IDENTIFIER_TO_TIER[type.identifier];
    if (!tier || tier === "not_collected") {
      continue;
    }
    for (const cat of type.categories) {
      const existing = worst[cat.identifier];
      if (!existing || TIER_RANK[tier] > TIER_RANK[existing]) {
        worst[cat.identifier] = tier as Exclude<ProfileTier, "not_collected">;
      }
    }
  }
  return { worstByCategory: worst };
}

interface PreviewPayload {
  appleId: string;
  developer: string;
  hasPrivacyDetails: number | null;
  iconUrl: string;
  name: string;
  privacyPolicyUrl: string;
  privacyTypes: PrivacyTypeSnapshot[];
  url: string;
}

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading"; entry: ShortlistEntry }
  | { kind: "ready"; entry: ShortlistEntry; preview: PreviewPayload }
  | { kind: "error"; entry: ShortlistEntry; message: string };

/**
 * Per-entry state for the inline match pill on untracked candidates.
 * Tracked candidates already ship with a server-computed `profileBadge`, so
 * this map is only populated for the `!candidateIsTracked` rows where we
 * need a live App Store scrape to know the answer.
 *
 *   - `loading` — /api/preview request is in flight
 *   - `done`    — scrape finished; `badge` is the computed verdict or null
 *                 (null = no labels parsed, or the profile is empty)
 *   - `error`   — request failed; the UI silently drops the pill rather than
 *                 blocking the row, so a rate-limited response doesn't turn
 *                 into a page-wide failure mode.
 */
type LiveBadgeEntry =
  | { kind: "loading" }
  | { kind: "done"; badge: AppProfileBadge | null }
  | { kind: "error" };
type LiveBadgeMap = Record<string, LiveBadgeEntry>;

/**
 * Format a millisecond delay as "Xm YYs" (or "YYs" when under a minute) so
 * the Task Center subtitle can show a live retry countdown that reads at a
 * glance. Values are clamped to 0 because the underlying wall clock can
 * drift fractionally past the target during a render tick.
 */
function formatRateWait(ms: number): string {
  const clamped = Math.max(0, Math.ceil(ms / 1000));
  if (clamped < 60) {
    return `${clamped}s`;
  }
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

export default function ShortlistView({
  initialGroups,
  initialProfile,
  flags,
}: ShortlistViewProps) {
  // i18n — page title only on this pass. Per-row chrome and group
  // labels stay English; tracked under the broader sweep.
  const tShortlist = useTranslations("shortlist");

  // Resolve effective flags with legacy "all-on" defaults so callers that
  // haven't been wired yet still render every affordance.
  const f: ShortlistFlagState = {
    actionsRemove: flags?.actionsRemove ?? true,
    actionsPreview: flags?.actionsPreview ?? true,
    actionsShare: flags?.actionsShare ?? true,
    actionsExport: flags?.actionsExport ?? true,
    actionsPrint: flags?.actionsPrint ?? true,
    actionsReset: flags?.actionsReset ?? true,
    actionsUndo: flags?.actionsUndo ?? true,
    detailedView: flags?.detailedView ?? true,
    liveBadgePrefetch: flags?.liveBadgePrefetch ?? true,
    profileMismatchPill: flags?.profileMismatchPill ?? true,
    installedGrouping: flags?.installedGrouping ?? true,
  };
  const taskCenter = useTaskCenter();
  const [groups, setGroups] = useState<ShortlistGroup[]>(initialGroups);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  // Profile is stable within a page life, so the server-rendered value is
  // usually all we need. We still refetch on mount in case the user just
  // edited it in another tab.
  const [profile, setProfile] = useState<PrivacyProfile | null>(initialProfile);
  useEffect(() => {
    let live = true;
    fetch("/api/privacy-profile")
      .then((r) =>
        r.ok ? (r.json() as Promise<{ profile: PrivacyProfile | null }>) : null
      )
      .then((body) => {
        if (!(live && body)) {
          return;
        }
        setProfile(body.profile);
      })
      .catch(() => {
        /* optional — keep the server-hydrated value */
      });
    return () => {
      live = false;
    };
  }, []);

  // Pull fresh groups on mount so a print-preview reload picks up new adds.
  // The server-rendered initialGroups are still used for first paint.
  //
  // When the refreshed list is entry-for-entry identical to what we already
  // have (by id), preserve the previous reference. Otherwise every mount
  // would fire a useless state change that invalidates the prefetch effect
  // — cancelling its Task Center task as "Superseded" before a redundant
  // re-run finds an empty todo list.
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/shortlist");
      if (!r.ok) {
        return;
      }
      const body = (await r.json()) as { groups?: ShortlistGroup[] };
      const nextGroups = body.groups ?? [];
      setGroups((prev) => {
        const prevIds = prev
          .flatMap((g) => g.entries.map((e) => e.id))
          .join("|");
        const nextIds = nextGroups
          .flatMap((g) => g.entries.map((e) => e.id))
          .join("|");
        return prevIds === nextIds ? prev : nextGroups;
      });
    } catch {
      /* leave previous state in place */
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── Live-badge prefetch for untracked entries ──
  // Tracked candidates already arrive with `profileBadge` populated from the
  // server (see lib/shortlist.ts → resolveCandidateBadge). Untracked ones
  // don't, because we have no DB footprint for them — but until the user
  // clicks "Preview" the row has no match signal, which is the whole
  // complaint this block fixes. We prefetch /api/preview for every untracked
  // entry once per page lifetime, compute the badge client-side using the
  // same pure helpers the drawer uses, and render the pill inline.
  //
  // Concurrency is capped at 3 so a big shortlist doesn't blow through the
  // /api/preview rate bucket (30/min, shared with /api/compare). The work
  // is surfaced via the global Task Center so the user can see progress in
  // the nav, cancel it from anywhere, and — crucially — watch a live
  // "retrying in Xm YYs" countdown when a 429 comes back (either from our
  // own rate limiter or Apple's). Errors are still swallowed per-row: we
  // drop the pill for that entry rather than raising a page-level banner,
  // because the user can still click Preview to see the full failure
  // reason.
  const [liveBadges, setLiveBadges] = useState<LiveBadgeMap>({});
  const prefetchedRef = useRef<Set<string>>(new Set());

  // ── Detailed-view state ──
  // When the user ticks the "Detailed view" checkbox next to Print, each
  // shortlist row expands to include that app's full privacy labels
  // (rendered horizontally — one row per Apple severity tier, categories
  // as inline chips). The on-screen view is the same DOM as print, so
  // window.print() just captures what the user already sees.
  //
  // `previewCache` memoises /api/preview responses so the detailed view
  // doesn't thrash the live App Store endpoint. It's populated lazily
  // from two places:
  //   1. The existing liveBadges prefetch (untracked candidates). We
  //      piggy-back on that fetch and store the full payload here.
  //   2. A dedicated effect triggered when detailedView flips on — fills
  //      in tracked candidates (which skip the liveBadges loop).
  //
  // `preparingPrint` drives a spinner on the Print button while the
  // just-in-time prefetch inside handlePrint is waiting for any rows
  // still missing from the cache.
  const [detailedView, setDetailedView] = useState(false);
  const [previewCache, setPreviewCache] = useState<
    Record<string, PreviewPayload>
  >({});
  const [preparingPrint, setPreparingPrint] = useState(false);
  // Drives the SocialShareModal. When non-null, the modal renders an
  // OG-style head-to-head PNG for that specific (group, entry) pair — so
  // if a group has three alternatives, each row has its own share button
  // that paints that particular head-to-head. `null` = modal closed.
  const [shareTarget, setShareTarget] = useState<{
    group: ShortlistGroup;
    entry: ShortlistEntry;
  } | null>(null);
  // Dedupe set for the detailed-view prefetch below — we only want to
  // attempt each entry once per page lifetime, even if the user toggles
  // the checkbox off and back on.
  const detailedPrefetchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Wave I: bail entirely when the live-badge prefetch is gated off. The
    // detailed-view prefetch below is a separate effect and stays untouched.
    if (!f.liveBadgePrefetch) {
      return;
    }
    // No profile ⇒ no badges to compute. Also bail if the profile has no
    // explicit preferences — `computeProfileMismatch` would return
    // `profileActive: false` for every row, so there's nothing to show.
    if (!profile) {
      return;
    }
    const hasAnyPref = Object.values(profile).some(
      (v) => typeof v === "string"
    );
    if (!hasAnyPref) {
      return;
    }

    const todo: ShortlistEntry[] = [];
    for (const group of groups) {
      for (const entry of group.entries) {
        if (entry.candidateIsTracked) {
          continue; // already has a badge
        }
        if (prefetchedRef.current.has(entry.id)) {
          continue; // already fetched
        }
        todo.push(entry);
      }
    }
    if (todo.length === 0) {
      return;
    }

    // Mark everything as in-flight up front so the UI immediately shows the
    // "Checking…" pill instead of a blank gap that would flicker to a badge.
    for (const entry of todo) {
      prefetchedRef.current.add(entry.id);
    }
    setLiveBadges((prev) => {
      const next: LiveBadgeMap = { ...prev };
      for (const entry of todo) {
        next[entry.id] = { kind: "loading" };
      }
      return next;
    });

    // Two separate flags: `cancelled` stops the pool for *any* reason
    // (effect cleanup OR user cancel), but `userCancelled` is the thing we
    // check at the end to decide whether to call task.complete(). The Task
    // Center already marks user-cancelled tasks as `cancelled`, so calling
    // complete('done') afterwards would incorrectly flip them back to done.
    let cancelled = false;
    let userCancelled = false;
    const abortController = new AbortController();
    const queue = [...todo];
    const CONCURRENCY = 3;

    // Shared rate-limit gate. When any worker hits a 429 it sets this to
    // the wall-clock timestamp when it's safe to try again; every worker
    // checks the gate before making its next request so the whole pool
    // pauses together rather than stampeding the server. A 1s interval
    // ticks the task subtitle so the countdown animates live in the nav.
    let pauseUntilMs = 0;
    let pauseTicker: ReturnType<typeof setInterval> | null = null;
    let completed = 0;

    const task = taskCenter.startTask({
      title: tShortlist("task_check_title"),
      subtitle: `0 of ${todo.length}`,
      kind: "scrape",
      href: "/dashboard/shortlist",
      progress: { current: 0, total: todo.length },
      onCancel: () => {
        userCancelled = true;
        cancelled = true;
        abortController.abort();
      },
    });

    const stopPauseTicker = () => {
      if (pauseTicker !== null) {
        clearInterval(pauseTicker);
        pauseTicker = null;
      }
    };

    const setRatePause = (ms: number) => {
      const target = Date.now() + Math.max(0, ms);
      // Honour the longest wait — if a second worker reports a shorter
      // retry-after while we're already paused for longer, don't shorten
      // it (and vice versa: extend if the new wait is longer).
      pauseUntilMs = Math.max(pauseUntilMs, target);
      const tick = () => {
        if (cancelled) {
          stopPauseTicker();
          return;
        }
        const remaining = pauseUntilMs - Date.now();
        if (remaining <= 0) {
          stopPauseTicker();
          // Resume: show the progress subtitle again.
          task.update({
            subtitle: `${completed} of ${todo.length}`,
          });
          return;
        }
        task.update({
          subtitle: `Rate-limited — retrying in ${formatRateWait(remaining)}`,
        });
      };
      // Fire immediately so the subtitle updates before the first interval.
      tick();
      if (pauseTicker === null && !cancelled) {
        pauseTicker = setInterval(tick, 1000);
      }
    };

    // Sleep in small slices so we exit promptly when the effect is torn
    // down or the user cancels. The pool also re-reads `pauseUntilMs` each
    // iteration, so a later 429 that extends the wait is honoured.
    const waitForRateGate = async () => {
      while (!cancelled) {
        const remaining = pauseUntilMs - Date.now();
        if (remaining <= 0) {
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(remaining, 500))
        );
      }
    };

    async function runOne(entry: ShortlistEntry): Promise<void> {
      await waitForRateGate();
      if (cancelled) {
        return;
      }
      try {
        const qs = new URLSearchParams({ url: entry.candidateStoreUrl });
        const r = await fetch(`/api/preview?${qs}`, {
          signal: abortController.signal,
        });
        if (r.status === 429) {
          // Pull retryAfterMs from the JSON body first (richer precision —
          // our server reports the exact remaining window). Fall back to
          // the Retry-After header (seconds) for robustness. Default to
          // 30s if neither is usable so we still make forward progress.
          let retryAfterMs: number | null = null;
          try {
            const body = (await r.clone().json()) as { retryAfterMs?: number };
            if (
              typeof body.retryAfterMs === "number" &&
              body.retryAfterMs > 0
            ) {
              retryAfterMs = body.retryAfterMs;
            }
          } catch {
            /* non-JSON body — fall through to header */
          }
          if (retryAfterMs === null) {
            const headerSecs = Number(r.headers.get("Retry-After"));
            if (Number.isFinite(headerSecs) && headerSecs > 0) {
              retryAfterMs = headerSecs * 1000;
            }
          }
          if (retryAfterMs === null) {
            retryAfterMs = 30_000;
          }
          if (cancelled) {
            return;
          }
          setRatePause(retryAfterMs);
          // Requeue so this entry is retried after the pause window. We
          // don't mark it as errored — the pill stays in "loading" state.
          queue.push(entry);
          return;
        }
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        const body = (await r.json()) as { preview?: PreviewPayload };
        const preview = body.preview;
        if (cancelled || !preview) {
          return;
        }
        // Cache the full preview payload so the detailed-view printout can
        // render the app's privacy labels without refetching. Marked as
        // already-prefetched so the detailed-view effect below doesn't
        // redundantly re-request this entry.
        setPreviewCache((prev) => ({ ...prev, [entry.id]: preview }));
        detailedPrefetchedRef.current.add(entry.id);
        const footprint = footprintFromPreviewTypes(preview.privacyTypes);
        const result = computeProfileMismatch(profile, footprint);
        const badge = result.profileActive ? summariseBadge(result) : null;
        setLiveBadges((prev) => ({
          ...prev,
          [entry.id]: { kind: "done", badge },
        }));
        completed += 1;
        task.setProgress(completed, todo.length);
        // Only push a fresh progress subtitle while we aren't rate-paused —
        // otherwise we'd clobber the live countdown.
        if (pauseUntilMs <= Date.now()) {
          task.update({ subtitle: `${completed} of ${todo.length}` });
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        // AbortError means the user cancelled or the effect re-ran; don't
        // log spam and don't flip the badge to error — the effect cleanup
        // handles both.
        if ((err as Error)?.name === "AbortError") {
          return;
        }
        setLiveBadges((prev) => ({ ...prev, [entry.id]: { kind: "error" } }));
      }
    }

    async function worker() {
      while (!cancelled) {
        const next = queue.shift();
        if (!next) {
          return;
        }
        await runOne(next);
      }
    }

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, todo.length) },
      worker
    );
    Promise.all(workers)
      .catch(() => {
        /* per-row errors already handled */
      })
      .finally(() => {
        stopPauseTicker();
        // User-cancel: TaskCenter already flipped status to 'cancelled'; don't
        // override it. Effect-cleanup (groups/profile changed, or navigate
        // away): mark the stale task as cancelled so it doesn't hang on the
        // "Running" list forever — a fresh run will start its own task.
        if (userCancelled) {
          return;
        }
        if (cancelled) {
          task.complete("cancelled", tShortlist("task_superseded"));
          return;
        }
        task.complete(
          "done",
          completed === todo.length
            ? `Checked ${completed} shortlist match${completed === 1 ? "" : "es"}`
            : `Checked ${completed} of ${todo.length} matches`
        );
      });

    return () => {
      cancelled = true;
      abortController.abort();
      stopPauseTicker();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- f.liveBadgePrefetch is stable per render
  }, [groups, profile, taskCenter, f.liveBadgePrefetch]);

  const totalCount = useMemo(
    () => groups.reduce((n, g) => n + g.entries.length, 0),
    [groups]
  );

  // ── Undo stack ──
  // Every destructive action pushes an UndoOp so Cmd/Ctrl+Z (dispatched as a
  // window-level `app:undo` custom event by KeyboardShortcuts.tsx) can replay
  // it by POSTing the entries back. We cap the stack at MAX_UNDO and drop
  // the oldest op once we hit it — undo is a safety net, not a full
  // version history, so unbounded memory isn't worth the complexity.
  //
  // Replay uses the entry's original (sourceAppId, candidateAppleId, …)
  // payload; the server generates a fresh id on POST, so undone rows come
  // back with a new uuid but the same user-facing content. This is fine —
  // nothing downstream cares about identity across the delete→undo boundary.
  type UndoOp =
    | { kind: "delete-one"; entry: ShortlistEntry }
    | { kind: "delete-all"; entries: ShortlistEntry[] };
  const MAX_UNDO = 20;
  const [undoStack, setUndoStack] = useState<UndoOp[]>([]);
  const [undoToast, setUndoToast] = useState<string | null>(null);

  const pushUndo = useCallback((op: UndoOp) => {
    setUndoStack((prev) => {
      const next = [...prev, op];
      // Drop oldest when we blow past the cap so the stack stays bounded.
      if (next.length > MAX_UNDO) {
        next.shift();
      }
      return next;
    });
  }, []);

  // Short-lived status line so the user sees "Restored Spotify" after hitting
  // Cmd+Z, instead of wondering whether anything happened. Auto-clears.
  const showUndoToast = useCallback((message: string) => {
    setUndoToast(message);
    window.setTimeout(() => {
      setUndoToast((current) => (current === message ? null : current));
    }, 3500);
  }, []);

  const handleRemove = useCallback(
    async (entry: ShortlistEntry) => {
      setBusyId(entry.id);
      try {
        await fetch(`/api/shortlist?id=${encodeURIComponent(entry.id)}`, {
          method: "DELETE",
        });
        pushUndo({ kind: "delete-one", entry });
        await refresh();
        // If the removed entry was open in the drawer, close it.
        setPreview((prev) =>
          prev.kind !== "idle" && prev.entry.id === entry.id
            ? { kind: "idle" }
            : prev
        );
      } finally {
        setBusyId(null);
      }
    },
    [refresh, pushUndo]
  );

  const handlePreview = useCallback(async (entry: ShortlistEntry) => {
    setPreview({ kind: "loading", entry });
    try {
      const qs = new URLSearchParams({ url: entry.candidateStoreUrl });
      const r = await fetch(`/api/preview?${qs}`);
      const body = await r.json();
      if (!r.ok) {
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      setPreview({
        kind: "ready",
        entry,
        preview: body.preview as PreviewPayload,
      });
    } catch (e) {
      setPreview({
        kind: "error",
        entry,
        message: e instanceof Error ? e.message : tShortlist("preview_failed"),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, []);

  const closePreview = useCallback(() => setPreview({ kind: "idle" }), []);

  /**
   * Cache-aware preview loader used by the SocialShareModal. Returns the
   * existing previewCache entry if we already have one (populated by the
   * liveBadges / detailed-view prefetch paths), otherwise kicks off a
   * fresh /api/preview fetch and stores the result in the cache so later
   * opens — or the detailed-view print — don't re-fetch. Resolves to null
   * on any error so the modal can render a "data pending" placeholder
   * without hanging on a never-resolving promise.
   */
  const loadPreviewForShare = useCallback(
    async (entry: ShortlistEntry) => {
      const cached = previewCache[entry.id];
      if (cached) {
        return cached;
      }
      try {
        const qs = new URLSearchParams({ url: entry.candidateStoreUrl });
        const r = await fetch(`/api/preview?${qs}`);
        if (!r.ok) {
          return null;
        }
        const body = (await r.json()) as { preview?: PreviewPayload };
        if (!body.preview) {
          return null;
        }
        setPreviewCache((prev) => ({ ...prev, [entry.id]: body.preview! }));
        return body.preview;
      } catch {
        return null;
      }
    },
    [previewCache]
  );

  // ── Detailed-view prefetch ──
  // Runs in the background whenever detailedView is on. Picks up any
  // shortlist entries that aren't yet in `previewCache` (mostly tracked
  // candidates — untracked ones are filled in by the liveBadges loop) and
  // quietly prefetches them so the "Print" action has data ready. Kept
  // intentionally simple compared to the liveBadges prefetch: no Task
  // Center integration and no rate-pause ticker, because this is a
  // best-effort warm-up — handlePrint will do a just-in-time fetch for
  // any entry the background pass missed.
  useEffect(() => {
    if (!detailedView) {
      return;
    }
    const todo: ShortlistEntry[] = [];
    for (const group of groups) {
      for (const entry of group.entries) {
        if (detailedPrefetchedRef.current.has(entry.id)) {
          continue;
        }
        detailedPrefetchedRef.current.add(entry.id);
        todo.push(entry);
      }
    }
    if (todo.length === 0) {
      return;
    }

    let cancelled = false;
    const ctrl = new AbortController();
    const queue = [...todo];

    async function fetchOne(entry: ShortlistEntry) {
      if (cancelled) {
        return;
      }
      try {
        const qs = new URLSearchParams({ url: entry.candidateStoreUrl });
        const r = await fetch(`/api/preview?${qs}`, { signal: ctrl.signal });
        if (!r.ok) {
          return;
        }
        const body = (await r.json()) as { preview?: PreviewPayload };
        if (cancelled || !body.preview) {
          return;
        }
        setPreviewCache((prev) => ({ ...prev, [entry.id]: body.preview! }));
      } catch {
        /* per-row errors silently drop — handlePrint retries if needed */
      }
    }

    async function worker() {
      while (!cancelled) {
        const next = queue.shift();
        if (!next) {
          return;
        }
        await fetchOne(next);
      }
    }

    const workers = Array.from({ length: Math.min(2, todo.length) }, worker);
    Promise.all(workers).catch(() => {
      /* per-row handled */
    });

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [detailedView, groups]);

  // Print entry point. Plain print when detailedView is off. When it's on,
  // we first make sure every entry has its preview payload in the cache
  // (filling any gaps the background prefetch missed). flushSync commits
  // the cache update synchronously so the DOM already has the detailed
  // rows rendered before window.print() snapshots the page.
  const handlePrint = useCallback(async () => {
    if (!detailedView) {
      window.print();
      return;
    }
    const allEntries = groups.flatMap((g) => g.entries);
    const missing = allEntries.filter((e) => !(e.id in previewCache));
    if (missing.length === 0) {
      window.print();
      return;
    }
    setPreparingPrint(true);
    const fetched: Record<string, PreviewPayload> = {};
    try {
      await Promise.all(
        missing.map(async (entry) => {
          try {
            const qs = new URLSearchParams({ url: entry.candidateStoreUrl });
            const r = await fetch(`/api/preview?${qs}`);
            if (!r.ok) {
              return;
            }
            const body = (await r.json()) as { preview?: PreviewPayload };
            if (body.preview) {
              fetched[entry.id] = body.preview;
            }
          } catch {
            /* best-effort — entry will render a "no labels" placeholder */
          }
        })
      );
    } finally {
      // flushSync so the new cache entries are committed to the DOM before
      // we trigger window.print(). Without it, print might fire on a DOM
      // that's still missing the rows we just fetched.
      flushSync(() => {
        setPreviewCache((prev) => ({ ...prev, ...fetched }));
        setPreparingPrint(false);
      });
      window.print();
    }
  }, [detailedView, groups, previewCache]);

  // Reset-all UI state. We gate the destructive call behind an inline
  // "Yes, clear everything" confirmation rather than a browser `confirm()`
  // dialog so the copy matches the rest of the app and the Escape key can
  // dismiss without any JS modal baggage.
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      // Snapshot the current list *before* hitting the server so Cmd+Z can
      // restore every row. We flatten across groups — the POST path re-hangs
      // each entry off its sourceAppId independently anyway.
      const snapshot = groups.flatMap((g) => g.entries);
      await fetch("/api/shortlist?all=1", { method: "DELETE" });
      if (snapshot.length > 0) {
        pushUndo({ kind: "delete-all", entries: snapshot });
      }
      await refresh();
      // Close any drawer that was showing a now-deleted entry.
      setPreview({ kind: "idle" });
    } finally {
      setResetting(false);
      setConfirmingReset(false);
    }
  }, [refresh, groups, pushUndo]);

  // Pop the top undo op and replay it by POSTing the saved entries back to
  // /api/shortlist. Each POST is idempotent by (sourceAppId, candidateAppleId),
  // so a user who undoes right after reshortlisting something new doesn't get
  // duplicate rows — the server absorbs the redundant add. Errors are logged
  // and silently skipped; the toast still fires with whatever did succeed.
  const handleUndo = useCallback(async () => {
    const target = undoStack.at(-1);
    if (!target) {
      showUndoToast(tShortlist("undo_nothing"));
      return;
    }
    // Pop immediately so rapid Cmd+Z taps march through the stack rather than
    // replaying the same op twice. Pure slice — no reducer funny business.
    setUndoStack((prev) => prev.slice(0, -1));

    const toReadd =
      target.kind === "delete-one" ? [target.entry] : target.entries;
    let restored = 0;
    for (const entry of toReadd) {
      try {
        const r = await fetch("/api/shortlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceAppId: entry.sourceAppId,
            candidateAppleId: entry.candidateAppleId,
            candidateName: entry.candidateName,
            candidateDeveloper: entry.candidateDeveloper || "",
            candidateIconUrl: entry.candidateIconUrl || "",
            candidateStoreUrl: entry.candidateStoreUrl,
            candidateBundleId: entry.candidateBundleId || "",
            note: entry.note || undefined,
          }),
        });
        if (r.ok) {
          restored += 1;
        }
      } catch {
        /* non-fatal — move on to the next entry */
      }
    }
    await refresh();
    if (target.kind === "delete-one") {
      showUndoToast(
        restored > 0
          ? `Restored “${target.entry.candidateName}”`
          : tShortlist("undo_restore_failed_one")
      );
    } else {
      showUndoToast(
        restored > 0
          ? `Restored ${restored} shortlisted app${restored === 1 ? "" : "s"}`
          : tShortlist("undo_restore_failed_all")
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [refresh, showUndoToast, undoStack]);

  // Listen for Cmd/Ctrl+Z at the window level. KeyboardShortcuts.tsx
  // dispatches `app:undo` outside of editable fields, so native text undo
  // still works when the user is typing. If the undo stack is empty we
  // still fire a toast — that's nicer than the action doing nothing with
  // no signal.
  useEffect(() => {
    const handler = () => {
      void handleUndo();
    };
    window.addEventListener("app:undo", handler);
    return () => window.removeEventListener("app:undo", handler);
  }, [handleUndo]);

  return (
    <div className="page-container shortlist-page">
      <div className="page-header shortlist-toolbar">
        <div>
          <h1 className="page-title">{tShortlist("page_title")}</h1>
          <p className="page-subtitle">
            {totalCount === 0
              ? tShortlist("subtitle_empty")
              : tShortlist("subtitle_with_counts", {
                  count: totalCount,
                  appsCount: groups.length,
                })}
          </p>
        </div>
        <div className="shortlist-toolbar-actions">
          {f.actionsExport && (
            <a
              className="btn btn-secondary"
              download
              href="/api/shortlist/export?format=md"
            >
              {tShortlist("download_md")}
            </a>
          )}
          {/* Detailed-view toggle. Styled as a pill-y checkbox label that
              sits immediately left of the Print button so the two controls
              read as a group ("print this, with detail"). The label is
              interactive — clicking anywhere on it toggles the checkbox —
              and carries a title so hover users see what "detailed" means
              without us needing an inline helper paragraph. */}
          {f.detailedView && (
            <label
              className={`shortlist-detailed-toggle${detailedView ? "is-on" : ""}`}
              title={tShortlist("detailed_toggle_title")}
            >
              <input
                checked={detailedView}
                disabled={totalCount === 0}
                onChange={(e) => setDetailedView(e.target.checked)}
                type="checkbox"
              />
              <span>{tShortlist("detailed_label")}</span>
            </label>
          )}
          {f.actionsPrint && (
            <button
              className="btn btn-secondary"
              disabled={totalCount === 0 || preparingPrint}
              onClick={() => {
                void handlePrint();
              }}
              type="button"
            >
              {preparingPrint ? (
                <>
                  <span className="spinner" /> {tShortlist("preparing")}
                </>
              ) : (
                "🖨 Print / PDF"
              )}
            </button>
          )}
          <Link className="btn btn-primary" href="/dashboard/compare">
            + Add more
          </Link>
        </div>
      </div>

      {totalCount === 0 ? (
        <div className="empty-state" style={{ padding: 32 }}>
          <div style={{ fontSize: 15, color: "var(--text)", marginBottom: 6 }}>
            {tShortlist("empty_lead")}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-2)" }}>
            {tShortlist.rich("empty_body", {
              compare: (chunks) => (
                <Link
                  className="definitions-inline-link"
                  href="/dashboard/compare"
                >
                  {chunks}
                </Link>
              ),
              shortlist: (chunks) => <strong>{chunks}</strong>,
            })}
          </div>
        </div>
      ) : (
        <div className="shortlist-groups">
          {groups.map((group) => (
            <ShortlistGroupCard
              busyId={busyId}
              detailedView={detailedView && f.detailedView}
              group={group}
              key={group.sourceApp.id}
              liveBadges={liveBadges}
              onPreview={handlePreview}
              onRemove={handleRemove}
              onShare={(g, e) => setShareTarget({ group: g, entry: e })}
              previewCache={previewCache}
              showInstalledGrouping={f.installedGrouping}
              showPreview={f.actionsPreview}
              showProfileMismatchPill={f.profileMismatchPill}
              showRemove={f.actionsRemove}
              showShare={f.actionsShare}
            />
          ))}
        </div>
      )}

      {/* Page-level reset footer. Only renders when the user actually has
          something to clear — avoids offering a destructive action on an
          already-empty page. The two-step inline confirmation keeps the
          action from being a single accidental click. Marked
          `shortlist-reset-footer` so the print stylesheet can hide it
          alongside the rest of the chrome. */}
      {f.actionsReset && totalCount > 0 && (
        <div
          aria-label={tShortlist("reset_aria")}
          className="shortlist-reset-footer"
          role="region"
        >
          {confirmingReset ? (
            <div
              aria-live="polite"
              className="shortlist-reset-confirm"
              role="alertdialog"
            >
              <span className="shortlist-reset-confirm-msg">
                {tShortlist.rich("reset_confirm_msg", {
                  count: totalCount,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </span>
              <div className="shortlist-reset-confirm-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={resetting}
                  onClick={() => setConfirmingReset(false)}
                  type="button"
                >
                  {tShortlist("reset_cancel")}
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  disabled={resetting}
                  onClick={() => void handleReset()}
                  type="button"
                >
                  {resetting ? (
                    <>
                      <span className="spinner" /> {tShortlist("clearing")}
                    </>
                  ) : (
                    tShortlist("clear_confirm")
                  )}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn btn-ghost shortlist-reset-btn"
              onClick={() => setConfirmingReset(true)}
              title={tShortlist("reset_title")}
              type="button"
            >
              <span aria-hidden="true">🗑</span>
              <span>{tShortlist("reset_label")}</span>
            </button>
          )}
        </div>
      )}

      {preview.kind !== "idle" && (
        <PreviewDrawer
          onClose={closePreview}
          profile={profile}
          state={preview}
        />
      )}

      {/* Social share modal — renders a 1200×630 OG-style PNG comparing the
          source app against the specific alternative the user clicked
          "Share" on. The trigger lives on each entry row (see
          ShortlistEntryRow), so groups with multiple alternatives produce
          a distinct image per head-to-head. Uses the same previewCache
          that drives the detailed view so opening the modal is cheap when
          the user has already scrolled through detailed rows. */}
      {shareTarget && (
        <SocialShareModal
          entry={shareTarget.entry}
          group={shareTarget.group}
          loadPreview={loadPreviewForShare}
          onClose={() => setShareTarget(null)}
        />
      )}

      {/* Undo toast — pops up after Cmd/Ctrl+Z replays a delete-one or
          delete-all op. Auto-clears itself after ~3.5s via showUndoToast's
          setTimeout. `role="status"` + `aria-live="polite"` so it's
          announced without stealing focus; the polite channel is correct
          because the action already completed. Hidden in print. */}
      {f.actionsUndo && undoToast && (
        <div aria-live="polite" className="shortlist-undo-toast" role="status">
          {undoToast}
        </div>
      )}
    </div>
  );
}

function ShortlistGroupCard({
  group,
  busyId,
  onRemove,
  onPreview,
  onShare,
  liveBadges,
  detailedView,
  previewCache,
  showRemove,
  showPreview,
  showShare,
  showProfileMismatchPill,
  showInstalledGrouping,
}: {
  group: ShortlistGroup;
  busyId: string | null;
  onRemove: (entry: ShortlistEntry) => void;
  onPreview: (entry: ShortlistEntry) => void;
  /**
   * Fired when the user clicks the per-row Share button. The card passes
   * both `group` and `entry` up so ShortlistView can paint an image
   * specific to that head-to-head — not just "this group's top
   * alternative". That's how a group with three alternatives produces
   * three distinct share images.
   */
  onShare: (group: ShortlistGroup, entry: ShortlistEntry) => void;
  liveBadges: LiveBadgeMap;
  detailedView: boolean;
  previewCache: Record<string, PreviewPayload>;
  showRemove: boolean;
  showPreview: boolean;
  showShare: boolean;
  showProfileMismatchPill: boolean;
  showInstalledGrouping: boolean;
}) {
  const tShortlist = useTranslations("shortlist");
  // Split the group's entries into "Installed" (tracked candidates — apps the
  // user already has in their library) and "Not installed" (App Store
  // previews). Keeping them as two sections reads more naturally than one
  // flat list: the user's own apps come up first, and alternatives they
  // haven't tried yet follow. Preserves the incoming order within each
  // bucket so the timeline-ish feel ("most recently shortlisted at the
  // bottom") isn't lost.
  const installed: ShortlistEntry[] = [];
  const notInstalled: ShortlistEntry[] = [];
  for (const entry of group.entries) {
    if (entry.candidateIsTracked) {
      installed.push(entry);
    } else {
      notInstalled.push(entry);
    }
  }
  // Only split visually when both buckets have rows — a group that only
  // contains tracked (or only untracked) entries stays as a single list, so
  // we don't add headings that would just look like dead chrome.
  // Wave I: collapsing the installed/notInstalled split into a single list
  // is also what `flag.shortlist.installed_grouping = off` delivers — turn
  // it off for users who find the two-section layout noisy on small lists.
  const showSections =
    showInstalledGrouping && installed.length > 0 && notInstalled.length > 0;

  const renderRow = (entry: ShortlistEntry) => (
    <ShortlistEntryRow
      busy={busyId === entry.id}
      detailedView={detailedView}
      entry={entry}
      key={entry.id}
      liveBadge={liveBadges[entry.id]}
      onPreview={onPreview}
      onRemove={onRemove}
      onShare={() => onShare(group, entry)}
      preview={previewCache[entry.id]}
      showPreview={showPreview}
      showProfileMismatchPill={showProfileMismatchPill}
      showRemove={showRemove}
      showShare={showShare}
    />
  );

  return (
    <section className="shortlist-group">
      <div className="shortlist-group-header">
        {group.sourceApp.iconUrl ? (
          <Image
            alt=""
            height={32}
            src={group.sourceApp.iconUrl}
            style={{
              width: 32,
              height: 32,
              borderRadius: 7,
              objectFit: "cover",
              flexShrink: 0,
            }}
            unoptimized
            width={32}
          />
        ) : (
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 7,
              background: "var(--bg-3)",
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="shortlist-group-title">
            {tShortlist.rich("group_title", {
              name: group.sourceApp.name,
              link: (chunks) => (
                <Link
                  className="definitions-inline-link"
                  href={`/apps/${group.sourceApp.id}`}
                >
                  {chunks}
                </Link>
              ),
            })}
          </div>
          <div className="shortlist-group-subtitle">
            {group.sourceApp.developer || "—"} · {group.entries.length} saved
            {/*
              Source app's own price + IAP next to the saved-count.
              Lets users do an at-a-glance side-by-side: "I currently
              pay $4.99 + IAP for X — does the alternative work out
              cheaper?". Kept as a quiet inline element rather than a
              chip because the source app is already the hero of the
              banner; doubling the chip count would crowd the row.
            */}
            {(() => {
              const line = formatPriceLine({
                priceFormatted: group.sourceApp.priceFormatted,
                priceCurrency: group.sourceApp.priceCurrency,
                hasIap: group.sourceApp.hasIap,
              });
              if (!line) {
                return null;
              }
              return (
                <>
                  {" · "}
                  <span
                    className="shortlist-source-price"
                    title={priceTooltip({
                      priceFormatted: group.sourceApp.priceFormatted,
                      priceCurrency: group.sourceApp.priceCurrency,
                      hasIap: group.sourceApp.hasIap,
                    })}
                  >
                    {line}
                  </span>
                </>
              );
            })()}
          </div>
        </div>
        {/* "Why you're looking for alternatives" pill — only rendered when a
            privacy profile is active AND the source app exceeds it in at
            least one category. Sits to the right of the header so users see
            the reason right next to the group title, without a separate
            banner row pushing the list down. On narrow screens it wraps
            underneath the title via flex-wrap. */}
        {showProfileMismatchPill && group.sourceApp.profileMismatch && (
          <ShortlistMismatchBanner
            appName={group.sourceApp.name}
            mismatch={group.sourceApp.profileMismatch}
          />
        )}
      </div>
      {/* Detailed-view only: surface the source app's own privacy snapshot
          so the user can compare "what MY current app collects" against each
          alternative below. Same horizontal row layout as the per-alternative
          detailed block so the eye can scan left-to-right across matching
          tiers. We key off server-hydrated snapshot rather than fetching
          live — the tracked app's DB rows are the source of truth for this
          screen. */}
      {detailedView && (
        <div className="shortlist-source-snapshot">
          <div className="shortlist-source-snapshot-label">
            {tShortlist("source_snapshot_label", {
              name: group.sourceApp.name,
            })}
          </div>
          {group.sourceApp.privacyTypes &&
          group.sourceApp.privacyTypes.length > 0 ? (
            <PrivacyLabelsStack privacyTypes={group.sourceApp.privacyTypes} />
          ) : (
            <div className="shortlist-source-snapshot-empty">
              {tShortlist("source_snapshot_empty")}
            </div>
          )}
        </div>
      )}
      {showSections ? (
        <>
          <div className="shortlist-entries-section">
            <div className="shortlist-entries-section-heading">
              <span>{tShortlist("installed")}</span>
              <span className="shortlist-entries-section-count">
                {installed.length}
              </span>
            </div>
            <div className="shortlist-entries">{installed.map(renderRow)}</div>
          </div>
          <div className="shortlist-entries-section">
            <div className="shortlist-entries-section-heading">
              <span>{tShortlist("not_installed")}</span>
              <span className="shortlist-entries-section-count">
                {notInstalled.length}
              </span>
            </div>
            <div className="shortlist-entries">
              {notInstalled.map(renderRow)}
            </div>
          </div>
        </>
      ) : (
        <div className="shortlist-entries">{group.entries.map(renderRow)}</div>
      )}
    </section>
  );
}

function ShortlistEntryRow({
  entry,
  busy,
  onRemove,
  onPreview,
  onShare,
  liveBadge,
  detailedView,
  preview,
  showRemove,
  showPreview,
  showShare,
  showProfileMismatchPill,
}: {
  entry: ShortlistEntry;
  busy: boolean;
  onRemove: (entry: ShortlistEntry) => void;
  onPreview: (entry: ShortlistEntry) => void;
  showRemove: boolean;
  showPreview: boolean;
  showShare: boolean;
  showProfileMismatchPill: boolean;
  /**
   * Opens the SocialShareModal for this specific (group, entry) pair.
   * Pre-bound by ShortlistGroupCard so the row doesn't need to know
   * which group it lives in — the parent closes over `group` when it
   * constructs the callback. Keeps this component's signature tight and
   * avoids threading `group` through every render tree.
   */
  onShare: () => void;
  /**
   * For untracked candidates only — the result of the client-side
   * /api/preview prefetch. `undefined` means "we haven't started yet", which
   * is normal on first paint for a tracked entry (we skip the prefetch) and
   * also when no privacy profile is set. `loading` is rendered as a muted
   * "Checking…" pill so the row doesn't look inert mid-scrape.
   */
  liveBadge: LiveBadgeEntry | undefined;
  /**
   * When true, render the horizontal privacy-labels block beneath the row.
   * Visible both on-screen (so the user can preview what will print) and
   * in the print stylesheet.
   */
  detailedView: boolean;
  /**
   * Cached /api/preview payload for this entry, if the prefetch has
   * populated it yet. `undefined` while the fetch is still pending — the
   * detailed block renders a muted placeholder in that state.
   */
  preview: PreviewPayload | undefined;
}) {
  const tShortlist = useTranslations("shortlist");
  const tBadge = useTranslations("profile_badge");
  // Prefer the server-computed badge when present (tracked candidates).
  // Otherwise fall back to the client-side prefetch result. Tracked rows
  // never set `liveBadge`, so there's no conflict to worry about.
  const resolvedBadge: AppProfileBadge | null =
    entry.profileBadge ??
    (liveBadge && liveBadge.kind === "done" ? liveBadge.badge : null);

  return (
    <>
      <div className={`shortlist-entry${detailedView ? "has-detailed" : ""}`}>
        {/* Entry-row icon: 40px (mid step in the 32 / 40 / 48 ladder).
          Group headers use 32 (small/inline-with-text), drawer previews
          use 48 (hero-sized). Stepping by 8 keeps the visual hierarchy
          obvious without micro-decisions per surface. */}
        {entry.candidateIconUrl ? (
          <Image
            alt=""
            height={40}
            src={entry.candidateIconUrl}
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              objectFit: "cover",
              flexShrink: 0,
            }}
            unoptimized
            width={40}
          />
        ) : (
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: "var(--bg-3)",
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="shortlist-entry-name">
            {entry.candidateName}
            {entry.candidateIsTracked && (
              <span className="shortlist-chip shortlist-chip-tracked">
                {tShortlist("tracked_chip")}
              </span>
            )}
            {/* "Saved for" badges — one per compare mode the user was in when
              they shortlisted this candidate. Privacy badges reuse the same
              severity-neutral slate palette the stats page uses for the
              privacy series; accessibility badges use the blue the a11y
              filter/chart uses. A candidate saved from both tabs renders
              both pills so the reason for shortlisting stays legible.
              Legacy rows (pre-migration) fall through as `['privacy']`. */}
            {entry.modes?.map((mode) => (
              <span
                className={`shortlist-chip shortlist-chip-mode shortlist-chip-mode-${mode}`}
                key={mode}
                title={
                  mode === "accessibility"
                    ? tShortlist("saved_a11y_compare")
                    : tShortlist("saved_privacy_compare")
                }
              >
                <span
                  aria-hidden="true"
                  style={{ display: "inline-flex", alignItems: "center" }}
                >
                  {mode === "accessibility" ? (
                    <AccessibilityFigureGlyph size={14} />
                  ) : (
                    "🔒"
                  )}
                </span>
                {mode === "accessibility"
                  ? tShortlist("chip_a11y")
                  : tShortlist("chip_privacy")}
              </span>
            ))}
            {/* Profile-match pill — reuses the same tone palette as the Apps
              grid badge so the language stays consistent. Tracked
              candidates get one from the server (entry.profileBadge).
              Untracked candidates get one from the client-side prefetch
              (liveBadge), so users see mismatches at a glance without
              opening the preview drawer. While the prefetch is in flight
              we render a muted "Checking…" placeholder so the row doesn't
              flicker from empty → badge. */}
            {showProfileMismatchPill &&
              resolvedBadge &&
              (() => {
                const localisedDescription = localiseBadgeDescription(
                  tBadge,
                  resolvedBadge
                );
                const localisedLabel = localiseBadgeLabel(
                  tBadge,
                  resolvedBadge
                );
                return (
                  <span
                    aria-label={tShortlist("privacy_profile_aria", {
                      description: localisedDescription,
                    })}
                    className={`app-card-profile-badge match-${resolvedBadge.tone}`}
                    title={localisedDescription}
                  >
                    {localisedLabel}
                  </span>
                );
              })()}
            {showProfileMismatchPill &&
              !resolvedBadge &&
              liveBadge?.kind === "loading" && (
                <span
                  aria-label={tShortlist("checking_profile_match_aria")}
                  className="shortlist-chip shortlist-chip-checking"
                >
                  Checking…
                </span>
              )}
            {/*
            Phase 2 price + IAP chip. Only renders for tracked
            candidates (the JOIN populates these fields when the
            candidate has an apps row). For untracked candidates the
            chip stays hidden — the alternative would be guessing or
            pulling iTunes lookups on render, neither of which is
            worth the latency for a row that's about to be previewed
            anyway. The tooltip explains what "IAP" means in plain
            English so non-technical recipients aren't left guessing.
          */}
            {(() => {
              const line = formatPriceLine({
                priceFormatted: entry.candidatePriceFormatted,
                priceCurrency: entry.candidatePriceCurrency,
                hasIap: entry.candidateHasIap,
              });
              if (!line) {
                return null;
              }
              return (
                <span
                  className="shortlist-chip shortlist-chip-price"
                  title={priceTooltip({
                    priceFormatted: entry.candidatePriceFormatted,
                    priceCurrency: entry.candidatePriceCurrency,
                    hasIap: entry.candidateHasIap,
                  })}
                >
                  <span aria-hidden="true">💲</span>
                  {line}
                </span>
              );
            })()}
          </div>
          <div className="shortlist-entry-developer">
            {entry.candidateDeveloper || "—"}
          </div>
        </div>
        <div className="shortlist-entry-actions">
          {showPreview && (
            <button
              aria-label={`Preview ${entry.candidateName}`}
              className="shortlist-preview-pill"
              onClick={() => onPreview(entry)}
              title={`Open a quick privacy preview for ${entry.candidateName}`}
              type="button"
            >
              <span aria-hidden="true" className="shortlist-preview-pill-icon">
                👁
              </span>
              <span>{tShortlist("preview_app")}</span>
            </button>
          )}
          {/* Per-entry social share trigger. Each alternative row gets its
            own button so a group with multiple shortlisted candidates
            produces a distinct head-to-head image per pair, rather than
            every row sharing a single top-alternative picker. Hidden in
            print via .shortlist-entry-actions display rules. */}
          {showShare && (
            <button
              aria-label={`Share comparison with ${entry.candidateName}`}
              className="btn btn-ghost btn-sm"
              onClick={onShare}
              title={`Generate a social share image comparing against ${entry.candidateName}`}
              type="button"
            >
              ↗ Share
            </button>
          )}
          <a
            className="btn btn-ghost btn-sm"
            href={entry.candidateStoreUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            App Store ↗
          </a>
          {showRemove && (
            <button
              aria-label={`Remove ${entry.candidateName} from shortlist`}
              className="btn btn-ghost btn-sm shortlist-remove-btn"
              disabled={busy}
              onClick={() => onRemove(entry)}
              type="button"
            >
              {busy ? "…" : "✕"}
            </button>
          )}
        </div>
      </div>
      {detailedView && <ShortlistEntryDetailed preview={preview} />}
    </>
  );
}

/**
 * Horizontal privacy-labels block rendered beneath each shortlist row when
 * "Detailed view" is on. Three label-rows — Tracking, Linked to you, Not
 * linked — each with their categories as inline chips. Visible both on
 * screen (so the user previews what's about to print) and in the print
 * stylesheet.
 *
 *   - `undefined` preview → "Fetching…" placeholder (background prefetch
 *     is still in flight; handlePrint will fill any remaining gaps).
 *   - Zero privacy types → subtle note explaining the empty state (either
 *     Apple says "No Details Provided" or the shelf parser couldn't find
 *     anything — mirrors the drawer's logic).
 *   - Otherwise → one row per severity tier, ordered by how Apple ranks
 *     them (tracking first, then linked, then not-linked).
 */
function ShortlistEntryDetailed({
  preview,
}: {
  preview: PreviewPayload | undefined;
}) {
  const tShortlist = useTranslations("shortlist");
  if (!preview) {
    return (
      <div className="shortlist-entry-detailed shortlist-entry-detailed--placeholder">
        Fetching privacy labels…
      </div>
    );
  }
  if (preview.privacyTypes.length === 0) {
    return (
      <div className="shortlist-entry-detailed shortlist-entry-detailed--empty">
        {preview.hasPrivacyDetails === 0
          ? tShortlist("no_details_short")
          : tShortlist("no_labels_short")}
      </div>
    );
  }
  return (
    <div className="shortlist-entry-detailed">
      <PrivacyLabelsStack privacyTypes={preview.privacyTypes} />
    </div>
  );
}

/**
 * Shared renderer for the horizontal privacy-labels stack used in both the
 * per-alternative detailed block and the source app's "currently in your
 * library" snapshot. Kept separate so those two surfaces can wrap it with
 * their own labels/placeholders without duplicating the chip-layout markup.
 */
function PrivacyLabelsStack({
  privacyTypes,
}: {
  privacyTypes: PrivacyTypeSnapshot[];
}) {
  return (
    <>
      {privacyTypes.map((type) => {
        const sev = SEVERITY_CONFIG[type.identifier];
        const sevColor =
          type.identifier === "DATA_USED_TO_TRACK_YOU"
            ? "var(--red)"
            : type.identifier === "DATA_LINKED_TO_YOU"
              ? "var(--orange)"
              : "var(--yellow)";
        return (
          <div className="shortlist-entry-detailed-row" key={type.identifier}>
            <span className="shortlist-entry-detailed-label">
              <span
                aria-hidden="true"
                className="shortlist-entry-detailed-dot"
                style={{ background: sevColor }}
              />
              <span>{sev?.label ?? type.title}</span>
            </span>
            <div className="shortlist-entry-detailed-chips">
              {type.categories.length === 0 ? (
                <span className="shortlist-entry-detailed-empty-chip">—</span>
              ) : (
                type.categories.map((cat) => {
                  const meta = CATEGORY_META[cat.identifier];
                  return (
                    <span
                      className="shortlist-entry-detailed-chip"
                      key={cat.identifier}
                    >
                      <span aria-hidden="true">{meta?.icon ?? "•"}</span>
                      <span>{meta?.label ?? cat.title}</span>
                    </span>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * Compact "why you're shortlisting" pill rendered inside the group header,
 * right-aligned, to explain which categories of the source app exceed the
 * user's saved privacy profile. Sits next to the "Alternatives to X" title
 * so the *reason* is inline with the subject, no separate banner row.
 *
 * Two lines of info:
 *   1. "Doesn't match your profile" headline (the app name is already in
 *      the group title right beside it, so we drop the repetition)
 *   2. The worst mismatch spelled out ("Location: precise (you allow
 *      approximate at most)"), with "+N more" when the app has additional
 *      mismatched categories — a compact counter rather than a chip stack,
 *      which would blow out the header width.
 *
 * Full per-category detail is still available in the detailed-view source
 * snapshot below, so this pill is intentionally summary-only. The tooltip
 * on the pill lists every mismatch so keyboard/hover users can see the
 * full set without toggling detailed view.
 */
function ShortlistMismatchBanner({
  appName,
  mismatch,
}: {
  appName: string;
  mismatch: ProfileMismatchResult;
}) {
  const tCategory = useTranslations("category");
  const tTier = useTranslations("privacy_profile_tier_short");
  const tMismatch = useTranslations("privacy_profile_mismatch_sentence");
  const tBadge = useTranslations("profile_badge");
  const top = mismatch.mismatches[0];
  // Defensive: server only attaches profileMismatch when count > 0, so `top`
  // should never be nullish here — but guard anyway so a stale-data edge case
  // can't crash the whole page.
  if (!top) {
    return null;
  }

  const headline =
    describeWorstMismatchLocalised(
      mismatch,
      (key) => i18nCategoryLabel(tCategory, key),
      (key) => tTier(key),
      (key, values) => tMismatch(key, values)
    ) ?? tBadge("mismatches_description", { count: mismatch.count });
  const tierCls = TIER_META[top.observed].severityCls;

  const remainder = mismatch.count - 1;

  // Build a plaintext tooltip enumerating every mismatch for keyboard /
  // hover users — mirrors the compare view's mismatch summary.
  const tooltip = [
    `${appName} vs your privacy profile:`,
    ...mismatch.mismatches.map((m) => {
      const label = CATEGORY_META[m.category]?.label ?? m.category;
      return `• ${label}: ${TIER_META[m.observed].shortLabel} (you allow ${TIER_META[m.allowed].shortLabel})`;
    }),
  ].join("\n");

  return (
    <div
      className={`shortlist-mismatch-banner ${tierCls}`}
      role="note"
      title={tooltip}
    >
      <span aria-hidden="true" className="shortlist-mismatch-banner-icon">
        {TIER_META[top.observed].icon}
      </span>
      <div className="shortlist-mismatch-banner-body">
        <div className="shortlist-mismatch-banner-title">
          Doesn’t match your profile
        </div>
        <div className="shortlist-mismatch-banner-headline">
          {headline}
          {remainder > 0 && (
            <span className="shortlist-mismatch-banner-more">
              {" · "}+{remainder} more
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewDrawer({
  state,
  onClose,
  profile,
}: {
  state: PreviewState;
  onClose: () => void;
  profile: PrivacyProfile | null;
}) {
  const tShortlist = useTranslations("shortlist");
  // Close on Escape — the drawer is modal-ish (overlays everything, is the
  // primary focus target), so Escape is the expected keyboard exit.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const entry = state.kind === "idle" ? null : state.entry;
  if (!entry) {
    return null;
  }

  return (
    <div
      className="shortlist-drawer-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <aside
        aria-label={`Preview of ${entry.candidateName}`}
        aria-modal="true"
        className="shortlist-drawer"
        // Stop clicks bubbling to the backdrop (which would close).
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <header className="shortlist-drawer-header">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
              flex: 1,
            }}
          >
            {/* Drawer preview icon: 48px (the hero size in the 32 / 40 / 48
                ladder — see ShortlistEntryRow above for the rationale). */}
            {entry.candidateIconUrl ? (
              <Image
                alt=""
                height={48}
                src={entry.candidateIconUrl}
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 10,
                  objectFit: "cover",
                  flexShrink: 0,
                }}
                unoptimized
                width={48}
              />
            ) : (
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 10,
                  background: "var(--bg-3)",
                  flexShrink: 0,
                }}
              />
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--text)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {entry.candidateName}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-2)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {entry.candidateDeveloper || "—"}
              </div>
            </div>
          </div>
          <button
            aria-label={tShortlist("close_preview_aria")}
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>

        <div className="shortlist-drawer-body">
          {state.kind === "loading" && (
            <div className="empty-state" style={{ padding: 24 }}>
              <span className="spinner-sm" /> Fetching live App Store data…
            </div>
          )}
          {state.kind === "error" && (
            <div
              className="empty-state"
              style={{ padding: 24, color: "var(--red)" }}
            >
              Preview failed: {state.message}
            </div>
          )}
          {state.kind === "ready" && (
            <PreviewBody
              entry={state.entry}
              preview={state.preview}
              profile={profile}
            />
          )}
        </div>

        <footer className="shortlist-drawer-footer">
          <a
            className="btn btn-primary"
            href={entry.candidateStoreUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open in App Store ↗
          </a>
        </footer>
      </aside>
    </div>
  );
}

function PreviewBody({
  preview,
  entry,
  profile,
}: {
  preview: PreviewPayload;
  entry: ShortlistEntry;
  profile: PrivacyProfile | null;
}) {
  const tShortlist = useTranslations("shortlist");
  const tBadge = useTranslations("profile_badge");
  const hasLabels = preview.privacyTypes.length > 0;
  const policyUrl = preview.privacyPolicyUrl || "";

  // Rebuild the footprint from the live preview rather than trusting the
  // stashed candidate entry — the App Store labels may have changed since
  // the user shortlisted the app, and the drawer should reflect today's
  // verdict.
  const { matchBadge, matchResult } = useMemo(() => {
    if (!(profile && hasLabels)) {
      return { matchBadge: null as AppProfileBadge | null, matchResult: null };
    }
    const footprint = footprintFromPreviewTypes(preview.privacyTypes);
    const result = computeProfileMismatch(profile, footprint);
    if (!result.profileActive) {
      return { matchBadge: null as AppProfileBadge | null, matchResult: null };
    }
    return { matchBadge: summariseBadge(result), matchResult: result };
  }, [profile, hasLabels, preview.privacyTypes]);

  return (
    <div>
      {matchBadge &&
        (() => {
          const localisedDescription = localiseBadgeDescription(
            tBadge,
            matchBadge
          );
          const localisedLabel = localiseBadgeLabel(tBadge, matchBadge);
          return (
            <div aria-live="polite" className="shortlist-match-panel">
              <div className="shortlist-match-header">
                <span
                  aria-label={tShortlist("privacy_profile_aria", {
                    description: localisedDescription,
                  })}
                  className={`app-card-profile-badge match-${matchBadge.tone}`}
                >
                  {localisedLabel}
                </span>
                <span className="shortlist-match-headline">
                  {localisedDescription}
                </span>
              </div>
              {matchResult && matchResult.mismatches.length > 0 && (
                <ul className="shortlist-match-list">
                  {matchResult.mismatches.slice(0, 5).map((m) => {
                    const catLabel =
                      CATEGORY_META[m.category]?.label ?? m.category;
                    const catIcon = CATEGORY_META[m.category]?.icon ?? "•";
                    const observed = TIER_META[m.observed];
                    const allowed = TIER_META[m.allowed];
                    return (
                      <li className="shortlist-match-row" key={m.category}>
                        <span
                          aria-hidden="true"
                          className="shortlist-match-icon"
                        >
                          {catIcon}
                        </span>
                        <span className="shortlist-match-category">
                          {catLabel}
                        </span>
                        <span className="shortlist-match-tiers">
                          <span
                            className={`shortlist-match-tier ${observed.severityCls}`}
                          >
                            {observed.shortLabel}
                          </span>
                          <span
                            aria-hidden="true"
                            className="shortlist-match-arrow"
                          >
                            ›
                          </span>
                          <span className="shortlist-match-tier shortlist-match-tier-allowed">
                            you allow {allowed.shortLabel.toLowerCase()}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                  {matchResult.mismatches.length > 5 && (
                    <li className="shortlist-match-more">
                      +{matchResult.mismatches.length - 5} more
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })()}
      {!hasLabels && (
        <div
          role="status"
          style={{
            display: "flex",
            gap: 12,
            padding: "12px 14px",
            borderRadius: 10,
            border: "1px solid rgba(255, 214, 10, 0.35)",
            background: "rgba(255, 214, 10, 0.08)",
            marginBottom: 14,
            alignItems: "flex-start",
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1.3 }}>
            ⚠️
          </span>
          <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {preview.hasPrivacyDetails === 0
                ? tShortlist("no_details_apple")
                : tShortlist("no_labels_short")}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-2)" }}>
              {preview.hasPrivacyDetails === 0
                ? tShortlist("no_details_dev")
                : tShortlist("no_section_recognised")}
            </div>
          </div>
        </div>
      )}

      {hasLabels && (
        <div style={{ marginBottom: 18 }}>
          <div className="shortlist-section-header">
            {tShortlist("section_privacy_labels")}
          </div>
          <div className="shortlist-types-list">
            {preview.privacyTypes.map((type) => {
              const sev = SEVERITY_CONFIG[type.identifier];
              const sevColor =
                type.identifier === "DATA_USED_TO_TRACK_YOU"
                  ? "var(--red)"
                  : type.identifier === "DATA_LINKED_TO_YOU"
                    ? "var(--orange)"
                    : "var(--yellow)";
              return (
                <div className="shortlist-type-card" key={type.identifier}>
                  <div className="shortlist-type-header">
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: sevColor,
                        display: "inline-block",
                      }}
                    />
                    <span>{sev?.label ?? type.title}</span>
                  </div>
                  <div className="shortlist-type-categories">
                    {type.categories.length === 0 ? (
                      <span className="shortlist-empty-inline">—</span>
                    ) : (
                      type.categories.map((cat) => {
                        const meta = CATEGORY_META[cat.identifier];
                        return (
                          <span
                            className="shortlist-category-chip"
                            key={cat.identifier}
                          >
                            <span aria-hidden="true">{meta?.icon ?? "•"}</span>
                            <span>{meta?.label ?? cat.title}</span>
                          </span>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div className="shortlist-section-header">
          {tShortlist("section_privacy_policy")}
        </div>
        {policyUrl ? (
          <a
            className="definitions-inline-link"
            href={policyUrl}
            rel="noopener noreferrer"
            style={{ wordBreak: "break-all", fontSize: 13 }}
            target="_blank"
          >
            {policyUrl}
          </a>
        ) : (
          <div style={{ fontSize: 13, color: "var(--text-3)" }}>
            Developer has not linked a privacy policy on the App Store page.
          </div>
        )}
      </div>

      {entry.note && (
        <div style={{ marginTop: 18 }}>
          <div className="shortlist-section-header">
            {tShortlist("section_your_note")}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-2)" }}>
            {entry.note}
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

/**
 * Coachmark tour — spotlight + tooltip walkthrough for the post-onboarding
 * dashboard.
 *
 * Step definitions come from lib/feature-flag-rules.ts:TOUR_STEPS. Copy
 * lives under `tour.<id>.title` / `tour.<id>.body` with `{possessive}`
 * interpolated from audience. Steps whose target isn't in the DOM are
 * dropped at runtime. Completion persists in localStorage; mid-tour state
 * persists in sessionStorage (refresh resumes, tab close cancels). Any
 * code path can dispatch `coachmark-tour:replay` to restart.
 *
 * Visual: full-viewport dark backdrop + spotlight element (outset box-
 * shadow trick) + tooltip card auto-positioned in the largest empty
 * quadrant (bottom → top → right → left fallback).
 *
 * Keyboard: Esc skips, ArrowRight/Enter advance, ArrowLeft goes back.
 */

import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Audience,
  type Modifier,
  type PrimaryGoal,
  TOUR_STEPS,
  type TourStepDef,
} from "@/lib/feature-flag-rules";

// localStorage — set on completion/dismissal. Cleared by replay events.
const COMPLETED_KEY = "coachmark_tour_done";
// sessionStorage — in-flight step index for mid-tour refresh resume.
const RESUME_KEY = "coachmark_tour_step";
// Window event for restarting the tour from anywhere.
export const COACHMARK_REPLAY_EVENT = "coachmark-tour:replay";

interface Props {
  /** Whether an AI provider is configured. Gates the `ai_summary` step. */
  aiConfigured: boolean;
  /** Active audience. Drives `{possessive}` and step inclusion. */
  audience: Audience;
  /** Hard gate from `flag.onboarding.coachmark_tour`. When false the
   *  component renders nothing and skips every effect. */
  enabled: boolean;
  /** Active goals (primary + modifiers). Drives step inclusion. */
  goals: Set<PrimaryGoal | Modifier>;
}

/**
 * Map audience to the possessive token used in `{possessive}`
 * interpolations. Translator-typed first arg keeps this locale-aware
 * via the `tour_possessive.*` i18n namespace.
 */
type PossT = (key: "self" | "loved_one" | "guardian") => string;
function possessiveFor(t: PossT, audience: Audience): string {
  return t(audience);
}

/**
 * Pick which side of the target the tooltip sits on. Prefers below, then
 * above, then right, then left, falling back when there's not enough room
 * for a 360x220 tooltip. Returns top/left clamped to the viewport.
 */
type Placement = "top" | "bottom" | "left" | "right";

interface ResolvedPlacement {
  left: number;
  side: Placement;
  top: number;
}

const TOOLTIP_W = 360;
const TOOLTIP_H_GUESS = 220;
const GAP = 14;
const VIEWPORT_PAD = 12;

function placeTooltip(rect: DOMRect): ResolvedPlacement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Available space on each side.
  const spaceBelow = vh - rect.bottom;
  const spaceAbove = rect.top;
  const spaceRight = vw - rect.right;
  const spaceLeft = rect.left;

  // Try sides in priority order.
  const sides: Placement[] = ["bottom", "top", "right", "left"];

  for (const side of sides) {
    if (side === "bottom" && spaceBelow >= TOOLTIP_H_GUESS + GAP) {
      return resolve(side, rect);
    }
    if (side === "top" && spaceAbove >= TOOLTIP_H_GUESS + GAP) {
      return resolve(side, rect);
    }
    if (side === "right" && spaceRight >= TOOLTIP_W + GAP) {
      return resolve(side, rect);
    }
    if (side === "left" && spaceLeft >= TOOLTIP_W + GAP) {
      return resolve(side, rect);
    }
  }

  // Nothing fits; centre in the viewport.
  return {
    side: "bottom",
    top: Math.max(VIEWPORT_PAD, (vh - TOOLTIP_H_GUESS) / 2),
    left: Math.max(VIEWPORT_PAD, (vw - TOOLTIP_W) / 2),
  };

  function resolve(side: Placement, r: DOMRect): ResolvedPlacement {
    let top = 0;
    let left = 0;
    if (side === "bottom") {
      top = r.bottom + GAP;
      left = r.left + r.width / 2 - TOOLTIP_W / 2;
    } else if (side === "top") {
      top = r.top - TOOLTIP_H_GUESS - GAP;
      left = r.left + r.width / 2 - TOOLTIP_W / 2;
    } else if (side === "right") {
      top = r.top + r.height / 2 - TOOLTIP_H_GUESS / 2;
      left = r.right + GAP;
    } else {
      top = r.top + r.height / 2 - TOOLTIP_H_GUESS / 2;
      left = r.left - TOOLTIP_W - GAP;
    }
    // Clamp to viewport.
    top = Math.max(
      VIEWPORT_PAD,
      Math.min(vh - TOOLTIP_H_GUESS - VIEWPORT_PAD, top)
    );
    left = Math.max(
      VIEWPORT_PAD,
      Math.min(vw - TOOLTIP_W - VIEWPORT_PAD, left)
    );
    return { side, top, left };
  }
}

export default function CoachmarkTour({
  enabled,
  audience,
  goals,
  aiConfigured,
}: Props) {
  // i18n. Step copy lives under `tour.<id>.{title,body}`; chrome (Skip,
  // Next, Back, progress) is in the same namespace. The possessive token
  // uses a sibling namespace.
  const tTour = useTranslations("tour");
  const tPoss = useTranslations("tour_possessive");

  // Mounted gate so SSR + hydration don't query the DOM.
  const [mounted, setMounted] = useState(false);
  // Distinct from `enabled` so the user can dismiss without disabling the flag.
  const [running, setRunning] = useState(false);
  // Persisted to sessionStorage on every step change for mid-tour resume.
  const [stepIndex, setStepIndex] = useState(0);
  // TOUR_STEPS filtered by audience/goals AND by in-DOM target presence.
  const [activeSteps, setActiveSteps] = useState<TourStepDef[]>([]);
  // null until measured — rendering nothing avoids a tooltip flash in the wrong place.
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [placement, setPlacement] = useState<ResolvedPlacement | null>(null);

  // Memo'd for stable identity across renders.
  const possessive = useMemo(
    () => possessiveFor(tPoss, audience),
    [tPoss, audience]
  );

  // Pure filter (no DOM access).
  const applicableSteps = useMemo(() => {
    if (!enabled) {
      return [];
    }
    return TOUR_STEPS.filter((s) =>
      s.includedWhen({ audience, goals, aiConfigured })
    );
  }, [enabled, audience, goals, aiConfigured]);

  // Re-check which applicable steps actually have an in-DOM target. Polled
  // once per second for up to 4s to give async surfaces time to attach
  // their data-tour anchors. Steps that never appear are silently dropped.
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const refreshActiveSteps = useCallback(() => {
    if (typeof document === "undefined") {
      return;
    }
    const present = applicableSteps.filter((s) =>
      document.querySelector(s.target)
    );
    setActiveSteps((prev) => {
      // Only update if the set changed — avoids flicker on every poll tick.
      if (
        prev.length === present.length &&
        prev.every((p, i) => p.id === present[i]?.id)
      ) {
        return prev;
      }
      return present;
    });
  }, [applicableSteps]);

  // ── Mount / start logic ────────────────────────────────────────
  useEffect(() => {
    setMounted(true);
  }, []);

  // Server-side completion check via /api/coachmark-state. Needed because
  // Tauri binds a fresh localhost port each boot, which invalidates
  // localStorage's per-origin scope. Tour-start blocks on `apiCheckDone`
  // so a fresh-origin launch doesn't briefly flash the tour. Fails open:
  // a fetch error still marks check-done.
  const [apiCheckDone, setApiCheckDone] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    // Same-session short-circuit — skip the round-trip.
    if (window.localStorage.getItem(COMPLETED_KEY) === "true") {
      setApiCheckDone(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/coachmark-state");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { completed?: boolean };
        if (cancelled) {
          return;
        }
        if (data.completed === true) {
          // Mirror to localStorage so synchronous checks pick it up next render.
          window.localStorage.setItem(COMPLETED_KEY, "true");
        }
      } catch (err) {
        console.warn("[coachmark] failed to read state from API:", err);
      } finally {
        if (!cancelled) {
          setApiCheckDone(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!(enabled && mounted && apiCheckDone)) {
      return;
    }
    // Skip if already completed/dismissed and no replay since.
    if (
      typeof window !== "undefined" &&
      window.localStorage.getItem(COMPLETED_KEY) === "true"
    ) {
      return;
    }
    refreshActiveSteps();
    const handle = window.setInterval(refreshActiveSteps, 800);
    const stop = window.setTimeout(() => window.clearInterval(handle), 4000);
    return () => {
      window.clearInterval(handle);
      window.clearTimeout(stop);
    };
  }, [enabled, mounted, apiCheckDone, refreshActiveSteps]);

  // Once we have steps, hydrate the resume index and start the tour.
  // Wait until activeSteps is populated at least once so the resumed
  // index isn't out of bounds. Gate on apiCheckDone for fresh Tauri launches.
  useEffect(() => {
    if (!(enabled && mounted && apiCheckDone)) {
      return;
    }
    if (activeSteps.length === 0) {
      return;
    }
    if (running) {
      return;
    }
    if (window.localStorage.getItem(COMPLETED_KEY) === "true") {
      return;
    }
    // Resume mid-flight from sessionStorage; clamp to the (possibly
    // shorter) new step list.
    const stored = window.sessionStorage.getItem(RESUME_KEY);
    let startAt = 0;
    if (stored !== null) {
      const parsed = Number.parseInt(stored, 10);
      if (Number.isFinite(parsed)) {
        startAt = Math.max(0, Math.min(activeSteps.length - 1, parsed));
      }
    }
    setStepIndex(startAt);
    setRunning(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeSteps is stable; effect fires once per tour start
  }, [enabled, mounted, activeSteps, running]);

  // Replay: dispatch COACHMARK_REPLAY_EVENT to clear and restart. Also
  // picks up `?tour=1` in the URL (used by /help/focus's replay link).
  const replayTour = useCallback(() => {
    try {
      window.localStorage.removeItem(COMPLETED_KEY);
      window.sessionStorage.removeItem(RESUME_KEY);
    } catch {
      /* private mode: storage may be inaccessible — replay still works in-memory */
    }
    // Mirror the clear to the server for fresh Tauri launches.
    fetch("/api/coachmark-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: false }),
    }).catch((err) => {
      console.warn("[coachmark] failed to persist replay reset:", err);
    });
    refreshActiveSteps();
    setStepIndex(0);
    setRunning(true);
  }, [refreshActiveSteps]);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    window.addEventListener(COACHMARK_REPLAY_EVENT, replayTour);
    return () => window.removeEventListener(COACHMARK_REPLAY_EVENT, replayTour);
  }, [mounted, replayTour]);

  // URL `?tour=1` shortcut. Read once on mount, then strip via
  // History.replaceState so the back-button doesn't re-trigger.
  useEffect(() => {
    if (!(enabled && mounted)) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("tour") !== "1") {
      return;
    }
    params.delete("tour");
    const qs = params.toString();
    const next =
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(null, "", next);
    replayTour();
  }, [enabled, mounted, replayTour]);

  // Measure the current step's target. Layout effect so we measure after
  // the DOM updates but before paint. ResizeObserver catches viewport
  // changes; scroll listener catches in-page scroll.
  const currentStep = activeSteps[stepIndex] ?? null;

  useLayoutEffect(() => {
    if (!(running && currentStep)) {
      setTargetRect(null);
      setPlacement(null);
      return;
    }
    const el = document.querySelector(currentStep.target);
    if (!el) {
      setTargetRect(null);
      setPlacement(null);
      return;
    }

    // `block: 'center'` keeps the target away from viewport edges so
    // the tooltip has room beside it.
    el.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });

    const measure = () => {
      const rect = el.getBoundingClientRect();
      setTargetRect(rect);
      setPlacement(placeTooltip(rect));
    };
    measure();

    // Re-measure on viewport changes. No rAF throttling needed.
    const onScroll = () => measure();
    const onResize = () => measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      ro.observe(document.documentElement);
    }

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [running, currentStep]);

  // Persist step index whenever it changes mid-flight.
  useEffect(() => {
    if (!running) {
      return;
    }
    try {
      window.sessionStorage.setItem(RESUME_KEY, String(stepIndex));
    } catch {
      /* noop */
    }
  }, [running, stepIndex]);

  // ── Handlers ───────────────────────────────────────────────────
  const finishTour = useCallback(() => {
    setRunning(false);
    setStepIndex(0);
    try {
      window.localStorage.setItem(COMPLETED_KEY, "true");
      window.sessionStorage.removeItem(RESUME_KEY);
    } catch {
      /* noop */
    }
    // Persist to the server so a Tauri relaunch (new origin → empty
    // localStorage) also sees the completion. Fire-and-forget.
    fetch("/api/coachmark-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    }).catch((err) => {
      console.warn("[coachmark] failed to persist completion:", err);
    });
  }, []);

  const goNext = useCallback(() => {
    setStepIndex((idx) => {
      if (idx + 1 >= activeSteps.length) {
        finishTour();
        return idx;
      }
      return idx + 1;
    });
  }, [activeSteps.length, finishTour]);

  const goBack = useCallback(() => {
    setStepIndex((idx) => Math.max(0, idx - 1));
  }, []);

  const skipTour = useCallback(() => {
    finishTour();
  }, [finishTour]);

  // Keyboard shortcuts. Bound to the document so the tour responds
  // even when focus is on the backdrop/spotlight.
  useEffect(() => {
    if (!running) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skipTour();
      } else if (
        e.key === "ArrowRight" ||
        (e.key === "Enter" && !isFormField(e.target))
      ) {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft" && stepIndex > 0) {
        e.preventDefault();
        goBack();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [running, stepIndex, goNext, goBack, skipTour]);

  // Pull focus to the tooltip container (not a button) on each step so
  // screen-reader users hear title + body before navigating controls.
  useEffect(() => {
    if (!running) {
      return;
    }
    if (!(targetRect && placement)) {
      return;
    }
    // Defer to next frame so the tooltip is mounted + positioned.
    const handle = window.requestAnimationFrame(() => {
      tooltipRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [running, stepIndex, targetRect, placement]);

  // ── Render ─────────────────────────────────────────────────────
  if (!mounted) {
    return null;
  }
  if (!running) {
    return null;
  }
  if (!currentStep) {
    return null;
  }
  if (!(targetRect && placement)) {
    return null;
  }

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === activeSteps.length - 1;
  const total = activeSteps.length;
  // Strip the "tour." prefix so we can look up `<id>.title`/`<id>.body`.
  const stepKey = currentStep.i18nKey.replace(/^tour\./, "");
  const title = tTour(`${stepKey}.title`, { possessive });
  const body = tTour(`${stepKey}.body`, { possessive });

  return (
    <div className="coachmark-tour" role="presentation">
      {/* Spotlight — outset box-shadow paints the rest of the viewport
          dark. pointer-events: none keeps the target interactive. */}
      <div
        aria-hidden="true"
        className="coachmark-spotlight"
        style={{
          top: targetRect.top - 4,
          left: targetRect.left - 4,
          width: targetRect.width + 8,
          height: targetRect.height + 8,
        }}
      />

      {/* Tooltip card. role="dialog" + aria-labelledby for screen readers.
          tabIndex=-1 lets us focus it without altering tab order. */}
      <div
        aria-label={tTour("dialog_aria")}
        aria-labelledby="coachmark-tooltip-title"
        aria-modal="false"
        className={`coachmark-tooltip coachmark-tooltip-${placement.side}`}
        ref={tooltipRef}
        role="dialog"
        style={{ top: placement.top, left: placement.left }}
        tabIndex={-1}
      >
        <div aria-live="polite" className="coachmark-tooltip-progress">
          {tTour("progress", { current: stepIndex + 1, total })}
        </div>
        <h2 className="coachmark-tooltip-title" id="coachmark-tooltip-title">
          {title}
        </h2>
        <p className="coachmark-tooltip-body">{body}</p>
        <div className="coachmark-tooltip-actions">
          <button className="coachmark-skip" onClick={skipTour} type="button">
            {tTour("skip")}
          </button>
          <div className="coachmark-tooltip-nav">
            {!isFirst && (
              <button className="coachmark-back" onClick={goBack} type="button">
                {tTour("previous")}
              </button>
            )}
            <button className="coachmark-next" onClick={goNext} type="button">
              {isLast ? tTour("finish") : tTour("next")}
            </button>
          </div>
        </div>
        <button
          aria-label={tTour("close_aria")}
          className="coachmark-tooltip-close"
          onClick={skipTour}
          type="button"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * `Enter` advances the tour except when focus is inside a form field,
 * where the keypress is meaningful to the user (submit, newline, etc.).
 */
function isFormField(target: EventTarget | null): boolean {
  if (!(target && target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  return false;
}

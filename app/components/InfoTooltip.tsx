"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useFlag } from "../../lib/feature-flags-hooks";

type TooltipSide = "top" | "right";

interface BubblePlacement {
  /** Horizontal delta (px) from the trigger's center to the bubble's center,
   *  used to nudge the caret so it still points at the trigger. */
  arrowOffset: number;
  /** 'top' means bubble sits above the trigger; 'bottom' means below. */
  flow: "top" | "bottom";
  left: number;
  top: number;
}

// Margin kept between the bubble and the viewport edge.
const VIEWPORT_MARGIN = 12;
// Max width used when measuring — kept in sync with the CSS clamp below.
const BUBBLE_MAX_WIDTH = 320;

export default function InfoTooltip({
  text,
  side = "top",
  label = "More information",
}: {
  text: string;
  side?: TooltipSide;
  label?: string;
}) {
  // Wave I: every InfoTooltip across the app reads the same global flag
  // so users with `flag.global.info_tooltips = off` (e.g. the minimal
  // accessibility profile) see a clean UI without help dots. Returning
  // null bypasses the mount entirely, which also drops the listener
  // wiring below — no perf cost when off.
  const tooltipsOn = useFlag("flag.global.info_tooltips") === "on";

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [placement, setPlacement] = useState<BubblePlacement | null>(null);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // Hover bridge (WCAG 1.4.13): the bubble is portaled with a gap below/
  // above the trigger, so closing the instant the pointer leaves the
  // trigger makes the bubble content unreachable. Instead the close is
  // scheduled with a short grace window and cancelled when the pointer
  // arrives on the bubble (or back on the trigger).
  const closeTimerRef = useRef<number | null>(null);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, 150);
  }, [cancelScheduledClose]);

  useEffect(() => cancelScheduledClose, [cancelScheduledClose]);

  // Avoid SSR mismatch: portal only renders after mount.
  useEffect(() => {
    setMounted(true);
  }, []);

  const computePlacement = useCallback((): BubblePlacement | null => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!(trigger && bubble)) {
      return null;
    }

    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const tRect = trigger.getBoundingClientRect();
    const bWidth = Math.min(bubble.offsetWidth, BUBBLE_MAX_WIDTH);
    const bHeight = bubble.offsetHeight;

    // Prefer the side the caller asked for, but flip if there isn't room.
    const spaceAbove = tRect.top;
    const spaceBelow = vh - tRect.bottom;
    const preferTop =
      side === "top" ? spaceAbove >= bHeight + VIEWPORT_MARGIN : false;
    const flow: BubblePlacement["flow"] =
      side === "top"
        ? preferTop
          ? "top"
          : spaceBelow >= bHeight + VIEWPORT_MARGIN
            ? "bottom"
            : spaceAbove >= spaceBelow
              ? "top"
              : "bottom"
        : spaceBelow >= bHeight + VIEWPORT_MARGIN
          ? "bottom"
          : "top";

    // Start centered on the trigger.
    const triggerCenterX = tRect.left + tRect.width / 2;
    let left = triggerCenterX - bWidth / 2;

    // Clamp to viewport.
    const minLeft = VIEWPORT_MARGIN;
    const maxLeft = vw - bWidth - VIEWPORT_MARGIN;
    if (left < minLeft) {
      left = minLeft;
    }
    if (left > maxLeft) {
      left = Math.max(minLeft, maxLeft);
    }

    const arrowOffset = triggerCenterX - (left + bWidth / 2);

    const GAP = 10;
    const top = flow === "top" ? tRect.top - bHeight - GAP : tRect.bottom + GAP;

    return { top, left, flow, arrowOffset };
  }, [side]);

  // Recompute on open and on scroll/resize while open.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    // Initial compute after the bubble has rendered so we can measure it.
    const next = computePlacement();
    if (next) {
      setPlacement(next);
    }

    const update = () => {
      const p = computePlacement();
      if (p) {
        setPlacement(p);
      }
    };

    // Use capture on scroll so we catch nested scroll containers.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, computePlacement]);

  // Click-outside / Escape to close.
  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (triggerRef.current?.contains(target)) {
        return;
      }
      if (bubbleRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Hooks above must run unconditionally to keep React's hook order stable.
  // Bail out here once the flag has resolved — every consumer renders the
  // tooltip inside other markup, so returning null is safe.
  if (!tooltipsOn) {
    return null;
  }

  const stopPropagation = (
    event:
      | React.MouseEvent<HTMLButtonElement>
      | React.PointerEvent<HTMLButtonElement>
      | React.FocusEvent<HTMLButtonElement>
  ) => {
    event.stopPropagation();
  };

  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    cancelScheduledClose();
    setOpen((current) => !current);
  };

  const showOnHover = (event: React.PointerEvent<HTMLButtonElement>) => {
    // Only treat fine pointers (mouse) as hover-openers; coarse pointers use tap.
    if (event.pointerType === "mouse") {
      cancelScheduledClose();
      setOpen(true);
    }
  };

  const hideOnLeave = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") {
      return;
    }
    // Keep open if focus is on the trigger (keyboard users).
    if (document.activeElement === triggerRef.current) {
      return;
    }
    // Grace window so the pointer can travel onto the bubble.
    scheduleClose();
  };

  const keepOpenOnBubbleHover = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") {
      cancelScheduledClose();
    }
  };

  const bubble =
    mounted && open ? (
      <div
        className={`info-tooltip-bubble info-tooltip-bubble--${placement?.flow ?? "top"} info-tooltip-bubble--visible`}
        id={id}
        onPointerEnter={keepOpenOnBubbleHover}
        onPointerLeave={hideOnLeave}
        ref={bubbleRef}
        role="tooltip"
        style={{
          top: placement ? placement.top : -9999,
          left: placement ? placement.left : -9999,
          // Hide while we measure (first paint) so there's no flicker.
          visibility: placement ? "visible" : "hidden",
        }}
      >
        <span
          aria-hidden="true"
          className="info-tooltip-bubble-arrow"
          style={{
            left: `calc(50% + ${placement?.arrowOffset ?? 0}px)`,
          }}
        />
        {text}
      </div>
    ) : null;

  return (
    <>
      <button
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        aria-label={label}
        className={`info-tooltip-trigger ${open ? "is-open" : ""}`}
        onBlur={(event) => {
          stopPropagation(event);
          // Give click handlers on the bubble a chance to fire first.
          setTimeout(() => {
            const active = document.activeElement;
            if (
              !(
                triggerRef.current?.contains(active) ||
                bubbleRef.current?.contains(active)
              )
            ) {
              setOpen(false);
            }
          }, 0);
        }}
        onClick={toggle}
        onFocus={(event) => {
          stopPropagation(event);
          cancelScheduledClose();
          setOpen(true);
        }}
        onPointerDown={stopPropagation}
        onPointerEnter={showOnHover}
        onPointerLeave={hideOnLeave}
        ref={triggerRef}
        type="button"
      >
        i
      </button>
      {mounted && bubble && createPortal(bubble, document.body)}
    </>
  );
}

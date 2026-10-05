"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { categoryLabel, severityLabel } from "../../lib/i18n-meta";
import { useResolvedFlag } from "../../lib/use-flag-bundle";
import { isRegistered, renderVignette } from "./vignettes/registry";
import VignetteStage from "./vignettes/VignetteStage";
import "./vignettes/data-label-hint.css";
import "./vignettes/clean-slate.css";

interface BubblePlacement {
  arrowOffset: number;
  /** True when the bubble had to be pulled back on screen, so its arrow
   *  would no longer point at the trigger. */
  clamped: boolean;
  flow: "top" | "bottom";
  left: number;
  /** Height cap for the scrolling contents, so a bubble taller than the
   *  room beside its trigger shrinks and scrolls instead of covering it. */
  scrollMaxHeight: number;
  top: number;
}

/** Grace period before a hover-opened bubble closes once the pointer
 *  leaves the trigger. Long enough to cross the GAP into the bubble and
 *  reach its link; short enough that sweeping past a card doesn't leave a
 *  bubble hanging. */
const HOVER_CLOSE_DELAY_MS = 150;

/** Below this, a bubble squeezed into the room beside its trigger is too
 *  short to use even with scrolling, and it overlaps the trigger instead.
 *  Kept low on purpose: a short bubble that scrolls is better than one that
 *  hides the focused trigger, which fails WCAG 2.4.11 at AA. A phone held
 *  sideways with the trigger mid-screen has about 150px each side; only a
 *  viewport under roughly 200px tall should ever reach the fallback. */
const MIN_FIT_HEIGHT = 80;

/** How much more room the other side must offer before an open bubble
 *  moves to it. Without this a near-tie flips the bubble on every
 *  re-placement: the trigger's hover lift (translateY(-1px), transitioned)
 *  alone shifts the measured room by a pixel. */
const FLIP_MARGIN = 24;

const VIEWPORT_MARGIN = 12;
const BUBBLE_WIDTH = 320;
const GAP = 10;

interface Props {
  /** Trigger content shown inline next to the label. Defaults to a small ✦ glyph. */
  children?: ReactNode;
  /** Apple privacy category id (e.g. `CONTACT_INFO`). */
  identifier: string;
  /** Apple severity id (e.g. `DATA_USED_TO_TRACK_YOU`). */
  severity: string;
}

/**
 * Hover/focus trigger that reveals a small skeuomorphic vignette in a
 * portal popover, explaining what a privacy data label means in lived
 * experience.
 *
 * Renders nothing (a) when the global `flag.global.label_hints` is off
 * (e.g. guardian / minimal focus), or (b) when no vignette is registered
 * for the requested (identifier, severity) pair — unknown combinations
 * silently fall back to "no hint" so callers can sprinkle
 * `<DataLabelHint>` everywhere without breaking surfaces. All 14 Apple
 * categories × 3 severities ship clean-slate vignettes today.
 *
 * The vignette animations are play-once (CSS `both` fill): the stage is
 * keyed on (identifier, severity) so re-opening the bubble — or the
 * caller switching severity, e.g. the profile editor following the
 * selected tier — remounts the SVG and replays the story.
 *
 * Pattern mirrors `InfoTooltip`: portal-mounted bubble with viewport
 * clamp + flip placement, hover-to-open on fine pointers, click-to-pin
 * for slow readers, Escape / outside click to dismiss. Unlike the tooltip,
 * the bubble holds a link (to the label definitions), so the pointer has to
 * be able to travel from the trigger into it, a click has to pin rather
 * than toggle shut, and keyboard focus has to be able to reach it even
 * though the bubble is portalled to the end of <body>. Vignette
 * animations live in `vignettes/data-label-hint.css`; the global
 * reduced-motion media rule in `app/globals.css` collapses them to a
 * static end-state automatically.
 */
export default function DataLabelHint({
  identifier,
  severity,
  children,
}: Props) {
  // Resolved from the shared `GET /api/feature-flags` bundle, NOT the
  // `useFlag` resolver hook — nothing primes that resolver's context in
  // the browser, so it always answered with the hard default ('on') and
  // an `off` focus/override rendered every hint anyway. `null` while the
  // bundle is in flight: hold the trigger back rather than paint it and
  // take it away, which is the flicker this gate exists to avoid.
  const hintsOn = useResolvedFlag("flag.global.label_hints");

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [placement, setPlacement] = useState<BubblePlacement | null>(null);
  // Whether the bubble's contents overflow their cap. When they do, the
  // scroll box becomes focusable so the keyboard can scroll it: with focus
  // on the link alone, the arrow keys don't move it, and the top of the
  // bubble can't be brought back into view (WCAG 2.1.1, and 2.1.3 at AAA).
  const [scrollable, setScrollable] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  // Interaction state that gates closing but never needs a re-render.
  //  - pinned: opened or confirmed by a click/tap; hover-leave won't close it.
  //  - justOpened: opened by hover or focus in the current gesture, so the
  //    click that follows pins it instead of toggling it straight back shut
  //    (a mouse click is pointerenter -> focus -> click; an Android tap is
  //    focus -> click).
  //  - pointerDownInBubble: Safari and iOS don't focus a link on click, so
  //    focus falls to <body> mid-click; without this the blur handler would
  //    unmount the bubble before the click lands on the link.
  //  - suppressFocusOpen: set when we hand focus back to the trigger, so its
  //    onFocus doesn't immediately re-open what was just closed.
  const pinned = useRef(false);
  const justOpened = useRef(false);
  const pointerDownInBubble = useRef(false);
  const suppressFocusOpen = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The side the open bubble is on, so re-placement keeps it there.
  const flowRef = useRef<BubblePlacement["flow"] | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const closeNow = useCallback(() => {
    cancelClose();
    pinned.current = false;
    justOpened.current = false;
    flowRef.current = null;
    setOpen(false);
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(closeNow, HOVER_CLOSE_DELAY_MS);
  }, [cancelClose, closeNow]);
  useEffect(() => cancelClose, [cancelClose]);

  const tHint = useTranslations("data_label_hint");
  const tCat = useTranslations("category");
  const tSev = useTranslations("severity");

  useEffect(() => {
    setMounted(true);
  }, []);

  const scene = renderVignette(identifier, severity);
  const registered = isRegistered(identifier, severity);
  const hasVignette = Boolean(scene && registered);
  const captionKey = `captions.${identifier.toLowerCase()}.${severity.toLowerCase()}`;

  const computePlacement = useCallback((): BubblePlacement | null => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!(trigger && bubble)) {
      return null;
    }

    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const tRect = trigger.getBoundingClientRect();
    const bWidth = Math.min(bubble.offsetWidth, BUBBLE_WIDTH);

    // The bubble's full height, measured from its scrolling contents so a
    // cap applied on an earlier pass doesn't feed back into this one.
    const scrollEl = bubble.querySelector<HTMLElement>(
      ".data-label-hint-scroll"
    );
    const chrome = scrollEl ? bubble.offsetHeight - scrollEl.clientHeight : 0;
    const natural = scrollEl
      ? scrollEl.scrollHeight + chrome
      : bubble.offsetHeight;

    const roomAbove = tRect.top - GAP - VIEWPORT_MARGIN;
    const roomBelow = vh - tRect.bottom - GAP - VIEWPORT_MARGIN;
    const room = { top: roomAbove, bottom: roomBelow };
    const kept = flowRef.current;
    let flow: BubblePlacement["flow"];
    let height: number;
    if (kept && natural <= room[kept]) {
      // Already open on a side that still fits whole: stay there.
      flow = kept;
      height = natural;
    } else if (natural <= roomAbove) {
      flow = "top";
      height = natural;
    } else if (natural <= roomBelow) {
      flow = "bottom";
      height = natural;
    } else {
      // Neither side fits the whole bubble. Take the roomier side and let
      // the contents scroll, rather than covering the trigger: with focus
      // on the trigger, covering it fails WCAG focus-not-obscured (2.4.11,
      // and 2.4.12 at AAA). An open bubble stays on its side unless the
      // other offers clearly more room: flipping under the pointer drops
      // it outside the bubble, which then closes.
      const other = kept === "top" ? "bottom" : "top";
      flow =
        kept && room[kept] + FLIP_MARGIN >= room[other]
          ? kept
          : roomAbove >= roomBelow
            ? "top"
            : "bottom";
      height = room[flow];
    }
    flowRef.current = flow;

    const triggerCenterX = tRect.left + tRect.width / 2;
    let left = triggerCenterX - bWidth / 2;
    const minLeft = VIEWPORT_MARGIN;
    const maxLeft = vw - bWidth - VIEWPORT_MARGIN;
    if (left < minLeft) {
      left = minLeft;
    }
    if (left > maxLeft) {
      left = Math.max(minLeft, maxLeft);
    }
    const arrowOffset = triggerCenterX - (left + bWidth / 2);

    if (height >= MIN_FIT_HEIGHT) {
      return {
        top: flow === "top" ? tRect.top - GAP - height : tRect.bottom + GAP,
        left,
        flow,
        arrowOffset,
        clamped: false,
        scrollMaxHeight: Math.max(0, height - chrome),
      };
    }

    // Last resort, for a trigger with too little room on either side (a
    // tiny viewport with the trigger mid-screen): keep the whole bubble on
    // screen even though it covers the trigger. It is position: fixed, so
    // any part past the viewport edge could never be scrolled to.
    const capped = Math.min(natural, vh - 2 * VIEWPORT_MARGIN);
    const preferredTop =
      flow === "top" ? tRect.top - GAP - capped : tRect.bottom + GAP;
    const maxTop = Math.max(VIEWPORT_MARGIN, vh - capped - VIEWPORT_MARGIN);
    const top = Math.min(Math.max(preferredTop, VIEWPORT_MARGIN), maxTop);
    return {
      top,
      left,
      flow,
      arrowOffset,
      clamped: Math.abs(top - preferredTop) > 0.5,
      scrollMaxHeight: Math.max(0, capped - chrome),
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const next = computePlacement();
    if (next) {
      setPlacement(next);
    }
    const update = (event?: Event) => {
      // Scrolling inside the bubble moves neither it nor its trigger, so it
      // needs no re-placement. Re-placing on it is what let a near-tie flip
      // the bubble to the other side while the pointer was in it.
      if (
        event?.target instanceof Node &&
        bubbleRef.current?.contains(event.target)
      ) {
        return;
      }
      const p = computePlacement();
      if (p) {
        setPlacement(p);
      }
    };
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, computePlacement]);

  useLayoutEffect(() => {
    if (!(open && placement)) {
      setScrollable(false);
      return;
    }
    const el = bubbleRef.current?.querySelector<HTMLElement>(
      ".data-label-hint-scroll"
    );
    setScrollable(Boolean(el && el.scrollHeight > el.clientHeight + 1));
  }, [open, placement]);

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
      closeNow();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // Escape from inside the bubble returns focus to the trigger rather
      // than dropping it on <body> when the bubble unmounts.
      if (bubbleRef.current?.contains(document.activeElement)) {
        suppressFocusOpen.current = true;
        triggerRef.current?.focus();
      }
      closeNow();
    };
    // Cleared a tick after release so the blur handler, which also defers a
    // tick, still sees the pointer as down inside the bubble.
    const handlePointerUp = () => {
      setTimeout(() => {
        pointerDownInBubble.current = false;
      }, 0);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, closeNow]);

  // Bail-out branches after all hooks so React's hook order stays stable.
  if (!(hintsOn === true && hasVignette)) {
    return null;
  }

  const categoryName = categoryLabel(tCat, identifier) ?? identifier;
  const severityName = severityLabel(tSev, severity) ?? severity;
  const triggerLabel = tHint("trigger_label");
  const popoverAria = tHint("popover_aria_label", {
    category: categoryName,
    severity: severityName,
  });

  const openFromGesture = () => {
    cancelClose();
    if (!open) {
      justOpened.current = true;
      setOpen(true);
    }
  };
  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!open) {
      // A tap or a click with no hover first (touch, Safari): open pinned.
      pinned.current = true;
      setOpen(true);
    } else if (justOpened.current) {
      // Hover or focus opened it a moment ago; this click pins it.
      justOpened.current = false;
      pinned.current = true;
    } else {
      closeNow();
    }
  };
  const showOnHover = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse") {
      openFromGesture();
    }
  };
  const hideOnLeave = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse" || pinned.current) {
      return;
    }
    // A keyboard user who opened it by focus keeps it while the mouse
    // wanders past, as before; so does anyone whose focus is inside it.
    const active = document.activeElement;
    if (triggerRef.current === active || bubbleRef.current?.contains(active)) {
      return;
    }
    scheduleClose();
  };
  const closeIfFocusLeft = () => {
    setTimeout(() => {
      if (pointerDownInBubble.current) {
        return;
      }
      const active = document.activeElement;
      if (
        triggerRef.current?.contains(active) ||
        bubbleRef.current?.contains(active)
      ) {
        return;
      }
      closeNow();
    }, 0);
  };
  // In DOM order: the scroll box (when focusable) comes before its link.
  const focusablesInBubble = () => [
    ...(bubbleRef.current?.querySelectorAll<HTMLElement>(
      '[tabindex="0"], a[href], button'
    ) ?? []),
  ];
  const firstFocusableInBubble = () => focusablesInBubble()[0];
  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    // The bubble lives at the end of <body>, so natural Tab order would
    // skip it entirely. Carry focus into it, but only once it has been
    // opened on purpose (Enter, Space or a click pins it). Tabbing straight
    // past the trigger still moves on as it always has: the profile editor
    // alone has fourteen of these in a row, and diverting every one would
    // cost a keyboard user two extra stops per row.
    if (event.key === "Tab" && !event.shiftKey && open && pinned.current) {
      const target = firstFocusableInBubble();
      if (target) {
        event.preventDefault();
        target.focus();
      }
    }
  };
  const onBubbleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    // Between the bubble's own stops (scroll box, then link), let the
    // browser move focus as usual.
    const items = focusablesInBubble();
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at >= 0 && (event.shiftKey ? at > 0 : at < items.length - 1)) {
      return;
    }
    // Tabbing out of the bubble returns to the trigger. Forward Tab also
    // closes it, so the next Tab continues through the page as normal.
    event.preventDefault();
    suppressFocusOpen.current = true;
    triggerRef.current?.focus();
    if (!event.shiftKey) {
      closeNow();
    }
  };

  const bubble =
    mounted && open ? (
      <div
        aria-label={popoverAria}
        className={`data-label-hint-bubble data-label-hint-bubble--${placement?.flow ?? "top"} data-label-hint-bubble--visible`}
        id={id}
        onBlur={closeIfFocusLeft}
        onKeyDown={onBubbleKeyDown}
        onPointerDown={() => {
          pointerDownInBubble.current = true;
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") {
            cancelClose();
          }
        }}
        onPointerLeave={hideOnLeave}
        ref={bubbleRef}
        role="dialog"
        style={{
          top: placement ? placement.top : -9999,
          left: placement ? placement.left : -9999,
          visibility: placement ? "visible" : "hidden",
        }}
      >
        {!placement?.clamped && (
          <span
            aria-hidden="true"
            className="data-label-hint-bubble-arrow"
            style={{ left: `calc(50% + ${placement?.arrowOffset ?? 0}px)` }}
          />
        )}
        {/*
          Everything but the arrow scrolls inside this box when the screen is
          shorter than the bubble: a phone held sideways, a small window, or
          a desktop zoomed to 400%. The bubble is position: fixed, so without
          it the bottom of the bubble, and the Read more link with it, sat
          past the edge of the screen where nothing could scroll to it. The
          arrow stays outside so the overflow doesn't clip it.
        */}
        <div
          aria-label={scrollable ? popoverAria : undefined}
          className="data-label-hint-scroll"
          role={scrollable ? "region" : undefined}
          style={
            placement ? { maxHeight: placement.scrollMaxHeight } : undefined
          }
          tabIndex={scrollable ? 0 : undefined}
        >
          {/*
          The scenes are concrete on purpose (a lock-screen time, a home
          address) and, on an app detail page, sit next to a named app. The
          conditional captions keep the words honest; this lip makes the
          status of the whole bubble plain at a glance, before anyone has
          read a word of the caption.
        */}
          <div className="data-label-hint-lip">{tHint("example_lip")}</div>
          {/* Keyed so a severity change (profile editor following the
            selected tier) remounts the SVG and replays the play-once
            animations from the start. */}
          <div
            className="data-label-hint-stage"
            key={`${identifier}-${severity}`}
          >
            <VignetteStage
              destination={scene?.destination}
              motif={scene?.motif}
            />
          </div>
          <div className="data-label-hint-caption">
            <span className="data-label-hint-caption-label">
              {categoryName} · {severityName}
            </span>
            {tHint(captionKey)}
            {/*
            The caption above is written conditionally ("could", "would")
            so it reads as one possibility rather than a report on this
            app. This line says what IS known: Apple's label establishes
            that the app collects this category, and nothing more — the
            fields inside it are not disclosed to anyone outside the
            developer. Concrete and actionable, rather than the meta
            "the scene is an example" framing this replaced.
          */}
            <span className="data-label-hint-not-disclosed">
              {tHint("not_disclosed", { category: categoryName })}
            </span>
          </div>
          {/*
          Lands on this category's entry in the label definitions, with
          `from` set so that page's Back button returns here. The hash is
          resolved by DefinitionsContent after mount: its body renders inside
          a Suspense boundary, so the browser's own anchor jump fires before
          the target exists.
        */}
          <div className="data-label-hint-footer">
            <Link
              className="data-label-hint-more"
              href={{
                pathname: "/help/definitions",
                query: pathname ? { from: pathname } : undefined,
                hash: `category-${identifier.toLowerCase()}`,
              }}
            >
              {tHint("read_more")}
            </Link>
          </div>
        </div>
      </div>
    ) : null;

  return (
    <>
      <button
        aria-controls={open ? id : undefined}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        aria-label={triggerLabel}
        className={`data-label-hint-trigger ${open ? "is-open" : ""}`}
        onBlur={closeIfFocusLeft}
        onClick={toggle}
        onFocus={() => {
          if (suppressFocusOpen.current) {
            suppressFocusOpen.current = false;
            return;
          }
          openFromGesture();
        }}
        onKeyDown={onTriggerKeyDown}
        onPointerEnter={showOnHover}
        onPointerLeave={hideOnLeave}
        ref={triggerRef}
        type="button"
      >
        {children ?? <span aria-hidden="true">✦</span>}
      </button>
      {mounted && bubble && createPortal(bubble, document.body)}
    </>
  );
}

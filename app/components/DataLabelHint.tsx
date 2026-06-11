"use client";

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
import { useFlag } from "../../lib/feature-flags-hooks";
import { categoryLabel, severityLabel } from "../../lib/i18n-meta";
import { isRegistered, renderVignette } from "./vignettes/registry";
import VignetteStage from "./vignettes/VignetteStage";
import "./vignettes/data-label-hint.css";
import "./vignettes/clean-slate.css";

interface BubblePlacement {
  arrowOffset: number;
  flow: "top" | "bottom";
  left: number;
  top: number;
}

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
 * Pattern mirrors `InfoTooltip` — portal-mounted bubble with viewport
 * clamp + flip placement, hover-to-open on fine pointers, click-to-pin
 * for slow readers, Escape / outside click to dismiss. Vignette
 * animations live in `vignettes/data-label-hint.css`; the global
 * reduced-motion media rule in `app/globals.css` collapses them to a
 * static end-state automatically.
 */
export default function DataLabelHint({
  identifier,
  severity,
  children,
}: Props) {
  const hintsOn = useFlag("flag.global.label_hints") === "on";

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [placement, setPlacement] = useState<BubblePlacement | null>(null);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

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
    const bHeight = bubble.offsetHeight;

    const spaceAbove = tRect.top;
    const spaceBelow = vh - tRect.bottom;
    const flow: BubblePlacement["flow"] =
      spaceAbove >= bHeight + VIEWPORT_MARGIN
        ? "top"
        : spaceBelow >= bHeight + VIEWPORT_MARGIN
          ? "bottom"
          : spaceAbove >= spaceBelow
            ? "top"
            : "bottom";

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
    const top = flow === "top" ? tRect.top - bHeight - GAP : tRect.bottom + GAP;

    return { top, left, flow, arrowOffset };
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
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
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, computePlacement]);

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

  // Bail-out branches after all hooks so React's hook order stays stable.
  if (!(hintsOn && hasVignette)) {
    return null;
  }

  const categoryName = categoryLabel(tCat, identifier) ?? identifier;
  const severityName = severityLabel(tSev, severity) ?? severity;
  const triggerLabel = tHint("trigger_label");
  const popoverAria = tHint("popover_aria_label", {
    category: categoryName,
    severity: severityName,
  });

  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen((c) => !c);
  };
  const showOnHover = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") {
      setOpen(true);
    }
  };
  const hideOnLeave = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "mouse") {
      return;
    }
    if (document.activeElement === triggerRef.current) {
      return;
    }
    setOpen(false);
  };

  const bubble =
    mounted && open ? (
      <div
        aria-label={popoverAria}
        className={`data-label-hint-bubble data-label-hint-bubble--${placement?.flow ?? "top"} data-label-hint-bubble--visible`}
        id={id}
        ref={bubbleRef}
        role="dialog"
        style={{
          top: placement ? placement.top : -9999,
          left: placement ? placement.left : -9999,
          visibility: placement ? "visible" : "hidden",
        }}
      >
        <span
          aria-hidden="true"
          className="data-label-hint-bubble-arrow"
          style={{ left: `calc(50% + ${placement?.arrowOffset ?? 0}px)` }}
        />
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
        </div>
      </div>
    ) : null;

  return (
    <>
      <button
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        aria-label={triggerLabel}
        className={`data-label-hint-trigger ${open ? "is-open" : ""}`}
        onBlur={() => {
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
        onFocus={() => setOpen(true)}
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

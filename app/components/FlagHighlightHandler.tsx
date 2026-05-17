"use client";

/**
 * Cross-page handler for the developer panel's "Show me where" link.
 * Reads `?flag-highlight=<key>` and choreographs five effects on each match
 * (`data-flag-target="<key>"` / `data-flag-key="<key>"`):
 *   1. Pulse ring class (`flag-highlight-target`)
 *   2. Smooth scroll into view
 *   3. Sonar ping (three concentric rings)
 *   4. Confetti burst from the target centre
 *   5. Off-screen edge arrow that tracks scroll until the target appears
 *
 * After ~6s the classes are cleared and the URL param is stripped so a
 * refresh doesn't re-trigger. Sonar/confetti/arrow respect
 * `prefers-reduced-motion`.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const HIGHLIGHT_DURATION_MS = 6000;
const CONFETTI_COUNT = 10;
const CONFETTI_COLORS = ["#a855f7", "#3b82f6", "#34c759", "#ff9f0a", "#ff453a"];

type ArrowDirection = "up" | "down" | "left" | "right";

interface ActiveHighlight {
  confetti: ConfettiParticle[];
  /** First match — used as the pin for the off-screen arrow. */
  el: HTMLElement;
  /** Sonar ping; CSS handles the three staggered rings via animation-delay. */
  ping: boolean;
}

interface ConfettiParticle {
  color: string;
  /** Final viewport translation in pixels. */
  dx: number;
  dy: number;
  id: number;
  rotation: number;
  /** Width × height (px). */
  size: number;
}

export default function FlagHighlightHandler() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [active, setActive] = useState<ActiveHighlight | null>(null);
  // `null` direction means the target is on-screen (no arrow).
  const [arrowDir, setArrowDir] = useState<ArrowDirection | null>(null);
  // Viewport coordinates so the arrow tracks the target as the user scrolls.
  const [arrowPos, setArrowPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });

  useEffect(() => {
    const key = searchParams?.get("flag-highlight");
    if (!key) {
      setActive(null);
      setArrowDir(null);
      return;
    }

    let cancelled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    let activeMatches: HTMLElement[] = [];
    let scrollHandler: (() => void) | null = null;

    // Defer one frame so hydration has flushed before we query.
    const raf = requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      const selector = `[data-flag-target="${cssEscape(key)}"], [data-flag-key="${cssEscape(key)}"]`;
      const matches = Array.from(
        document.querySelectorAll(selector)
      ) as HTMLElement[];
      if (matches.length === 0) {
        // Nothing to highlight; strip the param so refresh doesn't re-trigger.
        stripParam(router, pathname, searchParams);
        return;
      }
      activeMatches = matches;
      for (const el of matches) {
        el.classList.add("flag-highlight-target");
      }
      const primary = matches[0];
      primary.scrollIntoView({ behavior: "smooth", block: "center" });

      // Build the confetti bag once with stable IDs for React keys.
      const confetti: ConfettiParticle[] = Array.from(
        { length: CONFETTI_COUNT },
        (_, i) => {
          const angle =
            (Math.PI * 2 * i) / CONFETTI_COUNT + Math.random() * 0.4;
          const distance = 70 + Math.random() * 60;
          return {
            id: i,
            dx: Math.cos(angle) * distance,
            dy: Math.sin(angle) * distance,
            rotation: (Math.random() - 0.5) * 360,
            color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
            size: 6 + Math.random() * 4,
          };
        }
      );

      setActive({ el: primary, confetti, ping: true });

      // Track scroll/resize so the arrow follows the target and fades out
      // the moment the target scrolls into view.
      const updateArrow = () => {
        if (!primary.isConnected) {
          return;
        }
        const rect = primary.getBoundingClientRect();
        const placement = computeArrowPlacement(rect);
        setArrowDir(placement.dir);
        setArrowPos({ x: placement.x, y: placement.y });
      };
      updateArrow();
      scrollHandler = updateArrow;
      window.addEventListener("scroll", updateArrow, true);
      window.addEventListener("resize", updateArrow);

      cleanupTimer = setTimeout(() => {
        for (const el of activeMatches) {
          el.classList.remove("flag-highlight-target");
        }
        setActive(null);
        setArrowDir(null);
        stripParam(router, pathname, searchParams);
      }, HIGHLIGHT_DURATION_MS);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
      }
      if (scrollHandler) {
        window.removeEventListener("scroll", scrollHandler, true);
        window.removeEventListener("resize", scrollHandler);
      }
      for (const el of activeMatches) {
        el.classList.remove("flag-highlight-target");
      }
    };
  }, [pathname, searchParams, router]);

  if (!active) {
    return null;
  }

  // Position confetti + sonar ping at the target's centre via position:fixed.
  const rect = active.el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  return (
    <>
      {/* Sonar ping — three concentric rings staggered via animation-delay.
          pointer-events:none so they never block interaction. */}
      {active.ping && (
        <div
          aria-hidden="true"
          className="flag-highlight-ping"
          style={{ top: cy, left: cx }}
        >
          <span className="flag-highlight-ping-ring" />
          <span className="flag-highlight-ping-ring" />
          <span className="flag-highlight-ping-ring" />
        </div>
      )}

      {/* Confetti burst — final translation set as a CSS custom property
          so the keyframe can read it without reflow. */}
      <div
        aria-hidden="true"
        className="flag-highlight-confetti"
        style={{ top: cy, left: cx }}
      >
        {active.confetti.map((p) => (
          <span
            className="flag-highlight-confetti-piece"
            key={p.id}
            style={{
              ["--dx" as string]: `${p.dx}px`,
              ["--dy" as string]: `${p.dy}px`,
              ["--rot" as string]: `${p.rotation}deg`,
              background: p.color,
              width: `${p.size}px`,
              height: `${p.size * 0.4}px`,
            }}
          />
        ))}
      </div>

      {/* Off-screen arrow — pins to the closest viewport edge while the
          target sits outside the viewport, hides when on-screen. */}
      {arrowDir && (
        <div
          aria-hidden="true"
          className={`flag-highlight-arrow flag-highlight-arrow-${arrowDir}`}
          style={{ top: arrowPos.y, left: arrowPos.x }}
        >
          <svg
            aria-hidden="true"
            fill="none"
            height="32"
            viewBox="0 0 32 32"
            width="32"
          >
            <circle
              cx="16"
              cy="16"
              fill="var(--bg-2)"
              r="15"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M10 16 L22 16 M16 10 L22 16 L16 22"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.5"
            />
          </svg>
        </div>
      )}
    </>
  );
}

/**
 * Decide which viewport edge to pin the arrow to and the position along it.
 * Returns `null` direction when the target is fully on-screen. Coordinates
 * are clamped to a 24px gutter so the arrow isn't flush with the edge.
 */
function computeArrowPlacement(rect: DOMRect): {
  dir: ArrowDirection | null;
  x: number;
  y: number;
} {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const PAD = 24;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  if (rect.bottom < 0) {
    return { dir: "up", x: clamp(cx, PAD, vw - PAD), y: PAD };
  }
  if (rect.top > vh) {
    return { dir: "down", x: clamp(cx, PAD, vw - PAD), y: vh - PAD };
  }
  if (rect.right < 0) {
    return { dir: "left", x: PAD, y: clamp(cy, PAD, vh - PAD) };
  }
  if (rect.left > vw) {
    return { dir: "right", x: vw - PAD, y: clamp(cy, PAD, vh - PAD) };
  }
  return { dir: null, x: 0, y: 0 };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Strip the flag-highlight param via Next router. No-op when absent. */
function stripParam(
  router: ReturnType<typeof useRouter>,
  pathname: string | null,
  searchParams: ReturnType<typeof useSearchParams>
): void {
  if (!pathname) {
    return;
  }
  const params = new URLSearchParams(searchParams?.toString() ?? "");
  if (!params.has("flag-highlight")) {
    return;
  }
  params.delete("flag-highlight");
  const qs = params.toString();
  router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
}

/**
 * Escape a string for a CSS attribute selector. Falls back to a minimal
 * replace pass when CSS.escape isn't available (older webviews).
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, (m) => `\\${m}`);
}

"use client";

import type * as ECharts from "echarts";
/**
 * Thin ECharts wrapper that:
 *   - Imports echarts only on the client (Next App Router server-renders
 *     components by default, and ECharts touches `window` during init).
 *   - Registers a shared 'privacy-dark' / 'privacy-light' theme pair
 *     matching the globals.css text tokens, picks one via useChartTheme(),
 *     and re-initialises the chart when the page theme flips (ECharts
 *     binds its theme at init time — there's no post-init switch).
 *   - Handles resize via ResizeObserver so charts re-flow inside flex/grid
 *     parents without callers wiring a window listener per instance.
 *
 * Callers pass an ECharts `option` object; this component owns only the chrome.
 *
 * Text alternative (WCAG 1.1.1): a canvas is a picture to assistive
 * technology, so every chart needs `ariaLabel`, and passes the data in
 * words as `ariaDescription` where it fits. The root is `role="img"`
 * named by the label; the description is visually hidden text beside it,
 * linked with aria-describedby (children of role="img" are not read, so
 * it cannot live inside). ECharts' own `aria` option is always enabled
 * with the same label as its description, so its auto-generated summary
 * (English or Chinese only, and never our copy) never replaces ours.
 * Callers that use `aria.decal` for shapes mode keep it: the caller's
 * `aria` object is merged, not replaced.
 */
import { useEffect, useId, useRef } from "react";
import { withAriaLabel } from "../../../lib/chart-text-alternatives";
import { useChartTheme } from "../../../lib/use-chart-colors";

let themesRegistered = false;

// The tooltip glass is intentionally dark in BOTH themes — it mirrors the
// fixed dark popover chrome used elsewhere, and every chart pins the
// colours painted *inside* tooltip HTML to the dark palette for the same
// reason. Don't make this theme-dependent without revisiting those.
const TOOLTIP_CHROME = {
  backgroundColor: "rgba(18, 18, 26, 0.92)",
  borderColor: "rgba(255, 255, 255, 0.12)",
  textStyle: { color: "#f0f0f5" },
};

const FONT_FAMILY = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

function registerThemesOnce(echarts: typeof ECharts) {
  if (themesRegistered) {
    return;
  }
  // Dark values are the original 'privacy' theme; light values are the
  // light-mode --text / --text-2 tokens so default chrome (axis names,
  // legends that don't set their own colour) stays readable on white.
  echarts.registerTheme("privacy-dark", {
    backgroundColor: "transparent",
    textStyle: { color: "#f0f0f5", fontFamily: FONT_FAMILY },
    title: { textStyle: { color: "#f0f0f5" } },
    legend: { textStyle: { color: "#a0a0b0" } },
    tooltip: TOOLTIP_CHROME,
  });
  echarts.registerTheme("privacy-light", {
    backgroundColor: "transparent",
    textStyle: { color: "#1c1c1e", fontFamily: FONT_FAMILY },
    title: { textStyle: { color: "#1c1c1e" } },
    legend: { textStyle: { color: "#6c6c80" } },
    tooltip: TOOLTIP_CHROME,
  });
  themesRegistered = true;
}

interface EChartProps {
  /**
   * Optional longer text alternative: the chart's data restated in words.
   * Rendered visually hidden next to the chart and linked with
   * aria-describedby.
   */
  ariaDescription?: string;
  /**
   * Accessible name: what the chart shows, in one localised sentence.
   * Required so no chart ships as an unlabelled canvas.
   */
  ariaLabel: string;
  /** Extra className appended to the root div. */
  className?: string;
  /** Height in px or any valid CSS length. Width is always 100% of parent. */
  height?: number | string;
  /** Optional click handler for interactive charts. */
  onClick?: (params: unknown) => void;
  /**
   * Called once, after the chart instance is initialised. Used by callers
   * that need to dispatch imperative actions (e.g. `highlight`/`downplay`
   * to lock a Sankey adjacency selection) without rebuilding the chart.
   * The caller receives the raw ECharts instance.
   */
  onReady?: (instance: ECharts.ECharts) => void;
  option: ECharts.EChartsCoreOption;
}

export default function EChart({
  option,
  ariaLabel,
  ariaDescription,
  height = 360,
  className,
  onClick,
  onReady,
}: EChartProps) {
  const descriptionId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ECharts.ECharts | null>(null);
  const theme = useChartTheme();

  // Latest props for the (re-)init path below. Routed through refs so a
  // new option/handler identity per render never rebuilds the canvas —
  // only a theme flip does. Option *updates* still flow through the
  // setOption effect further down.
  const optionRef = useRef(option);
  const ariaLabelRef = useRef(ariaLabel);
  const onClickRef = useRef(onClick);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    optionRef.current = option;
    ariaLabelRef.current = ariaLabel;
    onClickRef.current = onClick;
    onReadyRef.current = onReady;
  });

  useEffect(() => {
    let cancelled = false;
    // Dynamically import so the ~900KB echarts bundle stays out of the SSR/
    // initial-paint path. The first chart on a page pays the hit; subsequent
    // charts reuse the cached module.
    (async () => {
      const echarts = await import("echarts");
      if (cancelled || !rootRef.current) {
        return;
      }
      registerThemesOnce(echarts);
      const inst = echarts.init(rootRef.current, `privacy-${theme}`, {
        renderer: "canvas",
      });
      instanceRef.current = inst;
      inst.setOption(withAriaLabel(optionRef.current, ariaLabelRef.current));
      inst.on("click", (params: unknown) => onClickRef.current?.(params));
      // Re-fires after a theme re-init so imperative callers always hold
      // the live instance, never a disposed one.
      onReadyRef.current?.(inst);
    })();

    return () => {
      cancelled = true;
      if (instanceRef.current) {
        instanceRef.current.dispose();
        instanceRef.current = null;
      }
    };
    // Re-initialise only when the theme changes — ECharts can't swap a
    // registered theme on a live instance. Option updates flow through the
    // next effect so we don't rebuild the canvas every render.
  }, [theme]);

  // Push new option (or label) when it changes, preserving the existing
  // canvas.
  useEffect(() => {
    if (instanceRef.current) {
      instanceRef.current.setOption(withAriaLabel(option, ariaLabel), {
        notMerge: true,
      });
    }
  }, [option, ariaLabel]);

  // ResizeObserver — safer than window resize because the chart can live
  // inside a flex parent that changes independently of the viewport.
  useEffect(() => {
    if (!rootRef.current || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => instanceRef.current?.resize());
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      <div
        aria-describedby={ariaDescription ? descriptionId : undefined}
        aria-label={ariaLabel}
        className={className}
        ref={rootRef}
        role="img"
        style={{
          width: "100%",
          height: typeof height === "number" ? `${height}px` : height,
        }}
      />
      {ariaDescription ? (
        <p className="sr-only" id={descriptionId}>
          {ariaDescription}
        </p>
      ) : null}
    </>
  );
}

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
 */
import { useEffect, useRef } from "react";
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
  height = 360,
  className,
  onClick,
  onReady,
}: EChartProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ECharts.ECharts | null>(null);
  const theme = useChartTheme();

  // Latest props for the (re-)init path below. Routed through refs so a
  // new option/handler identity per render never rebuilds the canvas —
  // only a theme flip does. Option *updates* still flow through the
  // setOption effect further down.
  const optionRef = useRef(option);
  const onClickRef = useRef(onClick);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    optionRef.current = option;
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
      inst.setOption(optionRef.current);
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

  // Push new option when it changes, preserving the existing canvas.
  useEffect(() => {
    if (instanceRef.current) {
      instanceRef.current.setOption(option, { notMerge: true });
    }
  }, [option]);

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
    <div
      className={className}
      ref={rootRef}
      style={{
        width: "100%",
        height: typeof height === "number" ? `${height}px` : height,
      }}
    />
  );
}

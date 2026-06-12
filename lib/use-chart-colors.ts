"use client";

import { useEffect, useState } from "react";
import {
  type ChartColors,
  type ChartThemeName,
  readChartColors,
  readTheme,
} from "./chart-colors";

/**
 * Resolved chart palette that tracks the active theme. Reads the CSS
 * design tokens off <html> and re-resolves when either theme mechanism
 * fires:
 *   (a) the OS prefers-color-scheme media query flips, or
 *   (b) the app's data-theme-override attribute changes (light / dark /
 *       high-contrast, set by AccessibilityQuickToggles and the desktop
 *       shell's pinned-theme setting).
 * Same observer pair PrivacySankey uses for its label theme. The returned
 * object is referentially stable until a token value actually changes, so
 * it's safe as a useMemo dependency for ECharts options.
 *
 * Client-only (React state + DOM observers) — kept separate from the
 * server-safe constants/helpers in lib/chart-colors.ts so tests and any
 * future server caller can import those without pulling in React.
 */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(() => readChartColors());

  useEffect(() => {
    const update = () => {
      setColors((prev) => {
        const next = readChartColors();
        const changed = (Object.keys(next) as Array<keyof ChartColors>).some(
          (key) => prev[key] !== next[key]
        );
        return changed ? next : prev;
      });
    };
    // Sync once on mount in case the SSR fallback diverges from the page.
    update();
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener?.("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme-override"],
    });
    return () => {
      mq.removeEventListener?.("change", update);
      mo.disconnect();
    };
  }, []);

  return colors;
}

/**
 * Theme *name* counterpart to useChartColors, for chrome that is keyed by
 * a light/dark record rather than individual tokens (PrivacySankey's
 * CHART_THEME, the ECharts theme selection in EChart.tsx). Watches the
 * same two mechanisms; "high-contrast" resolves to 'dark' (black
 * surfaces) via the shared readTheme().
 */
export function useChartTheme(): ChartThemeName {
  const [theme, setTheme] = useState<ChartThemeName>(() => readTheme());

  useEffect(() => {
    const update = () => setTheme(readTheme());
    update();
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener?.("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme-override"],
    });
    return () => {
      mq.removeEventListener?.("change", update);
      mo.disconnect();
    };
  }, []);

  return theme;
}

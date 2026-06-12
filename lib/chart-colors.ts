/**
 * Severity / accent colours for the chart components, resolved from the
 * CSS design tokens in app/globals.css instead of hardcoded dark-theme
 * hexes — so the light and high-contrast palettes flow through (WCAG
 * 1.4.11 requires 3:1 for graphics, and the dark brights sit as low as
 * ~1.9:1 on the light background).
 *
 * Chart surfaces paint in two different ways and each needs its own
 * treatment:
 *   - DOM-painted swatches / cells (SmallMultiples, the heatmap legend)
 *     use `var(--red, #ff453a)` directly — CSS resolves the token per
 *     theme for free. Same pattern CompareAppsView uses for teal.
 *   - Canvas-painted ECharts options (heatmap cells, Sankey nodes, radar
 *     series, timeline bands) can't — canvas fills need concrete colour
 *     strings. Those components resolve the tokens at render time via
 *     `useChartColors()` (lib/use-chart-colors.ts) and re-resolve when
 *     the theme changes.
 *
 * One deliberate exception: colours painted INSIDE the shared ECharts
 * tooltip stay pinned to the dark palette, because the tooltip glass
 * registered in EChart.tsx keeps its dark background in every theme —
 * theme-resolved colours would render dark-on-dark there in light mode.
 * SocialShareModal is likewise exempt: it exports a PNG over a fixed
 * dark background, independent of the page theme.
 *
 * `DARK_CHART_COLORS` doubles as the SSR fallback and as the single
 * place the dark-token hexes are written down outside globals.css —
 * tests/app/chart-colors.test.ts pins it against the `:root` block so
 * the two can't drift.
 */

export const DARK_CHART_COLORS = {
  bg: "#08080f",
  blue: "#0a84ff",
  // Chart chrome: `border` paints axis/grid lines, `text2`/`text3` paint
  // axis labels and legend text (the old hardcoded #a0a0b0 / #8e8e93 were
  // exactly the dark --text-2 / --text-3 values, so dark mode is
  // unchanged). `text` is the base for low-alpha derived chrome via
  // withAlpha (radar split bands, heatmap hover glow).
  border: "rgba(255, 255, 255, 0.07)",
  cream: "#d8c7a3",
  cyan: "#64d2ff",
  green: "#30d158",
  orange: "#ff9f0a",
  purple: "#af52de",
  red: "#ff453a",
  text: "#f0f0f5",
  text2: "#a0a0b0",
  text3: "#8e8e93",
  yellow: "#ffd60a",
} as const;

export type ChartColorKey = keyof typeof DARK_CHART_COLORS;
export type ChartColors = Record<ChartColorKey, string>;

/** CSS custom property backing each palette entry. */
export const CHART_COLOR_TOKENS: Record<ChartColorKey, string> = {
  bg: "--bg",
  blue: "--blue",
  border: "--border",
  cream: "--cream",
  cyan: "--cyan",
  green: "--green",
  orange: "--orange",
  purple: "--purple",
  red: "--red",
  text: "--text",
  text2: "--text-2",
  text3: "--text-3",
  yellow: "--yellow",
};

/**
 * Resolve the palette from the live document. Falls back to the dark
 * values during SSR and for any token the stylesheet doesn't define.
 */
export function readChartColors(): ChartColors {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return { ...DARK_CHART_COLORS };
  }
  const styles = window.getComputedStyle(document.documentElement);
  const colors: ChartColors = { ...DARK_CHART_COLORS };
  for (const key of Object.keys(CHART_COLOR_TOKENS) as ChartColorKey[]) {
    const value = styles.getPropertyValue(CHART_COLOR_TOKENS[key]).trim();
    if (value) {
      colors[key] = value;
    }
  }
  return colors;
}

export type ChartThemeName = "light" | "dark";

/**
 * Read the effective theme from the DOM so chart chrome that is keyed by
 * theme name (PrivacySankey's CHART_THEME, the ECharts theme picked in
 * EChart.tsx) can match the rest of the page. Priority:
 *   1. html[data-theme-override] — the app's explicit override. The
 *      "high-contrast" override maps to 'dark': its surfaces are pure
 *      black, so dark-keyed chrome (light text) is the readable choice
 *      regardless of the OS preference underneath.
 *   2. window.matchMedia('(prefers-color-scheme: light)') — OS preference.
 * Safe to call during SSR — returns 'dark' (the original default) when
 * `document`/`window` aren't available. Extracted from PrivacySankey so
 * every theme-keyed consumer resolves identically.
 */
export function readTheme(): ChartThemeName {
  if (typeof document === "undefined") {
    return "dark";
  }
  const override = document.documentElement.getAttribute("data-theme-override");
  if (override === "light") {
    return "light";
  }
  if (override === "dark" || override === "high-contrast") {
    return "dark";
  }
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

/**
 * `rgba()` form of a 6-digit hex colour, replacing the old
 * `${hex}33` / `${hex}55` suffix trick that only worked on literal hexes.
 * Canvas fills can't use `color-mix()`, and a resolved token isn't
 * guaranteed to be hex, so a non-hex input is returned unchanged (full
 * opacity) rather than mangled.
 */
export function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) {
    return color;
  }
  const r = Number.parseInt(match[1].slice(0, 2), 16);
  const g = Number.parseInt(match[1].slice(2, 4), 16);
  const b = Number.parseInt(match[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

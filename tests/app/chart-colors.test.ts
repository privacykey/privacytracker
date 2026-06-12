import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CHART_COLOR_TOKENS,
  type ChartColorKey,
  DARK_CHART_COLORS,
  withAlpha,
} from "../../lib/chart-colors";

/**
 * The chart components resolve their severity / accent colours from the
 * CSS design tokens (lib/chart-colors.ts + lib/use-chart-colors.ts)
 * instead of hardcoding the dark palette. Two contracts are pinned here:
 *
 *   1. `DARK_CHART_COLORS` (the SSR / missing-token fallback) must stay
 *      byte-identical to the `:root` dark tokens in app/globals.css —
 *      otherwise the fallback silently drifts from the real dark theme.
 *
 *   2. Wherever a theme block (light media query, light/high-contrast
 *      data-theme-override) redefines one of those tokens, the redefined
 *      colour must clear the WCAG 1.4.11 3:1 graphics minimum against
 *      that theme's backgrounds — that's the whole point of the charts
 *      reading tokens. Tokens a theme block doesn't (yet) redefine are
 *      skipped, so this suite tightens automatically when the light
 *      severity palette lands (PR #64) without failing before it.
 */

const css = readFileSync(
  path.join(process.cwd(), "app", "globals.css"),
  "utf8"
);

/** Slice out the body of the first block whose selector matches `start`. */
function extractBlock(source: string, start: RegExp): string {
  const match = start.exec(source);
  assert.ok(match, `selector ${start} not found in globals.css`);
  const open = source.indexOf("{", match.index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  assert.fail(`unterminated block for ${start}`);
}

function parseTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  // Strip comments first — token names mentioned in prose (e.g. the
  // "--text-2 : secondary copy" docs above the dark text tokens) would
  // otherwise be picked up as declarations.
  const source = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m = re.exec(source);
  while (m) {
    if (!tokens.has(m[1])) {
      tokens.set(m[1], m[2].trim().toLowerCase());
    }
    m = re.exec(source);
  }
  return tokens;
}

const darkRoot = parseTokens(extractBlock(css, /^:root\s*\{/m));
// The first prefers-color-scheme:light media block is the token block; its
// inner :root carries the light palette.
const lightMedia = parseTokens(
  extractBlock(
    extractBlock(css, /^@media \(prefers-color-scheme: light\)\s*\{/m),
    /:root\s*\{/
  )
);
const lightOverride = parseTokens(
  extractBlock(css, /^html\[data-theme-override="light"\]\s*\{/m)
);
const hcOverride = parseTokens(
  extractBlock(css, /^html\[data-theme-override="high-contrast"\]\s*\{/m)
);

// ── WCAG relative-luminance contrast ───────────────────────────────────

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `expected a 6-digit hex colour, got "${hex}"`);
  return (
    0.2126 * channel(Number.parseInt(m[1].slice(0, 2), 16)) +
    0.7152 * channel(Number.parseInt(m[1].slice(2, 4), 16)) +
    0.0722 * channel(Number.parseInt(m[1].slice(4, 6), 16))
  );
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Tokens the charts paint as solid graphics (fills, lines, swatches).
// Excluded: `bg` (the surface the others are measured against) and the
// chrome tokens — `border` is a translucent rgba (no fixed composite to
// measure here) and the text tokens get their own 4.5:1 text check below.
const CHROME_KEYS: ChartColorKey[] = ["bg", "border", "text", "text2", "text3"];
const GRAPHIC_KEYS = (
  Object.keys(CHART_COLOR_TOKENS) as ChartColorKey[]
).filter((key) => !CHROME_KEYS.includes(key));

test("DARK_CHART_COLORS matches the :root dark tokens in globals.css", () => {
  for (const key of Object.keys(CHART_COLOR_TOKENS) as ChartColorKey[]) {
    const token = CHART_COLOR_TOKENS[key].replace(/^--/, "");
    const cssValue = darkRoot.get(token);
    assert.ok(cssValue, `:root is missing --${token}`);
    assert.equal(
      cssValue,
      DARK_CHART_COLORS[key].toLowerCase(),
      `fallback for --${token} drifted from globals.css`
    );
  }
});

test("withAlpha converts 6-digit hexes and passes through anything else", () => {
  assert.equal(withAlpha("#ff453a", 0.2), "rgba(255, 69, 58, 0.2)");
  assert.equal(withAlpha(" #FFD60A ", 0.5), "rgba(255, 214, 10, 0.5)");
  // Non-hex resolved values (var() strings, rgb(), keywords) come back
  // unchanged rather than mangled.
  assert.equal(withAlpha("var(--red, #ff453a)", 0.2), "var(--red, #ff453a)");
  assert.equal(withAlpha("#fff", 0.2), "#fff");
});

test("light-theme chart tokens clear 3:1 against the light backgrounds", () => {
  // --bg #f2f2f7 and --bg-2 #ffffff are the light chart surfaces.
  const surfaces = [
    lightMedia.get("bg") ?? "#f2f2f7",
    lightMedia.get("bg-2") ?? "#ffffff",
  ];
  for (const key of GRAPHIC_KEYS) {
    const token = CHART_COLOR_TOKENS[key].replace(/^--/, "");
    const value = lightMedia.get(token);
    if (!value) {
      // Not redefined for light (yet) — dark value applies; nothing to pin.
      continue;
    }
    for (const surface of surfaces) {
      const ratio = contrast(value, surface);
      assert.ok(
        ratio >= 3,
        `light --${token} (${value}) is ${ratio.toFixed(2)}:1 against ${surface}; WCAG 1.4.11 needs 3:1`
      );
    }
  }
});

test("the two light mechanisms (media query + override) define identical tokens", () => {
  // A light-OS user and a pinned-light desktop user must get the same
  // palette, or charts would change colour based on *how* light mode was
  // entered.
  for (const key of GRAPHIC_KEYS) {
    const token = CHART_COLOR_TOKENS[key].replace(/^--/, "");
    const media = lightMedia.get(token);
    const override = lightOverride.get(token);
    if (media || override) {
      assert.equal(
        media,
        override,
        `--${token} differs between the light media query (${media}) and html[data-theme-override="light"] (${override})`
      );
    }
  }
});

test("light axis-label tokens clear 4.5:1 against the light chart surfaces", () => {
  // Chart axis labels and legend text read --text-2 / --text-3 (WCAG
  // 1.4.3 text minimum, not the 3:1 graphics bound). Charts sit on --bg
  // and --bg-2 panels.
  const surfaces = [
    lightMedia.get("bg") ?? "#f2f2f7",
    lightMedia.get("bg-2") ?? "#ffffff",
  ];
  for (const token of ["text-2", "text-3"]) {
    const value = lightMedia.get(token);
    assert.ok(value, `light palette is missing --${token}`);
    for (const surface of surfaces) {
      const ratio = contrast(value, surface);
      assert.ok(
        ratio >= 4.5,
        `light --${token} (${value}) is ${ratio.toFixed(2)}:1 against ${surface}; WCAG 1.4.3 needs 4.5:1`
      );
    }
  }
});

test("high-contrast chart tokens clear 3:1 against the HC background", () => {
  const surface = hcOverride.get("bg") ?? "#000000";
  for (const key of GRAPHIC_KEYS) {
    const token = CHART_COLOR_TOKENS[key].replace(/^--/, "");
    const value = hcOverride.get(token);
    if (!value) {
      continue;
    }
    const ratio = contrast(value, surface);
    assert.ok(
      ratio >= 3,
      `high-contrast --${token} (${value}) is ${ratio.toFixed(2)}:1 against ${surface}; WCAG 1.4.11 needs 3:1`
    );
  }
});

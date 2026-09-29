import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Text-token contrast on the surfaces the tokens actually land on.
 *
 * The tokens used to pass against the page background and fail once
 * composed: dark --text-3 was 4.2 to 4.4:1 on the nested settings panels
 * (--surface-2 / --surface-3 over a lighter --bg step), light --text-2
 * was 4.1:1 on --bg-3 and on the active schedule option's --blue-dim
 * tint, and the selected privacy-profile pills painted white on the
 * bright dark-mode severity fills (2.0 to 3.4:1). Each check below reads
 * the values straight out of app/globals.css, composites the translucent
 * ones, and requires WCAG 1.4.3's 4.5:1, in every block that defines the
 * token, so a later token edit cannot quietly undo it.
 */

const css = readFileSync(
  path.join(process.cwd(), "app", "globals.css"),
  "utf8"
);

/** Body of the first block whose selector matches `start`. */
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
const lightMedia = parseTokens(
  extractBlock(
    extractBlock(css, /^@media \(prefers-color-scheme: light\)\s*\{/m),
    /:root\s*\{/
  )
);
const lightOverride = parseTokens(
  extractBlock(css, /^html\[data-theme-override="light"\]\s*\{/m)
);
const darkOverride = parseTokens(
  extractBlock(css, /^html\[data-theme-override="dark"\]\s*\{/m)
);
const hcOverride = parseTokens(
  extractBlock(css, /^html\[data-theme-override="high-contrast"\]\s*\{/m)
);

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    return [
      Number.parseInt(hex[1].slice(0, 2), 16),
      Number.parseInt(hex[1].slice(2, 4), 16),
      Number.parseInt(hex[1].slice(4, 6), 16),
      1,
    ];
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  assert.ok(rgba, `expected a hex or rgba() colour, got "${value}"`);
  const parts = rgba[1].split(",").map((p) => Number.parseFloat(p));
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

/** Paint `top` over an opaque `base`. */
function over(top: string, base: Rgba): Rgba {
  const [r, g, b, a] = parseColor(top);
  return [
    r * a + base[0] * (1 - a),
    g * a + base[1] * (1 - a),
    b * a + base[2] * (1 - a),
    1,
  ];
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgba): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function token(block: Map<string, string>, name: string): string {
  const value = block.get(name);
  assert.ok(value, `block is missing --${name}`);
  return value;
}

function assertAA(
  label: string,
  fg: string,
  bg: Rgba,
  where: string,
  min = 4.5
) {
  const ratio = contrast(parseColor(fg), bg);
  assert.ok(
    ratio >= min,
    `${label} (${fg}) is ${ratio.toFixed(2)}:1 on ${where}; needs ${min}:1`
  );
}

test("dark --text-2 / --text-3 clear 4.5:1 on the lightest nested panel", () => {
  for (const [name, block] of [
    [":root", darkRoot],
    ['[data-theme-override="dark"]', darkOverride],
  ] as const) {
    // --surface-3 over --bg-3 is the lightest composite a settings help
    // line sits on (a nested row inside a panel on the lighter bg step).
    const bg3 = parseColor(token(block, "bg-3"));
    const nested = over(token(block, "surface-3"), bg3);
    const panel = over(
      token(block, "surface-2"),
      parseColor(token(block, "bg-2"))
    );
    for (const t of ["text-2", "text-3"]) {
      assertAA(
        `${name} --${t}`,
        token(block, t),
        nested,
        "--surface-3 over --bg-3"
      );
      assertAA(
        `${name} --${t}`,
        token(block, t),
        panel,
        "--surface-2 over --bg-2"
      );
    }
  }
});

test("light --text-2 clears 4.5:1 on --bg-3 and on the --blue-dim tint", () => {
  // --blue-dim is not redefined for light, so the root value applies.
  const blueDim = token(darkRoot, "blue-dim");
  for (const [name, block] of [
    ["@media light", lightMedia],
    ['[data-theme-override="light"]', lightOverride],
  ] as const) {
    const text2 = token(block, "text-2");
    assertAA(
      `${name} --text-2`,
      text2,
      parseColor(token(block, "bg-3")),
      "--bg-3"
    );
    assertAA(
      `${name} --text-2`,
      text2,
      over(blueDim, parseColor(token(block, "bg"))),
      "--blue-dim over --bg"
    );
  }
  assert.equal(
    token(lightMedia, "text-2"),
    token(lightOverride, "text-2"),
    "the two light mechanisms must agree on --text-2"
  );
});

test("--on-severity-fill reads on every solid severity fill, per theme", () => {
  const blocks = [
    [":root", darkRoot, darkRoot],
    ['[data-theme-override="dark"]', darkOverride, darkOverride],
    ["@media light", lightMedia, lightMedia],
    ['[data-theme-override="light"]', lightOverride, lightOverride],
    // High contrast re-pins the label; its fills are its own brights.
    ['[data-theme-override="high-contrast"]', hcOverride, hcOverride],
  ] as const;
  for (const [name, labelBlock, fillBlock] of blocks) {
    const label = token(labelBlock, "on-severity-fill");
    for (const fill of ["red", "orange", "green"]) {
      assertAA(
        `${name} --on-severity-fill`,
        label,
        parseColor(token(fillBlock, fill)),
        `--${fill}`
      );
    }
  }
});

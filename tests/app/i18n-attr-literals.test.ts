/**
 * Guard against hardcoded English in assistive/UI attributes.
 *
 * `pnpm lint:i18n` only checks locales/*.json key parity — it cannot see
 * a TSX literal like `aria-label="Sort apps"` that bypasses next-intl
 * entirely, which is how a batch of English-only screen-reader strings
 * shipped to non-English locales (pre-launch audit, 2026-06). This test
 * scans every component for `aria-label` / `title` / `placeholder` /
 * `alt` (plus the rarer aria string attributes) whose value contains
 * literal English words instead of a translator call.
 *
 * Allowed without complaint:
 *   - empty values (`alt=""` on decorative images)
 *   - translator calls and their key arguments (`t("key")`, `tGrid(...)`)
 *   - pure interpolation (`title={`${a} — ${b}`}` where a/b are localised)
 *   - brand names that stay English in every locale (see BRAND_TOKENS)
 *   - lines opted out with an `i18n-exempt` comment on the same or
 *     previous line (use sparingly, say why)
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const SCAN_ROOT = path.join(process.cwd(), "app");

/** Attributes whose values are read aloud or shown to users verbatim.
 *  No whitespace allowed around `=` — that's how Biome formats JSX
 *  attributes, and it keeps plain JS assignments like
 *  `const placeholder = "text"` out of scope. */
const ATTR_PATTERN =
  /(?:aria-label|aria-description|aria-roledescription|aria-valuetext|aria-placeholder|title|placeholder|alt)=/g;

/**
 * Brand names and locale-neutral tokens that legitimately appear in
 * attribute values untranslated (AGENTS.md: brand names stay English in
 * every locale). Matched case-sensitively as whole words.
 */
const BRAND_TOKENS = [
  "privacytracker",
  "App Store",
  "Apple Configurator",
  "Wayback",
  "Wayback Machine",
  "GitHub",
  "Crowdin",
  "ToS",
  "DR",
  "PrivacySpy",
  "Ollama",
  "OpenAI",
  "Anthropic",
  "SQLite",
  "Tauri",
];

const EXEMPT_MARKER = "i18n-exempt";

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (full.endsWith(".tsx") && !full.endsWith(".stories.tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Strip /* *​/ block comments and whitespace-preceded // line comments
 *  (preserving newlines so line numbers stay accurate). The `//` guard
 *  avoids eating `https://` inside string literals. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** True if the string contains an English word after removing brand
 *  tokens. A "word" is two or more consecutive ASCII letters — single
 *  glyphs (✓, ⚠, ·, x) and pure dates/numbers pass. */
function hasEnglishWord(text: string): boolean {
  let cleaned = text;
  for (const brand of BRAND_TOKENS) {
    cleaned = cleaned.split(brand).join(" ");
  }
  return /[A-Za-z]{2,}/.test(cleaned);
}

/** True when the quote at `index` opens a string that is never shown to
 *  users: the key argument of a translator call (`t("…")`, `tGrid(\`…\`)`),
 *  a TypeScript type assertion (`as "literal"`), or a comparison operand
 *  (`layout === "split"`). */
function isNonDisplayString(expr: string, index: number): boolean {
  const before = expr.slice(0, index);
  return (
    /\bt[A-Z]?\w*\(\s*$/.test(before) ||
    /\bas\s+$/.test(before) ||
    /[=!]==?\s*$/.test(before)
  );
}

/**
 * Collect the literal (non-interpolated) text content of every string
 * and template literal inside a JS expression, skipping translator-call
 * key arguments. Handles nested template literals via a mode stack.
 */
function literalTextInExpression(expr: string): string {
  const out: string[] = [];
  // Each frame: "single" | "double" | "template" | "interp"
  const stack: string[] = [];
  // Parallel skip flags, one per string/template frame, so a string
  // opened inside `${…}` can't clobber the outer template's state.
  const skipStack: boolean[] = [];
  let buf = "";

  const mode = () => stack[stack.length - 1];
  const flush = () => {
    if (buf && !skipStack[skipStack.length - 1]) {
      out.push(buf);
    }
    buf = "";
  };

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    const m = mode();

    if (m === "single" || m === "double") {
      if (ch === "\\") {
        i += 1;
        buf += " ";
      } else if (
        (m === "single" && ch === "'") ||
        (m === "double" && ch === '"')
      ) {
        flush();
        skipStack.pop();
        stack.pop();
      } else {
        buf += ch;
      }
    } else if (m === "template") {
      if (ch === "\\") {
        i += 1;
        buf += " ";
      } else if (ch === "`") {
        flush();
        skipStack.pop();
        stack.pop();
      } else if (ch === "$" && expr[i + 1] === "{") {
        flush();
        stack.push("interp");
        i += 1;
      } else {
        buf += ch;
      }
    } else if (ch === "'") {
      // remaining branches: top level or inside ${…}
      skipStack.push(isNonDisplayString(expr, i));
      stack.push("single");
    } else if (ch === '"') {
      skipStack.push(isNonDisplayString(expr, i));
      stack.push("double");
    } else if (ch === "`") {
      skipStack.push(isNonDisplayString(expr, i));
      stack.push("template");
    } else if (m === "interp" && ch === "}") {
      stack.pop();
    }
  }
  flush();
  return out.join(" ");
}

/** Extract the attribute value starting at `start` (just past the `=`).
 *  Returns the raw value span and whether it is a JSX expression. */
function readAttrValue(
  source: string,
  start: number
): { value: string; end: number } | null {
  const ch = source[start];
  if (ch === '"' || ch === "'") {
    const close = source.indexOf(ch, start + 1);
    if (close === -1) {
      return null;
    }
    return { value: source.slice(start + 1, close), end: close };
  }
  if (ch === "{") {
    // Unified frame stack: "{" (JS/JSX brace), "interp" (template ${…}),
    // or a quote character for string/template frames. Braces inside
    // strings are ignored; braces inside interpolations nest correctly.
    const frames: string[] = ["{"];
    for (let i = start + 1; i < source.length; i++) {
      const c = source[i];
      const top = frames[frames.length - 1];
      if (top === "'" || top === '"') {
        if (c === "\\") {
          i += 1;
        } else if (c === top) {
          frames.pop();
        }
      } else if (top === "`") {
        if (c === "\\") {
          i += 1;
        } else if (c === "`") {
          frames.pop();
        } else if (c === "$" && source[i + 1] === "{") {
          frames.push("interp");
          i += 1;
        }
      } else if (c === "'" || c === '"' || c === "`") {
        frames.push(c);
      } else if (c === "{") {
        frames.push("{");
      } else if (c === "}") {
        frames.pop();
        if (frames.length === 0) {
          return { value: source.slice(start + 1, i), end: i };
        }
      }
    }
    return null;
  }
  return null;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function isExempt(lines: string[], lineNo: number): boolean {
  const here = lines[lineNo - 1] ?? "";
  const above = lines[lineNo - 2] ?? "";
  return here.includes(EXEMPT_MARKER) || above.includes(EXEMPT_MARKER);
}

export function scanForHardcodedAttrLiterals(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of walk(root)) {
    const raw = readFileSync(file, "utf8");
    const source = stripComments(raw);
    const rawLines = raw.split("\n");
    ATTR_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null = ATTR_PATTERN.exec(source);
    while (match !== null) {
      const valueStart = match.index + match[0].length;
      const parsed = readAttrValue(source, valueStart);
      if (parsed) {
        const isExpression = source[valueStart] === "{";
        // The ${…} strip only matters for `attr="…"` matches that sit
        // inside a JS template building an HTML string — interpolated
        // values aren't hardcoded text.
        const text = isExpression
          ? literalTextInExpression(parsed.value)
          : parsed.value.replace(/\$\{[^}]*\}/g, " ");
        const lineNo = lineOf(source, match.index);
        if (hasEnglishWord(text) && !isExempt(rawLines, lineNo)) {
          findings.push({
            file: path.relative(process.cwd(), file),
            line: lineNo,
            snippet: (rawLines[lineNo - 1] ?? "").trim().slice(0, 120),
          });
        }
      }
      match = ATTR_PATTERN.exec(source);
    }
  }
  return findings;
}

test("no hardcoded English literals in assistive attributes under app/", () => {
  const findings = scanForHardcodedAttrLiterals(SCAN_ROOT);
  const report = findings
    .map((f) => `  ${f.file}:${f.line}  ${f.snippet}`)
    .join("\n");
  assert.equal(
    findings.length,
    0,
    `Found ${findings.length} assistive attribute(s) with hardcoded English text — route them through next-intl (add keys to locales/en.json + zh.json) or mark a deliberate exception with an \`i18n-exempt\` comment:\n${report}`
  );
});

/**
 * Guard against hardcoded English in VISIBLE JSX text.
 *
 * Sibling of i18n-attr-literals.test.ts, which covers assistive
 * attributes only. This one covers what that scanner deliberately
 * skips: JSX text nodes (`<div>Some words</div>`) and string/template
 * literals rendered as JSX expression children
 * (`{cond ? "Two words" : t("key")}`), which is how ~40 English-only
 * strings shipped to non-English locales despite the attribute guard
 * (pre-launch audit follow-up, 2026-06).
 *
 * Unlike the attribute test's regex scan, this uses the TypeScript AST
 * (already a devDependency) because "text node" has no reliable lexical
 * shape — `>`…`<` regexes trip over generics and comparisons, while
 * ts.JsxText is exact and gives us parents for the context checks.
 *
 * Trigger: text containing 2+ consecutive ASCII English words (after
 * brand-token and HTML-entity removal). Single-word literals ("Cancel")
 * are deliberately NOT flagged — measured during prototyping, the
 * single-word rule drowned in glyph labels, units and identifiers,
 * while the two-word rule found ~100 real strings at near-zero noise.
 *
 * Skipped without complaint:
 *   - anything inside <code>/<pre>/<kbd>/<samp> (samples, not copy) and
 *     <style>/<script> (CSS/JS text children)
 *   - subtrees under aria-hidden elements (glyph/icon spans)
 *   - app/components/vignettes/** — SVG illustration scenes of mock app
 *     UIs ("CREATE ACCOUNT", "pasta recipes"). The whole stage renders
 *     inside <svg aria-hidden="true"> (VignetteStage.tsx) with the
 *     meaning carried by localised captions in en.json, so the ~190
 *     in-artwork strings are set dressing, like text in a screenshot.
 *     The aria-hidden lives in the parent file, which a per-file AST
 *     walk can't see — hence the directory exclusion.
 *   - expression literals that are data rather than copy: the literal
 *     must reach its JsxExpression through display-transparent wrappers
 *     only (ternary results, && / || / ??, +, parens, templates).
 *     Strings consumed by variable declarations, call arguments
 *     (including translator keys), comparisons or object properties
 *     inside a render expression never flag.
 *   - lines opted out with an `i18n-exempt` comment on the same or
 *     previous line (use sparingly, say why)
 *
 * Verdict from the prototype (2026-06-12): high signal — after the
 * exclusions above, essentially every hit was genuinely untranslated
 * copy. But the backlog (~100 strings, mostly CompareAppsView,
 * StatsView, /help/focus and the chart empty-states) is too large to
 * fix in one sitting, so this test RATCHETS instead of asserting zero:
 * known debt is pinned in i18n-text-literals.baseline.json and only NEW
 * literals fail CI. Translate a baselined string and the stale entry is
 * reported (non-fatally) so the file shrinks over time. Regenerate
 * after intentional changes with:
 *
 *   UPDATE_I18N_TEXT_BASELINE=1 pnpm test && pnpm lint:fix
 *
 * (lint:fix settles the JSON to Biome's formatting) — the diff of the
 * checked-in baseline then shows reviewers exactly which strings were
 * added or removed.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const SCAN_ROOT = path.join(process.cwd(), "app");
const BASELINE_PATH = path.join(
  process.cwd(),
  "tests",
  "app",
  "i18n-text-literals.baseline.json"
);

/** Mirrors BRAND_TOKENS in i18n-attr-literals.test.ts. */
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

/** Two or more consecutive ASCII words of 2+ letters each. Apostrophes
 *  inside words count as word characters so contractions ("doesn't
 *  match") don't split into unflaggable singles. */
const TWO_WORDS = /[A-Za-z][A-Za-z'’]+[ \t]+[A-Za-z][A-Za-z'’]+/;

/** Tags whose text children are code/sample/CSS, not UI copy. */
const NON_COPY_TAGS = new Set([
  "code",
  "pre",
  "kbd",
  "samp",
  "style",
  "script",
]);

/** Directories whose JSX text is illustration artwork, not copy. */
const EXCLUDED_DIRS = new Set(["vignettes"]);

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry)) {
        walk(full, out);
      }
    } else if (full.endsWith(".tsx") && !full.endsWith(".stories.tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Strip brand tokens and HTML entities, then test the two-word rule. */
function hasEnglishPhrase(text: string): boolean {
  let cleaned = text.replace(/&[#a-zA-Z0-9]+;/g, " ");
  for (const brand of BRAND_TOKENS) {
    cleaned = cleaned.split(brand).join(" ");
  }
  return TWO_WORDS.test(cleaned);
}

/** True when `node` sits under a non-copy tag or an aria-hidden
 *  element — both render text we never localise. */
function inSkippedJsxContext(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isJsxElement(cur)) {
      const open = cur.openingElement;
      if (NON_COPY_TAGS.has(open.tagName.getText())) {
        return true;
      }
      for (const attr of open.attributes.properties) {
        if (
          ts.isJsxAttribute(attr) &&
          attr.name.getText() === "aria-hidden" &&
          attr.initializer?.getText() !== '"false"'
        ) {
          return true;
        }
      }
    }
    cur = cur.parent;
  }
  return false;
}

const TRANSPARENT_BINARY_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.PlusToken,
]);

/**
 * Walk from a literal up to its nearest JsxExpression. Returns true
 * only when (a) every node in between is a display-transparent wrapper
 * — so the literal itself is what gets rendered — and (b) that
 * JsxExpression is an element/fragment CHILD, not an attribute value
 * (attributes are i18n-attr-literals.test.ts territory).
 *
 * Anything else consuming the string on the way up (variable
 * declaration, call argument — translator keys included —, comparison,
 * object property, switch case) means it's data, not copy: not ours.
 */
function rendersAsJsxChild(node: ts.Node): boolean {
  let cur: ts.Node = node;
  let parent: ts.Node | undefined = cur.parent;
  while (parent) {
    if (ts.isJsxExpression(parent)) {
      const host = parent.parent;
      return ts.isJsxElement(host) || ts.isJsxFragment(host);
    }
    const transparent =
      (ts.isConditionalExpression(parent) &&
        (parent.whenTrue === cur || parent.whenFalse === cur)) ||
      (ts.isBinaryExpression(parent) &&
        TRANSPARENT_BINARY_OPS.has(parent.operatorToken.kind)) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isTemplateExpression(parent) ||
      ts.isTemplateSpan(parent);
    if (!transparent) {
      return false;
    }
    cur = parent;
    parent = cur.parent;
  }
  return false;
}

function isExempt(lines: string[], lineNo: number): boolean {
  const here = lines[lineNo - 1] ?? "";
  const above = lines[lineNo - 2] ?? "";
  return here.includes(EXEMPT_MARKER) || above.includes(EXEMPT_MARKER);
}

export function scanForHardcodedTextLiterals(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of walk(root)) {
    const sourceText = readFileSync(file, "utf8");
    const rawLines = sourceText.split("\n");
    const sf = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    const record = (node: ts.Node, text: string) => {
      // Line of the first English letter, not of the node start —
      // JsxText nodes often begin with the previous line's newline.
      const offset =
        node.getStart() + Math.max(0, node.getText().search(/[A-Za-z]/));
      const lineNo = sf.getLineAndCharacterOfPosition(offset).line + 1;
      if (isExempt(rawLines, lineNo)) {
        return;
      }
      findings.push({
        file: path.relative(process.cwd(), file),
        line: lineNo,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 100),
      });
    };

    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        if (hasEnglishPhrase(node.text) && !inSkippedJsxContext(node)) {
          record(node, node.text);
        }
        return;
      }
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)) &&
        hasEnglishPhrase(node.text) &&
        rendersAsJsxChild(node) &&
        !inSkippedJsxContext(node)
      ) {
        record(node, node.text);
        return;
      }
      if (ts.isTemplateExpression(node)) {
        // Check each literal span of `…${x}…` individually so an
        // interpolated value can't bridge two single words into a
        // false phrase.
        const spans = [
          node.head.text,
          ...node.templateSpans.map((s) => s.literal.text),
        ];
        if (
          spans.some((t) => hasEnglishPhrase(t)) &&
          rendersAsJsxChild(node) &&
          !inSkippedJsxContext(node)
        ) {
          record(node, spans.join(" … "));
        }
        // fall through: still visit ${…} for nested JSX
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return findings;
}

/** Baseline key — line numbers excluded on purpose so unrelated edits
 *  shifting a file don't invalidate entries. */
const keyOf = (f: Finding) => `${f.file}${f.snippet}`;

function loadBaseline(): Map<string, number> {
  let raw: string;
  try {
    raw = readFileSync(BASELINE_PATH, "utf8");
  } catch {
    return new Map();
  }
  const parsed = JSON.parse(raw) as Record<string, string[]>;
  const counts = new Map<string, number>();
  for (const [file, snippets] of Object.entries(parsed)) {
    for (const snippet of snippets) {
      const k = `${file}${snippet}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
}

function writeBaseline(findings: Finding[]): void {
  const byFile: Record<string, string[]> = {};
  for (const f of [...findings].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  )) {
    (byFile[f.file] ??= []).push(f.snippet);
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(byFile, null, 2)}\n`);
}

test("no NEW hardcoded English phrases in visible JSX text under app/", () => {
  const findings = scanForHardcodedTextLiterals(SCAN_ROOT);

  if (process.env.UPDATE_I18N_TEXT_BASELINE) {
    writeBaseline(findings);
    console.log(
      `i18n-text-literals: baseline regenerated with ${findings.length} entr${findings.length === 1 ? "y" : "ies"} at ${path.relative(process.cwd(), BASELINE_PATH)}`
    );
    return;
  }

  const remaining = loadBaseline();
  const fresh: Finding[] = [];
  for (const f of findings) {
    const k = keyOf(f);
    const allowed = remaining.get(k) ?? 0;
    if (allowed > 0) {
      remaining.set(k, allowed - 1);
    } else {
      fresh.push(f);
    }
  }

  // Stale baseline entries (strings since translated or removed) are a
  // courtesy note, not a failure — prune them by regenerating.
  const stale = [...remaining.entries()].filter(([, n]) => n > 0);
  if (stale.length > 0) {
    console.log(
      `i18n-text-literals: ${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} no longer match — run UPDATE_I18N_TEXT_BASELINE=1 pnpm test to prune.`
    );
  }

  const report = fresh
    .map((f) => `  ${f.file}:${f.line}  ${f.snippet}`)
    .join("\n");
  assert.equal(
    fresh.length,
    0,
    `Found ${fresh.length} NEW visible JSX text node(s) with hardcoded English — route them through next-intl (add keys to locales/en.json + zh.json) or mark a deliberate exception with an \`i18n-exempt\` comment:\n${report}`
  );
});

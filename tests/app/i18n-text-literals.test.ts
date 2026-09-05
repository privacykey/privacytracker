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
 * Unlike the attribute test's regex scan, this uses a Babel AST because
 * "text node" has no reliable lexical shape: `>`…`<` regexes trip over
 * generics and comparisons. The helper walks JSX nodes and their parents
 * without depending on the TypeScript compiler API (absent in TS 7).
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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  type Finding,
  scanForHardcodedTextLiterals,
} from "../helpers/i18n-text-scanner";

const SCAN_ROOT = path.join(process.cwd(), "app");
const BASELINE_PATH = path.join(
  process.cwd(),
  "tests",
  "app",
  "i18n-text-literals.baseline.json"
);

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

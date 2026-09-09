/**
 * Syntax-only JSX copy scanner. Babel keeps this independent of the
 * TypeScript compiler API, which is absent from TypeScript 7.
 *
 * Policy and reporting intentionally match the original scanner; the
 * ratchet and its baseline remain in i18n-text-literals.test.ts.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type { Node } from "@babel/types";

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
const TWO_WORDS = /[A-Za-z][A-Za-z'’]+[ \t]+[A-Za-z][A-Za-z'’]+/;
const NON_COPY_TAGS = new Set([
  "code",
  "pre",
  "kbd",
  "samp",
  "style",
  "script",
]);
const EXCLUDED_DIRS = new Set(["vignettes"]);

export interface Finding {
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

function hasEnglishPhrase(text: string): boolean {
  let cleaned = text.replace(/&[#a-zA-Z0-9]+;/g, " ");
  for (const brand of BRAND_TOKENS) {
    cleaned = cleaned.split(brand).join(" ");
  }
  return TWO_WORDS.test(cleaned);
}

/** Parsed nodes always carry source offsets. Use the original source for
 * JSX text: Babel decodes entities, but the baseline stores e.g. &apos;. */
function sourceOf(node: Node, source: string): string {
  return source.slice(node.start!, node.end!);
}

function inSkippedJsxContext(nodePath: NodePath, source: string): boolean {
  let current = nodePath.parentPath;
  while (current) {
    if (current.isJSXElement()) {
      const opening = current.node.openingElement;
      if (NON_COPY_TAGS.has(sourceOf(opening.name, source))) {
        return true;
      }
      for (const attr of opening.attributes) {
        if (
          attr.type === "JSXAttribute" &&
          sourceOf(attr.name, source) === "aria-hidden" &&
          (!attr.value || sourceOf(attr.value, source) !== '"false"')
        ) {
          // Preserve the legacy exemption policy during this parser-only
          // migration: only the literal aria-hidden="false" opts back in.
          return true;
        }
      }
    }
    current = current.parentPath;
  }
  return false;
}

/** Only literal values that reach an element/fragment child through
 * display-transparent expressions count. Call arguments, comparison
 * operands, object properties and attribute values are outside this rule. */
function rendersAsJsxChild(nodePath: NodePath): boolean {
  let current = nodePath;
  let parent = current.parentPath;
  while (parent) {
    if (parent.isJSXExpressionContainer()) {
      const host = parent.parentPath;
      return host.isJSXElement() || host.isJSXFragment();
    }
    const transparent =
      (parent.isConditionalExpression() &&
        (parent.node.consequent === current.node ||
          parent.node.alternate === current.node)) ||
      parent.isLogicalExpression() ||
      (parent.isBinaryExpression() && parent.node.operator === "+") ||
      parent.isParenthesizedExpression() ||
      parent.isTemplateLiteral();
    if (!transparent) {
      return false;
    }
    current = parent;
    parent = current.parentPath;
  }
  return false;
}

function isExempt(lines: string[], lineNo: number): boolean {
  const here = lines[lineNo - 1] ?? "";
  const above = lines[lineNo - 2] ?? "";
  return here.includes(EXEMPT_MARKER) || above.includes(EXEMPT_MARKER);
}

/** Pure source-level entry point for fixture coverage, without registering
 * a node:test test or reading/updating the repository's debt baseline. */
export function scanSourceForHardcodedTextLiterals(
  sourceText: string,
  file: string
): Finding[] {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(sourceText, {
      sourceFilename: file,
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      createParenthesizedExpressions: true,
      errorRecovery: false,
    });
  } catch (error) {
    throw new Error(`Cannot scan JSX translations in ${file}`, {
      cause: error,
    });
  }

  const findings: Finding[] = [];
  const rawLines = sourceText.split("\n");
  const record = (node: Node, text: string) => {
    // Report the first English letter, not leading JSX whitespace.
    const offset =
      node.start! + Math.max(0, sourceOf(node, sourceText).search(/[A-Za-z]/));
    const line = sourceText
      .slice(0, offset)
      .split(/\r\n|[\n\r\u2028\u2029]/).length;
    if (!isExempt(rawLines, line)) {
      findings.push({
        file: path.relative(process.cwd(), file),
        line,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 100),
      });
    }
  };

  traverse(ast, {
    noScope: true,
    enter(nodePath: NodePath) {
      const { node } = nodePath;
      if (nodePath.isJSXText()) {
        const text = sourceOf(node, sourceText);
        if (
          hasEnglishPhrase(text) &&
          !inSkippedJsxContext(nodePath, sourceText)
        ) {
          record(node, text);
        }
      } else if (nodePath.isStringLiteral()) {
        if (
          hasEnglishPhrase(nodePath.node.value) &&
          rendersAsJsxChild(nodePath) &&
          !inSkippedJsxContext(nodePath, sourceText)
        ) {
          record(node, nodePath.node.value);
        }
      } else if (nodePath.isTemplateLiteral()) {
        // Check chunks separately: an interpolation must not join two
        // single words into a new phrase. Still visit interpolated JSX.
        const spans = nodePath.node.quasis.map(
          (quasi) => quasi.value.cooked ?? quasi.value.raw
        );
        if (
          spans.some(hasEnglishPhrase) &&
          rendersAsJsxChild(nodePath) &&
          !inSkippedJsxContext(nodePath, sourceText)
        ) {
          record(node, spans.join(" … "));
        }
      }
    },
  });
  return findings;
}

export function scanForHardcodedTextLiterals(root: string): Finding[] {
  return walk(root).flatMap((file) =>
    scanSourceForHardcodedTextLiterals(readFileSync(file, "utf8"), file)
  );
}

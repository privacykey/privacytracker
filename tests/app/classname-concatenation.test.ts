/**
 * A conditional class must not glue onto the class written before it.
 *
 * `className={`btn btn-secondary${busy ? "is-disabled" : ""}`}` renders
 * "btn btn-secondaryis-disabled" while busy: the element loses its button
 * style and never gets the disabled one. The pre-1.0 UX pass found twelve
 * of these (the backup restore label, the four import-history filters, the
 * dashboard editor's active preset pill and its cell, the accessibility key
 * on app detail and in Compare, three dev-menu controls), and this test
 * found five more (the activity log's live toggle and the focus matrix
 * cells, two each, and the settings auto-save toast's fade-out).
 *
 * Every JSX `className` template is parsed with Babel, as the translation
 * scanner does, and a text chunk ending in a letter or digit may not be
 * followed by an interpolation that can yield a class word with no leading
 * space. A chunk ending in `-` composes a class on purpose
 * (`pill-${on ? "on" : "off"}`) and is left alone; an interpolation whose
 * values the source does not spell out is not judged itself, but a class
 * glued straight after one (`cell-${kind}${drift ? "is-drift" : ""}`) is.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type { JSXAttribute, Node } from "@babel/types";

interface Finding {
  file: string;
  line: number;
  word: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      walk(file, out);
    } else if (file.endsWith(".tsx") && !file.endsWith(".stories.tsx")) {
      out.push(file);
    }
  }
  return out;
}

/** The strings an interpolation can yield, or null when the source does
 * not say (an identifier, a call). */
function yielded(node: Node): string[] | null {
  switch (node.type) {
    case "StringLiteral":
      return [node.value];
    case "ParenthesizedExpression":
      return yielded(node.expression);
    case "ConditionalExpression": {
      const whenTrue = yielded(node.consequent);
      const whenFalse = yielded(node.alternate);
      return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
    }
    case "LogicalExpression":
      // `cond && "word"` yields "word" or a falsy value React drops.
      return node.operator === "&&" ? yielded(node.right) : null;
    default:
      return null;
  }
}

function scanClassNames(sourceText: string, file: string): Finding[] {
  const ast = parse(sourceText, {
    sourceFilename: file,
    sourceType: "module",
    plugins: ["jsx", "typescript"],
    createParenthesizedExpressions: true,
    errorRecovery: false,
  });
  const findings: Finding[] = [];
  traverse(ast, {
    noScope: true,
    JSXAttribute(attributePath: NodePath<JSXAttribute>) {
      const { name, value } = attributePath.node;
      if (
        name.type !== "JSXIdentifier" ||
        name.name !== "className" ||
        value?.type !== "JSXExpressionContainer" ||
        value.expression.type !== "TemplateLiteral"
      ) {
        return;
      }
      const { quasis, expressions } = value.expression;
      // Can the text just before interpolation `i` end in a letter or
      // digit? An empty chunk hands the question to the interpolation
      // before it: a word it yields, or the text before it when it can
      // yield nothing (`toggle${a ? " x" : ""}${b ? "y" : ""}`). One whose
      // values the source does not spell out (`cell-${kind}`) yields a
      // class word, as far as a class template goes.
      const glued = (i: number): boolean => {
        const before = quasis[i].value.cooked ?? quasis[i].value.raw;
        if (before !== "" || i === 0) {
          return /[A-Za-z0-9]$/.test(before);
        }
        const previous = yielded(expressions[i - 1]);
        if (previous === null) {
          return true;
        }
        return (
          previous.some((word) => /[A-Za-z0-9]$/.test(word)) ||
          (previous.includes("") && glued(i - 1))
        );
      };
      expressions.forEach((expression, i) => {
        if (!glued(i)) {
          return;
        }
        for (const word of yielded(expression) ?? []) {
          if (/^[A-Za-z0-9]/.test(word)) {
            findings.push({
              file: path.relative(process.cwd(), file),
              line: expression.loc?.start.line ?? 0,
              word,
            });
          }
        }
      });
    },
  });
  return findings;
}

test("the scanner flags a conditional class glued onto the one before it", () => {
  const glued = `
const a = <b className={\`btn btn-secondary\${busy ? "is-disabled" : ""}\`} />;
const c = <b className={\`key\${
  ok ? "key-match" : ""
}\`} />;
const d = <b className={\`pill\${active && "is-active"}\`} />;
const e = <b className={\`toggle\${a ? "is-x" : ""}\${b ? "is-y" : ""}\`} />;
const f = <b className={\`cell cell-\${kind}\${drift ? "is-drift" : ""}\`} />;
`;
  assert.deepEqual(
    scanClassNames(glued, "fixture.tsx").map((f) => f.word),
    ["is-disabled", "key-match", "is-active", "is-x", "is-y", "is-drift"]
  );
});

test("the scanner leaves spaced classes and composed suffixes alone", () => {
  const fine = `
const a = <b className={\`btn btn-secondary\${busy ? " is-disabled" : ""}\`} />;
const b = <b className={\`pill pill-\${on ? "on" : "off"}\`} />;
const c = <b className={\`card \${kind}\`} />;
const d = <b className={\`tone\${variant}\`} />;
const e = <b className={\`toggle\${a ? " is-x" : ""}\${b ? " is-y" : ""}\`} />;
`;
  assert.deepEqual(scanClassNames(fine, "fixture.tsx"), []);
});

test("no JSX className template glues a conditional class onto another", () => {
  const findings = walk(path.join(process.cwd(), "app")).flatMap((file) =>
    scanClassNames(readFileSync(file, "utf8"), file)
  );
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} "${f.word}"`),
    [],
    "put the space inside the conditional string: ` is-active`"
  );
});

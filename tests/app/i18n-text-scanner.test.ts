import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  scanForHardcodedTextLiterals,
  scanSourceForHardcodedTextLiterals,
} from "../helpers/i18n-text-scanner";

const FIXTURE_FILE = path.join(process.cwd(), "fixture.tsx");
const scan = (source: string) =>
  scanSourceForHardcodedTextLiterals(source, FIXTURE_FILE);
const snippets = (source: string) => scan(source).map((item) => item.snippet);

test("visible text includes nested JSX and preserves entities and duplicate counts", () => {
  assert.deepEqual(
    snippets(`const view = <>
      <div>Couldn&apos;t load matrix:</div>
      <section><span>Try again</span><span>Try again</span></section>
    </>;`),
    ["Couldn&apos;t load matrix:", "Try again", "Try again"]
  );
});

test("rendered expression results include conditional, logical and concatenated copy", () => {
  assert.deepEqual(
    snippets(`const view = <>
      {ready ? "Ready now" : "Please wait"}
      {ready && "Start here"}
      {label || "Missing label"}
      {label ?? "Unknown label"}
      {("Showing results " + count)}
    </>;`),
    [
      "Ready now",
      "Please wait",
      "Start here",
      "Missing label",
      "Unknown label",
      "Showing results",
    ]
  );
});

test("translator keys, call arguments, comparisons and object data are not copy", () => {
  assert.deepEqual(
    snippets(`const view = <>
      {t("Translation key")}
      {tGrid("Grid key", { value: "Object value" })}
      {format("Data argument")}
      {mode === "Comparison operand" ? t("One key") : t("Other key")}
      {(() => { const label = "Local data"; return label; })()}
      {{label: "Object property"}.label}
      <span title="Attribute copy" aria-label={"Assistive copy"} />
    </>;`),
    []
  );
});

test("template chunks are checked independently and interpolated JSX is still visited", () => {
  assert.deepEqual(
    snippets(`const view = <>
      {\`Plain template\`}{\`Showing results \${count} right now\`}
      {\`First \${value} last\`}{\`First \${<span>Nested copy</span>} last\`}
      {tag\`Data template\`}
    </>;`),
    ["Plain template", "Showing results … right now", "Nested copy"]
  );
});

test("escaped string and template literals use their displayed values", () => {
  assert.deepEqual(
    snippets(
      String.raw`const view = <>{"Read\x20more"}{` +
        "`" +
        String.raw`\u0053how details` +
        "`}</>;"
    ),
    ["Read more", "Show details"]
  );
});

test("code and style contexts exclude nested content", () => {
  for (const tag of ["code", "pre", "kbd", "samp", "style", "script"]) {
    assert.deepEqual(
      snippets(
        `const view = <${tag}><span>Sample words</span>{"Other words"}</${tag}>;`
      ),
      [],
      tag
    );
  }
});

test("aria-hidden exemptions retain the existing source-level policy", () => {
  assert.deepEqual(
    snippets(`const view = <>
      <div aria-hidden="true"><span>Hidden words</span></div>
      <div aria-hidden><span>Hidden words</span></div>
      <div aria-hidden="false"><span>Visible words</span></div>
      <div aria-hidden={false}><span>Legacy exemption</span></div>
      <div aria-hidden={hidden}><span>Legacy exemption</span></div>
    </>;`),
    ["Visible words"]
  );
});

test("same-line and previous-line exemptions retain their scope", () => {
  assert.deepEqual(
    snippets(`const view = <>
      <span>Same line</span> {/* i18n-exempt: demonstration */}
      {/* i18n-exempt: demonstration */}
      <span>Previous line</span>
      <span>Report this</span>
    </>;`),
    ["Report this"]
  );
});

test("phrase detection retains brand and entity filtering", () => {
  assert.deepEqual(
    snippets(`const view = <>
      <span>App Store</span><span>Apple Configurator</span>
      <span>GitHub</span><span>Cancel</span><span>✓ 2026</span>
      <span>&amp;&nbsp;</span>
      <span>First &amp; last</span>
      <span>Open privacytracker settings</span>
    </>;`),
    ["First &amp; last", "Open privacytracker settings"]
  );
});

test("TypeScript generics, comments and comparison operators are parsed structurally", () => {
  assert.deepEqual(
    snippets(`const identity = <T,>(value: T): T => value;
      type Label = "Type words";
      // <div>Comment words</div>
      const view = <div>{count < 3 ? "Try again" : t("Enough results")}</div>;`),
    ["Try again"]
  );
});

test("findings report the first English letter and retain the snippet length limit", () => {
  const source = "const view = (\r\n<div>\r\n  ✓ First phrase\r\n</div>\r\n);";
  assert.deepEqual(scan(source), [
    { file: "fixture.tsx", line: 3, snippet: "✓ First phrase" },
  ]);
  assert.equal(
    scan(`const view = <div>${"Long phrase ".repeat(20)}</div>;`)[0].snippet
      .length,
    100
  );
});

test("invalid TSX fails with its filename instead of silently skipping the file", () => {
  assert.throws(
    () => scan("const view = <div>Broken words</span>;"),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("fixture.tsx") &&
      error.cause instanceof SyntaxError
  );
});

test("directory scans exclude stories and artwork while scanning nested TSX", () => {
  const root = mkdtempSync(path.join(tmpdir(), "i18n-scanner-"));
  try {
    mkdirSync(path.join(root, "nested"));
    mkdirSync(path.join(root, "vignettes"));
    writeFileSync(
      path.join(root, "nested", "View.tsx"),
      "const view = <div>Visible words</div>;"
    );
    // Invalid syntax proves excluded files are not parsed at all.
    writeFileSync(path.join(root, "View.stories.tsx"), "invalid {");
    writeFileSync(path.join(root, "vignettes", "Scene.tsx"), "invalid {");
    writeFileSync(path.join(root, "data.ts"), "invalid {");
    assert.deepEqual(scanForHardcodedTextLiterals(root), [
      {
        file: path.relative(
          process.cwd(),
          path.join(root, "nested", "View.tsx")
        ),
        line: 1,
        snippet: "Visible words",
      },
    ]);
    writeFileSync(path.join(root, "Bad.tsx"), "invalid {");
    assert.throws(() => scanForHardcodedTextLiterals(root), /Bad\.tsx/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

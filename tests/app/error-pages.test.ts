/**
 * app/error.tsx and app/global-error.tsx replace Next's bare "Application
 * error: a client-side exception has occurred" with a page that says what
 * happened and offers a way on: try again, go home, or report it.
 *
 * The components are rendered in a child process (see
 * tests/helpers/render-error-pages.tsx for why). The end-to-end check that
 * a real render error lands on them lives in tests/e2e/error-pages.spec.ts.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ERROR_REPORT_FALLBACK_HREF,
  errorReportHref,
} from "../../lib/error-report-link";

const worker = fileURLToPath(
  new URL("../helpers/render-error-pages.tsx", import.meta.url)
);

interface Rendered {
  en: string;
  global: string;
  zh: string;
}

let rendered: Rendered | null = null;
function render(): Rendered {
  if (!rendered) {
    const { NODE_OPTIONS: _drop, ...env } = process.env;
    const stdout = execFileSync(process.execPath, ["--import", "tsx", worker], {
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    rendered = JSON.parse(stdout) as Rendered;
  }
  return rendered;
}

const en = JSON.parse(
  readFileSync(path.join(process.cwd(), "locales", "en.json"), "utf8")
).error_page as Record<string, string>;
const zh = JSON.parse(
  readFileSync(path.join(process.cwd(), "locales", "zh.json"), "utf8")
).error_page as Record<string, string>;

/** React escapes text; compare against the escaped form. */
function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#x27;")
    .replaceAll('"', "&quot;");
}

test("error.tsx renders the translated message, a retry button, home and report links", () => {
  const html = render().en;
  for (const key of ["title", "body", "try_again", "home", "report"]) {
    assert.ok(html.includes(escaped(en[key])), `missing error_page.${key}`);
  }
  assert.match(html, /role="alert"/);
  assert.match(html, /<h1[^>]*id="app-error-title"/);
  assert.match(html, /<button[^>]*data-testid="app-error-retry"[^>]*>/);
  assert.match(html, /<a[^>]*href="\/"/);
  assert.ok(
    html.includes(escaped(ERROR_REPORT_FALLBACK_HREF)),
    "report link should start as the plain template before mount"
  );
});

test("error.tsx follows the active locale", () => {
  const html = render().zh;
  assert.ok(html.includes(escaped(zh.title)));
  assert.ok(html.includes(escaped(zh.try_again)));
  assert.ok(!html.includes(escaped(en.title)));
});

test("global-error.tsx renders its own document with no inline script", () => {
  const html = render().global;
  assert.match(html, /^<html lang="en">/);
  assert.match(html, /<body[^>]*>/);
  assert.match(html, /<title>Something went wrong/);
  assert.match(html, /<button[^>]*data-testid="global-error-retry"/);
  assert.match(html, /<a[^>]*href="\/"/);
  assert.ok(html.includes(escaped(ERROR_REPORT_FALLBACK_HREF)));
  // The hash-based CSP allowlists inline scripts per prerendered page; this
  // page must not add one of its own.
  assert.doesNotMatch(html, /<script/);
});

test("neither page shows the error's message", () => {
  const { en: routeHtml, global } = render();
  for (const html of [routeHtml, global]) {
    assert.ok(!html.includes("secret app name"));
  }
});

test("the report link carries the path only", () => {
  const href = errorReportHref("/dashboard/apps");
  const url = new URL(href);
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/privacykey/privacytracker/issues/new");
  assert.equal(url.searchParams.get("template"), "bug_report.yml");
  assert.equal(url.searchParams.get("report-type"), "Feature bug");
  assert.equal(url.searchParams.get("current-url"), "/dashboard/apps");
  assert.equal(url.searchParams.get("title"), "Error on /dashboard/apps");
});

test("the report link falls back to the plain template for odd paths", () => {
  for (const bad of [null, undefined, "", "dashboard", "//evil.example/x"]) {
    assert.equal(errorReportHref(bad), ERROR_REPORT_FALLBACK_HREF);
  }
  assert.equal(
    errorReportHref(`/${"a".repeat(300)}`),
    ERROR_REPORT_FALLBACK_HREF
  );
});

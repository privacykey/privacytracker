/**
 * Renders the History timeline fold's `timeline.fold_*` messages through
 * next-intl and prints them as JSON, for tests/app/timeline-fold.test.ts.
 *
 * Run in a child process WITHOUT `--conditions=react-server`: under that
 * condition next-intl's entry loads React's server build, which has no
 * client hooks, and the import fails before `createTranslator` is reached
 * (the same reason tests/helpers/render-error-pages.tsx is a child process).
 *
 * argv[2] is a JSON array of `{ key, values }` cases. The output is
 * `{ en: string[], zh: string[] }`, in the same order. A missing key or a
 * message that does not format throws, so the test fails loudly rather
 * than comparing against next-intl's fallback text.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createTranslator } from "next-intl";

interface Case {
  key: string;
  values: Record<string, string | number>;
}

const cases = JSON.parse(process.argv[2] ?? "[]") as Case[];
const root = process.cwd();

function messages(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(root, "locales", `${locale}.json`), "utf8")
  ) as Record<string, unknown>;
}

// Keys are checked by the test against the bundle, not by the compiler:
// with messages typed as a loose record, createTranslator infers `never`.
type LooseTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string;

function render(locale: string): string[] {
  const t = createTranslator({
    locale,
    messages: messages(locale),
    namespace: "timeline",
    onError(error) {
      throw error;
    },
  }) as unknown as LooseTranslator;
  return cases.map((c) => t(c.key, c.values));
}

process.stdout.write(JSON.stringify({ en: render("en"), zh: render("zh") }));

/**
 * Renders the two error pages to static HTML and prints them as JSON.
 *
 * Run by tests/app/error-pages.test.ts in a child process WITHOUT
 * `--conditions=react-server`: the unit-test runner loads React's server
 * build, which has no client hooks and no react-dom/server, so a client
 * component cannot be rendered in-process.
 *
 * CSS imports are stubbed, since Node cannot load a stylesheet.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
// Static imports on purpose: tsx compiles this file and the components to
// the same module format, so the provider and the components' hooks share
// one next-intl instance. A dynamic import() of next-intl here loads its
// other build, with a separate React context, and every useTranslations
// call throws.
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "commonjs", source: "", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const root = process.cwd();
const messages = (locale: string) =>
  JSON.parse(
    readFileSync(path.join(root, "locales", `${locale}.json`), "utf8")
  ) as Record<string, unknown>;

async function main() {
  // Loaded after the CSS hook is in place.
  const { default: ErrorBoundaryPage } = await import("../../app/error");
  const { default: GlobalError } = await import("../../app/global-error");

  const noop = () => undefined;
  const error = Object.assign(new Error("secret app name in a message"), {
    digest: "123",
  });

  const routeError = (locale: string) =>
    renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={messages(locale)}
        timeZone="UTC"
      >
        <ErrorBoundaryPage error={error} reset={noop} />
      </NextIntlClientProvider>
    );

  const out = {
    en: routeError("en"),
    zh: routeError("zh"),
    global: renderToStaticMarkup(<GlobalError error={error} reset={noop} />),
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

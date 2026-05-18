import {
  DocsContainer,
  type DocsContainerProps,
} from "@storybook/addon-docs/blocks";
import { NextIntlClientProvider } from "next-intl";
import type { PropsWithChildren } from "react";
import { useGlobals } from "storybook/preview-api";
import enMessages from "../messages/en";
import zhMessages from "../messages/zh";

const MESSAGES: Record<string, typeof enMessages> = {
  en: enMessages,
  zh: zhMessages,
};

const STATIC_NOW = new Date("2026-05-14T00:00:00.000Z");

/**
 * Wraps every MDX docs page with the same toolbar-driven theme + locale
 * logic the per-story decorators apply.
 *
 * MDX pages without `<Story>` blocks (our Foundations pages) don't run
 * story decorators — Storybook only invokes those for each Story block.
 * Without a custom docs container the Theme and Locale toolbars are
 * effectively no-ops on those pages.
 *
 * Using `useGlobals` here is allowed because the docs container renders
 * inside the preview iframe (same context as decorators), so the hook
 * subscribes to global updates and the container re-renders on every
 * toolbar flip.
 */
export function ThemedDocsContainer(
  props: PropsWithChildren<DocsContainerProps>
) {
  const [globals] = useGlobals();
  const theme = (globals.theme as string) || "system";
  const locale = (globals.locale as string) || "en";
  const messages = MESSAGES[locale] ?? MESSAGES.en;

  if (typeof document !== "undefined") {
    const html = document.documentElement;
    const current = html.getAttribute("data-theme-override");
    const next = theme === "system" ? null : theme;
    if (current !== next) {
      if (next === null) {
        html.removeAttribute("data-theme-override");
      } else {
        html.setAttribute("data-theme-override", next);
      }
    }
  }

  return (
    <DocsContainer context={props.context} theme={props.theme}>
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        now={STATIC_NOW}
        timeZone="UTC"
      >
        {props.children}
      </NextIntlClientProvider>
    </DocsContainer>
  );
}

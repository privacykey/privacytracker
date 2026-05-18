import {
  DocsContainer,
  type DocsContainerProps,
} from "@storybook/addon-docs/blocks";
import { NextIntlClientProvider } from "next-intl";
import { type PropsWithChildren, useEffect, useState } from "react";
import enMessages from "../messages/en";
import zhMessages from "../messages/zh";

const MESSAGES: Record<string, typeof enMessages> = {
  en: enMessages,
  zh: zhMessages,
};

const STATIC_NOW = new Date("2026-05-14T00:00:00.000Z");

interface GlobalsState {
  locale: string;
  theme: string;
}

const DEFAULTS: GlobalsState = { theme: "system", locale: "en" };

function readUrlGlobals(): GlobalsState {
  if (typeof window === "undefined") {
    return DEFAULTS;
  }
  const raw = new URL(window.location.href).searchParams.get("globals") ?? "";
  return {
    theme: /(?:^|;)theme:([^;]+)/.exec(raw)?.[1] ?? DEFAULTS.theme,
    locale: /(?:^|;)locale:([^;]+)/.exec(raw)?.[1] ?? DEFAULTS.locale,
  };
}

function applyThemeAttribute(theme: string): void {
  if (typeof document === "undefined") {
    return;
  }
  const html = document.documentElement;
  const current = html.getAttribute("data-theme-override");
  const next = theme === "system" ? null : theme;
  if (current === next) {
    return;
  }
  if (next === null) {
    html.removeAttribute("data-theme-override");
  } else {
    html.setAttribute("data-theme-override", next);
  }
}

/**
 * Wraps every MDX docs page with the same toolbar-driven theme + locale
 * logic the per-story decorators apply.
 *
 * MDX pages without `<Story>` blocks (our Foundations pages) don't run
 * story decorators — Storybook only invokes those for each Story block.
 * Without a custom docs container the Theme and Locale toolbars are
 * no-ops on those pages.
 *
 * Storybook 10 forbids `useGlobals()` outside decorators and story
 * functions, so the container subscribes to global changes via the
 * docs context's channel (Storybook fires `globalsUpdated` on every
 * toolbar flip). Initial values are parsed from the URL.
 */
export function ThemedDocsContainer(
  props: PropsWithChildren<DocsContainerProps>
) {
  const [globals, setGlobals] = useState<GlobalsState>(readUrlGlobals);
  applyThemeAttribute(globals.theme);

  useEffect(() => {
    // Re-read the URL on mount in case it changed before the container
    // hydrated. After that, the channel drives all updates.
    setGlobals(readUrlGlobals());

    const channel = (
      props.context as unknown as {
        channel?: {
          on: (event: string, cb: (data: unknown) => void) => void;
          off: (event: string, cb: (data: unknown) => void) => void;
        };
      }
    )?.channel;
    if (!channel?.on) {
      return;
    }

    const handler = (data: unknown) => {
      const payload = (data ?? {}) as { globals?: Partial<GlobalsState> };
      if (!payload.globals) {
        return;
      }
      setGlobals((prev) => ({
        theme: payload.globals?.theme ?? prev.theme,
        locale: payload.globals?.locale ?? prev.locale,
      }));
    };
    channel.on("globalsUpdated", handler);
    return () => channel.off("globalsUpdated", handler);
  }, [props.context]);

  const messages = MESSAGES[globals.locale] ?? MESSAGES.en;

  return (
    <DocsContainer context={props.context} theme={props.theme}>
      <NextIntlClientProvider
        locale={globals.locale}
        messages={messages}
        now={STATIC_NOW}
        timeZone="UTC"
      >
        {props.children}
      </NextIntlClientProvider>
    </DocsContainer>
  );
}

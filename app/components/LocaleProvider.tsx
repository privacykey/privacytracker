"use client";

import { NextIntlClientProvider } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  LOCALE_COOKIE,
  type SupportedLocale,
} from "@/lib/locale";

/**
 * Client-side locale resolution (Rust-core Phase 0, layout batch).
 *
 * Reads the `NEXT_LOCALE` cookie (set by POST /api/locale) in the
 * browser, dynamically imports that locale's bundle, and mounts
 * next-intl's client provider around the app. The server prerenders
 * with nothing inside (every page is a client shell already), so the
 * first paint waits on one cached JSON import instead of showing
 * English and then flipping — no hydration mismatch, no flash.
 *
 * `<html lang>` is set here too: the static document says "en" and this
 * corrects it as soon as the locale is known.
 */

type Messages = Record<string, unknown>;

function readCookieLocale(): SupportedLocale {
  if (typeof document === "undefined") {
    return DEFAULT_LOCALE;
  }
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
  const value = match
    ? decodeURIComponent(match.slice(LOCALE_COOKIE.length + 1))
    : "";
  return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}

async function loadMessages(locale: SupportedLocale): Promise<Messages> {
  // Explicit branches keep the bundler to two known chunks instead of a
  // glob over locales/.
  if (locale === "zh") {
    return (await import("../../locales/zh.json")).default as Messages;
  }
  return (await import("../../locales/en.json")).default as Messages;
}

export default function LocaleProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    locale: SupportedLocale;
    messages: Messages;
  } | null>(null);

  useEffect(() => {
    let live = true;
    const locale = readCookieLocale();
    loadMessages(locale)
      .catch(async (error) => {
        console.warn("[locale] bundle load failed, falling back:", error);
        return loadMessages(DEFAULT_LOCALE);
      })
      .then((messages) => {
        if (!live) {
          return;
        }
        document.documentElement.lang = locale;
        setState({ locale, messages });
      });
    return () => {
      live = false;
    };
  }, []);

  if (!state) {
    return null;
  }

  return (
    <NextIntlClientProvider
      locale={state.locale}
      messages={state.messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      {children}
    </NextIntlClientProvider>
  );
}

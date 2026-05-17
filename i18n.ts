/**
 * next-intl per-request server config (v4) — "without i18n routing" mode.
 * The app uses flat routes (no `[locale]` segments) and resolves the locale
 * from the `NEXT_LOCALE` cookie on every server-rendered request. Falls
 * back to `'en'` when no cookie is set, the value isn't in
 * SUPPORTED_LOCALES, or `cookies()` throws (e.g. build-time prerender).
 *
 * Adding a locale: drop a `locales/<code>.json` and append `<code>` to
 * SUPPORTED_LOCALES.
 */

import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

export const SUPPORTED_LOCALES = ["en", "zh"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isSupportedLocale(
  value: string | undefined | null
): value is SupportedLocale {
  return (
    value !== null &&
    value !== undefined &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export default getRequestConfig(async () => {
  let locale: SupportedLocale = DEFAULT_LOCALE;
  try {
    const store = await cookies();
    const value = store.get(LOCALE_COOKIE)?.value;
    if (isSupportedLocale(value)) {
      locale = value;
    }
  } catch {
    // `cookies()` throws outside a request scope (e.g. build-time prerender).
  }
  return {
    locale,
    messages: (await import(`./locales/${locale}.json`)).default,
  };
});

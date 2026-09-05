/**
 * Locale constants shared by the server i18n config and the client
 * LocaleProvider. Client-safe: no next/headers import here.
 *
 * Adding a locale: drop a `locales/<code>.json` and append `<code>`.
 */
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

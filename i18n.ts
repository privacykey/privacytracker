/**
 * next-intl server config (v4, "without i18n routing").
 *
 * Rust-core Phase 0 (layout batch): the server side is FIXED to the default
 * locale. It used to read the `NEXT_LOCALE` cookie per request, which made
 * every route dynamic — the one thing standing between the app and a
 * static bundle. The real locale is now resolved on the client by
 * `app/components/LocaleProvider.tsx`, which reads the same cookie and
 * loads the matching bundle; the only server-rendered copy left is
 * build-time English (generateMetadata titles, which RouteTitle then
 * localises client-side, and the <noscript> fallback).
 *
 * The constants live in lib/locale.ts so client code can import them
 * without dragging next/headers into the browser bundle.
 */

import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE } from "./lib/locale";

export {
  DEFAULT_LOCALE,
  isSupportedLocale,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "./lib/locale";

export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: (await import(`./locales/${DEFAULT_LOCALE}.json`)).default,
}));

"use client";

/**
 * LocaleSwitcher — segmented pill that swaps the UI language.
 *
 * Mounts inside the Settings → Language section. Was previously a
 * footer pill; moved alongside other personalisation controls so the
 * language choice lives next to the user's other "about me" prefs.
 *
 * Posts the chosen locale to `/api/locale` (which sets the
 * `NEXT_LOCALE` cookie) and reloads the page so server components
 * pick up the new message bundle. Reload is deliberate: server-
 * rendered pages render their copy at the request boundary, so a
 * router.refresh() alone wouldn't flush layouts that already
 * resolved messages this turn.
 *
 * Why a cookie-driven server reload (vs swapping messages on the
 * client): keeps every server component on the right bundle from
 * first paint. A pure-client switcher would force a flash-of-EN
 * for the first render after switching, then re-render in ZH.
 */

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { SupportedLocale } from "@/i18n";

interface LocaleOption {
  code: SupportedLocale;
  label: string;
  /** Native-language label so the user can find it even if the current
   *  UI is in a language they don't read. e.g. a Chinese user looking
   *  at the English UI can still spot "中文". */
  nativeLabel: string;
}

const LOCALE_OPTIONS: readonly LocaleOption[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "zh", label: "中文", nativeLabel: "中文" },
];

export default function LocaleSwitcher() {
  const tFooter = useTranslations("footer");
  // `null` until the GET probe returns; render nothing rather than
  // showing "EN" if the user is actually on ZH (the cookie hasn't
  // been re-read yet).
  const [active, setActive] = useState<SupportedLocale | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/locale");
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as { locale: SupportedLocale };
        if (!cancelled) {
          setActive(data.locale);
        }
      } catch {
        /* ignore; pill stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (active === null) {
    return null;
  }

  async function switchTo(locale: SupportedLocale) {
    if (busy || locale === active) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      if (!res.ok) {
        throw new Error("locale switch rejected");
      }
      // Hard reload so server-rendered surfaces flush to the new
      // message bundle. router.refresh() doesn't reliably re-execute
      // every layout-level await, especially for pages that read
      // i18n.ts via getTranslations() at the page boundary.
      window.location.reload();
    } catch (err) {
      console.error("[LocaleSwitcher] switch failed:", err);
      setBusy(false);
    }
  }

  return (
    <div
      aria-label={tFooter("language_label")}
      className="locale-switcher"
      role="group"
    >
      {LOCALE_OPTIONS.map((option) => {
        const isActive = option.code === active;
        return (
          <button
            aria-pressed={isActive}
            className={`locale-switcher__option ${isActive ? "is-active" : ""}`}
            disabled={busy}
            key={option.code}
            onClick={() => void switchTo(option.code)}
            title={option.nativeLabel}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

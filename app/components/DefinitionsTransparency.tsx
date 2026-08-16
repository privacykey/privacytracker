"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { countryLabel, DEFAULT_COUNTRY, normalizeCountry } from "@/lib/region";

/**
 * The country-dependent parts of /help/definitions (Rust-core Phase 0).
 *
 * That page is ~636 lines of static explanation whose ONLY database read
 * was `getSetting("app_country")`, feeding Apple's per-storefront
 * transparency-report link at two render sites. Rather than move the
 * whole body client-side, just these two blocks live here and fetch the
 * setting themselves from `GET /api/settings`.
 *
 * `appleLinks` still comes from the page: it derives from the ACTIVE
 * LOCALE, not from the database, and `getLocale()` is a next-intl call
 * rather than a `lib/` read — so it stays server-side like the page's
 * other translations.
 *
 * Until the setting lands the country falls back to DEFAULT_COUNTRY,
 * which is what `getSetting("app_country", DEFAULT_COUNTRY)` returned
 * for an unset value anyway — so the fallback render is a state the
 * server could already produce, not a new one.
 *
 * `lib/region` is pure data + helpers (no DB), which is why it can be
 * imported from a client component.
 */

const TRANSPARENCY_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "us",
  "au",
  "gb",
  "ca",
  "nz",
  "ie",
  "de",
  "fr",
  "it",
  "es",
  "nl",
  "se",
  "no",
  "dk",
  "fi",
  "pl",
  "ch",
  "at",
  "be",
  "pt",
  "jp",
  "kr",
  "hk",
  "tw",
  "sg",
  "in",
  "id",
  "ph",
  "my",
  "th",
  "vn",
  "ae",
  "sa",
  "il",
  "tr",
  "za",
  "mx",
  "br",
  "ar",
  "cl",
  "co",
  // Mainland China — Apple publishes the report at /legal/transparency/cn.html.
  // Without 'cn' in this set, cn-storefront users would fall through to the
  // global index even though a country-specific page exists.
  "cn",
]);

interface Transparency {
  countrySpecific: boolean;
  label: string;
  url: string;
}

/** Read the storefront country, then resolve Apple's report link for it.
 *  Mirrors the page's former `resolveTransparencyLink(country, links)`. */
function useTransparency(transparencyIndex: string): {
  country: string;
  transparency: Transparency;
} {
  const [country, setCountry] = useState(DEFAULT_COUNTRY);

  useEffect(() => {
    let live = true;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { app_country?: string } | null) => {
        if (live && json?.app_country) {
          setCountry(normalizeCountry(json.app_country));
        }
      })
      .catch(() => {
        // Keep DEFAULT_COUNTRY — the same value an unset setting gave.
      });
    return () => {
      live = false;
    };
  }, []);

  const transparency: Transparency = TRANSPARENCY_COUNTRY_CODES.has(country)
    ? {
        url: `https://www.apple.com/legal/transparency/${country}.html`,
        label: countryLabel(country),
        countrySpecific: true,
      }
    : {
        url: transparencyIndex,
        label: countryLabel(country),
        countrySpecific: false,
      };

  return { country, transparency };
}

/** The storefront paragraph + report link in the Transparency section. */
export function DefinitionsTransparencyBody({
  transparencyIndex,
}: {
  transparencyIndex: string;
}) {
  const t = useTranslations("help_definitions_page");
  const { country, transparency } = useTransparency(transparencyIndex);

  return (
    <>
      <p className="help-section-copy">
        {t("transparency_storefront_lead")}{" "}
        <strong>{countryLabel(country)}</strong>{" "}
        <span className="definitions-country-code">
          ({country.toUpperCase()})
        </span>
        {t("transparency_storefront_settings_lead")}{" "}
        <Link className="definitions-inline-link" href="/dashboard/settings">
          {t("transparency_storefront_settings_link")}
        </Link>
        .
      </p>
      <p className="help-section-copy">
        {transparency.countrySpecific ? (
          <>
            <a
              className="definitions-inline-link"
              href={transparency.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("transparency_country_link", { country: transparency.label })}
            </a>
            <span className="definitions-source-copy">
              {" "}
              {t("transparency_country_outro", {
                country: transparency.label,
              })}
            </span>
          </>
        ) : (
          <>
            <a
              className="definitions-inline-link"
              href={transparency.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("transparency_global_link")}
            </a>
            <span className="definitions-source-copy">
              {" "}
              {t("transparency_global_outro", { country: transparency.label })}
            </span>
          </>
        )}
      </p>
    </>
  );
}

/** The same link as one row of the Authoritative Sources list. */
export function DefinitionsTransparencySource({
  transparencyIndex,
}: {
  transparencyIndex: string;
}) {
  const tSrc = useTranslations("help_definitions_page.sources");
  const { transparency } = useTransparency(transparencyIndex);

  return (
    <li>
      <a
        className="definitions-inline-link"
        href={transparency.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        {transparency.countrySpecific
          ? tSrc("transparency_country_link", { country: transparency.label })
          : tSrc("transparency_global_link")}
      </a>
      <span className="definitions-source-copy">
        {" "}
        {tSrc("transparency_outro")}
      </span>
    </li>
  );
}

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
 * Both blocks render nothing until the setting resolves. Seeding with
 * DEFAULT_COUNTRY instead would flash "United States (US)" at an
 * au/gb/jp user before flipping — a wrong-country frame the server
 * render never produced. An unset or unreadable setting still resolves
 * to DEFAULT_COUNTRY, matching getSetting("app_country", DEFAULT_COUNTRY).
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
  country: string | null;
  transparency: Transparency;
} {
  // `null` until the setting lands. Seeding with DEFAULT_COUNTRY instead
  // would render "United States (US)" to an au/gb/jp user for a frame
  // and then flip — a wrong-country flash the server render never had.
  // Callers hold these blocks back while this is null.
  const [country, setCountry] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { app_country?: string } | null) => {
        if (live) {
          // An unset/unreadable setting resolves to DEFAULT_COUNTRY —
          // exactly what getSetting("app_country", DEFAULT_COUNTRY) gave.
          setCountry(
            json?.app_country
              ? normalizeCountry(json.app_country)
              : DEFAULT_COUNTRY
          );
        }
      })
      .catch(() => {
        if (live) {
          setCountry(DEFAULT_COUNTRY);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const resolved = country ?? DEFAULT_COUNTRY;
  const transparency: Transparency = TRANSPARENCY_COUNTRY_CODES.has(resolved)
    ? {
        url: `https://www.apple.com/legal/transparency/${resolved}.html`,
        label: countryLabel(resolved),
        countrySpecific: true,
      }
    : {
        url: transparencyIndex,
        label: countryLabel(resolved),
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

  if (!country) {
    return null;
  }
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
  const { country, transparency } = useTransparency(transparencyIndex);

  if (!country) {
    return null;
  }
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

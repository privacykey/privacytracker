import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import {
  categoryDescription,
  categoryLabel,
  severityLabel,
} from "../../../lib/i18n-meta";
import { CATEGORY_META, SEVERITY_CONFIG } from "../../../lib/privacy-meta";
import {
  countryLabel,
  DEFAULT_COUNTRY,
  normalizeCountry,
} from "../../../lib/region";
import { getSetting } from "../../../lib/scheduler";

export const metadata: Metadata = {
  title: "Privacy Label Definitions — privacytracker",
  description:
    "Definitions of Apple App Store privacy label terms — Data Used to Track You, Data Linked to You, Data Not Linked to You — and the data types developers may collect, with links to Apple\u2019s authoritative sources.",
};

// The page reads the stored storefront country from SQLite to build a
// country-specific transparency report link, so it must not be statically
// rendered at build time.
export const dynamic = "force-dynamic";

// External Apple references. Apple maintains parallel localised pages
// at /cn/ paths for the Chinese mainland audience — the App Privacy
// Details page, App Store privacy story, the privacy-labels overview,
// and the developer help all have first-class Chinese variants. The
// support article uses a `zh-cn/` locale prefix instead of a path
// segment, and the developer-help URL uses an inserted `/cn/` segment.
//
// We resolve the variant per active locale rather than per storefront
// because the locale is what determines what language the user can
// actually read. Country/storefront stays orthogonal — a US user with
// `zh` locale gets the Chinese pages; a Chinese-mainland user with
// `en` locale gets the English-language pages.
//
// Centralising both variants here keeps the rest of the page honest:
// if Apple moves any of these, we only change one file.
//
// Shared shape — each property is just `string`, not the literal URL
// value. We don't use `as const` here because that would make each
// constant a struct of *literal* string types (e.g. the labelsOverview
// field would be typed as the exact `'https://…/au/…'` string), which
// then can't be cross-assigned: the EN object's labelsOverview is
// "the AU URL" and the ZH object's is "the CN URL", and those
// literal types are incompatible. Typing the constants as `AppleLinks`
// flattens them to plain `string` properties so the per-locale picker
// can return either one without TS rejecting the assignment.
interface AppleLinks {
  accessibilityLabels: string;
  appStoreStory: string;
  developerDetails: string;
  labelsOverview: string;
  labelsSupport: string;
  transparencyIndex: string;
}

const APPLE_LINKS_BASE: AppleLinks = {
  labelsOverview: "https://www.apple.com/au/privacy/labels/",
  labelsSupport: "https://support.apple.com/en-us/102399",
  developerDetails:
    "https://developer.apple.com/app-store/app-privacy-details/",
  appStoreStory: "https://apps.apple.com/us/story/id1539235847",
  transparencyIndex: "https://www.apple.com/legal/transparency/",
  // Apple's "Overview of Accessibility Nutrition Labels" help page on
  // App Store Connect — the accessibility analogue of the App Privacy
  // Details page above. Surfaced at the top of this definitions page so
  // users exploring privacy labels can jump straight to the accessibility
  // equivalent. We link to the /help/ path (not /app-store/) because it
  // documents the actual per-label definitions developers must fill in,
  // which is the parallel of this page.
  accessibilityLabels:
    "https://developer.apple.com/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels",
};

const APPLE_LINKS_ZH: AppleLinks = {
  // /au/privacy/labels/ → /cn/privacy/labels/ — same page, Chinese
  // copy with mainland storefront examples.
  labelsOverview: "https://www.apple.com/cn/privacy/labels/",
  // support.apple.com uses a `zh-cn/` locale segment; the article id
  // (102399) is the same across locales.
  labelsSupport: "https://support.apple.com/zh-cn/102399",
  // /app-store/app-privacy-details/ → /cn/app-store/app-privacy-details/
  // — Apple's developer site treats /cn/ as a locale prefix.
  developerDetails:
    "https://developer.apple.com/cn/app-store/app-privacy-details/",
  // apps.apple.com routes /us/story/<id> → /cn/story/<id> for the same
  // editorial. We don't strip the trailing id segment because Apple
  // tolerates either form and the canonical link from the App Store
  // editor uses the id-suffixed shape.
  appStoreStory: "https://apps.apple.com/cn/story/id1539235847",
  // Apple publishes the transparency report per *country* (not per
  // language) — `/legal/transparency/<country>.html`. For ZH users
  // we point the global-fallback at the China page (`cn.html`) so a
  // Chinese reader hitting the catch-all link still lands on a
  // Chinese-language disclosure rather than the locale-folder index
  // I previously used (which Apple no longer reliably serves).
  // resolveTransparencyLink() still produces the same path for any
  // storefront that has its own page; this base only kicks in when
  // the storefront isn't in TRANSPARENCY_COUNTRY_CODES.
  transparencyIndex: "https://www.apple.com/legal/transparency/cn.html",
  // /help/... → /cn/help/... — Apple's developer help inserts the
  // locale segment after the host.
  accessibilityLabels:
    "https://developer.apple.com/cn/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels",
};

/**
 * Resolve Apple-link variants for the active locale. Right now we
 * only have two variants ('en' base + 'zh' for Simplified Chinese);
 * additional locales can join by extending the switch.
 */
function appleLinksForLocale(locale: string): AppleLinks {
  if (locale === "zh") {
    return APPLE_LINKS_ZH;
  }
  return APPLE_LINKS_BASE;
}

/**
 * Known Apple transparency-report country pages. Apple only publishes a
 * country-specific URL for the subset of storefronts listed in their legal
 * site navigation (e.g. /legal/transparency/au.html). For anything outside
 * this set we fall through to the global index and let Apple's page pick
 * the user's locale.
 *
 * This list is conservative — if Apple adds new countries we'll miss them
 * until someone updates it, but the global fallback still works. Intersection
 * with COUNTRY_OPTIONS in lib/region.ts means every item here is a valid
 * storefront the user could have selected.
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

function resolveTransparencyLink(
  country: string,
  appleLinks: AppleLinks
): {
  url: string;
  label: string;
  countrySpecific: boolean;
} {
  if (TRANSPARENCY_COUNTRY_CODES.has(country)) {
    return {
      url: `https://www.apple.com/legal/transparency/${country}.html`,
      label: countryLabel(country),
      countrySpecific: true,
    };
  }
  return {
    url: appleLinks.transparencyIndex,
    label: countryLabel(country),
    countrySpecific: false,
  };
}

/**
 * Resolve the "Back" link shown at the top of this page. Callers may pass a
 * `?from=` query param (a same-origin path) so users land back where they
 * came from instead of being dumped on the dashboard. An optional `?label=`
 * param provides a human-readable tail for the button ("← Back to {label}").
 *
 * Validation is conservative: `from` must start with `/` but not `//` (which
 * would be protocol-relative) and must not contain `:` or whitespace. Anything
 * unexpected falls back to `/dashboard`, matching the previous behaviour.
 */
function resolveBackLink(
  searchParams:
    | { from?: string | string[]; label?: string | string[] }
    | undefined
): { href: string; label: string } {
  const rawFrom = Array.isArray(searchParams?.from)
    ? searchParams?.from[0]
    : searchParams?.from;
  const rawLabel = Array.isArray(searchParams?.label)
    ? searchParams?.label[0]
    : searchParams?.label;

  const fromIsSafe =
    typeof rawFrom === "string" &&
    rawFrom.length > 0 &&
    rawFrom.length < 200 &&
    rawFrom.startsWith("/") &&
    !rawFrom.startsWith("//") &&
    !rawFrom.startsWith("/\\") &&
    !/[\s<>]/.test(rawFrom) &&
    // Reject anything that smells like a scheme (e.g. "/javascript:…"):
    !/[a-z][a-z0-9+.-]*:/i.test(rawFrom);

  const href = fromIsSafe ? (rawFrom as string) : "/dashboard";

  let label: string;
  if (typeof rawLabel === "string" && rawLabel.trim().length > 0) {
    label = rawLabel.trim().slice(0, 60);
  } else if (fromIsSafe) {
    const path = (rawFrom as string).split("?")[0];
    if (path.startsWith("/apps/")) {
      label = "app";
    } else if (path === "/dashboard/apps") {
      label = "Apps";
    } else if (path === "/dashboard/privacy") {
      label = "Privacy Map";
    } else if (path === "/dashboard/stats") {
      label = "Stats";
    } else if (path === "/dashboard/manual-apps") {
      label = "Manual apps";
    } else if (path === "/dashboard/settings") {
      label = "Settings";
    } else if (path === "/onboard") {
      label = "Onboarding";
    } else if (path === "/welcome") {
      label = "Welcome";
    } else if (path === "/privacy-policy") {
      label = "Privacy Policy";
    } else if (path === "/legal") {
      label = "Legal";
    } else {
      label = "Dashboard";
    }
  } else {
    label = "Dashboard";
  }

  return { href, label };
}

interface DefinitionsHelpPageProps {
  // Next.js 15+ made `searchParams` an async boundary — it's a Promise that
  // must be awaited. Without the Promise type, TS lets us read `.from`/`.label`
  // off an unresolved Promise at runtime, which silently returns `undefined`
  // and means the contextual back-link never resolves.
  searchParams?: Promise<{
    from?: string | string[];
    label?: string | string[];
  }>;
}

export default async function DefinitionsHelpPage({
  searchParams,
}: DefinitionsHelpPageProps) {
  if (resolveFlagFromDb("flag.help.label_definitions") !== "on") {
    notFound();
  }

  const resolvedSearchParams = (await searchParams) ?? undefined;
  const country = normalizeCountry(getSetting("app_country", DEFAULT_COUNTRY));
  // Resolve Apple link variants per active UI locale — `zh` users get
  // Apple's Simplified-Chinese pages, every other locale gets the
  // canonical English-language ones. The country-specific transparency
  // URL still flows through resolveTransparencyLink() as before; the
  // locale-aware set only affects the global-fallback link.
  const locale = await getLocale();
  const appleLinks = appleLinksForLocale(locale);
  const transparency = resolveTransparencyLink(country, appleLinks);
  const back = resolveBackLink(resolvedSearchParams);

  // i18n — every visible string on this page reads from one of:
  //   - `help_definitions_page`           (page chrome + section bodies)
  //   - `help_definitions_page.sections`  (the five section headings)
  //   - `help_definitions_page.severity_bodies` (per-card prose)
  //   - `help_definitions_page.sources`   (authoritative-sources list)
  //   - `category` / `category_descriptions` (data-type labels + bodies)
  //   - `severity`                        (severity tier labels)
  //
  // The Chinese translations follow Apple's published glossary at
  // developer.apple.com/cn/app-store/app-privacy-details/ — kept
  // verbatim so the page reads as the same vocabulary users see on
  // a real Chinese-store App Store listing.
  const t = await getTranslations("help_definitions_page");
  const tSec = await getTranslations("help_definitions_page.sections");
  const tBody = await getTranslations("help_definitions_page.severity_bodies");
  const tSrc = await getTranslations("help_definitions_page.sources");
  const tCategory = await getTranslations("category");
  const tCategoryDesc = await getTranslations("category_descriptions");
  const tSeverity = await getTranslations("severity");

  // Severity card-render data — pairs each SEVERITY_CONFIG entry with
  // its localised label + body so the JSX stays scannable. The body
  // key matches the `cls` property on SEVERITY_CONFIG (severity-track
  // / severity-linked / severity-unlinked) trimmed of the prefix —
  // gives us a single map for both class names and body lookups.
  const severityCards = [
    {
      cfg: SEVERITY_CONFIG.DATA_USED_TO_TRACK_YOU,
      key: "DATA_USED_TO_TRACK_YOU",
      bodyKey: "track" as const,
    },
    {
      cfg: SEVERITY_CONFIG.DATA_LINKED_TO_YOU,
      key: "DATA_LINKED_TO_YOU",
      bodyKey: "linked" as const,
    },
    {
      cfg: SEVERITY_CONFIG.DATA_NOT_LINKED_TO_YOU,
      key: "DATA_NOT_LINKED_TO_YOU",
      bodyKey: "unlinked" as const,
    },
  ];

  return (
    <div className="definitions-page">
      {/* Hero block intentionally lives OUTSIDE any card wrapper so the
          page reads the same as /legal and /privacy-policy — back link +
          external Apple reference on the top row, eyebrow / title /
          subtitle stacked below. See /app/legal/page.tsx and
          /app/privacy-policy/page.tsx for the shared pattern. */}
      <header className="definitions-page-hero">
        <div className="definitions-hero-top">
          <Link className="priv-back-link" href={back.href}>
            {t("back_to", { target: back.label })}
          </Link>
          {/* Apple's own accessibility-label reference, aligned opposite
              the back link so the page advertises the privacy ↔ accessibility
              parallel without crowding the title. */}
          <a
            aria-label={t("apple_accessibility_aria")}
            className="definitions-external-link"
            href={appleLinks.accessibilityLabels}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("apple_accessibility")}
          </a>
        </div>
        <p className="priv-eyebrow">{t("eyebrow")}</p>
        <h1 className="priv-page-title">{t("title")}</h1>
        <p className="priv-page-sub">{t("subtitle")}</p>
      </header>

      <div className="definitions-content">
        {/* ── Severity (data-handling) buckets ───────────────────────── */}
        <section className="help-section help-section-wide">
          <h2 className="help-section-title">
            {tSec("how_developers_declare")}
          </h2>
          <p className="help-section-copy">
            {tSec.rich("how_developers_intro", {
              em: (chunks) => <em>{chunks}</em>,
            })}
          </p>

          <div className="definitions-grid">
            {severityCards.map(({ cfg, key, bodyKey }) => (
              <article
                className={`definitions-card definitions-card-${cfg.cls}`}
                key={key}
              >
                <header className="definitions-card-header">
                  <span className={`severity-badge ${cfg.cls}`}>
                    <span aria-hidden="true">{cfg.icon}</span>{" "}
                    {severityLabel(tSeverity, key) ?? cfg.label}
                  </span>
                </header>
                <p className="definitions-card-copy">{tBody(bodyKey)}</p>
              </article>
            ))}
          </div>

          <p className="help-section-copy" style={{ marginTop: 18 }}>
            {t("labels_support_lead")}{" "}
            <a
              className="definitions-inline-link"
              href={appleLinks.labelsSupport}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("labels_support_link")}
            </a>
            .
          </p>
        </section>

        {/* ── Data categories ───────────────────────────────────────── */}
        <section className="help-section help-section-wide">
          <h2 className="help-section-title">{tSec("data_categories")}</h2>
          <p className="help-section-copy">{t("categories_intro")}</p>

          <ul className="definitions-category-list">
            {Object.entries(CATEGORY_META).map(([key, meta]) => (
              <li className="definitions-category-item" key={key}>
                <span aria-hidden="true" className="definitions-category-icon">
                  {meta.icon}
                </span>
                <div>
                  <div className="definitions-category-label">
                    {categoryLabel(tCategory, key) ?? meta.label}
                  </div>
                  <p className="definitions-category-copy">
                    {categoryDescription(tCategoryDesc, key) ??
                      meta.description}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <p className="help-section-copy" style={{ marginTop: 18 }}>
            {t("categories_outro_lead")}{" "}
            <a
              className="definitions-inline-link"
              href={appleLinks.developerDetails}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("developer_details_link")}
            </a>
            {t("categories_outro_mid")}{" "}
            <a
              className="definitions-inline-link"
              href={appleLinks.appStoreStory}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("app_store_story_link")}
            </a>
            .
          </p>
        </section>

        {/* ── Apple / built-in apps ──────────────────────────────────── */}
        <section className="help-section help-section-wide">
          <h2 className="help-section-title">{tSec("apple_own_apps")}</h2>
          <p className="help-section-copy">{t("apple_apps_body")}</p>
          <p className="help-section-copy">
            <a
              className="definitions-inline-link"
              href={appleLinks.labelsOverview}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("apple_apps_link")}
            </a>
          </p>
        </section>

        {/* ── Apple Transparency Report (country-specific) ──────────── */}
        <section className="help-section help-section-wide">
          <h2 className="help-section-title">{tSec("transparency_report")}</h2>
          <p className="help-section-copy">{t("transparency_intro")}</p>
          <p className="help-section-copy">
            {t("transparency_storefront_lead")}{" "}
            <strong>{countryLabel(country)}</strong>{" "}
            <span className="definitions-country-code">
              ({country.toUpperCase()})
            </span>
            {t("transparency_storefront_settings_lead")}{" "}
            <Link
              className="definitions-inline-link"
              href="/dashboard/settings"
            >
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
                  {t("transparency_country_link", {
                    country: transparency.label,
                  })}
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
                  {t("transparency_global_outro", {
                    country: transparency.label,
                  })}
                </span>
              </>
            )}
          </p>
        </section>

        {/* ── Authoritative sources ─────────────────────────────────── */}
        <section className="help-section help-section-wide">
          <h2 className="help-section-title">
            {tSec("authoritative_sources")}
          </h2>
          <p className="help-section-copy">{t("sources_intro")}</p>
          <ul className="definitions-source-list">
            <li>
              <a
                className="definitions-inline-link"
                href={appleLinks.labelsSupport}
                rel="noopener noreferrer"
                target="_blank"
              >
                {tSrc("labels_support_link")}
              </a>
              <span className="definitions-source-copy">
                {" "}
                {tSrc("labels_support_outro")}
              </span>
            </li>
            <li>
              <a
                className="definitions-inline-link"
                href={appleLinks.developerDetails}
                rel="noopener noreferrer"
                target="_blank"
              >
                {tSrc("developer_details_link")}
              </a>
              <span className="definitions-source-copy">
                {" "}
                {tSrc("developer_details_outro")}
              </span>
            </li>
            <li>
              <a
                className="definitions-inline-link"
                href={appleLinks.labelsOverview}
                rel="noopener noreferrer"
                target="_blank"
              >
                {tSrc("labels_overview_link")}
              </a>
              <span className="definitions-source-copy">
                {" "}
                {tSrc("labels_overview_outro")}
              </span>
            </li>
            <li>
              <a
                className="definitions-inline-link"
                href={appleLinks.appStoreStory}
                rel="noopener noreferrer"
                target="_blank"
              >
                {tSrc("story_link")}
              </a>
              <span className="definitions-source-copy">
                {" "}
                {tSrc("story_outro")}
              </span>
            </li>
            <li>
              <a
                className="definitions-inline-link"
                href={transparency.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {transparency.countrySpecific
                  ? tSrc("transparency_country_link", {
                      country: transparency.label,
                    })
                  : tSrc("transparency_global_link")}
              </a>
              <span className="definitions-source-copy">
                {" "}
                {tSrc("transparency_outro")}
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

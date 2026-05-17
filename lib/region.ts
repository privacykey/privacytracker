/**
 * iTunes Search / App Store storefront regions.
 *
 * Apple's `country` parameter uses ISO 3166-1 alpha-2 codes (lower-case on the
 * iTunes Search API). We keep a hand-picked list of the most common App Store
 * storefronts — the full list is ~175 entries but most users only need a dozen
 * or so. If you need a region that isn't here, add it to COUNTRY_OPTIONS below.
 *
 * Default is 'us' because that's what the iTunes Search API falls back to when
 * no country is provided, which matches the original behaviour.
 */

export interface CountryOption {
  /** ISO 3166-1 alpha-2, lower-case — what Apple expects in the URL. */
  code: string;
  /** Human-friendly label for pickers. */
  label: string;
}

export const COUNTRY_OPTIONS: CountryOption[] = [
  { code: "us", label: "United States" },
  { code: "au", label: "Australia" },
  { code: "gb", label: "United Kingdom" },
  { code: "ca", label: "Canada" },
  { code: "nz", label: "New Zealand" },
  { code: "ie", label: "Ireland" },
  { code: "de", label: "Germany" },
  { code: "fr", label: "France" },
  { code: "it", label: "Italy" },
  { code: "es", label: "Spain" },
  { code: "nl", label: "Netherlands" },
  { code: "se", label: "Sweden" },
  { code: "no", label: "Norway" },
  { code: "dk", label: "Denmark" },
  { code: "fi", label: "Finland" },
  { code: "pl", label: "Poland" },
  { code: "ch", label: "Switzerland" },
  { code: "at", label: "Austria" },
  { code: "be", label: "Belgium" },
  { code: "pt", label: "Portugal" },
  { code: "jp", label: "Japan" },
  { code: "kr", label: "South Korea" },
  { code: "cn", label: "China mainland" },
  { code: "hk", label: "Hong Kong" },
  { code: "tw", label: "Taiwan" },
  { code: "sg", label: "Singapore" },
  { code: "in", label: "India" },
  { code: "id", label: "Indonesia" },
  { code: "ph", label: "Philippines" },
  { code: "my", label: "Malaysia" },
  { code: "th", label: "Thailand" },
  { code: "vn", label: "Vietnam" },
  { code: "ae", label: "United Arab Emirates" },
  { code: "sa", label: "Saudi Arabia" },
  { code: "il", label: "Israel" },
  { code: "tr", label: "Turkey" },
  { code: "za", label: "South Africa" },
  { code: "mx", label: "Mexico" },
  { code: "br", label: "Brazil" },
  { code: "ar", label: "Argentina" },
  { code: "cl", label: "Chile" },
  { code: "co", label: "Colombia" },
];

const VALID_CODES = new Set(COUNTRY_OPTIONS.map((o) => o.code));

export const DEFAULT_COUNTRY = "us";

/**
 * Normalises a raw country input to a known lower-case code, or falls back to
 * the default if the input is missing or unrecognised. Accepts any casing and
 * trims whitespace; also tolerates the occasional 3-letter ISO code by
 * truncating. We never reject — a bad value silently becomes 'us' so searches
 * keep working.
 */
export function normalizeCountry(input: unknown): string {
  if (typeof input !== "string") {
    return DEFAULT_COUNTRY;
  }
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return DEFAULT_COUNTRY;
  }
  // Allow 3-letter ISO alpha-3 code by slicing to the first two letters of
  // the closest matching alpha-2 (works for common cases like 'usa' → 'us').
  const candidate = trimmed.length > 2 ? trimmed.slice(0, 2) : trimmed;
  return VALID_CODES.has(candidate) ? candidate : DEFAULT_COUNTRY;
}

/**
 * Resolves a label for a country code (or returns the code itself upper-cased
 * if unknown).
 */
export function countryLabel(code: string): string {
  return (
    COUNTRY_OPTIONS.find((o) => o.code === code)?.label ?? code.toUpperCase()
  );
}

/**
 * Best-effort client-side storefront inference for first-run onboarding.
 * Locale wins when it includes a supported region subtag; timezone fills in
 * common cases where browsers report a generic language such as "en".
 */
export function inferCountryFromLocale(
  locale?: string | null,
  timeZone?: string | null
): string | null {
  const localeRegion =
    typeof locale === "string"
      ? locale.trim().split(/[-_]/).at(1)?.toLowerCase()
      : null;
  if (localeRegion && VALID_CODES.has(localeRegion)) {
    return localeRegion;
  }

  const tz = typeof timeZone === "string" ? timeZone : "";
  const timeZoneHints: [RegExp, string][] = [
    [/^Australia\//, "au"],
    [/^Pacific\/Auckland$/, "nz"],
    [/^Europe\/London$/, "gb"],
    [/^Europe\/Dublin$/, "ie"],
    [/^Europe\/Berlin$/, "de"],
    [/^Europe\/Paris$/, "fr"],
    [/^Europe\/Rome$/, "it"],
    [/^Europe\/Madrid$/, "es"],
    [/^Europe\/Amsterdam$/, "nl"],
    [/^America\/Toronto$|^America\/Vancouver$|^America\/Montreal$/, "ca"],
    [/^America\/Mexico_City$/, "mx"],
    [/^America\/Sao_Paulo$/, "br"],
    [/^Asia\/Tokyo$/, "jp"],
    [/^Asia\/Seoul$/, "kr"],
    [/^Asia\/Singapore$/, "sg"],
    [/^Asia\/Shanghai$/, "cn"],
    [/^Asia\/Hong_Kong$/, "hk"],
    [/^Asia\/Taipei$/, "tw"],
  ];
  for (const [pattern, code] of timeZoneHints) {
    if (pattern.test(tz) && VALID_CODES.has(code)) {
      return code;
    }
  }
  return null;
}

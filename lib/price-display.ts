/**
 * Client-safe helpers for rendering the price + IAP chip. Surfaces
 * Apple's localised `formattedPrice` verbatim so the chip matches the
 * App Store listing. `formatPriceLine` returns null when there's no
 * price data — UI should hide the chip rather than guess "Free".
 *
 * Both renderers take a `price_chip`-scoped translator (the loose
 * `(key, values?) => string` shape — see `lib/i18n-meta.ts`) so the
 * copy localises without this module importing React or next-intl.
 */

export interface PriceFields {
  hasIap?: number | null;
  priceAmount?: number | null;
  priceCurrency?: string | null;
  priceFormatted?: string | null;
}

/** Minimal translator shape — pass a `useTranslations("price_chip")` result. */
type PriceChipTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string;

/** Has the lookup successfully populated a price string? */
export function hasPriceData(p: PriceFields): boolean {
  return typeof p.priceFormatted === "string" && p.priceFormatted.length > 0;
}

/**
 * Build the chip text. Combines the formatted price with an IAP
 * indicator (`line_iap`) when `hasIap === 1`. Returns null when
 * there's no price data. `hasIap === 0` and `hasIap === null` both
 * collapse to no suffix — IAP detection is best-effort, so absence is
 * silent.
 */
export function formatPriceLine(
  t: PriceChipTranslator,
  p: PriceFields
): string | null {
  if (!hasPriceData(p)) {
    return null;
  }
  const base = p.priceFormatted!;
  if (p.hasIap === 1) {
    return t("line_iap", { price: base });
  }
  return base;
}

/** Tooltip copy for the price chip, spelling out each part in plain language. */
export function priceTooltip(t: PriceChipTranslator, p: PriceFields): string {
  if (!hasPriceData(p)) {
    return t("tooltip_no_data");
  }
  const parts: string[] = [];
  parts.push(
    p.priceAmount && p.priceAmount > 0
      ? t("tooltip_paid", { price: p.priceFormatted! })
      : t("tooltip_free")
  );
  if (p.hasIap === 1) {
    parts.push(t("tooltip_iap_yes"));
  } else if (p.hasIap === 0) {
    parts.push(t("tooltip_iap_no"));
  }
  return parts.join(" ");
}

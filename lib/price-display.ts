/**
 * Client-safe helpers for rendering the price + IAP chip. Surfaces
 * Apple's localised `formattedPrice` verbatim so the chip matches the
 * App Store listing. `formatPriceLine` returns null when there's no
 * price data — UI should hide the chip rather than guess "Free".
 */

export interface PriceFields {
  hasIap?: number | null;
  priceAmount?: number | null;
  priceCurrency?: string | null;
  priceFormatted?: string | null;
}

/** Has the lookup successfully populated a price string? */
export function hasPriceData(p: PriceFields): boolean {
  return typeof p.priceFormatted === "string" && p.priceFormatted.length > 0;
}

/**
 * Build the chip text. Combines the formatted price with an IAP
 * indicator when `hasIap === 1`. Returns null when there's no price
 * data. `hasIap === 0` and `hasIap === null` both collapse to no
 * suffix — IAP detection is best-effort, so absence is silent.
 */
export function formatPriceLine(p: PriceFields): string | null {
  if (!hasPriceData(p)) {
    return null;
  }
  const base = p.priceFormatted!;
  if (p.hasIap === 1) {
    return `${base} · IAP`;
  }
  return base;
}

/** Tooltip copy for the price chip, spelling out each part in plain English. */
export function priceTooltip(p: PriceFields): string {
  if (!hasPriceData(p)) {
    return "No pricing data captured yet.";
  }
  const parts: string[] = [];
  parts.push(
    p.priceAmount && p.priceAmount > 0
      ? `Costs ${p.priceFormatted} on the App Store.`
      : "Free to download from the App Store."
  );
  if (p.hasIap === 1) {
    parts.push(
      "Offers in-app purchases — features or content can be unlocked for additional payment."
    );
  } else if (p.hasIap === 0) {
    parts.push("No in-app purchases reported on the listing.");
  }
  return parts.join(" ");
}

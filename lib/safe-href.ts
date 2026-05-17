/**
 * Client-safe URL guard for `<a href={…}>` and `<img src={…}>` rendering.
 *
 * Returns true only for http(s) URLs. Blocks `javascript:`, `data:`,
 * `file:`, custom schemes, and anything that doesn't parse as a URL.
 *
 * The server-side ingest path (lib/security.ts → `sanitizePolicyUrl`,
 * `validateAppStoreUrl`, etc.) already filters URLs before they hit
 * the DB. This is the rendering-side equivalent: defence in depth for
 * legacy rows written before the sanitiser existed, and any future
 * field that arrives at a clickable surface without going through the
 * ingest sanitisers.
 *
 * Kept zero-dependency so client components can import it without
 * pulling in node:crypto / node:dns from lib/security.ts.
 */
export function isSafeExternalHref(href: string | undefined | null): boolean {
  if (typeof href !== "string" || !href.trim()) {
    return false;
  }
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

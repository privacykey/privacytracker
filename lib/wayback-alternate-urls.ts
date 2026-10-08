/**
 * Older App Store addresses for one app (docs/WAYBACK_IMPORT.md, P5).
 *
 * When an app's archived history starts late, often because the app was
 * renamed and its older pages sit under the old address, the detail card
 * lets the person add up to three older apps.apple.com addresses for the
 * same app. `POST /api/apps/[id]/import-history` takes the whole list as
 * `alternateUrls`, stores it, and the import merges the captures of every
 * address. The route is the authority (a bad entry is a 400
 * `invalid_alternate_url`); this only catches the obvious mistakes before
 * a request is sent.
 *
 * Pure and client-safe.
 */

/** The most older addresses the route accepts for one app. */
export const MAX_ALTERNATE_URLS = 3;

/** Why an address cannot be added. `rejected` is the route's 400. */
export type AlternateUrlProblem =
  | "not_app_store"
  | "other_app"
  | "duplicate"
  | "limit"
  | "rejected";

export type AlternateUrlCheck =
  | { ok: true; url: string }
  | { ok: false; problem: AlternateUrlProblem };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const STOREFRONT = /^[a-z]{2}$/i;
const TRACK_ID = /^(?:id|ID)(\d+)$/;

/**
 * An older address in the one shape the route stores, and so the shape
 * this checks for: `https://apps.apple.com/<storefront>/app/<slug>/id<n>`
 * with a lowercase two-letter storefront (`canonical_app_store_address`
 * in core/src/scrape/wayback.rs). Spaces, a trailing slash, a query and a
 * fragment are forgiven and dropped; a missing scheme is taken as https,
 * since people paste "apps.apple.com/…" as often as the full link, and
 * http is lifted to https. Null for anything else.
 */
export function canonicalAppStoreUrl(raw: string): string | null {
  let text = raw.trim();
  if (!text || text.length > 2048) {
    return null;
  }
  if (!SCHEME.test(text)) {
    text = `https://${text}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.hostname !== "apps.apple.com" ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return null;
  }
  const segments = parsed.pathname.split("/").slice(1);
  if (segments.at(-1) === "") {
    segments.pop();
  }
  if (segments.length !== 4) {
    return null;
  }
  const [storefront, app, slug, track] = segments;
  const id = TRACK_ID.exec(track)?.[1];
  if (!(STOREFRONT.test(storefront) && app === "app" && slug && id)) {
    return null;
  }
  return `https://apps.apple.com/${storefront.toLowerCase()}/app/${slug}/id${id}`;
}

/** The numeric App Store id at the end of a product address. */
export function appIdOfAppStoreUrl(url: string): string | null {
  const canonical = canonicalAppStoreUrl(url);
  return canonical ? (/\/id(\d+)$/.exec(canonical)?.[1] ?? null) : null;
}

const sameAddress = (a: string, b: string) =>
  (canonicalAppStoreUrl(a) ?? a).toLowerCase() ===
  (canonicalAppStoreUrl(b) ?? b).toLowerCase();

/**
 * Whether `raw` can be added to the app's older addresses: an App Store
 * product address, for this app's id, not already checked (as an older
 * address or as the address the import looked up), with room left.
 */
export function checkAlternateUrl(
  raw: string,
  {
    appId,
    existing,
    lookupUrl = null,
  }: {
    appId: string;
    existing: readonly string[];
    lookupUrl?: string | null;
  }
): AlternateUrlCheck {
  const url = canonicalAppStoreUrl(raw);
  if (!url) {
    return { ok: false, problem: "not_app_store" };
  }
  if (appIdOfAppStoreUrl(url) !== String(appId)) {
    return { ok: false, problem: "other_app" };
  }
  const taken = lookupUrl ? [...existing, lookupUrl] : [...existing];
  if (taken.some((other) => sameAddress(other, url))) {
    return { ok: false, problem: "duplicate" };
  }
  if (existing.length >= MAX_ALTERNATE_URLS) {
    return { ok: false, problem: "limit" };
  }
  return { ok: true, url };
}

/** The list to post when adding an address. */
export function withAlternateUrl(
  existing: readonly string[],
  url: string
): string[] {
  return [...existing, url];
}

/** The list to post when removing one; empty clears them all. */
export function withoutAlternateUrl(
  existing: readonly string[],
  url: string
): string[] {
  return existing.filter((other) => other !== url);
}

/** The route's 400 for an address it will not store. */
export function isAlternateUrlRejection(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === "invalid_alternate_url"
  );
}

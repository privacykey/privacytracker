/**
 * Transient (non-persisting) App Store scraper for the Compare feature.
 *
 * Why this exists: `fetchAndParseApp` in lib/scraper.ts always writes to the
 * DB, creates notifications, and mutates apps.changeCount. Compare lets users
 * evaluate an App Store candidate *before* committing to track it, so we
 * need a path that returns parsed privacy data without any of those side
 * effects.
 *
 * IMPORTANT: The privacy-item extraction here mirrors the logic in
 * lib/scraper.ts's `saveToDb`. If Apple's page structure changes and you fix
 * the fallback chain there, mirror the fix here too — both paths parse the
 * same HTML.
 */

import {
  type AccessibilityFeatureRecord,
  extractAccessibilityFeatures,
} from "./accessibility";
import type { PrivacyTypeSnapshot } from "./changelog";
import { AppleRateLimitError } from "./scraper";
import { safeFetch, sanitizePolicyUrl, validateAppStoreUrl } from "./security";

const APPLE_HOSTS = ["apps.apple.com", "itunes.apple.com"];
const APP_STORE_MAX_BYTES = 4 * 1024 * 1024;

export interface ComparePreview {
  /**
   * Accessibility features declared on Apple's a11y nutrition-labels shelf.
   * Mirrors the same shape `buildAccessibilitySnapshot` emits for tracked
   * apps, so CompareAppsView can render one widget for both slot sources.
   * Empty array means the shelf is present but declares nothing.
   */
  accessibilityFeatures: AccessibilityFeatureRecord[];
  appleId: string;
  developer: string;
  /**
   * Tri-state mirror of `apps.hasAccessibilityLabels`:
   *   1    — at least one feature declared
   *   0    — shelf present but declares nothing
   *   null — shelf absent in the scraped payload
   */
  hasAccessibilityLabels: number | null;
  /**
   * True when Apple shows the explicit "No Details Provided" shelf. Lets the
   * UI render the standard Apple copy instead of a generic empty state.
   */
  hasPrivacyDetails: number | null;
  iconUrl: string;
  name: string;
  privacyPolicyUrl: string;
  /** Parsed privacy tree — same shape as buildSnapshot returns for stored apps. */
  privacyTypes: PrivacyTypeSnapshot[];
  url: string;
}

/**
 * Fetch an App Store product page and parse just enough to compare it side
 * by side with another app. Does NOT touch the database, does NOT request a
 * policy summary (those are the expensive, stateful paths).
 */
export async function fetchAndParsePreview(
  url: string
): Promise<ComparePreview> {
  const verdict = validateAppStoreUrl(url);
  if (!(verdict.ok && verdict.url)) {
    throw new Error(
      `Rejected URL (${verdict.error ?? "invalid_url"}): ${verdict.detail ?? url}`
    );
  }

  const { response: req, body: htmlBuf } = await safeFetch(
    verdict.url.toString(),
    {
      allowedHosts: APPLE_HOSTS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeoutMs: 15_000,
      maxBytes: APP_STORE_MAX_BYTES,
      redirect: "follow",
    }
  );

  if (req.status === 429) {
    // Surface the same typed error fetchAndParseApp uses so the compare
    // route can report a 429 back cleanly rather than generic 500.
    throw new AppleRateLimitError(70_000);
  }
  if (!req.ok) {
    throw new Error(`HTTP ${req.status} fetching App Store page`);
  }

  const html = htmlBuf.toString("utf8");

  // ── Name (og:title, cleaned of Apple marketing suffixes) ──
  let name = "Unknown App";
  const nameMatch = html.match(
    /<meta\s+property="og:title"\s+content="([^"]+)"/i
  );
  if (nameMatch) {
    name = nameMatch[1].replace(/ on the App Store$/i, "").trim();
  }

  // ── Icon ──
  let iconUrl = "";
  const iconMatch = html.match(
    /<meta\s+property="og:image"\s+content="([^"]+)"/i
  );
  if (iconMatch) {
    iconUrl = iconMatch[1];
  }

  // ── Apple ID ──
  const idMatch = url.match(/\/id([0-9]+)/i);
  const appleId = idMatch ? idMatch[1] : "";

  // ── Developer ──
  let developer = "";
  const devMatch = html.match(
    /"author"\s*:\s*\{\s*"@type"[^}]*"name"\s*:\s*"([^"]+)"/
  );
  if (devMatch) {
    developer = devMatch[1];
  }

  // ── Privacy Policy URL ──
  // Supports both ' (straight) and ’ (curly) apostrophes — Apple's HTML
  // mixes them depending on locale. See the matching code in scraper.ts —
  // these patterns are deliberately bounded with `{0,2048}?` rather than
  // `[^]*?` so a pathological body can't drive catastrophic backtracking.
  let privacyPolicyUrl = "";
  const ariaMatch =
    html.match(
      /<a\s+[^<>]{0,2048}?aria-label="Developer[’']s Privacy Policy"[\s\S]{0,2048}?href="([^"]+)"/i
    ) ||
    html.match(
      /<a\s+[\s\S]{0,2048}?href="([^"]+)"[\s\S]{0,2048}?aria-label="Developer[’']s Privacy Policy"/i
    );
  if (ariaMatch) {
    privacyPolicyUrl = ariaMatch[1];
  } else {
    const sectionMatch = html.match(
      /id="notPurchasedLinks"[\s\S]*?<a\s+[^>]*?href="([^"]+)"[^>]*?>\s*Privacy Policy\s*<\/a>/i
    );
    if (sectionMatch) {
      privacyPolicyUrl = sectionMatch[1];
    }
  }
  privacyPolicyUrl = sanitizePolicyUrl(privacyPolicyUrl);

  // ── Privacy JSON payload ──
  const jsonMatch = html.match(
    /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!jsonMatch) {
    throw new Error("No serialized-server-data script found in App Store page");
  }

  let data: any;
  try {
    const raw = JSON.parse(jsonMatch[1]);
    data = Array.isArray(raw) ? raw : (raw.data ?? []);
  } catch {
    throw new Error("Failed to parse serialized-server-data JSON");
  }

  // Prefer clean JSON title over og:title when available.
  const jsonTitle: string | undefined = data[0]?.data?.title;
  if (jsonTitle) {
    name = jsonTitle.trim();
  }

  const privacyTypes = extractPrivacyTypesFromRaw(data);
  const hasPrivacyDetails = privacyTypes.length > 0 ? 1 : null;

  // Accessibility shelf — reuse the shared extractor so Compare previews
  // behave exactly like the persistent scraper: tri-state hasAccessibility
  // (null = absent shelf, 0 = shelf present but empty, 1 = features listed)
  // so the UI can tell "developer hasn't filed anything" apart from
  // "couldn't scrape".
  const rawAccessibility = extractAccessibilityFeatures(data);
  const accessibilityFeatures: AccessibilityFeatureRecord[] =
    rawAccessibility ?? [];
  const hasAccessibilityLabels: number | null =
    rawAccessibility === null ? null : accessibilityFeatures.length > 0 ? 1 : 0;

  return {
    appleId,
    name,
    iconUrl,
    developer,
    privacyPolicyUrl,
    url: verdict.url.toString(),
    privacyTypes,
    hasPrivacyDetails,
    accessibilityFeatures,
    hasAccessibilityLabels,
  };
}

/**
 * Walk the parsed Apple payload and produce a PrivacyTypeSnapshot[].
 * The fallback chain matches `saveToDb` in lib/scraper.ts: product-page shelf
 * first, then privacyHeader detail shelves (with legacy nested purposes
 * flattened), then generic pageData.
 */
function extractPrivacyTypesFromRaw(rawData: any): PrivacyTypeSnapshot[] {
  let privacyItems: any[] = [];
  try {
    const shelfMap = rawData?.[0]?.data?.shelfMapping;

    if (shelfMap?.privacyTypes?.items?.length) {
      privacyItems = shelfMap.privacyTypes.items;
    }

    if (!privacyItems.length) {
      const viaHeader =
        shelfMap?.privacyHeader?.seeAllAction?.pageData?.shelves;
      if (viaHeader?.length) {
        for (const shelf of viaHeader) {
          if (shelf.contentType !== "privacyType") {
            continue;
          }
          for (const item of shelf.items ?? []) {
            if (item.categories?.length) {
              privacyItems.push(item);
            } else if (item.purposes?.length) {
              const catMap = new Map<string, any>();
              for (const p of item.purposes) {
                for (const c of p.categories ?? []) {
                  if (!catMap.has(c.identifier)) {
                    catMap.set(c.identifier, {
                      identifier: c.identifier,
                      title: c.title,
                    });
                  }
                }
              }
              privacyItems.push({
                ...item,
                categories: [...catMap.values()],
                purposes: [],
              });
            }
          }
        }
      }
    }

    if (!privacyItems.length) {
      const pageData = rawData?.[0]?.data?.pageData;
      if (pageData?.shelves?.length) {
        for (const shelf of pageData.shelves) {
          if (shelf.contentType === "privacyType") {
            privacyItems.push(...(shelf.items ?? []));
          }
        }
      }
    }
  } catch (e) {
    console.error("[compare] Could not extract privacy data from raw JSON", e);
  }

  return privacyItems.map((item) => ({
    identifier: String(item.identifier ?? ""),
    title: String(item.title ?? ""),
    categories: (item.categories ?? []).map((c: any) => ({
      identifier: String(c.identifier ?? ""),
      title: String(c.title ?? ""),
    })),
  }));
}

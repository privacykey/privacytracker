export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildAccessibilitySnapshot } from "../../../lib/accessibility";
import type { AccessibilityFeature } from "../../../lib/accessibility-types";
import { buildSnapshot } from "../../../lib/changelog";
import {
  type ComparePreview,
  fetchAndParsePreview,
} from "../../../lib/compare-scrape";
import db from "../../../lib/db";
import type { PolicySummary } from "../../../lib/policy-summary-meta";
import { getPolicyAnalysis } from "../../../lib/privacy-policy";
import { AppleRateLimitError } from "../../../lib/scraper";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  validateAppStoreUrl,
} from "../../../lib/security";

/**
 * GET /api/compare?a=<spec>&b=<spec>
 *
 * Each `spec` is either:
 *   - `id:<appId>` — a tracked app; we pull privacy data from the DB and
 *     include the stored policy summary if one exists
 *   - `url:<apps.apple.com URL>` — an untracked candidate; we scrape and
 *     parse on demand WITHOUT persisting (no DB writes, no notifications)
 *
 * Returns `{ a: CompareSlot, b: CompareSlot }` where each slot is a
 * normalised shape containing privacyTypes (always), policySummary (optional
 * — only tracked apps have one), and a flag indicating whether the slot is
 * from the library or a fresh scrape.
 *
 * Rate limits: the URL path goes through the same 30 req/min-per-IP limit
 * as /api/scrape so a caller can't use us as a free iTunes scraping proxy.
 */

interface CompareSlot {
  /**
   * Accessibility features (VoiceOver, Larger Text, etc.) the developer
   * declares on Apple's accessibility nutrition-labels shelf. Empty array
   * when the developer has filed the shelf but listed nothing; absent when
   * the shelf is missing entirely (mirrors the `hasAccessibilityLabels`
   * tri-state below). Always present in the response so the Compare view
   * can render its Accessibility tab without a second round-trip.
   */
  accessibilityFeatures: AccessibilityFeature[];
  developer: string;
  /**
   * Tri-state mirror of `apps.hasAccessibilityLabels`:
   *   1    — developer claims at least one feature
   *   0    — developer filed the shelf but declared nothing
   *   null — shelf absent OR preview couldn't decide
   * The UI uses this to pick between "✓ declares support" chips,
   * "No accessibility labels filed" banners, and neutral "not scraped"
   * states.
   */
  hasAccessibilityLabels: number | null;
  hasPrivacyDetails: number | null;
  iconUrl: string;
  id: string;
  name: string;
  policySummary: PolicySummary | null;
  privacyPolicyUrl: string;
  privacyTypes: ComparePreview["privacyTypes"];
  source: "library" | "scrape";
  url: string;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const specA = url.searchParams.get("a");
  const specB = url.searchParams.get("b");

  if (!(specA && specB)) {
    return NextResponse.json(
      { error: "Both `a` and `b` are required" },
      { status: 400 }
    );
  }

  // Apply the shared scrape rate limit if either slot will hit iTunes.
  if (specA.startsWith("url:") || specB.startsWith("url:")) {
    const rate = checkRateLimit({
      key: rateLimitKeyForRequest(request, "compare"),
      limit: 30,
      windowMs: 60_000,
    });
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded for /api/compare. Try again shortly." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)),
          },
        }
      );
    }
  }

  try {
    const [a, b] = await Promise.all([resolveSlot(specA), resolveSlot(specB)]);
    return NextResponse.json({ a, b });
  } catch (error) {
    if (error instanceof AppleRateLimitError) {
      return NextResponse.json(
        { error: "App Store rate-limited us. Try again in a minute." },
        { status: 429 }
      );
    }
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    console.error("/api/compare error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function resolveSlot(spec: string): Promise<CompareSlot> {
  if (spec.startsWith("id:")) {
    const appId = spec.slice(3);
    return resolveFromLibrary(appId);
  }
  if (spec.startsWith("url:")) {
    const candidateUrl = spec.slice(4);
    const verdict = validateAppStoreUrl(candidateUrl);
    if (!(verdict.ok && verdict.url)) {
      throw new Error(`Rejected URL (${verdict.error ?? "invalid_url"})`);
    }
    const preview = await fetchAndParsePreview(verdict.url.toString());
    return {
      source: "scrape",
      id: preview.appleId,
      name: preview.name,
      iconUrl: preview.iconUrl,
      developer: preview.developer,
      privacyPolicyUrl: preview.privacyPolicyUrl,
      url: preview.url,
      privacyTypes: preview.privacyTypes,
      hasPrivacyDetails: preview.hasPrivacyDetails,
      policySummary: null,
      // `fetchAndParsePreview` extracts the accessibility shelf using the
      // same helper as the persistent scraper, so preview slots behave the
      // same as tracked ones for the Compare view's accessibility tab.
      accessibilityFeatures: preview.accessibilityFeatures ?? [],
      hasAccessibilityLabels: preview.hasAccessibilityLabels ?? null,
    };
  }
  throw new Error(`Invalid spec: ${spec.slice(0, 40)}`);
}

function resolveFromLibrary(appId: string): CompareSlot {
  const app = db
    .prepare(
      "SELECT id, name, iconUrl, developer, url, privacyPolicyUrl, hasPrivacyDetails, hasAccessibilityLabels FROM apps WHERE id = ?"
    )
    .get(appId) as
    | {
        id: string;
        name: string;
        iconUrl: string;
        developer: string;
        url: string;
        privacyPolicyUrl: string;
        hasPrivacyDetails: number | null;
        hasAccessibilityLabels: number | null;
      }
    | undefined;

  if (!app) {
    throw new Error(`App not found: ${appId}`);
  }

  const privacyTypes = buildSnapshot(appId);
  const analysis = getPolicyAnalysis(appId);
  const policySummary = analysis?.summary ?? null;

  // Reuse the same snapshot helper the app-detail view does so Compare
  // always shows exactly what the detail page would — no divergence if
  // Apple's shelf data has been refreshed since this slot was last
  // viewed. Shape matches AccessibilityFeature (identifier/title/
  // description/iconTemplate).
  const accessibilityFeatures = buildAccessibilitySnapshot(app.id);

  return {
    source: "library",
    id: app.id,
    name: app.name,
    iconUrl: app.iconUrl,
    developer: app.developer,
    privacyPolicyUrl: app.privacyPolicyUrl,
    url: app.url,
    privacyTypes,
    hasPrivacyDetails: app.hasPrivacyDetails,
    policySummary,
    accessibilityFeatures,
    hasAccessibilityLabels: app.hasAccessibilityLabels,
  };
}

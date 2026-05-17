export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { fetchAndParsePreview } from "../../../lib/compare-scrape";
import { AppleRateLimitError } from "../../../lib/scraper";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  validateAppStoreUrl,
} from "../../../lib/security";

/**
 * GET /api/preview?url=<apps.apple.com URL>
 *
 * Transient scrape for the shortlist preview drawer. Mirrors the `url:`
 * path in /api/compare but returns a single slot (not a pair) and does NOT
 * touch the DB. Shares the same rate limit key group as /api/compare so a
 * caller can't use it as a sneaky second lane onto iTunes.
 *
 * Returned shape matches ComparePreview: { appleId, name, iconUrl,
 * developer, privacyPolicyUrl, url, privacyTypes, hasPrivacyDetails }.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const candidateUrl = url.searchParams.get("url");
  if (!candidateUrl) {
    return NextResponse.json(
      { error: "`url` query param is required" },
      { status: 400 }
    );
  }

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "compare"),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded for preview. Try again shortly.",
        retryAfterMs: rate.retryAfterMs,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
      }
    );
  }

  const verdict = validateAppStoreUrl(candidateUrl);
  if (!(verdict.ok && verdict.url)) {
    return NextResponse.json(
      { error: `Rejected URL (${verdict.error ?? "invalid_url"})` },
      { status: 400 }
    );
  }

  try {
    const preview = await fetchAndParsePreview(verdict.url.toString());
    return NextResponse.json({ preview });
  } catch (error) {
    if (error instanceof AppleRateLimitError) {
      return NextResponse.json(
        {
          error: "App Store rate-limited us. Try again in a minute.",
          retryAfterMs: error.retryAfterMs,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)),
          },
        }
      );
    }
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    console.error("/api/preview error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

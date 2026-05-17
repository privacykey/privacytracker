export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiTiming } from "../../../lib/api-timing";
import { schedulePostAppUpdatePolicyFetch } from "../../../lib/post-app-update-policy-fetch";
import { scrapeInitialUrls } from "../../../lib/scraper";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  validateAppStoreUrl,
} from "../../../lib/security";

// Guardrails:
//   - URL allowlist: only apps.apple.com / itunes.apple.com with an /id<digits>
//     path segment. Anything else would make this endpoint an SSRF primitive.
//   - Rate limit per IP: the scraper fans out to Apple + optional privacy
//     policy hosts; an attacker could otherwise use us to hammer iTunes and
//     get the tracker's IP banned.
//   - Per-batch cap: the legacy handler trusted `urls` unconditionally.
const MAX_URLS_PER_BATCH = 100;

export const POST = withApiTiming("/api/scrape", async (request: Request) => {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "scrape"),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded for /api/scrape. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
      }
    );
  }

  let body: {
    urls?: unknown;
    resync?: unknown;
    summarizePolicies?: unknown;
    trigger?: unknown;
  };
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { urls, resync, summarizePolicies, trigger } = body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return NextResponse.json(
      { error: "urls must be a non-empty array" },
      { status: 400 }
    );
  }
  if (urls.length > MAX_URLS_PER_BATCH) {
    return NextResponse.json(
      { error: `urls exceeds cap of ${MAX_URLS_PER_BATCH}` },
      { status: 400 }
    );
  }

  const cleaned: string[] = [];
  for (const candidate of urls) {
    const verdict = validateAppStoreUrl(candidate);
    if (!(verdict.ok && verdict.url)) {
      return NextResponse.json(
        {
          error: `Rejected URL (${verdict.error ?? "invalid_url"}): ${String(candidate).slice(0, 200)}`,
        },
        { status: 400 }
      );
    }
    cleaned.push(verdict.url.toString());
  }

  // Callers can label the scrape (Settings → Sync now, Onboarding, Change
  // Match retry). Unknown/missing values fall back to the signature default:
  // resync === true means "user asked us to refresh", so we treat it as
  // manual; resync === false means "first scrape for this URL", i.e. import.
  const allowedTriggers = ["scheduled", "manual", "import", "wayback"] as const;
  type AllowedTrigger = (typeof allowedTriggers)[number];
  const triggerOverride: AllowedTrigger | undefined =
    typeof trigger === "string" &&
    (allowedTriggers as readonly string[]).includes(trigger)
      ? (trigger as AllowedTrigger)
      : undefined;

  try {
    const results = await scrapeInitialUrls(
      cleaned,
      resync === true,
      summarizePolicies === true,
      { trigger: triggerOverride }
    );

    // Server-side log of per-result failures. Without this, a headless
    // deployment (Docker / non-Tauri) has no breadcrumb when an
    // individual app's scrape errors out — the wizard's import-history
    // row shows the error string to the user but the operator log has
    // nothing. Worth emitting at error level since each entry indicates
    // a specific app that didn't import. Bounded — the route already
    // caps the batch via MAX_URLS_PER_BATCH.
    const failures = results.filter(
      (r): r is Extract<typeof r, { status: "error" | "rate_limited" }> =>
        r.status === "error" || r.status === "rate_limited"
    );
    if (failures.length > 0) {
      console.error(
        `[scrape] ${failures.length} / ${results.length} URLs failed:`,
        failures.map((f) => ({
          url: f.url,
          status: f.status,
          error: f.error,
        }))
      );
    }

    if (
      summarizePolicies !== true &&
      results.some((result) => result.status === "success")
    ) {
      schedulePostAppUpdatePolicyFetch(resync === true ? "sync" : "import");
    }
    return NextResponse.json({ results });
  } catch (error) {
    console.error("Scrape API error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
});

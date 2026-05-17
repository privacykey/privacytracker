export const dynamic = "force-dynamic";

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendManualAppEvent,
  getCurrentManualAppPolicyVersion,
  upsertManualAppPolicyVersion,
} from "../../../../../lib/manual-app-history";
import { getManualApp } from "../../../../../lib/manual-apps-server";
import { fetchPrivacyPolicySource } from "../../../../../lib/privacy-policy";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
} from "../../../../../lib/security";

// Next 16 hands params as a Promise. Webpack-mode build's TS check
// rejects T | Promise<T> unions in this position, so we keep the
// Promise variant only and let `await Promise.resolve(...)` below
// handle the runtime.
interface Ctx {
  params: Promise<{ id: string }>;
}

async function resolveId(context: Ctx): Promise<string | null> {
  const params = await Promise.resolve(context.params);
  const id = (params?.id ?? "").toString();
  // UUIDs are 36 chars, but bounded generously for forward-compat.
  if (!id || id.length > 128) {
    return null;
  }
  return id;
}

/**
 * POST /api/manual-apps/[id]/scrape
 *
 * Fetch the manual app's privacy-policy URL, persist the extracted text in
 * `manual_app_policy_versions`, and append a `scrape` event to the
 * changelog. Response shape mirrors the GET detail shape so the client can
 * optimistically render the fresh event without reloading the page.
 *
 * Rate limited to discourage accidental DDoS from an impatient "Scrape"
 * button. The underlying safeFetch layer already enforces SSRF protection
 * (allowlist, timeouts, byte caps); this endpoint just orchestrates.
 */
export async function POST(request: Request, context: Ctx) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "manual-apps.scrape"),
    // Conservative: one manual-app scrape every ~6 s on average; enough for
    // testing but stops someone from mashing the button into a tight loop.
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const id = await resolveId(context);
  if (!id) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const app = getManualApp(id);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!app.privacyPolicyUrl) {
    return NextResponse.json(
      { error: "No privacy policy URL set for this manual app" },
      { status: 400 }
    );
  }

  const now = Date.now();
  const previous = getCurrentManualAppPolicyVersion(id);

  try {
    const source = await fetchPrivacyPolicySource(app.privacyPolicyUrl);

    // Validation failures come back as `status: 'too_short'` or
    // `'unsupported_content_type'` with an `error` string. Record them as a
    // scrape error so the changelog explains why the user didn't see new
    // content without blowing up the request.
    if (source.status !== "ready") {
      const event = appendManualAppEvent({
        manualAppId: id,
        type: "scrape",
        occurredAt: now,
        detail: {
          kind: "scrape",
          policy_event: "error",
          policyUrl: app.privacyPolicyUrl,
          finalUrl: source.finalUrl,
          title: source.title,
          error: source.error,
        },
      });
      recordAudit({
        action: "manual-apps.scrape.rejected",
        actorIp,
        userAgent,
        success: false,
        detail: `id=${id} reason=${source.status}`,
      });
      return NextResponse.json({ event, version: null }, { status: 200 });
    }

    // Hash the normalised text so identical re-fetches fold into one row.
    const contentHash = crypto
      .createHash("sha256")
      .update(source.text)
      .digest("hex");

    const { id: versionId, isNew } = upsertManualAppPolicyVersion({
      manualAppId: id,
      contentHash,
      fetchedAt: now,
      policyUrl: app.privacyPolicyUrl,
      sourceFinalUrl: source.finalUrl,
      sourceTitle: source.title,
      sourceContentType: source.contentType,
      sourceOrigin: source.origin,
      sourceWordCount: source.wordCount,
      sourceText: source.text,
    });

    // policy_event is the discriminator the timeline renders against:
    //   first   — no prior capture exists (`previous == null`)
    //   changed — a prior capture exists, but hash differs
    //   same    — hash matches the most recent capture
    let policyEvent: "first" | "same" | "changed";
    if (!previous) {
      policyEvent = "first";
    } else if (isNew) {
      policyEvent = "changed";
    } else {
      policyEvent = "same";
    }

    const event = appendManualAppEvent({
      manualAppId: id,
      type: "scrape",
      occurredAt: now,
      detail: {
        kind: "scrape",
        policy_event: policyEvent,
        versionId,
        wordCount: source.wordCount,
        contentHash,
        policyUrl: app.privacyPolicyUrl,
        finalUrl: source.finalUrl,
        title: source.title,
      },
    });

    recordAudit({
      action: "manual-apps.scrape.success",
      actorIp,
      userAgent,
      success: true,
      detail: `id=${id} event=${policyEvent} words=${source.wordCount}`,
    });

    return NextResponse.json({
      event,
      version: {
        id: versionId,
        contentHash,
        wordCount: source.wordCount,
        policyUrl: app.privacyPolicyUrl,
        sourceFinalUrl: source.finalUrl,
        sourceTitle: source.title,
        fetchedAt: now,
        isNew,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Policy fetch failed";
    const event = appendManualAppEvent({
      manualAppId: id,
      type: "scrape",
      occurredAt: now,
      detail: {
        kind: "scrape",
        policy_event: "error",
        policyUrl: app.privacyPolicyUrl,
        error: message,
      },
    });
    recordAudit({
      action: "manual-apps.scrape.failed",
      actorIp,
      userAgent,
      success: false,
      detail: `id=${id} err=${message.slice(0, 120)}`,
    });
    return NextResponse.json(
      { event, version: null, error: message },
      { status: 200 }
    );
  }
}

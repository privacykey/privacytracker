/**
 * /api/verdicts
 *
 *   GET    ?appId=…   — every verdict (user + imported) for an app
 *   POST              — set or update the user's verdict for an app
 *   DELETE            — clear the user's verdict for an app
 *
 * Imported verdicts are written by the audit-bundle import path, not by
 * this endpoint. The per-id operations available to clients are limited
 * to "set my own verdict" / "clear my own verdict" — recipients can
 * dismiss imported recommendations by hitting DELETE with
 * ?source=imported&sourceName=…, but the common case (set/clear my
 * own) requires no extra params.
 */

import { type NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import {
  acceptCurrentConcern,
  clearConcernAcceptance,
  clearDeferral,
  deferDecision,
  deferredUntil,
  hasAcceptedConcern,
  REVIEW_DAYS,
} from "@/lib/focus-review";
import { requestBodyErrorResponse } from "@/lib/request-body";
import { readBoundedJson } from "@/lib/security";
import {
  clearVerdict,
  isValidVerdict,
  listVerdicts,
  setVerdict,
  type VerdictSource,
  type VerdictValue,
} from "@/lib/verdicts";

export const dynamic = "force-dynamic";

/**
 * No server-side cache revalidation here — deliberately (Rust-core
 * Phase 0). Every page is a client shell that refetches its own data, so
 * nothing server-rendered depends on verdicts; and the prerendered HTML
 * must NEVER be regenerated at runtime, because the Content-Security-
 * Policy allowlists each page's inline scripts by build-time hash. The
 * old revalidatePath("/dashboard", "layout") marked the whole layout
 * stale, Next re-rendered those pages on the next request and overwrote
 * their HTML with flight payloads no hash covered, and they went blank
 * behind the CSP. The client's refetch is the only cache step now.
 */
export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("appId");
  if (!appId) {
    return NextResponse.json({ error: "appId is required" }, { status: 400 });
  }
  try {
    const verdicts = listVerdicts(appId);
    return NextResponse.json({
      verdicts,
      ...(request.nextUrl.searchParams.get("decision") === "1"
        ? {
            deferredUntil: deferredUntil(appId),
            accepted: hasAcceptedConcern(appId),
          }
        : {}),
    });
  } catch (e) {
    console.error("[/api/verdicts GET] failed:", e);
    return NextResponse.json(
      { error: "Failed to list verdicts" },
      { status: 500 }
    );
  }
}

interface PostBody {
  acceptCurrent?: boolean;
  appId?: string;
  clearAcceptance?: boolean;
  deferDays?: number;
  rationale?: string | null;
  verdict?: VerdictValue;
}

export async function POST(request: NextRequest) {
  let body: PostBody;
  try {
    body = await readBoundedJson<PostBody>(request, 8 * 1024);
  } catch (error) {
    const bodyLimitResponse = requestBodyErrorResponse(error);
    if (bodyLimitResponse) {
      return bodyLimitResponse;
    }

    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.appId || typeof body.appId !== "string") {
    return NextResponse.json({ error: "appId is required" }, { status: 400 });
  }
  if (body.deferDays !== undefined && body.verdict !== undefined) {
    return NextResponse.json(
      { error: "Choose a verdict or a reminder, not both" },
      { status: 400 }
    );
  }
  if (!isValidVerdict(body.verdict)) {
    if (body.deferDays !== undefined) {
      if (!REVIEW_DAYS.includes(body.deferDays as 1 | 7 | 30)) {
        return NextResponse.json(
          { error: "deferDays must be 1, 7 or 30" },
          { status: 400 }
        );
      }
      if (!db.prepare("SELECT id FROM apps WHERE id = ?").get(body.appId)) {
        return NextResponse.json({ error: "App not found" }, { status: 404 });
      }
      return NextResponse.json(
        { deferredUntil: deferDecision(body.appId, body.deferDays) },
        { status: 201 }
      );
    }
    return NextResponse.json(
      { error: "verdict must be one of: safe, replace, uninstall" },
      { status: 400 }
    );
  }
  if (
    body.rationale !== undefined &&
    body.rationale !== null &&
    typeof body.rationale !== "string"
  ) {
    return NextResponse.json(
      { error: "rationale must be a string or null" },
      { status: 400 }
    );
  }

  try {
    const verdict = db.transaction(() => {
      const saved = setVerdict({
        appId: body.appId!,
        verdict: body.verdict!,
        rationale: body.rationale ?? null,
        source: "user",
      });
      clearDeferral(body.appId!);
      if (body.clearAcceptance === true) {
        clearConcernAcceptance(body.appId!);
      }
      if (body.verdict === "safe" && body.acceptCurrent === true) {
        acceptCurrentConcern(body.appId!);
      }
      return saved;
    })();
    return NextResponse.json({ verdict }, { status: 201 });
  } catch (e) {
    console.error("[/api/verdicts POST] failed:", e);
    return NextResponse.json(
      { error: "Failed to set verdict" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("appId");
  if (!appId) {
    return NextResponse.json({ error: "appId is required" }, { status: 400 });
  }

  // Optional: clear an imported recommendation. Defaults to clearing
  // the user's own verdict (the common case).
  const sourceParam = request.nextUrl.searchParams.get("source");
  const source: VerdictSource =
    sourceParam === "imported" ? "imported" : "user";
  const sourceName =
    source === "imported"
      ? request.nextUrl.searchParams.get("sourceName")
      : null;

  if (source === "imported" && !sourceName) {
    return NextResponse.json(
      { error: "sourceName is required when source=imported" },
      { status: 400 }
    );
  }

  try {
    if (request.nextUrl.searchParams.get("deferredOnly") === "1") {
      clearDeferral(appId);
      return NextResponse.json({ removed: true });
    }
    const removed = clearVerdict(appId, source, sourceName);
    return NextResponse.json({ removed });
  } catch (e) {
    console.error("[/api/verdicts DELETE] failed:", e);
    return NextResponse.json(
      { error: "Failed to clear verdict" },
      { status: 500 }
    );
  }
}

export const dynamic = "force-dynamic";

import { type NextRequest, NextResponse } from "next/server";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedBody,
} from "@/lib/security";

/**
 * /api/csp-report — where the browser sends Content-Security-Policy
 * violation reports (`report-uri` in proxy.ts).
 *
 * POST is deliberately public: browsers send reports as anonymous POSTs,
 * so proxy.ts exempts this path from the auth gate and the same-origin
 * mutation check. It is safe to expose because all it does is append a
 * trimmed summary to a small in-memory ring — no DB, no disk, bounded
 * body, rate limited per IP. Nothing leaves the machine; this exists so
 * an operator can see what a policy would block (PRIVACYTRACKER_CSP=
 * report-only) or did block, from the Diagnostics page.
 *
 * GET returns the ring (normal auth applies — it's private data about
 * what pages the user visited).
 */

interface CspReport {
  blockedUri: string;
  directive: string;
  documentUri: string;
  receivedAt: number;
  sample: string;
}

const RING_MAX = 50;
const ring: CspReport[] = ((globalThis as any).__pt_csp_ring ??= []);

function summarise(raw: unknown): CspReport | null {
  // Legacy report-uri shape: { "csp-report": {...} }. Reporting API
  // shape: [{ type: "csp-violation", body: {...} }].
  const bodies: any[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item?.body) {
        bodies.push(item.body);
      }
    }
  } else if (raw && typeof raw === "object") {
    bodies.push((raw as any)["csp-report"] ?? raw);
  }
  const b = bodies[0];
  if (!b || typeof b !== "object") {
    return null;
  }
  const str = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : "";
  return {
    receivedAt: Date.now(),
    directive: str(
      b["effective-directive"] ??
        b.effectiveDirective ??
        b["violated-directive"],
      64
    ),
    blockedUri: str(b["blocked-uri"] ?? b.blockedURL ?? b.blockedURI, 200),
    documentUri: str(b["document-uri"] ?? b.documentURL, 200),
    sample: str(b["script-sample"] ?? b.sample, 120),
  };
}

export async function POST(request: NextRequest) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "csp-report"),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return new NextResponse(null, { status: 429 });
  }
  let raw: unknown;
  try {
    const text = await readBoundedBody(request, 16 * 1024);
    raw = JSON.parse(text.toString());
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const report = summarise(raw);
  if (report) {
    ring.unshift(report);
    if (ring.length > RING_MAX) {
      ring.length = RING_MAX;
    }
    console.warn(
      `[csp] violation: ${report.directive} blocked ${report.blockedUri || "(inline)"} on ${report.documentUri}`
    );
  }
  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  return NextResponse.json({ reports: ring });
}

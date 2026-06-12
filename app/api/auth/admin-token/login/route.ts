/**
 * POST /api/auth/admin-token/login
 *
 * Exchanges the user's `AUDITOR_ADMIN_TOKEN` (typed into the Settings
 * panel or sent by an integration) for an HttpOnly session cookie.
 * Browser callers use the cookie for subsequent /api/* requests so the
 * raw token is never reachable from JavaScript — defeats the XSS-uplift
 * path where an injected script could exfiltrate the token from
 * sessionStorage and replay it against destructive admin endpoints.
 *
 * Rate-limited per-IP (5 attempts / minute) so brute-forcing the token
 * via the loopback or LAN is impractical even when the proxy bypasses
 * the non-local admin gate for this path. Constant-time compare against
 * AUDITOR_ADMIN_TOKEN.
 */
import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  ADMIN_TOKEN_COOKIE,
  adminTokenConfigured,
  checkRateLimit,
  isSameOriginRequest,
  loginBruteForceTripped,
  rateLimitKeyForRequest,
  readBoundedJson,
  recordAudit,
  recordLoginFailure,
  requestActorIp,
  requestHasValidAdminToken,
} from "@/lib/security";

export const dynamic = "force-dynamic";

const ADMIN_TOKEN_MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours.

interface Body {
  token?: unknown;
}

export async function POST(request: NextRequest) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  // Auth bypass through the proxy + browser POST means we still must
  // require same-origin to block CSRF-style logins driven by a malicious
  // page the user happens to load.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Same-origin required" },
      { status: 403 }
    );
  }

  // A caller already holding a valid token (cookie/header) bypasses the global
  // brute-force backstop, so an attacker who trips the absolute counter can
  // never lock the legitimate operator out of re-authenticating.
  const alreadyAuthed = requestHasValidAdminToken(request);

  // Global, IP-independent brute-force backstop. The per-IP limiter below
  // collapses to a single shared bucket when no trusted proxy is configured,
  // so this absolute counter is what actually bounds total guesses against a
  // spoofed/rotated source IP. Only failed attempts count toward it.
  if (!alreadyAuthed) {
    const brute = loginBruteForceTripped();
    if (brute.tripped) {
      recordAudit({
        action: "admin_token.login.global_throttled",
        actorIp,
        userAgent,
        success: false,
        detail: `retryAfterMs=${brute.retryAfterMs}`,
      });
      return NextResponse.json(
        { error: "Too many failed attempts. Try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(brute.retryAfterMs / 1000)),
          },
        }
      );
    }
  }

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "admin-token-login"),
    limit: 5,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    recordAudit({
      action: "admin_token.login.rate_limited",
      actorIp,
      userAgent,
      success: false,
      detail: `retryAfterMs=${rate.retryAfterMs}`,
    });
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
      }
    );
  }

  if (!adminTokenConfigured()) {
    return NextResponse.json(
      { error: "AUDITOR_ADMIN_TOKEN is not configured on the server." },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = await readBoundedJson<Body>(request, 4 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const provided = typeof body.token === "string" ? body.token.trim() : "";
  if (!provided) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 });
  }

  const expected = process.env.AUDITOR_ADMIN_TOKEN ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const matches = a.length === b.length && timingSafeEqual(a, b);
  if (!matches) {
    // Feed the absolute brute-force backstop (failures only).
    recordLoginFailure();
    recordAudit({
      action: "admin_token.login.invalid",
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  recordAudit({
    action: "admin_token.login",
    actorIp,
    userAgent,
    success: true,
  });

  const res = NextResponse.json({ ok: true });
  // Secure flag set only over HTTPS — the cookie spec says browsers
  // drop Secure cookies on http://, so always-true would break local
  // installs. We mirror the request's perceived protocol.
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const isHttps =
    forwardedProto === "https" || request.nextUrl.protocol === "https:";
  res.cookies.set({
    name: ADMIN_TOKEN_COOKIE,
    value: provided,
    httpOnly: true,
    secure: isHttps,
    sameSite: "strict",
    path: "/",
    maxAge: ADMIN_TOKEN_MAX_AGE_SECONDS,
  });
  return res;
}

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
 * Rate-limited per client (5 attempts / minute), and each wrong token
 * counts toward the client's guess budget shared with every other token
 * check (lib/admin-token-guard.ts), so brute-forcing the token via the
 * loopback or LAN is impractical even when the proxy bypasses the
 * non-local admin gate for this path. The client is the socket peer, or
 * the last forwarded hop behind a trusted proxy, so one client's attempts
 * never lock another out. Constant-time compare against
 * AUDITOR_ADMIN_TOKEN.
 */

import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  adminTokenAttemptsBlocked,
  adminTokenClientKey,
  recordAdminTokenFailure,
  recordAdminTokenSuccess,
  TOO_MANY_FAILURES,
} from "@/lib/admin-token-guard";
import { requestOrigin } from "@/lib/deployment-trust";
import { requestBodyErrorResponse } from "@/lib/request-body";
import {
  ADMIN_TOKEN_COOKIE,
  adminTokenConfigured,
  checkRateLimit,
  isSameOriginRequest,
  loginBruteForceTripped,
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

  // Every login presents a token, so a client past its budget of wrong
  // tokens (on any path: this form, the header or cookie the proxy checks,
  // the status endpoint) is refused before this one is looked at. The
  // budget is per client, so one client's guessing never refuses another.
  const client = adminTokenClientKey(request.headers);
  const guessing = adminTokenAttemptsBlocked(client);
  if (guessing.blocked) {
    recordAudit({
      action: "admin_token.login.client_throttled",
      actorIp,
      userAgent,
      success: false,
      detail: `retryAfterMs=${guessing.retryAfterMs}`,
    });
    return NextResponse.json(
      { error: TOO_MANY_FAILURES },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(guessing.retryAfterMs / 1000)),
        },
      }
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

  // Keyed by the same client as the guess budget, so one client's attempts
  // no longer fill a bucket every client shares. Without a known client (a
  // server started without the request preloader) it falls back to the
  // route's shared bucket, as before.
  const rate = checkRateLimit({
    key: `admin-token-login:${client ?? "local"}`,
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
  } catch (error) {
    const bodyLimitResponse = requestBodyErrorResponse(error);
    if (bodyLimitResponse) {
      return bodyLimitResponse;
    }

    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const provided = typeof body?.token === "string" ? body.token.trim() : "";
  if (!provided) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 });
  }

  const expected = process.env.AUDITOR_ADMIN_TOKEN ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const matches = a.length === b.length && timingSafeEqual(a, b);
  if (!matches) {
    // Feed the absolute brute-force backstop (failures only) and this
    // client's guess budget.
    recordLoginFailure();
    recordAdminTokenFailure(client, `login ${provided}`);
    recordAudit({
      action: "admin_token.login.invalid",
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  recordAdminTokenSuccess(client);
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
  const isHttps = requestOrigin(request)?.startsWith("https:") === true;
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

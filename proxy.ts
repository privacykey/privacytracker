import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  effectiveHostFromHeaders,
  isHostAllowed,
  isNetworkExposed,
} from "@/lib/deployment-trust";

/**
 * Global proxy — runs before every matched route. Runs on the Node runtime.
 *
 * Responsibilities:
 *   1. Reject any request whose Host isn't on the allowlist (default: loopback
 *      only). This is the canonical DNS-rebinding defence — browsers cannot
 *      spoof the Host header, so a malicious page that rebinds DNS to the
 *      loopback instance still arrives with its own hostname and is bounced.
 *   2. Attach conservative security headers (including a nonce-based CSP)
 *      to every response.
 *   3. Require the AUDITOR_ADMIN_TOKEN on guarded API calls whenever the
 *      deployment is declared network-exposed (config-driven, NOT derived from
 *      the spoofable Host header).
 *   4. Enforce same-origin CSRF protection on mutating API calls so a
 *      malicious cross-origin page can't drive the local app. Bypass
 *      is granted when the configured AUDITOR_ADMIN_TOKEN header is
 *      supplied (for scripted callers).
 *
 * Trust note: host classification + network-exposure live in the dependency-
 * free `@/lib/deployment-trust` module so this file (which runs in the proxy
 * sandbox and must not import the native better-sqlite3 binding) can share
 * exactly the same logic as `lib/security.ts`.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Same-site form-nav sends Origin automatically; legitimate no-Origin
// mutations are tool-driven and must supply the admin token.
const ALWAYS_REQUIRE_ORIGIN_PREFIX = "/api/";
const NON_LOCAL_ADMIN_READ_PREFIXES = [
  "/api/ai/debug-log",
  "/api/backup/",
  "/api/deployment/",
  "/api/desktop/diagnostics",
  "/api/diagnostics/",
  "/api/export",
  "/api/import/",
];
// Endpoints that handle their own auth and must bypass the non-local
// admin-token gate. The login endpoint is the chicken-and-egg root —
// it is how a caller obtains the cookie in the first place. It does
// its own constant-time compare + rate limit. The status/logout
// endpoints are non-sensitive: status returns a boolean, logout just
// clears the cookie.
const ADMIN_AUTH_BYPASS_PREFIX = "/api/auth/admin-token/";
const ADMIN_TOKEN_COOKIE = "pt_admin_token";

// Apple's privacy-label icons come from `is{1..5}-ssl.mzstatic.com`. Listed
// explicitly so a future `evil.mzstatic.com` subdomain can't be reached
// from inside the WebView.
const APPLE_IMG_HOSTS =
  "https://is1-ssl.mzstatic.com https://is2-ssl.mzstatic.com https://is3-ssl.mzstatic.com https://is4-ssl.mzstatic.com https://is5-ssl.mzstatic.com";

function makeNonce(): string {
  return randomBytes(16).toString("base64");
}

function buildCsp(nonce: string): string {
  // Production uses strict-dynamic + a per-request nonce so Next's
  // hydration scripts bootstrap cleanly and arbitrary inline JS is
  // blocked. Every modern browser used as a Tauri WebView (WebKit,
  // Chromium ≥ 52) honours strict-dynamic.
  //
  // Dev intentionally drops nonces and falls back to unsafe-inline /
  // unsafe-eval. We learned this the hard way: when a nonce is present
  // in the CSP request header, Next applies it to every internal
  // chunk-loader / flight-data <script> tag on the server. The browser
  // then strips that nonce from the DOM after executing the inline
  // script (a security feature in the HTML spec). React 19 hydrates,
  // sees the missing attribute, and floods the dev overlay with
  // "tree hydrated but some attributes ... didn't match" warnings — a
  // false positive that drowns out real mismatches. Production already
  // never shows that overlay, so the dev/prod CSP split is purely
  // about silencing dev noise; the security posture in prod is
  // unchanged.
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = isDev
    ? "'self' 'unsafe-inline' 'unsafe-eval'"
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `img-src 'self' data: blob: ${APPLE_IMG_HOSTS}`,
    "font-src 'self' data:",
    `script-src ${scriptSrc}`,
    // Styles still rely on 'unsafe-inline' because Next emits inline
    // <style> tags from styled-jsx that aren't easily nonce-tagged. The
    // XSS-uplift risk of inline styles is much smaller than scripts.
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "object-src 'none'",
    // 'navigate-to' is a Chromium-only directive; harmless when ignored,
    // closes a navigation-based exfil path where supported.
    "navigate-to 'self'",
  ].join("; ");
}

function attachSecurityHeaders(res: NextResponse, nonce: string): NextResponse {
  res.headers.set("Content-Security-Policy", buildCsp(nonce));
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), usb=(), payment=()"
  );
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  // No HSTS — only meaningful over HTTPS, and setting it on plain HTTP misleads.
  return res;
}

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!(origin && host)) {
    return false;
  }
  try {
    const originUrl = new URL(origin);
    return originUrl.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function constantTimeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function requestHasValidAdminToken(request: NextRequest): boolean {
  const expected = process.env.AUDITOR_ADMIN_TOKEN;
  if (!expected) {
    return false;
  }
  // HttpOnly cookie is the browser path (set by /api/auth/admin-token/login).
  // x-auditor-admin-token header is the scripted-caller path.
  const cookieToken = request.cookies.get(ADMIN_TOKEN_COOKIE)?.value;
  if (cookieToken && constantTimeMatch(cookieToken, expected)) {
    return true;
  }
  const provided = request.headers.get("x-auditor-admin-token");
  if (provided && constantTimeMatch(provided, expected)) {
    return true;
  }
  return false;
}

function nonLocalAdminApplies(method: string, pathname: string): boolean {
  if (!pathname.startsWith("/api/")) {
    return false;
  }
  // Auth endpoints self-gate; the proxy must let them through so the
  // user can obtain the cookie in the first place.
  if (pathname.startsWith(ADMIN_AUTH_BYPASS_PREFIX)) {
    return false;
  }
  if (MUTATING_METHODS.has(method)) {
    return true;
  }
  return NON_LOCAL_ADMIN_READ_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix)
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();
  const nonce = makeNonce();

  // Step 0 — Host allowlist (DNS-rebinding defence). Reject ANY request whose
  // effective Host isn't allowlisted, for every method including GET, before
  // any other gate. The default allowlist is loopback only; operators add LAN
  // hosts via PRIVACYTRACKER_ALLOWED_HOSTS. Loopback always passes, so the
  // in-container healthcheck on 127.0.0.1 keeps working. A malicious page that
  // DNS-rebinds to the loopback instance still sends its own hostname in Host
  // and is bounced here — closing the read-disclosure path on un-gated GETs.
  if (!isHostAllowed(effectiveHostFromHeaders(request.headers))) {
    const res = NextResponse.json(
      { error: "Host not allowed" },
      { status: 400 }
    );
    return attachSecurityHeaders(res, nonce);
  }

  // Network-exposed installs must opt into the shared-secret gate for API
  // writes and high-sensitivity reads. "Exposed" is a property of the
  // DEPLOYMENT CONFIG (allowlist / bind / PRIVACYTRACKER_NETWORK_EXPOSED), not
  // of the request Host — so a spoofed `Host: localhost` can no longer downgrade
  // the instance to "local" and skip this gate.
  if (
    isNetworkExposed() &&
    nonLocalAdminApplies(method, pathname) &&
    !requestHasValidAdminToken(request)
  ) {
    const res = NextResponse.json(
      { error: "Admin token required for non-local API access" },
      { status: 401 }
    );
    return attachSecurityHeaders(res, nonce);
  }

  // CSRF: reject mutating API calls that are neither same-origin nor
  // carry the admin token. Reads pass through.
  if (
    MUTATING_METHODS.has(method) &&
    pathname.startsWith(ALWAYS_REQUIRE_ORIGIN_PREFIX) &&
    !(isSameOrigin(request) || requestHasValidAdminToken(request))
  ) {
    const res = NextResponse.json(
      { error: "Cross-origin mutation rejected" },
      { status: 403 }
    );
    return attachSecurityHeaders(res, nonce);
  }

  // Forward the nonce + CSP to the downstream handler. Next.js parses
  // the `Content-Security-Policy` *request* header (yes, request — that
  // is how Next learns the nonce in middleware-based setups) and applies
  // the discovered nonce to its hydration / RSC <script> tags. The
  // `x-nonce` request header is the canonical place server components
  // read the value via `headers().get('x-nonce')`.
  //
  // In dev we skip both forwards. `buildCsp` already drops `nonce-…`
  // from the script-src in dev (see the comment there), so leaving
  // them set would only confuse Next into nonce-decorating its
  // internal flight-data scripts — which the browser then strips,
  // which triggers a wall of React 19 hydration warnings the user
  // can't action.
  const isDev = process.env.NODE_ENV !== "production";
  const csp = buildCsp(nonce);
  const forwardedHeaders = new Headers(request.headers);
  if (!isDev) {
    forwardedHeaders.set("x-nonce", nonce);
    forwardedHeaders.set("Content-Security-Policy", csp);
  }

  const res = NextResponse.next({ request: { headers: forwardedHeaders } });
  return attachSecurityHeaders(res, nonce);
}

// Run on every path except Next internals and static assets.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|preview-icon-).*)",
  ],
};

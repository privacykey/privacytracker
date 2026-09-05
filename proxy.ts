import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  requestHasValidAdminHeader,
  requestHasValidAdminToken,
} from "@/lib/admin-auth";
import {
  effectiveHostFromHeaders,
  isHostAllowed,
  isNetworkExposed,
  isSameOriginRequest,
  requestOrigin,
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
 *   3. Require the AUDITOR_ADMIN_TOKEN on private pages and API calls whenever the
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
// Public exceptions are exact routes, never a prefix that could grow to contain
// private data. Static build assets are excluded by the matcher below.
const PUBLIC_READ_PATHS = new Set([
  "/login",
  "/api/health",
  "/api/ready",
  "/api/auth/admin-token/status",
  "/brand-icon.png",
]);
const AUTH_PATHS = new Set([
  "/api/auth/admin-token/login",
  "/api/auth/admin-token/logout",
]);

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

  const publicRead =
    (method === "GET" || method === "HEAD") && PUBLIC_READ_PATHS.has(pathname);
  const requiresAuth =
    isNetworkExposed() || Boolean(process.env.AUDITOR_ADMIN_TOKEN);
  if (
    requiresAuth &&
    !publicRead &&
    !AUTH_PATHS.has(pathname) &&
    !requestHasValidAdminToken(request)
  ) {
    const res = pathname.startsWith("/api/")
      ? NextResponse.json({ error: "Admin token required" }, { status: 401 })
      : NextResponse.redirect(
          new URL("/login", requestOrigin(request) ?? request.url)
        );
    res.headers.set("Cache-Control", "no-store");
    return attachSecurityHeaders(res, nonce);
  }

  // CSRF: reject mutating API calls that are neither same-origin nor
  // carry an explicit admin-token header. Cookies never exempt the Origin check.
  if (
    MUTATING_METHODS.has(method) &&
    pathname.startsWith(ALWAYS_REQUIRE_ORIGIN_PREFIX) &&
    !(isSameOriginRequest(request) || requestHasValidAdminHeader(request))
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
  forwardedHeaders.set(
    "x-privacytracker-login",
    pathname === "/login" ? "1" : "0"
  );
  if (!isDev) {
    forwardedHeaders.set("x-nonce", nonce);
    forwardedHeaders.set("Content-Security-Policy", csp);
  }

  const res = NextResponse.next({ request: { headers: forwardedHeaders } });
  res.headers.set("Cache-Control", "no-store");
  return attachSecurityHeaders(res, nonce);
}

// Run on every path except Next internals and static assets.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|preview-icon-).*)",
  ],
};

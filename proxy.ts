import { readFileSync } from "node:fs";
import path from "node:path";
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
 *   2. Attach conservative security headers (including a hash-based CSP —
 *      see scripts/generate-csp-hashes.mjs)
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

/**
 * CSP mode. `enforce` (default) sends Content-Security-Policy;
 * `report-only` sends Content-Security-Policy-Report-Only so an operator
 * can watch /api/csp-report for violations before enforcing; `off`
 * sends no CSP at all (debugging only — documented as unsafe).
 */
function cspMode(): "enforce" | "report-only" | "off" {
  const raw = (process.env.PRIVACYTRACKER_CSP ?? "enforce").toLowerCase();
  return raw === "report-only" || raw === "off" ? raw : "enforce";
}

interface CspHashes {
  all: string[];
  routes: Record<string, string[]>;
}

let hashesCache: CspHashes | null | undefined;

/**
 * Per-route inline-script hashes written by scripts/generate-csp-hashes.mjs
 * after `next build`. Read once, lazily. Missing in production = fail
 * CLOSED (script-src 'self' only, which blocks Next's inline bootstrap and
 * breaks the page loudly) rather than open — the build script exists so
 * this never happens in a real build.
 */
function loadCspHashes(): CspHashes | null {
  if (hashesCache !== undefined) {
    return hashesCache;
  }
  try {
    const dist = process.env.NEXT_DIST_DIR ?? ".next";
    hashesCache = JSON.parse(
      readFileSync(path.join(process.cwd(), dist, "csp-hashes.json"), "utf8")
    ) as CspHashes;
  } catch (error) {
    hashesCache = null;
    console.error(
      "[proxy] csp-hashes.json not found — was `next build` run without scripts/generate-csp-hashes.mjs? Failing closed (script-src 'self').",
      error
    );
  }
  return hashesCache;
}

/**
 * Map a request path to the prerendered route whose HTML will be served,
 * mirroring next.config.js rewrites: the per-id detail URLs serve the
 * static `view` shells. Unknown paths serve the 404 page.
 */
function cspRouteKey(pathname: string, hashes: CspHashes): string {
  const clean =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (/^\/apps\/[^/]+$/.test(clean)) {
    return "/apps/view";
  }
  if (/^\/manual-apps\/[^/]+$/.test(clean)) {
    return "/manual-apps/view";
  }
  return clean in hashes.routes ? clean : "/_not-found";
}

function scriptSrc(pathname: string): string {
  if (process.env.NODE_ENV !== "production") {
    return "'self' 'unsafe-inline' 'unsafe-eval'";
  }
  const hashes = loadCspHashes();
  if (!hashes) {
    return "'self'";
  }
  const list = hashes.routes[cspRouteKey(pathname, hashes)] ?? hashes.all;
  return ["'self'", ...list.map((h) => `'${h}'`)].join(" ");
}

function buildCsp(pathname: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `img-src 'self' data: blob: ${APPLE_IMG_HOSTS}`,
    "font-src 'self' data:",
    `script-src ${scriptSrc(pathname)}`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "object-src 'none'",
    "report-uri /api/csp-report",
  ].join("; ");
}

function attachSecurityHeaders(
  res: NextResponse,
  pathname: string
): NextResponse {
  const mode = cspMode();
  if (mode === "enforce") {
    res.headers.set("Content-Security-Policy", buildCsp(pathname));
  } else if (mode === "report-only") {
    res.headers.set("Content-Security-Policy-Report-Only", buildCsp(pathname));
  }
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), usb=(), payment=()"
  );
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return res;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();

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
    return attachSecurityHeaders(res, pathname);
  }

  // Browsers send CSP violation reports as anonymous POSTs (no custom
  // headers, cookies optional). The endpoint only appends to a small,
  // rate-limited in-memory ring, so it is exempt from BOTH the auth gate
  // and the same-origin mutation check below.
  const cspReport = method === "POST" && pathname === "/api/csp-report";
  const publicRead =
    (method === "GET" || method === "HEAD") && PUBLIC_READ_PATHS.has(pathname);
  const requiresAuth =
    isNetworkExposed() || Boolean(process.env.AUDITOR_ADMIN_TOKEN);
  if (
    requiresAuth &&
    !(publicRead || cspReport) &&
    !AUTH_PATHS.has(pathname) &&
    !requestHasValidAdminToken(request)
  ) {
    const res = pathname.startsWith("/api/")
      ? NextResponse.json({ error: "Admin token required" }, { status: 401 })
      : NextResponse.redirect(
          new URL("/login", requestOrigin(request) ?? request.url)
        );
    res.headers.set("Cache-Control", "no-store");
    return attachSecurityHeaders(res, pathname);
  }

  // CSRF: reject mutating API calls that are neither same-origin nor
  // carry an explicit admin-token header. Cookies never exempt the Origin check.
  if (
    MUTATING_METHODS.has(method) &&
    !cspReport &&
    pathname.startsWith(ALWAYS_REQUIRE_ORIGIN_PREFIX) &&
    !(isSameOriginRequest(request) || requestHasValidAdminHeader(request))
  ) {
    const res = NextResponse.json(
      { error: "Cross-origin mutation rejected" },
      { status: 403 }
    );
    return attachSecurityHeaders(res, pathname);
  }

  const res = NextResponse.next();
  res.headers.set("Cache-Control", "no-store");
  return attachSecurityHeaders(res, pathname);
}

// Run on every path except Next internals and static assets.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|preview-icon-).*)",
  ],
};

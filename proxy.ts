import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  requestHasValidAdminHeader,
  requestHasValidAdminToken,
} from "@/lib/admin-auth";
import { cspRouteKey } from "@/lib/csp-route-key";
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
 * Tauri v2 routes every `invoke()` over a custom protocol whose origin is
 * platform-dependent: `ipc://localhost` on macOS/Linux, `http://ipc.localhost`
 * on Windows/Android (see `convertFileSrc` in tauri's injected core.js).
 * Neither is covered by `'self'` when the page is served by the Node sidecar
 * at `http://127.0.0.1:<port>`, so under a hash-based CSP every invoke trips
 * `connect-src` — including tauri-plugin-notification's `js_init_script`,
 * which probes `plugin:notification|is_permission_granted` on every page load.
 *
 * The app keeps working because tauri's ipc-protocol.js catches the blocked
 * fetch and silently falls back to `window.ipc.postMessage`, but each call
 * still costs a blocked request, a console warning and a CSP report.
 *
 * Deliberately NOT the updater's release feed: `plugin:updater|check` only
 * crosses the IPC boundary, and the HTTPS fetch to GitHub happens in Rust
 * (reqwest), never in the webview. Same for plugin-process. So the IPC
 * origins are the whole of what the desktop build needs.
 *
 * Mirrors the `connect-src` in src-tauri/tauri.conf.json — keep the two in
 * sync. A window opting into `useHttpsScheme: true` would additionally need
 * `https://ipc.localhost` in both places.
 */
const TAURI_IPC_SOURCES = "ipc: http://ipc.localhost";

/**
 * True only inside the Tauri desktop app: src-tauri/src/sidecar.rs sets
 * PRIVACYTRACKER_RUNTIME=desktop on the Node child it spawns. Read per
 * request (not cached at module load) so tests can flip it.
 *
 * Browser and Docker deployments never see this, so their `connect-src`
 * stays exactly `'self'`.
 */
function isDesktopRuntime(): boolean {
  return process.env.PRIVACYTRACKER_RUNTIME === "desktop";
}

function connectSrc(): string {
  return isDesktopRuntime() ? `'self' ${TAURI_IPC_SOURCES}` : "'self'";
}

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

function scriptSrc(pathname: string): string {
  if (process.env.NODE_ENV !== "production") {
    return "'self' 'unsafe-inline' 'unsafe-eval'";
  }
  const hashes = loadCspHashes();
  if (!hashes) {
    return "'self'";
  }
  const list =
    hashes.routes[cspRouteKey(pathname, hashes.routes)] ?? hashes.all;
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
    `connect-src ${connectSrc()}`,
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

  // Step 0.5 — Canonical trailing-slash redirect.
  //
  // Next normally emits this 308 itself, but it does so in the router
  // (dist/server/lib/router-utils/resolve-routes.js) BEFORE middleware runs,
  // and its redirect branch returns `resHeaders: null` — discarding every
  // header accumulated so far, including the static set from next.config.js's
  // `headers()`. That left `GET /dashboard/` answering 308 with zero security
  // headers while `GET /dashboard` carried all six.
  //
  // `skipTrailingSlashRedirect: true` in next.config.js suppresses the router's
  // version so the request reaches here and the redirect goes out through
  // attachSecurityHeaders like every other response. Headers are computed for
  // the CANONICAL path, so the CSP hash set matches the page the browser
  // actually lands on.
  //
  // Not covered (and not coverable from here): Next normalises repeated
  // slashes and backslashes with a 308 emitted before the route table is
  // consulted at all, so `//dashboard` still answers header-less. It is a
  // bodiless redirect to a same-origin canonical path, same as this one was.
  if (pathname.length > 1 && pathname.endsWith("/")) {
    // NOT `request.nextUrl.clone()`: NextURL's pathname setter reports the new
    // value from its getter but does not rebuild `href`, so the serialised
    // Location kept the trailing slash and the 308 pointed at itself — an
    // infinite redirect. A plain URL over `request.url` round-trips honestly.
    const canonical = new URL(request.url);
    canonical.pathname = pathname.replace(/\/+$/, "");
    const res = NextResponse.redirect(canonical, 308);
    res.headers.set("Cache-Control", "no-store");
    return attachSecurityHeaders(res, canonical.pathname);
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

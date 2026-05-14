import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Global proxy — runs before every matched route. Runs on the Node runtime.
 *
 * Responsibilities:
 *   1. Attach conservative security headers (including a nonce-based CSP)
 *      to every response.
 *   2. Enforce same-origin CSRF protection on mutating API calls so a
 *      malicious cross-origin page can't drive the local app. Bypass
 *      is granted when the configured AUDITOR_ADMIN_TOKEN header is
 *      supplied (for scripted callers).
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Same-site form-nav sends Origin automatically; legitimate no-Origin
// mutations are tool-driven and must supply the admin token.
const ALWAYS_REQUIRE_ORIGIN_PREFIX = '/api/';
const NON_LOCAL_ADMIN_READ_PREFIXES = [
  '/api/ai/debug-log',
  '/api/backup/',
  '/api/deployment/',
  '/api/desktop/diagnostics',
  '/api/diagnostics/',
  '/api/export',
  '/api/import/',
];
// Endpoints that handle their own auth and must bypass the non-local
// admin-token gate. The login endpoint is the chicken-and-egg root —
// it is how a caller obtains the cookie in the first place. It does
// its own constant-time compare + rate limit. The status/logout
// endpoints are non-sensitive: status returns a boolean, logout just
// clears the cookie.
const ADMIN_AUTH_BYPASS_PREFIX = '/api/auth/admin-token/';
const ADMIN_TOKEN_COOKIE = 'pt_admin_token';

// Apple's privacy-label icons come from `is{1..5}-ssl.mzstatic.com`. Listed
// explicitly so a future `evil.mzstatic.com` subdomain can't be reached
// from inside the WebView.
const APPLE_IMG_HOSTS =
  'https://is1-ssl.mzstatic.com https://is2-ssl.mzstatic.com https://is3-ssl.mzstatic.com https://is4-ssl.mzstatic.com https://is5-ssl.mzstatic.com';

function makeNonce(): string {
  return randomBytes(16).toString('base64');
}

function buildCsp(nonce: string): string {
  // Dev builds need 'unsafe-eval' for Next's HMR runtime and 'unsafe-inline'
  // as a fallback for browsers that don't honour 'strict-dynamic' on inline
  // scripts. Both directives are dropped in production where 'strict-dynamic'
  // is enough to bootstrap Next's hydration via the nonce — every modern
  // browser used as a Tauri WebView (WebKit, Chromium ≥ 52) supports it.
  const isDev = process.env.NODE_ENV !== 'production';
  const scriptSrc = isDev
    ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' 'unsafe-eval'`
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
  ].join('; ');
}

function attachSecurityHeaders(res: NextResponse, nonce: string): NextResponse {
  res.headers.set('Content-Security-Policy', buildCsp(nonce));
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), usb=(), payment=()',
  );
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // No HSTS — only meaningful over HTTPS, and setting it on plain HTTP misleads.
  return res;
}

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function hostWithoutPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(':')[0] ?? trimmed;
}

function isLocalRequestHost(request: NextRequest): boolean {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || request.headers.get('host');
  if (!host) return false;
  const h = hostWithoutPort(host);
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

function constantTimeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requestHasValidAdminToken(request: NextRequest): boolean {
  const expected = process.env.AUDITOR_ADMIN_TOKEN;
  if (!expected) return false;
  // HttpOnly cookie is the browser path (set by /api/auth/admin-token/login).
  // x-auditor-admin-token header is the scripted-caller path.
  const cookieToken = request.cookies.get(ADMIN_TOKEN_COOKIE)?.value;
  if (cookieToken && constantTimeMatch(cookieToken, expected)) return true;
  const provided = request.headers.get('x-auditor-admin-token');
  if (provided && constantTimeMatch(provided, expected)) return true;
  return false;
}

function nonLocalAdminApplies(method: string, pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  // Auth endpoints self-gate; the proxy must let them through so the
  // user can obtain the cookie in the first place.
  if (pathname.startsWith(ADMIN_AUTH_BYPASS_PREFIX)) return false;
  if (MUTATING_METHODS.has(method)) return true;
  return NON_LOCAL_ADMIN_READ_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();
  const nonce = makeNonce();

  // Non-local installs must opt into the shared-secret gate for API writes
  // and high-sensitivity reads. Without an authentication layer, a reverse
  // proxy / LAN hostname should not be able to mutate or export user data
  // just because it is same-origin to the browser.
  if (!isLocalRequestHost(request) && nonLocalAdminApplies(method, pathname)) {
    if (!requestHasValidAdminToken(request)) {
      const res = NextResponse.json(
        { error: 'Admin token required for non-local API access' },
        { status: 401 },
      );
      return attachSecurityHeaders(res, nonce);
    }
  }

  // CSRF: reject mutating API calls that are neither same-origin nor
  // carry the admin token. Reads pass through.
  if (MUTATING_METHODS.has(method) && pathname.startsWith(ALWAYS_REQUIRE_ORIGIN_PREFIX)) {
    if (!isSameOrigin(request) && !requestHasValidAdminToken(request)) {
      const res = NextResponse.json(
        { error: 'Cross-origin mutation rejected' },
        { status: 403 },
      );
      return attachSecurityHeaders(res, nonce);
    }
  }

  // Forward the nonce + CSP to the downstream handler. Next.js parses
  // the `Content-Security-Policy` *request* header (yes, request — that
  // is how Next learns the nonce in middleware-based setups) and applies
  // the discovered nonce to its hydration / RSC <script> tags. The
  // `x-nonce` request header is the canonical place server components
  // read the value via `headers().get('x-nonce')`.
  const csp = buildCsp(nonce);
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set('x-nonce', nonce);
  forwardedHeaders.set('Content-Security-Policy', csp);

  const res = NextResponse.next({ request: { headers: forwardedHeaders } });
  return attachSecurityHeaders(res, nonce);
}

// Run on every path except Next internals and static assets.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|fonts/|preview-icon-).*)'],
};

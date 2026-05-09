import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Global proxy — runs before every matched route. Runs on the Node runtime.
 *
 * Responsibilities:
 *   1. Attach conservative security headers to every response.
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
  '/api/deployment/support-bundle',
  '/api/diagnostics/',
  '/api/export',
  '/api/import/',
];

function attachSecurityHeaders(res: NextResponse): NextResponse {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https://*.mzstatic.com",
    "font-src 'self' data:",
    // Next injects inline <script> blobs for hydration / RSC payloads;
    // unsafe-inline is required without strict-dynamic nonce pipeline.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "object-src 'none'",
  ].join('; ');

  res.headers.set('Content-Security-Policy', csp);
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), usb=(), payment=()',
  );
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

function requestHasValidAdminToken(request: NextRequest): boolean {
  const expected = process.env.AUDITOR_ADMIN_TOKEN;
  if (!expected) return false;
  const provided = request.headers.get('x-auditor-admin-token');
  if (!provided) return false;
  // timingSafeEqual throws on length mismatch — short-circuit first.
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function nonLocalAdminApplies(method: string, pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  if (MUTATING_METHODS.has(method)) return true;
  return NON_LOCAL_ADMIN_READ_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();

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
      return attachSecurityHeaders(res);
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
      return attachSecurityHeaders(res);
    }
  }

  const res = NextResponse.next();
  return attachSecurityHeaders(res);
}

// Run on every path except Next internals and static assets.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|fonts/|preview-icon-).*)'],
};

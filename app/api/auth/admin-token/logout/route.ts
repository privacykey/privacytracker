/**
 * POST /api/auth/admin-token/logout
 *
 * Clears the HttpOnly admin-token cookie. Same-origin gated; the cookie
 * itself is HttpOnly so JS can't delete it client-side. Logout is the
 * server-side counterpart.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  ADMIN_TOKEN_COOKIE,
  isSameOriginRequest,
  recordAudit,
  requestActorIp,
} from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'Same-origin required' }, { status: 403 });
  }

  recordAudit({
    action: 'admin_token.logout',
    actorIp: requestActorIp(request),
    userAgent: request.headers.get('user-agent'),
    success: true,
  });

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: ADMIN_TOKEN_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  return res;
}

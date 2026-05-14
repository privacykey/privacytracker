/**
 * GET /api/auth/admin-token/status
 *
 * UI helper — returns whether the admin token is configured server-side
 * and whether the current request carries a valid one (via the HttpOnly
 * cookie set by login, OR the legacy header). The Settings panel uses
 * this to render the "unlock" / "locked" pill since it cannot read the
 * HttpOnly cookie directly.
 *
 * Never returns the token itself.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { adminTokenConfigured, requestHasValidAdminToken } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return NextResponse.json({
    configured: adminTokenConfigured(),
    unlocked: requestHasValidAdminToken(request),
  });
}

import { NextResponse } from 'next/server';
import { buildDeploymentDiagnostics } from '@/lib/deployment-diagnostics';

export const dynamic = 'force-dynamic';

/**
 * Readiness probe for containers and reverse proxies.
 *
 * `/api/health` stays a tiny liveness check. This route is deliberately
 * deeper: it confirms the app can query SQLite and that the configured data
 * location is writable. Use this for Docker HEALTHCHECK and deploy smoke
 * tests.
 */
export async function GET(request: Request) {
  const diagnostics = buildDeploymentDiagnostics(request.headers);
  const ready =
    diagnostics.health.status === 'ok' &&
    diagnostics.database.writable;

  return NextResponse.json(
    {
      status: ready ? 'ready' : 'not_ready',
      checks: diagnostics.checks,
    },
    { status: ready ? 200 : 503 },
  );
}

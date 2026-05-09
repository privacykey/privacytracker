import { NextResponse } from 'next/server';
import { buildDeploymentDiagnostics } from '@/lib/deployment-diagnostics';

export const dynamic = 'force-dynamic';

/**
 * Safe deployment diagnostics for the Settings card.
 *
 * No secrets, no API keys, no tracked-app data. The goal is to answer
 * "is this local / LAN / Tauri install wired correctly?" without making
 * users dig through logs.
 */
export async function GET(request: Request) {
  return NextResponse.json(buildDeploymentDiagnostics(request.headers));
}

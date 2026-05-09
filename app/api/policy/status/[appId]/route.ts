export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getPolicyAnalysis } from '../../../../../lib/privacy-policy';

/**
 * Lightweight polling endpoint for the AI Policy tab. Returns just
 * `runStatus`, `runStartedAt`, `lastRunLog`, and `status` so the client can
 * render the spinner + log without round-tripping the full source/summary.
 * No auth — the full analysis is reachable via /api/apps/[id] and this is
 * a subset.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ appId: string }> },
): Promise<Response> {
  // Next 15 types params as a Promise; accept both shapes.
  const params = await Promise.resolve(context.params);
  const appId = params?.appId?.trim();
  if (!appId || !/^\d{1,20}$/.test(appId)) {
    return NextResponse.json({ error: 'Invalid appId' }, { status: 400 });
  }

  const analysis = getPolicyAnalysis(appId);
  if (!analysis) {
    // 200 with a "not started" shape so the client can poll into existence.
    return NextResponse.json({
      runStatus: 'idle',
      runStartedAt: null,
      lastRunLog: [],
      status: null,
    });
  }

  return NextResponse.json({
    runStatus: analysis.runStatus ?? 'idle',
    runStartedAt: analysis.runStartedAt ?? null,
    lastRunLog: analysis.lastRunLog ?? [],
    // `status` lets the client detect terminal results (ready / fetch_error)
    // and stop polling even if run_status hasn't flipped to 'idle' yet.
    status: analysis.status,
  });
}

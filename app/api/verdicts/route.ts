/**
 * /api/verdicts
 *
 *   GET    ?appId=…   — every verdict (user + imported) for an app
 *   POST              — set or update the user's verdict for an app
 *   DELETE            — clear the user's verdict for an app
 *
 * Imported verdicts are written by the audit-bundle import path, not by
 * this endpoint. The per-id operations available to clients are limited
 * to "set my own verdict" / "clear my own verdict" — recipients can
 * dismiss imported recommendations by hitting DELETE with
 * ?source=imported&sourceName=…, but the common case (set/clear my
 * own) requires no extra params.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { revalidatePath } from 'next/cache';
import {
  listVerdicts,
  setVerdict,
  clearVerdict,
  isValidVerdict,
  type VerdictValue,
  type VerdictSource,
} from '@/lib/verdicts';

export const dynamic = 'force-dynamic';

/**
 * Bust the Next full-route cache for every server-rendered surface
 * that reads verdict data. Without this, the user sets Safe/Replace/
 * Uninstall on /apps/[id], hits browser back, and lands on a cached
 * /dashboard/apps render that still shows the old (or no) verdict
 * pill on the card. Surfaces that read verdicts:
 *
 *   - /dashboard                       — pending-decision callouts
 *   - /dashboard/apps                  — verdict pill on each card
 *   - /dashboard/review-recommendations — explicit verdict list
 *   - /dashboard/shortlist             — verdict-aware sort/filter
 *   - /apps/[id]                       — the detail page itself
 *
 * `revalidatePath('/dashboard', 'layout')` invalidates the entire
 * /dashboard segment in one call, which covers the first four;
 * `/apps/[id]` is invalidated separately via its own path because
 * it sits outside the /dashboard layout. The client also fires
 * `router.refresh()` after a successful save (see VerdictPicker)
 * to clear its Router Cache for currently-rendered routes.
 */
function invalidateVerdictCaches(appId?: string): void {
  try {
    revalidatePath('/dashboard', 'layout');
    if (appId) {
      revalidatePath(`/apps/${appId}`);
    }
  } catch (e) {
    // revalidatePath throws synchronously when called outside of a
    // route handler / server action, but that should never happen
    // here. Log and continue — the client-side router.refresh() is
    // a second safety net.
    console.warn('[/api/verdicts] revalidatePath failed:', e);
  }
}

export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get('appId');
  if (!appId) {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }
  try {
    const verdicts = listVerdicts(appId);
    return NextResponse.json({ verdicts });
  } catch (e) {
    console.error('[/api/verdicts GET] failed:', e);
    return NextResponse.json({ error: 'Failed to list verdicts' }, { status: 500 });
  }
}

interface PostBody {
  appId?: string;
  verdict?: VerdictValue;
  rationale?: string | null;
}

export async function POST(request: NextRequest) {
  let body: PostBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.appId || typeof body.appId !== 'string') {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }
  if (!isValidVerdict(body.verdict)) {
    return NextResponse.json(
      { error: 'verdict must be one of: safe, replace, uninstall' },
      { status: 400 },
    );
  }
  if (body.rationale !== undefined && body.rationale !== null && typeof body.rationale !== 'string') {
    return NextResponse.json({ error: 'rationale must be a string or null' }, { status: 400 });
  }

  try {
    const verdict = setVerdict({
      appId: body.appId,
      verdict: body.verdict,
      rationale: body.rationale ?? null,
      source: 'user',
    });
    invalidateVerdictCaches(body.appId);
    return NextResponse.json({ verdict }, { status: 201 });
  } catch (e) {
    console.error('[/api/verdicts POST] failed:', e);
    return NextResponse.json({ error: 'Failed to set verdict' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get('appId');
  if (!appId) {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }

  // Optional: clear an imported recommendation. Defaults to clearing
  // the user's own verdict (the common case).
  const sourceParam = request.nextUrl.searchParams.get('source');
  const source: VerdictSource = sourceParam === 'imported' ? 'imported' : 'user';
  const sourceName =
    source === 'imported'
      ? request.nextUrl.searchParams.get('sourceName')
      : null;

  if (source === 'imported' && !sourceName) {
    return NextResponse.json(
      { error: 'sourceName is required when source=imported' },
      { status: 400 },
    );
  }

  try {
    const removed = clearVerdict(appId, source, sourceName);
    invalidateVerdictCaches(appId);
    return NextResponse.json({ removed });
  } catch (e) {
    console.error('[/api/verdicts DELETE] failed:', e);
    return NextResponse.json({ error: 'Failed to clear verdict' }, { status: 500 });
  }
}

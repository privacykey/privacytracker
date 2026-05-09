export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  addShortlistEntry,
  countShortlistEntries,
  listShortlistGroups,
  listShortlistPairs,
  removeAllShortlistEntries,
  removeShortlistEntry,
  removeShortlistEntryByPair,
} from '../../../lib/shortlist';
import type { ShortlistMode } from '../../../lib/shortlist-types';

const VALID_MODES: ShortlistMode[] = ['privacy', 'accessibility'];

/**
 * Read the optional `modes` field off an incoming POST body and normalise it
 * into a typed array. Accepts either a single string ("privacy") or an
 * array of strings — the UI sends the array form, but a curl user trying
 * the endpoint by hand might reach for the string shorthand. Anything
 * that doesn't match a known mode is dropped; an empty result returns
 * `undefined` so `addShortlistEntry` falls back to its own default.
 */
function parseModesField(raw: unknown): ShortlistMode[] | undefined {
  if (raw == null) return undefined;
  const tokens = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === 'string')
    : typeof raw === 'string'
    ? raw.split(',')
    : [];
  const normalised = tokens
    .map(t => t.trim().toLowerCase())
    .filter((t): t is ShortlistMode => (VALID_MODES as string[]).includes(t));
  return normalised.length > 0 ? normalised : undefined;
}
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from '../../../lib/security';

/**
 * List every shortlist entry, grouped by source app. The `pairs` array is a
 * compact lookup the Compare view uses to render "already shortlisted" state
 * on its candidate list without paying for the full grouped payload.
 *
 * Reads are unauthenticated (consistent with /api/manual-apps) but still
 * rate limited so a same-origin loop can't hammer SQLite.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'shortlist.list'),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  return NextResponse.json({
    groups: listShortlistGroups(),
    pairs: listShortlistPairs(),
    total: countShortlistEntries(),
  });
}

/**
 * Create (or refresh) a shortlist entry. Body shape:
 *   {
 *     sourceAppId:         string,
 *     candidateAppleId:    string,
 *     candidateName:       string,
 *     candidateDeveloper?: string,
 *     candidateIconUrl?:   string,
 *     candidateStoreUrl:   string,
 *     candidateBundleId?:  string,
 *     note?:               string,
 *   }
 *
 * Idempotent by (sourceAppId, candidateAppleId). addShortlistEntry throws on
 * validation failures (missing fields, unknown source app) — we translate
 * those into a 400 so the UI can surface the message inline.
 */
export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'shortlist.write'),
    limit: 60,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'shortlist.create.unauthorised',
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    // 8 KB — only short strings (name, URL, optional note). Larger payloads
    // here would almost certainly be a misuse.
    body = await readBoundedJson<Record<string, unknown>>(request, 8 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid request body' },
      { status: 400 },
    );
  }

  try {
    const entry = addShortlistEntry({
      sourceAppId:         String(body.sourceAppId ?? ''),
      candidateAppleId:    String(body.candidateAppleId ?? ''),
      candidateName:       String(body.candidateName ?? ''),
      candidateDeveloper:  typeof body.candidateDeveloper === 'string' ? body.candidateDeveloper : undefined,
      candidateIconUrl:    typeof body.candidateIconUrl === 'string'   ? body.candidateIconUrl   : undefined,
      candidateStoreUrl:   String(body.candidateStoreUrl ?? ''),
      candidateBundleId:   typeof body.candidateBundleId === 'string'  ? body.candidateBundleId  : undefined,
      note:                typeof body.note === 'string' ? body.note : undefined,
      // Optional — the Compare view passes the current compare mode here
      // so re-shortlisting the same candidate from the Accessibility tab
      // unions the badge onto an entry that was originally saved for
      // privacy reasons (or vice versa).
      modes:               parseModesField((body as { modes?: unknown }).modes),
    });
    recordAudit({
      action: 'shortlist.create',
      actorIp,
      userAgent,
      detail: `${entry.sourceAppId}→${entry.candidateAppleId}`,
      success: true,
    });
    return NextResponse.json({ entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Shortlist add failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Delete an entry either by id (preferred), by (sourceAppId,
 * candidateAppleId) pair, or — with `all=1` — every entry at once. The
 * pair form is convenient for the Compare view's "untoggle" button, which
 * only holds the pair reference; the `all=1` form powers the "Reset
 * shortlist" footer on /dashboard/shortlist and requires the admin token
 * when one is configured (same as the other destructive operations).
 *
 * Query string: /api/shortlist?id=<uuid>
 *         or:   /api/shortlist?sourceAppId=<…>&candidateAppleId=<…>
 *         or:   /api/shortlist?all=1
 */
export async function DELETE(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'shortlist.write'),
    limit: 60,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'shortlist.delete.unauthorised',
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const sourceAppId = url.searchParams.get('sourceAppId');
  const candidateAppleId = url.searchParams.get('candidateAppleId');
  const all = url.searchParams.get('all');

  // `all=1` → nuke everything. Return the removed count so the UI can echo
  // "Cleared N alternatives" without re-fetching to compare lengths.
  if (all === '1' || all === 'true') {
    const removed = removeAllShortlistEntries();
    recordAudit({
      action: 'shortlist.delete.all',
      actorIp,
      userAgent,
      detail: String(removed),
      success: true,
    });
    return NextResponse.json({ deleted: removed > 0, removed });
  }

  let deleted = false;
  if (id) {
    deleted = removeShortlistEntry(id);
  } else if (sourceAppId && candidateAppleId) {
    deleted = removeShortlistEntryByPair(sourceAppId, candidateAppleId);
  } else {
    return NextResponse.json(
      { error: 'Provide `id`, both `sourceAppId` and `candidateAppleId`, or `all=1`' },
      { status: 400 },
    );
  }

  recordAudit({
    action: 'shortlist.delete',
    actorIp,
    userAgent,
    detail: id ?? `${sourceAppId}→${candidateAppleId}`,
    success: deleted,
  });

  return NextResponse.json({ deleted });
}

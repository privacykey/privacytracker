export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  getRecentActivity,
  countRecentActivity,
  type ActivityType,
  type ActivityStatus,
  type ActivitySortField,
  type ActivitySortDir,
} from '../../../lib/activity';

const KNOWN_TYPES: readonly ActivityType[] = [
  'scrape',
  'resync',
  'policy_summary',
  'scheduled_sync',
  'manual_sync',
  'import',
  'wayback_import',
  'backup_export',
  'backup_restore',
  'reset',
];

const KNOWN_STATUSES: readonly ActivityStatus[] = ['ok', 'error', 'partial', 'cancelled'];
const KNOWN_SORT_FIELDS: readonly ActivitySortField[] = ['started_at', 'ended_at', 'duration_ms'];

function parseType(raw: string | null): ActivityType | undefined {
  if (!raw) return undefined;
  return KNOWN_TYPES.find(t => t === raw);
}

function parseStatus(raw: string | null): ActivityStatus | undefined {
  if (!raw) return undefined;
  return KNOWN_STATUSES.find(s => s === raw);
}

function parseSortBy(raw: string | null): ActivitySortField | undefined {
  if (!raw) return undefined;
  return KNOWN_SORT_FIELDS.find(f => f === raw);
}

function parseSortDir(raw: string | null): ActivitySortDir | undefined {
  if (raw === 'asc' || raw === 'desc') return raw;
  return undefined;
}

function parseTimestamp(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitRaw = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const offsetRaw = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
  const type = parseType(url.searchParams.get('type'));
  const status = parseStatus(url.searchParams.get('status'));
  const since = parseTimestamp(url.searchParams.get('since'));
  const until = parseTimestamp(url.searchParams.get('until'));
  const sortBy = parseSortBy(url.searchParams.get('sortBy'));
  const sortDir = parseSortDir(url.searchParams.get('sortDir'));

  const rows = getRecentActivity({
    limit,
    offset,
    type,
    status,
    since,
    until,
    sortBy,
    sortDir,
  });
  const total = countRecentActivity({ type, status, since, until });

  return NextResponse.json({
    rows,
    total,
    limit,
    offset,
    type: type ?? null,
    status: status ?? null,
    since: since ?? null,
    until: until ?? null,
    sortBy: sortBy ?? 'started_at',
    sortDir: sortDir ?? 'desc',
  });
}

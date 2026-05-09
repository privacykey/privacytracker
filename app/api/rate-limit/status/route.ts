import { NextRequest, NextResponse } from 'next/server';
import {
  clearRateLimit,
  getAllRateLimits,
  type RateLimitCategory,
} from '@/lib/rate-limit';

/**
 * Rate-limit visibility endpoint.
 *
 *   GET    → { search, scrape, serverNow }
 *   DELETE { category: 'search' | 'scrape' | 'all' } → clears the cooldown
 *
 * UI polls GET to drive a countdown banner; clients compute remaining time
 * from `resumeAt - Date.now()`, so local clock skew doesn't matter. DELETE
 * zeros the cooldown without contacting Apple — if the ban is still in
 * effect, the next outbound call re-records it on its 429.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getAllRateLimits());
}

const VALID_CATEGORIES: ReadonlyArray<RateLimitCategory | 'all'> = [
  'search',
  'scrape',
  'all',
];

export async function DELETE(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'expected object body' }, { status: 400 });
  }
  const category = (body as { category?: unknown }).category;
  if (typeof category !== 'string' || !VALID_CATEGORIES.includes(category as RateLimitCategory | 'all')) {
    return NextResponse.json(
      { error: 'expected { category: "search" | "scrape" | "all" }' },
      { status: 400 },
    );
  }
  if (category === 'all') {
    clearRateLimit('search');
    clearRateLimit('scrape');
  } else {
    clearRateLimit(category as RateLimitCategory);
  }
  return NextResponse.json(getAllRateLimits());
}

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  getAccessibilityProfile,
  saveAccessibilityProfile,
} from '../../../lib/accessibility-profile-server';
import { sanitizeA11yProfile } from '../../../lib/accessibility-profile';

/**
 * GET  → { profile: { [featureKey]: preference } | null }
 * PUT  → body { profile: AccessibilityProfile | null }  (null clears)
 *
 * Sparse objects are fine — feature keys the user hasn't marked are simply
 * absent (treated as "no preference"). The server sanitises on save, so
 * unknown feature keys or unknown preference strings get dropped before they
 * reach the DB. Mirrors /api/privacy-profile.
 */
export async function GET() {
  return NextResponse.json({ profile: getAccessibilityProfile() });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const raw = (body as { profile?: unknown }).profile;
  if (raw === null) {
    saveAccessibilityProfile(null);
    return NextResponse.json({ profile: null });
  }
  if (raw === undefined) {
    return NextResponse.json(
      { error: 'Missing `profile` key. Pass null to clear, or an object to save.' },
      { status: 400 },
    );
  }

  const clean = sanitizeA11yProfile(raw);
  saveAccessibilityProfile(clean);
  return NextResponse.json({ profile: getAccessibilityProfile() });
}

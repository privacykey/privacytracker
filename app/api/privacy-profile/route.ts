export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  getPrivacyProfile,
  savePrivacyProfile,
} from '../../../lib/privacy-profile-server';
import { sanitizeProfile } from '../../../lib/privacy-profile';

/**
 * GET  → { profile: { [categoryKey]: tier } | null }
 * PUT  → body { profile: PrivacyProfile | null }  (null clears)
 *
 * Sparse objects are fine — keys the user hasn't chosen a tier for are simply
 * absent. The server sanitises on save, so unknown category keys or unknown
 * tier strings get dropped before they reach the DB.
 */
export async function GET() {
  return NextResponse.json({ profile: getPrivacyProfile() });
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
    savePrivacyProfile(null);
    return NextResponse.json({ profile: null });
  }
  if (raw === undefined) {
    return NextResponse.json(
      { error: 'Missing `profile` key. Pass null to clear, or an object to save.' },
      { status: 400 },
    );
  }

  const clean = sanitizeProfile(raw);
  savePrivacyProfile(clean);
  return NextResponse.json({ profile: getPrivacyProfile() });
}

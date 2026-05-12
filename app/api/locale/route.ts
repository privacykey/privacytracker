/**
 * /api/locale — set the user's preferred UI locale.
 *
 * Stored as a `NEXT_LOCALE` cookie which `i18n.ts` reads on every
 * server-rendered request. A cookie (not localStorage) is required because
 * server components need the locale at render time.
 *
 * Body: `{ locale: 'en' | 'zh' }`. Returns the resolved locale. Unknown
 * locales fall back to the default with `accepted: false` so the client
 * can show a "language not supported" toast.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type SupportedLocale,
} from '@/i18n';
import { readBoundedJson } from '@/lib/security';

export const dynamic = 'force-dynamic';

interface LocaleBody {
  locale: SupportedLocale;
}

export async function POST(request: NextRequest) {
  let body: Partial<LocaleBody>;
  try {
    body = await readBoundedJson<Partial<LocaleBody>>(request, 1024);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const requested = body.locale;
  if (!isSupportedLocale(requested)) {
    return NextResponse.json(
      {
        accepted: false,
        locale: DEFAULT_LOCALE,
        supported: [...SUPPORTED_LOCALES],
        error: `locale must be one of: ${SUPPORTED_LOCALES.join(', ')}`,
      },
      { status: 400 },
    );
  }

  const res = NextResponse.json({
    accepted: true,
    locale: requested,
    supported: [...SUPPORTED_LOCALES],
  });
  // 365-day cookie; user-set so it should outlive a session. httpOnly:false
  // because the locale switcher reads it client-side too.
  res.cookies.set(LOCALE_COOKIE, requested, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: false,
  });
  return res;
}

/** Read the currently-set locale, or fall back to the default if no cookie. */
export async function GET(request: NextRequest) {
  const cookieValue = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = isSupportedLocale(cookieValue) ? cookieValue : DEFAULT_LOCALE;
  return NextResponse.json({
    locale,
    explicitlySet: isSupportedLocale(cookieValue),
    supported: [...SUPPORTED_LOCALES],
  });
}

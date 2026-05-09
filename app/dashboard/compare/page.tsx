import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Nav from '../../components/Nav';
import CompareAppsView from '../../components/CompareAppsView';
import { resolveFlagFromDb } from '@/lib/feature-flags-server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('page_metadata');
  return {
    title: t('compare_title'),
    description: t('compare_description'),
  };
}

/**
 * Validate that a spec string from the query string is one of the two shapes
 * CompareAppsView / /api/compare already accept: `id:<appId>` or
 * `url:<https://...>`. Anything else is dropped back to `undefined` so the
 * page simply boots with empty slots instead of crashing downstream.
 *
 * We keep this intentionally permissive: the heavy validation (tracking ID
 * existence, URL scheme, storefront country) happens inside /api/compare.
 * This wrapper just guards against obviously malformed query strings.
 */
function sanitizeSpec(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return undefined;

  if (trimmed.startsWith('id:')) {
    const id = trimmed.slice(3);
    // Apple track IDs are numeric, but we allow alphanumerics + a handful of
    // safe characters to match whatever the DB already stores.
    if (/^[A-Za-z0-9_-]{1,40}$/.test(id)) return trimmed;
    return undefined;
  }

  if (trimmed.startsWith('url:')) {
    const url = trimmed.slice(4);
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return trimmed;
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }

  return undefined;
}

interface ComparePageProps {
  // Next.js 15+ made `searchParams` an async boundary — the object isn't
  // resolved until you await it. Typing it as Promise<...> matches the
  // pattern in `app/apps/[id]/page.tsx` and stops TS from quietly letting
  // us read `.a`/`.b` off an unresolved Promise (which silently returns
  // `undefined` and means the slots never pre-fill).
  searchParams?: Promise<{
    a?: string | string[];
    b?: string | string[];
    /**
     * Origin marker. When `from=review`, the page renders a "Back to
     * Review" header link instead of "Back to Apps", and tells
     * CompareAppsView to default slot B to App Store search mode +
     * auto-save the chosen candidate to the source app's shortlist.
     * The review wizard's Compare step links here with this param so
     * users can flip back without losing their decision context.
     */
    from?: string | string[];
  }>;
}

function readSingle(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function ComparePage({ searchParams }: ComparePageProps) {
  // Round 3: gated by `flag.page.compare`. Default on; off for guardian +
  // minimal per the rule engine. Returning notFound() rather than redirecting
  // because users hitting this URL deliberately should see "this isn't here"
  // rather than a silent bounce to the dashboard.
  if (resolveFlagFromDb('flag.page.compare') !== 'on') notFound();

  const params = (await searchParams) ?? {};
  const specA = sanitizeSpec(params.a);
  const specB = sanitizeSpec(params.b);
  const fromReview = readSingle(params.from) === 'review';
  const tCompare = await getTranslations('compare');

  // Origin-aware back link. When the user came from the review wizard,
  // we keep them in that flow — the review page still shows their
  // decisions in progress, and a "Back to Apps" link would break the
  // mental thread of "I'm choosing a replacement for THIS app".
  // Round 3 v1.2 — when entering from the review wizard, return the user
  // to Step 2 (Compare) rather than the wizard's default Step 1 landing.
  // The wizard reads `?step=compare` off useSearchParams() on mount and
  // jumps straight to the Compare panel, so the user lands back exactly
  // where they were when they clicked "Find alternatives". Without the
  // hint, the wizard rebooted at Step 1 and the back-link felt like it
  // had thrown away their progress.
  const backHref = fromReview
    ? '/dashboard/review-recommendations?step=compare'
    : '/dashboard/apps';
  const backLabel = fromReview ? tCompare('back_to_review') : tCompare('back_to_apps');

  return (
    <>
      <Nav />
      <div className="page-container">
        <div className="page-header">
          <div>
            <h1 className="page-title">{tCompare('page_title')}</h1>
            <p className="page-subtitle">
              {fromReview ? (
                <>{tCompare('page_subtitle_from_review')}</>
              ) : (
                <>
                  {tCompare('page_subtitle_default_lead')}{' '}
                  <Link href="/dashboard/apps" className="definitions-inline-link">
                    {tCompare('page_subtitle_default_link')}
                  </Link>
                  {tCompare('page_subtitle_default_after')}{' '}
                  <kbd className="kbd kbd-inline">{tCompare('page_subtitle_default_kbd')}</kbd>{' '}
                  {tCompare('page_subtitle_default_close')}
                </>
              )}
            </p>
          </div>
          <Link href={backHref} className="btn btn-secondary">
            {backLabel}
          </Link>
        </div>

        {/* Seed either/both slots from the URL. CompareAppsView handles the
            empty case itself (empty-state copy + two pickers). */}
        <CompareAppsView
          initialSpec={specA}
          initialSpecOther={specB}
          pinnedSlot="A"
          lockPinned={false}
          fromReview={fromReview}
        />
      </div>
    </>
  );
}

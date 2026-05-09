import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * Bottom-LEFT mirror of {@link KeyboardHint}. Holds the two "site info"
 * disclosures the user asked for:
 *
 *   • Privacy policy — we don't collect any personal data; the page also
 *     lists every third-party endpoint the running service may contact.
 *   • Legal — every bundled dependency and its licence, grouped by
 *     SPDX identifier with a sticky sidebar.
 *
 * Visually mirrors .kbd-hint-anchor (same pill, same blur, same hover)
 * but pinned to the opposite corner so the two hovering footers don't
 * overlap. Hides on narrow viewports for the same reason — the bottom
 * row is already crowded on phones.
 *
 * Server component — pure Link markup, no window access. We want this
 * rendered in the initial HTML so the pages it points at are reachable
 * even before React hydrates, and because these are statutory-style
 * disclosures that shouldn't wait on JS. `getTranslations` is the
 * server-side counterpart of `useTranslations` so the component stays
 * server-rendered.
 */
export default async function SiteInfoHint() {
  const t = await getTranslations('footer');
  return (
    // The parent <footer> in app/layout.tsx already supplies the
    // contentinfo landmark, so this wrapper is just a styled
    // positioning anchor — matching KeyboardHint on the right.
    <div className="site-info-hint-anchor" aria-label={t('site_info_aria')}>
      <Link
        href="/privacy-policy"
        className="site-info-hint-link"
        title={t('privacy_policy_title')}
      >
        {t('privacy_policy')}
      </Link>
      <span className="site-info-hint-divider" aria-hidden="true" />
      <Link
        href="/legal"
        className="site-info-hint-link"
        title={t('legal_title')}
      >
        {t('legal')}
      </Link>
    </div>
  );
}

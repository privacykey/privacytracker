'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { openKeyboardHelp } from './KeyboardShortcuts';
import { openAboutModal } from './AboutModal';

/**
 * Small bottom-right affordance that says "Press ? for shortcuts" and sits
 * alongside an "About" button. Acts as a clickable discoverability nudge
 * for users who don't know the keyboard shortcuts exist, and doubles as the
 * app-wide footer entry point for the About dialog AND the entry point for
 * Apple's authoritative privacy-label reference material.
 *
 * Only renders on viewports wide enough that it won't crowd mobile UI. The
 * shortcut hint half can be dismissed with the × button; the About button
 * sticks around either way so users can always reach credits / source /
 * label definitions.
 */
export default function KeyboardHint() {
  // i18n — translates the four visible labels and three tooltip
  // titles. Captured at the top so the conditional <kbd>?</kbd>
  // sandwich below can interpolate the prefix/suffix bilingual.
  const t = useTranslations('footer.kbd_hint');
  const [dismissed, setDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  // Wait for client mount so we can read the viewport width without
  // mismatching SSR.
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  // Pass the current path through to /help/definitions so its "Back" button
  // returns the user here instead of the dashboard. Suppressed when we're
  // already on the definitions page (no useful round-trip), or when the
  // pathname lookup failed for some reason.
  const definitionsHref =
    pathname && pathname !== '/help/definitions'
      ? { pathname: '/help/definitions', query: { from: pathname } }
      : '/help/definitions';

  return (
    // The parent <footer> in app/layout.tsx already supplies the
    // contentinfo landmark, so this wrapper is just a styled
    // positioning anchor — no redundant ARIA role here.
    <div className="kbd-hint-anchor">
      {!dismissed && (
        <>
          <button
            type="button"
            className="kbd-hint-button"
            onClick={openKeyboardHelp}
            title={t('shortcut_button_title')}
          >
            {t('shortcut_prefix')} <kbd className="kbd kbd-inline">?</kbd> {t('shortcut_suffix')}
          </button>
          <button
            type="button"
            className="kbd-hint-dismiss"
            aria-label={t('dismiss_aria')}
            onClick={e => {
              e.stopPropagation();
              setDismissed(true);
            }}
          >
            ✕
          </button>
          <span className="kbd-hint-divider" aria-hidden="true" />
        </>
      )}
      <span className="kbd-hint-links">
        {/* Internal definitions page — summarises Apple's label vocabulary
            in one place, with deep links out to apple.com sources
            (including Apple's built-in-app labels and the country-specific
            transparency report). */}
        <Link
          href={definitionsHref}
          className="kbd-hint-link"
          title={t('definitions_title')}
        >
          {t('definitions_label')}
        </Link>
        <span className="kbd-hint-divider" aria-hidden="true" />
      </span>
      <button
        type="button"
        className="kbd-hint-about"
        onClick={openAboutModal}
        title={t('about_title')}
      >
        {t('about_label')}
      </button>
    </div>
  );
}

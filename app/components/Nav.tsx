'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import NotificationBell from './NotificationBell';
import { TaskCenterTrigger } from './TaskCenter';
import BrandWordmark from './BrandWordmark';
// DevMenu used to mount inside `.nav-right` between the bell and the
// "+ Add Apps" CTA. It moved to the global footer cluster (bottom-right,
// next to the accessibility quick-toggles) so it's reachable from every
// page, including routes without a navbar (onboarding, legal, etc).
// See app/layout.tsx for the new mount.

interface NavProps {
  appCount?: number;
  /**
   * Resolved nav flags from the server (round 3). Optional — when omitted,
   * every entry defaults to true so legacy callers that haven't been
   * updated yet keep their previous behaviour.
   */
  flags?: {
    appCountBadge?: boolean;
    notificationBell?: boolean;
    notificationBellPolling?: boolean;
    taskCenterTrigger?: boolean;
    mobileDrawer?: boolean;
    pagePrivacyMap?: boolean;
    pageStats?: boolean;
    pageShortlist?: boolean;
  };
}

interface NavLink {
  href: string;
  /** Translation key under `nav.links.*`. We carry the key (not the
   *  rendered label) on this static structure so re-renders of Nav
   *  pick up the active locale automatically. */
  labelKey:
    | 'home'
    | 'apps'
    | 'privacy_map'
    | 'stats'
    | 'shortlist'
    | 'changelog'
    | 'settings';
  exact?: boolean;
  dynamicBadge?: boolean;
  flagKey?: string;
}

const NAV_LINKS: NavLink[] = [
  { href: '/dashboard',           labelKey: 'home',         exact: true },
  { href: '/dashboard/apps',      labelKey: 'apps',         dynamicBadge: true },
  { href: '/dashboard/privacy',   labelKey: 'privacy_map',  flagKey: 'pagePrivacyMap' },
  { href: '/dashboard/stats',     labelKey: 'stats',        flagKey: 'pageStats' },
  { href: '/dashboard/shortlist', labelKey: 'shortlist',    flagKey: 'pageShortlist' },
  { href: '/changelog',           labelKey: 'changelog' },
  { href: '/dashboard/settings',  labelKey: 'settings' },
];

export default function Nav({ appCount, flags }: NavProps) {
  // i18n: nav-link labels, brand name, button copy, and ARIA text all
  // pull from the `nav` namespace. The translation function is stable
  // across renders (next-intl memoises by namespace), so it's safe to
  // capture in callbacks and the badge aria-label.
  const t = useTranslations('nav');

  // Default every nav-flag to true when not supplied. Caller pages opt in
  // by passing resolved values; pages that haven't been wired yet behave
  // exactly like before.
  const f = {
    appCountBadge: flags?.appCountBadge ?? true,
    notificationBell: flags?.notificationBell ?? true,
    notificationBellPolling: flags?.notificationBellPolling ?? true,
    taskCenterTrigger: flags?.taskCenterTrigger ?? true,
    mobileDrawer: flags?.mobileDrawer ?? true,
    pagePrivacyMap: flags?.pagePrivacyMap ?? true,
    pageStats: flags?.pageStats ?? true,
    pageShortlist: flags?.pageShortlist ?? true,
  };

  // Filter NAV_LINKS down to entries whose page-flag (when present) is on.
  const visibleLinks = NAV_LINKS.filter((link) => {
    if (!link.flagKey) return true;
    return f[link.flagKey as keyof typeof f] === true;
  });
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const isActive = useCallback(
    (href: string, exact = false) =>
      exact ? pathname === href : (pathname === href || pathname.startsWith(href + '/')),
    [pathname],
  );

  // Close the drawer on route change so navigating doesn't leave it stuck
  // open over the new page.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Close on Escape or outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (drawerRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen]);

  return (
    <nav className={`nav ${menuOpen ? 'nav-menu-open' : ''}`}>
      <Link href="/dashboard" className="nav-brand">
        {/* Served from /public; regenerate via `python3 tools/build_icons.py`. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="nav-brand-icon" src="/brand-icon.png" alt="" width={28} height={28} />
        {/* Typographic wordmark instead of plain text — "privacy" picks
            up the nav's foreground colour, "tracker" runs the brand
            #0a84ff → #5e5ce6 gradient (same SVG the About modal uses).
            Sized for nav scale. The aria-label keeps the link's
            accessible name on the brand string for screen readers,
            falling back to the localised t('brand') value. */}
        <BrandWordmark
          className="nav-brand-wordmark"
          height={20}
          ariaLabel={t('brand')}
        />
      </Link>

      <div className="nav-links nav-links-desktop">
        {visibleLinks.map(link => {
          const active = isActive(link.href, link.exact);
          const showBadge = link.dynamicBadge && appCount !== undefined && f.appCountBadge;
          // Coachmark tour spotlights Settings as the export-bundle entry
          // point for loved_one users. Tag the link so the tour can find it.
          const tourId = link.href === '/dashboard/settings' ? 'settings-link' : undefined;
          return (
            <Link
              key={link.href}
              href={link.href}
              data-tour={tourId}
              className={`nav-link ${active ? 'active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              {t(`links.${link.labelKey}`)}
              {showBadge && (
                <span
                  className="count-badge"
                  aria-label={t('apps_tracked_aria', { count: appCount ?? 0 })}
                >
                  {appCount}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      <div className="nav-right" data-tour="notification-bell">
        {f.taskCenterTrigger && <TaskCenterTrigger />}
        {f.notificationBell && <NotificationBell pollingEnabled={f.notificationBellPolling} />}
        {/* Dev menu used to render here. It now lives in the global
            footer landmark (app/layout.tsx) so it's reachable from
            every page — including non-navbar routes — and sits next
            to the accessibility / keyboard hint cluster bottom-right. */}
        <Link href="/onboard" className="btn btn-sm btn-primary nav-add-apps">
          <span className="nav-add-apps-label">{t('add_apps_label')}</span>
          <span className="nav-add-apps-compact" aria-hidden="true">+</span>
        </Link>
        {f.mobileDrawer && <button
          type="button"
          ref={triggerRef}
          className="nav-menu-trigger"
          aria-label={menuOpen ? t('menu_close_aria') : t('menu_open_aria')}
          aria-expanded={menuOpen}
          aria-controls="nav-drawer"
          onClick={() => setMenuOpen(open => !open)}
        >
          {/* Three stacked lines collapse to an X when the menu is open.
              We render both and swap visibility in CSS so the transition
              is cheap and the hit-target stays stable. */}
          <span className={`nav-menu-icon ${menuOpen ? 'nav-menu-icon-open' : ''}`} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>}
      </div>

      {f.mobileDrawer && <div
        id="nav-drawer"
        ref={drawerRef}
        className={`nav-drawer ${menuOpen ? 'nav-drawer-open' : ''}`}
        role="menu"
        aria-label={t('drawer_aria')}
        aria-hidden={!menuOpen}
      >
        {visibleLinks.map(link => {
          const active = isActive(link.href, link.exact);
          const showBadge = link.dynamicBadge && appCount !== undefined && f.appCountBadge;
          return (
            <Link
              key={link.href}
              href={link.href}
              role="menuitem"
              className={`nav-drawer-link ${active ? 'active' : ''}`}
              aria-current={active ? 'page' : undefined}
              tabIndex={menuOpen ? 0 : -1}
            >
              {t(`links.${link.labelKey}`)}
              {showBadge && (
                <span
                  className="count-badge"
                  aria-label={t('apps_tracked_aria', { count: appCount ?? 0 })}
                >
                  {appCount}
                </span>
              )}
            </Link>
          );
        })}
      </div>}
    </nav>
  );
}

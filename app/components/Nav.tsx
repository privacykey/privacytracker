"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import BrandWordmark from "./BrandWordmark";
import NotificationBell from "./NotificationBell";
import { TaskCenterTrigger } from "./TaskCenter";
import TaskListIcon from "./TaskListIcon";

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
    taskListIcon?: boolean;
    mobileDrawer?: boolean;
    pagePrivacyMap?: boolean;
    pageStats?: boolean;
    pageShortlist?: boolean;
  };
}

interface NavLink {
  dynamicBadge?: boolean;
  exact?: boolean;
  flagKey?: string;
  href: string;
  /** Translation key under `nav.links.*`. We carry the key (not the
   *  rendered label) on this static structure so re-renders of Nav
   *  pick up the active locale automatically. */
  labelKey:
    | "home"
    | "apps"
    | "privacy_map"
    | "stats"
    | "shortlist"
    | "changelog"
    | "settings";
}

const NAV_LINKS: NavLink[] = [
  { href: "/dashboard", labelKey: "home", exact: true },
  { href: "/dashboard/apps", labelKey: "apps", dynamicBadge: true },
  {
    href: "/dashboard/privacy",
    labelKey: "privacy_map",
    flagKey: "pagePrivacyMap",
  },
  { href: "/dashboard/stats", labelKey: "stats", flagKey: "pageStats" },
  {
    href: "/dashboard/shortlist",
    labelKey: "shortlist",
    flagKey: "pageShortlist",
  },
  { href: "/changelog", labelKey: "changelog" },
  { href: "/dashboard/settings", labelKey: "settings" },
];

// Sibling routes that should also light up a nav link. Today only
// `/dashboard/review-recommendations` aliases to `/dashboard/apps` —
// users treat the review queue as a dialog over the apps grid, so the
// Apps tab stays highlighted while they're inside it and clicking it
// acts as a "close-and-return" affordance. Module-scope const (not a
// component-body literal) so it doesn't trigger the
// `react-hooks/exhaustive-deps` warning on the `isActive` useCallback
// — the table is static across renders.
const NAV_ALIASES: Record<string, string[]> = {
  "/dashboard/apps": ["/dashboard/review-recommendations"],
};

export default function Nav({ appCount, flags }: NavProps) {
  // i18n: nav-link labels, brand name, button copy, and ARIA text all
  // pull from the `nav` namespace. The translation function is stable
  // across renders (next-intl memoises by namespace), so it's safe to
  // capture in callbacks and the badge aria-label.
  const t = useTranslations("nav");

  // Default every nav-flag to true when not supplied. Caller pages opt in
  // by passing resolved values; pages that haven't been wired yet behave
  // exactly like before.
  const f = {
    appCountBadge: flags?.appCountBadge ?? true,
    notificationBell: flags?.notificationBell ?? true,
    notificationBellPolling: flags?.notificationBellPolling ?? true,
    taskCenterTrigger: flags?.taskCenterTrigger ?? true,
    taskListIcon: flags?.taskListIcon ?? true,
    mobileDrawer: flags?.mobileDrawer ?? true,
    pagePrivacyMap: flags?.pagePrivacyMap ?? true,
    pageStats: flags?.pageStats ?? true,
    pageShortlist: flags?.pageShortlist ?? true,
  };

  // Filter NAV_LINKS down to entries whose page-flag (when present) is on.
  const visibleLinks = NAV_LINKS.filter((link) => {
    if (!link.flagKey) {
      return true;
    }
    return f[link.flagKey as keyof typeof f] === true;
  });
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  // Width tier, measured from the nav's own layout width rather than a
  // media query. offsetWidth is reported in the nav's local CSS pixels,
  // so when the in-app text scale zooms .app-main (html[data-a11y-scale],
  // see globals.css) the measured width shrinks to the effective space the
  // nav actually has — media queries keep reading the unzoomed viewport
  // and lie under zoom. Thresholds come from the rendered en-locale nav:
  // the full chrome needs ~1070px, the compact tier (icon brand + "+"
  // pill) ~840px; below that only the drawer fits. The ≤640px media block
  // stays as the SSR/no-JS baseline so phones never flash the full nav.
  const [tier, setTier] = useState<"full" | "compact" | "drawer">("full");
  useEffect(() => {
    const el = navRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const compute = () => {
      const w = el.offsetWidth;
      setTier(w <= 860 ? "drawer" : w <= 1100 ? "compact" : "full");
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isActive = useCallback(
    (href: string, exact = false) => {
      if (pathname === href) {
        return true;
      }
      if (!exact && pathname.startsWith(`${href}/`)) {
        return true;
      }
      const aliases = NAV_ALIASES[href];
      if (
        aliases?.some((a) => pathname === a || pathname.startsWith(`${a}/`))
      ) {
        return true;
      }
      return false;
    },
    [pathname]
  );

  // Close the drawer on route change so navigating doesn't leave it stuck
  // open over the new page.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Close on Escape or outside click.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (drawerRef.current?.contains(target)) {
        return;
      }
      if (triggerRef.current?.contains(target)) {
        return;
      }
      setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuOpen]);

  return (
    <nav
      className={`nav ${menuOpen ? "nav-menu-open" : ""}`}
      data-tier={tier}
      ref={navRef}
    >
      {/* aria-label on the link itself, not just the wordmark SVG: in
          compact/mobile tiers the wordmark is display:none (removed
          from the a11y tree) and only the alt="" icon remains, which
          left the link with an empty accessible name. */}
      <Link
        aria-label={t("brand_home_aria")}
        className="nav-brand"
        href="/dashboard"
      >
        {/* Served from /public; regenerate via `python3 tools/build_icons.py`. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          className="nav-brand-icon"
          height={28}
          src="/brand-icon.png"
          width={28}
        />
        {/* Typographic wordmark instead of plain text — "privacy" picks
            up the nav's foreground colour, "tracker" runs the brand
            #0a84ff → #5e5ce6 gradient (same SVG the About modal uses).
            Sized for nav scale. The aria-label keeps the link's
            accessible name on the brand string for screen readers,
            falling back to the localised t('brand') value. */}
        <BrandWordmark
          ariaLabel={t("brand")}
          className="nav-brand-wordmark"
          height={20}
        />
      </Link>

      <div className="nav-links nav-links-desktop">
        {visibleLinks.map((link) => {
          const active = isActive(link.href, link.exact);
          const showBadge =
            link.dynamicBadge && appCount !== undefined && f.appCountBadge;
          // Coachmark tour spotlights Settings as the export-bundle entry
          // point for loved_one users. Tag the link so the tour can find it.
          const tourId =
            link.href === "/dashboard/settings" ? "settings-link" : undefined;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={`nav-link ${active ? "active" : ""}`}
              data-tour={tourId}
              href={link.href}
              key={link.href}
            >
              {t(`links.${link.labelKey}`)}
              {showBadge && (
                <span
                  aria-label={t("apps_tracked_aria", { count: appCount ?? 0 })}
                  className="count-badge"
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
        {f.taskListIcon && <TaskListIcon />}
        {f.notificationBell && (
          <NotificationBell pollingEnabled={f.notificationBellPolling} />
        )}
        {/* Dev menu used to render here. It now lives in the global
            footer landmark (app/layout.tsx) so it's reachable from
            every page — including non-navbar routes — and sits next
            to the accessibility / keyboard hint cluster bottom-right. */}
        {/* aria-label keeps the accessible name in compact tiers, where
            the text span is display:none and only the aria-hidden "+"
            stays visible — the link previously had no name there. Same
            string as the visible desktop label (WCAG 2.5.3). */}
        <Link
          aria-label={t("add_apps_label")}
          className="btn btn-sm btn-primary nav-add-apps"
          href="/onboard"
        >
          <span className="nav-add-apps-label">{t("add_apps_label")}</span>
          <span aria-hidden="true" className="nav-add-apps-compact">
            +
          </span>
        </Link>
        {f.mobileDrawer && (
          <button
            aria-controls="nav-drawer"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? t("menu_close_aria") : t("menu_open_aria")}
            className="nav-menu-trigger"
            onClick={() => setMenuOpen((open) => !open)}
            ref={triggerRef}
            type="button"
          >
            {/* Three stacked lines collapse to an X when the menu is open.
              We render both and swap visibility in CSS so the transition
              is cheap and the hit-target stays stable. */}
            <span
              aria-hidden="true"
              className={`nav-menu-icon ${menuOpen ? "nav-menu-icon-open" : ""}`}
            >
              <span />
              <span />
              <span />
            </span>
          </button>
        )}
      </div>

      {f.mobileDrawer && (
        <div
          aria-hidden={!menuOpen}
          aria-label={t("drawer_aria")}
          className={`nav-drawer ${menuOpen ? "nav-drawer-open" : ""}`}
          id="nav-drawer"
          ref={drawerRef}
          role="menu"
        >
          {visibleLinks.map((link) => {
            const active = isActive(link.href, link.exact);
            const showBadge =
              link.dynamicBadge && appCount !== undefined && f.appCountBadge;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`nav-drawer-link ${active ? "active" : ""}`}
                href={link.href}
                key={link.href}
                role="menuitem"
                tabIndex={menuOpen ? 0 : -1}
              >
                {t(`links.${link.labelKey}`)}
                {showBadge && (
                  <span
                    aria-label={t("apps_tracked_aria", {
                      count: appCount ?? 0,
                    })}
                    className="count-badge"
                  >
                    {appCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}

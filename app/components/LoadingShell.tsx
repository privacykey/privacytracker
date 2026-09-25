"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import BrandWordmark from "./BrandWordmark";
import "./loading-shell.css";

/**
 * Neutral placeholders painted while the app's data is still on its way.
 *
 * Before these, a slow server meant a blank grey page: AppChrome held the
 * whole tree until the flag bundle settled, and each page loader then held
 * again until its own reads landed, so with every /api call taking 3 s
 * the dashboard had no nav and no text for about 13 s.
 *
 * Both pieces are deliberately free of anything a flag or a read decides.
 * The nav skeleton has the brand link and grey bars where the links will
 * be, never the links themselves (Privacy Map, Stats and Shortlist are
 * flag-gated, and a link that paints and then disappears is exactly what
 * AppChrome's hold exists to prevent). The page skeleton is a few grey
 * blocks marked `aria-busy`, with a "Loading…" status for screen readers.
 */

/** Routes whose pages render the top nav. The shell only shows a nav
 *  skeleton where a real nav will follow, so onboarding, the welcome
 *  page and the help pages never flash a nav they do not have. */
export function routeHasNav(pathname: string): boolean {
  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/apps/") ||
    pathname.startsWith("/manual-apps/") ||
    pathname === "/changelog"
  );
}

export function NavSkeleton() {
  const t = useTranslations("nav");
  return (
    <nav className="nav nav-skeleton" data-testid="nav-skeleton">
      <Link
        aria-label={t("brand_home_aria")}
        className="nav-brand"
        href="/dashboard"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          className="nav-brand-icon"
          height={28}
          src="/brand-icon.png"
          width={28}
        />
        <BrandWordmark
          ariaLabel={t("brand")}
          className="nav-brand-wordmark"
          height={20}
        />
      </Link>
      <div aria-hidden="true" className="nav-links nav-links-desktop">
        <span className="loading-shell-bar nav-skeleton-link" />
        <span className="loading-shell-bar nav-skeleton-link" />
        <span className="loading-shell-bar nav-skeleton-link" />
        <span className="loading-shell-bar nav-skeleton-link" />
      </div>
      <div aria-hidden="true" className="nav-right">
        <span className="loading-shell-bar nav-skeleton-action" />
      </div>
    </nav>
  );
}

export function PageSkeleton() {
  const t = useTranslations("common");
  return (
    <div
      aria-busy="true"
      className="page-container loading-shell-page"
      data-testid="page-skeleton"
      role="status"
    >
      <span className="sr-only">{t("loading")}</span>
      <div aria-hidden="true" className="loading-shell-blocks">
        <span className="loading-shell-bar loading-shell-title" />
        <span className="loading-shell-bar loading-shell-line" />
        <span className="loading-shell-bar loading-shell-card" />
        <span className="loading-shell-bar loading-shell-card" />
      </div>
    </div>
  );
}

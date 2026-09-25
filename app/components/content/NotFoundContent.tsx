"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import GithubIssueLink from "../GithubIssueLink";

/**
 * 404 body (Rust-core Phase 0, layout batch). The page used to be a
 * server component reading the Referer HEADER for its back link, which
 * made the not-found route dynamic. document.referrer carries the same
 * information on the client with the same same-origin check, so the
 * route prerenders statically and the back link fills in after mount.
 */

function pathToLabelKey(path: string): string {
  if (path.startsWith("/apps/")) {
    return "app";
  }
  if (path === "/dashboard/apps") {
    return "apps";
  }
  if (path === "/dashboard/privacy") {
    return "privacy_map";
  }
  if (path === "/dashboard/stats") {
    return "stats";
  }
  if (path === "/dashboard/manual-apps") {
    return "manual_apps";
  }
  if (path === "/dashboard/settings") {
    return "settings";
  }
  if (path === "/dashboard/settings/import-history") {
    return "import_history";
  }
  if (path === "/dashboard/shortlist") {
    return "shortlist";
  }
  if (path === "/dashboard/compare") {
    return "compare";
  }
  if (path === "/dashboard") {
    return "dashboard";
  }
  if (path === "/onboard") {
    return "onboarding";
  }
  if (path === "/welcome") {
    return "welcome";
  }
  if (path === "/help/definitions") {
    return "definitions";
  }
  if (path === "/privacy-policy") {
    return "privacy_policy";
  }
  if (path === "/legal") {
    return "legal";
  }
  return "previous_page";
}

/**
 * Resolve the "Back" link from document.referrer. Same-origin only —
 * compares host segments exactly as the server version compared the
 * Referer against the Host header — and never for the 404 itself or
 * the redirect-only root.
 */
function resolveBackLink(): { href: string; labelKey: string } | null {
  try {
    const referer = document.referrer;
    if (!referer) {
      return null;
    }
    const url = new URL(referer);
    if (url.host.toLowerCase() !== window.location.host.toLowerCase()) {
      return null;
    }
    const path = url.pathname;
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.length > 200 ||
      /[\s<>]/.test(path) ||
      /[a-z][a-z0-9+.-]*:/i.test(path)
    ) {
      return null;
    }
    if (path === "/" || path === "/404" || path === window.location.pathname) {
      return null;
    }
    return { href: path + url.search, labelKey: pathToLabelKey(path) };
  } catch {
    return null;
  }
}

export default function NotFoundContent() {
  const t = useTranslations("not_found");
  const [back, setBack] = useState<{ href: string; labelKey: string } | null>(
    null
  );
  useEffect(() => {
    setBack(resolveBackLink());
  }, []);

  return (
    <div
      aria-labelledby="notfound-title"
      className="notfound-root"
      role="alert"
    >
      {/* Colours come from the theme tokens in globals.css, so the page
          follows light, dark, a pinned theme and high contrast like every
          other surface. It used to hard-code the dark palette and patch
          light mode with its own media query, which missed the issue
          line (#8e8e93 on white, 3.3:1) and ignored a pinned theme. */}
      <style>{`
        .notfound-root {
          min-height: calc(100vh - 60px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: var(--bg);
          color: var(--text);
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        .notfound-card {
          width: 100%;
          max-width: 560px;
          background: var(--bg-2);
          border: 1px solid var(--border);
          border-radius: 24px;
          padding: 40px 36px;
          text-align: center;
          box-shadow: var(--shadow-lg);
        }
        .notfound-brand {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          margin-bottom: 32px;
        }
        .notfound-logo {
          width: 44px;
          height: 44px;
          border-radius: 10px;
          display: block;
          object-fit: cover;
          box-shadow: 0 4px 14px rgba(10, 132, 255, 0.35);
        }
        .notfound-brand-name {
          font-size: 17px;
          font-weight: 600;
          letter-spacing: -0.01em;
          color: var(--text);
        }
        .notfound-code {
          font-size: 72px;
          font-weight: 700;
          letter-spacing: -0.04em;
          line-height: 1;
          margin: 0 0 16px;
          background: linear-gradient(135deg, var(--blue) 0%, #5e5ce6 100%);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          color: var(--blue); /* fallback for browsers without background-clip */
        }
        .notfound-eyebrow {
          display: block;
          width: 100%;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--text-3);
          margin: 0 0 12px;
        }
        .notfound-title {
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--text);
          margin: 0 0 12px;
          line-height: 1.2;
        }
        .notfound-subtitle {
          font-size: 15px;
          line-height: 1.55;
          color: var(--text-2);
          margin: 0 auto 28px;
          max-width: 440px;
        }
        .notfound-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          justify-content: center;
          margin-bottom: 24px;
        }
        .notfound-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 11px 22px;
          border-radius: 12px;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: -0.01em;
          text-decoration: none;
          transition: transform 0.12s ease, background 0.12s ease, border-color 0.12s ease;
        }
        .notfound-btn-primary {
          background: linear-gradient(135deg, var(--blue-fill) 0%, #5e5ce6 100%);
          color: #ffffff;
          box-shadow: 0 4px 14px rgba(10, 132, 255, 0.35);
        }
        .notfound-btn-primary:hover {
          transform: translateY(-1px);
        }
        /* High contrast: --blue-fill is yellow, so a solid fill with a
           black label, as .btn-primary gets. */
        html[data-theme-override="high-contrast"] .notfound-btn-primary {
          background: var(--blue-fill);
          color: #000000;
        }
        .notfound-btn-secondary {
          background: var(--surface);
          border: 1px solid var(--border-strong);
          color: var(--text);
        }
        .notfound-btn-secondary:hover {
          background: var(--surface-hover);
        }
        .notfound-btn:focus-visible {
          outline: 2px solid var(--blue);
          outline-offset: 3px;
        }
        .notfound-hint {
          font-size: 13px;
          color: var(--text-2);
          line-height: 1.55;
          margin: 0;
        }
        .notfound-hint a {
          color: var(--blue);
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .notfound-hint a:hover {
          text-decoration-thickness: 2px;
        }
        .notfound-issue {
          margin-top: 28px;
          padding-top: 20px;
          border-top: 1px solid var(--border);
          font-size: 12px;
          color: var(--text-3);
          line-height: 1.5;
        }
        .notfound-issue a {
          color: inherit;
          text-decoration: none;
          transition: color 0.12s ease;
        }
        .notfound-issue a span {
          color: var(--blue);
          font-weight: 500;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .notfound-issue a:hover span,
        .notfound-issue a:focus-visible span {
          text-decoration-thickness: 2px;
        }
        .notfound-issue a:focus-visible {
          outline: 2px solid var(--blue);
          outline-offset: 3px;
          border-radius: 4px;
        }
        @media (max-width: 480px) {
          .notfound-card {
            padding: 32px 24px;
            border-radius: 20px;
          }
          .notfound-code {
            font-size: 60px;
          }
          .notfound-title {
            font-size: 22px;
          }
          .notfound-subtitle {
            font-size: 14px;
          }
        }
      `}</style>
      <section className="notfound-card">
        <div className="notfound-brand">
          {/* Regenerated via `python3 tools/build_icons.py` → public/brand-icon.png. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt=""
            className="notfound-logo"
            height={44}
            src="/brand-icon.png"
            width={44}
          />
          <span className="notfound-brand-name">privacytracker</span>
        </div>
        <p aria-hidden="true" className="notfound-code">
          404
        </p>
        <span className="notfound-eyebrow">{t("eyebrow")}</span>
        <h1 className="notfound-title" id="notfound-title">
          {t("title")}
        </h1>
        <p className="notfound-subtitle">{t("subtitle")}</p>
        <div className="notfound-actions">
          {back ? (
            <>
              <Link
                className="notfound-btn notfound-btn-primary"
                href={back.href}
              >
                {t("back_to", { label: t(`back_labels.${back.labelKey}`) })}
              </Link>
              <Link className="notfound-btn notfound-btn-secondary" href="/">
                {t("home")}
              </Link>
            </>
          ) : (
            <>
              <Link className="notfound-btn notfound-btn-primary" href="/">
                {t("home")}
              </Link>
              <Link
                className="notfound-btn notfound-btn-secondary"
                href="/dashboard"
              >
                {t("go_to_dashboard")}
              </Link>
            </>
          )}
        </div>
        <p className="notfound-hint">
          {t.rich("hint", {
            link: (chunks) => <Link href="/dashboard/apps">{chunks}</Link>,
          })}
        </p>
        {/* Bottom "report a bug" link. The GithubIssueLink client component
            builds a prefilled issue URL using window.location.href and
            document.referrer so maintainers see where the 404 happened and
            how the user got there. Styles live in .notfound-issue above. */}
        <p className="notfound-issue">
          <GithubIssueLink />
        </p>
      </section>
    </div>
  );
}

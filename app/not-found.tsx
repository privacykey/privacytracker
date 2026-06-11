import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import GithubIssueLink from "./components/GithubIssueLink";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("not_found_title"),
    description: t("not_found_description"),
  };
}

/**
 * App Router catches every unknown URL with this file. It's a server
 * component (no `"use client"`) so it renders straight from HTML — no
 * JavaScript needed, matching the <noscript> fallback in `app/layout.tsx`.
 *
 * Design mirrors the no-JS card: same brand gradient, same dark/light mode
 * breakpoints, same 24 px card radius. Styles are inlined and scoped with
 * a `.notfound-` prefix so the page still renders correctly even if the
 * global stylesheet is blocked.
 */

/**
 * Map a same-origin pathname to a `not_found.back_labels.*` translation key
 * for the back button. Mirrors `resolveBackLink` in
 * `app/help/definitions/page.tsx`, but operates on the `Referer` header
 * instead of a `?from=` query param because callers don't opt into linking
 * to the 404 page.
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
 * Resolve the "Back" link from the incoming Referer header. Returns null if
 * the referer is missing, off-origin, malformed, or points at the 404 page
 * itself (in which case offering "back" would loop the user).
 *
 * Same-origin check is critical: a hostile site could set Referer to
 * anything, but because we strip everything except the pathname of a URL
 * object whose host matches ours, there's no way for an attacker to land a
 * `javascript:` URI or a cross-origin redirect here.
 */
async function resolveBackLink(): Promise<{
  href: string;
  labelKey: string;
} | null> {
  try {
    const h = await headers();
    const referer = h.get("referer");
    const host = h.get("host");
    if (!(referer && host)) {
      return null;
    }

    let url: URL;
    try {
      url = new URL(referer);
    } catch {
      return null;
    }

    // Same-origin only. Compares the host segment (hostname + port) directly;
    // case-insensitive to match how the proxy does it.
    if (url.host.toLowerCase() !== host.toLowerCase()) {
      return null;
    }

    const path = url.pathname;
    // Belt-and-braces: pathname always starts with `/` on a valid URL, but
    // reject protocol-relative / empty / schemed strings if anything
    // exotic leaked through.
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.length > 200 ||
      /[\s<>]/.test(path) ||
      /[a-z][a-z0-9+.-]*:/i.test(path)
    ) {
      return null;
    }

    // Avoid a loop if the user somehow arrived at the 404 from another 404,
    // and avoid offering "/" which is a redirect-only router page.
    if (path === "/" || path === "/404") {
      return null;
    }

    return { href: path + url.search, labelKey: pathToLabelKey(path) };
  } catch {
    return null;
  }
}

export default async function NotFound() {
  const t = await getTranslations("not_found");
  const back = await resolveBackLink();

  return (
    <div
      aria-labelledby="notfound-title"
      className="notfound-root"
      role="alert"
    >
      <style>{`
        .notfound-root {
          min-height: calc(100vh - 60px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #08080f;
          color: #f5f5f7;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        .notfound-card {
          width: 100%;
          max-width: 560px;
          background: #111118;
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 24px;
          padding: 40px 36px;
          text-align: center;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.02);
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
          color: #f5f5f7;
        }
        .notfound-code {
          font-size: 72px;
          font-weight: 700;
          letter-spacing: -0.04em;
          line-height: 1;
          margin: 0 0 16px;
          background: linear-gradient(135deg, #0a84ff 0%, #5e5ce6 100%);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          color: #0a84ff; /* fallback for browsers without background-clip */
        }
        .notfound-eyebrow {
          display: block;
          width: 100%;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #8e8e93;
          margin: 0 0 12px;
        }
        .notfound-title {
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: #f5f5f7;
          margin: 0 0 12px;
          line-height: 1.2;
        }
        .notfound-subtitle {
          font-size: 15px;
          line-height: 1.55;
          color: #8e8e93;
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
          background: linear-gradient(135deg, #0a84ff 0%, #5e5ce6 100%);
          color: #ffffff;
          box-shadow: 0 4px 14px rgba(10, 132, 255, 0.35);
        }
        .notfound-btn-primary:hover {
          transform: translateY(-1px);
        }
        .notfound-btn-secondary {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #f5f5f7;
        }
        .notfound-btn-secondary:hover {
          background: rgba(255, 255, 255, 0.08);
        }
        .notfound-btn:focus-visible {
          outline: 2px solid #0a84ff;
          outline-offset: 3px;
        }
        .notfound-hint {
          font-size: 13px;
          color: #8e8e93;
          line-height: 1.55;
          margin: 0;
        }
        .notfound-hint a {
          color: #0a84ff;
          text-decoration: none;
        }
        .notfound-hint a:hover {
          text-decoration: underline;
        }
        .notfound-issue {
          margin-top: 28px;
          padding-top: 20px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          font-size: 12px;
          color: #8e8e93;
          line-height: 1.5;
        }
        .notfound-issue a {
          color: inherit;
          text-decoration: none;
          transition: color 0.12s ease;
        }
        .notfound-issue a span {
          color: #0a84ff;
          font-weight: 500;
        }
        .notfound-issue a:hover span,
        .notfound-issue a:focus-visible span {
          text-decoration: underline;
        }
        .notfound-issue a:focus-visible {
          outline: 2px solid #0a84ff;
          outline-offset: 3px;
          border-radius: 4px;
        }
        @media (prefers-color-scheme: light) {
          .notfound-root {
            background: #f2f2f7;
            color: #1d1d1f;
          }
          .notfound-card {
            background: #ffffff;
            border-color: rgba(0, 0, 0, 0.07);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.02);
          }
          .notfound-logo {
            box-shadow: 0 4px 14px rgba(0, 113, 227, 0.3);
          }
          .notfound-code {
            background: linear-gradient(135deg, #0071e3 0%, #5e5ce6 100%);
            -webkit-background-clip: text;
            background-clip: text;
            color: #0071e3;
          }
          .notfound-brand-name,
          .notfound-title {
            color: #1d1d1f;
          }
          .notfound-eyebrow,
          .notfound-subtitle,
          .notfound-hint {
            color: #6e6e73;
          }
          .notfound-btn-primary {
            background: linear-gradient(135deg, #0071e3 0%, #5e5ce6 100%);
            box-shadow: 0 4px 14px rgba(0, 113, 227, 0.3);
          }
          .notfound-btn-secondary {
            background: rgba(0, 0, 0, 0.03);
            border-color: rgba(0, 0, 0, 0.08);
            color: #1d1d1f;
          }
          .notfound-btn-secondary:hover {
            background: rgba(0, 0, 0, 0.06);
          }
          .notfound-hint a {
            color: #0071e3;
          }
          .notfound-issue {
            border-top-color: rgba(0, 0, 0, 0.07);
          }
          .notfound-issue a span {
            color: #0071e3;
          }
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

import type { Metadata, Viewport } from "next";
import "./globals.css";
import { getTranslations } from "next-intl/server";
import AppChrome from "./components/AppChrome";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("root_title"),
    description: t("root_description"),
  };
}

// No maximumScale cap: Android Chrome honours it and disables pinch-zoom
// entirely (WCAG 1.4.4 failure), while iOS ignores it anyway. The iOS
// focus-auto-zoom problem it used to guard against is solved by keeping
// every input's font-size >= 16px (see the comment in app/globals.css
// around the form-control sizing rules).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#08080f" },
  ],
};

/**
 * Root layout — STATIC (Rust-core Phase 0, layout batch).
 *
 * No headers(), no cookies(), no DB reads, no force-dynamic. Everything
 * per-user moved into the client AppChrome: locale (LocaleProvider),
 * the login-page split (usePathname), the seven global-surface flags
 * (flag bundle), and titles (RouteTitle). What stays server-rendered is
 * build-time English by design: the <noscript> fallback (a JS-required
 * app explaining itself to a browser without JS) and generateMetadata's
 * <title>, which RouteTitle then localises.
 *
 * The a11y pre-hydration script carries no nonce any more — proxy.ts
 * emits a hash-based CSP generated from the prerendered HTML by
 * scripts/generate-csp-hashes.mjs, which covers it.
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tNojs = await getTranslations("nojs");

  return (
    // suppressHydrationWarning is essential here: the head script writes
    // a11y prefs as data-* attributes on <html> before React hydrates, so
    // the server-rendered <html> intentionally differs from the hydrated
    // one. The flag scopes only to this element, not children. Removing
    // it brings back the hydration warning whenever a user has any
    // non-default a11y pref persisted.
    //
    // data-scroll-behavior="smooth" is Next 16's opt-in for CSS-driven
    // smooth scrolling. Without it Next logs a dev warning and the
    // smooth-scroll animation can fight route-transition scroll-to-top.
    <html data-scroll-behavior="smooth" lang="en" suppressHydrationWarning>
      <head suppressHydrationWarning>
        {/* Self-hosted Inter (v4.1, SIL OFL-1.1) — see /public/fonts/ +
            @font-face in app/globals.css. Italic loads lazily. */}
        <link
          as="font"
          crossOrigin="anonymous"
          href="/fonts/InterVariable.woff2"
          rel="preload"
          type="font/woff2"
        />
        {/* Pre-hydration bootstrapper for accessibility quick-toggles.
            Runs synchronously during HTML parsing so persisted prefs land
            as data-* attributes on <html> before first paint.

            A PLAIN inline script element on purpose (Rust-core Phase 0,
            layout batch): the beforeInteractive strategy of Next's Script
            component is not emitted in App Router HTML — Next ships it in
            the RSC payload and inserts it at runtime — so the build-time
            CSP hasher (scripts/generate-csp-hashes.mjs, which hashes the
            prerendered HTML) could never allowlist it and the policy
            blocked it on every page. As a real head script it is in the
            HTML, hashed, and allowed.

            Mirrors keys in AccessibilityQuickToggles.tsx (A11Y_STORAGE_KEYS).
            try/catch is for Safari private-mode windows where localStorage
            throws. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var h=document.documentElement;var f=localStorage.getItem('a11y-quick-font');if(f==='dyslexic')h.setAttribute('data-a11y-font','dyslexic');var s=localStorage.getItem('a11y-quick-scale');if(s==='large'||s==='x-large')h.setAttribute('data-a11y-scale',s);var t=localStorage.getItem('a11y-quick-theme');if(t==='light'||t==='dark'||t==='high-contrast')h.setAttribute('data-theme-override',t);var sh=localStorage.getItem('a11y-quick-shapes');if(sh==='on')h.setAttribute('data-a11y-shapes','on');var sd=localStorage.getItem('a11y-quick-solid');if(sd==='on')h.setAttribute('data-a11y-solid','on');}catch(e){}})();`,
          }}
          id="a11y-prefs-bootstrap"
        />
      </head>
      <body>
        {/* No-JavaScript fallback. Styles are inlined so the page still
            renders if external stylesheets are blocked alongside JS. */}
        <noscript>
          <style>{`
            .nojs-root {
              position: fixed;
              inset: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 24px;
              font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #08080f;
              color: #f5f5f7;
              z-index: 2147483647;
              overflow-y: auto;
              -webkit-font-smoothing: antialiased;
              -moz-osx-font-smoothing: grayscale;
            }
            .nojs-card {
              width: 100%;
              max-width: 560px;
              background: #111118;
              border: 1px solid rgba(255, 255, 255, 0.07);
              border-radius: 24px;
              padding: 40px 36px;
              text-align: center;
              box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.02);
            }
            .nojs-brand {
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 12px;
              margin-bottom: 32px;
            }
            .nojs-logo {
              width: 44px;
              height: 44px;
              border-radius: 10px;
              display: block;
              object-fit: cover;
              box-shadow: 0 4px 14px rgba(10, 132, 255, 0.35);
            }
            .nojs-brand-name {
              font-size: 17px;
              font-weight: 600;
              letter-spacing: -0.01em;
              color: #f5f5f7;
            }
            .nojs-eyebrow {
              display: block;
              width: 100%;
              font-size: 11px;
              font-weight: 700;
              letter-spacing: 0.12em;
              text-transform: uppercase;
              color: #8e8e93;
              margin: 0 0 20px;
            }
            .nojs-title {
              font-size: 26px;
              font-weight: 700;
              letter-spacing: -0.02em;
              color: #f5f5f7;
              margin: 0 0 12px;
              line-height: 1.2;
            }
            .nojs-subtitle {
              font-size: 15px;
              line-height: 1.55;
              color: #8e8e93;
              margin: 0 auto 28px;
              max-width: 440px;
            }
            .nojs-list {
              list-style: none;
              padding: 0;
              margin: 0 0 24px;
              text-align: left;
              display: flex;
              flex-direction: column;
              gap: 10px;
            }
            .nojs-list-item {
              display: flex;
              align-items: flex-start;
              gap: 12px;
              padding: 12px 14px;
              background: rgba(255, 255, 255, 0.03);
              border: 1px solid rgba(255, 255, 255, 0.06);
              border-radius: 12px;
              font-size: 14px;
              line-height: 1.5;
              color: #f5f5f7;
            }
            .nojs-list-num {
              flex-shrink: 0;
              width: 22px;
              height: 22px;
              border-radius: 50%;
              background: rgba(10, 132, 255, 0.15);
              color: #0a84ff;
              font-size: 12px;
              font-weight: 600;
              display: flex;
              align-items: center;
              justify-content: center;
              margin-top: 1px;
            }
            .nojs-hint {
              font-size: 13px;
              color: #8e8e93;
              line-height: 1.55;
              margin: 0;
            }
            .nojs-code {
              display: block;
              margin: 10px auto 0;
              padding: 8px 12px;
              background: rgba(255, 255, 255, 0.06);
              border: 1px solid rgba(255, 255, 255, 0.08);
              border-radius: 8px;
              font-family: 'SF Mono', ui-monospace, 'Menlo', monospace;
              font-size: 12px;
              color: #f5f5f7;
              max-width: fit-content;
            }
            @media (prefers-color-scheme: light) {
              .nojs-root {
                background: #f2f2f7;
                color: #1d1d1f;
              }
              .nojs-card {
                background: #ffffff;
                border-color: rgba(0, 0, 0, 0.07);
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.02);
              }
              .nojs-logo {
                box-shadow: 0 4px 14px rgba(0, 113, 227, 0.3);
              }
              .nojs-brand-name,
              .nojs-title,
              .nojs-list-item {
                color: #1d1d1f;
              }
              .nojs-eyebrow,
              .nojs-subtitle,
              .nojs-hint {
                color: #6e6e73;
              }
              .nojs-list-item {
                background: rgba(0, 0, 0, 0.02);
                border-color: rgba(0, 0, 0, 0.06);
              }
              .nojs-list-num {
                background: rgba(0, 113, 227, 0.1);
                color: #0071e3;
              }
              .nojs-code {
                background: rgba(0, 0, 0, 0.04);
                border-color: rgba(0, 0, 0, 0.08);
                color: #1d1d1f;
              }
            }
            @media (max-width: 480px) {
              .nojs-card {
                padding: 32px 24px;
                border-radius: 20px;
              }
              .nojs-title {
                font-size: 22px;
              }
              .nojs-subtitle {
                font-size: 14px;
              }
            }
          `}</style>
          <div aria-live="assertive" className="nojs-root" role="alert">
            <main aria-labelledby="nojs-title" className="nojs-card">
              <section className="nojs-brand">
                {/* Regenerated via tools/build_icons.py → public/brand-icon.png. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt=""
                  className="nojs-logo"
                  height={44}
                  src="/brand-icon.png"
                  width={44}
                />
                <span className="nojs-brand-name">privacytracker</span>
              </section>
              <span className="nojs-eyebrow">{tNojs("eyebrow")}</span>
              <h1 className="nojs-title" id="nojs-title">
                {tNojs("title")}
              </h1>
              <p className="nojs-subtitle">{tNojs("subtitle")}</p>
              <ol className="nojs-list">
                <li className="nojs-list-item">
                  <span aria-hidden="true" className="nojs-list-num">
                    1
                  </span>
                  <span>{tNojs("step_enable")}</span>
                </li>
                <li className="nojs-list-item">
                  <span aria-hidden="true" className="nojs-list-num">
                    2
                  </span>
                  <span>{tNojs("step_allowlist")}</span>
                </li>
                <li className="nojs-list-item">
                  <span aria-hidden="true" className="nojs-list-num">
                    3
                  </span>
                  <span>{tNojs("step_refresh")}</span>
                </li>
              </ol>
              <p className="nojs-hint">
                {tNojs("hint_lead")}
                <span className="nojs-code">{tNojs("hint_path")}</span>
              </p>
            </main>
          </div>
        </noscript>
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}

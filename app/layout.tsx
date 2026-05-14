import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { headers } from 'next/headers';
import './globals.css';
import { TaskCenterProvider } from './components/TaskCenter';
import { QueuedSearchProvider } from './components/QueuedSearchProvider';
import { ImportQueueProvider } from './components/ImportQueueProvider';
import ClientDiagnosticsBoot from './components/ClientDiagnosticsBoot';
import KeyboardShortcuts from './components/KeyboardShortcuts';
import KeyboardHint from './components/KeyboardHint';
import SiteInfoHint from './components/SiteInfoHint';
import AboutModal from './components/AboutModal';
import AccessibilityQuickToggles from './components/AccessibilityQuickToggles';
import DevMenu from './components/DevMenu';
import NextDevIndicatorRepositioner from './components/NextDevIndicatorRepositioner';
import NavigationHistoryTracker from './components/NavigationHistoryTracker';
import AdminTokenBridge from './components/AdminTokenBridge';
import MenuActionsBridge from './components/MenuActionsBridge';
import FocusPreviewBanner from './components/FocusPreviewBanner';
import UpdateBanner from './components/UpdateBanner';
import FlagHighlightHandler from './components/FlagHighlightHandler';
import { resolveFlagFromDb } from '@/lib/feature-flags-server';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'privacytracker — iOS App Privacy Labels',
  description: 'Monitor, track, and get alerted when iOS apps change their privacy labels.',
};

// maximumScale = 1 stops iOS Safari from auto-zooming on focus, which on
// dense tables pushed the page into horizontal-scroll mode. Users can
// still pinch-zoom out and OS-level accessibility zoom is unaffected.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f2f2f7' },
    { media: '(prefers-color-scheme: dark)',  color: '#08080f' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // next-intl bootstrap. Locale fixed at 'en' in i18n.ts; this primes
  // useTranslations() in client components. Server components call
  // getTranslations() directly.
  const locale = await getLocale();
  const messages = await getMessages();
  const tFooter = await getTranslations('footer');

  // Per-request CSP nonce, minted by proxy.ts and forwarded via the
  // `x-nonce` request header. Read here and threaded into every inline
  // <Script> we render so the nonce is identical between server-rendered
  // HTML and client hydration — otherwise React 19's hydration check
  // sees `nonce=""` vs `nonce={undefined}` and warns.
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  // Resolve global-surface flags once per request. Each is wrapped in
  // try/catch so a fresh-install DB or resolver mishap doesn't take down
  // the layout — defaults to 'on' to preserve pre-flag UX on failure.
  const flags = {
    keyboardShortcuts: safeResolve('flag.global.keyboard_shortcuts', 'on'),
    siteInfoHint: safeResolve('flag.global.site_info_hint', 'on'),
    aboutModal: safeResolve('flag.global.about_modal', 'on'),
    accessibilityToggles: safeResolve('flag.global.accessibility_toggles', 'on'),
    taskCenterPolling: safeResolve('flag.taskcenter.polling', 'on'),
    taskCenterAutoDismiss: safeResolve('flag.taskcenter.auto_dismiss', 'on'),
    taskCenterResumeCards: safeResolve('flag.taskcenter.resume_cards', 'on'),
  };

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
    <html lang={locale} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Self-hosted Inter (v4.1, SIL OFL-1.1) — see /public/fonts/ +
            @font-face in app/globals.css. Italic loads lazily. */}
        <link
          rel="preload"
          href="/fonts/InterVariable.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        {/* Pre-hydration bootstrapper for accessibility quick-toggles.
            MUST run synchronously before any stylesheet to apply persisted
            prefs before first paint, otherwise users see a flash from
            default styles to their chosen theme.

            Uses <Script strategy="beforeInteractive"> because it's the only
            App Router mechanism that lands as the first child of <head>
            (raw <script> rendered through React ends up AFTER Next's CSS
            link, and CSSOM-blocking would defer it past first paint).

            Mirrors keys in AccessibilityQuickToggles.tsx (A11Y_STORAGE_KEYS).
            try/catch is for Safari private-mode windows where localStorage
            throws. Fires a dev-mode "Encountered a script tag while
            rendering React" warning that's a false positive — it runs once
            during HTML parsing as intended. */}
        <Script
          id="a11y-prefs-bootstrap"
          strategy="beforeInteractive"
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var h=document.documentElement;var f=localStorage.getItem('a11y-quick-font');if(f==='dyslexic')h.setAttribute('data-a11y-font','dyslexic');var s=localStorage.getItem('a11y-quick-scale');if(s==='large'||s==='x-large')h.setAttribute('data-a11y-scale',s);var t=localStorage.getItem('a11y-quick-theme');if(t==='light'||t==='dark'||t==='high-contrast')h.setAttribute('data-theme-override',t);var sh=localStorage.getItem('a11y-quick-shapes');if(sh==='on')h.setAttribute('data-a11y-shapes','on');var sd=localStorage.getItem('a11y-quick-solid');if(sd==='on')h.setAttribute('data-a11y-solid','on');}catch(e){}})();`,
          }}
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
          <div className="nojs-root" role="alert" aria-live="assertive">
            <main className="nojs-card" aria-labelledby="nojs-title">
              <div className="nojs-brand">
                {/* Regenerated via tools/build_icons.py → public/brand-icon.png. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="nojs-logo" src="/brand-icon.png" alt="" width={44} height={44} />
                <span className="nojs-brand-name">privacytracker</span>
              </div>
              <span className="nojs-eyebrow">JavaScript required</span>
              <h1 id="nojs-title" className="nojs-title">This app needs JavaScript to run</h1>
              <p className="nojs-subtitle">
                privacytracker renders its dashboard, onboarding wizard, and privacy-label
                timelines on the client. Without JavaScript there&apos;s nothing to show.
              </p>
              <ol className="nojs-list">
                <li className="nojs-list-item">
                  <span className="nojs-list-num" aria-hidden="true">1</span>
                  <span>Re-enable JavaScript in your browser settings.</span>
                </li>
                <li className="nojs-list-item">
                  <span className="nojs-list-num" aria-hidden="true">2</span>
                  <span>If you use a content blocker, allowlist this domain.</span>
                </li>
                <li className="nojs-list-item">
                  <span className="nojs-list-num" aria-hidden="true">3</span>
                  <span>Refresh the page.</span>
                </li>
              </ol>
              <p className="nojs-hint">
                In most browsers, JavaScript lives under:
                <span className="nojs-code">Settings → Privacy &amp; security → Site settings → JavaScript</span>
              </p>
            </main>
          </div>
        </noscript>
        {/* Banner landmark wraps the skip-link so no content sits outside
            a landmark region (axe "region" rule). */}
        <header className="app-banner" aria-label={tFooter('skip_landmark')}>
          <a href="#main-content" className="skip-link">{tFooter('skip_to_content')}</a>
        </header>
        {/* next-intl client provider — primes useTranslations() beneath. */}
        <NextIntlClientProvider locale={locale} messages={messages}>
        <TaskCenterProvider
          pollingEnabled={flags.taskCenterPolling}
          autoDismissEnabled={flags.taskCenterAutoDismiss}
          resumeCardsEnabled={flags.taskCenterResumeCards}
        >
          <QueuedSearchProvider>
            <ImportQueueProvider>
              {/* Boots the client diagnostics module (long-task observer,
                  fetch wrapper, import-event ring). Renders nothing —
                  surface is read from the Diagnostics page. */}
              <ClientDiagnosticsBoot />
              {/* Path tracker. Writes pathname+search to sessionStorage on
                  every navigation so downstream pages can render a "← Back
                  to X" link (document.referrer alone is unreliable —
                  Next's soft navigations don't update it). */}
              <NavigationHistoryTracker />
              <AdminTokenBridge />
              {/* Listens for menu-bar-driven events (Cmd+F search focus,
                  Help → Copy Diagnostics). The actual menu items live
                  in src-tauri/src/app_menu.rs; this component is the
                  webview-side counterpart. */}
              <MenuActionsBridge />
              {/* Focus preview banner — only renders when a preview is staged. */}
              <FocusPreviewBanner />
              {/* Update banner — polls /api/update-status; self-gated on
                  cache state + user-dismissed flag. */}
              <UpdateBanner />
              {/* Cross-page flag-highlight handler — reads
                  `?flag-highlight=<key>` and rings the gated element. */}
              <FlagHighlightHandler />
              <main id="main-content" tabIndex={-1} className="app-main">
                {children}
              </main>
              {/* Footer landmark (role="contentinfo") groups the bottom-
                  right cluster (About, shortcuts, a11y) under one region.
                  Widgets are flag-gated; the landmark always renders. */}
              <footer className="app-footer-landmark">
                {/* Dev menu — gated on flag.devopts.visible + the
                    `dev-menu-on` localStorage opt-in. Renders null when
                    either gate is off. */}
                <DevMenu />
                {/* Reposition the Next.js dev indicator above our cluster.
                    Renders null in production. */}
                <NextDevIndicatorRepositioner />
                {flags.accessibilityToggles && <AccessibilityQuickToggles />}
                {flags.keyboardShortcuts && <KeyboardHint />}
                {/* Bottom-LEFT pill — Privacy policy / Legal links. */}
                {flags.siteInfoHint && <SiteInfoHint />}
              </footer>
            </ImportQueueProvider>
          </QueuedSearchProvider>
        </TaskCenterProvider>
        {/* Global overlay portals — dialogs that render outside the main
            landmark when open. The region wrapper keeps axe happy even
            when both overlays are flag-off. */}
        <div role="region" aria-label="Global overlays">
          {flags.keyboardShortcuts && <KeyboardShortcuts />}
          {flags.aboutModal && <AboutModal />}
        </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

/**
 * Wrapper around resolveFlagFromDb that swallows resolver errors so a
 * fresh-install DB or mid-migration state can't take down the layout.
 */
function safeResolve(
  key: Parameters<typeof resolveFlagFromDb>[0],
  fallbackOn: 'on' | 'off',
): boolean {
  try {
    return resolveFlagFromDb(key) === 'on';
  } catch {
    return fallbackOn === 'on';
  }
}

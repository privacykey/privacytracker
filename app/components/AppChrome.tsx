"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useFlagBundle, useFlagBundleStatus } from "@/lib/use-flag-bundle";
import AboutModal from "./AboutModal";
import AccessibilityQuickToggles from "./AccessibilityQuickToggles";
import AdminTokenBridge from "./AdminTokenBridge";
import ClientDiagnosticsBoot from "./ClientDiagnosticsBoot";
import DevMenu from "./DevMenu";
import FlagHighlightHandler from "./FlagHighlightHandler";
import FocusPreviewBanner from "./FocusPreviewBanner";
import { ImportQueueProvider } from "./ImportQueueProvider";
import KeyboardHint from "./KeyboardHint";
import KeyboardShortcuts from "./KeyboardShortcuts";
import LocaleProvider from "./LocaleProvider";
import MenuActionsBridge from "./MenuActionsBridge";
import NavigationHistoryTracker from "./NavigationHistoryTracker";
import NextDevIndicatorRepositioner from "./NextDevIndicatorRepositioner";
import NonLocalReadOnlyBanner from "./NonLocalReadOnlyBanner";
import { QueuedSearchProvider } from "./QueuedSearchProvider";
import RouteTitle from "./RouteTitle";
import SiteInfoHint from "./SiteInfoHint";
import { TaskCenterProvider } from "./TaskCenter";
import UpdateBanner from "./UpdateBanner";
import { UserTasksProvider } from "./UserTasksProvider";

/**
 * The app's chrome — providers, skip-link, footer widgets, overlays —
 * as a CLIENT component (Rust-core Phase 0, layout batch).
 *
 * This is what lets app/layout.tsx become static. The layout used to
 * make three per-request reads that forced every route dynamic:
 *   - headers() for the CSP nonce (gone: hash-based CSP needs none),
 *   - headers() for the login-page flag the proxy set (here it's
 *     `usePathname() === "/login"`, which is known at prerender time
 *     for the route being rendered and again at hydration — no header),
 *   - resolveFlagFromDb() ×7 for the global-surface flags (here they come
 *     from the shared client flag bundle).
 *
 * The login page gets a BARE tree — just the locale provider around the
 * form — so no dashboard provider starts polling private APIs from the
 * anonymous page (that was the point of the old header branch).
 *
 * Flags fail OPEN and the tree is held until they settle: the layout
 * defaulted every global flag to "on" when the resolver failed, and the
 * TaskCenterProvider seeds its polling from these props at mount, so it
 * must not mount with placeholders.
 */

const CHROME_FLAG_KEYS = [
  "flag.global.keyboard_shortcuts",
  "flag.global.site_info_hint",
  "flag.global.about_modal",
  "flag.global.accessibility_toggles",
  "flag.taskcenter.polling",
  "flag.taskcenter.auto_dismiss",
  "flag.taskcenter.resume_cards",
] as const;

export default function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <LocaleProvider>
      <RouteTitle />
      {pathname === "/login" ? children : <ChromeTree>{children}</ChromeTree>}
    </LocaleProvider>
  );
}

function ChromeTree({ children }: { children: ReactNode }) {
  const tFooter = useTranslations("footer");
  const tRegions = useTranslations("layout_regions");
  const bundle = useFlagBundle(CHROME_FLAG_KEYS);
  const { failedToLoad } = useFlagBundleStatus();
  if (!(bundle || failedToLoad)) {
    return null;
  }
  const on = (key: (typeof CHROME_FLAG_KEYS)[number]) =>
    failedToLoad || !bundle ? true : bundle[key];

  return (
    <>
      {/* Banner landmark wraps the skip-link so no content sits outside
        a landmark region (axe "region" rule). */}
      <header aria-label={tFooter("skip_landmark")} className="app-banner">
        <a className="skip-link" href="#main-content">
          {tFooter("skip_to_content")}
        </a>
      </header>
      <TaskCenterProvider
        autoDismissEnabled={on("flag.taskcenter.auto_dismiss")}
        pollingEnabled={on("flag.taskcenter.polling")}
        resumeCardsEnabled={on("flag.taskcenter.resume_cards")}
      >
        <UserTasksProvider>
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
              {/* Read-only notice — only renders when served from a
              non-local host without the admin-token cookie, i.e. when
              proxy.ts will 401 every write. */}
              <NonLocalReadOnlyBanner />
              {/* Focus preview banner — only renders when a preview is staged. */}
              <FocusPreviewBanner />
              {/* Update banner — polls /api/update-status; self-gated on
              cache state + user-dismissed flag. */}
              <UpdateBanner />
              {/* Cross-page flag-highlight handler — reads
              `?flag-highlight=<key>` and rings the gated element. */}
              <FlagHighlightHandler />
              <main className="app-main" id="main-content" tabIndex={-1}>
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
                {on("flag.global.accessibility_toggles") && (
                  <AccessibilityQuickToggles />
                )}
                {on("flag.global.keyboard_shortcuts") && <KeyboardHint />}
                {/* Bottom-LEFT pill — Privacy policy / Legal links. */}
                {on("flag.global.site_info_hint") && <SiteInfoHint />}
              </footer>
            </ImportQueueProvider>
          </QueuedSearchProvider>
        </UserTasksProvider>
      </TaskCenterProvider>
      {/* Global overlay portals — dialogs that render outside the main
        landmark when open. The region wrapper keeps axe happy even
        when both overlays are flag-off. */}
      <section aria-label={tRegions("global_overlays")}>
        {on("flag.global.keyboard_shortcuts") && <KeyboardShortcuts />}
        {on("flag.global.about_modal") && <AboutModal />}
      </section>
    </>
  );
}

"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useModalFocus } from "../../lib/use-modal-focus";
// Pull the version from package.json at build time so the About
// modal always reflects the actual shipped version. Webpack inlines
// the value at compile time — no runtime fetch.
import packageJson from "../../package.json";
import BrandWordmark from "./BrandWordmark";

const APP_VERSION = (packageJson as { version: string }).version;

// Shared custom-event name so any UI affordance (footer button, nav link,
// help menu) can ask the modal to open without threading refs through the
// component tree. Mirrors the `kbd-help:open` pattern used by the keyboard
// shortcut overlay.
const EVENT_OPEN = "about-modal:open";

export function openAboutModal() {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(EVENT_OPEN));
}

/**
 * macOS-style "About" dialog. A compact centered card with the app name,
 * version, and three links: GitHub source, creator, AI disclosure.
 *
 * The modal mounts globally (see `layout.tsx`) and listens for the
 * `about-modal:open` custom event, so the footer button can trigger it
 * without prop drilling.
 */
export default function AboutModal() {
  // i18n — pulls every visible string under the `about` namespace so
  // the modal's chrome (title, subtitle, version, link labels,
  // copyright) translates with the active locale.
  const t = useTranslations("about");
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // Listen for the global open request.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(EVENT_OPEN, onOpen);
    return () => window.removeEventListener(EVENT_OPEN, onOpen);
  }, []);

  // Focus management + Escape-to-close: remember the previously focused
  // element, move focus into the card on open, trap Tab inside, and restore
  // focus on close. Shared with every other modal via this hook.
  const cardRef = useModalFocus<HTMLDivElement>({ open, onClose: close });

  if (!open) {
    return null;
  }

  return (
    <div
      aria-labelledby="about-title"
      aria-modal="true"
      className="about-scrim"
      onClick={close}
      role="dialog"
    >
      <div
        className="about-card"
        onClick={(e) => e.stopPropagation()}
        ref={cardRef}
        tabIndex={-1}
      >
        <button
          aria-label={t("close_aria")}
          className="about-close"
          onClick={close}
          type="button"
        >
          ✕
        </button>

        {/* Served from /public; regenerate via `python3 tools/build_icons.py`. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          className="about-icon"
          height={64}
          src="/brand-icon.png"
          width={64}
        />

        {/* Typographic wordmark instead of plain text — picks up the
            same blue→indigo gradient the brand icon uses, so the
            About modal reads as the app's "splash" rather than a
            generic dialog. The dialog's accessible name is still
            anchored on the visually-hidden #about-title (h2) below
            so screen readers announce the brand name as text rather
            than describing the SVG. */}
        <BrandWordmark className="about-wordmark" height={36} />

        <h2 className="about-title sr-only" id="about-title">
          {t("title")}
        </h2>
        <p className="about-subtitle">{t("subtitle")}</p>
        <p className="about-version">
          {t("version", { version: APP_VERSION })}
        </p>

        <div className="about-links">
          <a
            className="about-link"
            href="https://github.com/privacykey/privacytracker"
            rel="noopener noreferrer"
            target="_blank"
          >
            <GitHubIcon />
            <span className="about-link-label">
              <span className="about-link-title">{t("github_title")}</span>
              <span className="about-link-sub">{t("github_sub")}</span>
            </span>
            <ExternalIcon />
          </a>

          <a
            className="about-link"
            href="https://adam.kostarelas.com"
            rel="noopener noreferrer"
            target="_blank"
          >
            <UserIcon />
            <span className="about-link-label">
              <span className="about-link-title">{t("creator_title")}</span>
              <span className="about-link-sub">{t("creator_sub")}</span>
            </span>
            <ExternalIcon />
          </a>

          <Link
            className="about-link"
            href="/dashboard/about/ai-disclosure"
            onClick={close}
          >
            <SparkleIcon />
            <span className="about-link-label">
              <span className="about-link-title">{t("ai_title")}</span>
              <span className="about-link-sub">{t("ai_sub")}</span>
            </span>
            <ChevronIcon />
          </Link>
        </div>

        <p className="about-copyright">
          {t("copyright", { year: new Date().getFullYear() })}
        </p>
      </div>
    </div>
  );
}

// ── Inline SVG icons ───────────────────────────────────────────────────
// Keeping these co-located avoids adding a dependency on an icon library
// for three glyphs. Each is a 16×16 stroke icon that inherits currentColor.

function GitHubIcon() {
  return (
    <svg
      aria-hidden="true"
      className="about-link-icon"
      fill="currentColor"
      height="18"
      viewBox="0 0 16 16"
      width="18"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg
      aria-hidden="true"
      className="about-link-icon"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="18"
    >
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M2.75 14c.5-2.75 2.75-4.25 5.25-4.25s4.75 1.5 5.25 4.25" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg
      aria-hidden="true"
      className="about-link-icon"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="18"
    >
      <path d="M8 1.5l1.4 3.6L13 6.5l-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4L8 1.5z" />
      <path d="M12.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      aria-hidden="true"
      className="about-link-chevron"
      fill="none"
      height="12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 16 16"
      width="12"
    >
      <path d="M6 3.5h6.5V10" />
      <path d="M12.5 3.5 6 10" />
      <path d="M12.5 9v3.5H3.5V3.5H7" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      className="about-link-chevron"
      fill="none"
      height="12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 16 16"
      width="12"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

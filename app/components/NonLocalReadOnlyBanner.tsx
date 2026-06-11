"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ADMIN_TOKEN_CHANGED_EVENT } from "./AdminTokenBridge";

/**
 * Proactive "you're browsing read-only" banner for non-local origins.
 *
 * proxy.ts rejects every mutating /api/* call (and high-sensitivity
 * reads) with 401 when the request host isn't loopback and no admin
 * token accompanies it. Each surface used to discover that lazily — a
 * search that "found nothing", a task click that silently did nothing.
 * This banner makes the state explicit up-front: when the page is
 * served from a non-local hostname and the admin-token cookie isn't
 * present, it explains why writes will fail and deep-links the login
 * card. It re-checks on ADMIN_TOKEN_CHANGED_EVENT so a successful
 * login clears it without a reload.
 *
 * Renders nothing on loopback hosts (the localhost / Tauri-sidecar
 * common case) — the status fetch is skipped entirely there. Dismissal
 * is per-tab-session (sessionStorage), so it returns on the next visit
 * but doesn't nag within one.
 */

const DISMISS_KEY = "pt-nonlocal-banner-dismissed";

// Mirrors isLocalRequestHost in proxy.ts — keep the host sets in sync
// or the banner will show (or hide) where the gate disagrees.
function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "[::1]" ||
    h === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

export default function NonLocalReadOnlyBanner() {
  const t = useTranslations("nonlocal_banner");
  const [show, setShow] = useState(false);

  const check = useCallback(async () => {
    if (isLocalHostname(window.location.hostname)) {
      setShow(false);
      return;
    }
    // try/catch for Safari private-mode windows where storage throws —
    // same pattern as UpdateBanner and the a11y bootstrap script.
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY) === "1") {
        setShow(false);
        return;
      }
    } catch {
      // Storage unavailable — treat as not dismissed.
    }
    try {
      // Gate-exempt read (under /api/auth/admin-token/), so it works
      // from the very state the banner is warning about.
      const res = await fetch("/api/auth/admin-token/status", {
        cache: "no-store",
      });
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as { unlocked?: boolean };
      setShow(!json.unlocked);
    } catch {
      // Network failure — stay quiet rather than flash a maybe-wrong banner.
    }
  }, []);

  useEffect(() => {
    void check();
    const onChange = () => void check();
    window.addEventListener(ADMIN_TOKEN_CHANGED_EVENT, onChange);
    return () =>
      window.removeEventListener(ADMIN_TOKEN_CHANGED_EVENT, onChange);
  }, [check]);

  if (!show) {
    return null;
  }

  return (
    <section aria-label={t("aria")} className="nonlocal-banner" role="status">
      <div className="nonlocal-banner__inner">
        <div className="nonlocal-banner__copy">
          <span className="nonlocal-banner__label">{t("label")}</span>{" "}
          <span className="nonlocal-banner__body">{t("body")}</span>{" "}
          <Link
            className="nonlocal-banner__link"
            href="/dashboard/settings#deployment-diagnostics"
          >
            {t("link")}
          </Link>
        </div>
        <div className="nonlocal-banner__actions">
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              try {
                window.sessionStorage.setItem(DISMISS_KEY, "1");
              } catch {
                // Storage unavailable — dismissal just won't persist.
              }
              setShow(false);
            }}
            type="button"
          >
            {t("dismiss")}
          </button>
        </div>
      </div>
    </section>
  );
}

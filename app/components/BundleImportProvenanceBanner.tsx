"use client";

/**
 * Dashboard provenance banner — shown once after an audit-bundle import.
 * Server resolves the most recent `audit_bundle_imports` row within the
 * last 24h; the banner self-dismisses on any click anywhere (or on tab
 * close) by writing a `dismissed:{importedAt}` marker to sessionStorage.
 * After 24h the server stops sending the prop and the banner stops mounting.
 */

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface Props {
  annotationsAdded: number;
  /** Counters from the import — used to flesh out the banner copy. */
  appsAdded: number;
  appsUpdated: number;
  /** Epoch ms of the most recent accepted bundle. */
  importedAt: number;
  /** Display name of the recommender; falls back to "your friend". */
  recommenderName: string;
}

export default function BundleImportProvenanceBanner({
  importedAt,
  recommenderName,
  appsAdded,
  appsUpdated,
  annotationsAdded,
}: Props) {
  const tBanner = useTranslations("bundle_import_banner");
  // Per-tab dismissal marker keyed on importedAt so a new import re-arms
  // the banner.
  const dismissalKey = `bundle-import-banner-dismissed:${importedAt}`;

  // Banner starts visible during SSR; the client hides it on mount if
  // the marker is already set.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(dismissalKey) === "1") {
        setDismissed(true);
      }
    } catch {
      // Private mode / disabled storage — leave the banner visible.
    }
  }, [dismissalKey]);

  // Soft dismissal on any click outside the banner. The banner stops
  // propagation on its own buttons so dismiss/X can be clicked without
  // also firing the global handler.
  useEffect(() => {
    if (dismissed) {
      return;
    }
    const handle = () => {
      try {
        sessionStorage.setItem(dismissalKey, "1");
      } catch {
        /* swallow */
      }
      setDismissed(true);
    };
    // Delay so the click that opened the dashboard doesn't immediately
    // dismiss the banner.
    const t = setTimeout(() => {
      document.addEventListener("click", handle);
    }, 600);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", handle);
    };
  }, [dismissed, dismissalKey]);

  if (dismissed) {
    return null;
  }

  // Server already coerces missing recommender names to a localised
  // "your friend"; trust it.
  const safeName = recommenderName.trim() || tBanner("fallback_name");
  const headlineKey = safeName.endsWith("s")
    ? "headline_possessive_s"
    : "headline_possessive_default";

  return (
    <div
      aria-live="polite"
      className="bundle-import-banner"
      onClick={(e) => e.stopPropagation()}
      role="status"
    >
      <span aria-hidden="true" className="bundle-import-banner__icon">
        📥
      </span>
      <div className="bundle-import-banner__copy">
        <strong>{tBanner(headlineKey, { name: safeName })}</strong>
        <span>
          {annotationsAdded > 0
            ? tBanner("notes_attached", { count: annotationsAdded })
            : tBanner("no_notes")}
          {(appsAdded > 0 || appsUpdated > 0) && (
            <>
              {" "}
              <span className="bundle-import-banner__stats">
                ({appsAdded > 0 && tBanner("stats_added", { count: appsAdded })}
                {appsAdded > 0 && appsUpdated > 0 && tBanner("stats_separator")}
                {appsUpdated > 0 &&
                  tBanner("stats_updated", { count: appsUpdated })}
                )
              </span>
            </>
          )}
        </span>
      </div>
      <button
        aria-label={tBanner("dismiss_aria")}
        className="bundle-import-banner__dismiss"
        onClick={(e) => {
          e.stopPropagation();
          try {
            sessionStorage.setItem(dismissalKey, "1");
          } catch {
            /* swallow */
          }
          setDismissed(true);
        }}
        type="button"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

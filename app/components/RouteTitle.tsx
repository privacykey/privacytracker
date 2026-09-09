"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * Localised document titles for a static bundle (Rust-core Phase 0).
 *
 * Every page still declares generateMetadata, but under static
 * prerender that runs at BUILD time with the default locale, so the
 * <title> baked into the HTML is English. This sets the translated
 * title once the client locale is known. Pages whose title carries a
 * name (/apps/<id>, /manual-apps/<id>) set their own from their loader
 * after the fetch, which runs after this effect and wins.
 *
 * GENERATED from each page's generateMetadata by the layout batch — if
 * a page's title key changes, update it here too (the ledger test
 * cross-checks the two).
 */
export const ROUTE_TITLE_KEYS: Record<string, string> = {
  "/about": "about_page.metadata_title",
  "/apps/view": "page_metadata.app_detail_fallback",
  "/changelog": "page_metadata.changelog_title",
  "/dashboard/about/ai-disclosure": "ai_disclosure_page.metadata_title",
  "/dashboard/apps": "page_metadata.apps_title",
  "/dashboard/compare": "page_metadata.compare_title",
  "/dashboard/diagnostics": "page_metadata.diagnostics_title",
  "/dashboard/manual-apps": "page_metadata.manual_apps_title",
  "/dashboard": "page_metadata.home_title",
  "/dashboard/privacy": "page_metadata.privacy_map_title",
  "/dashboard/review-recommendations": "page_metadata.review_title",
  "/dashboard/settings/devices": "devices.page_title",
  "/dashboard/settings/focus": "page_metadata.focus_edit_title",
  "/dashboard/settings/import-history": "page_metadata.import_history_title",
  "/dashboard/settings/layout": "page_metadata.layout_edit_title",
  "/dashboard/settings": "page_metadata.settings_title",
  "/dashboard/shortlist": "page_metadata.shortlist_title",
  "/dashboard/stats": "page_metadata.stats_title",
  "/help/definitions": "page_metadata.definitions_title",
  "/help/export-app-list": "help_export.metadata_title",
  "/help/parental-controls": "help_parental.metadata_title",
  "/manual-apps/view": "page_metadata.manual_app_detail_fallback_alt",
  "/onboard": "page_metadata.onboard_title",
  "/onboard/profile": "page_metadata.onboard_profile_title",
  "/welcome": "page_metadata.welcome_title",
};

export default function RouteTitle() {
  const pathname = usePathname();
  const t = useTranslations();
  useEffect(() => {
    // Same URL → shell mapping as next.config.js rewrites / proxy.ts:
    // the per-id detail URLs are served by the static `view` shells,
    // whose fallback title applies until the loader knows the name.
    const shell = pathname.replace(/^\/(apps|manual-apps)\/[^/]+$/, "/$1/view");
    const key = ROUTE_TITLE_KEYS[shell];
    if (key) {
      document.title = t(key);
    }
  }, [pathname, t]);
  return null;
}

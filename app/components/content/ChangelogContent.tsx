"use client";

import { useTranslations } from "next-intl";
import Nav from "@/app/components/Nav";
import UniversalChangelogView from "@/app/components/UniversalChangelogView";
/**
 * /changelog — universal changelog page.
 *
 * Aggregates every change (privacy-label adds/removes/modifications,
 * accessibility shelf events, privacy-policy events, archive imports)
 * across every tracked app into a single newest-first feed. The
 * AppChangeTimeline chart at the top runs in global mode (no appId
 * passed) so it renders the same stacked-bar visualisation as the
 * stats page hero, but for the whole library.
 *
 * Rust-core Phase 0: this page used to query the apps table directly
 * for the filter dropdown. That list now loads client-side from
 * `GET /api/apps` inside UniversalChangelogView, which already owned
 * the filter state and its paginated feed fetches — so the page is a
 * shell.
 */

export default function ChangelogContent() {
  const t = useTranslations("changelog_page");

  return (
    <>
      <Nav />
      <div className="page-container">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("title")}</h1>
            <p className="page-subtitle">{t("subtitle")}</p>
          </div>
        </div>

        <UniversalChangelogView />
      </div>
    </>
  );
}

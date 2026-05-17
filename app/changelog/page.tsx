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
 * Server boundary: read the tracked-app list once for the filter
 * dropdown, then hand off to the client component which owns the
 * filter state + paginated fetches.
 */

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import db from "../../lib/db";
import Nav from "../components/Nav";
import UniversalChangelogView from "../components/UniversalChangelogView";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("changelog_title"),
    description: t("changelog_description"),
  };
}

interface AppForFilter {
  id: string;
  name: string;
}

export default async function ChangelogPage() {
  const t = await getTranslations("changelog_page");

  // Apps list for the filter dropdown. Pulled server-side so the
  // initial render doesn't have to wait for a fetch — and so search-
  // engine indexers (which won't run client JS) still see a sane
  // empty page rather than a blank shell.
  let apps: AppForFilter[] = [];
  try {
    apps = db
      .prepare("SELECT id, name FROM apps ORDER BY name COLLATE NOCASE")
      .all() as AppForFilter[];
  } catch (e) {
    console.warn("[/changelog] apps list query failed:", e);
  }

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

        <UniversalChangelogView apps={apps} />
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import {
  MANUAL_APP_SOURCE_META,
  MANUAL_APP_SOURCES,
} from "../../../lib/manual-apps";
import { listManualApps } from "../../../lib/manual-apps-server";
import ManualAppsView from "../../components/ManualAppsView";
import Nav from "../../components/Nav";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("manual_apps_title"),
    description: t("manual_apps_description"),
  };
}

/**
 * Entry point for the manual-apps editor. The actual list + forms live in a
 * client component so we can use stateful editing, but we hydrate the initial
 * list server-side so the page renders without a loading spinner. Source-type
 * metadata is client-safe (no DB imports) so we hand the full list across as
 * the source of truth for icons and labels — the client never hard-codes
 * these, which keeps adding a fifth source type a one-file change.
 */
export default function ManualAppsPage() {
  if (resolveFlagFromDb("flag.page.manual_apps") !== "on") {
    notFound();
  }

  let initialApps: ReturnType<typeof listManualApps> = [];
  try {
    initialApps = listManualApps();
  } catch (error) {
    // DB not ready (first boot, permissions mid-migration, etc.). Render an
    // empty state rather than 500 — the user can still add their first app.
    console.warn("[manual-apps-page] listManualApps failed:", error);
  }

  const sources = MANUAL_APP_SOURCES.map((value) => ({
    ...MANUAL_APP_SOURCE_META[value],
  }));

  return (
    <>
      <Nav />
      <ManualAppsView initialApps={initialApps} sources={sources} />
    </>
  );
}

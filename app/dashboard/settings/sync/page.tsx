import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAllApps } from "../../../../lib/scraper";
import Nav from "../../../components/Nav";
import SettingsView from "../../../components/SettingsView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Data sync \u00b7 Settings",
  description:
    "When syncs run, which App Store region to read, and what the last run did.",
};

/**
 * Settings \u2192 Data sync.
 *
 * One of the four group routes derived from the section taxonomy in
 * app/components/settings/section-groups.ts. Renders SettingsView in
 * `viewMode="sync"` so the state machine stays in one place \u2014 the
 * same arrangement the import-history route has used since before the split.
 */
export default function SettingsSyncPage() {
  let apps: any[] = [];
  try {
    apps = getAllApps() as any[];
  } catch (error) {
    // DB not ready \u2014 same behaviour as the Settings landing page.
    console.warn("[settings-sync-page] getAllApps failed:", error);
  }

  if (apps.length === 0) {
    redirect("/onboard");
  }

  return (
    <>
      <Nav />
      <SettingsView viewMode="sync" />
    </>
  );
}

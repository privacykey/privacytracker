import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAllApps } from "../../../../lib/scraper";
import Nav from "../../../components/Nav";
import SettingsView from "../../../components/SettingsView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Privacy policies & AI \u00b7 Settings",
  description: "Policy scraping, throttling, and the optional AI summariser.",
};

/**
 * Settings \u2192 Privacy policies & AI.
 *
 * One of the four group routes derived from the section taxonomy in
 * app/components/settings/section-groups.ts. Renders SettingsView in
 * `viewMode="policies"` so the state machine stays in one place \u2014 the
 * same arrangement the import-history route has used since before the split.
 */
export default function SettingsPoliciesPage() {
  let apps: any[] = [];
  try {
    apps = getAllApps() as any[];
  } catch (error) {
    // DB not ready \u2014 same behaviour as the Settings landing page.
    console.warn("[settings-policies-page] getAllApps failed:", error);
  }

  if (apps.length === 0) {
    redirect("/onboard");
  }

  return (
    <>
      <Nav />
      <SettingsView viewMode="policies" />
    </>
  );
}

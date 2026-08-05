import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAllApps } from "../../../../lib/scraper";
import Nav from "../../../components/Nav";
import SettingsView from "../../../components/SettingsView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin \u00b7 Settings",
  description:
    "Imports, diagnostics, backups, history import, export and reset.",
};

/**
 * Settings \u2192 Admin.
 *
 * One of the four group routes derived from the section taxonomy in
 * app/components/settings/section-groups.ts. Renders SettingsView in
 * `viewMode="admin"` so the state machine stays in one place \u2014 the
 * same arrangement the import-history route has used since before the split.
 */
export default function SettingsAdminPage() {
  let apps: any[] = [];
  try {
    apps = getAllApps() as any[];
  } catch (error) {
    // DB not ready \u2014 same behaviour as the Settings landing page.
    console.warn("[settings-admin-page] getAllApps failed:", error);
  }

  if (apps.length === 0) {
    redirect("/onboard");
  }

  return (
    <>
      <Nav />
      <SettingsView viewMode="admin" />
    </>
  );
}

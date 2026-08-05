import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAllApps } from "../../../lib/scraper";
import Nav from "../../components/Nav";
import SettingsLandingRedirect from "../../components/settings/SettingsLandingRedirect";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("settings_title"),
    description: t("settings_description"),
  };
}

/**
 * Settings landing.
 *
 * Settings is split across four group routes (you / sync / policies /
 * admin), so this page's job is to forward to the right one. It cannot do
 * that on the server: the thing that decides where to go is the URL
 * fragment, and fragments are never sent to the server. So the forwarding
 * lives in a client component, and this page keeps only the check that
 * does belong on the server — the empty-install bounce to onboarding.
 *
 * Nav still points here, and every previously-published anchor still
 * resolves, which is the point of doing it this way.
 */
export default function SettingsPage() {
  let apps: any[] = [];
  try {
    apps = getAllApps() as any[];
  } catch (error) {
    // DB not ready
    console.warn("[settings-page] getAllApps failed:", error);
  }

  if (apps.length === 0) {
    redirect("/onboard");
  }

  return (
    <>
      <Nav />
      <SettingsLandingRedirect />
    </>
  );
}

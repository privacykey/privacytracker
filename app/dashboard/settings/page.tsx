import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Nav from "../../components/Nav";
import RequireAppsGate from "../../components/RequireAppsGate";
import SettingsLandingRedirect from "../../components/settings/SettingsLandingRedirect";

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
 * lives in a client component, and the empty-install bounce to onboarding
 * is client-side too (RequireAppsGate — Rust-core Phase 0).
 *
 * Nav still points here, and every previously-published anchor still
 * resolves, which is the point of doing it this way.
 */
export default function SettingsPage() {
  return (
    <>
      <Nav />
      <RequireAppsGate>
        <SettingsLandingRedirect />
      </RequireAppsGate>
    </>
  );
}

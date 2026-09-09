import type { Metadata } from "next";
import Nav from "../../../components/Nav";
import RequireAppsGate from "../../../components/RequireAppsGate";
import SettingsView from "../../../components/SettingsView";

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
  return (
    <>
      <Nav />
      <RequireAppsGate>
        <SettingsView viewMode="policies" />
      </RequireAppsGate>
    </>
  );
}

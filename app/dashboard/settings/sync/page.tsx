import type { Metadata } from "next";
import Nav from "../../../components/Nav";
import RequireAppsGate from "../../../components/RequireAppsGate";
import SettingsView from "../../../components/SettingsView";

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
  return (
    <>
      <Nav />
      <RequireAppsGate>
        <SettingsView viewMode="sync" />
      </RequireAppsGate>
    </>
  );
}

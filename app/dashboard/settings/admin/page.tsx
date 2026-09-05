import type { Metadata } from "next";
import Nav from "../../../components/Nav";
import RequireAppsGate from "../../../components/RequireAppsGate";
import SettingsView from "../../../components/SettingsView";

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
  return (
    <>
      <Nav />
      <RequireAppsGate>
        <SettingsView viewMode="admin" />
      </RequireAppsGate>
    </>
  );
}

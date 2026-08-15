import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Nav from "../../../components/Nav";
import RequireAppsGate from "../../../components/RequireAppsGate";
import SettingsView from "../../../components/SettingsView";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("import_history_title"),
    description: t("import_history_description"),
  };
}

/**
 * Dedicated nested page for the Import History feature. Reuses SettingsView
 * in `viewMode="import-history"` so the state machine (imports list,
 * expanded row, change-match search, delete confirmations, background queue
 * banner) stays in exactly one place.
 *
 * The main /dashboard/settings page renders a link card in the Import
 * History slot that points here; notifications routed to "Import finished",
 * "Unmatched apps to review", and "Import needs attention" all land here.
 */
export default function ImportHistoryPage() {
  return (
    <>
      <Nav />
      <RequireAppsGate>
        <SettingsView viewMode="import-history" />
      </RequireAppsGate>
    </>
  );
}

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import DevicesView from "../../../components/DevicesView";
import Nav from "../../../components/Nav";
import RequireFlagGate from "../../../components/RequireFlagGate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("devices");
  return { title: t("page_title") };
}

/**
 * Devices settings.
 *
 * Rust-core Phase 0: this page used to resolve `flag.settings.devices_page`
 * and read the device list (plus per-device app counts) from the DB in a
 * server component. Both now come from the API — the flag through
 * RequireFlagGate, and the list through DevicesView's own `refresh()`,
 * which already fetched `/api/devices` for post-mutation reloads and
 * returns the identical shape (the route includes `appCount`).
 */
export default function DevicesSettingsPage() {
  return (
    <>
      <Nav />
      <RequireFlagGate flag="flag.settings.devices_page">
        <div className="page-container">
          <DevicesView />
        </div>
      </RequireFlagGate>
    </>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import { getAllDevices, getDeviceAppCounts } from "../../../../lib/devices";
import DevicesView, {
  type DeviceListEntry,
} from "../../../components/DevicesView";
import Nav from "../../../components/Nav";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("devices");
  return { title: t("page_title") };
}

export default function DevicesSettingsPage() {
  if (resolveFlagFromDb("flag.settings.devices_page") !== "on") {
    notFound();
  }

  let initialDevices: DeviceListEntry[] = [];
  try {
    const devices = getAllDevices();
    const counts = getDeviceAppCounts();
    initialDevices = devices.map((d) => ({
      ...d,
      appCount: counts.get(d.id) ?? 0,
    }));
  } catch (error) {
    console.warn("[devices-page] failed to load devices:", error);
  }

  return (
    <>
      <Nav />
      <div className="page-container">
        <DevicesView initialDevices={initialDevices} />
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import DashboardLayoutSettingsContent from "@/app/components/content/DashboardLayoutSettingsContent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("layout_edit_title"),
    description: t("layout_edit_description"),
  };
}

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component DashboardLayoutSettingsContent so this route prerenders statically and the
 * copy follows the client-resolved locale; generateMetadata's title is
 * build-time English that RouteTitle localises on the client.
 */
export default function DashboardLayoutSettingsPage() {
  return <DashboardLayoutSettingsContent />;
}

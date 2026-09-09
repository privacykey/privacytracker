import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import ExportAppListHelpContent from "@/app/components/content/ExportAppListHelpContent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("help_export");
  return {
    title: t("metadata_title"),
    description: t("metadata_description"),
  };
}

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component ExportAppListHelpContent so this route prerenders statically and the
 * copy follows the client-resolved locale; the metadata title is
 * build-time English that RouteTitle localises on the client.
 */
export default function ExportAppListHelpPage() {
  return <ExportAppListHelpContent />;
}

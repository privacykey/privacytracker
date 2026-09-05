import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import ChangelogContent from "@/app/components/content/ChangelogContent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("changelog_title"),
    description: t("changelog_description"),
  };
}

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component ChangelogContent so this route prerenders statically and the
 * copy follows the client-resolved locale; the metadata title is
 * build-time English that RouteTitle localises on the client.
 */
export default function ChangelogPage() {
  return <ChangelogContent />;
}

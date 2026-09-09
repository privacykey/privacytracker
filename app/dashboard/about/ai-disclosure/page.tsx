import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import AiDisclosureContent from "@/app/components/content/AiDisclosureContent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ai_disclosure_page");
  return {
    title: t("metadata_title"),
    description: t("metadata_description"),
  };
}

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component AiDisclosureContent so this route prerenders statically and the
 * copy follows the client-resolved locale; generateMetadata's title is
 * build-time English that RouteTitle localises on the client.
 */
export default function AiDisclosurePage() {
  return <AiDisclosureContent />;
}

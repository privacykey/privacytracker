import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import AboutContent from "@/app/components/content/AboutContent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("about_page");
  return {
    title: t("metadata_title"),
  };
}

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component AboutContent so this route prerenders statically and the
 * copy follows the client-resolved locale; generateMetadata's title is
 * build-time English that RouteTitle localises on the client.
 */
export default function AboutPage() {
  return <AboutContent />;
}

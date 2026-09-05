import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import DefinitionsContent from "@/app/components/content/DefinitionsContent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("definitions_title"),
    description: t("definitions_description"),
  };
}

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component DefinitionsContent so this route prerenders statically and the
 * copy follows the client-resolved locale; the metadata title is
 * build-time English that RouteTitle localises on the client.
 */
export default function DefinitionsHelpPage() {
  return (
    <Suspense fallback={null}>
      <DefinitionsContent />
    </Suspense>
  );
}

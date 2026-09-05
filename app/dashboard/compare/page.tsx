import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import CompareContent from "@/app/components/content/CompareContent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("compare_title"),
    description: t("compare_description"),
  };
}

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component CompareContent so this route prerenders statically and the
 * copy follows the client-resolved locale; generateMetadata's title is
 * build-time English that RouteTitle localises on the client.
 */
export default function ComparePage() {
  return (
    <Suspense fallback={null}>
      <CompareContent />
    </Suspense>
  );
}

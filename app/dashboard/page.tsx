import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import HomeLoader from "../components/HomeLoader";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("home_title"),
  };
}

/**
 * Home dashboard.
 *
 * Rust-core Phase 0: the last page of the conversion. Its 27 server
 * reads, two writes (welcomed_at, migration-marker consume) and the
 * two-way empty-install redirect all moved into HomeLoader, which
 * documents the ordering and failure-mode invariants it preserves.
 * The Suspense boundary is what Next requires around useSearchParams
 * (?sample=1 and ?edit=layout are read there).
 */
export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <HomeLoader />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import ReviewQueueLoader from "../../components/ReviewQueueLoader";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("review_title"),
  };
}

/**
 * /dashboard/review-recommendations — universal Review / Compare / Save
 * wizard, with an optional desktop-only Backup / Act extension.
 *
 * The extension requires audience=self, the cfgutil feature flag, and the
 * Tauri desktop runtime. It records a backup only after both native
 * discovery and server-side Manifest.db verification; Act then re-checks
 * that durable stamp immediately before the first removal.
 *
 * Web users and people outside the extension gates still get the complete
 * non-destructive recommendation flow without disabled desktop controls.
 *
 * Rust-core Phase 0: the row assembly — six DB reads plus a per-row
 * listAnnotations() — moved verbatim into GET /api/review-queue, and the
 * gate inputs come from /api/focus + /api/feature-flags. See
 * ReviewQueueLoader, which also owns the `generatedAtLabel` main added
 * for the printable checklist.
 */
export default function ReviewRecommendationsPage() {
  return <ReviewQueueLoader />;
}

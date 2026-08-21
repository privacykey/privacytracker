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
 * /dashboard/review-recommendations — three-step wizard:
 *   1. Review — set/refine per-app verdict; imported recommendations from
 *      audit bundles render as advisory pills.
 *   2. Backup — connect device, run cfgutil backup. Uninstall stays
 *      disabled until a backup landed within the freshness window.
 *   3. Act — for apps marked "uninstall", walk through them with
 *      type-DELETE confirmation.
 *
 * Gates (the view renders the same apps either way and only hides the
 * destructive steps): audience must be 'self', and
 * `flag.devopts.cfgutil_uninstall` must be on. Tauri-only checks live in
 * the wizard itself so web-build users can still review verdicts.
 *
 * Rust-core Phase 0: the row assembly — six DB reads plus a per-row
 * listAnnotations() — moved verbatim into GET /api/review-queue, and the
 * gate inputs come from /api/focus + /api/feature-flags. See
 * ReviewQueueLoader.
 */
export default function ReviewRecommendationsPage() {
  return <ReviewQueueLoader />;
}

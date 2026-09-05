"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * "N apps need a decision" CTA banner — the dashboard's `review_cta`
 * layout card. Was an async server component local to the dashboard
 * page (server getTranslations for the ICU plural); the plural resolves
 * identically through next-intl's client hook, so it moved here when the
 * page became a shell (Rust-core Phase 0).
 *
 * Callers pass it as `reviewCtaSlot` ONLY when count > 0 and keep the
 * slot null otherwise — HomeView treats a non-null slot as "this card
 * has data", and in edit mode a null slot is what makes the card render
 * as a reorderable ghost row.
 */
export default function ReviewCtaBanner({ count }: { count: number }) {
  const t = useTranslations("dashboard.review_cta");
  return (
    <div className="review-cta-wrap">
      <Link
        aria-label={t("aria", { count })}
        className="review-cta"
        href="/dashboard/review-recommendations"
      >
        <span aria-hidden="true" className="review-cta-icon">
          📝
        </span>
        <span className="review-cta-body">
          <strong>{t("heading", { count })}</strong>
          <span className="review-cta-sub">{t("body")}</span>
        </span>
        <span aria-hidden="true" className="review-cta-arrow">
          →
        </span>
      </Link>
    </div>
  );
}

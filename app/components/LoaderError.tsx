"use client";

import { useTranslations } from "next-intl";

/**
 * "This page couldn't load its data" with a Try again button, for page
 * loaders whose required read failed.
 *
 * A failed read is not an empty install. The loaders that bounce an
 * empty install to onboarding used to map any non-OK response to "no
 * apps", which sent a user with a full library to "Add the apps from
 * your iPhone" whenever the server hiccuped. They render this instead,
 * and `onRetry` re-runs the same reads without reloading the page.
 */
export default function LoaderError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("loader_error");
  return (
    <div className="page-container">
      <div className="empty-state" data-testid="loader-error" role="alert">
        <div className="empty-state-title">{t("title")}</div>
        <p className="empty-state-text">
          <button className="btn btn-secondary" onClick={onRetry} type="button">
            {t("retry")}
          </button>
        </p>
      </div>
    </div>
  );
}

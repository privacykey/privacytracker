"use client";

import { useTranslations } from "next-intl";

/** Keep editable onboarding screens unmounted until their saved state is known. */
export default function LoaderRetry({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("common");
  return (
    <div className="wizard-outer">
      <div className="wizard-card" role="alert">
        <h1 className="wizard-title">{t("load_failed")}</h1>
        <p className="wizard-subtitle">{t("load_failed_hint")}</p>
        <button className="pill-button-primary" onClick={onRetry} type="button">
          {t("retry")}
        </button>
      </div>
    </div>
  );
}

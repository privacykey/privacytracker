"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  ERROR_REPORT_FALLBACK_HREF,
  errorReportHref,
} from "@/lib/error-report-link";
import "./error-content.css";

/**
 * Body of app/error.tsx: what a reader sees when a page throws while it
 * renders, instead of Next's bare "Application error: a client-side
 * exception has occurred".
 *
 * It renders inside the root layout's chrome (AppChrome), so the locale
 * provider and global styles are there. Pages render their own <Nav />,
 * which went down with the page, so the card carries its own way home.
 */
export default function ErrorContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("error_page");
  // The report link names the path the error happened on, read after
  // mount; before that it opens the plain template.
  const [reportHref, setReportHref] = useState(ERROR_REPORT_FALLBACK_HREF);
  useEffect(() => {
    setReportHref(errorReportHref(window.location.pathname));
  }, []);

  return (
    <div className="app-error-root">
      <section
        aria-labelledby="app-error-title"
        className="app-error-card"
        role="alert"
      >
        <p className="app-error-eyebrow">
          <span aria-hidden="true" className="app-error-glyph">
            !
          </span>
          {t("eyebrow")}
        </p>
        <h1 className="app-error-title" id="app-error-title">
          {t("title")}
        </h1>
        <p className="app-error-body">{t("body")}</p>
        <div className="app-error-actions">
          <button
            className="btn btn-primary"
            data-testid="app-error-retry"
            onClick={onRetry}
            type="button"
          >
            {t("try_again")}
          </button>
          <Link className="btn btn-secondary" href="/">
            {t("home")}
          </Link>
        </div>
        <p className="app-error-report">
          <a href={reportHref} rel="noopener noreferrer" target="_blank">
            {t("report")}
          </a>
          <span className="app-error-report-note">{t("report_note")}</span>
        </p>
      </section>
    </div>
  );
}

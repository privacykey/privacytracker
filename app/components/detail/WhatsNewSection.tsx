"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

// ── What's New Section ────────────────────────────────────────────────
//
// Surfaces the App Store "What's New" release notes alongside the version
// pill so auditors can eyeball whether a new version explains any privacy
// label changes. Collapsed by default when the notes are long so it doesn't
// push the privacy labels below the fold.

export default function WhatsNewSection({
  whatsNew,
  version,
  releasedAt,
  formatDate,
}: {
  whatsNew: string;
  version?: string | null;
  releasedAt?: number | null;
  formatDate: (ts: number) => string;
}) {
  const tDetail = useTranslations("app_detail");
  const LONG_THRESHOLD = 280;
  const isLong = whatsNew.length > LONG_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);

  return (
    <section className="whats-new-section">
      <div className="whats-new-header">
        <div>
          <div className="whats-new-kicker">{tDetail("whats_new_kicker")}</div>
          <h2 className="whats-new-title">
            {version
              ? tDetail("whats_new.version", { version })
              : tDetail("whats_new.latest")}
            {releasedAt && (
              <span className="whats-new-date">
                {" "}
                · {formatDate(releasedAt)}
              </span>
            )}
          </h2>
        </div>
        {isLong && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setExpanded(!expanded)}
            type="button"
          >
            {expanded
              ? tDetail("whats_new.collapse")
              : tDetail("whats_new.expand")}
          </button>
        )}
      </div>
      <pre
        className={`whats-new-body ${expanded ? "" : "whats-new-body-clamped"}`}
      >
        {whatsNew}
      </pre>
    </section>
  );
}

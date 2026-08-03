"use client";

/**
 * Compact Import History card shown on the main Settings landing page.
 *
 * The full review-and-retry UI lives on its own route; keeping only a link
 * here lets the Settings landing stay scannable and gives the history room
 * for its expandable rows and inline change-match flow.
 *
 * Carries the same `import-history` anchor id as ImportHistorySection —
 * they are mutually exclusive `viewMode` branches, so only one is ever in
 * the document at a time.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useImportQueue } from "../ImportQueueProvider";

export default function ImportHistoryLinkCard() {
  const importQueue = useImportQueue();
  const tSections = useTranslations("settings.sections");
  const tImpHistoryCard = useTranslations("settings.import_history_card");

  return (
    <div className="settings-section" id="import-history">
      <h2 className="settings-section-title">{tSections("import_history")}</h2>
      <p className="settings-section-subtitle">{tImpHistoryCard("subtitle")}</p>
      <Link
        className="btn btn-secondary"
        href="/dashboard/settings/import-history"
      >
        {tImpHistoryCard("open_link")}
      </Link>
      {importQueue.state.queued > 0 && (
        <p
          style={{
            fontSize: 12,
            color: "var(--orange)",
            marginTop: 10,
          }}
        >
          {tImpHistoryCard("queue_note", {
            count: importQueue.state.queued,
          })}
        </p>
      )}
    </div>
  );
}

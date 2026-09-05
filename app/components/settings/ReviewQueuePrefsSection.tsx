"use client";

/**
 * Review-queue presentation preferences (the progress-bar toggle).
 *
 * Anchor id `review-queue-preferences` — see ./README.md on why ids are load-bearing.
 */

import { useTranslations } from "next-intl";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";

export default function ReviewQueuePrefsSection({
  queueShowProgressBar,
  queueShowProgressBarAutoSave,
  saveQueueShowProgressBar,
}: {
  queueShowProgressBar: boolean;
  queueShowProgressBarAutoSave: ReturnType<typeof useSettingsAutoSave<boolean>>;
  saveQueueShowProgressBar: (next: boolean) => void;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tReviewQueueSettings = useTranslations("settings.review_queue_card");

  return (
    <div className="settings-section" id="review-queue-preferences">
      <h2 className="settings-section-title">{tSections("review_queue")}</h2>
      <p className="settings-section-subtitle">{tSub("review_queue")}</p>
      <label className="settings-checkbox-row">
        <input
          checked={queueShowProgressBar}
          className="settings-checkbox"
          disabled={queueShowProgressBarAutoSave.saving}
          onChange={(event) =>
            void saveQueueShowProgressBar(event.target.checked)
          }
          type="checkbox"
        />
        <span>
          {tReviewQueueSettings("progress_bar_label")}
          <span
            className="settings-field-help"
            style={{ display: "block", marginTop: 4 }}
          >
            {tReviewQueueSettings("progress_bar_help")}
          </span>
        </span>
      </label>
    </div>
  );
}

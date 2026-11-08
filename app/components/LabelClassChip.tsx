"use client";

import { useTranslations } from "next-intl";
import { LABEL_CLASS_META, type LabelClass } from "../../lib/label-class";
import PrivacyTypeIcon from "./PrivacyTypeIcon";
import "./label-class-chip.css";

export type LabelClassChipSize = "md" | "sm";

interface LabelClassChipProps {
  className?: string;
  /**
   * Count form ("5 linked to you"). The numeral is its own span so it can
   * take tabular figures; the hover text becomes the long count sentence.
   */
  count?: number;
  labelClass: LabelClass;
  /** `md` is 20px tall with 12px text; `sm` is 18px for inline use. */
  size?: LabelClassChipSize;
  /** Hover text. Defaults to the full Apple name, or the count sentence. */
  title?: string;
}

/**
 * One chip for Apple's privacy-label classes, on every surface.
 *
 * Renders the class glyph (`PrivacyTypeIcon`, already aria-hidden) and the
 * short label from `label_class.*`, with the full Apple name in `title` so
 * the short form never loses its meaning. The colour comes from the
 * `severity-*` class alone (globals.css), so a class can only ever be one
 * colour: track red, linked orange, not linked cream, not collected
 * neutral. The chip also keeps `severity-badge`, which tests and the
 * detail accordion select on.
 */
export default function LabelClassChip({
  className,
  count,
  labelClass,
  size = "md",
  title,
}: LabelClassChipProps) {
  const t = useTranslations("label_class");
  const tSeverity = useTranslations("severity");
  const meta = LABEL_CLASS_META[labelClass];
  const hasCount = typeof count === "number";
  const hover =
    title ??
    (hasCount
      ? t(`title_count_${labelClass}`, { count })
      : tSeverity(meta.severityKey));
  const classes = [
    "severity-badge",
    "label-class-chip",
    `label-class-chip-${size}`,
    meta.severityCls,
    hasCount ? "label-class-chip-count" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} title={hover}>
      <PrivacyTypeIcon tier={labelClass} />
      {hasCount
        ? t.rich(`count_${labelClass}`, {
            count,
            num: (chunks) => (
              <span className="label-class-chip-num">{chunks}</span>
            ),
          })
        : t(labelClass)}
    </span>
  );
}

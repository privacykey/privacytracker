"use client";

/**
 * Compact read-only verdict pill for grid cards and app-detail headers.
 * For the editable picker, see VerdictPicker.tsx.
 */

import { useTranslations } from "next-intl";
import { VERDICT_META, type VerdictValue } from "../../lib/verdict-types";

interface Props {
  /** Render only the icon, no label text. */
  iconOnly?: boolean;
  /** 'sm' for grid cards, 'md' for the detail header. Default 'sm'. */
  size?: "sm" | "md";
  /** Optional "by <name>" suffix for imported rows. */
  sourceName?: string | null;
  /** Optional title override; defaults to the verdict description. */
  title?: string;
  verdict: VerdictValue;
}

export default function VerdictPill({
  verdict,
  size = "sm",
  iconOnly = false,
  sourceName,
  title,
}: Props) {
  // Labels read from i18n; icon stays sourced from VERDICT_META.
  const t = useTranslations("verdict");
  const meta = VERDICT_META[verdict];
  const fullLabel = t(`${verdict}_label`);
  const shortLabel = t(`${verdict}_short`);
  const description = t(`${verdict}_desc`);
  const tooltip =
    title ??
    (sourceName
      ? t("recommended_by_title", { description, sourceName })
      : description);
  return (
    <span
      aria-label={
        sourceName
          ? t("recommended_by_aria", { label: fullLabel, sourceName })
          : fullLabel
      }
      className={`verdict-pill verdict-pill-${meta.cls} verdict-pill-${size}`}
      title={tooltip}
    >
      <span aria-hidden="true" className="verdict-pill-icon">
        {meta.icon}
      </span>
      {!iconOnly && <span className="verdict-pill-label">{shortLabel}</span>}
      {sourceName && !iconOnly && (
        <span className="verdict-pill-source">· {sourceName}</span>
      )}
    </span>
  );
}

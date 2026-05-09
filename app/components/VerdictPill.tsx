'use client';

/**
 * Compact read-only verdict pill for grid cards and app-detail headers.
 * For the editable picker, see VerdictPicker.tsx.
 */

import { useTranslations } from 'next-intl';
import { VERDICT_META, type VerdictValue } from '../../lib/verdict-types';

interface Props {
  verdict: VerdictValue;
  /** 'sm' for grid cards, 'md' for the detail header. Default 'sm'. */
  size?: 'sm' | 'md';
  /** Render only the icon, no label text. */
  iconOnly?: boolean;
  /** Optional "by <name>" suffix for imported rows. */
  sourceName?: string | null;
  /** Optional title override; defaults to the verdict description. */
  title?: string;
}

export default function VerdictPill({
  verdict,
  size = 'sm',
  iconOnly = false,
  sourceName,
  title,
}: Props) {
  // Labels read from i18n; icon stays sourced from VERDICT_META.
  const t = useTranslations('verdict');
  const meta = VERDICT_META[verdict];
  const fullLabel = t(`${verdict}_label`);
  const shortLabel = t(`${verdict}_short`);
  const description = t(`${verdict}_desc`);
  const tooltip = title ?? (sourceName
    ? t('recommended_by_title', { description, sourceName })
    : description);
  return (
    <span
      className={`verdict-pill verdict-pill-${meta.cls} verdict-pill-${size}`}
      title={tooltip}
      aria-label={
        sourceName
          ? t('recommended_by_aria', { label: fullLabel, sourceName })
          : fullLabel
      }
    >
      <span className="verdict-pill-icon" aria-hidden="true">{meta.icon}</span>
      {!iconOnly && <span className="verdict-pill-label">{shortLabel}</span>}
      {sourceName && !iconOnly && (
        <span className="verdict-pill-source">· {sourceName}</span>
      )}
    </span>
  );
}

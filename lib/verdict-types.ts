/**
 * Client-safe verdict types. Mirrors the server-side `AppVerdict` from
 * `lib/verdicts.ts` but imports nothing — so client components can use
 * the types without dragging better-sqlite3 into the browser bundle.
 *
 * The runtime helpers in `lib/verdicts.ts` re-export the same
 * `VerdictValue` / `VerdictSource` aliases so server code can import
 * either module interchangeably.
 */

export type VerdictValue = 'safe' | 'replace' | 'uninstall';
export type VerdictSource = 'user' | 'imported';

export interface AppVerdict {
  id: string;
  appId: string;
  verdict: VerdictValue;
  rationale: string | null;
  source: VerdictSource;
  /** Recommender display name when source === 'imported'; null for 'user'. */
  sourceName: string | null;
  setAt: number;
  updatedAt: number;
}

/**
 * Visual + copy metadata for each verdict value. Kept here so the pill,
 * picker, filter chips, and detail-page header can all read the same
 * tokens without forking the strings.
 *
 * Colour intent — green/amber/red maps onto the existing severity
 * palette in globals.css so verdicts read as part of the same family
 * as the privacy-risk pills, just on a different axis ("what I've
 * decided" vs "what Apple says about the app").
 */
export interface VerdictMeta {
  value: VerdictValue;
  label: string;
  shortLabel: string;
  /** One-liner for tooltips and the picker's per-option helper text. */
  description: string;
  icon: string;
  /** CSS class suffix — `verdict-pill-${cls}` and `verdict-chip-${cls}`. */
  cls: 'safe' | 'replace' | 'uninstall';
}

export const VERDICT_META: Record<VerdictValue, VerdictMeta> = {
  safe: {
    value: 'safe',
    label: 'Marked safe',
    shortLabel: 'Safe',
    description:
      "Keeping this app — you're comfortable with what it does and how it handles your data.",
    icon: '✓',
    cls: 'safe',
  },
  replace: {
    value: 'replace',
    label: 'Looking for replacement',
    shortLabel: 'Replace',
    description:
      "You want a less invasive alternative. Use the Compare view to find candidates and add them to your shortlist.",
    icon: '↻',
    cls: 'replace',
  },
  uninstall: {
    value: 'uninstall',
    label: 'Marked to remove',
    shortLabel: 'Remove',
    description:
      "You've decided this app should be removed. When source = 'imported', this is a recommendation only — your own decision still gates whether you actually remove it.",
    icon: '🗑',
    cls: 'uninstall',
  },
};

/** Stable ordering for the picker / filter row. */
export const VERDICT_ORDER: VerdictValue[] = ['safe', 'replace', 'uninstall'];

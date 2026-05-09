/**
 * YourFocusCard — top-of-Settings card showing the user's current focus
 * (audience + goals + accessibility modifier) as chips, with an Adjust
 * button. Server component (synchronous DB read).
 *
 * Renders one of two states: an "audience unset" setup CTA linking to
 * /onboard/welcome, or a chip strip + Adjust + (?) help link. For
 * `loved_one` it also surfaces an annotation count when notes exist.
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getActiveFocus, getFocusUpdatedAt } from '@/lib/feature-flag-storage';
import { resolveFlagFromDb } from '@/lib/feature-flags-server';
import { getDateFormatPreference } from '@/lib/date-format-server';
import { formatDate } from '@/lib/date-format';
import AccessibilityFigureGlyph from './AccessibilityFigureGlyph';
import db from '@/lib/db';

interface AnnotationCountRow { count: number; }

/**
 * Audience + goal icons. Inlined (not imported from FocusEditForm, which is
 * a client component) so this server component stays server-side.
 */
const AUDIENCE_ICONS: Record<'self' | 'loved_one' | 'guardian', string> = {
  self: '👤',
  loved_one: '🤝',
  guardian: '🛡️',
};
// Accessibility isn't here — the modifier chip renders an
// `<AccessibilityFigureGlyph />` SVG instead of a single emoji.
const GOAL_ICONS: Record<string, string> = {
  understand: '🔍',
  declutter: '🧹',
  minimal: '📋',
};

function getActiveAnnotationCount(): number {
  // Apps with at least one non-deleted annotation — drives the loved_one
  // "{N} apps with notes" subtext.
  const row = db.prepare(`
    SELECT COUNT(DISTINCT app_id) AS count
    FROM annotations
    WHERE deleted_at IS NULL
  `).get() as AnnotationCountRow | undefined;
  return row?.count ?? 0;
}

export default async function YourFocusCard() {
  // Three translation namespaces: `your_focus_card` (card chrome),
  // `audience` (audience chip label), `goal` (goal chip labels).
  const t = await getTranslations('your_focus_card');
  const tAudience = await getTranslations('audience');
  const tGoal = await getTranslations('goal');

  const focus = getActiveFocus();
  const audienceSet = focus.audience !== undefined && Boolean(focus.audience);

  // First-run / unset state — surface a setup CTA so users who land on
  // Settings without completing onboarding can self-recover.
  if (!audienceSet) {
    return (
      <section
        className="settings-section your-focus-card your-focus-card--unset"
        id="focus"
        data-tour="focus-card"
      >
        <h2 className="settings-section-title">{t('title')}</h2>
        <p className="your-focus-card__unset-subtext">{t('unset_subtext')}</p>
        <Link
          href="/onboard/welcome"
          className="btn btn-primary your-focus-card__setup-cta"
        >
          {t('unset_cta')}
        </Link>
      </section>
    );
  }

  // Set state — chip strip in audience · goals · modifier order.
  const audienceChip = tAudience(`${focus.audience}.label`);
  const goalChips = describeGoals(focus.goals, tGoal);
  const accessibilityActive = focus.goals.has('accessibility');
  const isLovedOne = focus.audience === 'loved_one';
  // Gate the annotation count behind `flag.dashboard.annotation_banner`
  // so non-loved_one audiences skip the DB hit.
  const annotationBannerOn = (() => {
    try {
      return resolveFlagFromDb('flag.dashboard.annotation_banner') === 'on';
    } catch {
      return false;
    }
  })();
  const annotationCount =
    isLovedOne && annotationBannerOn ? getActiveAnnotationCount() : 0;

  // Plain-English summary combining audience + active goals. Subkeys live
  // under `your_focus_card.summary.*` for localiser-only edits.
  const summarySentences: string[] = [t(`summary.${focus.audience}`)];
  if (focus.goals.has('minimal')) {
    summarySentences.push(t('summary.with_minimal'));
  } else if (focus.goals.has('understand') && focus.goals.has('declutter')) {
    summarySentences.push(t('summary.with_understand_declutter'));
  } else if (focus.goals.has('understand')) {
    summarySentences.push(t('summary.with_understand'));
  } else if (focus.goals.has('declutter')) {
    summarySentences.push(t('summary.with_declutter'));
  }
  if (accessibilityActive) {
    summarySentences.push(t('summary.with_accessibility'));
  }
  const summary = summarySentences.join(' ');

  // "What this turns on" — render a pill list of focus-controlled page
  // flags. Each `flag` is typed as a FlagKey via Parameters<…>[0] so
  // typos fail at tsc. For tri-state surfaces (collapsed/on/off) we
  // treat non-'off' as "on" because a collapsed panel is still mounted.
  // Errors fall through to "off".
  type FlagName = Parameters<typeof resolveFlagFromDb>[0];
  const enables: ReadonlyArray<{ key: string; flag: FlagName; treatCollapsedAsOn?: true }> = [
    { key: 'privacy_map',   flag: 'flag.page.privacy_map' },
    { key: 'stats',         flag: 'flag.page.stats' },
    { key: 'compare',       flag: 'flag.page.compare' },
    { key: 'shortlist',     flag: 'flag.page.shortlist' },
    { key: 'manual_apps',   flag: 'flag.page.manual_apps' },
    { key: 'annotations',   flag: 'flag.detail.annotations_sidebar', treatCollapsedAsOn: true },
    { key: 'accessibility', flag: 'flag.detail.a11y.panel', treatCollapsedAsOn: true },
  ];
  const enableRows = enables.map(({ key, flag, treatCollapsedAsOn }) => {
    const on = (() => {
      try {
        const value = resolveFlagFromDb(flag);
        return treatCollapsedAsOn ? value !== 'off' : value === 'on';
      } catch {
        return false;
      }
    })();
    return { key, on };
  });

  // "Focus updated {date}" footnote — suppressed when the user has never
  // called setActiveFocus (e.g. DB-seeded installs).
  const updatedAt = getFocusUpdatedAt();
  const dateMode = getDateFormatPreference();

  return (
    <section
      className="settings-section your-focus-card"
      id="focus"
      data-tour="focus-card"
    >
      <header className="your-focus-card__header">
        <h2 className="settings-section-title">{t('title')}</h2>
        <Link
          href="/help/focus"
          className="your-focus-card__help-link"
          aria-label={t('help_link')}
          title={t('help_link')}
        >
          (?)
        </Link>
      </header>

      {/* Chip strip — same audience + goal vocabulary as the onboarding
          screens; accessibility renders an SVG figure-in-circle. */}
      <div className="your-focus-card__chips" role="list">
        <span role="listitem" className="chip chip--audience">
          <span className="chip-icon" aria-hidden="true">
            {AUDIENCE_ICONS[focus.audience]}
          </span>
          <span className="chip-label">{audienceChip}</span>
        </span>
        {goalChips.map(({ key, label }) => (
          <span key={key} role="listitem" className="chip chip--goal">
            <span className="chip-icon" aria-hidden="true">
              {GOAL_ICONS[key] ?? ''}
            </span>
            <span className="chip-label">{label}</span>
          </span>
        ))}
        {accessibilityActive && (
          <span role="listitem" className="chip chip--modifier">
            <span className="chip-icon" aria-hidden="true">
              <AccessibilityFigureGlyph size={16} />
            </span>
            <span className="chip-label">{tGoal('accessibility.label')}</span>
          </span>
        )}
      </div>

      {summary && <p className="your-focus-card__summary">{summary}</p>}

      {isLovedOne && annotationCount > 0 && (
        <Link
          href="/dashboard?filter=annotated"
          className="your-focus-card__annotation-count"
        >
          {/* ICU plural via your_focus_card.annotation_count. */}
          {t('annotation_count', { count: annotationCount })}
        </Link>
      )}

      <div className="your-focus-card__enables">
        <h3 className="your-focus-card__enables-heading">
          {t('enables_heading')}
        </h3>
        <ul className="your-focus-card__enables-list" role="list">
          {enableRows.map((row) => (
            <li
              key={row.key}
              className={`your-focus-card__enable${row.on ? ' is-on' : ' is-off'}`}
            >
              <span className="your-focus-card__enable-name">
                {t(`enables.${row.key}`)}
              </span>
              <span className="your-focus-card__enable-state" aria-hidden="true">
                {row.on ? '●' : '○'}
              </span>
              <span className="your-focus-card__enable-state-label">
                {row.on ? t('enable_chip_on') : t('enable_chip_off')}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="your-focus-card__footer">
        <div className="your-focus-card__actions">
          <Link
            href="/dashboard/settings/focus"
            className="btn btn-primary your-focus-card__adjust"
            aria-label={t('adjust')}
          >
            <span className="your-focus-card__adjust-icon" aria-hidden="true">✏️</span>
            <span>{t('adjust')}</span>
          </Link>
        </div>
        {updatedAt && (
          <p className="your-focus-card__updated-at">
            {t('updated_at', { date: formatDate(updatedAt, dateMode) })}
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Locals
// ---------------------------------------------------------------------------

/**
 * Render active goals as `{ key, label }` entries in display order:
 * understand → declutter (if both checked) → minimal. Accessibility is
 * rendered separately. Takes the goal-namespace `t` so this helper stays
 * sync (the caller already awaits translations once).
 */
function describeGoals(
  goals: Set<string>,
  tGoal: (key: string) => string,
): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  if (goals.has('minimal')) {
    out.push({ key: 'minimal', label: tGoal('minimal.label') });
  } else {
    if (goals.has('understand')) {
      out.push({ key: 'understand', label: tGoal('understand.label') });
    }
    if (goals.has('declutter')) {
      out.push({ key: 'declutter', label: tGoal('declutter.label') });
    }
  }
  return out;
}

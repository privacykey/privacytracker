'use client';

/**
 * FocusPreviewBanner — persistent top-of-page banner that surfaces a
 * staged focus preview and lets the user commit or revert.
 *
 * The focus-edit form (Settings → Adjust) stages a preview into
 * sessionStorage via lib/focus-preview.ts. Keep → POST /api/focus, clear
 * preview, full reload so server-rendered surfaces flush. Revert → clear
 * silently. Tab close → sessionStorage drops, no banner in a fresh tab.
 *
 * Mounted in app/layout.tsx so every route gets the banner. Server-
 * rendered flag decisions don't reflect preview state until commit, so
 * Keep triggers a hard reload.
 * https://privacytracker-docs.privacykey.org/develop/feature-flags
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  clearPreviewFocus,
  getPreviewFocus,
  isHintShown,
  markHintShown,
  subscribePreview,
  type FocusPreview,
} from '@/lib/focus-preview';

export default function FocusPreviewBanner() {
  // Audience/goal labels come from shared `audience.<key>.label` and
  // `goal.<key>.label` namespaces so copy edits ripple everywhere.
  const t = useTranslations('preview_banner');
  const tAudience = useTranslations('audience');
  const tGoal = useTranslations('goal');

  // null = no preview; undefined = pre-mount (avoid SSR/hydrate mismatch).
  const [preview, setPreview] = useState<FocusPreview | null | undefined>(undefined);
  const [showHint, setShowHint] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Hydrate from sessionStorage on mount, then subscribe to in-tab
  // change events.
  useEffect(() => {
    const sync = () => {
      const next = getPreviewFocus();
      setPreview(next);
      // "Closing this tab reverts" hint is shown once per preview session.
      if (next && !isHintShown()) {
        setShowHint(true);
        markHintShown();
      } else {
        setShowHint(false);
      }
    };
    sync();
    const unsubscribe = subscribePreview(sync);
    return unsubscribe;
  }, []);

  const handleKeep = useCallback(async () => {
    if (!preview || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch('/api/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audience: preview.audience,
          understand: preview.understand,
          declutter: preview.declutter,
          minimal: preview.minimal,
          accessibility: preview.accessibility,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t('save_failed_default'));
      }
      // Hard reload so server-rendered surfaces (Nav, YourFocusCard,
      // callouts) flush. router.refresh() doesn't reliably re-execute
      // layout-level resolveFlagFromDb() across all routes.
      clearPreviewFocus();
      window.location.reload();
    } catch (err) {
      console.error('[FocusPreviewBanner] commit failed:', err);
      setSubmitError(err instanceof Error ? err.message : t('save_failed_default'));
      setSubmitting(false);
    }
  }, [preview, submitting, t]);

  const handleRevert = useCallback(() => {
    if (submitting) return;
    clearPreviewFocus();
    // No reload — server-rendered surfaces are already on the DB state.
  }, [submitting]);

  if (preview === undefined || preview === null) {
    return null;
  }

  // Human-readable summary, e.g. "For someone I care about · Understand
  // · Declutter · Accessibility".
  const audienceLabel = tAudience(`${preview.audience}.label`);
  const goalLabels = goalLabelsFor(preview, tGoal);
  const summary = [audienceLabel, ...goalLabels].join(' · ');

  return (
    <div
      className="focus-preview-banner"
      role="region"
      aria-label={t('controls_aria')}
    >
      <div className="focus-preview-banner__inner">
        <div className="focus-preview-banner__copy">
          <span className="focus-preview-banner__label">{t('label')}</span>{' '}
          <strong className="focus-preview-banner__summary">{summary}</strong>
          {showHint && (
            <span className="focus-preview-banner__hint">
              {t('first_time_hint_inline')}
            </span>
          )}
          {submitError && (
            <span
              className="focus-preview-banner__error"
              role="alert"
              aria-live="assertive"
            >
              {' '}{submitError}
            </span>
          )}
        </div>
        <div className="focus-preview-banner__actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void handleKeep()}
            disabled={submitting}
          >
            {submitting ? t('saving') : t('keep')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleRevert}
            disabled={submitting}
          >
            {t('revert')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compose the goal portion of the preview summary in display order:
 *   - minimal selected → render the minimal label alone
 *   - otherwise → understand / declutter (in that order) if checked,
 *     fallback to understand when neither is checked (matches the silent
 *     default applied at commit time)
 *   - accessibility appended last when active.
 *
 * Takes a `t` function so React hook ordering rules aren't violated.
 */
function goalLabelsFor(
  preview: FocusPreview,
  tGoal: (key: string) => string,
): string[] {
  const out: string[] = [];
  if (preview.minimal) {
    out.push(tGoal('minimal.label'));
  } else if (preview.understand || preview.declutter) {
    if (preview.understand) out.push(tGoal('understand.label'));
    if (preview.declutter) out.push(tGoal('declutter.label'));
  } else {
    out.push(tGoal('understand.label'));
  }
  if (preview.accessibility) out.push(tGoal('accessibility.label'));
  return out;
}

'use client';

import { useState, useEffect, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { Audience } from '@/lib/feature-flag-rules';
import { seedSampleApps } from '@/lib/sample-apps';
import { useFlag } from '../../lib/feature-flags-hooks';

/**
 * Onboarding screen 1 — WHO are you auditing apps for?
 *
 * Three radio cards (self / loved_one / guardian) with arrow-key navigation,
 * plus a "Try with sample data" escape hatch and a "Skip for now" link that
 * sets `audience = self` silently.
 *
 * Replaces the pre-v1 four-card intent picker. The new audience choice
 * drives the entire focus system; goals are picked on the next screen
 * (`/onboard/goals`).
 *
 * Accessibility: WCAG AA. Cards are `role="radio"` inside a
 * `role="radiogroup"`, navigated by ↑/↓/←/→ and selected by Space/Enter.
 * Touch targets are ≥44×44px on mobile.
 *
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags.
 */

/**
 * Audience cards rendered on screen 1. Labels + subtext come from
 * `locales/<locale>.json` under `audience.<value>.{label,subtext}` —
 * shared with WelcomeSplash, GoalsScreen pre-fill copy, and the focus
 * edit form. Only the icon stays hard-coded because emoji glyphs are
 * language-agnostic.
 */
const AUDIENCE_VALUES: ReadonlyArray<{ value: Audience; icon: string }> = [
  { value: 'self', icon: '👤' },
  { value: 'loved_one', icon: '🤝' },
  { value: 'guardian', icon: '🛡️' },
];

interface Props {
  /** If revisiting (e.g. via Settings → Focus → Adjust), pre-select the current audience. */
  initialAudience?: Audience | null;
}

export default function WelcomeSplash({ initialAudience }: Props) {
  const router = useRouter();
  // Onboarding screen-1 copy. Uses three namespaces:
  //   - `onboarding.welcome` for the page chrome (headline, subhead, buttons)
  //   - `audience` for the three card labels + subtexts (shared across surfaces)
  //   - `onboarding.audience_aria` for screen-reader card descriptions
  const t = useTranslations('onboarding.welcome');
  const tAudience = useTranslations('audience');
  const tAria = useTranslations('onboarding.audience_aria');
  const tCommon = useTranslations('common');

  // Wave I — onboarding screen-1 flags. The audience-picker itself can be
  // hidden (skipping straight to /onboard/goals with the legacy 'self'
  // default), and its bottom-of-card "Skip for now" link is gated
  // separately so admins can keep the picker but force a deliberate
  // choice. The "Try with sample data" escape hatch likewise has its
  // own flag so guardians (curated workflow) don't see a "skip the real
  // setup" affordance during onboarding.
  const audiencePickerOn = useFlag('flag.onboarding.audience_picker') === 'on';
  const audiencePickerSkipOn = useFlag('flag.onboarding.audience_picker.skip') === 'on';
  const sampleDataButtonOn = useFlag('flag.onboarding.sample_data_button') === 'on';

  const [selected, setSelected] = useState<Audience | null>(initialAudience ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Sync to props change (revisit case)
  useEffect(() => {
    setSelected(initialAudience ?? null);
  }, [initialAudience]);

  async function commitAndContinue(audience: Audience) {
    setSaving(true);
    setError('');
    try {
      // Set the audience now; goals get set on the next screen.
      // We pass empty primary goals here — screen 2 will overwrite them
      // with the user's actual goal selections (or the silent default).
      const res = await fetch('/api/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audience, understand: true }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t('save_failed'));
      }
      router.push('/onboard/goals');
    } catch (err) {
      console.error('[welcome] save failed:', err);
      setError(err instanceof Error ? err.message : t('save_failed'));
      setSaving(false);
    }
  }

  function handleContinue() {
    if (!selected) return;
    void commitAndContinue(selected);
  }

  function handleSkip() {
    // Skip = set audience to 'self' silently and advance to screen 2.
    void commitAndContinue('self');
  }

  function handleSampleData() {
    // Sample-data mode: seed sessionStorage with 10 demo apps + route to
    // /dashboard?sample=1. The query param tells the server-side dashboard
    // to skip the no-apps-redirect; the SampleModeView client component
    // then reads sessionStorage and renders the demo apps inline.
    seedSampleApps();
    void fetch('/api/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'self', understand: true }),
    }).finally(() => {
      router.push('/dashboard?sample=1');
    });
  }

  // Arrow-key navigation between cards (WCAG AA).
  function handleCardKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (saving) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = (index + 1) % AUDIENCE_VALUES.length;
      setSelected(AUDIENCE_VALUES[next].value);
      focusCard(next);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = (index - 1 + AUDIENCE_VALUES.length) % AUDIENCE_VALUES.length;
      setSelected(AUDIENCE_VALUES[prev].value);
      focusCard(prev);
    }
  }

  function focusCard(index: number) {
    const id = `audience-card-${AUDIENCE_VALUES[index].value}`;
    document.getElementById(id)?.focus();
  }

  return (
    <div className="wizard-outer">
      <div className="wizard-card wizard-card-wide">
        <div className="welcome-eyebrow">{t('eyebrow')}</div>
        <h1 className="wizard-title">{t('headline')}</h1>
        <p className="wizard-subtitle">{t('subhead_long')}</p>

        {audiencePickerOn && <div
          className="method-grid welcome-grid audience-grid"
          role="radiogroup"
          aria-label={t('subhead')}
        >
          {AUDIENCE_VALUES.map((option, index) => {
            const isSelected = selected === option.value;
            return (
              <button
                key={option.value}
                id={`audience-card-${option.value}`}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={tAria(`${option.value}_card`)}
                tabIndex={isSelected || (selected === null && index === 0) ? 0 : -1}
                className={`method-card welcome-card audience-card ${isSelected ? 'active' : ''}`}
                onClick={() => setSelected(option.value)}
                onKeyDown={(e) => handleCardKeyDown(e, index)}
                onDoubleClick={() => commitAndContinue(option.value)}
                disabled={saving}
              >
                <div className="method-card-top">
                  <span className="welcome-card-icon" aria-hidden="true">
                    {option.icon}
                  </span>
                  <span className="method-card-radio" aria-hidden="true">
                    {isSelected ? '✓' : ''}
                  </span>
                </div>
                <div className="method-card-title">{tAudience(`${option.value}.label`)}</div>
                <p className="method-card-copy">{tAudience(`${option.value}.subtext`)}</p>
              </button>
            );
          })}
        </div>}

        {error && (
          <div className="welcome-error" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        <div className="welcome-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleContinue}
            disabled={!selected || saving}
          >
            {saving ? tCommon('saving') : t('next')}
          </button>
          {audiencePickerSkipOn && <button
            type="button"
            className="btn btn-ghost welcome-skip"
            onClick={handleSkip}
            disabled={saving}
          >
            {t('skip')}
          </button>}
        </div>

        {sampleDataButtonOn && <div className="welcome-tertiary">
          <button
            type="button"
            className="welcome-link welcome-sample-data"
            onClick={handleSampleData}
            disabled={saving}
          >
            {t('sample_data_button')} →
          </button>
        </div>}

        <p className="welcome-footnote">
          {t('footnote_prompt')}{' '}
          <Link href="/help/focus" className="welcome-link">
            {t('help_link')}
          </Link>
        </p>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import PrivacyProfileEditor from './PrivacyProfileEditor';
import {
  DEFAULT_PROFILE,
  type PrivacyProfile,
} from '../../lib/privacy-profile';

interface Props {
  /** Existing saved profile, so a returning user sees their previous edits. */
  initialProfile: PrivacyProfile | null;
}

/**
 * Optional onboarding step shown between the Welcome splash and the main
 * OnboardWizard. Entirely skippable — the toggle at the top is off by
 * default. Once the user flips it on, the editor appears with a sensible
 * default profile they can fine-tune before continuing.
 *
 * A returning user (revisiting from Settings → "Edit in onboarding style")
 * lands here with their existing profile hydrated and the toggle pre-on, so
 * the Save & Continue flow is identical.
 */
export default function PrivacyProfileSetup({ initialProfile }: Props) {
  const t = useTranslations('onboard.profile_setup');
  const router = useRouter();
  const hasExistingProfile = Boolean(
    initialProfile && Object.values(initialProfile).some(v => typeof v === 'string'),
  );
  const [enabled, setEnabled] = useState<boolean>(hasExistingProfile);
  const [profile, setProfile] = useState<PrivacyProfile>(
    hasExistingProfile ? { ...initialProfile } : { ...DEFAULT_PROFILE },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  const continueToWizard = () => {
    router.push('/onboard');
  };

  const onSkip = () => {
    continueToWizard();
  };

  const onSave = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = enabled ? profile : null;
      const res = await fetch('/api/privacy-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: payload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? t('save_failed'));
      }
      continueToWizard();
    } catch (err) {
      console.error('[onboard/profile] save failed:', err);
      setError(err instanceof Error ? err.message : t('save_failed'));
      setSaving(false);
    }
  };

  const setCount = Object.values(profile).filter(v => typeof v === 'string').length;

  return (
    <div className="wizard-outer">
      <div className="wizard-card wizard-card-wide">
        {/* Back link to the previous onboarding screen — without one
            users on /onboard/profile have no obvious way to revisit
            their goals or audience pick. Mirrors the back link on the
            wizard's step 1; same `wizard-back-link` class so the
            placement is consistent across the onboarding flow. */}
        <Link
          href="/onboard/goals"
          className="wizard-back-link"
          aria-label={t('back_aria')}
        >
          <span aria-hidden="true">←</span> {t('back_to_goals')}
        </Link>
        <div className="wizard-subtle-eyebrow">{t('eyebrow')}</div>
        <h1 className="wizard-title">{t('title')}</h1>
        <p className="wizard-subtitle">
          {t.rich('subtitle', { em: chunks => <em>{chunks}</em> })}
        </p>

        {/* Master on/off — matches the switch style used in Settings →
            Privacy Profile so the control feels the same wherever the user
            encounters it. */}
        <div className="privacy-profile-toggle-row" style={{ marginBottom: 16 }}>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t('switch_aria')}
            className={`switch-toggle${enabled ? ' is-on' : ''}`}
            onClick={() => setEnabled(!enabled)}
            disabled={saving}
          >
            <span className="switch-toggle-thumb" aria-hidden="true" />
          </button>
          <div className="privacy-profile-toggle-label">
            <div className="privacy-profile-toggle-title">{t('switch_title')}</div>
            <div className="privacy-profile-toggle-hint">
              {enabled
                ? t('switch_hint_on')
                : t('switch_hint_off')}
            </div>
          </div>
        </div>

        {enabled && (
          <PrivacyProfileEditor
            value={profile}
            onChange={setProfile}
            disabled={saving}
            // First-time users land here with the editor's local state
            // pre-loaded from DEFAULT_PROFILE — clicking a preset shouldn't
            // require a confirm. Returning users (with a saved profile)
            // get the confirm so they don't lose customisations.
            confirmOnPresetApply={hasExistingProfile}
          />
        )}

        {error && (
          <div className="welcome-error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div className="welcome-actions" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void onSave()}
            disabled={saving || (enabled && setCount === 0)}
          >
            {saving
              ? t('saving')
              : enabled
                ? t('save_continue')
                : t('continue_no_profile')}
          </button>
          <button
            type="button"
            className="btn btn-ghost welcome-skip"
            onClick={onSkip}
            disabled={saving}
          >
            {t('skip')}
          </button>
        </div>

        <p className="welcome-footnote" style={{ marginTop: 14 }}>
          {t('footnote_pre')}
          <Link href="/dashboard/settings#privacy-profile" className="welcome-link">
            {t('footnote_link')}
          </Link>
          {t('footnote_post')}
        </p>
      </div>
    </div>
  );
}

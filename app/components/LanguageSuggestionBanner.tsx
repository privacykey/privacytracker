'use client';

/**
 * LanguageSuggestionBanner — surfaces in the Settings → App Store Region
 * card after the user changes their storefront, when the new region's
 * expected language differs from the active UI locale.
 *
 * Trigger logic lives in the parent (SettingsView):
 *
 *   - storefront → 'cn' AND active locale === 'en'  → suggest zh
 *   - storefront → anything else AND active locale === 'zh' → suggest en
 *
 * Click "Switch" → POST /api/locale + window.location.reload, same path
 * the LocaleSwitcher in Settings → Language uses. Reload is deliberate
 * — server components render their copy at the request boundary, and
 * router.refresh() doesn't reliably re-execute every layout-level await.
 *
 * Click "Dismiss" → fires onDismiss so the parent can clear its
 * suggestion state. We don't persist the dismissal across page loads;
 * the suggestion only fires immediately after a region save, so a
 * one-shot dismissal is sufficient for v1.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface Props {
  /** Which language the banner is suggesting we switch *to*. */
  target: 'zh' | 'en';
  /** Called after a successful dismiss or switch — parent clears state. */
  onDismiss: () => void;
}

export default function LanguageSuggestionBanner({ target, onDismiss }: Props) {
  const t = useTranslations('language_suggestion');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleKey = target === 'zh' ? 'to_zh_title' : 'to_en_title';
  const bodyKey = target === 'zh' ? 'to_zh_body' : 'to_en_body';
  const ctaKey = target === 'zh' ? 'to_zh_cta' : 'to_en_cta';

  async function handleSwitch() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/locale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: target }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Hard reload so server-rendered surfaces flush to the new
      // bundle on first paint. Same pattern LocaleSwitcher uses.
      window.location.reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('switch_failed'));
      setBusy(false);
    }
  }

  return (
    <aside
      className="language-suggestion-banner"
      role="status"
      aria-live="polite"
    >
      <div className="language-suggestion-body">
        <strong className="language-suggestion-title">{t(titleKey)}</strong>
        <p className="language-suggestion-copy">{t(bodyKey)}</p>
        {error && (
          <p className="language-suggestion-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="language-suggestion-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void handleSwitch()}
          disabled={busy}
        >
          {t(ctaKey)}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onDismiss}
          aria-label={t('dismiss_aria')}
          disabled={busy}
        >
          {t('dismiss')}
        </button>
      </div>
    </aside>
  );
}

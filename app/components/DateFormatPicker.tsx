'use client';

/**
 * DateFormatPicker — Settings → Appearance control for the
 * `app_settings.date_format` preference. Hits /api/date-format on
 * mount to hydrate the current value, then POSTs back on change and
 * broadcasts the new value via `broadcastDateFormat()` so every
 * mounted `useDateFormat()` hook re-renders without a page reload.
 *
 * The component is intentionally small — just a labelled select with
 * live previews under each option — so it can sit inside the
 * SettingsView's existing card chrome without dragging extra layout
 * primitives along.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DATE_FORMAT_DEFAULT,
  DATE_FORMAT_MODES,
  describeDateFormat,
  normaliseDateFormat,
  type DateFormatMode,
} from '@/lib/date-format';
import { broadcastDateFormat } from '@/lib/date-format-hook';

export default function DateFormatPicker() {
  const t = useTranslations('date_format');
  // Hydrating null means "still fetching" — render the select as
  // disabled so the user doesn't briefly see the wrong default and
  // accidentally save it. Once the GET resolves we flip to the real
  // value.
  const [mode, setMode] = useState<DateFormatMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Gate the per-option "— Dec 31, 2025" preview text behind a mount
   * flag. Without this, the `'auto'` mode preview produces a
   * hydration mismatch: `describeDateFormat('auto')` calls through to
   * `Intl.DateTimeFormat(undefined, …)`, which on the server picks up
   * Node's runtime locale (typically `en-US` → "Dec 31, 2025") and on
   * the client picks up the browser's locale (e.g. `en-AU` →
   * "31 Dec 2025"). That difference shows up in the SSR vs. CSR HTML
   * and React tears down the whole option tree to recover.
   * Rendering the preview only after mount means the server emits
   * just the mode label (locale-agnostic) and the client patches in
   * the preview text on the next paint — no SSR/CSR divergence.
   */
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let live = true;
    fetch('/api/date-format')
      .then(r => (r.ok ? r.json() : null))
      .then((body: { mode?: string } | null) => {
        if (!live) return;
        setMode(normaliseDateFormat(body?.mode ?? null));
      })
      .catch(() => {
        if (live) setMode(DATE_FORMAT_DEFAULT);
      });
    return () => {
      live = false;
    };
  }, []);

  async function handleChange(next: DateFormatMode) {
    setMode(next);
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/date-format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      const body = (await r.json()) as { mode?: string };
      const saved = normaliseDateFormat(body.mode ?? next);
      setMode(saved);
      // Tell every mounted useDateFormat() to re-read in-place. This
      // is the live-apply path — without it, dates re-format only
      // after a route change.
      broadcastDateFormat(saved);
      setSavedAt(Date.now());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('save_failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-field date-format-picker">
      <label htmlFor="date-format-picker-select" className="settings-field-label">
        {t('label')}
      </label>
      <p className="settings-field-hint">{t('hint')}</p>
      <select
        id="date-format-picker-select"
        value={mode ?? DATE_FORMAT_DEFAULT}
        onChange={(e) => handleChange(normaliseDateFormat(e.target.value))}
        disabled={mode === null || saving}
        className="date-format-picker-select"
      >
        {DATE_FORMAT_MODES.map((m) => (
          <option key={m} value={m}>
            {/* Server emits `Auto` / `DMY` / `MDY` / `ISO` (locale-
                agnostic); client appends `— Dec 31, 2025` etc. on the
                first effect tick. See the `mounted` declaration above
                for the hydration-mismatch reasoning. */}
            {t(`modes.${m}`)}{mounted ? ` — ${describeDateFormat(m)}` : ''}
          </option>
        ))}
      </select>
      {savedAt && !saving && !error && (
        <p
          className="settings-field-status settings-field-status-ok"
          role="status"
          aria-live="polite"
        >
          {t('saved')}
        </p>
      )}
      {error && (
        <p
          className="settings-field-status settings-field-status-err"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}

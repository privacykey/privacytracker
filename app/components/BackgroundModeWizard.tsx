'use client';

/**
 * "Keep privacytracker running in the background" wizard.
 *
 * Tauri-only — the web build has no concept of a tray icon or
 * persistent background process, so we never render this surface
 * outside the desktop shell. Gated by `flag.dashboard.background_mode_wizard`.
 *
 * Four steps:
 *
 *   1. Sync frequency       — writes `sync_schedule` (manual / daily / weekly)
 *   2. Notifications        — writes `notification_webhook_url` + format +
 *                             frequency. In-app bell is always on. Native
 *                             OS notifications are opt-in (existing
 *                             `native_notifications` toggle in the
 *                             DesktopAppSection — surfaced here too so the
 *                             wizard is self-contained).
 *   3. Background defaults  — autostart + launch-hidden recommendations
 *                             (existing Tauri plugins; we set the same
 *                             settings DesktopAppSection writes).
 *   4. Quiet hours          — optional start/end window during which
 *                             notifications get suppressed (existing
 *                             `notification_quiet_hours_*` settings).
 *
 * On success, writes `background_wizard_completed_at`. On dismiss
 * without completing, writes `background_wizard_dismissed_at`. Either
 * value hides the dashboard callout forever (re-discoverable via
 * Settings).
 *
 * All settings are saved on the FINAL "Done" click — the user can
 * navigate freely between steps without partial writes.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import './background-mode-wizard.css';

type Step = 0 | 1 | 2 | 3;

type SyncSchedule = 'manual' | 'daily' | 'weekly';
type WebhookFormat = 'slack' | 'discord' | 'teams' | 'generic';
type WebhookFrequency = 'immediate' | 'daily_summary' | 'weekly_summary' | 'off';

interface WizardState {
  sync: SyncSchedule;
  nativeNotifications: boolean;
  webhookUrl: string;
  webhookFormat: WebhookFormat;
  webhookFrequency: WebhookFrequency;
  autostart: boolean;
  launchHidden: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

interface Props {
  onClose: (outcome: 'completed' | 'dismissed') => void;
  /** Initial values pulled from current settings so the wizard reads
   *  the user's existing config and can be revisited without resetting
   *  things they already configured. */
  initial?: Partial<WizardState>;
}

const DEFAULT_STATE: WizardState = {
  sync: 'daily',
  nativeNotifications: true,
  webhookUrl: '',
  webhookFormat: 'generic',
  webhookFrequency: 'immediate',
  autostart: true,
  launchHidden: true,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
};

export default function BackgroundModeWizard({ onClose, initial }: Props) {
  const t = useTranslations('background_mode_wizard');
  const [step, setStep] = useState<Step>(0);
  const [state, setState] = useState<WizardState>({ ...DEFAULT_STATE, ...initial });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Test-webhook state lives inside the notifications step
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'failure'>('idle');
  const [testDetail, setTestDetail] = useState<string>('');

  const update = (patch: Partial<WizardState>) => setState(prev => ({ ...prev, ...patch }));

  const next = () => setStep(s => (s < 3 ? ((s + 1) as Step) : s));
  const back = () => setStep(s => (s > 0 ? ((s - 1) as Step) : s));

  const handleTestWebhook = async () => {
    if (!state.webhookUrl.trim()) return;
    setTestStatus('testing');
    setTestDetail('');
    try {
      const res = await fetch('/api/notifications/webhook-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: state.webhookUrl.trim(),
          format: state.webhookFormat,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        setTestStatus('success');
        setTestDetail(t('step_notifications.test_success', { status: body.status }));
      } else {
        setTestStatus('failure');
        setTestDetail(body.detail ?? body.error ?? t('step_notifications.test_failure_generic'));
      }
    } catch (e) {
      setTestStatus('failure');
      setTestDetail(e instanceof Error ? e.message : t('step_notifications.test_failure_generic'));
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Settings write — the wizard collects everything and commits in
      // one POST so the user can back out without partial state.
      const settingsRes = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sync_schedule: state.sync,
          notification_webhook_url: state.webhookUrl.trim(),
          notification_webhook_format: state.webhookFormat,
          notification_webhook_frequency: state.webhookUrl.trim() ? state.webhookFrequency : 'off',
          notification_quiet_hours_start: state.quietHoursEnabled ? state.quietHoursStart : '',
          notification_quiet_hours_end:   state.quietHoursEnabled ? state.quietHoursEnd   : '',
          background_wizard_completed_at: String(Date.now()),
        }),
      });
      if (!settingsRes.ok) {
        const body = await settingsRes.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${settingsRes.status}`);
      }

      // Native notifications + autostart + launch-hidden live in the
      // desktop-specific settings store (separate endpoint from the
      // main /api/settings — same persistence shape, distinct route
      // because some keys map to Tauri plugin state and need extra
      // side-effects). We POST best-effort and log on failure rather
      // than blocking the wizard — the user's primary config already
      // landed in /api/settings.
      try {
        await fetch('/api/settings/desktop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            native_notifications: state.nativeNotifications,
            autostart: state.autostart,
            launch_hidden: state.launchHidden,
          }),
        });
      } catch (e) {
        console.warn('[BackgroundModeWizard] desktop settings write failed (ignored):', e);
      }

      onClose('completed');
    } catch (err) {
      console.error('[BackgroundModeWizard] submit failed:', err);
      setSubmitError(err instanceof Error ? err.message : t('submit_error_generic'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-overlay bg-wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bg-wizard-title"
      onClick={() => onClose('dismissed')}
    >
      <div
        className="modal-card bg-wizard-card"
        onClick={e => e.stopPropagation()}
      >
        <header className="bg-wizard-header">
          <h2 id="bg-wizard-title" className="bg-wizard-title">{t('title')}</h2>
          <button
            type="button"
            className="bg-wizard-close"
            onClick={() => onClose('dismissed')}
            aria-label={t('close_aria')}
            disabled={submitting}
          >
            ✕
          </button>
        </header>

        <div className="bg-wizard-stepper" aria-label={t('stepper_aria')}>
          {([0, 1, 2, 3] as Step[]).map(s => (
            <div
              key={s}
              className={`bg-wizard-stepper-dot ${s === step ? 'is-current' : ''} ${s < step ? 'is-done' : ''}`}
              aria-current={s === step ? 'step' : undefined}
            />
          ))}
        </div>

        <div className="bg-wizard-body">
          {step === 0 && <SyncStep state={state} update={update} t={t} />}
          {step === 1 && (
            <NotificationsStep
              state={state}
              update={update}
              t={t}
              onTest={handleTestWebhook}
              testStatus={testStatus}
              testDetail={testDetail}
            />
          )}
          {step === 2 && <BackgroundDefaultsStep state={state} update={update} t={t} />}
          {step === 3 && <QuietHoursStep state={state} update={update} t={t} />}
        </div>

        {submitError && <p className="bg-wizard-error">{submitError}</p>}

        <footer className="bg-wizard-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={step === 0 ? () => onClose('dismissed') : back}
            disabled={submitting}
          >
            {step === 0 ? t('cancel') : t('back')}
          </button>
          {step < 3 ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={next}
              disabled={submitting}
            >
              {t('next')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSubmit()}
              disabled={submitting}
            >
              {submitting ? t('saving') : t('done')}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Step components
// ─────────────────────────────────────────────

function SyncStep({
  state, update, t,
}: {
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <section className="bg-wizard-step" data-testid="bg-wizard-step-sync">
      <h3 className="bg-wizard-step-title">{t('step_sync.title')}</h3>
      <p className="bg-wizard-step-body">{t('step_sync.body')}</p>
      <div className="bg-wizard-option-list" role="radiogroup">
        {(['daily', 'weekly', 'manual'] as const).map(s => (
          <label
            key={s}
            className={`bg-wizard-option ${state.sync === s ? 'is-active' : ''}`}
          >
            <input
              type="radio"
              name="bg-wizard-sync"
              value={s}
              checked={state.sync === s}
              onChange={() => update({ sync: s })}
            />
            <div className="bg-wizard-option-text">
              <strong>{t(`step_sync.option_${s}` as 'step_sync.option_daily')}</strong>
              <span className="bg-wizard-option-hint">
                {t(`step_sync.option_${s}_hint` as 'step_sync.option_daily_hint')}
              </span>
            </div>
          </label>
        ))}
      </div>
    </section>
  );
}

function NotificationsStep({
  state, update, t, onTest, testStatus, testDetail,
}: {
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
  t: ReturnType<typeof useTranslations>;
  onTest: () => void;
  testStatus: 'idle' | 'testing' | 'success' | 'failure';
  testDetail: string;
}) {
  const webhookConfigured = state.webhookUrl.trim().length > 0;
  return (
    <section className="bg-wizard-step" data-testid="bg-wizard-step-notifications">
      <h3 className="bg-wizard-step-title">{t('step_notifications.title')}</h3>
      <p className="bg-wizard-step-body">{t('step_notifications.body')}</p>

      <div className="bg-wizard-toggle-list">
        <label className="bg-wizard-toggle">
          <input type="checkbox" checked disabled />
          <div className="bg-wizard-toggle-text">
            <strong>{t('step_notifications.bell_label')}</strong>
            <span className="bg-wizard-toggle-hint">{t('step_notifications.bell_hint')}</span>
          </div>
        </label>
        <label className="bg-wizard-toggle">
          <input
            type="checkbox"
            checked={state.nativeNotifications}
            onChange={e => update({ nativeNotifications: e.target.checked })}
          />
          <div className="bg-wizard-toggle-text">
            <strong>{t('step_notifications.native_label')}</strong>
            <span className="bg-wizard-toggle-hint">{t('step_notifications.native_hint')}</span>
          </div>
        </label>
      </div>

      <div className="bg-wizard-webhook">
        <div className="bg-wizard-webhook-label">{t('step_notifications.webhook_label')}</div>
        <p className="bg-wizard-webhook-hint">{t('step_notifications.webhook_hint')}</p>
        <div className="bg-wizard-webhook-row">
          <input
            type="url"
            className="bg-wizard-input"
            placeholder={t('step_notifications.webhook_placeholder')}
            value={state.webhookUrl}
            onChange={e => update({ webhookUrl: e.target.value })}
          />
          <select
            className="bg-wizard-select"
            value={state.webhookFormat}
            onChange={e => update({ webhookFormat: e.target.value as WebhookFormat })}
            disabled={!webhookConfigured}
            aria-label={t('step_notifications.webhook_format_aria')}
          >
            <option value="slack">{t('step_notifications.format_slack')}</option>
            <option value="discord">{t('step_notifications.format_discord')}</option>
            <option value="teams">{t('step_notifications.format_teams')}</option>
            <option value="generic">{t('step_notifications.format_generic')}</option>
          </select>
        </div>
        {webhookConfigured && (
          <>
            <div className="bg-wizard-webhook-frequency">
              <span className="bg-wizard-webhook-frequency-label">
                {t('step_notifications.frequency_label')}
              </span>
              <div className="bg-wizard-pill-row">
                {(['immediate', 'daily_summary', 'weekly_summary'] as const).map(f => (
                  <label
                    key={f}
                    className={`bg-wizard-pill ${state.webhookFrequency === f ? 'is-active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="bg-wizard-webhook-freq"
                      value={f}
                      checked={state.webhookFrequency === f}
                      onChange={() => update({ webhookFrequency: f })}
                    />
                    <span>{t(`step_notifications.frequency_${f}` as 'step_notifications.frequency_immediate')}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="bg-wizard-webhook-test">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onTest}
                disabled={testStatus === 'testing'}
              >
                {testStatus === 'testing'
                  ? t('step_notifications.testing')
                  : t('step_notifications.test_button')}
              </button>
              {testStatus === 'success' && (
                <span className="bg-wizard-test-result is-success">✓ {testDetail}</span>
              )}
              {testStatus === 'failure' && (
                <span className="bg-wizard-test-result is-failure">✕ {testDetail}</span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function BackgroundDefaultsStep({
  state, update, t,
}: {
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <section className="bg-wizard-step" data-testid="bg-wizard-step-defaults">
      <h3 className="bg-wizard-step-title">{t('step_defaults.title')}</h3>
      <p className="bg-wizard-step-body">{t('step_defaults.body')}</p>
      <div className="bg-wizard-toggle-list">
        <label className="bg-wizard-toggle">
          <input
            type="checkbox"
            checked={state.autostart}
            onChange={e => update({ autostart: e.target.checked })}
          />
          <div className="bg-wizard-toggle-text">
            <strong>{t('step_defaults.autostart_label')}</strong>
            <span className="bg-wizard-toggle-hint">{t('step_defaults.autostart_hint')}</span>
          </div>
        </label>
        <label className="bg-wizard-toggle">
          <input
            type="checkbox"
            checked={state.launchHidden}
            onChange={e => update({ launchHidden: e.target.checked })}
            disabled={!state.autostart}
          />
          <div className="bg-wizard-toggle-text">
            <strong>{t('step_defaults.launch_hidden_label')}</strong>
            <span className="bg-wizard-toggle-hint">{t('step_defaults.launch_hidden_hint')}</span>
          </div>
        </label>
      </div>
    </section>
  );
}

function QuietHoursStep({
  state, update, t,
}: {
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <section className="bg-wizard-step" data-testid="bg-wizard-step-quiet">
      <h3 className="bg-wizard-step-title">{t('step_quiet.title')}</h3>
      <p className="bg-wizard-step-body">{t('step_quiet.body')}</p>
      <label className="bg-wizard-toggle">
        <input
          type="checkbox"
          checked={state.quietHoursEnabled}
          onChange={e => update({ quietHoursEnabled: e.target.checked })}
        />
        <div className="bg-wizard-toggle-text">
          <strong>{t('step_quiet.enable_label')}</strong>
          <span className="bg-wizard-toggle-hint">{t('step_quiet.enable_hint')}</span>
        </div>
      </label>
      {state.quietHoursEnabled && (
        <div className="bg-wizard-time-row">
          <label className="bg-wizard-time-field">
            <span>{t('step_quiet.start_label')}</span>
            <input
              type="time"
              className="bg-wizard-input"
              value={state.quietHoursStart}
              onChange={e => update({ quietHoursStart: e.target.value })}
            />
          </label>
          <label className="bg-wizard-time-field">
            <span>{t('step_quiet.end_label')}</span>
            <input
              type="time"
              className="bg-wizard-input"
              value={state.quietHoursEnd}
              onChange={e => update({ quietHoursEnd: e.target.value })}
            />
          </label>
        </div>
      )}
    </section>
  );
}

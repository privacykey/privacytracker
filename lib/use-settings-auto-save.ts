'use client';

/**
 * Client hook that wraps a settings POST in a validate → POST → toast
 * lifecycle.
 *
 * Returns `{ save, error, saving }`:
 *   - `save(value)` POSTs and resolves to 'ok' | 'invalid' | 'error'
 *   - `error` is the latest sync-validation error (null when valid)
 *   - `saving` is true while a save is in flight
 *
 * Validation failures show an inline error (no toast). Success shows
 * a green pill; network/server failures show a red pill with reason.
 */

import { useCallback, useState } from 'react';
import { pushSettingsToast } from '../app/components/SettingsAutoSaveToast';

export type AutoSaveResult = 'ok' | 'invalid' | 'error';

export interface AutoSaveOptions<T> {
  /** Endpoint to POST to. */
  endpoint: string;
  /** Build the request body from the value. Defaults to `{ value }`. */
  buildBody?: (value: T) => unknown;
  /** Sync validator. Return `null` for valid, a string for the inline error. */
  validate?: (value: T) => string | null;
  /** Toast message on success. Defaults to "Saved". */
  successMessage?: string | ((value: T) => string);
  /** Optional Task Center label override. Falls back to `successMessage`. */
  taskLabel?: string | ((value: T) => string);
  /** HTTP method, defaults to POST. */
  method?: 'POST' | 'PATCH' | 'PUT';
  /** Optional callback fired after the toast. */
  onSaved?: (value: T, response: unknown) => void;
}

export function useSettingsAutoSave<T>(opts: AutoSaveOptions<T>) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    async (value: T): Promise<AutoSaveResult> => {
      // Validate up front — no toast on validation failures, inline only.
      if (opts.validate) {
        const v = opts.validate(value);
        if (v) {
          setError(v);
          return 'invalid';
        }
      }
      setError(null);

      setSaving(true);
      try {
        const body = opts.buildBody ? opts.buildBody(value) : { value };
        const res = await fetch(opts.endpoint, {
          method: opts.method ?? 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          // Surface server-supplied `{ error: "…" }` when present.
          let reason = `HTTP ${res.status}`;
          try {
            const parsed = JSON.parse(text) as { error?: string };
            if (parsed?.error) reason = parsed.error;
          } catch {
            if (text) reason = text.slice(0, 200);
          }
          pushSettingsToast({
            kind: 'error',
            message: `Couldn't save — ${reason}`,
            taskLabel: typeof opts.taskLabel === 'function' ? opts.taskLabel(value) : opts.taskLabel,
          });
          return 'error';
        }

        const responseBody = await res.json().catch(() => null);

        const successMsg =
          typeof opts.successMessage === 'function'
            ? opts.successMessage(value)
            : opts.successMessage ?? 'Saved';
        pushSettingsToast({
          kind: 'success',
          message: successMsg,
          taskLabel:
            typeof opts.taskLabel === 'function'
              ? opts.taskLabel(value)
              : opts.taskLabel,
        });

        opts.onSaved?.(value, responseBody);
        return 'ok';
      } catch (err) {
        // Network/transport failure — distinct from server-rejected.
        const reason = err instanceof Error ? err.message : 'connection';
        pushSettingsToast({
          kind: 'error',
          message: `Couldn't save — ${reason}`,
        });
        return 'error';
      } finally {
        setSaving(false);
      }
    },
    [opts],
  );

  return { save, error, saving, clearError: () => setError(null) };
}

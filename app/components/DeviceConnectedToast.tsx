'use client';

/**
 * Device-connect toast. Polls the Tauri-side `list_connected_devices`
 * command every 5s and surfaces a toast when a new ECID appears. Click →
 * /onboard?source=cfgutil&ecid=… which OnboardWizard already handles.
 *
 * No-ops on the web build (Tauri shim returns null) and on platforms
 * without Configurator (`cfgutilUnavailable: true` on the first poll
 * stops the loop). Dedup keyed by ECID against the previous poll.
 * Mounted on the Apps page only.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  isDesktop,
  listConnectedDevices,
  type ConnectedDevice,
} from '../../lib/desktop';

/** How often to ask the Rust side "what's plugged in right now?". */
const POLL_INTERVAL_MS = 5_000;

/** Map an Apple model identifier to a friendly emoji. Falls back to device
 *  class then a generic phone glyph. */
function deviceGlyph(d: ConnectedDevice): string {
  const cls = (d.deviceClass ?? '').toLowerCase();
  if (cls.includes('ipad')) return '📱';
  if (cls.includes('iphone')) return '📱';
  if (cls.includes('ipod')) return '🎵';
  if (cls.includes('watch')) return '⌚';
  // model-based fallback — some cfgutil revisions return lowercase model ids.
  const model = (d.model ?? '').toLowerCase();
  if (model.startsWith('ipad')) return '📱';
  if (model.startsWith('ipod')) return '🎵';
  if (model.startsWith('watch')) return '⌚';
  return '📱';
}

type ToastT = (key: string, values?: Record<string, string | number | Date>) => string;

/** "Aria's iPhone" → use the device's name when present, friendly fallback otherwise. */
function deviceDisplayName(t: ToastT, d: ConnectedDevice): string {
  if (d.name && d.name.trim()) return d.name.trim();
  if (d.model && d.model.trim()) return d.model.trim();
  if (d.deviceClass && d.deviceClass.trim()) return t('no_name_with_class', { cls: d.deviceClass.trim() });
  return t('no_name');
}

export default function DeviceConnectedToast() {
  const tToast = useTranslations('device_connect_toast');
  // At most one toast at a time even if multiple devices arrive in the
  // same poll — the user can repeat the action for each.
  const [pending, setPending] = useState<ConnectedDevice | null>(null);
  const [dismissedEcids, setDismissedEcids] = useState<Set<string>>(new Set());

  // Refs hold cross-poll state so the polling effect doesn't recreate
  // the timer on every change.
  const previousEcidsRef = useRef<Set<string>>(new Set());
  const stoppedRef = useRef<boolean>(false);

  const poll = useCallback(async () => {
    const result = await listConnectedDevices();
    if (!result) {
      // Not running in Tauri — bail out and never poll again.
      stoppedRef.current = true;
      return;
    }
    if (result.cfgutilUnavailable) {
      // Configurator not installed — quietly stop polling.
      stoppedRef.current = true;
      return;
    }

    const currentEcids = new Set(result.devices.map(d => d.ecid));

    // Drop the pending toast when its device disappears from the list.
    setPending(prev => (prev && !currentEcids.has(prev.ecid) ? null : prev));

    // Forget dismissals for devices that are no longer connected so a
    // plug → dismiss → unplug → re-plug sequence re-shows the toast.
    setDismissedEcids(prev => {
      const next = new Set<string>();
      for (const ecid of prev) {
        if (currentEcids.has(ecid)) next.add(ecid);
      }
      return next;
    });

    // The first poll establishes a baseline so a device that was already
    // plugged in when the app opened doesn't immediately fire a toast.
    const previous = previousEcidsRef.current;
    const isFirstPoll = previous.size === 0;
    if (!isFirstPoll) {
      for (const device of result.devices) {
        if (previous.has(device.ecid)) continue;
        if (dismissedEcids.has(device.ecid)) continue;
        // First fresh device wins; the next one promotes after dismissal.
        setPending(prev => prev ?? device);
        break;
      }
    }

    previousEcidsRef.current = currentEcids;
  }, [dismissedEcids]);

  useEffect(() => {
    if (!isDesktop()) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled || stoppedRef.current) return;
      await poll();
      if (cancelled || stoppedRef.current) return;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    // Kick off immediately so a device plugged in before navigating to
    // the Apps page is detected on first render. The first-poll baseline
    // suppresses toasts for already-connected ECIDs.
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [poll]);

  // Hidden in the web build so server-side renders match.
  if (!isDesktop() || !pending) return null;

  const dismiss = () => {
    setDismissedEcids(prev => {
      const next = new Set(prev);
      if (pending.ecid) next.add(pending.ecid);
      return next;
    });
    setPending(null);
  };

  const displayName = deviceDisplayName(tToast, pending);
  const glyph = deviceGlyph(pending);
  const subtitle = [
    pending.deviceClass,
    pending.iosVersion ? `iOS ${pending.iosVersion}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className="device-connect-toast"
      role="dialog"
      aria-live="polite"
      aria-label={tToast('aria_connected', { name: displayName })}
    >
      <div className="device-connect-toast-icon" aria-hidden="true">
        {glyph}
      </div>
      <div className="device-connect-toast-body">
        <div className="device-connect-toast-title">
          {tToast.rich('title_connected', {
            name: displayName,
            strong: chunks => <strong>{chunks}</strong>,
          })}
        </div>
        {subtitle && (
          <div className="device-connect-toast-sub">{subtitle}</div>
        )}
        <div className="device-connect-toast-help">
          {tToast('help')}
        </div>
      </div>
      <div className="device-connect-toast-actions">
        <Link
          href={{
            pathname: '/onboard',
            query: { source: 'cfgutil', ecid: pending.ecid },
          }}
          className="btn btn-primary btn-sm"
          onClick={dismiss}
        >
          {tToast('import_apps')}
        </Link>
        <button
          type="button"
          className="device-connect-toast-dismiss"
          onClick={dismiss}
          aria-label={tToast('dismiss_aria')}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

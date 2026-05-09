'use client';

/**
 * Inline rate-limit banner with live countdown and auto-retry.
 * Subscribes to `/api/rate-limit/status`, ticks a 1 Hz countdown
 * driven by the local clock, and fires `onResume` the moment the
 * cooldown elapses so the parent can re-issue its interrupted request.
 *
 * Manual "Retry now" calls DELETE on the status endpoint to zero the
 * cooldown server-side, then fires `onResume`. If Apple is still
 * rate-limiting, the parent's retry will get a fresh 429 and the
 * banner re-appears on the next poll.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RateLimitCategory } from '@/lib/rate-limit';

interface RateLimitSnapshot {
  category: RateLimitCategory;
  active: boolean;
  resumeAt: number;
  reason: string;
}

interface RateLimitStatusResponse {
  search: RateLimitSnapshot;
  scrape: RateLimitSnapshot;
  serverNow: number;
}

interface Props {
  /** Which Apple endpoint this surface relies on. */
  category: RateLimitCategory;
  /**
   * Called when the local countdown reaches 0 (timer elapsed or
   * "Retry now" clicked). Parent should re-issue whatever request the
   * 429 interrupted. The banner clears its visible state immediately
   * after firing.
   */
  onResume?: () => void;
  /** `inline` sits flush in a surface; `floating` adds shadow + margin. */
  variant?: 'inline' | 'floating';
  /** Polling cadence while cooldown is active. Defaults to 4500 ms. */
  pollIntervalMs?: number;
  /** If true, keep polling even when no cooldown is active. */
  pollWhenIdle?: boolean;
}

const HUMAN_LABEL: Record<RateLimitCategory, { title: string; what: string }> = {
  search: {
    title: 'Apple search service is throttled',
    what: 'Apple has rate-limited iTunes Search lookups from this app. New search results may be missing or stale until this clears.',
  },
  scrape: {
    title: 'Apple App Store is throttled',
    what: "Apple is temporarily blocking App Store page reads. Re-syncs and new imports can't fetch fresh privacy labels until this clears.",
  },
};

function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s.toString().padStart(2, '0')}s`;
}

export default function RateLimitBanner({
  category,
  onResume,
  variant = 'inline',
  pollIntervalMs = 4500,
  pollWhenIdle = false,
}: Props) {
  // null until first fetch — render nothing so we don't flash an empty banner.
  const [snapshot, setSnapshot] = useState<RateLimitSnapshot | null>(null);
  // Local-clock countdown, recomputed every second from snapshot.resumeAt.
  const [remainingMs, setRemainingMs] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Latch so we don't fire onResume twice per countdown.
  const resumedRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/rate-limit/status', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as RateLimitStatusResponse;
      const next = data[category];
      setSnapshot(next);
      if (next.active) {
        // Re-arm the resume latch when a fresh 429 lands during a countdown.
        resumedRef.current = false;
      }
    } catch {
      // Network failure is non-fatal — keep the previous snapshot.
    }
  }, [category]);

  // Initial fetch + interval. Polling only runs while a cooldown is
  // active unless `pollWhenIdle` is true.
  useEffect(() => {
    void fetchStatus();
    const isActive = snapshot?.active ?? false;
    if (!isActive && !pollWhenIdle) return;
    const id = setInterval(() => { void fetchStatus(); }, pollIntervalMs);
    return () => { clearInterval(id); };
    // snapshot.active retriggers this effect to start/stop the interval.
  }, [fetchStatus, snapshot?.active, pollIntervalMs, pollWhenIdle]);

  // Local 1 Hz countdown tick driven by snapshot.resumeAt.
  useEffect(() => {
    if (!snapshot?.active) return;
    const compute = () => {
      const ms = Math.max(0, snapshot.resumeAt - Date.now());
      setRemainingMs(ms);
      if (ms === 0 && !resumedRef.current) {
        resumedRef.current = true;
        // Hide the banner so the parent has a clean stage for retry.
        setSnapshot(prev => (prev ? { ...prev, active: false, resumeAt: 0, reason: '' } : prev));
        if (onResume) {
          // Defer one tick so React commits the hide before the parent retries.
          setTimeout(() => { onResume(); }, 0);
        }
      }
    };
    compute();
    const id = setInterval(compute, 1000);
    return () => { clearInterval(id); };
  }, [snapshot?.active, snapshot?.resumeAt, onResume]);

  const handleManualRetry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await fetch('/api/rate-limit/status', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      if (res.ok) {
        // Optimistically hide the banner; next poll confirms.
        resumedRef.current = true;
        setSnapshot(prev => (prev ? { ...prev, active: false, resumeAt: 0, reason: '' } : prev));
        if (onResume) onResume();
      }
    } catch {
      // Swallow — UI stays mounted, user can click again.
    } finally {
      setRetrying(false);
    }
  }, [category, onResume, retrying]);

  if (!snapshot || !snapshot.active) return null;

  const meta = HUMAN_LABEL[category];
  const className = `rate-limit-banner rate-limit-banner--${variant}`;

  return (
    <div className={className} role="status" aria-live="polite" data-rate-category={category}>
      <div className="rate-limit-banner-row">
        <span className="rate-limit-banner-icon" aria-hidden="true">⏳</span>
        <div className="rate-limit-banner-text">
          <div className="rate-limit-banner-title">{meta.title}</div>
          <div className="rate-limit-banner-sub">
            {meta.what}{' '}
            <span className="rate-limit-banner-countdown">
              Auto-retry in <strong>{formatCountdown(remainingMs)}</strong>.
            </span>
          </div>
        </div>
        <div className="rate-limit-banner-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void handleManualRetry()}
            disabled={retrying}
          >
            {retrying ? 'Retrying…' : 'Retry now'}
          </button>
        </div>
      </div>
      {snapshot.reason && (
        <div className="rate-limit-banner-details">
          <button
            type="button"
            className="link-button-inline"
            onClick={() => setShowDetails(d => !d)}
            aria-expanded={showDetails}
          >
            {showDetails ? 'Hide details' : 'Why is this happening?'}
          </button>
          {showDetails && (
            <div className="rate-limit-banner-reason">
              <p>
                Apple polices request volumes against their iTunes Search
                ({category === 'search' ? 'used here' : 'shared rolling-minute window'})
                and App Store endpoints. When the rolling-minute counter trips,
                further requests bounce until the window opens up again. We
                pace requests under Apple&rsquo;s ceiling, but burst usage
                (e.g. importing a long app list while a background sync runs)
                can still cross the line.
              </p>
              <p className="rate-limit-banner-reason-meta">
                <code>{snapshot.reason}</code>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

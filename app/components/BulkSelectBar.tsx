'use client';

/**
 * Bulk-select floating toolbar — appears below the AppGrid filter row
 * when Select mode is active and at least one app is checked. Drives the
 * `/api/verdicts/bulk` POST and surfaces a 30-second Undo toast on
 * success.
 *
 * Confirmation dialog kicks in above 10 apps to match the existing soft-
 * delete window pattern (`SOFT_DELETE_WINDOW_MS` = 30s in annotations).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { VerdictValue } from '../../lib/verdict-types';
// Co-located CSS — Turbopack hot-reloads small files reliably; appending
// to the 26k-line globals.css was leaving the bulk-select rules unbundled
// until a full dev-server restart.
import './bulk-select-bar.css';

interface BulkSelectBarProps {
  selectedIds: string[];
  visibleIds: string[];
  onSelectAll: () => void;
  onClear: () => void;
  onExit: () => void;
  /**
   * Reverse a bulk apply. The parent maintains `previousVerdicts`
   * (per-app verdict captured before the bulk write) so Undo can
   * restore the pre-apply state. Called with no args; parent handles
   * the per-app rewrite.
   */
  onUndoRequest?: (
    previous: Array<{ appId: string; verdict: VerdictValue | null }>,
  ) => Promise<void> | void;
  /**
   * Map of appId → existing user verdict at the moment Select mode was
   * entered. Used to compute the rollback set for Undo.
   */
  currentVerdicts: Record<string, VerdictValue>;
}

const CONFIRM_THRESHOLD = 10;
const UNDO_WINDOW_MS = 30_000;

export default function BulkSelectBar({
  selectedIds,
  visibleIds,
  onSelectAll,
  onClear,
  onExit,
  currentVerdicts,
}: BulkSelectBarProps) {
  const t = useTranslations('review_queue.select_mode');
  const tVerdict = useTranslations('verdict');
  const router = useRouter();
  const [pendingConfirm, setPendingConfirm] = useState<VerdictValue | null>(null);
  const [applying, setApplying] = useState(false);
  const [undo, setUndo] = useState<{
    verdict: VerdictValue;
    previous: Array<{ appId: string; verdict: VerdictValue | null }>;
  } | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  // Clean up the undo timer when the bar unmounts (mode exit, etc.).
  useEffect(() => () => {
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
  }, []);

  const apply = useCallback(
    async (verdict: VerdictValue) => {
      setApplying(true);
      const previous = selectedIds.map(id => ({
        appId: id,
        verdict: currentVerdicts[id] ?? null,
      }));
      try {
        const res = await fetch('/api/verdicts/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appIds: selectedIds, verdict }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Schedule undo window expiry.
        setUndo({ verdict, previous });
        if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
        undoTimerRef.current = window.setTimeout(() => setUndo(null), UNDO_WINDOW_MS);
        router.refresh();
        // Selection is preserved so the user can re-apply a different
        // verdict (or use Undo) without re-picking. Parent can call
        // `onClear()` to reset if desired.
      } catch (e) {
        console.warn('[BulkSelectBar] apply failed', e);
        alert(t('error_apply'));
      } finally {
        setApplying(false);
        setPendingConfirm(null);
      }
    },
    [currentVerdicts, router, selectedIds, t],
  );

  const handleMark = useCallback(
    (verdict: VerdictValue) => {
      if (selectedIds.length === 0) return;
      if (selectedIds.length > CONFIRM_THRESHOLD) {
        setPendingConfirm(verdict);
      } else {
        void apply(verdict);
      }
    },
    [apply, selectedIds.length],
  );

  const handleUndo = useCallback(async () => {
    if (!undo) return;
    const { previous } = undo;
    try {
      // Walk the previous list — per-app POST or DELETE to restore.
      await Promise.all(
        previous.map(p =>
          p.verdict
            ? fetch('/api/verdicts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appId: p.appId, verdict: p.verdict }),
              })
            : fetch(`/api/verdicts?appId=${encodeURIComponent(p.appId)}`, {
                method: 'DELETE',
              }),
        ),
      );
      router.refresh();
    } catch (e) {
      console.warn('[BulkSelectBar] undo failed', e);
    } finally {
      setUndo(null);
      if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    }
  }, [router, undo]);

  const hasSelection = selectedIds.length > 0;

  return (
    <>
      <div
        className={`bulk-select-bar ${hasSelection ? 'is-active' : 'is-empty'}`}
        role="region"
        aria-label={t('toolbar_label')}
      >
        {/* Top row: state-aware headline so the user always knows what
            the bar wants from them. Empty → invitation. Active →
            confirmation + a nudge toward the action buttons below. */}
        <div className="bulk-select-bar-headline">
          <span className="bulk-select-bar-icon" aria-hidden="true">
            {hasSelection ? '✓' : '☐'}
          </span>
          <span className="bulk-select-bar-title">
            {hasSelection
              ? t('headline_active', { count: selectedIds.length })
              : t('headline_empty')}
          </span>
          {/* The exit button hugs the right of the headline so it's
              always discoverable, regardless of selection state. */}
          <button
            type="button"
            className="bulk-select-bar-exit"
            onClick={onExit}
            disabled={applying}
            title={t('exit_title')}
            aria-label={t('exit')}
          >
            ✕
          </button>
        </div>

        {/* Action row: three large verdict buttons. When the selection
            is empty they read disabled (more muted than the default
            disabled style) so the eye is drawn back to the headline
            instructions above. */}
        <div className="bulk-select-bar-actions">
          <button
            type="button"
            className="bulk-select-action bulk-select-action-safe"
            disabled={!hasSelection || applying}
            onClick={() => handleMark('safe')}
          >
            <span className="bulk-select-action-icon" aria-hidden="true">✓</span>
            <span>{t('mark_safe')}</span>
          </button>
          <button
            type="button"
            className="bulk-select-action bulk-select-action-replace"
            disabled={!hasSelection || applying}
            onClick={() => handleMark('replace')}
          >
            <span className="bulk-select-action-icon" aria-hidden="true">↻</span>
            <span>{t('mark_replace')}</span>
          </button>
          <button
            type="button"
            className="bulk-select-action bulk-select-action-uninstall"
            disabled={!hasSelection || applying}
            onClick={() => handleMark('uninstall')}
          >
            <span className="bulk-select-action-icon" aria-hidden="true">🗑</span>
            <span>{t('mark_uninstall')}</span>
          </button>
        </div>

        {/* Footer row: secondary controls. Select-all is only useful
            when there's something to select; Clear only when something
            IS selected. Hiding the irrelevant one each time reduces
            visual noise without disabling-but-leaving-around. */}
        <div className="bulk-select-bar-footer">
          {!hasSelection && visibleIds.length > 0 && (
            <button type="button" className="bulk-select-bar-link" onClick={onSelectAll}>
              {t('select_all_n', { count: visibleIds.length })}
            </button>
          )}
          {hasSelection && (
            <button type="button" className="bulk-select-bar-link" onClick={onClear}>
              {t('clear')}
            </button>
          )}
          {hasSelection && (
            <span className="bulk-select-bar-hint" aria-hidden="true">
              {t('hint_active')}
            </span>
          )}
        </div>
      </div>

      {pendingConfirm && (
        <div className="modal-overlay" onClick={() => !applying && setPendingConfirm(null)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="modal-title">
              {t('confirm_title', { count: selectedIds.length })}
            </h2>
            <p className="modal-copy">
              {t('confirm_body', { verdict: tVerdict(`${pendingConfirm}_short`) })}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPendingConfirm(null)}
                disabled={applying}
              >
                {t('confirm_cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void apply(pendingConfirm)}
                disabled={applying}
                autoFocus
              >
                {t('confirm_apply')}
              </button>
            </div>
          </div>
        </div>
      )}

      {undo && (
        <div className="bulk-select-undo-toast" role="status">
          {t('applied', {
            count: undo.previous.length,
            verdict: tVerdict(`${undo.verdict}_short`),
          })}
          <button
            type="button"
            className="bulk-select-undo-toast-btn"
            onClick={() => void handleUndo()}
          >
            {t('undo')}
          </button>
        </div>
      )}
    </>
  );
}

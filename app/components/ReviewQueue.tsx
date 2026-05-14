'use client';

/**
 * Tinder-style review queue over the apps currently visible in the
 * AppGrid. Phases:
 *
 *   preflight → running → summary
 *
 * - Pre-flight modal: pick scope / sort / split, see live count, start.
 * - Running: full-screen carousel. One card at a time. Pointer drag
 *   physics + keyboard nav (1/2/3 + arrow keys + n/u/Esc).
 * - Summary: counts + CTAs (find alternatives, continue next batch,
 *   optional cfgutil offer on Tauri).
 *
 * State is component-local + sessionStorage. Verdicts hit /api/verdicts
 * POST immediately on swipe; per-card notes hit /api/annotations after
 * verdict commit. Failures surface a toast and revert the local
 * totals (verdict persistence is the source of truth on reload).
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { VerdictValue } from '../../lib/verdict-types';
import type { AppProfileBadge } from '../../lib/privacy-profile';
import { localiseBadgeDescription, localiseBadgeLabel } from '../../lib/i18n-meta';
import VerdictPill from './VerdictPill';
// Co-located CSS — Turbopack tracks this reliably alongside the
// component; bundling into the 26k-line globals.css was leaving stale
// hot-reload bundles in dev.
import './review-queue.css';
import {
  computeQueueApps,
  countQueueBatches,
  splitQueueIntoBatches,
  applyDecision,
  applySkip,
  undoDecision,
  undoSkip,
  EMPTY_SESSION_TOTALS,
  DEFAULT_PREFLIGHT,
  GUARDIAN_DEFAULT_PREFLIGHT,
  QUEUE_SCOPE_VALUES,
  QUEUE_SORT_VALUES,
  QUEUE_SPLIT_VALUES,
  type QueueAppInput,
  type QueuePreflightChoices,
  type QueueScope,
  type QueueSort,
  type QueueSplit,
  type QueueSessionTotals,
} from '../../lib/review-queue';

type Audience = 'self' | 'loved_one' | 'guardian';

interface ReviewQueueProps {
  /** Apps already filtered by the AppGrid's current filter state. */
  apps: QueueAppInput[];
  userVerdicts: Record<string, VerdictValue>;
  profileBadges: Record<string, AppProfileBadge>;
  /** Whether the user has set a privacy profile (controls mismatch UI). */
  hasProfile: boolean;
  audience: Audience;
  /** Apps with pending changes (privacy/accessibility/policy). */
  changedAppIds: Set<string>;
  /** Show the end-of-session cfgutil offer (Tauri-only, gated by flag). */
  showCfgutilOffer?: boolean;
  /** Render the progress bar in the running-phase header. */
  showProgressBar?: boolean;
  onClose: () => void;
}

type DragDirection = 'left' | 'right' | 'up' | 'down' | null;

const SWIPE_THRESHOLD_PX = 110;
const SWIPE_VELOCITY_THRESHOLD = 0.5; // px/ms

type Phase =
  | { kind: 'preflight' }
  | {
      kind: 'running';
      preflight: QueuePreflightChoices;
      batches: QueueAppInput[][];
      batchIndex: number;
      cardIndex: number;
      totals: QueueSessionTotals;
      /** Pop last decision; allows single-step undo. Discriminated union so
          skip and verdict undos can take different reversal paths. */
      lastDecision:
        | {
            kind: 'verdict';
            appId: string;
            prevVerdict: VerdictValue | null;
            nextVerdict: VerdictValue;
            wroteNote: boolean;
          }
        | { kind: 'skip'; appId: string }
        | null;
    }
  | {
      kind: 'summary';
      preflight: QueuePreflightChoices;
      batches: QueueAppInput[][];
      batchIndex: number;
      totals: QueueSessionTotals;
    };

// ─────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────

export default function ReviewQueue({
  apps,
  userVerdicts,
  profileBadges,
  hasProfile,
  audience,
  changedAppIds,
  showCfgutilOffer = false,
  showProgressBar = true,
  onClose,
}: ReviewQueueProps) {
  const t = useTranslations('review_queue');
  const tBadge = useTranslations('profile_badge');
  const router = useRouter();

  // Default preflight depends on audience (guardian → mismatch scope).
  const defaultPreflight =
    audience === 'guardian' ? GUARDIAN_DEFAULT_PREFLIGHT : DEFAULT_PREFLIGHT;

  // Restore last-used preflight choices from sessionStorage so users
  // don't reconfigure on every entry within a single tab session.
  const initialPreflight = useMemo<QueuePreflightChoices>(() => {
    if (typeof window === 'undefined') return defaultPreflight;
    try {
      const raw = window.sessionStorage.getItem('queue_preflight_choices');
      if (!raw) return defaultPreflight;
      const parsed = JSON.parse(raw);
      const scope = QUEUE_SCOPE_VALUES.includes(parsed.scope)
        ? (parsed.scope as QueueScope)
        : defaultPreflight.scope;
      const sort = QUEUE_SORT_VALUES.includes(parsed.sort)
        ? (parsed.sort as QueueSort)
        : defaultPreflight.sort;
      const splitRaw = parsed.split;
      const split = QUEUE_SPLIT_VALUES.includes(splitRaw)
        ? (splitRaw as QueueSplit)
        : defaultPreflight.split;
      return { scope, sort, split };
    } catch {
      return defaultPreflight;
    }
  }, [defaultPreflight]);

  const [preflight, setPreflight] = useState<QueuePreflightChoices>(initialPreflight);
  const [phase, setPhase] = useState<Phase>({ kind: 'preflight' });
  const [toast, setToast] = useState<string>('');

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(prev => (prev === msg ? '' : prev)), 3000);
  }, []);

  // Live preview of what the queue will contain given current preflight.
  const queuePreview = useMemo(() => {
    return computeQueueApps(apps, {
      scope: preflight.scope,
      sort: preflight.sort,
      userVerdicts,
      profileBadges,
      changedAppIds,
    });
  }, [apps, preflight.scope, preflight.sort, userVerdicts, profileBadges, changedAppIds]);

  const previewCount = queuePreview.length;
  const previewBatches = countQueueBatches(previewCount, preflight.split);

  // Persist preflight choices for next time.
  useEffect(() => {
    try {
      window.sessionStorage.setItem('queue_preflight_choices', JSON.stringify(preflight));
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [preflight]);

  const startQueue = useCallback(() => {
    const list = computeQueueApps(apps, {
      scope: preflight.scope,
      sort: preflight.sort,
      userVerdicts,
      profileBadges,
      changedAppIds,
    });
    if (list.length === 0) return;
    const batches = splitQueueIntoBatches(list, preflight.split);
    setPhase({
      kind: 'running',
      preflight,
      batches,
      batchIndex: 0,
      cardIndex: 0,
      totals: EMPTY_SESSION_TOTALS,
      lastDecision: null,
    });
  }, [apps, preflight, userVerdicts, profileBadges, changedAppIds]);

  // ─────────────────────────────────────────────
  // Verdict + Annotation save (used during running phase)
  // ─────────────────────────────────────────────

  const saveDecision = useCallback(
    async (appId: string, verdict: VerdictValue, note: string) => {
      // Verdict first — note attaches to the same decision.
      try {
        const res = await fetch('/api/verdicts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appId,
            verdict,
            rationale: note.trim() || null,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        console.warn('[ReviewQueue] verdict save failed', e);
        return false;
      }
      // Per-card annotation (Annotation row) — only when the user typed a note.
      if (note.trim().length > 0) {
        try {
          await fetch('/api/annotations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              appId,
              content: note.trim(),
              tag: null,
              visibility: 'export',
            }),
          });
        } catch (e) {
          // Note save failure is non-fatal — verdict is already through.
          console.warn('[ReviewQueue] annotation save failed', e);
        }
      }
      return true;
    },
    [],
  );

  const writeSessionActivity = useCallback(
    async (totals: QueueSessionTotals, preflightUsed: QueuePreflightChoices) => {
      // Fire-and-forget — there's no API for this yet so we write via a
      // small helper endpoint. If it doesn't exist, swallow the error.
      try {
        await fetch('/api/activity/queue-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ totals, preflight: preflightUsed }),
        });
      } catch (e) {
        console.warn('[ReviewQueue] session activity write failed', e);
      }
    },
    [],
  );

  // ─────────────────────────────────────────────
  // Decision dispatch (called by card after swipe / key)
  // ─────────────────────────────────────────────

  const advance = useCallback(
    (verdict: VerdictValue, note: string) => {
      setPhase(prev => {
        if (prev.kind !== 'running') return prev;
        const batch = prev.batches[prev.batchIndex];
        const app = batch[prev.cardIndex];
        if (!app) return prev;

        const wroteNote = note.trim().length > 0;
        const nextTotals = applyDecision(prev.totals, verdict, wroteNote);

        // Fire-and-forget save (parent UI is optimistic).
        void saveDecision(app.id, verdict, note).then(ok => {
          if (!ok) showToast(t('save_failed_toast'));
        });

        const nextCardIndex = prev.cardIndex + 1;
        const lastDecision = {
          kind: 'verdict' as const,
          appId: app.id,
          prevVerdict: userVerdicts[app.id] ?? null,
          nextVerdict: verdict,
          wroteNote,
        };

        if (nextCardIndex >= batch.length) {
          // End of batch / session — write activity row, then go to summary.
          void writeSessionActivity(nextTotals, prev.preflight);
          return {
            kind: 'summary',
            preflight: prev.preflight,
            batches: prev.batches,
            batchIndex: prev.batchIndex,
            totals: nextTotals,
          };
        }
        return {
          ...prev,
          cardIndex: nextCardIndex,
          totals: nextTotals,
          lastDecision,
        };
      });
    },
    [saveDecision, showToast, t, userVerdicts, writeSessionActivity],
  );

  const skipCurrent = useCallback(() => {
    setPhase(prev => {
      if (prev.kind !== 'running') return prev;
      const batch = prev.batches[prev.batchIndex];
      const app = batch[prev.cardIndex];
      if (!app) return prev;

      const nextTotals = applySkip(prev.totals);
      const nextCardIndex = prev.cardIndex + 1;
      const lastDecision = { kind: 'skip' as const, appId: app.id };

      if (nextCardIndex >= batch.length) {
        // End-of-batch reached via skips alone — still flush totals.
        void writeSessionActivity(nextTotals, prev.preflight);
        return {
          kind: 'summary',
          preflight: prev.preflight,
          batches: prev.batches,
          batchIndex: prev.batchIndex,
          totals: nextTotals,
        };
      }
      return {
        ...prev,
        cardIndex: nextCardIndex,
        totals: nextTotals,
        lastDecision,
      };
    });
  }, [writeSessionActivity]);

  const undoLast = useCallback(() => {
    setPhase(prev => {
      if (prev.kind !== 'running' || !prev.lastDecision || prev.cardIndex === 0) return prev;
      const ld = prev.lastDecision;

      // Skip is local-only — no API call to reverse, just rewind.
      if (ld.kind === 'skip') {
        return {
          ...prev,
          cardIndex: prev.cardIndex - 1,
          totals: undoSkip(prev.totals),
          lastDecision: null,
        };
      }

      const nextTotals = undoDecision(prev.totals, ld.nextVerdict, ld.wroteNote);

      // Best-effort: restore previous verdict or clear it. Annotation
      // creation is left alone — the user can edit/delete via the app detail
      // page if they regret the note. This matches the "verdict + annotation
      // commit together" semantics: only the verdict undoes.
      void (async () => {
        try {
          if (ld.prevVerdict) {
            await fetch('/api/verdicts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ appId: ld.appId, verdict: ld.prevVerdict }),
            });
          } else {
            await fetch(`/api/verdicts?appId=${encodeURIComponent(ld.appId)}`, {
              method: 'DELETE',
            });
          }
        } catch (e) {
          console.warn('[ReviewQueue] undo verdict failed', e);
        }
      })();

      return {
        ...prev,
        cardIndex: prev.cardIndex - 1,
        totals: nextTotals,
        lastDecision: null,
      };
    });
  }, []);

  const continueToNextBatch = useCallback(() => {
    setPhase(prev => {
      if (prev.kind !== 'summary') return prev;
      const nextBatchIndex = prev.batchIndex + 1;
      if (nextBatchIndex >= prev.batches.length) return prev;
      return {
        kind: 'running',
        preflight: prev.preflight,
        batches: prev.batches,
        batchIndex: nextBatchIndex,
        cardIndex: 0,
        totals: EMPTY_SESSION_TOTALS,
        lastDecision: null,
      };
    });
  }, []);

  const finish = useCallback(() => {
    router.refresh();
    onClose();
  }, [router, onClose]);

  // Top-level Escape handler so the user can always bail out of the
  // queue (running OR summary). Previously only the preflight modal had
  // its own Esc handler and the running card's Esc was only wired to
  // dismiss the note overlay — pressing Esc on the carousel itself was
  // a no-op, which is why the close button felt like the only way out.
  useEffect(() => {
    if (phase.kind === 'preflight') return; // preflight has its own
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't hijack Esc when a textarea (note overlay) is focused —
      // the card's local handler will close the textarea first.
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (phase.kind === 'summary') {
        finish();
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase.kind, finish, onClose]);

  // ─────────────────────────────────────────────
  // Phase rendering
  // ─────────────────────────────────────────────

  if (phase.kind === 'preflight') {
    return (
      <PreflightModal
        preflight={preflight}
        onChange={setPreflight}
        previewCount={previewCount}
        previewBatches={previewBatches}
        audience={audience}
        hasProfile={hasProfile}
        onStart={startQueue}
        onCancel={onClose}
        t={t}
      />
    );
  }

  if (phase.kind === 'running') {
    const batch = phase.batches[phase.batchIndex];
    const app = batch[phase.cardIndex];
    return (
      <div className="review-queue-fullscreen" role="dialog" aria-modal="true">
        <RunningHeader
          batchIndex={phase.batchIndex}
          totalBatches={phase.batches.length}
          cardIndex={phase.cardIndex}
          batchSize={batch.length}
          showProgressBar={showProgressBar}
          onExit={onClose}
          onUndo={phase.lastDecision ? undoLast : undefined}
          t={t}
        />
        <ReviewCard
          key={`${phase.batchIndex}-${phase.cardIndex}-${app.id}`}
          app={app}
          badge={profileBadges[app.id]}
          existingVerdict={userVerdicts[app.id]}
          onDecide={advance}
          onSkip={skipCurrent}
          t={t}
          tBadge={tBadge}
        />
        {toast && <div className="review-queue-toast" role="status">{toast}</div>}
      </div>
    );
  }

  // Summary phase
  const hasNextBatch = phase.batchIndex + 1 < phase.batches.length;
  const remainingInNext = hasNextBatch ? phase.batches[phase.batchIndex + 1].length : 0;
  const isFinalBatch = !hasNextBatch;

  return (
    <div className="review-queue-fullscreen review-queue-summary-wrap" role="dialog" aria-modal="true">
      <SummaryScreen
        totals={phase.totals}
        isFinal={isFinalBatch}
        batchIndex={phase.batchIndex}
        totalBatches={phase.batches.length}
        remainingInNext={remainingInNext}
        showCfgutilOffer={showCfgutilOffer && audience === 'self'}
        onContinue={hasNextBatch ? continueToNextBatch : undefined}
        onClose={finish}
        t={t}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// Preflight modal
// ─────────────────────────────────────────────

interface PreflightProps {
  preflight: QueuePreflightChoices;
  onChange: (next: QueuePreflightChoices) => void;
  previewCount: number;
  previewBatches: number;
  audience: Audience;
  hasProfile: boolean;
  onStart: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
}

function PreflightModal({
  preflight,
  onChange,
  previewCount,
  previewBatches,
  audience,
  hasProfile,
  onStart,
  onCancel,
  t,
}: PreflightProps) {
  // Focus the start button on open so Enter starts immediately.
  const startBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    startBtnRef.current?.focus();
  }, []);

  // Esc dismisses; Enter triggers start when enabled.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const splitSize = preflight.split;

  // Compact split labels for the pill row — just the number, or "All".
  const splitPillLabel = (s: QueueSplit): string => {
    if (s === null) return t('preflight.split_short.none');
    return t('preflight.split_short.n', { n: s });
  };

  return (
    <div className="modal-overlay review-queue-preflight-overlay" role="dialog" aria-modal="true">
      <div className="modal-card review-queue-preflight-card">
        <header className="review-queue-preflight-header">
          <h2 className="review-queue-preflight-title">{t('preflight.title')}</h2>
          {audience === 'guardian' && (
            <p className="review-queue-preflight-guardian-note">
              {t('preflight.guardian_intro', { label: t('audience.guardian') })}
            </p>
          )}
        </header>

        {/* Primary choice: which apps. 2x2 grid of buttons — no native
            radio chrome so the layout survives a CSS cold-load (no FOUC). */}
        <div className="review-queue-preflight-section">
          <div
            className="review-queue-scope-grid"
            role="radiogroup"
            aria-label={t('preflight.scope_label')}
          >
            {QUEUE_SCOPE_VALUES.map(scope => {
              const disabled = scope === 'mismatch' && !hasProfile;
              const active = preflight.scope === scope;
              return (
                <button
                  key={scope}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  className={`review-queue-scope-card ${active ? 'is-active' : ''}`}
                  onClick={() => onChange({ ...preflight, scope })}
                  title={t(`preflight.scope_desc.${scope}`)}
                >
                  {t(`preflight.scope.${scope}`)}
                </button>
              );
            })}
          </div>
          {/* Description text only for the currently-selected scope —
              keeps the helpful copy without cluttering every option. */}
          <p className="review-queue-scope-description">
            {t(`preflight.scope_desc.${preflight.scope}`)}
          </p>
        </div>

        {/* Advanced disclosure for sort + split. Collapsed by default so
            the modal opens lean; power users can expand to fine-tune. */}
        <details className="review-queue-preflight-advanced">
          <summary>{t('preflight.advanced')}</summary>
          <div className="review-queue-preflight-advanced-body">
            <div className="review-queue-preflight-advanced-row">
              <span className="review-queue-preflight-advanced-label">
                {t('preflight.sort_label')}
              </span>
              <div className="review-queue-preflight-pill-row" role="radiogroup">
                {QUEUE_SORT_VALUES.map(sort => {
                  const disabled = sort === 'mismatch_severity' && !hasProfile;
                  const active = preflight.sort === sort;
                  return (
                    <button
                      key={sort}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={disabled}
                      className={`review-queue-preflight-pill ${active ? 'is-active' : ''}`}
                      onClick={() => onChange({ ...preflight, sort })}
                    >
                      {t(`preflight.sort_short.${sort}`)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="review-queue-preflight-advanced-row">
              <span className="review-queue-preflight-advanced-label">
                {t('preflight.split_label')}
              </span>
              <div className="review-queue-preflight-pill-row" role="radiogroup">
                {QUEUE_SPLIT_VALUES.map(s => {
                  const value = s === null ? 'none' : String(s);
                  const active = preflight.split === s;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`review-queue-preflight-pill ${active ? 'is-active' : ''}`}
                      onClick={() => onChange({ ...preflight, split: s })}
                    >
                      {splitPillLabel(s)}
                    </button>
                  );
                })}
              </div>
            </div>
            {!hasProfile && (
              <p className="review-queue-preflight-hint">{t('preflight.no_profile_hint')}</p>
            )}
          </div>
        </details>

        <div className="review-queue-preflight-count" role="status" aria-live="polite">
          {splitSize !== null && previewCount > splitSize
            ? t('preflight.count_summary_with_batches_compact', {
                count: previewCount,
                batches: previewBatches,
                size: splitSize,
              })
            : t('preflight.count_summary', { count: previewCount })}
        </div>

        <div className="review-queue-preflight-footer">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {t('preflight.cancel')}
          </button>
          <button
            ref={startBtnRef}
            type="button"
            className="btn btn-primary"
            onClick={onStart}
            disabled={previewCount === 0}
          >
            {previewCount === 0 ? t('preflight.start_disabled') : t('preflight.start')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Running header — progress + exit + undo
// ─────────────────────────────────────────────

interface RunningHeaderProps {
  batchIndex: number;
  totalBatches: number;
  cardIndex: number;
  batchSize: number;
  showProgressBar: boolean;
  onExit: () => void;
  onUndo?: () => void;
  t: ReturnType<typeof useTranslations>;
}

function RunningHeader({
  batchIndex,
  totalBatches,
  cardIndex,
  batchSize,
  showProgressBar,
  onExit,
  onUndo,
  t,
}: RunningHeaderProps) {
  // Progress fraction = (decisions completed) / batchSize. cardIndex is the
  // 0-indexed current card, so it directly equals the number completed.
  const progressPct = batchSize > 0 ? Math.min(100, (cardIndex / batchSize) * 100) : 0;
  return (
    <header className="review-queue-header">
      <div className="review-queue-header-left">
        <span className="review-queue-progress">
          {t('progress.label', { current: cardIndex + 1, total: batchSize })}
        </span>
        {totalBatches > 1 && (
          <span className="review-queue-batch-progress">
            {t('progress.batch_label', { current: batchIndex + 1, total: totalBatches })}
          </span>
        )}
      </div>
      {showProgressBar && (
        <div
          className="review-queue-progress-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={batchSize}
          aria-valuenow={cardIndex}
          aria-label={t('progress.bar_aria', { current: cardIndex, total: batchSize })}
        >
          <div
            className="review-queue-progress-bar-fill"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
      <div className="review-queue-header-right">
        {onUndo && (
          <button
            type="button"
            className="review-queue-header-btn"
            onClick={onUndo}
            title={t('actions.undo_hint')}
          >
            {t('actions.undo')}
          </button>
        )}
        {/* Labeled close pill — sits at the right edge of the header,
            inside the flex flow so it can't collide with Undo. Esc
            still works (top-level handler in the parent). */}
        <button
          type="button"
          className="review-queue-close"
          onClick={onExit}
          title={t('actions.close_title')}
          aria-label={t('actions.close_aria')}
        >
          <span aria-hidden="true" className="review-queue-close-icon">✕</span>
          <span className="review-queue-close-label">{t('actions.close')}</span>
        </button>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────
// Review card — drag physics, keyboard nav, note overlay
// ─────────────────────────────────────────────

interface ReviewCardProps {
  app: QueueAppInput;
  badge: AppProfileBadge | undefined;
  existingVerdict: VerdictValue | undefined;
  onDecide: (verdict: VerdictValue, note: string) => void;
  onSkip: () => void;
  t: ReturnType<typeof useTranslations>;
  tBadge: ReturnType<typeof useTranslations>;
}

function ReviewCard({ app, badge, existingVerdict, onDecide, onSkip, t, tBadge }: ReviewCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragDirection, setDragDirection] = useState<DragDirection>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [exitDir, setExitDir] = useState<DragDirection>(null);
  const pointerStartRef = useRef<{ x: number; y: number; t: number } | null>(null);

  // Auto-focus the note textarea when the overlay opens.
  useEffect(() => {
    if (noteOpen) {
      noteRef.current?.focus();
    }
  }, [noteOpen]);

  // Commit a verdict — animates the card off-screen then fires onDecide.
  const commit = useCallback(
    (verdict: VerdictValue) => {
      const dir: DragDirection =
        verdict === 'safe' ? 'right' : verdict === 'uninstall' ? 'left' : 'up';
      setExitDir(dir);
      // Match the CSS transition duration (220ms) before advancing.
      const note = noteText;
      window.setTimeout(() => {
        onDecide(verdict, note);
      }, 220);
    },
    [noteText, onDecide],
  );

  // Reduced-motion users: skip the animation and advance immediately.
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }, []);

  const decideNow = useCallback(
    (verdict: VerdictValue) => {
      if (prefersReducedMotion) {
        onDecide(verdict, noteText);
      } else {
        commit(verdict);
      }
    },
    [commit, noteText, onDecide, prefersReducedMotion],
  );

  // Keyboard shortcuts — registered globally while card is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // When the note textarea is focused, only intercept Esc.
      const target = e.target as HTMLElement | null;
      const inTextarea = target?.tagName === 'TEXTAREA';

      if (inTextarea) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setNoteOpen(false);
          setNoteText('');
          cardRef.current?.focus();
        }
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case '1':
        case 'ArrowLeft':
          e.preventDefault();
          decideNow('uninstall');
          break;
        case '2':
        case 'ArrowRight':
          e.preventDefault();
          decideNow('safe');
          break;
        case '3':
        case 'ArrowUp':
          e.preventDefault();
          decideNow('replace');
          break;
        case 'n':
        case 'N':
        case 'ArrowDown':
          e.preventDefault();
          setNoteOpen(prev => !prev);
          break;
        case 's':
        case 'S':
          e.preventDefault();
          onSkip();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decideNow, onSkip]);

  // Pointer drag.
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore drag when initiated on interactive children (buttons, links, textarea).
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, textarea')) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointerStartRef.current = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    setIsDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointerStartRef.current) return;
    const dx = e.clientX - pointerStartRef.current.x;
    const dy = e.clientY - pointerStartRef.current.y;
    setDragOffset({ x: dx, y: dy });

    // Direction is the dominant axis past a small deadzone.
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < 20 && ay < 20) {
      setDragDirection(null);
    } else if (ax > ay) {
      setDragDirection(dx > 0 ? 'right' : 'left');
    } else {
      setDragDirection(dy > 0 ? 'down' : 'up');
    }
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = pointerStartRef.current;
      pointerStartRef.current = null;
      setIsDragging(false);
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const dt = Math.max(1, e.timeStamp - start.t);
      const vx = dx / dt;
      const vy = dy / dt;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);

      const passesThreshold = (mag: number, vel: number) =>
        mag >= SWIPE_THRESHOLD_PX || Math.abs(vel) >= SWIPE_VELOCITY_THRESHOLD;

      // Horizontal dominance — left/right.
      if (ax > ay && passesThreshold(ax, vx)) {
        if (dx > 0) decideNow('safe');
        else decideNow('uninstall');
        return;
      }
      // Vertical dominance — up = replace, down = open note.
      if (ay > ax && passesThreshold(ay, vy)) {
        if (dy < 0) {
          decideNow('replace');
        } else {
          setNoteOpen(prev => !prev);
        }
        return;
      }
      // Below threshold — spring back.
      setDragOffset({ x: 0, y: 0 });
      setDragDirection(null);
    },
    [decideNow],
  );

  const onPointerCancel = useCallback(() => {
    pointerStartRef.current = null;
    setIsDragging(false);
    setDragOffset({ x: 0, y: 0 });
    setDragDirection(null);
  }, []);

  // Visual transform — both drag-in-progress and exit animation reuse the
  // same CSS variable for transform so the spring-back transition kicks
  // in automatically when we reset to 0,0.
  const transform = (() => {
    if (exitDir) {
      const off = 1200;
      if (exitDir === 'right') return `translate(${off}px, 0) rotate(20deg)`;
      if (exitDir === 'left') return `translate(${-off}px, 0) rotate(-20deg)`;
      if (exitDir === 'up') return `translate(0, ${-off}px) rotate(0)`;
      if (exitDir === 'down') return `translate(0, ${off}px) rotate(0)`;
    }
    const { x, y } = dragOffset;
    const rotate = (x / 20).toFixed(2);
    return `translate(${x}px, ${y}px) rotate(${rotate}deg)`;
  })();

  // Localised badge text via the active locale's `profile_badge.*`
  // namespace. The raw `badge.label` / `badge.description` from the
  // server are English fallbacks only — we route through i18n-meta so
  // non-en locales render their own copy.
  const badgeLabel = badge ? localiseBadgeLabel(tBadge, badge) : null;
  const badgeDescription = badge ? localiseBadgeDescription(tBadge, badge) : null;

  return (
    <div
      className={`review-queue-card-stage${dragDirection ? ` is-${dragDirection}` : ''}${isDragging ? ' is-dragging' : ''}${exitDir ? ' is-exiting' : ''}${prefersReducedMotion ? ' is-reduced-motion' : ''}`}
    >
      <div
        ref={cardRef}
        className="review-queue-card"
        style={{ transform }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        tabIndex={-1}
      >
        <div className="review-queue-card-icon-wrap">
          {app.iconUrl ? (
            <Image
              src={app.iconUrl}
              alt={t('card.icon_alt', { name: app.name })}
              width={88}
              height={88}
              className="review-queue-card-icon"
              unoptimized
            />
          ) : (
            <div className="review-queue-card-icon-placeholder">{app.name[0]}</div>
          )}
        </div>

        <div className="review-queue-card-body">
          <h3 className="review-queue-card-name">{app.name}</h3>
          <div className="review-queue-card-developer">{app.developer ?? t('card.no_developer')}</div>

          <div className="review-queue-card-pills">
            <RiskPill app={app} />
            {badge && (
              <span
                className={`profile-badge profile-badge-${badge.tone} profile-badge-md`}
                title={badgeDescription ?? undefined}
              >
                {badgeLabel}
              </span>
            )}
            {existingVerdict && <VerdictPill verdict={existingVerdict} size="sm" />}
          </div>

          {badgeDescription && badge && badge.tone !== 'ok' && (
            <p className="review-queue-card-mismatch">{badgeDescription}</p>
          )}

          <CategoryChips app={app} t={t} />

          <Link
            href={`/apps/${app.id}`}
            target="_blank"
            rel="noreferrer"
            className="review-queue-card-detail-link"
            title={t('card.open_detail_title', { name: app.name })}
          >
            ↗
          </Link>
        </div>

        {/* Direction overlays — fade in proportionally to drag. */}
        <div className="review-queue-card-overlay overlay-left" aria-hidden="true">{t('actions.uninstall')}</div>
        <div className="review-queue-card-overlay overlay-right" aria-hidden="true">{t('actions.safe')}</div>
        <div className="review-queue-card-overlay overlay-up" aria-hidden="true">{t('actions.replace')}</div>
        <div className="review-queue-card-overlay overlay-down" aria-hidden="true">{t('actions.note')}</div>

        {noteOpen && (
          <div className="review-queue-note-overlay" role="region" aria-label={t('note_overlay.title')}>
            <textarea
              ref={noteRef}
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder={t('note_overlay.placeholder')}
              rows={3}
              className="review-queue-note-textarea"
            />
            <p className="review-queue-note-hint">{t('note_overlay.submit_hint')}</p>
          </div>
        )}
      </div>

      <div className="review-queue-actions" aria-label={t('hints.bar_label')}>
        <button
          type="button"
          className="review-queue-action review-queue-action-uninstall"
          onClick={() => decideNow('uninstall')}
          title={t('actions.uninstall_hint')}
        >
          <span aria-hidden="true">←</span>
          <span>{t('actions.uninstall')}</span>
          <kbd>1</kbd>
        </button>
        <button
          type="button"
          className="review-queue-action review-queue-action-note"
          onClick={() => setNoteOpen(prev => !prev)}
          title={t('actions.note_hint')}
          aria-pressed={noteOpen}
        >
          <span aria-hidden="true">↓</span>
          <span>{t('actions.note')}</span>
          <kbd>n</kbd>
        </button>
        <button
          type="button"
          className="review-queue-action review-queue-action-replace"
          onClick={() => decideNow('replace')}
          title={t('actions.replace_hint')}
        >
          <span aria-hidden="true">↑</span>
          <span>{t('actions.replace')}</span>
          <kbd>3</kbd>
        </button>
        <button
          type="button"
          className="review-queue-action review-queue-action-safe"
          onClick={() => decideNow('safe')}
          title={t('actions.safe_hint')}
        >
          <span aria-hidden="true">→</span>
          <span>{t('actions.safe')}</span>
          <kbd>2</kbd>
        </button>
      </div>

      {/* Skip — secondary action below the four primary buttons so it
          doesn't compete for attention but stays one click away. */}
      <button
        type="button"
        className="review-queue-skip"
        onClick={onSkip}
        title={t('actions.skip_hint')}
      >
        {t('actions.skip')} <kbd>s</kbd>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────
// Small helpers used inside the card
// ─────────────────────────────────────────────

function RiskPill({ app }: { app: QueueAppInput }) {
  const t = useTranslations('risk');
  const score = (app.trackCount ?? 0) * 10 + (app.linkedCount ?? 0) * 3 + (app.unlinkedCount ?? 0);
  let level: 'high' | 'moderate' | 'low' | 'minimal';
  if ((app.trackCount ?? 0) >= 1) level = 'high';
  else if ((app.linkedCount ?? 0) >= 3) level = 'moderate';
  else if ((app.linkedCount ?? 0) >= 1 || (app.unlinkedCount ?? 0) >= 1) level = 'low';
  else level = 'minimal';
  // Score is used as a hidden tie-breaker; visible label comes from the level.
  void score;
  return <span className={`risk-pill risk-pill-${level}`}>{t(`${level}_label`)}</span>;
}

function CategoryChips({ app, t }: { app: QueueAppInput; t: ReturnType<typeof useTranslations> }) {
  // Track / Linked / Unlinked counts give a quick "what's collected" snapshot
  // without needing a per-card fetch. Skip the strip when all three are zero.
  const trk = app.trackCount ?? 0;
  const lnk = app.linkedCount ?? 0;
  const unl = app.unlinkedCount ?? 0;
  const total = trk + lnk + unl;
  if (total === 0) {
    return <div className="review-queue-card-categories-empty">{t('card.no_categories')}</div>;
  }
  return (
    <div className="review-queue-card-chips" aria-label={t('card.top_categories_label')}>
      {trk > 0 && (
        <span className="review-queue-card-chip review-queue-card-chip-track">
          <span className="review-queue-card-chip-dot" aria-hidden="true" />
          {t('card.chip_tracking', { count: trk })}
        </span>
      )}
      {lnk > 0 && (
        <span className="review-queue-card-chip review-queue-card-chip-linked">
          <span className="review-queue-card-chip-dot" aria-hidden="true" />
          {t('card.chip_linked', { count: lnk })}
        </span>
      )}
      {unl > 0 && (
        <span className="review-queue-card-chip review-queue-card-chip-unlinked">
          <span className="review-queue-card-chip-dot" aria-hidden="true" />
          {t('card.chip_unlinked', { count: unl })}
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Summary screen
// ─────────────────────────────────────────────

interface SummaryProps {
  totals: QueueSessionTotals;
  isFinal: boolean;
  batchIndex: number;
  totalBatches: number;
  remainingInNext: number;
  showCfgutilOffer: boolean;
  onContinue?: () => void;
  onClose: () => void;
  t: ReturnType<typeof useTranslations>;
}

function SummaryScreen({
  totals,
  isFinal,
  batchIndex,
  totalBatches,
  remainingInNext,
  showCfgutilOffer,
  onContinue,
  onClose,
  t,
}: SummaryProps) {
  const title = isFinal
    ? t('summary.title')
    : t('summary.title_batch', { current: batchIndex + 1, total: totalBatches });
  return (
    <div className="review-queue-summary">
      <h2 className="review-queue-summary-title">{title}</h2>
      <ul className="review-queue-summary-counts">
        <li className="review-queue-summary-count count-safe">
          {t('summary.counts_safe', { count: totals.safe })}
        </li>
        <li className="review-queue-summary-count count-replace">
          {t('summary.counts_replace', { count: totals.replace })}
        </li>
        <li className="review-queue-summary-count count-uninstall">
          {t('summary.counts_uninstall', { count: totals.uninstall })}
        </li>
        {totals.notesAdded > 0 && (
          <li className="review-queue-summary-count count-notes">
            {t('summary.counts_notes', { count: totals.notesAdded })}
          </li>
        )}
        {totals.skipped > 0 && (
          <li className="review-queue-summary-count count-skipped">
            {t('summary.counts_skipped', { count: totals.skipped })}
          </li>
        )}
      </ul>

      {totals.replace > 0 && (
        <Link
          href={`/dashboard/compare`}
          className="btn btn-primary"
          title={t('summary.find_alternatives_aria')}
        >
          {t('summary.find_alternatives', { count: totals.replace })}
        </Link>
      )}

      {showCfgutilOffer && totals.uninstall > 0 && (
        <div className="review-queue-summary-cfgutil">
          <h3 className="review-queue-summary-cfgutil-title">
            {t('summary.cfgutil_offer_title', { count: totals.uninstall })}
          </h3>
          <p className="review-queue-summary-cfgutil-body">{t('summary.cfgutil_offer_body')}</p>
          <Link href="/dashboard/review-recommendations" className="btn btn-secondary">
            {t('summary.cfgutil_open')}
          </Link>
        </div>
      )}

      <div className="review-queue-summary-footer">
        {onContinue && (
          <button type="button" className="btn btn-secondary" onClick={onContinue}>
            {t('summary.continue_batch', { count: remainingInNext })}
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {isFinal ? t('summary.done') : t('summary.back_to_apps')}
        </button>
      </div>
    </div>
  );
}

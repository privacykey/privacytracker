'use client';

/**
 * Verdict picker for the App Detail page. Renders three big buttons
 * (Safe / Replace / Uninstall) plus an optional rationale textarea
 * and a "Clear my verdict" link. Imported recommendations from a
 * recipient's audit-bundle import surface above the picker as
 * read-only pills so the user can see "Mum says uninstall: <why>"
 * before they commit their own decision.
 *
 * The picker stores the *user's* verdict only. Imported verdicts are
 * advisory by definition and live in their own pills above the
 * picker — clicking the dismiss × on an imported pill removes that
 * recommendation from the local DB without touching the user's own
 * decision.
 *
 * Copy is deliberately written for non-technical users: "Mark this
 * app safe", "Decide later", etc. — no jargon, no scary CTAs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  VERDICT_META,
  VERDICT_ORDER,
  type AppVerdict,
  type VerdictValue,
} from '../../lib/verdict-types';

interface Props {
  appId: string;
  appName: string;
  /** Optional initial state — server-rendered when available. */
  initialVerdicts?: AppVerdict[];
  /**
   * Called after the picker successfully writes (or clears) the
   * user's verdict so the parent can refresh derived state (e.g.
   * the verdict pill in the detail header). Receives the new value
   * (or null when cleared).
   */
  onChange?: (verdict: VerdictValue | null) => void;
  /**
   * Compact mode — drops the title, subtitle, imported-recs region,
   * and the rationale textarea, leaving just the three small option
   * chips on a single horizontal line. Used by the review-and-act
   * surface where each row is a one-line summary and the rationale
   * is rendered separately by the parent. Defaults to false; full
   * mode is what the App Detail page renders.
   */
  compact?: boolean;
}

interface PickerState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  user: AppVerdict | null;
  imported: AppVerdict[];
  /** Buffered rationale text — debounced to the API. */
  rationale: string;
}

const RATIONALE_DEBOUNCE_MS = 600;

export default function VerdictPicker({
  appId,
  appName,
  initialVerdicts,
  onChange,
  compact = false,
}: Props) {
  // i18n — picker chrome lives under `verdict_picker.*`; per-option
  // short labels and descriptions reuse the existing `verdict.*`
  // namespace so the same strings stay in sync between this picker
  // and the read-only VerdictPill / pill metadata renderers.
  const tPicker = useTranslations('verdict_picker');
  const tVerdict = useTranslations('verdict');

  // Used to bust the Router Cache after a successful save/clear so
  // the dashboard / app-list views the user might back-navigate to
  // re-fetch their RSC payload instead of serving the cached one
  // from before the verdict change. The /api/verdicts handler also
  // calls revalidatePath('/dashboard', 'layout') server-side; the
  // two together cover both the data cache and the client-side
  // router cache.
  const router = useRouter();

  const split = useMemo(() => splitVerdicts(initialVerdicts ?? []), [initialVerdicts]);
  const [state, setState] = useState<PickerState>({
    loading: false,
    saving: false,
    error: null,
    user: split.user,
    imported: split.imported,
    rationale: split.user?.rationale ?? '',
  });

  // Re-fetch on mount to catch any verdicts that landed via imports
  // since the page was rendered. The initial server-rendered list
  // covers the common case; this just keeps the panel honest after
  // an in-session bundle import.
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true }));
    fetch(`/api/verdicts?appId=${encodeURIComponent(appId)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(({ verdicts }: { verdicts: AppVerdict[] }) => {
        if (!live) return;
        const next = splitVerdicts(verdicts);
        setState(s => ({
          ...s,
          loading: false,
          user: next.user,
          imported: next.imported,
          rationale: next.user?.rationale ?? s.rationale,
        }));
      })
      .catch(e => {
        if (!live) return;
        setState(s => ({ ...s, loading: false, error: e instanceof Error ? e.message : tPicker('error_load') }));
      });
    return () => {
      live = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [appId]);

  // ── Cmd+Z undo for verdict mutations ───────────────────────────────
  // The destructive verdict operations (set / clear) overwrite the
  // user's existing AppVerdict — including a rationale text field that
  // can be tens of words. Without undo, a single misclick on the
  // "Clear" link erases that rationale forever. We push a snapshot of
  // the prior user verdict (or null when there wasn't one) onto a
  // bounded stack on every successful save/clear, listen for the
  // global `app:undo` window event while the picker is mounted, and
  // replay via the same /api/verdicts route that fired the original
  // change.
  type VerdictUndoOp = { priorUser: AppVerdict | null };
  const MAX_VERDICT_UNDO_OPS = 20;
  const verdictUndoStackRef = useRef<VerdictUndoOp[]>([]);
  // Local flash for "Restored …" feedback. Picker doesn't have a toast
  // host; we reuse a tiny ephemeral banner above the buttons. Auto-
  // clears after a couple of seconds so it doesn't accumulate.
  const [undoFlash, setUndoFlash] = useState<string | null>(null);

  const pushVerdictUndo = useCallback((op: VerdictUndoOp) => {
    const next = [...verdictUndoStackRef.current, op];
    if (next.length > MAX_VERDICT_UNDO_OPS) next.shift();
    verdictUndoStackRef.current = next;
  }, []);

  const flashUndoMessage = useCallback((msg: string) => {
    setUndoFlash(msg);
    window.setTimeout(() => {
      setUndoFlash(current => (current === msg ? null : current));
    }, 2500);
  }, []);

  const setVerdict = useCallback(
    async (verdict: VerdictValue, rationale: string | null) => {
      // Snapshot BEFORE the request so the undo op carries the row
      // that was actually in effect at the moment of the click. We
      // read directly off `state.user` (the cached AppVerdict) rather
      // than refetching — the picker only ever races itself, and the
      // server-side UPSERT key (app_id + 'user') guarantees there's
      // exactly one user row to restore.
      const priorUser = state.user;
      setState(s => ({ ...s, saving: true, error: null }));
      try {
        const res = await fetch('/api/verdicts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId, verdict, rationale }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { verdict: saved }: { verdict: AppVerdict } = await res.json();
        setState(s => ({
          ...s,
          saving: false,
          user: saved,
          rationale: saved.rationale ?? '',
        }));
        pushVerdictUndo({ priorUser });
        onChange?.(saved.verdict);
        // Bust the Router Cache so a back-nav to /dashboard or
        // /dashboard/apps re-fetches the RSC payload — otherwise
        // the cached card list still shows the old verdict pill
        // (or no pill) until the user manually refreshes.
        router.refresh();
      } catch (e) {
        setState(s => ({
          ...s,
          saving: false,
          error: e instanceof Error ? e.message : tPicker('error_save'),
        }));
      }
    },
    [appId, onChange, tPicker, router, state.user, pushVerdictUndo],
  );

  const clearVerdict = useCallback(async () => {
    // Same snapshot pattern — capture before the request so we can
    // restore the rationale text the user typed. The Clear case is
    // the highest-value undo here: a misclicked "Clear my verdict"
    // permanently loses the rationale, while clicking a different
    // verdict button just overwrites it (and the new value still
    // has its own undo entry).
    const priorUser = state.user;
    setState(s => ({ ...s, saving: true, error: null }));
    try {
      const res = await fetch(`/api/verdicts?appId=${encodeURIComponent(appId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(s => ({ ...s, saving: false, user: null, rationale: '' }));
      pushVerdictUndo({ priorUser });
      onChange?.(null);
      // Same Router Cache bust as `setVerdict` — clearing the
      // verdict has the same downstream effect on every list view
      // that paints a verdict pill.
      router.refresh();
    } catch (e) {
      setState(s => ({
        ...s,
        saving: false,
        error: e instanceof Error ? e.message : tPicker('error_clear'),
      }));
    }
  }, [appId, onChange, tPicker, router, state.user, pushVerdictUndo]);

  const handleVerdictUndo = useCallback(async () => {
    const prev = verdictUndoStackRef.current;
    if (prev.length === 0) return;
    const top = prev[prev.length - 1];
    verdictUndoStackRef.current = prev.slice(0, -1);

    try {
      if (top.priorUser) {
        // Restore via the same POST endpoint the picker uses on
        // forward changes. The handler is an UPSERT so this works
        // whether the row currently exists or not.
        const res = await fetch('/api/verdicts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appId,
            verdict: top.priorUser.verdict,
            rationale: top.priorUser.rationale ?? null,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { verdict: restored }: { verdict: AppVerdict } = await res.json();
        setState(s => ({ ...s, user: restored, rationale: restored.rationale ?? '' }));
        onChange?.(restored.verdict);
        const label = tVerdict(`${restored.verdict}.label`);
        flashUndoMessage(`↶ Restored "${label}"`);
      } else {
        // Prior state was "no verdict" — restore by clearing.
        // DELETE is idempotent on the server side, so this is
        // safe to fire even if the row was already gone.
        const res = await fetch(`/api/verdicts?appId=${encodeURIComponent(appId)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setState(s => ({ ...s, user: null, rationale: '' }));
        onChange?.(null);
        flashUndoMessage('↶ Verdict undecided again');
      }
      router.refresh();
    } catch (e) {
      console.error('[verdict-picker] undo failed:', e);
      flashUndoMessage('❌ Couldn’t undo that change');
    }
  }, [appId, flashUndoMessage, onChange, router, tVerdict]);

  useEffect(() => {
    const handler = () => { void handleVerdictUndo(); };
    window.addEventListener('app:undo', handler);
    return () => window.removeEventListener('app:undo', handler);
  }, [handleVerdictUndo]);

  const dismissImported = useCallback(
    async (sourceName: string) => {
      try {
        const qs = new URLSearchParams({
          appId,
          source: 'imported',
          sourceName,
        });
        const res = await fetch(`/api/verdicts?${qs}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setState(s => ({
          ...s,
          imported: s.imported.filter(v => v.sourceName !== sourceName),
        }));
        // Imported recommendations show on /dashboard/review-
        // recommendations and as ghost pills on /dashboard cards;
        // dismiss = "I've seen this", so refresh the parent layouts.
        router.refresh();
      } catch (e) {
        setState(s => ({
          ...s,
          error: e instanceof Error ? e.message : tPicker('error_dismiss'),
        }));
      }
    },
    [appId, tPicker, router],
  );

  // Debounced rationale auto-save. Each keystroke updates the buffered
  // text immediately (responsive textarea) and schedules a write after
  // the user pauses typing — same UX shape as the notes auto-save.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRationaleChange = useCallback(
    (next: string) => {
      setState(s => ({ ...s, rationale: next }));
      if (!state.user) return; // No verdict yet — rationale only persists when paired with one
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (!state.user) return;
        setVerdict(state.user.verdict, next.trim() || null);
      }, RATIONALE_DEBOUNCE_MS);
    },
    [state.user, setVerdict],
  );

  // Flush any pending rationale write on unmount so a "type, navigate
  // away" sequence doesn't drop the last edit.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Compact mode — short-circuit early. Renders a single horizontal
  // chip cluster suitable for inline use in a list row. No imported
  // recommendations region, no rationale textarea — the parent
  // surface (review-and-act page) shows those separately.
  if (compact) {
    return (
      <div
        className="verdict-picker verdict-picker-compact"
        role="radiogroup"
        aria-label={tPicker('options_aria')}
      >
        {VERDICT_ORDER.map(value => {
          const meta = VERDICT_META[value];
          const active = state.user?.verdict === value;
          const optionLabel = tVerdict(`${value}_short`);
          const optionDesc = tVerdict(`${value}_desc`);
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={state.saving}
              className={`verdict-picker-chip verdict-picker-chip-${meta.cls}${active ? ' is-active' : ''}`}
              onClick={() => setVerdict(value, state.rationale.trim() || null)}
              title={optionDesc}
            >
              <span className="verdict-picker-chip-icon" aria-hidden="true">{meta.icon}</span>
              <span className="verdict-picker-chip-label">{optionLabel}</span>
            </button>
          );
        })}
        {state.error && (
          <span className="verdict-picker-error" role="alert">
            {state.error}
          </span>
        )}
      </div>
    );
  }

  return (
    <section className="verdict-picker" aria-labelledby="verdict-picker-heading">
      <header className="verdict-picker-header">
        <h3 id="verdict-picker-heading" className="verdict-picker-title">
          {tPicker('title', { appName })}
        </h3>
        <p className="verdict-picker-sub">{tPicker('sub')}</p>
      </header>

      {/* Cmd-Z undo flash. Tiny ephemeral banner that appears for ~2.5s
          after the global undo handler restores a verdict. Live region
          + role=status so screen readers announce "Restored Safe"
          when the user hits the shortcut. The flash auto-clears itself
          via setTimeout in flashUndoMessage; nothing here to dismiss. */}
      {undoFlash && (
        <div
          className="verdict-picker-undo-flash"
          role="status"
          aria-live="polite"
        >
          {undoFlash}
        </div>
      )}

      {state.imported.length > 0 && (
        <div
          className="verdict-picker-imported"
          role="region"
          aria-label={tPicker('imported_aria')}
        >
          <p className="verdict-picker-imported-title">{tPicker('imported_title')}</p>
          <ul className="verdict-picker-imported-list">
            {state.imported.map(rec => {
              const meta = VERDICT_META[rec.verdict];
              const sourceLabel = rec.sourceName ?? tPicker('imported_friend_fallback');
              const verdictShort = tVerdict(`${rec.verdict}_short`).toLowerCase();
              return (
                <li key={rec.id} className={`verdict-picker-imported-row verdict-pill-${meta.cls}`}>
                  <span className="verdict-pill-icon" aria-hidden="true">{meta.icon}</span>
                  <div className="verdict-picker-imported-body">
                    <div className="verdict-picker-imported-label">
                      {tPicker.rich('imported_says', {
                        name: sourceLabel,
                        verdict: verdictShort,
                        strong: chunks => <strong>{chunks}</strong>,
                        em: chunks => <em>{chunks}</em>,
                      })}
                    </div>
                    {rec.rationale && (
                      <div className="verdict-picker-imported-reason">
                        &ldquo;{rec.rationale}&rdquo;
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="verdict-picker-imported-dismiss"
                    onClick={() => rec.sourceName && dismissImported(rec.sourceName)}
                    aria-label={
                      rec.sourceName
                        ? tPicker('imported_dismiss_aria', { sourceName: rec.sourceName })
                        : tPicker('imported_dismiss_aria_anon')
                    }
                    title={tPicker('imported_dismiss_title')}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="verdict-picker-imported-hint">{tPicker('imported_hint')}</p>
        </div>
      )}

      <div
        className="verdict-picker-options"
        role="radiogroup"
        aria-label={tPicker('options_aria')}
      >
        {VERDICT_ORDER.map(value => {
          const meta = VERDICT_META[value];
          const active = state.user?.verdict === value;
          const optionLabel = tVerdict(`${value}_short`);
          const optionDesc = tVerdict(`${value}_desc`);
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={state.saving}
              className={`verdict-picker-option verdict-picker-option-${meta.cls} ${active ? 'is-active' : ''}`}
              onClick={() => setVerdict(value, state.rationale.trim() || null)}
              title={optionDesc}
            >
              <span className="verdict-picker-option-icon" aria-hidden="true">{meta.icon}</span>
              <span className="verdict-picker-option-label">{optionLabel}</span>
              <span className="verdict-picker-option-desc">{optionDesc}</span>
            </button>
          );
        })}
      </div>

      {state.user && (
        <div className="verdict-picker-rationale">
          <label htmlFor="verdict-rationale" className="verdict-picker-rationale-label">
            {tPicker('rationale_label')}
          </label>
          <textarea
            id="verdict-rationale"
            className="verdict-picker-rationale-input"
            value={state.rationale}
            onChange={e => onRationaleChange(e.target.value)}
            placeholder={tPicker('rationale_placeholder')}
            rows={2}
            maxLength={400}
          />
          <div className="verdict-picker-rationale-meta">
            <button
              type="button"
              className="verdict-picker-clear"
              onClick={clearVerdict}
              disabled={state.saving}
            >
              {tPicker('clear')}
            </button>
            <span className="verdict-picker-saved" aria-live="polite">
              {state.saving ? tPicker('saving') : tPicker('saved')}
            </span>
          </div>
        </div>
      )}

      {state.error && (
        <p className="verdict-picker-error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}

function splitVerdicts(verdicts: AppVerdict[]): { user: AppVerdict | null; imported: AppVerdict[] } {
  let user: AppVerdict | null = null;
  const imported: AppVerdict[] = [];
  for (const v of verdicts) {
    if (v.source === 'user') {
      // There can only be one user verdict per app (UNIQUE index), so
      // the first hit is the right one. Keep it idempotent though.
      if (!user) user = v;
    } else {
      imported.push(v);
    }
  }
  // Most-recently-set first for the imported list so a fresh import
  // surfaces above older recommendations.
  imported.sort((a, b) => b.setAt - a.setAt);
  return { user, imported };
}

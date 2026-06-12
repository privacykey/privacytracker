"use client";

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

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  rovingTabIndex,
  useRovingRadioGroup,
} from "../../lib/use-roving-radiogroup";
import {
  type AppVerdict,
  VERDICT_META,
  VERDICT_ORDER,
  type VerdictValue,
} from "../../lib/verdict-types";

interface Props {
  appId: string;
  appName: string;
  /**
   * Compact mode — drops the title, subtitle, imported-recs region,
   * and the rationale textarea, leaving just the three small option
   * chips on a single horizontal line. Used by the review-and-act
   * surface where each row is a one-line summary and the rationale
   * is rendered separately by the parent. Defaults to false; full
   * mode is what the App Detail page renders.
   */
  compact?: boolean;
  /** Optional initial state — server-rendered when available. */
  initialVerdicts?: AppVerdict[];
  /**
   * Called after the picker successfully writes (or clears) the
   * user's verdict so the parent can refresh derived state (e.g.
   * the verdict pill in the detail header). Receives the new value
   * (or null when cleared).
   */
  onChange?: (verdict: VerdictValue | null) => void;
}

interface PickerState {
  error: string | null;
  imported: AppVerdict[];
  loading: boolean;
  /** Buffered rationale text — debounced to the API. */
  rationale: string;
  saving: boolean;
  user: AppVerdict | null;
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
  const tPicker = useTranslations("verdict_picker");
  const tVerdict = useTranslations("verdict");

  // Used to bust the Router Cache after a successful save/clear so
  // the dashboard / app-list views the user might back-navigate to
  // re-fetch their RSC payload instead of serving the cached one
  // from before the verdict change. The /api/verdicts handler also
  // calls revalidatePath('/dashboard', 'layout') server-side; the
  // two together cover both the data cache and the client-side
  // router cache.
  const router = useRouter();

  const split = useMemo(
    () => splitVerdicts(initialVerdicts ?? []),
    [initialVerdicts]
  );
  const [state, setState] = useState<PickerState>({
    loading: false,
    saving: false,
    error: null,
    user: split.user,
    imported: split.imported,
    rationale: split.user?.rationale ?? "",
  });

  // Two-stage editing flow:
  //   1. `picker` step — the three big verdict buttons. Used when no verdict
  //      exists yet, or when the user hits "Change my decision" to switch.
  //   2. `reason` step — entered automatically after a verdict is saved (and
  //      via Edit from the summary). Compact chosen-verdict header + a
  //      prominent "Why?" rationale textarea + Done. Done collapses to the
  //      summary view.
  // Falls back to the summary view (compact pill + Edit) when state.user is
  // set and the picker isn't being edited.
  type EditStep = "picker" | "reason";
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<EditStep>("picker");

  // Roving-tabindex keyboard support for both radiogroups (compact
  // chips + full picker). `followFocus: false` — selecting a verdict
  // writes to the server, pushes an undo entry, and (in full mode)
  // swaps the picker for the rationale step, so arrows move focus
  // only and Enter/Space commits (the APG variant for radios whose
  // selection has significant side effects).
  const verdictRadioKeyDown = useRovingRadioGroup({ followFocus: false });

  const showSummary = !!state.user && !editing;
  const showReason = !!state.user && editing && step === "reason";
  // showPicker is implicit — falls through when neither summary nor reason
  // matches (no verdict yet, or the user clicked "Change my decision").

  // Re-fetch on mount to catch any verdicts that landed via imports
  // since the page was rendered. The initial server-rendered list
  // covers the common case; this just keeps the panel honest after
  // an in-session bundle import.
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fetch(`/api/verdicts?appId=${encodeURIComponent(appId)}`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then(({ verdicts }: { verdicts: AppVerdict[] }) => {
        if (!live) {
          return;
        }
        const next = splitVerdicts(verdicts);
        setState((s) => ({
          ...s,
          loading: false,
          user: next.user,
          imported: next.imported,
          rationale: next.user?.rationale ?? s.rationale,
        }));
      })
      .catch((e) => {
        if (!live) {
          return;
        }
        setState((s) => ({
          ...s,
          loading: false,
          error: e instanceof Error ? e.message : tPicker("error_load"),
        }));
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
  interface VerdictUndoOp {
    priorUser: AppVerdict | null;
  }
  const MAX_VERDICT_UNDO_OPS = 20;
  const verdictUndoStackRef = useRef<VerdictUndoOp[]>([]);
  // Local flash for "Restored …" feedback. Picker doesn't have a toast
  // host; we reuse a tiny ephemeral banner above the buttons. Auto-
  // clears after a couple of seconds so it doesn't accumulate.
  const [undoFlash, setUndoFlash] = useState<string | null>(null);

  const pushVerdictUndo = useCallback((op: VerdictUndoOp) => {
    const next = [...verdictUndoStackRef.current, op];
    if (next.length > MAX_VERDICT_UNDO_OPS) {
      next.shift();
    }
    verdictUndoStackRef.current = next;
  }, []);

  const flashUndoMessage = useCallback((msg: string) => {
    setUndoFlash(msg);
    window.setTimeout(() => {
      setUndoFlash((current) => (current === msg ? null : current));
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
      setState((s) => ({ ...s, saving: true, error: null }));
      try {
        const res = await fetch("/api/verdicts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId, verdict, rationale }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const { verdict: saved }: { verdict: AppVerdict } = await res.json();
        setState((s) => ({
          ...s,
          saving: false,
          user: saved,
          rationale: saved.rationale ?? "",
        }));
        // After a successful save, step into the rationale stage so the
        // user can add a reason without losing focus. Done collapses the
        // whole panel; users who don't want to write anything can click
        // Done immediately. Avoids the prior auto-collapse that hid the
        // rationale field as soon as a verdict was picked.
        setEditing(true);
        setStep("reason");
        pushVerdictUndo({ priorUser });
        onChange?.(saved.verdict);
        // Bust the Router Cache so a back-nav to /dashboard or
        // /dashboard/apps re-fetches the RSC payload — otherwise
        // the cached card list still shows the old verdict pill
        // (or no pill) until the user manually refreshes.
        router.refresh();
      } catch (e) {
        setState((s) => ({
          ...s,
          saving: false,
          error: e instanceof Error ? e.message : tPicker("error_save"),
        }));
      }
    },
    [appId, onChange, tPicker, router, state.user, pushVerdictUndo]
  );

  const clearVerdict = useCallback(async () => {
    // Same snapshot pattern — capture before the request so we can
    // restore the rationale text the user typed. The Clear case is
    // the highest-value undo here: a misclicked "Clear my verdict"
    // permanently loses the rationale, while clicking a different
    // verdict button just overwrites it (and the new value still
    // has its own undo entry).
    const priorUser = state.user;
    setState((s) => ({ ...s, saving: true, error: null }));
    try {
      const res = await fetch(
        `/api/verdicts?appId=${encodeURIComponent(appId)}`,
        {
          method: "DELETE",
        }
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setState((s) => ({ ...s, saving: false, user: null, rationale: "" }));
      pushVerdictUndo({ priorUser });
      onChange?.(null);
      // Same Router Cache bust as `setVerdict` — clearing the
      // verdict has the same downstream effect on every list view
      // that paints a verdict pill.
      router.refresh();
    } catch (e) {
      setState((s) => ({
        ...s,
        saving: false,
        error: e instanceof Error ? e.message : tPicker("error_clear"),
      }));
    }
  }, [appId, onChange, tPicker, router, state.user, pushVerdictUndo]);

  const handleVerdictUndo = useCallback(async () => {
    const prev = verdictUndoStackRef.current;
    if (prev.length === 0) {
      return;
    }
    const top = prev[prev.length - 1];
    verdictUndoStackRef.current = prev.slice(0, -1);

    try {
      if (top.priorUser) {
        // Restore via the same POST endpoint the picker uses on
        // forward changes. The handler is an UPSERT so this works
        // whether the row currently exists or not.
        const res = await fetch("/api/verdicts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appId,
            verdict: top.priorUser.verdict,
            rationale: top.priorUser.rationale ?? null,
          }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const { verdict: restored }: { verdict: AppVerdict } = await res.json();
        setState((s) => ({
          ...s,
          user: restored,
          rationale: restored.rationale ?? "",
        }));
        onChange?.(restored.verdict);
        const label = tVerdict(`${restored.verdict}.label`);
        flashUndoMessage(`↶ Restored "${label}"`);
      } else {
        // Prior state was "no verdict" — restore by clearing.
        // DELETE is idempotent on the server side, so this is
        // safe to fire even if the row was already gone.
        const res = await fetch(
          `/api/verdicts?appId=${encodeURIComponent(appId)}`,
          {
            method: "DELETE",
          }
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        setState((s) => ({ ...s, user: null, rationale: "" }));
        onChange?.(null);
        flashUndoMessage("↶ Verdict undecided again");
      }
      router.refresh();
    } catch (e) {
      console.error("[verdict-picker] undo failed:", e);
      flashUndoMessage("❌ Couldn’t undo that change");
    }
  }, [appId, flashUndoMessage, onChange, router, tVerdict]);

  useEffect(() => {
    const handler = () => {
      void handleVerdictUndo();
    };
    window.addEventListener("app:undo", handler);
    return () => window.removeEventListener("app:undo", handler);
  }, [handleVerdictUndo]);

  const dismissImported = useCallback(
    async (sourceName: string) => {
      try {
        const qs = new URLSearchParams({
          appId,
          source: "imported",
          sourceName,
        });
        const res = await fetch(`/api/verdicts?${qs}`, { method: "DELETE" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        setState((s) => ({
          ...s,
          imported: s.imported.filter((v) => v.sourceName !== sourceName),
        }));
        // Imported recommendations show on /dashboard/review-
        // recommendations and as ghost pills on /dashboard cards;
        // dismiss = "I've seen this", so refresh the parent layouts.
        router.refresh();
      } catch (e) {
        setState((s) => ({
          ...s,
          error: e instanceof Error ? e.message : tPicker("error_dismiss"),
        }));
      }
    },
    [appId, tPicker, router]
  );

  // Debounced rationale auto-save. Each keystroke updates the buffered
  // text immediately (responsive textarea) and schedules a write after
  // the user pauses typing — same UX shape as the notes auto-save.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRationaleChange = useCallback(
    (next: string) => {
      setState((s) => ({ ...s, rationale: next }));
      if (!state.user) {
        return; // No verdict yet — rationale only persists when paired with one
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        if (!state.user) {
          return;
        }
        setVerdict(state.user.verdict, next.trim() || null);
      }, RATIONALE_DEBOUNCE_MS);
    },
    [state.user, setVerdict]
  );

  // Flush any pending rationale write on unmount so a "type, navigate
  // away" sequence doesn't drop the last edit.
  useEffect(
    () => () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    },
    []
  );

  // Compact mode — short-circuit early. Renders a single horizontal
  // chip cluster suitable for inline use in a list row. No imported
  // recommendations region, no rationale textarea — the parent
  // surface (review-and-act page) shows those separately.
  if (compact) {
    return (
      <div
        aria-label={tPicker("options_aria")}
        className="verdict-picker verdict-picker-compact"
        onKeyDown={verdictRadioKeyDown}
        role="radiogroup"
      >
        {VERDICT_ORDER.map((value, index) => {
          const meta = VERDICT_META[value];
          const active = state.user?.verdict === value;
          const optionLabel = tVerdict(`${value}_short`);
          const optionDesc = tVerdict(`${value}_desc`);
          return (
            <button
              aria-checked={active}
              className={`verdict-picker-chip verdict-picker-chip-${meta.cls}${active ? " is-active" : ""}`}
              disabled={state.saving}
              key={value}
              onClick={() => setVerdict(value, state.rationale.trim() || null)}
              role="radio"
              tabIndex={rovingTabIndex(active, index, !!state.user)}
              title={optionDesc}
              type="button"
            >
              <span aria-hidden="true" className="verdict-picker-chip-icon">
                {meta.icon}
              </span>
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

  // Imported recommendations — shared between the expanded picker and
  // the collapsed summary so advisory context stays visible after the
  // user has decided.
  const importedSection =
    state.imported.length > 0 ? (
      <section
        aria-label={tPicker("imported_aria")}
        className="verdict-picker-imported"
      >
        <p className="verdict-picker-imported-title">
          {tPicker("imported_title")}
        </p>
        <ul className="verdict-picker-imported-list">
          {state.imported.map((rec) => {
            const meta = VERDICT_META[rec.verdict];
            const sourceLabel =
              rec.sourceName ?? tPicker("imported_friend_fallback");
            const verdictShort = tVerdict(`${rec.verdict}_short`).toLowerCase();
            return (
              <li
                className={`verdict-picker-imported-row verdict-pill-${meta.cls}`}
                key={rec.id}
              >
                <span aria-hidden="true" className="verdict-pill-icon">
                  {meta.icon}
                </span>
                <div className="verdict-picker-imported-body">
                  <div className="verdict-picker-imported-label">
                    {tPicker.rich("imported_says", {
                      name: sourceLabel,
                      verdict: verdictShort,
                      strong: (chunks) => <strong>{chunks}</strong>,
                      em: (chunks) => <em>{chunks}</em>,
                    })}
                  </div>
                  {rec.rationale && (
                    <div className="verdict-picker-imported-reason">
                      &ldquo;{rec.rationale}&rdquo;
                    </div>
                  )}
                </div>
                <button
                  aria-label={
                    rec.sourceName
                      ? tPicker("imported_dismiss_aria", {
                          sourceName: rec.sourceName,
                        })
                      : tPicker("imported_dismiss_aria_anon")
                  }
                  className="verdict-picker-imported-dismiss"
                  onClick={() =>
                    rec.sourceName && dismissImported(rec.sourceName)
                  }
                  title={tPicker("imported_dismiss_title")}
                  type="button"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
        <p className="verdict-picker-imported-hint">
          {tPicker("imported_hint")}
        </p>
      </section>
    ) : null;

  // Wrap the parts that recur across all three views — the heading
  // (always rendered, sr-only in collapsed mode), the undo flash, and
  // the imported recommendations strip. Errors render after the body.
  const errorBlock = state.error ? (
    <p className="verdict-picker-error" role="alert">
      {state.error}
    </p>
  ) : null;

  // ── 1. Collapsed summary view ─────────────────────────────────────
  if (showSummary && state.user) {
    const rationale = state.user.rationale?.trim() ?? "";
    const meta = VERDICT_META[state.user.verdict];
    return (
      <section
        aria-labelledby="verdict-picker-heading"
        className="verdict-picker verdict-picker-collapsed"
      >
        <h3 className="sr-only" id="verdict-picker-heading">
          {tPicker("title", { appName })}
        </h3>

        {undoFlash && (
          <div
            aria-live="polite"
            className="verdict-picker-undo-flash"
            role="status"
          >
            {undoFlash}
          </div>
        )}

        {importedSection}

        <div
          className={`verdict-picker-summary verdict-picker-summary-${meta.cls}`}
        >
          <span aria-hidden="true" className="verdict-picker-summary-icon">
            {meta.icon}
          </span>
          <span className="verdict-picker-summary-label">
            {tPicker("summary_label")}
          </span>
          <span className="verdict-picker-summary-value">
            {tVerdict(`${state.user.verdict}_short`)}
          </span>
          {rationale && (
            <span
              className="verdict-picker-summary-rationale"
              title={rationale}
            >
              &ldquo;{rationale}&rdquo;
            </span>
          )}
          <button
            aria-label={tPicker("edit_aria", { appName })}
            className="btn btn-secondary btn-sm verdict-picker-summary-edit"
            onClick={() => {
              setStep("reason");
              setEditing(true);
            }}
            type="button"
          >
            {tPicker("edit")}
          </button>
        </div>

        {errorBlock}
      </section>
    );
  }

  // ── 2. Reason step — verdict already chosen, rationale takes focus ─
  if (showReason && state.user) {
    const meta = VERDICT_META[state.user.verdict];
    return (
      <section
        aria-labelledby="verdict-picker-heading"
        className="verdict-picker"
      >
        <header className="verdict-picker-header">
          <h3 className="verdict-picker-title" id="verdict-picker-heading">
            {tPicker("reason_title")}
          </h3>
        </header>

        {undoFlash && (
          <div
            aria-live="polite"
            className="verdict-picker-undo-flash"
            role="status"
          >
            {undoFlash}
          </div>
        )}

        {importedSection}

        {/* Compact chosen-verdict header — paints with the verdict family
            and offers a single "Change" link to swap back to the full
            picker. The pill is read-only here; the verdict is already
            saved on the server. */}
        <div
          className={`verdict-picker-reason-chosen verdict-picker-reason-chosen-${meta.cls}`}
        >
          <span
            aria-hidden="true"
            className="verdict-picker-reason-chosen-icon"
          >
            {meta.icon}
          </span>
          <span className="verdict-picker-reason-chosen-label">
            {tPicker.rich("reason_chosen_label", {
              verdict: tVerdict(`${state.user.verdict}_short`),
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </span>
          <button
            className="verdict-picker-reason-change"
            disabled={state.saving}
            onClick={() => setStep("picker")}
            type="button"
          >
            {tPicker("reason_change")}
          </button>
        </div>

        <div className="verdict-picker-rationale">
          <label
            className="verdict-picker-rationale-label"
            htmlFor="verdict-rationale"
          >
            {tPicker("rationale_label")}
          </label>
          <textarea
            autoFocus
            className="verdict-picker-rationale-input"
            id="verdict-rationale"
            maxLength={400}
            onChange={(e) => onRationaleChange(e.target.value)}
            placeholder={tPicker("rationale_placeholder")}
            rows={3}
            value={state.rationale}
          />
          <div className="verdict-picker-rationale-meta">
            <button
              className="btn btn-ghost btn-sm verdict-picker-clear"
              disabled={state.saving}
              onClick={clearVerdict}
              type="button"
            >
              {tPicker("clear")}
            </button>
            <div className="verdict-picker-rationale-spacer" />
            <span aria-live="polite" className="verdict-picker-saved">
              {state.saving ? tPicker("saving") : tPicker("saved")}
            </span>
            <button
              className="btn btn-primary btn-sm verdict-picker-done"
              disabled={state.saving}
              onClick={() => setEditing(false)}
              type="button"
            >
              {tPicker("done")}
            </button>
          </div>
        </div>

        {errorBlock}
      </section>
    );
  }

  // ── 3. Picker step — three big verdict buttons (no rationale yet) ──
  return (
    <section
      aria-labelledby="verdict-picker-heading"
      className="verdict-picker"
    >
      <header className="verdict-picker-header">
        <h3 className="verdict-picker-title" id="verdict-picker-heading">
          {tPicker("title", { appName })}
        </h3>
        <p className="verdict-picker-sub">{tPicker("sub")}</p>
      </header>

      {undoFlash && (
        <div
          aria-live="polite"
          className="verdict-picker-undo-flash"
          role="status"
        >
          {undoFlash}
        </div>
      )}

      {importedSection}

      <div
        aria-label={tPicker("options_aria")}
        className="verdict-picker-options"
        onKeyDown={verdictRadioKeyDown}
        role="radiogroup"
      >
        {VERDICT_ORDER.map((value, index) => {
          const meta = VERDICT_META[value];
          const active = state.user?.verdict === value;
          const optionLabel = tVerdict(`${value}_short`);
          const optionDesc = tVerdict(`${value}_desc`);
          return (
            <button
              aria-checked={active}
              className={`verdict-picker-option verdict-picker-option-${meta.cls} ${active ? "is-active" : ""}`}
              disabled={state.saving}
              key={value}
              onClick={() => setVerdict(value, state.rationale.trim() || null)}
              role="radio"
              tabIndex={rovingTabIndex(active, index, !!state.user)}
              title={optionDesc}
              type="button"
            >
              <span aria-hidden="true" className="verdict-picker-option-icon">
                {meta.icon}
              </span>
              <span className="verdict-picker-option-label">{optionLabel}</span>
              <span className="verdict-picker-option-desc">{optionDesc}</span>
            </button>
          );
        })}
      </div>

      {/* When a verdict is already set and the user is in the picker step
          via "Change my decision", offer a Cancel link to bail without
          changing anything. */}
      {state.user && (
        <div className="verdict-picker-picker-actions">
          <button
            className="btn btn-ghost btn-sm"
            disabled={state.saving}
            onClick={() => setStep("reason")}
            type="button"
          >
            {tPicker("reason_back")}
          </button>
        </div>
      )}

      {errorBlock}
    </section>
  );
}

function splitVerdicts(verdicts: AppVerdict[]): {
  user: AppVerdict | null;
  imported: AppVerdict[];
} {
  let user: AppVerdict | null = null;
  const imported: AppVerdict[] = [];
  for (const v of verdicts) {
    if (v.source === "user") {
      // There can only be one user verdict per app (UNIQUE index), so
      // the first hit is the right one. Keep it idempotent though.
      if (!user) {
        user = v;
      }
    } else {
      imported.push(v);
    }
  }
  // Most-recently-set first for the imported list so a fresh import
  // surfaces above older recommendations.
  imported.sort((a, b) => b.setAt - a.setAt);
  return { user, imported };
}

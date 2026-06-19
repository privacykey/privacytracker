"use client";

/**
 * FeatureToggleRow — a curated row of per-feature on/off toggles shown under
 * the focus tiles on /welcome and in the settings focus editor.
 *
 * Each toggle shows whether a feature is currently on, and flipping it writes
 * (or clears) a per-flag USER OVERRIDE via /api/feature-flags/overrides.
 * Overrides are the resolver's final word, so a flip sticks regardless of which
 * goals the focus selects — but a flip that lands the feature back on whatever
 * the goals would give CLEARS the override instead of pinning a redundant one
 * (so later goal changes can move it again). The decision is made against the
 * focus-only baseline the server supplies:
 *   - GET /api/feature-flags now returns `focusValue` per flag = the value the
 *     audience/goal rules alone yield (this key's own override stripped).
 *   - When the form passes the in-progress `focusSelection`, we additionally
 *     POST it to /api/feature-flags/resolve-preview so the baseline (and the
 *     display of non-overridden toggles) tracks the goals being edited, not the
 *     last-saved focus.
 *
 * Overrides write IMMEDIATELY and independently of the form's Save — they are
 * meaningful on their own and outlive an abandoned focus edit by design. Do not
 * "fix" this by batching them onto form submit; focus and overrides are
 * separate persistence axes.
 *
 * Known edge: the clear-vs-pin decision uses the SAME baseline as the display
 * (the in-progress preview) so a flip can never visually reject the user's
 * click. If a user previews a goal change, toggles a feature to the previewed
 * value, then abandons WITHOUT saving the focus, a now-redundant override can
 * be left against the still-persisted focus. It's harmless and self-correcting
 * — the ↺ reset clears it — and is the deliberate cost of immediate-write +
 * live preview. Deciding against the persisted baseline instead would make the
 * toggle reject clicks whenever the preview diverges, which is worse.
 *
 * Mirrors the writeOverride / deleteOverride pattern in
 * DevOptionsFeatureFlagPanel.tsx — this is the friendly, curated counterpart.
 */

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import type { Audience, FlagKey, FlagValue } from "@/lib/feature-flag-rules";

interface ToggleDef {
  /** i18n key under `feature_toggle.features.*`. */
  i18n: string;
  icon: string;
  key: FlagKey;
}

/**
 * The curated set. Every key is wired (a real surface reads it) and lives in
 * `WIRED_FLAGS`. Keep in lockstep with PREVIEW_KEYS in the resolve-preview route.
 */
const TOGGLES: readonly ToggleDef[] = [
  { key: "flag.detail.policy.ai_summary", i18n: "ai_summary", icon: "📝" },
  { key: "flag.page.compare", i18n: "compare", icon: "⚖️" },
  { key: "flag.page.privacy_map", i18n: "privacy_map", icon: "🗺️" },
  { key: "flag.page.stats", i18n: "stats", icon: "📊" },
  { key: "flag.nav.notification_bell", i18n: "notifications", icon: "🔔" },
  { key: "flag.page.shortlist", i18n: "shortlist", icon: "⭐" },
];

/** Per-flag state we track. `override` null ⇒ value is purely focus-derived. */
interface FlagState {
  /** Focus-only baseline (override of THIS key stripped) from the GET. */
  focusValue: FlagValue;
  override: FlagValue | null;
}

/** GET /api/feature-flags row shape (subset we consume). */
interface ApiFlagRow {
  focusValue: FlagValue;
  key: string;
  override: FlagValue | null;
}

type WriteErrorKind = "rate_limited" | "write_failed";

/** The in-progress goal selection the form is editing, if it passes one. */
export interface FocusSelection {
  accessibility: boolean;
  audience: Audience;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
}

export default function FeatureToggleRow({
  focusSelection,
}: {
  focusSelection?: FocusSelection;
}) {
  const t = useTranslations("feature_toggle");
  const router = useRouter();
  const [rows, setRows] = useState<Map<string, FlagState>>(new Map());
  const [preview, setPreview] = useState<Map<string, FlagValue>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [writeErrors, setWriteErrors] = useState<Map<string, WriteErrorKind>>(
    new Map()
  );
  const [adminLocked, setAdminLocked] = useState(false);
  // Retry thunks re-run the exact failed write (same optimistic value + request).
  const retryRef = useRef<Map<string, () => Promise<boolean>>>(new Map());
  // Per-chip refs so a successful retry can land focus back on the toggle (the
  // error block holding the Retry button unmounts on success → focus to body).
  const chipRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  // Initial load: the focus-only baseline + any existing overrides.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/feature-flags");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { flags?: ApiFlagRow[] };
        if (cancelled) {
          return;
        }
        const next = new Map<string, FlagState>();
        const wanted = new Set<string>(TOGGLES.map((tg) => tg.key));
        for (const row of data.flags ?? []) {
          if (wanted.has(row.key)) {
            next.set(row.key, {
              focusValue: row.focusValue,
              override: row.override,
            });
          }
        }
        setRows(next);
        setLoadFailed(false);
      } catch (e) {
        if (!cancelled) {
          console.warn("[FeatureToggleRow] load failed:", e);
          setLoadFailed(true);
        }
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Admin-token gate: when a token is configured but this session isn't
  // unlocked, every override write is a guaranteed 401 — render read-only
  // up front instead of letting users click into an invisible failure.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/admin-token/status");
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as {
          configured?: boolean;
          unlocked?: boolean;
        };
        if (!cancelled) {
          setAdminLocked(Boolean(data.configured) && !data.unlocked);
        }
      } catch {
        // Best-effort — if the probe fails we leave toggles enabled and let a
        // real write surface its own error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // In-progress focus reflection: when the form passes its live selection,
  // debounce a read-only resolve so the baseline tracks the goals being edited.
  const focusKey = focusSelection ? JSON.stringify(focusSelection) : null;
  useEffect(() => {
    if (!focusKey) {
      setPreview(new Map());
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch("/api/feature-flags/resolve-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: focusKey,
        });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as {
          focusValues?: Record<string, FlagValue>;
        };
        if (cancelled) {
          return;
        }
        const next = new Map<string, FlagValue>();
        for (const [k, v] of Object.entries(data.focusValues ?? {})) {
          next.set(k, v);
        }
        setPreview(next);
      } catch {
        // Preview is best-effort; baseline falls back to the GET focusValue.
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [focusKey]);

  function baselineFor(key: string, row: FlagState): FlagValue {
    return preview.get(key) ?? row.focusValue;
  }

  function clearWriteError(key: string) {
    setWriteErrors((prev) => {
      if (!prev.has(key)) {
        return prev;
      }
      const m = new Map(prev);
      m.delete(key);
      return m;
    });
  }

  // Shared optimistic write: apply the new override locally, fire the request,
  // and on failure roll back to `prevRow` + surface a retryable inline error.
  async function runWrite(
    key: FlagKey,
    prevRow: FlagState,
    optimisticOverride: FlagValue | null,
    doFetch: () => Promise<Response>
  ): Promise<boolean> {
    setRows((prev) =>
      new Map(prev).set(key, {
        focusValue: prevRow.focusValue,
        override: optimisticOverride,
      })
    );
    setBusyKey(key);
    clearWriteError(key);

    let kind: WriteErrorKind | null = null;
    try {
      const res = await doFetch();
      if (!res.ok) {
        kind = res.status === 429 ? "rate_limited" : "write_failed";
      }
    } catch {
      kind = "write_failed";
    }

    if (kind) {
      setRows((prev) => new Map(prev).set(key, prevRow));
      const failKind = kind;
      setWriteErrors((prev) => new Map(prev).set(key, failKind));
      retryRef.current.set(key, () =>
        runWrite(key, prevRow, optimisticOverride, doFetch)
      );
    } else {
      retryRef.current.delete(key);
      // Optimistic state already reflects the new value; repaint the
      // server-rendered surfaces that gate on this flag.
      router.refresh();
    }
    setBusyKey(null);
    return kind == null;
  }

  function toggle(key: FlagKey) {
    if (adminLocked || busyKey) {
      return;
    }
    const row = rows.get(key);
    if (!row) {
      return;
    }
    const baseline = baselineFor(key, row);
    const displayed = row.override ?? baseline;
    const target: FlagValue = displayed === "on" ? "off" : "on";
    // The #5 fix: clear the override when the desired value already matches
    // focus, otherwise pin it.
    const clearing = target === baseline;
    void runWrite(key, row, clearing ? null : target, () =>
      clearing
        ? fetch(`/api/feature-flags/overrides/${encodeURIComponent(key)}`, {
            method: "DELETE",
          })
        : fetch("/api/feature-flags/overrides", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value: target }),
          })
    );
  }

  function reset(key: FlagKey) {
    if (adminLocked || busyKey) {
      return;
    }
    const row = rows.get(key);
    if (!row || row.override == null) {
      return;
    }
    void runWrite(key, row, null, () =>
      fetch(`/api/feature-flags/overrides/${encodeURIComponent(key)}`, {
        method: "DELETE",
      })
    );
  }

  // Retrying re-runs the exact failed write. It goes through the same guards as
  // toggle()/reset() (so it can't fire while locked or while another write is in
  // flight) and, on completion, lands focus back on the toggle — the error block
  // holding the Retry button unmounts on success, which would otherwise drop
  // focus to <body>. The chip's sr-only label re-announces the resulting state.
  async function retry(key: FlagKey) {
    if (adminLocked || busyKey) {
      return;
    }
    const thunk = retryRef.current.get(key);
    if (!thunk) {
      return;
    }
    await thunk();
    requestAnimationFrame(() => chipRefs.current.get(key)?.focus());
  }

  // Only hide the whole section when the INITIAL load failed with nothing to
  // show — a per-toggle WRITE failure must never blank the row.
  if (loaded && loadFailed && rows.size === 0) {
    return null;
  }

  return (
    <section className="feature-toggle-row">
      <h2 className="focus-purpose-secondary-heading">{t("heading")}</h2>
      <p className="feature-toggle-hint">
        {adminLocked ? t("locked_hint") : t("hint")}
      </p>
      <div className="feature-toggle-grid">
        {TOGGLES.map((tg) => {
          const row = rows.get(tg.key);
          const baseline = row ? baselineFor(tg.key, row) : "off";
          const overridden = row?.override != null;
          const displayed = overridden ? (row?.override ?? baseline) : baseline;
          const on = displayed === "on";
          const busy = busyKey === tg.key;
          const err = writeErrors.get(tg.key);
          const label = t(`features.${tg.i18n}`);
          return (
            <div className="feature-toggle-item" key={tg.key}>
              <button
                aria-busy={busy}
                aria-pressed={on}
                className={`feature-toggle-chip ${on ? "is-on" : "is-off"}${
                  adminLocked ? " feature-toggle-chip--locked" : ""
                }`}
                disabled={!loaded || busy || adminLocked || !row}
                onClick={() => toggle(tg.key)}
                ref={(el) => {
                  chipRefs.current.set(tg.key, el);
                }}
                type="button"
              >
                <span aria-hidden="true" className="feature-toggle-icon">
                  {adminLocked ? "🔒" : tg.icon}
                </span>
                <span className="feature-toggle-label">{label}</span>
                <span
                  aria-hidden="true"
                  className={`feature-toggle-state feature-toggle-state--${
                    on ? "on" : "off"
                  }`}
                >
                  {on ? t("on") : t("off")}
                </span>
                <span className="sr-only">
                  {adminLocked
                    ? t("locked_aria", { feature: label })
                    : on
                      ? t("aria_on", { feature: label })
                      : t("aria_off", { feature: label })}
                </span>
              </button>
              {overridden && !adminLocked && (
                <button
                  className="feature-toggle-reset"
                  disabled={busy}
                  onClick={() => reset(tg.key)}
                  title={t("reset", { feature: label })}
                  type="button"
                >
                  <span aria-hidden="true">↺</span>
                  <span className="sr-only">
                    {t("reset", { feature: label })}
                  </span>
                </button>
              )}
              {/* Always-mounted live region: a status region created in the
                  same tick as its text is frequently missed by NVDA/JAWS, so we
                  keep it present and only swap the text (matching the undo strip
                  in DevOptionsFeatureFlagPanel). The visible box below is the
                  separate, mountable VISUAL surface. */}
              <div aria-live="polite" className="sr-only" role="status">
                {err
                  ? err === "rate_limited"
                    ? t("rate_limited")
                    : t("write_failed")
                  : ""}
              </div>
              {err && (
                <div className="feature-toggle-error">
                  <span aria-hidden="true">⚠</span>
                  <span aria-hidden="true">
                    {err === "rate_limited"
                      ? t("rate_limited")
                      : t("write_failed")}
                  </span>
                  <button
                    className="feature-toggle-retry"
                    disabled={busyKey !== null}
                    onClick={() => retry(tg.key)}
                    type="button"
                  >
                    {t("retry")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

"use client";

/**
 * FeatureToggleRow — a curated row of per-feature on/off toggles shown under
 * the focus tiles on /welcome and in the settings focus editor.
 *
 * Each toggle reads its CURRENTLY-RESOLVED value from `/api/feature-flags`
 * (focus rules + any existing override already applied server-side) and, when
 * flipped, writes a per-flag USER OVERRIDE via `/api/feature-flags/overrides`.
 * Overrides are the final word in the resolver, so flipping one here sticks
 * regardless of which goals the focus selects. A small reset control clears
 * the override and hands the feature back to the focus-driven default.
 *
 * Mirrors the writeOverride / deleteOverride pattern in
 * DevOptionsFeatureFlagPanel.tsx — this is the friendly, curated counterpart.
 */

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type { FlagKey, FlagValue } from "@/lib/feature-flag-rules";

interface ToggleDef {
  /** i18n key under `feature_toggle.features.*`. */
  i18n: string;
  icon: string;
  key: FlagKey;
}

/**
 * The curated set. Every key is wired (a real surface reads it) and lives in
 * `WIRED_FLAGS`. Tunable — add/remove a line here and an entry under
 * `feature_toggle.features.*` in the locales.
 */
const TOGGLES: readonly ToggleDef[] = [
  { key: "flag.detail.policy.ai_summary", i18n: "ai_summary", icon: "📝" },
  { key: "flag.page.compare", i18n: "compare", icon: "⚖️" },
  { key: "flag.page.privacy_map", i18n: "privacy_map", icon: "🗺️" },
  { key: "flag.page.stats", i18n: "stats", icon: "📊" },
  { key: "flag.nav.notification_bell", i18n: "notifications", icon: "🔔" },
  { key: "flag.page.shortlist", i18n: "shortlist", icon: "⭐" },
];

interface FlagState {
  /** Resolved value with override applied. */
  currentValue: FlagValue;
  /** The override row, or null when the value comes purely from focus rules. */
  override: FlagValue | null;
}

/** GET /api/feature-flags row shape (subset we consume). */
interface ApiFlagRow {
  currentValue: FlagValue;
  key: string;
  override: FlagValue | null;
}

export default function FeatureToggleRow() {
  const t = useTranslations("feature_toggle");
  const router = useRouter();
  const [state, setState] = useState<Map<string, FlagState>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/feature-flags");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { flags?: ApiFlagRow[] };
      const next = new Map<string, FlagState>();
      for (const row of data.flags ?? []) {
        next.set(row.key, {
          currentValue: row.currentValue,
          override: row.override,
        });
      }
      setState(next);
      setFailed(false);
    } catch (e) {
      console.warn("[FeatureToggleRow] load failed:", e);
      setFailed(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setOverride(key: FlagKey, value: FlagValue) {
    setBusyKey(key);
    try {
      const res = await fetch("/api/feature-flags/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      await load();
      // Refresh server-rendered surfaces that gate on this flag.
      router.refresh();
    } catch (e) {
      console.warn("[FeatureToggleRow] override write failed:", e);
      setFailed(true);
    } finally {
      setBusyKey(null);
    }
  }

  async function clearOverride(key: FlagKey) {
    setBusyKey(key);
    try {
      const res = await fetch(
        `/api/feature-flags/overrides/${encodeURIComponent(key)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      await load();
      router.refresh();
    } catch (e) {
      console.warn("[FeatureToggleRow] override clear failed:", e);
      setFailed(true);
    } finally {
      setBusyKey(null);
    }
  }

  // Hide entirely if the list never loaded — nothing useful to show, and we
  // don't want a broken control blocking the onboarding flow.
  if (loaded && failed && state.size === 0) {
    return null;
  }

  return (
    <section className="feature-toggle-row">
      <h2 className="focus-purpose-secondary-heading">{t("heading")}</h2>
      <p className="feature-toggle-hint">{t("hint")}</p>
      <div className="feature-toggle-grid">
        {TOGGLES.map((toggle) => {
          const row = state.get(toggle.key);
          const on = (row?.currentValue ?? "off") === "on";
          const overridden = row?.override != null;
          const busy = busyKey === toggle.key;
          const label = t(`features.${toggle.i18n}`);
          return (
            <div className="feature-toggle-item" key={toggle.key}>
              <button
                aria-busy={busy}
                aria-pressed={on}
                className={`feature-toggle-chip ${on ? "is-on" : "is-off"}`}
                disabled={!loaded || busy}
                onClick={() => void setOverride(toggle.key, on ? "off" : "on")}
                type="button"
              >
                <span aria-hidden="true" className="feature-toggle-icon">
                  {toggle.icon}
                </span>
                <span className="feature-toggle-label">{label}</span>
                <span
                  aria-hidden="true"
                  className={`feature-toggle-state feature-toggle-state--${on ? "on" : "off"}`}
                >
                  {on ? t("on") : t("off")}
                </span>
                <span className="sr-only">
                  {on
                    ? t("aria_on", { feature: label })
                    : t("aria_off", { feature: label })}
                </span>
              </button>
              {overridden && (
                <button
                  className="feature-toggle-reset"
                  disabled={busy}
                  onClick={() => void clearOverride(toggle.key)}
                  title={t("reset", { feature: label })}
                  type="button"
                >
                  <span aria-hidden="true">↺</span>
                  <span className="sr-only">
                    {t("reset", { feature: label })}
                  </span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

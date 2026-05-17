"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

/**
 * Step-2 upfront diff for the OnboardWizard cfgutil re-sync path.
 *
 * Renders three sections — Added / Removed / Already tracked
 * (collapsed) — built from a client-side diff between the cfgutil-
 * imported entries and the device's currently-tracked apps. Default-
 * checks every add + every remove; the user can untick anything they
 * don't want to apply. The Continue button surfaces a count summary
 * that drives the confirm modal in the parent.
 *
 * This panel REPLACES the regular ImportedAppsTable + the smaller
 * AlreadyTrackedAccordion when the wizard is in auto-resync mode
 * (cfgutil detected an ECID that matches an existing device). The
 * post-scrape DeviceSyncDiffOverlay no longer fires on this entry
 * point — Settings → Devices "Re-sync" remains the post-scrape path.
 */

export interface CfgutilEntry {
  bundleId?: string | null;
  id: string;
  name: string;
}

export interface TrackedApp {
  appId: string;
  bundleId: string | null;
  name: string;
}

export interface Step2DiffPanelProps {
  deviceId: string;
  deviceName: string;
  /** The cfgutil-imported entries (each with at minimum `name` + `bundleId`). */
  entries: CfgutilEntry[];
  /**
   * Confirm handler. Receives the user's selection (which entry ids to
   * include as adds going forward, and which appIds to apply as
   * removes). Parent is responsible for the API commit + advancing the
   * wizard.
   */
  onConfirm: (selection: {
    pickedEntryIds: string[];
    pickedRemoveAppIds: string[];
    addCount: number;
    removeCount: number;
  }) => void;
}

interface DiffBuckets {
  /** Cfgutil entries whose bundleId is NOT linked to this device yet. */
  added: CfgutilEntry[];
  /** Device's tracked apps whose bundleId did NOT appear in cfgutil. */
  removed: TrackedApp[];
  /** Cfgutil entries whose bundleId IS already linked to this device. */
  unchanged: CfgutilEntry[];
}

function normaliseName(raw: string): string {
  return raw.toLowerCase().normalize("NFKC").trim();
}

/**
 * Compute the three diff buckets. Match priority:
 *
 *   1. bundleId equality — strongest, used whenever both sides have a
 *      bundleId. Cfgutil always populates bundleId on incoming entries.
 *   2. Name fallback (case-insensitive, Unicode-normalised) — kicks in
 *      when a tracked app has NULL bundleId. Legacy CSV / manual
 *      imports never populated the column, so this fallback prevents
 *      every cfgutil entry from being flagged as "new" the first time a
 *      user re-syncs after migrating.
 *
 * The name fallback is intentionally one-way: tracked-side-missing-
 * bundleId can match a cfgutil-side bundleId entry by name, but a
 * cfgutil entry without a bundleId still falls through to "added"
 * (cfgutil reads installed apps; missing bundleId there means the
 * extractor failed and we shouldn't pretend it matches).
 */
function computeBuckets(
  entries: CfgutilEntry[],
  tracked: TrackedApp[]
): DiffBuckets {
  const trackedByBundle = new Map<string, TrackedApp>();
  const trackedByNameNoBundle = new Map<string, TrackedApp>();
  for (const t of tracked) {
    if (t.bundleId) {
      trackedByBundle.set(t.bundleId, t);
    } else {
      trackedByNameNoBundle.set(normaliseName(t.name), t);
    }
  }

  const cfgBundleSet = new Set<string>();
  const cfgNameSet = new Set<string>();
  for (const e of entries) {
    if (e.bundleId) {
      cfgBundleSet.add(e.bundleId);
    }
    cfgNameSet.add(normaliseName(e.name));
  }

  // Track which name-fallback tracked rows we've "claimed" so removes
  // computed below don't double-count them.
  const consumedNameMatches = new Set<string>();

  const added: CfgutilEntry[] = [];
  const unchanged: CfgutilEntry[] = [];
  for (const e of entries) {
    const bid = e.bundleId?.trim();
    if (bid && trackedByBundle.has(bid)) {
      unchanged.push(e);
      continue;
    }
    const nameKey = normaliseName(e.name);
    if (trackedByNameNoBundle.has(nameKey)) {
      unchanged.push(e);
      consumedNameMatches.add(nameKey);
      continue;
    }
    added.push(e);
  }

  const removed: TrackedApp[] = [];
  for (const t of tracked) {
    if (t.bundleId) {
      if (!cfgBundleSet.has(t.bundleId)) {
        removed.push(t);
      }
    } else {
      // Tracked row with no bundleId: a remove only if its name didn't
      // match a cfgutil entry. Otherwise it's an unchanged-via-name
      // match and we already consumed it.
      const nameKey = normaliseName(t.name);
      if (!consumedNameMatches.has(nameKey)) {
        removed.push(t);
      }
    }
  }

  return { added, removed, unchanged };
}

export default function Step2DiffPanel({
  deviceId,
  deviceName,
  entries,
  onConfirm,
}: Step2DiffPanelProps) {
  const t = useTranslations("onboard.step2_diff");
  const [tracked, setTracked] = useState<TrackedApp[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickedAdds, setPickedAdds] = useState<Set<string>>(new Set());
  const [pickedRemoves, setPickedRemoves] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!deviceId) {
      setTracked(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/devices/${encodeURIComponent(deviceId)}/tracked-apps`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        if (cancelled) {
          return;
        }
        setTracked(Array.isArray(json.apps) ? json.apps : []);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        console.warn("[step2-diff] tracked-apps fetch failed:", err);
        setLoadError(err instanceof Error ? err.message : "load failed");
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const buckets = useMemo<DiffBuckets | null>(() => {
    if (!tracked) {
      return null;
    }
    return computeBuckets(entries, tracked);
  }, [entries, tracked]);

  // Default-tick every add + every remove the first time we have a
  // diff. After that, respect whatever the user has manually ticked.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!buckets || hydrated) {
      return;
    }
    setPickedAdds(new Set(buckets.added.map((a) => a.id)));
    setPickedRemoves(new Set(buckets.removed.map((r) => r.appId)));
    setHydrated(true);
  }, [buckets, hydrated]);

  if (loadError) {
    return (
      <div className="wizard-note wizard-note-amber" role="alert">
        <strong>{t("load_error_title")}</strong>
        <p style={{ margin: "4px 0 0" }}>
          {t("load_error_body", { error: loadError })}
        </p>
      </div>
    );
  }
  if (!buckets) {
    return <p className="wizard-note">{t("loading")}</p>;
  }

  const handleContinue = () => {
    onConfirm({
      pickedEntryIds: Array.from(pickedAdds),
      pickedRemoveAppIds: Array.from(pickedRemoves),
      addCount: pickedAdds.size,
      removeCount: pickedRemoves.size,
    });
  };

  // "Nothing's changed" path — every cfgutil entry matches a tracked
  // app (by bundleId or name fallback). Skip the full diff UI and
  // surface a single "all set" panel with a Done button that bypasses
  // the confirm modal. The unchanged accordion stays available below
  // so the user can verify which apps were matched.
  const hasNothingToDo =
    buckets.added.length === 0 && buckets.removed.length === 0;
  if (hasNothingToDo) {
    return (
      <div aria-label={t("region_aria")} className="step2-diff-panel">
        <header className="step2-diff-header">
          <h2 className="step2-diff-title">
            {t("all_tracked_title", {
              device: deviceName || t("device_fallback"),
            })}
          </h2>
          <p className="step2-diff-sub">
            {t("all_tracked_body", { count: buckets.unchanged.length })}
          </p>
        </header>
        {buckets.unchanged.length > 0 && (
          <details className="step2-diff-section step2-diff-section-collapsed">
            <summary className="step2-diff-section-summary">
              <span className="step2-diff-section-title">
                {t("unchanged_heading", { count: buckets.unchanged.length })}
              </span>
              <span aria-hidden="true" className="step2-diff-section-chevron">
                ▸
              </span>
            </summary>
            <p className="step2-diff-section-help">{t("unchanged_help")}</p>
            <ul className="step2-diff-rows">
              {buckets.unchanged.map((entry) => (
                <li
                  className="step2-diff-row step2-diff-row-readonly"
                  key={entry.id}
                >
                  <span aria-hidden="true" className="step2-diff-row-tick">
                    ✓
                  </span>
                  <span className="step2-diff-row-name">{entry.name}</span>
                  {entry.bundleId && (
                    <span className="step2-diff-row-bundle">
                      {entry.bundleId}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        <footer className="step2-diff-footer">
          <span className="step2-diff-footer-summary">
            {t("all_tracked_summary")}
          </span>
          <button
            className="btn btn-primary"
            onClick={handleContinue}
            type="button"
          >
            {t("done")}
          </button>
        </footer>
      </div>
    );
  }

  return (
    <div aria-label={t("region_aria")} className="step2-diff-panel">
      <header className="step2-diff-header">
        <h2 className="step2-diff-title">
          {t("heading", { device: deviceName || t("device_fallback") })}
        </h2>
        <p className="step2-diff-sub">
          {t("summary_counts", {
            adds: buckets.added.length,
            removes: buckets.removed.length,
            unchanged: buckets.unchanged.length,
          })}
        </p>
      </header>

      {buckets.added.length === 0 && buckets.removed.length === 0 && (
        <div className="wizard-note" role="status">
          <strong>{t("no_changes_title")}</strong>
          <p style={{ margin: "4px 0 0" }}>{t("no_changes_body")}</p>
        </div>
      )}

      {buckets.added.length > 0 && (
        <section className="step2-diff-section">
          <h3 className="step2-diff-section-title">
            {t("adds_heading", { count: buckets.added.length })}
          </h3>
          <p className="step2-diff-section-help">{t("adds_help")}</p>
          <ul className="step2-diff-rows">
            {buckets.added.map((entry) => (
              <li className="step2-diff-row" key={entry.id}>
                <input
                  aria-label={t("add_check_aria", { name: entry.name })}
                  checked={pickedAdds.has(entry.id)}
                  className="step2-diff-row-check"
                  onChange={() => {
                    setPickedAdds((prev) => {
                      const next = new Set(prev);
                      if (next.has(entry.id)) {
                        next.delete(entry.id);
                      } else {
                        next.add(entry.id);
                      }
                      return next;
                    });
                  }}
                  type="checkbox"
                />
                <span className="step2-diff-row-name">{entry.name}</span>
                {entry.bundleId && (
                  <span className="step2-diff-row-bundle">
                    {entry.bundleId}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {buckets.removed.length > 0 && (
        <section className="step2-diff-section">
          <h3 className="step2-diff-section-title">
            {t("removes_heading", { count: buckets.removed.length })}
          </h3>
          <p className="step2-diff-section-help">{t("removes_help")}</p>
          <ul className="step2-diff-rows">
            {buckets.removed.map((row) => (
              <li className="step2-diff-row" key={row.appId}>
                <input
                  aria-label={t("remove_check_aria", { name: row.name })}
                  checked={pickedRemoves.has(row.appId)}
                  className="step2-diff-row-check"
                  onChange={() => {
                    setPickedRemoves((prev) => {
                      const next = new Set(prev);
                      if (next.has(row.appId)) {
                        next.delete(row.appId);
                      } else {
                        next.add(row.appId);
                      }
                      return next;
                    });
                  }}
                  type="checkbox"
                />
                <span className="step2-diff-row-name">{row.name}</span>
                {row.bundleId && (
                  <span className="step2-diff-row-bundle">{row.bundleId}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {buckets.unchanged.length > 0 && (
        <details className="step2-diff-section step2-diff-section-collapsed">
          <summary className="step2-diff-section-summary">
            <span className="step2-diff-section-title">
              {t("unchanged_heading", { count: buckets.unchanged.length })}
            </span>
            <span aria-hidden="true" className="step2-diff-section-chevron">
              ▸
            </span>
          </summary>
          <p className="step2-diff-section-help">{t("unchanged_help")}</p>
          <ul className="step2-diff-rows">
            {buckets.unchanged.map((entry) => (
              <li
                className="step2-diff-row step2-diff-row-readonly"
                key={entry.id}
              >
                <span aria-hidden="true" className="step2-diff-row-tick">
                  ✓
                </span>
                <span className="step2-diff-row-name">{entry.name}</span>
                {entry.bundleId && (
                  <span className="step2-diff-row-bundle">
                    {entry.bundleId}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <footer className="step2-diff-footer">
        <span className="step2-diff-footer-summary">
          {t("selection_summary", {
            adds: pickedAdds.size,
            removes: pickedRemoves.size,
          })}
        </span>
        <button
          className="btn btn-primary"
          onClick={handleContinue}
          type="button"
        >
          {t("continue")}
        </button>
      </footer>
    </div>
  );
}

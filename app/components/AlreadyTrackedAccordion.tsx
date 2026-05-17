"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

/**
 * Accordion shown above the OnboardWizard's `ImportedAppsTable` when
 * the user is importing from a device that's been imported from before
 * (cfgutil ECID match → re-sync mode auto-set). Cross-references the
 * incoming app list's bundle IDs against the device's currently-tracked
 * apps and folds the duplicates into a collapsed disclosure so the
 * "new" rows stay front-and-centre.
 *
 *   "5 apps already tracked from My iPhone — already matched. ▸"
 *
 * Clicking expands a plain list of the tracked names. The accordion
 * doesn't mutate anything — it's purely a visual aid. The actual diff
 * + double-confirm happens after the scrape via DeviceSyncDiffOverlay.
 */

export interface AlreadyTrackedAccordionProps {
  /** Device id the OnboardWizard is currently in re-sync mode for. */
  deviceId: string | null;
  /** Display name for the contextual heading copy. */
  deviceName?: string;
  /** The cfgutil-imported entries — needs `name` + optional `bundleId`. */
  entries: Array<{ id: string; name: string; bundleId?: string | null }>;
}

export default function AlreadyTrackedAccordion({
  deviceId,
  deviceName,
  entries,
}: AlreadyTrackedAccordionProps) {
  const t = useTranslations("onboard.already_tracked");
  const [trackedBundleIds, setTrackedBundleIds] = useState<Set<string> | null>(
    null
  );
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!deviceId) {
      setTrackedBundleIds(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/devices/${encodeURIComponent(deviceId)}/bundles`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) {
          return;
        }
        const json = await res.json();
        if (cancelled) {
          return;
        }
        const set = new Set<string>(
          Array.isArray(json.bundleIds) ? json.bundleIds : []
        );
        setTrackedBundleIds(set);
      })
      .catch((error) => {
        console.warn("[already-tracked-accordion] fetch failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const trackedFromEntries = useMemo(() => {
    if (!trackedBundleIds || trackedBundleIds.size === 0) {
      return [];
    }
    return entries.filter((e) => {
      const bid = e.bundleId?.trim();
      return bid ? trackedBundleIds.has(bid) : false;
    });
  }, [entries, trackedBundleIds]);

  if (!deviceId || trackedFromEntries.length === 0) {
    return null;
  }

  return (
    <details
      className="already-tracked-accordion"
      onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}
      open={expanded}
    >
      <summary className="already-tracked-accordion-summary">
        <span aria-hidden="true" className="already-tracked-accordion-icon">
          ✓
        </span>
        <span className="already-tracked-accordion-text">
          {t("summary", {
            count: trackedFromEntries.length,
            device: deviceName?.trim() || t("device_fallback"),
          })}
        </span>
        <span aria-hidden="true" className="already-tracked-accordion-chevron">
          {expanded ? "▾" : "▸"}
        </span>
      </summary>
      <p className="already-tracked-accordion-help">{t("help")}</p>
      <ul className="already-tracked-accordion-list">
        {trackedFromEntries.map((entry) => (
          <li className="already-tracked-accordion-item" key={entry.id}>
            {entry.name}
          </li>
        ))}
      </ul>
    </details>
  );
}

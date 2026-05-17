"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import "./device-sync.css";

/**
 * "Installed on" side-panel for App Detail. Renders as the right
 * 1/3 column next to the "What's changed" panel (or full-width on
 * mobile). Self-fetches via /api/devices/for-app — keeps the server
 * component free of an extra query.
 *
 * Renders nothing when:
 *   - the app is on zero devices (legacy unlinked apps)
 *   - the only device is the "Unknown device" backfill placeholder
 *     (it carries no information the user supplied)
 *
 * Click on a device chip routes to /dashboard/settings/devices where the
 * user can rename / re-sync / delete.
 */

export interface AppDeviceMini {
  id: string;
  iosVersion: string | null;
  isUnknownPlaceholder: boolean;
  lastSyncedAt: number;
  model: string | null;
  name: string;
}

export default function AppDevicesPanel({ appId }: { appId: string }) {
  const t = useTranslations("devices.app_panel");
  const [devices, setDevices] = useState<AppDeviceMini[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/devices/for-app/${encodeURIComponent(appId)}`, {
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
        setDevices(Array.isArray(json.devices) ? json.devices : []);
      })
      .catch((error) => {
        console.warn("[app-devices-panel] fetch failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  if (!devices || devices.length === 0) {
    return null;
  }
  // Hide when only the "Unknown device" backfill placeholder is present
  // — that's the migration default with no user-supplied device name.
  const meaningful = devices.filter((d) => !d.isUnknownPlaceholder);
  if (meaningful.length === 0) {
    return null;
  }

  return (
    <aside aria-label={t("aria")} className="app-devices-panel">
      <header className="app-devices-panel-header">
        <h2 className="app-devices-panel-title">
          {t("heading", { count: meaningful.length })}
        </h2>
        <p className="app-devices-panel-sub">{t("subtitle")}</p>
      </header>
      <ul className="app-devices-panel-list">
        {meaningful.map((d) => (
          <li className="app-devices-panel-row" key={d.id}>
            <Link
              className="app-devices-panel-chip"
              href="/dashboard/settings/devices"
            >
              <span aria-hidden="true" className="app-devices-panel-chip-icon">
                {iconForDeviceName(d)}
              </span>
              <span className="app-devices-panel-chip-body">
                <span className="app-devices-panel-chip-name">{d.name}</span>
                {(d.model || d.iosVersion) && (
                  <span className="app-devices-panel-chip-meta">
                    {[d.model, d.iosVersion].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <footer className="app-devices-panel-footer">
        <Link
          className="app-devices-panel-manage-link"
          href="/dashboard/settings/devices"
        >
          {t("manage_link")}
        </Link>
      </footer>
    </aside>
  );
}

/** Light heuristic — pick an emoji glyph based on the device's name /
 *  model. Apple Configurator-supplied names usually contain "iPhone" /
 *  "iPad" / "iPod". Fallback: a generic phone glyph. */
function iconForDeviceName(d: AppDeviceMini): string {
  const haystack = `${d.name} ${d.model ?? ""}`.toLowerCase();
  if (haystack.includes("ipad")) {
    return "📱";
  }
  if (haystack.includes("ipod")) {
    return "🎵";
  }
  if (haystack.includes("mac")) {
    return "💻";
  }
  if (haystack.includes("watch")) {
    return "⌚";
  }
  return "📱";
}

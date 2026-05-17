"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import "./device-sync.css";

/**
 * "Tracked on: iPhone · iPad" chip strip rendered in the App Detail
 * header. Self-fetches via /api/devices/for-app — the server component
 * doesn't need to thread the data through; this is a small affordance
 * that shouldn't block the page render.
 *
 * Renders nothing when:
 *   - the feature flag is off (controlled by caller mounting decision)
 *   - the app is on zero devices (legacy unlinked apps)
 *   - the app is on exactly one "Unknown device" placeholder (no
 *     informational value)
 */

interface DeviceMini {
  id: string;
  isUnknownPlaceholder: boolean;
  name: string;
}

export default function TrackedOnChips({ appId }: { appId: string }) {
  const t = useTranslations("devices.tracked_on");
  const [devices, setDevices] = useState<DeviceMini[] | null>(null);

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
        console.warn("[tracked-on-chips] fetch failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  if (!devices || devices.length === 0) {
    return null;
  }
  // Don't surface the "Unknown device" placeholder by itself — it's a
  // bootstrap artefact, not informative for the user.
  if (devices.length === 1 && devices[0].isUnknownPlaceholder) {
    return null;
  }

  return (
    <div aria-label={t("aria")} className="tracked-on-strip">
      <span className="tracked-on-strip-label">{t("label")}</span>
      {devices.map((d) => (
        <Link
          className="tracked-on-chip"
          href={"/dashboard/settings/devices"}
          key={d.id}
        >
          {d.name}
        </Link>
      ))}
    </div>
  );
}

"use client";

/**
 * Device-connect toast — surfaces under /onboard when an iPhone or iPad
 * is attached to the Mac, offering a one-click jump into the cfgutil
 * import flow for that ECID.
 *
 * Now event-driven: subscribes to the Tauri `cfgutil:device-connected`
 * event emitted by the Rust IOKit watcher. No polling. Gated on a
 * "user has imported via cfgutil at least once" flag so a fresh install
 * never pays the cost — users who never use cfgutil don't see the
 * toast and the watcher stays idle.
 *
 * Unlike the passive toasts, this one carries an action (the Import
 * CTA), so it deliberately stays until dismissed instead of auto-hiding
 * after TOAST_HOLD_MS. Position/animation chrome is shared via the
 * toastIn/toastOut keyframes + --toast-* vars in globals.css.
 *
 * No-ops outside the Tauri shell.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ConnectedDevice, isDesktop } from "../../lib/desktop";
import { TOAST_OUT_MS } from "../../lib/toast-timing";

type ToastT = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

function deviceGlyph(d: ConnectedDevice): string {
  const cls = (d.deviceClass ?? "").toLowerCase();
  if (cls.includes("ipad")) {
    return "📱";
  }
  if (cls.includes("iphone")) {
    return "📱";
  }
  if (cls.includes("ipod")) {
    return "🎵";
  }
  if (cls.includes("watch")) {
    return "⌚";
  }
  const model = (d.model ?? "").toLowerCase();
  if (model.startsWith("ipad")) {
    return "📱";
  }
  if (model.startsWith("ipod")) {
    return "🎵";
  }
  if (model.startsWith("watch")) {
    return "⌚";
  }
  return "📱";
}

function deviceDisplayName(t: ToastT, d: ConnectedDevice): string {
  if (d.name?.trim()) {
    return d.name.trim();
  }
  if (d.model?.trim()) {
    return d.model.trim();
  }
  if (d.deviceClass?.trim()) {
    return t("no_name_with_class", { cls: d.deviceClass.trim() });
  }
  return t("no_name");
}

/**
 * Shape of the Tauri-emitted payload. Mirrors src-tauri/src/usb_watcher.rs's
 * serde::Serialize on the device row.
 */
interface DeviceEventPayload {
  deviceClass: string | null;
  ecid: string;
  iosVersion: string | null;
  model: string | null;
  name: string | null;
}

export default function DeviceConnectedToast() {
  const tToast = useTranslations("device_connect_toast");
  const [pending, setPending] = useState<ConnectedDevice | null>(null);
  const [dismissedEcids, setDismissedEcids] = useState<Set<string>>(new Set());
  const [gateOpen, setGateOpen] = useState<boolean | null>(null);
  // Dismissal plays the toastOut animation for TOAST_OUT_MS before the
  // toast actually unmounts; `leaving` drives the CSS class, the ref
  // holds the timer so unmount can cancel it.
  const [leaving, setLeaving] = useState(false);
  const leaveTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (leaveTimerRef.current !== null) {
        window.clearTimeout(leaveTimerRef.current);
      }
    },
    []
  );

  // Read the cfgutil_imported_at gate once on mount. We only subscribe to
  // the USB attach event when the gate is open — users who have never
  // imported via cfgutil don't pay any cost.
  useEffect(() => {
    if (!isDesktop()) {
      setGateOpen(false);
      return;
    }
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((json) => {
        if (cancelled) {
          return;
        }
        const raw = json?.cfgutil_imported_at;
        setGateOpen(raw !== "" && raw !== null && raw !== undefined);
      })
      .catch(() => {
        if (!cancelled) {
          setGateOpen(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to the IOKit-driven device-connected event. Lazy-imports the
  // Tauri event API so the web build doesn't ship the bridge.
  useEffect(() => {
    if (!gateOpen) {
      return;
    }
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) {
          return;
        }
        const off = await listen<DeviceEventPayload>(
          "cfgutil:device-connected",
          (event) => {
            const payload = event.payload;
            if (!payload || typeof payload.ecid !== "string" || !payload.ecid) {
              return;
            }
            setDismissedEcids((prev) => {
              if (prev.has(payload.ecid)) {
                return prev;
              }
              return prev;
            });
            setPending((prev) => {
              // Don't replace an existing pending toast — the user can
              // dismiss the current one and the next event will land.
              if (prev) {
                return prev;
              }
              return {
                ecid: payload.ecid,
                name: payload.name,
                model: payload.model,
                iosVersion: payload.iosVersion,
                deviceClass: payload.deviceClass,
              };
            });
          }
        );
        if (cancelled) {
          off();
          return;
        }
        unsubscribe = off;
      } catch (err) {
        console.warn(
          "[device-toast] failed to subscribe to cfgutil:device-connected",
          err
        );
      }
    })();
    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [gateOpen]);

  const dismiss = useCallback(() => {
    if (!pending || leaving) {
      return;
    }
    const ecid = pending.ecid;
    setLeaving(true);
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null;
      setDismissedEcids((prev) => {
        const next = new Set(prev);
        next.add(ecid);
        return next;
      });
      setPending(null);
      setLeaving(false);
    }, TOAST_OUT_MS);
  }, [pending, leaving]);

  // Hidden in the web build so server-side renders match.
  if (!(isDesktop() && pending)) {
    return null;
  }
  if (dismissedEcids.has(pending.ecid)) {
    return null;
  }

  const displayName = deviceDisplayName(tToast, pending);
  const glyph = deviceGlyph(pending);
  const subtitle = [
    pending.deviceClass,
    pending.iosVersion ? `iOS ${pending.iosVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      aria-label={tToast("aria_connected", { name: displayName })}
      aria-live="polite"
      className={`device-connect-toast${leaving ? " device-connect-toast-leaving" : ""}`}
      role="dialog"
    >
      <div aria-hidden="true" className="device-connect-toast-icon">
        {glyph}
      </div>
      <div className="device-connect-toast-body">
        <div className="device-connect-toast-title">
          {tToast.rich("title_connected", {
            name: displayName,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </div>
        {subtitle && <div className="device-connect-toast-sub">{subtitle}</div>}
        <div className="device-connect-toast-help">{tToast("help")}</div>
      </div>
      <div className="device-connect-toast-actions">
        <Link
          className="btn btn-primary btn-sm"
          href={{
            pathname: "/onboard",
            query: { source: "cfgutil", ecid: pending.ecid },
          }}
          onClick={dismiss}
        >
          {tToast("import_apps")}
        </Link>
        <button
          aria-label={tToast("dismiss_aria")}
          className="device-connect-toast-dismiss"
          onClick={dismiss}
          type="button"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

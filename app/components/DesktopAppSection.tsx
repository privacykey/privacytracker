"use client";

/**
 * Desktop-only settings block.
 *
 * Rendered only when the page is loaded inside the Tauri webview — in the
 * Docker/web build the whole section no-ops via `if (!isDesktop()) return null`.
 *
 * Drop this component anywhere inside `SettingsView.tsx`'s main body:
 *
 *   import DesktopAppSection from './DesktopAppSection';
 *   …
 *   <DesktopAppSection />
 *
 * That keeps the 6k-line SettingsView from growing a big platform-specific
 * branch inline.
 *
 * Everything here follows the same read-then-write pattern:
 *   1. Settings are persisted on the Node side via /api/settings/desktop.
 *   2. After POSTing the new value, we invoke any Tauri-side command that
 *      needs to *act* on the change (dock policy, shortcut rebind, theme
 *      class, etc.). A restart should never be required for a v1 setting.
 */

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyThemeOverride,
  authenticateTouchId,
  getDiagnosticsReport,
  isAutostartEnabled,
  isDesktop,
  openDataDir,
  openLogDir,
  registerGlobalShortcut,
  setAutostart,
  setDockVisibility,
  setTrayVisible,
  toggleDevtools,
} from "@/lib/desktop";

type ThemeMode = "system" | "light" | "dark";

interface DesktopSettings {
  auto_lock_idle_minutes: number;
  autostart: boolean;
  global_shortcut: string;
  hide_dock: boolean;
  launch_hidden: boolean;
  native_notifications: boolean;
  require_unlock: boolean;
  theme_override: ThemeMode;
  tray_visible: boolean;
}

const EMPTY: DesktopSettings = {
  hide_dock: false,
  launch_hidden: false,
  autostart: false,
  native_notifications: true,
  global_shortcut: "CmdOrCtrl+Shift+P",
  require_unlock: false,
  auto_lock_idle_minutes: 15,
  theme_override: "system",
  tray_visible: true,
};

export default function DesktopAppSection() {
  const tDesk = useTranslations("settings.desktop_app_card");
  const [inDesktop, setInDesktop] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<DesktopSettings>(EMPTY);
  const [shortcutDraft, setShortcutDraft] = useState<string>(
    EMPTY.global_shortcut
  );
  const [saving, setSaving] = useState<string | null>(null);
  const [touchIdBusy, setTouchIdBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const statusTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- load ---------------------------------------------------------------

  useEffect(() => {
    setInDesktop(isDesktop());
    fetch("/api/settings/desktop")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body || typeof body !== "object") {
          return;
        }
        const next: DesktopSettings = {
          hide_dock: !!body.hide_dock,
          launch_hidden: !!body.launch_hidden,
          autostart: !!body.autostart,
          native_notifications: body.native_notifications !== false, // default true
          global_shortcut: String(
            body.global_shortcut ?? EMPTY.global_shortcut
          ),
          require_unlock: !!body.require_unlock,
          auto_lock_idle_minutes: Number.isFinite(body.auto_lock_idle_minutes)
            ? Number(body.auto_lock_idle_minutes)
            : EMPTY.auto_lock_idle_minutes,
          theme_override: ["system", "light", "dark"].includes(
            body.theme_override
          )
            ? (body.theme_override as ThemeMode)
            : "system",
          tray_visible: body.tray_visible !== false, // default true
        };
        setSettings(next);
        setShortcutDraft(next.global_shortcut);
        // Don't clobber an active accessibility-quick-toggle theme.
        //
        // Both this section's `theme_override` setting and the
        // accessibility quick-toggles popover write to the same
        // `data-theme-override` attribute on <html>. The pre-hydration
        // script in app/layout.tsx already applied the user's a11y
        // choice synchronously before paint; if we now call
        // applyThemeOverride('system') from the desktop bundle's
        // default, we'd silently remove that attribute and the user
        // would see their a11y theme reset on every refresh — which
        // is what was happening in Safari (and any browser, but Safari
        // exposes it most because its localStorage timing is tighter).
        // Only apply the desktop override when the user hasn't picked
        // a11y theme explicitly.
        let a11yTheme: string | null = null;
        try {
          a11yTheme = window.localStorage.getItem("a11y-quick-theme");
        } catch {
          /* private mode / blocked storage — fall through and apply
             the desktop default; nothing else to consult here. */
        }
        if (!a11yTheme) {
          applyThemeOverride(next.theme_override);
        }
      })
      .catch(() => {
        /* best-effort — fall back to EMPTY */
      });
  }, []);

  const flashStatus = useCallback((msg: string) => {
    setStatus(msg);
    if (statusTimeout.current) {
      clearTimeout(statusTimeout.current);
    }
    statusTimeout.current = setTimeout(() => setStatus(null), 2500);
  }, []);

  const persist = useCallback(
    async (
      patch: Partial<DesktopSettings>,
      key: string
    ): Promise<DesktopSettings | null> => {
      setSaving(key);
      try {
        const resp = await fetch("/api/settings/desktop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!resp.ok) {
          flashStatus(tDesk("status_save_failed_check"));
          return null;
        }
        const body = await resp.json();
        const next: DesktopSettings = { ...settings, ...patch, ...body };
        setSettings(next);
        return next;
      } catch (err) {
        console.warn("desktop settings POST failed:", err);
        flashStatus(tDesk("status_save_failed"));
        return null;
      } finally {
        setSaving(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
    [settings, flashStatus]
  );

  // ---- handlers -----------------------------------------------------------

  const onToggleHideDock = async (next: boolean) => {
    const ok = await persist({ hide_dock: next }, "hide_dock");
    if (ok) {
      await setDockVisibility(!next);
    }
  };

  const onToggleTrayVisible = async (next: boolean) => {
    const ok = await persist({ tray_visible: next }, "tray_visible");
    if (ok) {
      await setTrayVisible(next);
    }
  };

  const onToggleLaunchHidden = async (next: boolean) => {
    await persist({ launch_hidden: next }, "launch_hidden");
    // Nothing to apply live — this only affects subsequent boots.
  };

  const onToggleAutostart = async (next: boolean) => {
    await persist({ autostart: next }, "autostart");
    await setAutostart(next);
    const actual = await isAutostartEnabled();
    if (actual !== null && actual !== next) {
      flashStatus(
        next
          ? tDesk("status_autostart_blocked_on")
          : tDesk("status_autostart_blocked_off")
      );
    }
  };

  const onToggleNativeNotifications = async (next: boolean) => {
    await persist({ native_notifications: next }, "native_notifications");
    // The Rust-side watcher reads this on boot; runtime flipping requires
    // a restart for v1. Flash a hint so users know.
    flashStatus(
      next
        ? tDesk("status_native_notifs_on")
        : tDesk("status_native_notifs_off")
    );
  };

  const onToggleRequireUnlock = async (next: boolean) => {
    if (next) {
      const ok = await authenticateTouchId(tDesk("touchid_reason_enable"));
      if (ok === false) {
        flashStatus(tDesk("status_touchid_cancelled_unlock_off"));
        return;
      }
      if (ok === null) {
        flashStatus(tDesk("status_touchid_unavailable_unlock_off"));
        return;
      }
    }
    await persist({ require_unlock: next }, "require_unlock");
  };

  const onAutoLockChange = async (val: string) => {
    const n = Number.parseInt(val, 10);
    if (!Number.isFinite(n) || n < 0) {
      return;
    }
    await persist({ auto_lock_idle_minutes: n }, "auto_lock");
  };

  const onThemeChange = async (mode: ThemeMode) => {
    await persist({ theme_override: mode }, "theme");
    applyThemeOverride(mode);
  };

  const onSaveShortcut = async () => {
    const trimmed = shortcutDraft.trim();
    if (trimmed.length === 0 || trimmed.length > 64) {
      flashStatus(tDesk("status_shortcut_invalid"));
      return;
    }
    const ok = await persist({ global_shortcut: trimmed }, "shortcut");
    if (ok) {
      const bound = await registerGlobalShortcut(trimmed);
      flashStatus(
        bound
          ? tDesk("status_shortcut_updated")
          : tDesk("status_shortcut_unbound")
      );
    }
  };

  const onTestTouchId = async () => {
    setTouchIdBusy(true);
    try {
      const ok = await authenticateTouchId(tDesk("touchid_reason_test"));
      if (ok === true) {
        flashStatus(tDesk("status_touchid_succeeded"));
      } else if (ok === false) {
        flashStatus(tDesk("status_touchid_cancelled"));
      } else {
        flashStatus(tDesk("status_touchid_unavailable"));
      }
    } finally {
      setTouchIdBusy(false);
    }
  };

  const onCopyDiagnostics = async () => {
    const report = await getDiagnosticsReport();
    if (!report) {
      flashStatus(tDesk("status_diagnostics_failed"));
      return;
    }
    try {
      await navigator.clipboard.writeText(report);
      flashStatus(tDesk("status_diagnostics_copied_clipboard"));
    } catch {
      // Fallback: drop into a textarea the user can copy manually. Rare,
      // but the Tauri webview's clipboard permission might not be granted.
      const ta = document.createElement("textarea");
      ta.value = report;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      flashStatus(tDesk("status_diagnostics_copied"));
    }
  };

  // ---- render -------------------------------------------------------------

  if (inDesktop === null) {
    return null; // waiting on mount
  }
  if (!inDesktop) {
    return null; // running in a web browser, nothing to show
  }

  const disabled = (key: string) => saving === key;

  return (
    <section aria-labelledby="desktop-app-heading" className="settings-section">
      <h2 id="desktop-app-heading">{tDesk("heading")}</h2>
      <p className="muted">{tDesk("subhead")}</p>

      {/* --- Launch & window --------------------------------------------- */}
      <h3>{tDesk("section_launch")}</h3>

      <label className="settings-row">
        <input
          checked={settings.autostart}
          disabled={disabled("autostart")}
          onChange={(e) => onToggleAutostart(e.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>{tDesk("autostart_label")}</strong>
          <span className="muted block">{tDesk("autostart_help")}</span>
        </span>
      </label>

      <label className="settings-row">
        <input
          checked={settings.launch_hidden}
          disabled={disabled("launch_hidden")}
          onChange={(e) => onToggleLaunchHidden(e.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>{tDesk("launch_hidden_label")}</strong>
          <span className="muted block">{tDesk("launch_hidden_help")}</span>
        </span>
      </label>

      <label className="settings-row">
        <input
          checked={settings.hide_dock}
          disabled={disabled("hide_dock")}
          onChange={(e) => onToggleHideDock(e.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>{tDesk("hide_dock_label")}</strong>
          <span className="muted block">{tDesk("hide_dock_help")}</span>
        </span>
      </label>

      {/* Menu-bar tray icon — show/hide live. Default on. When off, the
          tray icon disappears from the macOS menu bar and the only way
          to bring the window back is via the Dock (or `open` from
          Terminal). The Node sidecar + scheduler keep running either
          way; this is purely about the visible affordance. */}
      <label className="settings-row">
        <input
          checked={settings.tray_visible}
          disabled={disabled("tray_visible")}
          onChange={(e) => onToggleTrayVisible(e.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>Show menu bar icon</strong>
          <span className="muted block">
            Display the privacytracker icon in the macOS menu bar so you can
            show / hide the window and trigger Sync now without opening the
            Dock. Disable to keep the menu bar uncluttered.
          </span>
        </span>
      </label>

      {/* --- Notifications ----------------------------------------------- */}
      <h3>{tDesk("section_notifications")}</h3>

      <label className="settings-row">
        <input
          checked={settings.native_notifications}
          disabled={disabled("native_notifications")}
          onChange={(e) => onToggleNativeNotifications(e.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>{tDesk("native_notifs_label")}</strong>
          <span className="muted block">{tDesk("native_notifs_help")}</span>
        </span>
      </label>

      {/* --- Global shortcut & URL scheme -------------------------------- */}
      <h3>{tDesk("section_keyboard")}</h3>

      <div className="settings-row">
        <label className="block" htmlFor="desktop-shortcut">
          <strong>{tDesk("shortcut_label")}</strong>
          <span className="muted block">
            {tDesk("shortcut_help_pre")}
            <code>CmdOrCtrl+Shift+P</code>
            {tDesk("shortcut_help_or")}
            <code>Alt+Space</code>
            {tDesk("shortcut_help_post")}
          </span>
        </label>
        <input
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled("shortcut")}
          id="desktop-shortcut"
          onChange={(e) => setShortcutDraft(e.target.value)}
          spellCheck={false}
          style={{ fontFamily: "monospace", minWidth: 240 }}
          type="text"
          value={shortcutDraft}
        />
        <button
          disabled={
            disabled("shortcut") ||
            shortcutDraft.trim() === settings.global_shortcut
          }
          onClick={onSaveShortcut}
          type="button"
        >
          {tDesk("shortcut_apply")}
        </button>
      </div>

      <p className="muted">
        {tDesk("url_scheme_pre")}
        <code>privacytracker://app/&lt;id&gt;</code>
        {tDesk("url_scheme_post")}
      </p>

      {/* --- Security ---------------------------------------------------- */}
      <h3>{tDesk("section_security")}</h3>

      <label className="settings-row">
        <input
          checked={settings.require_unlock}
          disabled={disabled("require_unlock")}
          onChange={(e) => onToggleRequireUnlock(e.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>{tDesk("require_unlock_label")}</strong>
          <span className="muted block">{tDesk("require_unlock_help")}</span>
        </span>
      </label>

      <div className="settings-row">
        <label htmlFor="auto-lock">
          <strong>{tDesk("auto_lock_label")}</strong>
          <span className="muted block">
            {tDesk("auto_lock_help_pre")}
            <code>0</code>
            {tDesk("auto_lock_help_post")}
          </span>
        </label>
        <input
          disabled={disabled("auto_lock") || !settings.require_unlock}
          id="auto-lock"
          max={1440}
          min={0}
          onChange={(e) => onAutoLockChange(e.target.value)}
          step={5}
          style={{ width: 80 }}
          type="number"
          value={settings.auto_lock_idle_minutes}
        />
        <button disabled={touchIdBusy} onClick={onTestTouchId} type="button">
          {touchIdBusy ? tDesk("touchid_waiting") : tDesk("touchid_test")}
        </button>
      </div>

      {/* --- Appearance -------------------------------------------------- */}
      <h3>{tDesk("section_appearance")}</h3>

      <div
        aria-labelledby="theme-heading"
        className="settings-row"
        role="radiogroup"
      >
        <span className="block" id="theme-heading">
          <strong>{tDesk("theme_label")}</strong>
        </span>
        {(["system", "light", "dark"] as ThemeMode[]).map((mode) => (
          <label key={mode} style={{ marginRight: 12 }}>
            <input
              checked={settings.theme_override === mode}
              disabled={disabled("theme")}
              name="theme-override"
              onChange={() => onThemeChange(mode)}
              type="radio"
              value={mode}
            />{" "}
            {mode === "system"
              ? tDesk("theme_system")
              : mode === "light"
                ? tDesk("theme_light")
                : tDesk("theme_dark")}
          </label>
        ))}
      </div>

      {/* --- Diagnostics -------------------------------------------------- */}
      <h3>{tDesk("section_diagnostics")}</h3>

      <div
        className="settings-row"
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <button
          onClick={() => {
            openDataDir();
          }}
          type="button"
        >
          {tDesk("show_data_folder")}
        </button>
        <button
          onClick={() => {
            openLogDir();
          }}
          type="button"
        >
          {tDesk("show_log_folder")}
        </button>
        <button onClick={onCopyDiagnostics} type="button">
          {tDesk("copy_diagnostics")}
        </button>
        <button
          onClick={() => {
            toggleDevtools();
          }}
          type="button"
        >
          {tDesk("toggle_devtools")}
        </button>
      </div>
      <p className="muted">
        {tDesk("diagnostics_help_pre")}
        <code>privacy.db</code>
        {tDesk("diagnostics_help_post")}
      </p>

      {status && (
        <p
          aria-live="polite"
          className="muted"
          role="status"
          style={{ marginTop: 16 }}
        >
          {status}
        </p>
      )}
    </section>
  );
}

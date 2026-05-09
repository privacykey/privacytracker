import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/scheduler';

/**
 * Desktop-shell settings.
 *
 * This route is the single source of truth for every desktop-only user
 * preference. The Tauri shell reads the whole bundle once on boot (see
 * src-tauri/src/settings.rs::fetch) to wire up the window, dock policy,
 * global shortcut, native notifications watcher, and Touch ID gate. The
 * settings UI also reads + writes it.
 *
 * The persisted keys live under the `desktop_*` namespace in the
 * `app_settings` key/value table. On the wire we expose a camelCased bundle
 * so Rust can derive it with one #[derive(Deserialize)] instead of
 * juggling snake_case keys.
 *
 *  GET  → {
 *    desktop_hide_dock, hide_dock,
 *    desktop_launch_hidden, launch_hidden,
 *    desktop_autostart, autostart,
 *    desktop_native_notifications, native_notifications,
 *    desktop_global_shortcut, global_shortcut,
 *    desktop_require_unlock, require_unlock,
 *    desktop_auto_lock_idle_minutes, auto_lock_idle_minutes,
 *    desktop_theme_override, theme_override,
 *  }
 *
 *  POST { <any subset of the keys above> } → persists whatever was sent
 *  and echoes the full current bundle back.
 *
 * The `desktop_*` aliases in the GET response are kept for backwards
 * compatibility with the original single-key shape (`desktop_hide_dock`)
 * — the DesktopAppSection component reads them at that name. New code
 * should use the short names (hide_dock, launch_hidden, …).
 */
export const dynamic = 'force-dynamic';

type DesktopSettings = {
  hide_dock: boolean;
  launch_hidden: boolean;
  autostart: boolean;
  native_notifications: boolean;
  global_shortcut: string;
  require_unlock: boolean;
  auto_lock_idle_minutes: number;
  theme_override: 'system' | 'light' | 'dark';
  /** Whether the user had the Web Inspector open last quit. The Rust
   *  shell reads this on boot (settings::fetch) and re-opens devtools
   *  if true, so devs don't have to keep re-opening the inspector
   *  every launch. commands::toggle_devtools (and the menu handler)
   *  POST the new state here after toggling. */
  devtools_open: boolean;
  /** Whether the menu-bar tray icon is visible. The Rust shell installs
   *  the tray unconditionally and flips visibility via
   *  tray.set_visible(...) based on this flag — both at boot
   *  (main.rs::setup) and live when the user toggles the switch in
   *  the desktop-app settings card. */
  tray_visible: boolean;
};

// Keep this in sync with src-tauri/src/settings.rs::DesktopSettings defaults.
const DEFAULTS: DesktopSettings = {
  hide_dock: false,
  launch_hidden: false,
  autostart: false,
  native_notifications: true,
  global_shortcut: 'CmdOrCtrl+Shift+P',
  require_unlock: false,
  auto_lock_idle_minutes: 15,
  theme_override: 'system',
  devtools_open: false,
  tray_visible: true,
};

// Map between UI-facing short names and the persisted app_settings keys.
// Keeping this in one place means we can add a new key in exactly one
// line (plus the type + defaults above).
const KEYS: Record<keyof DesktopSettings, string> = {
  hide_dock: 'desktop_hide_dock',
  launch_hidden: 'desktop_launch_hidden',
  autostart: 'desktop_autostart',
  native_notifications: 'desktop_native_notifications',
  global_shortcut: 'desktop_global_shortcut',
  require_unlock: 'desktop_require_unlock',
  auto_lock_idle_minutes: 'desktop_auto_lock_idle_minutes',
  theme_override: 'desktop_theme_override',
  devtools_open: 'desktop_devtools_open',
  tray_visible: 'desktop_tray_visible',
};

function readSetting<K extends keyof DesktopSettings>(key: K): DesktopSettings[K] {
  const raw = getSetting(KEYS[key], '');
  const def = DEFAULTS[key];
  if (raw === '') return def;
  switch (key) {
    case 'auto_lock_idle_minutes': {
      const n = parseInt(raw, 10);
      return (Number.isFinite(n) && n >= 0 && n <= 1440
        ? n
        : (def as number)) as DesktopSettings[K];
    }
    case 'global_shortcut':
      // Trust the string as-is; the Rust side parses it as a Tauri
      // accelerator and falls back to the default if malformed.
      return raw as DesktopSettings[K];
    case 'theme_override':
      return (['system', 'light', 'dark'].includes(raw) ? raw : def) as DesktopSettings[K];
    default:
      // Boolean keys.
      return (raw === 'true') as DesktopSettings[K];
  }
}

function writeSetting<K extends keyof DesktopSettings>(key: K, value: unknown): void {
  if (value === undefined || value === null) return;
  const defType = typeof DEFAULTS[key];
  if (key === 'auto_lock_idle_minutes') {
    const n = typeof value === 'number' ? value : parseInt(String(value), 10);
    if (!Number.isFinite(n) || n < 0 || n > 1440) return;
    setSetting(KEYS[key], String(Math.floor(n)));
    return;
  }
  if (key === 'global_shortcut') {
    if (typeof value !== 'string') return;
    // Basic shape check — Tauri accelerators are +-joined tokens. A deeper
    // validation lives on the Rust side (shortcut.parse()) and is the
    // authoritative one.
    if (value.length === 0 || value.length > 64) return;
    setSetting(KEYS[key], value);
    return;
  }
  if (key === 'theme_override') {
    if (value !== 'system' && value !== 'light' && value !== 'dark') return;
    setSetting(KEYS[key], String(value));
    return;
  }
  // Boolean-typed keys.
  if (defType === 'boolean') {
    setSetting(KEYS[key], value ? 'true' : 'false');
  }
}

function readAll(): DesktopSettings {
  return {
    hide_dock: readSetting('hide_dock'),
    launch_hidden: readSetting('launch_hidden'),
    autostart: readSetting('autostart'),
    native_notifications: readSetting('native_notifications'),
    global_shortcut: readSetting('global_shortcut'),
    require_unlock: readSetting('require_unlock'),
    auto_lock_idle_minutes: readSetting('auto_lock_idle_minutes'),
    theme_override: readSetting('theme_override'),
    devtools_open: readSetting('devtools_open'),
    tray_visible: readSetting('tray_visible'),
  };
}

function serialise(s: DesktopSettings): Record<string, unknown> {
  // Emit both the short name (new) and the desktop_* alias (old). Once
  // every caller is migrated the desktop_* forms can go away.
  return {
    ...s,
    desktop_hide_dock: s.hide_dock,
    desktop_launch_hidden: s.launch_hidden,
    desktop_autostart: s.autostart,
    desktop_native_notifications: s.native_notifications,
    desktop_global_shortcut: s.global_shortcut,
    desktop_require_unlock: s.require_unlock,
    desktop_auto_lock_idle_minutes: s.auto_lock_idle_minutes,
    desktop_theme_override: s.theme_override,
    desktop_devtools_open: s.devtools_open,
    desktop_tray_visible: s.tray_visible,
  };
}

function markDesktopRuntimeIfTrusted(req: NextRequest): void {
  if (
    process.env.PRIVACYTRACKER_RUNTIME === 'desktop' ||
    req.headers.get('x-privacytracker-runtime') === 'desktop'
  ) {
    setSetting('runtime_environment', 'desktop');
  }
}

export async function GET(req: NextRequest) {
  markDesktopRuntimeIfTrusted(req);
  return NextResponse.json(serialise(readAll()));
}

export async function POST(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'expected object body' }, { status: 400 });
  }
  const obj = body as Record<string, unknown>;

  for (const key of Object.keys(KEYS) as (keyof DesktopSettings)[]) {
    // Accept either "hide_dock" (new) or "desktop_hide_dock" (legacy).
    if (key in obj) writeSetting(key, obj[key]);
    const legacy = KEYS[key];
    if (legacy in obj) writeSetting(key, obj[legacy]);
  }

  return NextResponse.json(serialise(readAll()));
}

/**
 * Tiny client-side helper for "am I running inside the Tauri desktop shell,
 * and if so can I call into its Rust commands?"
 *
 * Kept framework-agnostic so both React components (SettingsView, AppGrid)
 * and any future utility can import without pulling Tauri's types when
 * rendered in the Docker/web deployment.
 *
 * Works against Tauri v2. Detection uses `window.__TAURI_INTERNALS__`
 * (set unconditionally by Tauri v2's IPC bootstrap) so it remains
 * accurate when `withGlobalTauri` is disabled in tauri.conf.json.
 * Invocation goes through a dynamic import of `@tauri-apps/api/core`,
 * which Next splits into a chunk only the Tauri build loads.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

let cachedInvoke: InvokeFn | null | undefined;

function getInvoke(): InvokeFn | null {
  if (typeof window === 'undefined') return null;
  if (!window.__TAURI_INTERNALS__) return null;
  if (cachedInvoke !== undefined) return cachedInvoke;
  cachedInvoke = (cmd, args) =>
    import('@tauri-apps/api/core').then(m => m.invoke(cmd, args ?? {}));
  return cachedInvoke;
}

/** `true` when the page is running inside the Tauri webview. */
export function isDesktop(): boolean {
  return getInvoke() !== null;
}

/**
 * Show/hide the macOS Dock icon. Resolves to `true` on success, `false` if
 * we're not in Tauri (or on a non-macOS host). Never throws — the toggle UI
 * is considered advisory.
 */
export async function setDockVisibility(visible: boolean): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    await invoke('set_dock_visibility', { visible });
    return true;
  } catch (err) {
    console.warn('set_dock_visibility failed:', err);
    return false;
  }
}

/** Open the per-user data folder in the OS file manager. */
export async function openDataDir(): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    await invoke('open_data_dir');
    return true;
  } catch (err) {
    console.warn('open_data_dir failed:', err);
    return false;
  }
}

/** Open the app log folder in the OS file manager. */
export async function openLogDir(): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    await invoke('open_log_dir');
    return true;
  } catch (err) {
    console.warn('open_log_dir failed:', err);
    return false;
  }
}

/** Toggle the Tauri webview devtools. No-op in release builds. */
export async function toggleDevtools(): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    await invoke('toggle_devtools');
    return true;
  } catch (err) {
    console.warn('toggle_devtools failed:', err);
    return false;
  }
}

/**
 * Ask the Rust side to re-register the global shortcut. Call this after
 * you've already POSTed the new value to /api/settings/desktop — the
 * Rust command just takes the accelerator string and rebinds.
 */
export async function registerGlobalShortcut(shortcut: string): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    await invoke('register_global_shortcut', { shortcut });
    return true;
  } catch (err) {
    console.warn('register_global_shortcut failed:', err);
    return false;
  }
}

/**
 * Pull the diagnostics report string from the Rust side. Returns null on
 * failure so the UI can disable the "Copy diagnostics" button gracefully.
 */
export async function getDiagnosticsReport(): Promise<string | null> {
  const invoke = getInvoke();
  if (!invoke) return null;
  try {
    const result = await invoke('get_diagnostics_report');
    return typeof result === 'string' ? result : null;
  } catch (err) {
    console.warn('get_diagnostics_report failed:', err);
    return null;
  }
}

/**
 * Trigger Touch ID / device-password authentication. Resolves to
 *   - true  on successful auth
 *   - false on user cancel
 *   - null  if authentication isn't available on this host (non-macOS,
 *           no biometrics/password set up, etc.) — caller should treat
 *           "unlock" as vacuously succeeded and display a hint.
 */
export async function authenticateTouchId(reason: string): Promise<boolean | null> {
  const invoke = getInvoke();
  if (!invoke) return null;
  try {
    const ok = await invoke('authenticate_touch_id', { reason });
    return Boolean(ok);
  } catch (err) {
    console.warn('authenticate_touch_id failed:', err);
    return null;
  }
}

/** Nudge the Dock badge to a specific count. */
export async function setDockBadge(count: number): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    await invoke('set_dock_badge', { count: Math.max(0, Math.floor(count)) });
    return true;
  } catch (err) {
    console.warn('set_dock_badge failed:', err);
    return false;
  }
}

/** Show or hide the menu-bar tray icon live. The tray is always
 *  installed at boot; this just calls TrayIcon::set_visible on the
 *  existing instance so the flip is instant. No-op on the web build
 *  (returns false when window.__TAURI__ is absent). */
export async function setTrayVisible(visible: boolean): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    await invoke('set_tray_visible', { visible });
    return true;
  } catch (err) {
    console.warn('set_tray_visible failed:', err);
    return false;
  }
}

/**
 * Returns the base URL the Node sidecar is listening on. In the Docker/web
 * build, this is undefined — callers should fall back to `location.origin`.
 */
export async function sidecarBaseUrl(): Promise<string | undefined> {
  const invoke = getInvoke();
  if (!invoke) return undefined;
  try {
    const url = await invoke('sidecar_base_url');
    return typeof url === 'string' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Autostart (start-at-login). Tauri's autostart plugin exposes these as
 * plugin-level commands under `plugin:autostart|enable|disable|is_enabled`
 * rather than our own handler, so route through those directly.
 */
export async function setAutostart(enabled: boolean): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    await invoke(enabled ? 'plugin:autostart|enable' : 'plugin:autostart|disable');
    return true;
  } catch (err) {
    console.warn('autostart toggle failed:', err);
    return false;
  }
}

export async function isAutostartEnabled(): Promise<boolean | null> {
  const invoke = getInvoke();
  if (!invoke) return null;
  try {
    const r = await invoke('plugin:autostart|is_enabled');
    return Boolean(r);
  } catch {
    return null;
  }
}

/**
 * Result of `check_cfgutil`. Mirrors the Rust `CfgutilCheck` struct. The UI
 * keeps every field nullable because any one of them might be missing on
 * older cfgutil builds — the important signal is `available`, backstopped
 * by `error` when things went wrong. Modern cfgutil builds do not all expose
 * a version command, so `version === null` can still be a healthy state.
 */
export interface CfgutilCheckResult {
  available: boolean;
  version: string | null;
  path: string | null;
  automationToolsInstalled: boolean;
  appInstalled: boolean;
  error: string | null;
  platform: 'macos' | 'windows' | 'linux' | 'unknown';
}

/**
 * Single row from `run_cfgutil_export`. Named to line up with the existing
 * `parseImportedAppRows` shape so the caller can pipe the result into the
 * Step-2 name list without a rename pass.
 */
export interface CfgutilApp {
  name: string;
  developer: string | null;
  bundleId: string | null;
  version: string | null;
}

export interface CfgutilExportResult {
  deviceCount: number;
  apps: CfgutilApp[];
  rawStdout: string;
}

/**
 * Ask the Rust side whether `cfgutil` is reachable on this Mac. Returns
 * `null` when we're not running inside the Tauri shell at all — callers
 * should treat that as "auto-import isn't an option on this platform,
 * render the manual CSV drop instead".
 */
export async function checkCfgutil(): Promise<CfgutilCheckResult | null> {
  const invoke = getInvoke();
  if (!invoke) return null;
  try {
    const raw = (await invoke('check_cfgutil')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return null;
    return normalizeCfgutilCheck(raw);
  } catch (err) {
    console.warn('check_cfgutil failed:', err);
    // Synthesize an error result so the UI can surface what happened without
    // collapsing back to "maybe it works, try again".
    return {
      available: false,
      version: null,
      path: null,
      automationToolsInstalled: false,
      appInstalled: false,
      error: err instanceof Error ? err.message : String(err),
      platform: 'unknown',
    };
  }
}

/**
 * Run `cfgutil --format JSON get installedApps`, parse it, and hand back
 * the deduped app list. Throws (rather than returning null) so the caller
 * can surface a specific error message — this command is only ever fired
 * after the user explicitly clicks "Export now", so they expect feedback.
 *
 * `ecid` is optional at the API boundary for backwards compatibility, but
 * the onboarding UI now picks a specific device first and passes it through.
 * That prevents a multi-device desk from importing a sibling phone by
 * accident.
 */
export async function runCfgutilExport(
  ecid?: string,
): Promise<CfgutilExportResult> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('Auto-import is only available in the desktop app.');
  }
  const raw = (await invoke(
    'run_cfgutil_export',
    ecid ? { ecid } : undefined,
  )) as Record<string, unknown>;
  return {
    deviceCount: typeof raw?.device_count === 'number' ? raw.device_count : 0,
    apps: Array.isArray(raw?.apps)
      ? (raw.apps as Array<Record<string, unknown>>).map(app => ({
          name: typeof app.name === 'string' ? app.name : '',
          developer: typeof app.developer === 'string' ? app.developer : null,
          bundleId: typeof app.bundle_id === 'string' ? app.bundle_id : null,
          version: typeof app.version === 'string' ? app.version : null,
        }))
      : [],
    rawStdout: typeof raw?.raw_stdout === 'string' ? raw.raw_stdout : '',
  };
}

/**
 * Single device row from `list_connected_devices`. Mirrors the Rust
 * `ConnectedDevice` struct. Every field except `ecid` is nullable —
 * older cfgutil builds, or a device that hasn't yet been "trusted" on
 * the Mac, can leave us with just the ECID and no descriptive
 * metadata. The toast component falls back to "an iOS device
 * connected" copy in that case.
 */
export interface ConnectedDevice {
  ecid: string;
  name: string | null;
  model: string | null;
  iosVersion: string | null;
  deviceClass: string | null;
}

export interface ConnectedDeviceList {
  devices: ConnectedDevice[];
  /**
   * True when cfgutil itself isn't reachable on this host. The webview
   * uses this to suppress polling silently — rather than spamming the
   * user with "cfgutil missing" once every 5 seconds, the toast
   * component just stops polling once it sees this flag.
   */
  cfgutilUnavailable: boolean;
}

/**
 * Lightweight "what devices are plugged in right now?" probe. Designed
 * to be polled — sub-second on a healthy device, returns an empty list
 * (rather than throwing) when nothing's connected. Returns `null` when
 * we're not running inside the Tauri shell at all so callers can skip
 * the poll loop on the web build.
 */
export async function listConnectedDevices(): Promise<ConnectedDeviceList | null> {
  const invoke = getInvoke();
  if (!invoke) return null;
  try {
    const raw = (await invoke('list_connected_devices')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') {
      return { devices: [], cfgutilUnavailable: false };
    }
    const devices: ConnectedDevice[] = Array.isArray(raw.devices)
      ? (raw.devices as Array<Record<string, unknown>>).map(d => ({
          ecid: typeof d.ecid === 'string' ? d.ecid : '',
          name: typeof d.name === 'string' ? d.name : null,
          model: typeof d.model === 'string' ? d.model : null,
          iosVersion: typeof d.ios_version === 'string' ? d.ios_version : null,
          deviceClass: typeof d.device_class === 'string' ? d.device_class : null,
        }))
      : [];
    return {
      devices: devices.filter(d => d.ecid.length > 0),
      cfgutilUnavailable: Boolean(raw.cfgutil_unavailable),
    };
  } catch (err) {
    console.warn('list_connected_devices failed:', err);
    // Quiet fail — same rationale as the Rust side. The toast component
    // treats this as "nothing to surface right now" rather than an error.
    return { devices: [], cfgutilUnavailable: false };
  }
}

/**
 * Result of a cfgutil device backup. The webview surfaces `ok` +
 * `backupPath` for the success case, and falls back to `error` for the
 * failure case. `log` is kept around for the diagnostics drawer.
 */
export interface CfgutilBackupResult {
  ok: boolean;
  ecid: string;
  backupPath: string | null;
  finishedAt: number | null;
  log: string;
  error: string | null;
}

/**
 * Result of a cfgutil app removal. As with the backup result, `ok` is
 * the truth; on failure the `error` string is human-readable copy
 * suitable to render directly in the wizard's per-row status column.
 */
export interface CfgutilRemoveResult {
  ok: boolean;
  ecid: string;
  bundleId: string;
  log: string;
  error: string | null;
}

/**
 * Run `cfgutil backup --backup-output <dest_dir>` against the device
 * with the given ECID. Synchronous from the caller's perspective —
 * the webview shows a progress modal while this is in flight.
 *
 * The destructive surface (uninstall) gates on a recent successful
 * backup, so this function is the precondition for any
 * `removeAppViaCfgutil` call. The Phase 3 wizard is the only caller.
 *
 * Returns a result with `ok: false` and `error: "Auto-import is only
 * available in the desktop app."` when called from the web build —
 * keeps the fallback behaviour symmetric with the wizard's error UI.
 */
export async function backupDeviceViaCfgutil(
  ecid: string,
  destDir: string,
): Promise<CfgutilBackupResult> {
  const invoke = getInvoke();
  if (!invoke) {
    return {
      ok: false,
      ecid,
      backupPath: null,
      finishedAt: null,
      log: '',
      error: 'Backups via cfgutil are only available in the desktop app.',
    };
  }
  try {
    const raw = (await invoke('run_cfgutil_backup', { ecid, destDir })) as Record<
      string,
      unknown
    >;
    return normalizeCfgutilBackup(raw, ecid);
  } catch (err) {
    return {
      ok: false,
      ecid,
      backupPath: null,
      finishedAt: null,
      log: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove an app from a connected device. Single bundle ID per call —
 * there is intentionally no batch path. The caller is responsible for
 * having walked the user through:
 *
 *   1. Auditing their verdicts (their own user-source verdict must be
 *      'uninstall' — imported recommendations alone are not enough).
 *   2. Running a fresh backup via {@link backupDeviceViaCfgutil}.
 *   3. A per-app type-DELETE confirmation modal.
 *
 * The Rust command does input validation (ECID + bundleId character
 * sets) but trusts that the audience+flag gate has been satisfied
 * upstream. The wizard component carries that responsibility.
 */
export async function removeAppViaCfgutil(
  ecid: string,
  bundleId: string,
): Promise<CfgutilRemoveResult> {
  const invoke = getInvoke();
  if (!invoke) {
    return {
      ok: false,
      ecid,
      bundleId,
      log: '',
      error: 'Uninstall via cfgutil is only available in the desktop app.',
    };
  }
  try {
    const raw = (await invoke('run_cfgutil_remove_app', { ecid, bundleId })) as Record<
      string,
      unknown
    >;
    return normalizeCfgutilRemove(raw, ecid, bundleId);
  } catch (err) {
    return {
      ok: false,
      ecid,
      bundleId,
      log: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeCfgutilBackup(
  raw: Record<string, unknown>,
  ecid: string,
): CfgutilBackupResult {
  return {
    ok: Boolean(raw?.ok),
    ecid: typeof raw?.ecid === 'string' ? raw.ecid : ecid,
    backupPath: typeof raw?.backup_path === 'string' ? raw.backup_path : null,
    finishedAt: typeof raw?.finished_at === 'number' ? raw.finished_at : null,
    log: typeof raw?.log === 'string' ? raw.log : '',
    error: typeof raw?.error === 'string' ? raw.error : null,
  };
}

function normalizeCfgutilRemove(
  raw: Record<string, unknown>,
  ecid: string,
  bundleId: string,
): CfgutilRemoveResult {
  return {
    ok: Boolean(raw?.ok),
    ecid: typeof raw?.ecid === 'string' ? raw.ecid : ecid,
    bundleId: typeof raw?.bundle_id === 'string' ? raw.bundle_id : bundleId,
    log: typeof raw?.log === 'string' ? raw.log : '',
    error: typeof raw?.error === 'string' ? raw.error : null,
  };
}

function normalizeCfgutilCheck(raw: Record<string, unknown>): CfgutilCheckResult {
  const platform =
    raw.platform === 'macos' || raw.platform === 'windows' || raw.platform === 'linux'
      ? raw.platform
      : 'unknown';
  return {
    available: Boolean(raw.available),
    version: typeof raw.version === 'string' ? raw.version : null,
    path: typeof raw.path === 'string' ? raw.path : null,
    automationToolsInstalled: Boolean(raw.automation_tools_installed),
    appInstalled: Boolean(raw.app_installed),
    error: typeof raw.error === 'string' ? raw.error : null,
    platform,
  };
}

/** Apple Configurator's App Store product id. Used to open the listing
 *  directly via the `macappstore://` scheme so users don't have to search. */
export const APPLE_CONFIGURATOR_APP_STORE_ID = '1037126344';

/** Apple Configurator's App Store URL. The `macappstore://` variant below
 *  opens the App Store app on macOS; the https variant is the fallback for
 *  when the protocol handler isn't registered (shouldn't happen on stock
 *  macOS, but we keep it in case the user is running a stripped-down image). */
export const APPLE_CONFIGURATOR_MACAPPSTORE_URL =
  'macappstore://apps.apple.com/app/apple-configurator-2/id1037126344';
export const APPLE_CONFIGURATOR_HTTPS_URL =
  'https://apps.apple.com/app/apple-configurator-2/id1037126344';

/** Apply the user's theme-override choice to the current document.
 *
 * Accepts `high-contrast` in addition to the classic light/dark/system modes
 * so the accessibility quick-toggles popover can cycle through a true HC
 * palette (pure B&W + yellow focus rings) without bypassing the normal
 * data-theme-override attribute machinery. The DesktopAppSection UI still
 * only exposes system/light/dark — the HC option is surfaced through the
 * footer toggles.
 */
export function applyThemeOverride(
  mode: 'system' | 'light' | 'dark' | 'high-contrast',
): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.removeAttribute('data-theme-override');
  if (mode === 'light' || mode === 'dark' || mode === 'high-contrast') {
    html.setAttribute('data-theme-override', mode);
  }
}

/**
 * Deep-link into the macOS System Settings → Accessibility pane. Returns
 * `true` if the URL was handed off to the shell, `false` otherwise (non-
 * Tauri, non-macOS, or the plugin call errored). Uses the documented
 * `x-apple.systempreferences:com.apple.preference.universalaccess` URL
 * scheme, which macOS resolves to the Accessibility pane regardless of
 * macOS 13+ "System Settings" vs. legacy "System Preferences" branding.
 *
 * In the browser build this is a no-op — callers should hide the trigger
 * when `isDesktop()` returns false.
 */
export async function openMacAccessibilitySettings(): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    // The Tauri v2 opener / shell plugin exposes the canonical `open` command
    // under `plugin:opener|open_url`. Passing a URL with the
    // `x-apple.systempreferences` scheme asks macOS to route to the right
    // pane directly.
    await invoke('plugin:opener|open_url', {
      url: 'x-apple.systempreferences:com.apple.preference.universalaccess',
    });
    return true;
  } catch (err) {
    // Fall back to the shell plugin's `plugin:shell|open` command (older
    // plugin surface) before giving up.
    try {
      await invoke('plugin:shell|open', {
        path: 'x-apple.systempreferences:com.apple.preference.universalaccess',
      });
      return true;
    } catch (err2) {
      console.warn('openMacAccessibilitySettings failed:', err, err2);
      return false;
    }
  }
}

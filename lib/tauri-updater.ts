/**
 * Client-only wrapper around `@tauri-apps/plugin-updater`. Safe to import
 * from any client component — outside Tauri, every call resolves to a
 * no-op (`available: false` / `installed: false`) so the UI shape stays
 * the same across deployments. Tauri's plugin imports are dynamic so
 * Next's `next build` stays happy and the web bundle stays clean.
 */

'use client';

/** Whether we're running inside a Tauri webview. */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  // Tauri v2 exposes __TAURI_INTERNALS__; v1 used __TAURI__. Either signal
  // is enough to attempt the plugin import.
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

/** What `checkAndInstall` reports back to the UI. */
export interface TauriUpdateResult {
  /** True if Tauri reported an update is available. */
  available: boolean;
  /** True if download + install succeeded (relaunch follows). */
  installed: boolean;
  /** Version string Tauri sees as latest, if any. */
  version?: string;
  /** Release notes Tauri parsed out of the manifest, if any. */
  notes?: string;
  /** Error string if anything threw. UI surfaces verbatim. */
  error?: string;
}

/**
 * Checks for an update via Tauri's updater plugin and (if found) downloads,
 * installs, and relaunches. Outside Tauri, returns `{ available: false,
 * installed: false }` so the UI falls back to manual instructions.
 */
export async function checkAndInstall(): Promise<TauriUpdateResult> {
  if (!isTauri()) return { available: false, installed: false };

  try {
    // Dynamic import — Next splits this into its own chunk that only the
    // Tauri build loads. The catch swallows resolution failures gracefully.
    const updater = await import('@tauri-apps/plugin-updater');
    const proc = await import('@tauri-apps/plugin-process');

    const update = await updater.check();
    if (!update?.available) {
      return { available: false, installed: false };
    }

    await update.downloadAndInstall();
    // relaunch() drops the current webview — any in-flight state writes
    // or fetches behind it are lost.
    await proc.relaunch();
    return {
      available: true,
      installed: true,
      version: update.version,
      notes: update.body,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      available: false,
      installed: false,
      error: msg,
    };
  }
}

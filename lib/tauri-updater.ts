/**
 * Client-only wrapper around `@tauri-apps/plugin-updater`. Safe to import
 * from any client component — outside Tauri, every call resolves to a
 * no-op (`available: false` / `installed: false`) so the UI shape stays
 * the same across deployments. Tauri's plugin imports are dynamic so
 * Next's `next build` stays happy and the web bundle stays clean.
 */

'use client';

import { compareVersions } from './semver-compare';
import packageJson from '../package.json';

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

    // Downgrade protection. Tauri's ed25519 signature check verifies
    // authenticity but not freshness — a GitHub-repo compromise (without
    // the minisign key) could re-promote a previously-signed older
    // build as `latest` and we'd otherwise install it on next launch.
    // Refuse anything whose version isn't strictly newer than the
    // running app.
    const current = packageJson.version;
    if (typeof update.version === 'string' && compareVersions(update.version, current) <= 0) {
      return {
        available: false,
        installed: false,
        version: update.version,
        error: `Refusing to install ${update.version} — current version is ${current} (downgrade blocked).`,
      };
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

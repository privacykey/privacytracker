/**
 * Client-only wrapper around `@tauri-apps/plugin-updater`. Safe to import
 * from any client component — outside Tauri, every call resolves to a
 * no-op (`available: false` / `installed: false`) so the UI shape stays
 * the same across deployments. Tauri's plugin imports are dynamic so
 * Next's `next build` stays happy and the web bundle stays clean.
 */

"use client";

import packageJson from "../package.json";
import { compareVersions } from "./semver-compare";

/** Whether we're running inside a Tauri webview. */
export function isTauri(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  // Tauri v2 exposes __TAURI_INTERNALS__; v1 used __TAURI__. Either signal
  // is enough to attempt the plugin import.
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

/** What `checkAndInstall` reports back to the UI. */
export interface TauriUpdateResult {
  /** True if Tauri reported an update is available. */
  available: boolean;
  /**
   * Error string if the check, download or install threw. UI surfaces
   * verbatim. Never set once the update is installed: a relaunch that
   * fails after that is reported in `relaunchError`.
   */
  error?: string;
  /** True if download + install succeeded, whether or not the relaunch did. */
  installed: boolean;
  /** Release notes Tauri parsed out of the manifest, if any. */
  notes?: string;
  /**
   * Set when the update installed but the automatic relaunch failed. The
   * new version is already on disk and starts on the next launch, so the
   * UI asks for a restart instead of reporting a failed install.
   */
  relaunchError?: string;
  /** Version string Tauri sees as latest, if any. */
  version?: string;
}

/** Tauri's invoke() rejects with a plain string; most other failures are Errors. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * What the shell's `install_verified_update` command resolves with
 * (src-tauri/src/update_guard.rs): the version of the bundle it installed,
 * read from the bundle on disk, and the version that is running.
 */
interface VerifiedInstall {
  installedVersion: string;
  runningVersion: string;
}

function isVerifiedInstall(value: unknown): value is VerifiedInstall {
  const v = value as Partial<VerifiedInstall> | null;
  return (
    typeof v?.installedVersion === "string" &&
    typeof v.runningVersion === "string"
  );
}

/**
 * Checks for an update via Tauri's updater plugin and (if found) downloads,
 * installs, and relaunches. Outside Tauri, returns `{ available: false,
 * installed: false }` so the UI falls back to manual instructions. A
 * relaunch failure after a successful install still reports `installed:
 * true`, with the reason in `relaunchError`.
 *
 * The install goes through the shell's `install_verified_update` command,
 * not the plugin's own `downloadAndInstall()`. The version in the update
 * manifest is not signed (the signature covers only the archive), so the
 * shell reads the version from the signed archive, installs only if it is
 * newer than the running app, and reads it again from the installed
 * bundle. The page is granted the plugin's `check` alone.
 */
export async function checkAndInstall(): Promise<TauriUpdateResult> {
  if (!isTauri()) {
    return { available: false, installed: false };
  }

  try {
    // Dynamic import — Next splits this into its own chunk that only the
    // Tauri build loads. The catch swallows resolution failures gracefully.
    const updater = await import("@tauri-apps/plugin-updater");
    const proc = await import("@tauri-apps/plugin-process");
    const { invoke } = await import("@tauri-apps/api/core");

    const update = await updater.check();
    if (!update?.available) {
      return { available: false, installed: false };
    }

    // A manifest that doesn't even claim a newer version is refused before
    // anything is downloaded. Its claim proves nothing on its own: the
    // shell checks the version inside the signed archive below.
    const current = packageJson.version;
    if (
      typeof update.version === "string" &&
      compareVersions(update.version, current) <= 0
    ) {
      return {
        available: false,
        installed: false,
        version: update.version,
        error: `The update offered is version ${update.version}, which is not newer than the version you are running (${current}). It was not installed.`,
      };
    }

    const verified = await invoke("install_verified_update", {
      rid: update.rid,
    });
    // The shell has refused anything that isn't newer. Relaunching is what
    // would start an older build, so check its answer again before that.
    if (!isVerifiedInstall(verified)) {
      return {
        available: true,
        installed: false,
        version: update.version,
        error:
          "privacytracker could not confirm which version was installed, so it did not restart. Download the current version from the releases page and install it again.",
      };
    }
    if (
      compareVersions(verified.installedVersion, verified.runningVersion) <= 0
    ) {
      return {
        available: true,
        installed: false,
        version: verified.installedVersion,
        error: `The update that was installed is version ${verified.installedVersion}, which is not newer than the version you are running (${verified.runningVersion}), so privacytracker did not restart. Download the current version from the releases page and install it again.`,
      };
    }
    const installed: TauriUpdateResult = {
      available: true,
      installed: true,
      version: verified.installedVersion,
      notes: update.body,
    };
    try {
      // relaunch() drops the current webview — any in-flight state writes
      // or fetches behind it are lost. It can resolve just before the
      // process exits, so the caller may still paint this result briefly.
      await proc.relaunch();
    } catch (e) {
      // The new version is already installed; only the restart failed.
      // Reporting that as a failed install would send the user off to
      // download an update they already have.
      return { ...installed, relaunchError: errorMessage(e) };
    }
    return installed;
  } catch (e) {
    return {
      available: false,
      installed: false,
      error: errorMessage(e),
    };
  }
}

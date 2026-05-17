"use client";

/**
 * UpdateBanner — top-of-page banner that surfaces an available app update
 * and offers a deployment-aware call-to-action.
 *
 * Polls /api/update-status every 30 min to pick up newly-detected updates
 * without requiring a page refresh. The actual GitHub fetch happens in
 * `lib/update-check.ts` (server-side, cached 24h), so this poll is cheap —
 * it just reads the cached status from `app_settings`.
 *
 * Per-version dismiss: if the user clicks "Not now" we stash the latest
 * version in localStorage and stay quiet until a *newer* version shows up.
 * The next release re-arms the banner. Persists in localStorage rather
 * than the DB because dismissal is a per-device UX preference, not a
 * shared application setting.
 *
 * Mounted once in app/layout.tsx. The banner renders nothing when there's
 * no update, the check is disabled, or the user dismissed this version.
 *
 * Deployment-aware CTAs:
 *   - tauri:    "Install update" → calls into lib/tauri-updater
 *   - docker:   "View release" + copy-paste compose-pull command
 *   - homebrew: "View release" + copy-paste `brew upgrade` command
 *   - node:     "View release" + git pull / npm install hint
 *
 * The banner intentionally does NOT do anything destructive automatically.
 * Even on Tauri the install requires a click — surprise restarts in the
 * middle of a privacy-label diff would be a bad day.
 */

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkAndInstall,
  isTauri as isTauriRuntime,
  type TauriUpdateResult,
} from "@/lib/tauri-updater";

type DeploymentRuntime = "docker" | "tauri" | "homebrew" | "node" | "unknown";

interface UpdateStatusResponse {
  currentVersion: string;
  enabled: boolean;
  lastChecked: number;
  lastError: string | null;
  latestNotes: string | null;
  latestPublishedAt: string | null;
  latestUrl: string | null;
  latestVersion: string | null;
  runtime: DeploymentRuntime;
  updateAvailable: boolean;
}

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 min — banner UX, not a check
const DISMISS_KEY = "update-banner-dismissed-version";
const STATUS_URL = "/api/update-status";

export default function UpdateBanner() {
  const tBanner = useTranslations("update_banner");
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [installState, setInstallState] = useState<
    "idle" | "installing" | "done" | "error"
  >("idle");
  const [installError, setInstallError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  // Track whether we've mounted on the client. The server can't know if
  // the user is in Tauri (no DOM) so the runtime resolution is deferred
  // until after hydration to avoid a mismatch flicker.
  const [mounted, setMounted] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Mount + dismiss bootstrap ─────────────────────────────────────
  useEffect(() => {
    setMounted(true);
    try {
      setDismissedVersion(localStorage.getItem(DISMISS_KEY));
    } catch {
      // Safari private mode / blocked storage — treat as not dismissed.
    }
  }, []);

  // ─── Poll status ───────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(STATUS_URL, { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as UpdateStatusResponse;
      setStatus(json);
    } catch {
      // Network blip — keep whatever we last saw. The next poll retries.
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [fetchStatus]);

  // ─── Effective runtime: server best-guess, overridden by Tauri probe ─
  // The server reports 'docker' / 'homebrew' / 'node'. Tauri can only be
  // detected from the client (window.__TAURI__), so we override here.
  const effectiveRuntime: DeploymentRuntime = useMemo(() => {
    if (!(mounted && status)) {
      return status?.runtime ?? "unknown";
    }
    if (isTauriRuntime()) {
      return "tauri";
    }
    return status.runtime;
  }, [mounted, status]);

  // Dep array uses the full `status` object rather than `status?.latestVersion`
  // so the React Compiler can preserve its memoization. The Compiler's static
  // analysis can't track the optional-chain to `latestVersion` precisely
  // enough to match a hand-written narrower dep, and a mismatch surfaces as
  // a "Compilation Skipped: existing manual memoization could not be
  // preserved" lint warning. The behavioural difference is tiny — `status`
  // changes about as often as `status.latestVersion` does in practice (they
  // come from the same /api/update-status response body), so re-creating
  // the callback on every status change is effectively free.
  const handleDismiss = useCallback(() => {
    if (!status?.latestVersion) {
      return;
    }
    try {
      localStorage.setItem(DISMISS_KEY, status.latestVersion);
    } catch {
      /* ignore */
    }
    setDismissedVersion(status.latestVersion);
  }, [status]);

  const handleTauriInstall = useCallback(async () => {
    setInstallState("installing");
    setInstallError(null);
    const result: TauriUpdateResult = await checkAndInstall();
    if (result.installed) {
      setInstallState("done");
      // The relaunch() call inside checkAndInstall will wipe this view
      // before this state ever paints. Setting it anyway for the case
      // where Tauri reports installed but defers the restart.
    } else if (result.error) {
      setInstallState("error");
      setInstallError(result.error);
    } else {
      // No update available per Tauri (could happen if the GitHub cache
      // is stale relative to Tauri's manifest poll — rare but possible).
      setInstallState("idle");
    }
  }, []);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      // No clipboard permission — the command stays visible in the
      // banner so users can still select+copy manually.
    }
  }, []);

  // ─── Render gates ──────────────────────────────────────────────────
  if (!(mounted && status)) {
    return null;
  }
  if (!status.enabled) {
    return null;
  }
  if (!status.updateAvailable) {
    return null;
  }
  if (status.latestVersion && status.latestVersion === dismissedVersion) {
    return null;
  }

  const upgradeCommand = upgradeCommandFor(effectiveRuntime);

  return (
    <div aria-live="polite" className="update-banner" role="status">
      <div className="update-banner__inner">
        <div className="update-banner__copy">
          <span className="update-banner__label">{tBanner("label")}</span>
          <span className="update-banner__summary">
            {tBanner("summary", {
              latest: status.latestVersion ?? "",
              current: status.currentVersion,
            })}
          </span>
          {status.latestUrl && (
            <a
              className="update-banner__link"
              href={status.latestUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {tBanner("release_notes")}
            </a>
          )}
        </div>

        <div className="update-banner__actions">
          {effectiveRuntime === "tauri" && (
            <button
              className="update-banner__cta update-banner__cta--primary"
              disabled={installState === "installing"}
              onClick={handleTauriInstall}
              type="button"
            >
              {installState === "installing"
                ? tBanner("installing")
                : installState === "error"
                  ? tBanner("try_again")
                  : tBanner("install_restart")}
            </button>
          )}

          {upgradeCommand && (
            <div className="update-banner__cmd-row">
              <code className="update-banner__cmd">{upgradeCommand}</code>
              <button
                aria-label={tBanner("copy_aria", { cmd: upgradeCommand })}
                className="update-banner__cta update-banner__cta--ghost"
                onClick={() => handleCopy(upgradeCommand)}
                type="button"
              >
                {copyState === "copied" ? tBanner("copied") : tBanner("copy")}
              </button>
            </div>
          )}

          <button
            aria-label={tBanner("dismiss_aria", {
              version: status.latestVersion ?? "",
            })}
            className="update-banner__cta update-banner__cta--ghost"
            onClick={handleDismiss}
            type="button"
          >
            {tBanner("not_now")}
          </button>
        </div>

        {installState === "error" && installError && (
          <p className="update-banner__error" role="alert">
            {tBanner("install_failed_pre", { message: installError })}
            {status.latestUrl ? (
              <a
                href={status.latestUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {tBanner("download_manually_link")}
              </a>
            ) : (
              tBanner("download_manually_no_link")
            )}
            {tBanner("install_failed_post")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Returns the most useful copy-paste command for each deployment, or
 * `null` if the deployment doesn't have one (Tauri uses an in-app
 * button, not a shell command).
 */
function upgradeCommandFor(runtime: DeploymentRuntime): string | null {
  switch (runtime) {
    case "docker":
      return "docker compose pull && docker compose up -d";
    case "homebrew":
      return "brew upgrade privacykey/tap/privacytracker";
    case "node":
      return "git pull && npm install && npm run build";
    default:
      return null;
  }
}

"use client";

/**
 * Deployment Diagnostics + the session admin token: the diagnostics
 * snapshot with its locked state, the unlock/clear token flow, the
 * support-bundle copy, and the cross-tab ADMIN_TOKEN_CHANGED_EVENT
 * listener.
 *
 * `loadBackupSnapshots` comes in as an input because unlocking the admin
 * token opens two gates at once — diagnostics AND the backup snapshot
 * list — and the backup subsystem lives in its own hook (use-backup).
 * That re-pull is the one deliberate edge between the two.
 */

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ADMIN_TOKEN_CHANGED_EVENT } from "@/app/components/AdminTokenBridge";
import type { DeploymentDiagnostics } from "@/app/components/settings/types";

export function useDeployment({
  showToast,
  loadBackupSnapshots,
}: {
  showToast: (msg: string) => void;
  loadBackupSnapshots: () => Promise<void>;
}) {
  const tDeploy = useTranslations("settings.deployment_diagnostics_card");

  const [deploymentDiagnostics, setDeploymentDiagnostics] =
    useState<DeploymentDiagnostics | null>(null);
  const [deploymentDiagnosticsLoading, setDeploymentDiagnosticsLoading] =
    useState(false);
  const [deploymentDiagnosticsError, setDeploymentDiagnosticsError] =
    useState("");
  /**
   * True when GET /api/deployment/diagnostics was rejected by the proxy's
   * non-local admin gate (401/403) rather than failing on its own. Renders
   * the unlock form instead of the generic "unable to load" card — the
   * diagnostics card is the login destination every blocked surface links
   * to, so it must stay usable while locked.
   */
  const [deploymentDiagnosticsLocked, setDeploymentDiagnosticsLocked] =
    useState(false);
  const [copyingDeploymentDiagnostics, setCopyingDeploymentDiagnostics] =
    useState(false);
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [adminTokenUnlocked, setAdminTokenUnlocked] = useState(false);
  /**
   * Whether AUDITOR_ADMIN_TOKEN is configured server-side, read from the
   * gate-exempt /api/auth/admin-token/status endpoint so it's available
   * even while the diagnostics payload itself is locked. Defaults true so
   * the unlock form doesn't flash out while the status call is in flight.
   */
  const [adminTokenConfigured, setAdminTokenConfigured] = useState(true);

  const loadDeploymentDiagnostics = async () => {
    setDeploymentDiagnosticsLoading(true);
    try {
      const res = await fetch("/api/deployment/diagnostics", {
        cache: "no-store",
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // The proxy's non-local admin gate, not a server failure. Flip
          // the locked state so the section renders the unlock form —
          // every blocked surface links here to log in, so a dead
          // "unable to load" card would strand the user.
          setDeploymentDiagnosticsLocked(true);
          setDeploymentDiagnostics(null);
          setDeploymentDiagnosticsError("");
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as DeploymentDiagnostics;
      setDeploymentDiagnostics(data);
      setDeploymentDiagnosticsLocked(false);
      setDeploymentDiagnosticsError("");
    } catch (error) {
      console.warn("[settings] loadDeploymentDiagnostics failed:", error);
      setDeploymentDiagnosticsError(tDeploy("load_failed"));
    } finally {
      setDeploymentDiagnosticsLoading(false);
    }
  };

  const refreshAdminUnlockState = async () => {
    try {
      const res = await fetch("/api/auth/admin-token/status", {
        cache: "no-store",
      });
      if (!res.ok) {
        setAdminTokenUnlocked(false);
        return;
      }
      const data = (await res.json()) as {
        configured?: boolean;
        unlocked?: boolean;
      };
      setAdminTokenConfigured(Boolean(data.configured));
      setAdminTokenUnlocked(Boolean(data.unlocked));
    } catch {
      setAdminTokenUnlocked(false);
    }
  };

  const saveSessionAdminToken = async () => {
    const token = adminTokenInput.trim();
    if (!token) {
      return;
    }
    try {
      const res = await fetch("/api/auth/admin-token/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        showToast(tDeploy("admin_unlock_failed"));
        return;
      }
      window.dispatchEvent(new Event(ADMIN_TOKEN_CHANGED_EVENT));
      setAdminTokenInput("");
      setAdminTokenUnlocked(true);
      showToast(tDeploy("admin_unlock_saved"));
      // The gate just opened — re-pull the data it was hiding so the
      // section populates without a manual refresh.
      void loadDeploymentDiagnostics();
      void loadBackupSnapshots();
    } catch {
      showToast(tDeploy("admin_unlock_failed"));
    }
  };

  const clearSessionAdminToken = async () => {
    try {
      await fetch("/api/auth/admin-token/logout", { method: "POST" });
      window.dispatchEvent(new Event(ADMIN_TOKEN_CHANGED_EVENT));
    } catch {
      /* no-op */
    }
    setAdminTokenUnlocked(false);
    setAdminTokenInput("");
    showToast(tDeploy("admin_unlock_cleared"));
  };

  const writeClipboardText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };

  const copyDeploymentSupportBundle = async () => {
    if (copyingDeploymentDiagnostics) {
      return;
    }
    setCopyingDeploymentDiagnostics(true);
    try {
      const res = await fetch("/api/deployment/support-bundle", {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const bundle = await res.json();
      await writeClipboardText(JSON.stringify(bundle, null, 2));
      showToast(tDeploy("copy_success"));
    } catch (error) {
      console.warn("[settings] copyDeploymentSupportBundle failed:", error);
      showToast(tDeploy("copy_failed"));
    } finally {
      setCopyingDeploymentDiagnostics(false);
    }
  };

  useEffect(() => {
    refreshAdminUnlockState();
    window.addEventListener(ADMIN_TOKEN_CHANGED_EVENT, refreshAdminUnlockState);
    return () =>
      window.removeEventListener(
        ADMIN_TOKEN_CHANGED_EVENT,
        refreshAdminUnlockState
      );
  }, []);
  // Self-loading on mount, like the other subsystem hooks.
  useEffect(() => {
    void loadDeploymentDiagnostics();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once effect
  }, []);

  return {
    deploymentDiagnostics,
    setDeploymentDiagnostics,
    deploymentDiagnosticsLoading,
    setDeploymentDiagnosticsLoading,
    deploymentDiagnosticsError,
    setDeploymentDiagnosticsError,
    deploymentDiagnosticsLocked,
    setDeploymentDiagnosticsLocked,
    copyingDeploymentDiagnostics,
    setCopyingDeploymentDiagnostics,
    adminTokenInput,
    setAdminTokenInput,
    adminTokenUnlocked,
    setAdminTokenUnlocked,
    adminTokenConfigured,
    setAdminTokenConfigured,
    loadDeploymentDiagnostics,
    refreshAdminUnlockState,
    saveSessionAdminToken,
    clearSessionAdminToken,
    writeClipboardText,
    copyDeploymentSupportBundle,
  };
}

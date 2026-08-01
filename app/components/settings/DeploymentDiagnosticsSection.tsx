"use client";

/**
 * Deployment Diagnostics card — what this install actually is: version,
 * runtime (desktop vs web vs container), DB path and writability, proxy
 * and TLS detection, plus the per-check verdicts.
 *
 * Most of it is read-only, but it doubles as the admin-token unlock
 * surface: the diagnostics endpoint is token-gated, so when the server
 * has a token configured and this session doesn't hold it, the card
 * renders a locked state with an unlock field instead of the data. That
 * is why the token props live here rather than in a separate section.
 *
 * Anchor id `deployment-diagnostics` matches the SettingsSidebar entry —
 * see ./README.md.
 */

import { useTranslations } from "next-intl";
import { fmtBytes } from "./format";
import type { DeploymentDiagnostics } from "./types";

export default function DeploymentDiagnosticsSection({
  diagnostics,
  loading,
  error,
  locked,
  onReload,
  copying,
  onCopySupportBundle,
  adminTokenConfigured,
  adminTokenUnlocked,
  adminTokenInput,
  setAdminTokenInput,
  onSaveAdminToken,
  onClearAdminToken,
}: {
  diagnostics: DeploymentDiagnostics | null;
  loading: boolean;
  error: string | null;
  /** True when the endpoint answered 401 — the card shows the unlock
   *  field instead of the (unavailable) data. */
  locked: boolean;
  onReload: () => void;
  copying: boolean;
  onCopySupportBundle: () => void;
  adminTokenConfigured: boolean;
  adminTokenUnlocked: boolean;
  adminTokenInput: string;
  setAdminTokenInput: (next: string) => void;
  onSaveAdminToken: () => void;
  onClearAdminToken: () => void;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tDeploy = useTranslations("settings.deployment_diagnostics_card");

  return (
    <div className="settings-section" id="deployment-diagnostics">
      <h2 className="settings-section-title">
        {tSections("deployment_diagnostics")}
      </h2>
      <p className="settings-section-subtitle">
        {tSub("deployment_diagnostics")}
      </p>

      {loading && !diagnostics ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            color: "var(--text-3)",
          }}
        >
          <span className="spinner-sm" /> {tDeploy("loading")}
        </div>
      ) : diagnostics ? (
        <>
          <div className="settings-status-grid deployment-diagnostics-grid">
            <div className="settings-status-item">
              <div className="settings-status-label">{tDeploy("version")}</div>
              <div className="settings-status-value">
                {diagnostics.app.version}
              </div>
            </div>
            <div className="settings-status-item">
              <div className="settings-status-label">{tDeploy("health")}</div>
              <div
                className="settings-status-value"
                style={{
                  color:
                    diagnostics.health.status === "ok"
                      ? "var(--green)"
                      : "var(--danger)",
                }}
              >
                {diagnostics.health.status === "ok"
                  ? tDeploy("health_ok")
                  : tDeploy("health_degraded")}
              </div>
            </div>
            <div className="settings-status-item">
              <div className="settings-status-label">{tDeploy("database")}</div>
              <div
                className="settings-status-value"
                style={{
                  color: diagnostics.database.writable
                    ? "var(--green)"
                    : "var(--danger)",
                }}
              >
                {diagnostics.database.writable
                  ? tDeploy("writable")
                  : tDeploy("not_writable")}
              </div>
            </div>
            <div className="settings-status-item">
              <div className="settings-status-label">{tDeploy("access")}</div>
              <div className="settings-status-value">
                {diagnostics.network.localOnlyHost
                  ? tDeploy("access_local")
                  : tDeploy("access_lan")}
              </div>
            </div>
          </div>

          <div className="deployment-admin-card">
            <div>
              <div className="deployment-admin-title">
                {tDeploy("admin_unlock_title")}
              </div>
              <p className="deployment-admin-copy">
                {diagnostics.security.adminTokenConfigured
                  ? tDeploy("admin_unlock_body_configured")
                  : tDeploy("admin_unlock_body_off")}
              </p>
              <div
                className={`deployment-admin-state${adminTokenUnlocked ? " is-unlocked" : ""}`}
                role="status"
              >
                {adminTokenUnlocked
                  ? tDeploy("session_unlocked")
                  : tDeploy("session_locked")}
              </div>
            </div>
            {diagnostics.security.adminTokenConfigured ? (
              <div className="deployment-admin-controls">
                <label className="settings-field" style={{ gap: 6 }}>
                  <span className="settings-field-label">
                    {tDeploy("admin_token_input")}
                  </span>
                  <input
                    autoComplete="off"
                    className="settings-input"
                    onChange={(event) => setAdminTokenInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onSaveAdminToken();
                      }
                    }}
                    placeholder={tDeploy("admin_token_placeholder")}
                    type="password"
                    value={adminTokenInput}
                  />
                </label>
                <div className="deployment-admin-actions">
                  <button
                    className="btn btn-secondary"
                    disabled={!adminTokenInput.trim()}
                    onClick={onSaveAdminToken}
                    type="button"
                  >
                    {tDeploy("admin_unlock")}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={!adminTokenUnlocked}
                    onClick={onClearAdminToken}
                    type="button"
                  >
                    {tDeploy("admin_lock")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div
            aria-label={tDeploy("checks_aria")}
            className="deployment-check-list"
          >
            {diagnostics.checks.map((check) => (
              <div
                className={`deployment-check deployment-check-${check.status}`}
                key={check.id}
              >
                <div className="deployment-check-main">
                  <span aria-hidden="true" className="deployment-check-dot" />
                  <div>
                    <div className="deployment-check-title">{check.label}</div>
                    <div className="deployment-check-detail">
                      {check.detail}
                    </div>
                  </div>
                </div>
                <span className="deployment-check-status">
                  {tDeploy(`status_${check.status}`)}
                </span>
              </div>
            ))}
          </div>

          <div className="deployment-detail-grid">
            <div className="deployment-detail-row">
              <span>{tDeploy("db_path")}</span>
              <code>{diagnostics.database.path}</code>
            </div>
            <div className="deployment-detail-row">
              <span>{tDeploy("db_size")}</span>
              <strong>{fmtBytes(diagnostics.database.sizeBytes)}</strong>
            </div>
            <div className="deployment-detail-row">
              <span>{tDeploy("host")}</span>
              <code>{diagnostics.network.host ?? tDeploy("unknown")}</code>
            </div>
            <div className="deployment-detail-row">
              <span>{tDeploy("proxy")}</span>
              <strong>
                {diagnostics.network.proxyDetected
                  ? tDeploy("proxy_detected")
                  : tDeploy("proxy_not_detected")}
              </strong>
            </div>
            <div className="deployment-detail-row">
              <span>{tDeploy("admin_token")}</span>
              <strong>
                {diagnostics.security.adminTokenConfigured
                  ? tDeploy("admin_token_on")
                  : tDeploy("admin_token_off")}
              </strong>
            </div>
            <div className="deployment-detail-row">
              <span>{tDeploy("runtime")}</span>
              <strong>
                {diagnostics.app.runtime === "desktop"
                  ? tDeploy("runtime_desktop")
                  : diagnostics.app.containerLikely
                    ? tDeploy("runtime_container")
                    : tDeploy("runtime_web")}
              </strong>
            </div>
          </div>

          <button
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => void onReload()}
            style={{ marginTop: 16 }}
            type="button"
          >
            {loading ? (
              <>
                <span className="spinner" /> {tDeploy("refreshing")}
              </>
            ) : (
              tDeploy("refresh")
            )}
          </button>
          <button
            className="btn btn-secondary"
            disabled={copying}
            onClick={() => void onCopySupportBundle()}
            style={{ marginTop: 16, marginLeft: 8 }}
            type="button"
          >
            {copying ? (
              <>
                <span className="spinner" /> {tDeploy("copying")}
              </>
            ) : (
              tDeploy("copy_bundle")
            )}
          </button>
        </>
      ) : locked ? (
        // The non-local admin gate rejected the diagnostics read.
        // This card is the login destination every blocked surface
        // links to, so the unlock form must render even though the
        // diagnostics payload (and its adminTokenConfigured flag)
        // is unavailable — `adminTokenConfigured` comes from the
        // gate-exempt /api/auth/admin-token/status instead.
        <div className="settings-help-card" role="status">
          <div className="settings-help-title">{tDeploy("locked_title")}</div>
          <p className="settings-help-copy">
            {adminTokenConfigured
              ? tDeploy("locked_body")
              : tDeploy("locked_body_no_token")}
          </p>
          {adminTokenConfigured && (
            <div className="deployment-admin-controls">
              <label className="settings-field" style={{ gap: 6 }}>
                <span className="settings-field-label">
                  {tDeploy("admin_token_input")}
                </span>
                <input
                  autoComplete="off"
                  className="settings-input"
                  onChange={(event) => setAdminTokenInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onSaveAdminToken();
                    }
                  }}
                  placeholder={tDeploy("admin_token_placeholder")}
                  type="password"
                  value={adminTokenInput}
                />
              </label>
              <div className="deployment-admin-actions">
                <button
                  className="btn btn-secondary"
                  disabled={!adminTokenInput.trim()}
                  onClick={onSaveAdminToken}
                  type="button"
                >
                  {tDeploy("admin_unlock")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="settings-help-card" role="status">
          <div className="settings-help-title">
            {tDeploy("unavailable_title")}
          </div>
          <p className="settings-help-copy">
            {error || tDeploy("unavailable_body")}
          </p>
          <button
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => void onReload()}
            type="button"
          >
            {loading ? (
              <>
                <span className="spinner" /> {tDeploy("refreshing")}
              </>
            ) : (
              tDeploy("try_again")
            )}
          </button>
        </div>
      )}
    </div>
  );
}

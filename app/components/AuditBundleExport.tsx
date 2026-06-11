"use client";

/**
 * AuditBundleExport — counterpart to AuditBundleImport. Lets a
 * `loved_one`-audience user produce a `.audit.json` file they can
 * share with someone they're recommending privacy choices to.
 *
 * The button + panel are gated by `flag.settings.admin.export.audit_bundle`,
 * or by the handoff workflow selected during onboarding. The client-side
 * `useFlag` hook doesn't bootstrap from server state on fresh page loads
 * (it returns the hard default of `'off'` until an override mutation fires),
 * so we round-trip `/api/feature-flags` and `/api/focus` on mount to
 * resolve the actual gate. The server enforces the same gate
 * authoritatively (`/api/export/audit-bundle` returns 403 when off) — the
 * client probe is only there to hide the button when it would 403 anyway.
 *
 * The panel is collapsed by default and expands on click — same
 * "two-state" pattern the import widget uses for its preview modal.
 * On submit we POST to the export endpoint, read the response as a
 * Blob, and click an invisible <a download> to trigger the browser's
 * save-file dialog. Filename comes straight from the server's
 * Content-Disposition header (handles localised dates etc.).
 */

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export default function AuditBundleExport() {
  const t = useTranslations("settings.audit_bundle_export");
  const tFallback = useTranslations("settings.audit_bundle_import");

  // null = still probing, false = flag off (render null), true = render UI.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [recommenderName, setRecommenderName] = useState("");
  const [includeProfile, setIncludeProfile] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the gate against actual server state. Failing closed (set
  // to false when both probes fail) keeps the button hidden when we can't
  // confirm the gate, which matches what the server enforces anyway.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let flagAllowed = false;
      let workflowAllowed = false;
      try {
        const res = await fetch("/api/feature-flags");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          flags: Array<{ key: string; currentValue: string }>;
        };
        const row = data.flags.find(
          (f) => f.key === "flag.settings.admin.export.audit_bundle"
        );
        flagAllowed = row?.currentValue === "on";
      } catch {
        flagAllowed = false;
      }

      try {
        const res = await fetch("/api/focus");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { workflow?: string };
        workflowAllowed = data.workflow === "other_handoff";
      } catch {
        workflowAllowed = false;
      }

      if (!cancelled) {
        setEnabled(flagAllowed || workflowAllowed);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (enabled !== true) {
    return null;
  }

  async function handleExport() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/export/audit-bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recommenderName: recommenderName.trim() || null,
          includeRecommenderProfile: includeProfile,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }

      // Read the blob FIRST so we can release the response stream before
      // touching the DOM. The filename comes from the server-generated
      // Content-Disposition header.
      const filenameHeader = res.headers.get("content-disposition") ?? "";
      const filenameMatch = filenameHeader.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] ?? "audit.audit.json";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      // Reset the form on success — leaving the panel open lets the
      // user export again with different settings, but we collapse it
      // so the next visit defaults to the lighter button view.
      setOpen(false);
      setRecommenderName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error_generic"));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        className="btn btn-secondary audit-bundle-export__open-btn"
        onClick={() => setOpen(true)}
        type="button"
      >
        {t("open_button")}
      </button>
    );
  }

  return (
    <div className="audit-bundle-export">
      <div className="audit-bundle-export__heading">
        <h3 className="audit-bundle-export__title">{t("panel_title")}</h3>
        <p className="audit-bundle-export__subtitle">
          {t("panel_description")}
        </p>
      </div>

      <label className="audit-bundle-export__field">
        <span className="audit-bundle-export__field-label">
          {t("recommender_label")}
        </span>
        <input
          className="audit-bundle-export__field-input"
          disabled={submitting}
          onChange={(event) => setRecommenderName(event.target.value)}
          placeholder={t("recommender_placeholder")}
          type="text"
          value={recommenderName}
        />
        <span className="audit-bundle-export__field-hint">
          {t("recommender_hint", {
            fallback: tFallback("fallback_recommender"),
          })}
        </span>
      </label>

      <label className="audit-bundle-export__checkbox-row">
        <input
          checked={includeProfile}
          className="settings-checkbox"
          disabled={submitting}
          onChange={(event) => setIncludeProfile(event.target.checked)}
          type="checkbox"
        />
        <span>
          <span className="audit-bundle-export__checkbox-label">
            {t("include_profile_label")}
          </span>
          <span className="audit-bundle-export__field-hint">
            {t("include_profile_hint")}
          </span>
        </span>
      </label>

      {error && (
        <div className="audit-bundle-export__error" role="alert">
          {error}
        </div>
      )}

      <div className="audit-bundle-export__actions">
        <button
          className="btn btn-primary"
          disabled={submitting}
          onClick={() => void handleExport()}
          type="button"
        >
          {submitting ? t("submit_busy") : t("submit")}
        </button>
        <button
          className="btn btn-ghost"
          disabled={submitting}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          type="button"
        >
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

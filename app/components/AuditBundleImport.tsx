"use client";

/**
 * AuditBundleImport — UI for accepting an audit bundle exported by another
 * instance of the app.
 *
 * Flow (matches https://privacytracker-docs.privacykey.org/develop/feature-flags):
 *
 *   1. User clicks "Import audit bundle" or drops a file on the drop-zone.
 *   2. We POST the file to /api/import/audit-bundle (no `confirm`) for a
 *      validate-only preview. Server returns the bundle envelope summary
 *      (recommender name, app count, annotation count, version) plus an
 *      `existingImport` record if the same bundle has already been seen.
 *   3. Confirm modal opens with the preview numbers and a duplicate-import
 *      warning if applicable. Cancel discards everything; Confirm POSTs
 *      again with `?confirm=1` (and `&allowDuplicate=1` when the user is
 *      proceeding past a dedup match).
 *   4. After commit, we render a result toast with the merge summary and
 *      a "View dashboard" link. The dashboard's provenance banner reads
 *      the activity-log row written by the API to populate its copy.
 *
 * Drag-and-drop supported only on this drop-zone (per spec). Drag-and-drop
 * elsewhere in the app is intentionally NOT supported in v1 to avoid
 * accidental imports.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { useModalFocus } from "../../lib/use-modal-focus";

// Mirrors the four named profile presets exposed by
// `lib/privacy-profile.ts`. Kept as a string-literal union here (rather
// than re-importing ProfilePresetKey) so this client component doesn't
// pull in any server-leaning helpers — the API is the single source of
// truth for the values we'll see at runtime.
type RecommenderPresetKey =
  | "strict"
  | "balanced"
  | "anti_tracking"
  | "permissive";

interface PreviewPayload {
  bundle: {
    version: number;
    app_version: string;
    exported_at: string;
    recommender_name: string | null;
    exported_by_audience: "self" | "loved_one" | "guardian";
    apps_count: number;
    annotations_count: number;
    has_recommender_profile: boolean;
    /**
     * Present when the bundle (v2+) carries a recognised preset key.
     * Older bundles or recommenders with custom profiles report null.
     */
    recommender_profile_preset: RecommenderPresetKey | null;
  };
  existingImport: {
    importedAt: number;
    recommenderName: string | null;
  } | null;
}

interface ImportSummary {
  annotationsAdded: number;
  appsAdded: number;
  appsSkipped: number;
  appsTotal: number;
  appsUpdated: number;
  recommenderName: string;
  recommenderProfilePreset: RecommenderPresetKey | null;
  recommenderProfileStashed: boolean;
}

export default function AuditBundleImport() {
  const t = useTranslations("settings.audit_bundle_import");
  // Reuses the four preset labels already maintained under the privacy
  // profile editor — no need for a parallel set of translations here.
  const tPresets = useTranslations("settings.profile_editor.presets.labels");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Three-state machine: idle (drop-zone visible) → preview (confirm
  // modal open) → done (result toast). Errors push us back to idle with
  // a banner. Each state owns its own data so the JSX renders without
  // peeking at the others.
  const [previewing, setPreviewing] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const bundleConfirmRef = useModalFocus<HTMLDivElement>({
    open: !!(preview && previewing),
    onClose: () => busy === null && reset(),
  });

  const reset = () => {
    setPreviewing(null);
    setPreview(null);
    setError(null);
    setBusy(null);
  };

  const runPreview = useCallback(async (file: File) => {
    setError(null);
    setPreview(null);
    setPreviewing(file);
    setBusy("preview");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/audit-bundle", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as
        | {
            ok: true;
            preview: true;
            bundle: PreviewPayload["bundle"];
            existingImport: PreviewPayload["existingImport"];
          }
        | { ok?: false; error?: string };
      if (!(res.ok && "ok" in data && data.ok)) {
        const message = ("error" in data && data.error) || `HTTP ${res.status}`;
        throw new Error(message);
      }
      setPreview({ bundle: data.bundle, existingImport: data.existingImport });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error_could_not_read"));
      setPreviewing(null);
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, []);

  const runCommit = useCallback(async () => {
    if (!(previewing && preview)) {
      return;
    }
    setBusy("commit");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", previewing);
      const params = new URLSearchParams({ confirm: "1" });
      if (preview.existingImport) {
        params.set("allowDuplicate", "1");
      }
      const res = await fetch(`/api/import/audit-bundle?${params.toString()}`, {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as
        | { ok: true; preview: false; summary: ImportSummary }
        | { ok?: false; error?: string };
      if (!(res.ok && "ok" in data && data.ok)) {
        const message = ("error" in data && data.error) || `HTTP ${res.status}`;
        throw new Error(message);
      }
      setResult(data.summary);
      setPreview(null);
      setPreviewing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error_import_failed"));
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [previewing, preview]);

  // Drop-zone handlers. Drag-over highlight is purely cosmetic; the
  // actual file validation happens after `drop` once we have the
  // File object. Defensive — only honour the first file even if the
  // user drops several.
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (busy) {
      return;
    }
    if (e.dataTransfer?.types?.includes("Files")) {
      setDragOver(true);
    }
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (busy) {
      return;
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) {
      return;
    }
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      void runPreview(file);
    }
  };

  return (
    <div className="audit-bundle-import">
      <div className="audit-bundle-import__heading">
        <h3 className="audit-bundle-import__title">{t("title")}</h3>
        <p className="audit-bundle-import__subtitle">
          {t("subtitle_pre")}
          <code>{t("subtitle_code")}</code>
          {t("subtitle_post")}
        </p>
      </div>

      {result ? (
        <ResultBanner
          onDismiss={() => {
            setResult(null);
            reset();
          }}
          summary={result}
        />
      ) : (
        <div
          aria-label={t("dropzone_aria")}
          className={`audit-bundle-import__dropzone${dragOver ? " is-drag-over" : ""}${busy ? " is-busy" : ""}`}
          onClick={() => {
            if (!busy) {
              fileRef.current?.click();
            }
          }}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !busy) {
              e.preventDefault();
              fileRef.current?.click();
            }
          }}
          role="button"
          tabIndex={0}
        >
          <span
            aria-hidden="true"
            className="audit-bundle-import__dropzone-icon"
          >
            📥
          </span>
          <strong className="audit-bundle-import__dropzone-label">
            {t("dropzone_label")}
          </strong>
          <span className="audit-bundle-import__dropzone-hint">
            {t("dropzone_hint_pre")}
            <code>{t("subtitle_code")}</code>
            {t("dropzone_hint_post")}
          </span>
          {busy === "preview" && (
            <span
              aria-live="polite"
              className="audit-bundle-import__dropzone-status"
            >
              <span aria-hidden="true" className="spinner-sm" />{" "}
              {t("dropzone_busy")}
            </span>
          )}
        </div>
      )}

      <input
        accept="application/json,.audit.json,.json"
        aria-hidden="true"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset value so picking the same file twice still re-fires.
          e.target.value = "";
          if (file) {
            void runPreview(file);
          }
        }}
        ref={fileRef}
        tabIndex={-1}
        type="file"
      />

      {error && !preview && (
        <div className="audit-bundle-import__error" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
          <button
            aria-label={t("dismiss_error_aria")}
            className="audit-bundle-import__error-dismiss"
            onClick={() => setError(null)}
            type="button"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      )}

      {/*
        Confirm modal — shown after the preview POST returns. Uses the
        same .modal-overlay / .modal-card chrome as SettingsView's
        wayback-remove + reset-app dialogs so the destructive-action
        pattern stays consistent across the app.
      */}
      {preview && previewing && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (busy === null) {
              reset();
            }
          }}
        >
          <div
            aria-describedby="bundle-confirm-copy"
            aria-labelledby="bundle-confirm-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            ref={bundleConfirmRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="modal-badge">
              {preview.existingImport
                ? t("modal_badge_reimport")
                : t("modal_badge_new")}
            </div>
            <h2 className="modal-title" id="bundle-confirm-title">
              {preview.existingImport
                ? t("modal_title_existing")
                : t("modal_title_new", {
                    name:
                      preview.bundle.recommender_name?.trim() ||
                      t("fallback_recommender"),
                  })}
            </h2>
            <div className="modal-copy" id="bundle-confirm-copy">
              {preview.existingImport ? (
                <p>
                  {t("modal_copy_existing_pre")}
                  <strong>
                    {new Date(
                      preview.existingImport.importedAt
                    ).toLocaleString()}
                  </strong>
                  {t("modal_copy_existing_mid")}
                  <strong>
                    {preview.bundle.recommender_name?.trim() ||
                      t("fallback_recommender")}
                  </strong>
                  {t("modal_copy_existing_post")}
                </p>
              ) : (
                <p>
                  {t.rich("modal_copy_new", {
                    apps: preview.bundle.apps_count,
                    notes: preview.bundle.annotations_count,
                    b: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              )}
              <ul className="audit-bundle-import__envelope">
                <li>
                  <span>{t("envelope_recommender")}</span>
                  <strong>
                    {preview.bundle.recommender_name?.trim() ||
                      t("fallback_recommender")}
                  </strong>
                </li>
                <li>
                  <span>{t("envelope_exported")}</span>
                  <strong>
                    {new Date(preview.bundle.exported_at).toLocaleString()}
                  </strong>
                </li>
                <li>
                  <span>{t("envelope_app_version")}</span>
                  <strong>
                    {t("envelope_app_version_value", {
                      version: preview.bundle.app_version,
                    })}
                  </strong>
                </li>
                <li>
                  <span>{t("envelope_privacy_profile")}</span>
                  <strong>
                    {preview.bundle.has_recommender_profile
                      ? t("envelope_profile_included")
                      : t("envelope_profile_excluded")}
                    {preview.bundle.recommender_profile_preset && (
                      <>
                        {" "}
                        <span className="audit-bundle-import__envelope-preset">
                          {t("envelope_profile_preset", {
                            preset: tPresets(
                              preview.bundle.recommender_profile_preset
                            ),
                          })}
                        </span>
                      </>
                    )}
                  </strong>
                </li>
              </ul>
              {error && (
                <p className="audit-bundle-import__inline-error" role="alert">
                  <span aria-hidden="true">⚠</span> {error}
                </p>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={busy !== null}
                onClick={reset}
                type="button"
              >
                {t("modal_cancel")}
              </button>
              <button
                autoFocus
                className={`btn ${preview.existingImport ? "btn-secondary" : "btn-primary"}`}
                disabled={busy !== null}
                onClick={() => void runCommit()}
                type="button"
              >
                {busy === "commit" ? (
                  <>
                    <span aria-hidden="true" className="spinner-sm" />{" "}
                    {t("modal_importing")}
                  </>
                ) : preview.existingImport ? (
                  t("modal_reimport_anyway")
                ) : (
                  t("modal_import")
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultBanner({
  summary,
  onDismiss,
}: {
  summary: ImportSummary;
  onDismiss: () => void;
}) {
  const t = useTranslations("settings.audit_bundle_import");
  const tPresets = useTranslations("settings.profile_editor.presets.labels");
  return (
    <div
      aria-live="polite"
      className="audit-bundle-import__result"
      role="status"
    >
      <span aria-hidden="true">✓</span>
      <div className="audit-bundle-import__result-body">
        <strong>
          {t("result_summary_apps_added", { count: summary.appsAdded })}
          {summary.appsUpdated > 0
            ? t("result_summary_updated", { count: summary.appsUpdated })
            : ""}
          {summary.appsSkipped > 0
            ? t("result_summary_skipped", { count: summary.appsSkipped })
            : ""}
          {summary.annotationsAdded > 0
            ? t("result_summary_notes", {
                count: summary.annotationsAdded,
                name: summary.recommenderName,
              })
            : ""}
          {t("result_summary_period")}
        </strong>
        {summary.recommenderProfileStashed && (
          <span className="audit-bundle-import__result-detail">
            {t("result_profile_stashed", { name: summary.recommenderName })}
          </span>
        )}
        {summary.recommenderProfilePreset && (
          <span className="audit-bundle-import__result-detail">
            {t("result_profile_preset", {
              name: summary.recommenderName,
              preset: tPresets(summary.recommenderProfilePreset),
            })}
          </span>
        )}
        <Link className="audit-bundle-import__result-link" href="/dashboard">
          {t("result_view_dashboard")}
        </Link>
      </div>
      <button
        aria-label={t("result_dismiss_aria")}
        className="audit-bundle-import__result-dismiss"
        onClick={onDismiss}
        type="button"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

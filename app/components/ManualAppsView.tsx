"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isManualAppSource,
  type ManualApp,
  type ManualAppInput,
  type ManualAppSource,
  type ManualAppSourceMeta,
} from "../../lib/manual-apps";
import { useModalFocus } from "../../lib/use-modal-focus";
import {
  rovingTabIndex,
  useRovingRadioGroup,
} from "../../lib/use-roving-radiogroup";
import Favicon from "./Favicon";

interface Props {
  initialApps: ManualApp[];
  sources: ManualAppSourceMeta[];
}

// Shape matches ManualAppInput but all fields are strings (including source)
// so the form state plays nicely with controlled <input> / <select>.
interface FormState {
  developer: string;
  name: string;
  notes: string;
  privacyPolicyUrl: string;
  source: ManualAppSource;
  sourceUrl: string;
}

const EMPTY_FORM = (defaultSource: ManualAppSource): FormState => ({
  name: "",
  source: defaultSource,
  developer: "",
  privacyPolicyUrl: "",
  sourceUrl: "",
  notes: "",
});

function toInput(form: FormState): ManualAppInput {
  // Empty strings become `null` so the API clears the field. `name` and
  // `source` are always sent — the server re-validates either way.
  return {
    name: form.name,
    source: form.source,
    developer: form.developer.trim() ? form.developer : null,
    privacyPolicyUrl: form.privacyPolicyUrl.trim()
      ? form.privacyPolicyUrl
      : null,
    sourceUrl: form.sourceUrl.trim() ? form.sourceUrl : null,
    notes: form.notes.trim() ? form.notes : null,
  };
}

function fromApp(app: ManualApp): FormState {
  return {
    name: app.name,
    source: app.source,
    developer: app.developer ?? "",
    privacyPolicyUrl: app.privacyPolicyUrl ?? "",
    sourceUrl: app.sourceUrl ?? "",
    notes: app.notes ?? "",
  };
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export default function ManualAppsView({ initialApps, sources }: Props) {
  // i18n — page chrome, form titles, field labels + hints, empty state,
  // per-row chrome, and the delete-confirm modal.
  const tManual = useTranslations("manual_apps");
  // Source-meta labels (web app / TestFlight / personal / sideloaded)
  // come from `manual_app_source.<value>_{label,short,desc}` so the
  // picker buttons and the per-row badge translate.
  const tSource = useTranslations("manual_app_source");
  const searchParams = useSearchParams();
  const [apps, setApps] = useState<ManualApp[]>(initialApps);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(() =>
    EMPTY_FORM((sources[0]?.value as ManualAppSource) ?? "sideloaded")
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  /**
   * Confirm-modal state for the manual-app delete flow. Mirrors the
   * `.modal-overlay` / `.modal-card` pattern used in SettingsView's
   * wayback-remove + reset-app dialogs and AppGrid's tracked-app
   * delete dialog. Replaces the previous `window.confirm()` so the UX
   * is consistent across the app.
   */
  const [pendingDelete, setPendingDelete] = useState<ManualApp | null>(null);
  // "Did we already open the create form from a ?prefillName deep link?" —
  // a ref rather than state so we don't re-trigger if the user closes and
  // reopens the page without a fresh URL.
  const prefilledRef = useRef(false);

  const manualDeleteRef = useModalFocus<HTMLDivElement>({
    open: pendingDelete !== null,
    onClose: () => !busy && setPendingDelete(null),
  });

  // APG keyboard contract for the source-card radiogroup: one tab
  // stop, arrows move focus + selection (local form state only).
  const sourceRadioKeyDown = useRovingRadioGroup();

  // Keyed for O(1) label lookup in the list.
  const sourceMeta = useMemo(() => {
    const map = new Map<ManualAppSource, ManualAppSourceMeta>();
    for (const s of sources) {
      map.set(s.value, s);
    }
    return map;
  }, [sources]);

  const currentSourceMeta = sourceMeta.get(form.source);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setCreating(true);
    setError("");
    setForm(EMPTY_FORM((sources[0]?.value as ManualAppSource) ?? "sideloaded"));
  }, [sources]);

  const openEdit = useCallback((app: ManualApp) => {
    setCreating(false);
    setEditingId(app.id);
    setError("");
    setForm(fromApp(app));
  }, []);

  const closeForm = useCallback(() => {
    setCreating(false);
    setEditingId(null);
    setError("");
  }, []);

  // Deep-link support: Settings → Import history → "Mark as manual app" sends
  // the user here with ?prefillName=<query>&source=<source>. The manual-app
  // detail page also links back here with ?editId=<id> to reuse the editor
  // form. We auto-open whichever flow the URL encodes, once per page load.
  useEffect(() => {
    if (prefilledRef.current) {
      return;
    }
    if (!searchParams) {
      return;
    }

    // Edit deep link — takes precedence over prefillName since opening a
    // blank create form for an existing app would be confusing.
    const editId = searchParams.get("editId")?.trim() ?? "";
    if (editId) {
      const match = apps.find((a) => a.id === editId);
      if (match) {
        prefilledRef.current = true;
        openEdit(match);
        window.setTimeout(() => {
          const el = document.querySelector(".manual-apps-form-card");
          if (el && "scrollIntoView" in el) {
            (el as HTMLElement).scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          }
        }, 0);
        return;
      }
      // Otherwise silently fall through — the id is unknown, probably
      // stale. We still honour prefillName if present.
    }

    const name = searchParams.get("prefillName")?.trim() ?? "";
    const rawSource = searchParams.get("source");
    if (!name) {
      return;
    }
    prefilledRef.current = true;

    const source: ManualAppSource = isManualAppSource(rawSource)
      ? rawSource
      : ((sources[0]?.value as ManualAppSource) ?? "web_clip");

    setCreating(true);
    setEditingId(null);
    setError("");
    setForm({
      ...EMPTY_FORM(source),
      name,
    });
    // Scroll the new form into view after React commits — otherwise on a
    // page with existing entries the user might miss that it opened.
    window.setTimeout(() => {
      const el = document.querySelector(".manual-apps-form-card");
      if (el && "scrollIntoView" in el) {
        (el as HTMLElement).scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    }, 0);
  }, [searchParams, sources, apps, openEdit]);

  const update = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }

    if (!form.name.trim()) {
      setError(tManual("errors.name_required"));
      return;
    }

    setBusy(true);
    setError("");
    setFlash("");
    try {
      const body = toInput(form);
      const endpoint = editingId
        ? `/api/manual-apps/${editingId}`
        : "/api/manual-apps";
      const method = editingId ? "PUT" : "POST";
      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}) as any);
      if (!res.ok) {
        throw new Error(data?.error ?? tManual("errors.request_failed"));
      }
      const saved: ManualApp | undefined = data?.app;
      if (!saved) {
        throw new Error(tManual("errors.malformed_response"));
      }

      setApps((prev) => {
        if (editingId) {
          return prev.map((a) => (a.id === saved.id ? saved : a));
        }
        return [saved, ...prev];
      });
      setFlash(
        editingId
          ? tManual("flash_saved")
          : tManual("flash_added", { name: saved.name })
      );
      closeForm();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : tManual("errors.save_failed")
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Stage 1: row click → stage the modal. The actual deletion happens
   * inside `confirmDelete` once the user clicks Confirm in the modal.
   */
  const onDelete = (app: ManualApp) => {
    if (busy) {
      return;
    }
    setError("");
    setFlash("");
    setPendingDelete(app);
  };

  // ── Cmd+Z undo for manual-app deletions ────────────────────────────
  // When confirmDelete succeeds we push the entire deleted ManualApp
  // onto a bounded stack. KeyboardShortcuts.tsx dispatches an
  // `app:undo` window event when the user hits Cmd/Ctrl+Z outside of a
  // text input; we listen for it while the page is mounted and replay
  // the most-recent op via /api/manual-apps/<id>/restore.
  //
  // The restore endpoint re-creates the row with the SAME id (so any
  // bookmarks / copied URLs the user has still resolve), but the
  // `manual_app_events` and `manual_app_policy_versions` tables stay
  // empty — recreating the full event history would require either
  // shipping potentially-large JSON in the undo payload or doing a
  // soft-delete on the server, both of which are heavier than is
  // warranted for a feature whose canonical use case is "I just hit
  // delete by mistake".
  const MAX_MANUAL_UNDO_OPS = 20;
  const manualUndoStackRef = useRef<ManualApp[]>([]);

  const pushManualUndo = useCallback((snapshot: ManualApp) => {
    const next = [...manualUndoStackRef.current, snapshot];
    if (next.length > MAX_MANUAL_UNDO_OPS) {
      next.shift();
    }
    manualUndoStackRef.current = next;
  }, []);

  const handleManualUndo = useCallback(async () => {
    const prev = manualUndoStackRef.current;
    if (prev.length === 0) {
      return;
    }
    const target = prev[prev.length - 1];
    manualUndoStackRef.current = prev.slice(0, -1);

    try {
      const res = await fetch(
        `/api/manual-apps/${encodeURIComponent(target.id)}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(target),
        }
      );
      if (res.status === 409) {
        // Already exists — a sibling tab restored it, or the user
        // double-pressed Cmd+Z. Drop the op without an error toast.
        setFlash(tManual("flash_nothing_to_undo"));
        return;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { app: ManualApp };
      // Re-insert in-place. The original ordering (by name / source
      // / first_seen) is whatever the parent passes through
      // initialApps. Since we have the row's full payload here, we
      // can drop it back into the list and trust React to re-sort
      // on the next render — but for the user's mental model the
      // cleanest thing is "the app I just deleted reappears at the
      // top". We append to the end of the current list and let the
      // existing useEffect sort handle the rest if any sort logic
      // re-runs; if not, it shows up at the bottom which is still
      // a clear "this was just restored" signal.
      setApps((prevApps) => {
        // Defensive: don't double-insert if it raced into state from
        // somewhere else.
        if (prevApps.some((a) => a.id === body.app.id)) {
          return prevApps;
        }
        return [...prevApps, body.app];
      });
      setFlash(tManual("flash_restored", { name: body.app.name }));
      setError("");
    } catch (err) {
      console.error("[manual-apps] undo failed:", err);
      setError(
        err instanceof Error ? err.message : tManual("errors.delete_failed")
      );
    }
    // tManual is the only outer dep we touch (for the flash + error
    // strings); ESLint can't tell it's stable across renders. The async
    // undo reads its target from a ref so it doesn't need to re-render
    // when the stack changes.
  }, [tManual]);

  useEffect(() => {
    const handler = () => {
      void handleManualUndo();
    };
    window.addEventListener("app:undo", handler);
    return () => window.removeEventListener("app:undo", handler);
  }, [handleManualUndo]);

  /**
   * Stage 2: confirm clicked. Same network code as the previous inline
   * `onDelete` — only the gate changed.
   */
  const confirmDelete = async () => {
    const app = pendingDelete;
    if (!app || busy) {
      return;
    }
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const res = await fetch(`/api/manual-apps/${app.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? tManual("errors.delete_failed"));
      }
      setApps((prev) => prev.filter((a) => a.id !== app.id));
      setPendingDelete(null);
      // Push the FULL deleted row onto the undo stack so Cmd+Z can
      // restore everything the user typed (name, developer, privacy
      // policy URL, source URL, notes). The id is preserved by the
      // /restore endpoint so any external links still work after
      // restoration.
      pushManualUndo(app);
      setFlash(tManual("flash_removed_undo", { name: app.name }));
      if (editingId === app.id) {
        closeForm();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : tManual("errors.delete_failed")
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page manual-apps-page">
      <header className="manual-apps-header">
        <div>
          <div className="manual-apps-eyebrow">{tManual("eyebrow")}</div>
          <h1 className="manual-apps-title">{tManual("page_title")}</h1>
          <p className="manual-apps-intro">{tManual("intro")}</p>
        </div>

        {!(creating || editingId) && (
          <div className="manual-apps-actions">
            <button
              className="btn btn-primary"
              onClick={openCreate}
              type="button"
            >
              {tManual("add_button")}
            </button>
            <Link className="btn btn-ghost" href="/dashboard">
              {tManual("back_to_dashboard")}
            </Link>
          </div>
        )}
      </header>

      {flash && (
        <div className="manual-apps-flash" role="status">
          {flash}
        </div>
      )}

      {(creating || editingId) && (
        <section
          aria-label={
            editingId ? tManual("form_title_edit") : tManual("form_title_add")
          }
          className="manual-apps-form-card"
        >
          <h2 className="manual-apps-form-title">
            {editingId ? tManual("form_title_edit") : tManual("form_title_add")}
          </h2>

          <form className="manual-apps-form" onSubmit={onSubmit}>
            <label className="manual-apps-field">
              <span className="manual-apps-label">{tManual("name_label")}</span>
              <input
                className="settings-input"
                disabled={busy}
                maxLength={120}
                onChange={(e) => update({ name: e.target.value })}
                placeholder={tManual("name_placeholder")}
                required
                type="text"
                value={form.name}
              />
            </label>

            <fieldset
              aria-label={tManual("source_group_aria")}
              className="manual-apps-source-group"
            >
              <legend className="manual-apps-label">
                {tManual("source_legend")}
              </legend>
              <div
                className="manual-apps-source-grid"
                onKeyDown={sourceRadioKeyDown}
                role="radiogroup"
              >
                {sources.map((src, srcIndex) => {
                  const active = form.source === src.value;
                  return (
                    <button
                      aria-checked={active}
                      className={`manual-apps-source-card ${active ? "active" : ""}`}
                      disabled={busy}
                      key={src.value}
                      onClick={() => update({ source: src.value })}
                      role="radio"
                      tabIndex={rovingTabIndex(
                        active,
                        srcIndex,
                        sources.some((s) => s.value === form.source)
                      )}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="manual-apps-source-icon"
                      >
                        {src.icon}
                      </span>
                      <span className="manual-apps-source-label">
                        {tSource(`${src.value}_label`)}
                      </span>
                      <span className="manual-apps-source-copy">
                        {tSource(`${src.value}_desc`)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <label className="manual-apps-field">
              <span className="manual-apps-label">
                {tManual("developer_label")}
              </span>
              <input
                className="settings-input"
                disabled={busy}
                maxLength={120}
                onChange={(e) => update({ developer: e.target.value })}
                placeholder={tManual("developer_placeholder")}
                type="text"
                value={form.developer}
              />
            </label>

            <label className="manual-apps-field">
              <span className="manual-apps-label">
                {tManual("policy_url_label")}
              </span>
              <input
                className="settings-input"
                disabled={busy}
                maxLength={512}
                onChange={(e) => update({ privacyPolicyUrl: e.target.value })}
                placeholder={tManual("policy_url_placeholder")}
                type="url"
                value={form.privacyPolicyUrl}
              />
              <span className="manual-apps-hint">
                {tManual("policy_url_hint")}
              </span>
            </label>

            {currentSourceMeta?.supportsSourceUrl && (
              <label className="manual-apps-field">
                <span className="manual-apps-label">
                  {tManual("source_link_label")}
                </span>
                <input
                  className="settings-input"
                  disabled={busy}
                  maxLength={512}
                  onChange={(e) => update({ sourceUrl: e.target.value })}
                  placeholder={currentSourceMeta.sourceUrlPlaceholder}
                  type="url"
                  value={form.sourceUrl}
                />
                <span className="manual-apps-hint">
                  {tManual("source_link_hint")}
                </span>
              </label>
            )}

            <label className="manual-apps-field">
              <span className="manual-apps-label">
                {tManual("notes_label")}
              </span>
              <textarea
                className="settings-input manual-apps-textarea"
                disabled={busy}
                maxLength={2000}
                onChange={(e) => update({ notes: e.target.value })}
                placeholder={tManual("notes_placeholder")}
                rows={3}
                value={form.notes}
              />
            </label>

            {error && (
              <div className="manual-apps-error" role="alert">
                {error}
              </div>
            )}

            <div className="manual-apps-form-actions">
              <button className="btn btn-primary" disabled={busy} type="submit">
                {busy
                  ? tManual("saving")
                  : editingId
                    ? tManual("save_changes")
                    : tManual("add_app")}
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={closeForm}
                type="button"
              >
                {tManual("cancel")}
              </button>
              {editingId && (
                <button
                  className="btn btn-danger manual-apps-delete"
                  disabled={busy}
                  onClick={() => {
                    const target = apps.find((a) => a.id === editingId);
                    if (target) {
                      onDelete(target);
                    }
                  }}
                  type="button"
                >
                  {tManual("delete")}
                </button>
              )}
            </div>
          </form>
        </section>
      )}

      {apps.length === 0 ? (
        <section className="manual-apps-empty">
          <div aria-hidden="true" className="manual-apps-empty-icon">
            📭
          </div>
          <h2>{tManual("empty_title")}</h2>
          <p>
            {tManual.rich("empty_body_rich", {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        </section>
      ) : (
        <ul aria-label={tManual("list_aria")} className="manual-apps-list">
          {apps.map((app) => {
            const meta = sourceMeta.get(app.source);
            return (
              <li className="manual-apps-row" key={app.id}>
                <div className="manual-apps-row-main">
                  <div className="manual-apps-row-heading">
                    <span aria-hidden="true" className="manual-apps-row-icon">
                      {meta?.icon ?? "📦"}
                    </span>
                    <div className="manual-apps-row-titleblock">
                      <div className="manual-apps-row-name">{app.name}</div>
                      <div className="manual-apps-row-meta">
                        <span className="manual-apps-row-source">
                          {meta ? tSource(`${meta.value}_short`) : app.source}
                        </span>
                        {app.developer && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span className="manual-apps-row-developer">
                              {app.developer}
                            </span>
                          </>
                        )}
                        <span aria-hidden="true"> · </span>
                        <span className="manual-apps-row-updated">
                          {tManual("row_updated", {
                            date: formatDate(app.updatedAt),
                          })}
                        </span>
                      </div>
                    </div>
                  </div>

                  {(app.privacyPolicyUrl || app.sourceUrl || app.notes) && (
                    <div className="manual-apps-row-body">
                      {app.privacyPolicyUrl && (
                        <div className="manual-apps-row-link">
                          <span className="manual-apps-row-linklabel">
                            {tManual("row_policy_label")}
                          </span>{" "}
                          <a
                            className="manual-apps-row-linkbody"
                            href={app.privacyPolicyUrl}
                            rel="noreferrer noopener"
                            target="_blank"
                          >
                            <Favicon size={16} url={app.privacyPolicyUrl} />
                            <span>{app.privacyPolicyUrl}</span>
                          </a>
                        </div>
                      )}
                      {app.sourceUrl && (
                        <div className="manual-apps-row-link">
                          <span className="manual-apps-row-linklabel">
                            {tManual("row_source_label")}
                          </span>{" "}
                          <a
                            className="manual-apps-row-linkbody"
                            href={app.sourceUrl}
                            rel="noreferrer noopener"
                            target="_blank"
                          >
                            <Favicon size={16} url={app.sourceUrl} />
                            <span>{app.sourceUrl}</span>
                          </a>
                        </div>
                      )}
                      {app.notes && (
                        <p className="manual-apps-row-notes">{app.notes}</p>
                      )}
                    </div>
                  )}
                </div>

                <div className="manual-apps-row-actions">
                  <Link
                    className="btn btn-sm btn-secondary"
                    href={`/manual-apps/${encodeURIComponent(app.id)}`}
                  >
                    {tManual("row_view")}
                  </Link>
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={() => openEdit(app)}
                    type="button"
                  >
                    {tManual("row_edit")}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => onDelete(app)}
                    type="button"
                  >
                    {tManual("row_remove")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/*
        Confirm modal for manual-app deletion. Mirrors the
        `.modal-overlay` / `.modal-card` chrome used by AppGrid's
        tracked-app delete dialog and SettingsView's wayback-remove
        dialog so the destructive UX is consistent across the app.
      */}
      {pendingDelete && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!busy) {
              setPendingDelete(null);
            }
          }}
        >
          <div
            aria-describedby="manual-delete-copy"
            aria-labelledby="manual-delete-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            ref={manualDeleteRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="modal-badge">{tManual("remove_modal_badge")}</div>
            <h2 className="modal-title" id="manual-delete-title">
              {tManual("remove_modal_title", { name: pendingDelete.name })}
            </h2>
            <p className="modal-copy" id="manual-delete-copy">
              {tManual("remove_modal_body")}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setPendingDelete(null)}
                type="button"
              >
                {tManual("cancel")}
              </button>
              <button
                autoFocus
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void confirmDelete()}
                type="button"
              >
                {busy ? (
                  <>
                    <span aria-hidden="true" className="spinner-sm" />{" "}
                    {tManual("removing")}
                  </>
                ) : (
                  tManual("remove_app")
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

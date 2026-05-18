"use client";

/**
 * AnnotationsSidebar — per-app freeform notes (round 3 PR 4).
 *
 * Right-rail sidebar on viewports >=768px; inline section below the privacy
 * labels on narrow viewports. Markdown content rendered via `marked` with
 * its default sanitiser. Each note has a tag dropdown, a visibility lock
 * (private notes never appear in audit-bundle exports), and metadata
 * showing source ("Note from {recommender}" for imported notes).
 *
 * Auto-save is debounced 1s after the last keystroke. Delete is soft (sets
 * `deleted_at`); a 30s undo toast lets the user reverse it before purge.
 *
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags.
 */

import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Annotation,
  AnnotationTag,
  AnnotationVisibility,
} from "@/lib/annotations";

/**
 * Annotation renderer — full GFM (tables, task lists, strikethrough,
 * autolinks) + soft line breaks (single newline → <br>) so users don't
 * have to learn that two trailing spaces or a blank line are required
 * to break a line. Inline raw HTML is escaped rather than passed
 * through, so a typo'd `<script>` ends up as readable text instead of
 * an XSS vector — the spec calls notes "full GitHub-flavoured
 * markdown" but never raw HTML, and our DB stores the source verbatim
 * so the conservative choice is safe.
 *
 * Marked v15 dropped the legacy `sanitize` option; the documented
 * replacement is to override the renderer's html() and escape the
 * input. We swap in `<code>`-wrapped escaped text so the user can see
 * the literal markup they typed (helpful when debugging an unintended
 * `<` in their own copy) rather than silently dropping it.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const annotationRenderer = new Renderer();
// Block-level raw HTML token. marked passes `{ text }` (the raw block
// of inline HTML the user typed). We wrap it as inline code so it
// reads as a literal in the rendered output.
annotationRenderer.html = function annotationHtmlRenderer({ text }) {
  return `<code>${escapeHtml(text)}</code>`;
};
// External links open in a new tab + carry rel="noopener noreferrer"
// so a malicious destination can't tamper with the parent window via
// `window.opener`. Empty / javascript: hrefs collapse to a span so the
// link affordance disappears entirely. Regular `function` (not arrow)
// so marked can bind `this` to the renderer at call time — that's
// how we reach `this.parser.parseInline(tokens)` to render the link
// label without re-implementing the inline parser.
annotationRenderer.link = function annotationLinkRenderer({
  href,
  title,
  tokens,
}) {
  const inlineText = this?.parser?.parseInline
    ? this.parser.parseInline(tokens ?? [])
    : escapeHtml(
        (tokens ?? []).map((t: { raw?: string }) => t.raw ?? "").join("")
      );
  const safeHref =
    typeof href === "string" && /^(https?:|mailto:|#)/i.test(href.trim())
      ? href.trim()
      : "";
  if (!safeHref) {
    return `<span>${inlineText}</span>`;
  }
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noopener noreferrer">${inlineText}</a>`;
};
// Images are intentionally rendered as text. Notes are for short audit
// comments, and allowing arbitrary image URLs adds both tracking pixels and
// another URI-bearing token type to sanitize.
annotationRenderer.image = function annotationImageRenderer({ href, text }) {
  const label =
    typeof text === "string" && text.trim()
      ? text.trim()
      : typeof href === "string"
        ? href.trim()
        : "image";
  return `<span class="annotation-image-placeholder">${escapeHtml(label)}</span>`;
};

marked.setOptions({
  gfm: true, // tables, strikethrough, autolinks, task lists
  breaks: true, // single newline → <br>
  renderer: annotationRenderer,
});

/** Render a single annotation's markdown to safe HTML. */
function renderAnnotation(content: string): string {
  try {
    const html = marked.parse(content, { async: false }) as string;
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target", "rel"],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#)/i,
      FORBID_TAGS: [
        "img",
        "svg",
        "math",
        "iframe",
        "object",
        "embed",
        "script",
        "style",
        "form",
      ],
    });
  } catch {
    // Last-resort fallback — escape so the raw text shows up readable
    // rather than as a parser stack trace.
    return `<p>${escapeHtml(content)}</p>`;
  }
}

/**
 * Markdown toolbar action repertoire. Used by both the click-driven
 * toolbar buttons above each editor and the keyboard shortcuts inside
 * the textarea. Two flavours:
 *
 *   - **Wrap actions** (`bold`, `italic`, `strike`, `code`, `link`)
 *     surround the current selection with markers. When the selection
 *     is empty, a placeholder is inserted and the caret lands on it
 *     ready for typing.
 *
 *   - **Line actions** (`h1`/`h2`/`h3`, `ul`, `ol`, `quote`) prepend a
 *     marker to the start of every line covered by the selection. When
 *     the line already starts with the same marker the prefix is
 *     stripped — clicking H2 a second time removes the heading. This
 *     gives a click "behaves like a toggle" feel which is what users
 *     expect from a rich-text toolbar.
 */
type MarkdownAction =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "link"
  | "h1"
  | "h2"
  | "h3"
  | "ul"
  | "ol"
  | "quote";

/**
 * Apply a markdown formatting action to a textarea. Mutates the input
 * via `setContent` and re-positions the caret/selection so the next
 * keystroke or click "feels right" (caret inside the new wrapper, or
 * lying on the inserted placeholder).
 */
function applyMarkdownAction(
  ta: HTMLTextAreaElement,
  action: MarkdownAction,
  setContent: (next: string) => void
): void {
  const { selectionStart: start, selectionEnd: end, value } = ta;
  const before = value.slice(0, start);
  const middle = value.slice(start, end);
  const after = value.slice(end);

  // ---- Wrap actions ----
  if (
    action === "bold" ||
    action === "italic" ||
    action === "strike" ||
    action === "code"
  ) {
    const wrap =
      action === "bold"
        ? "**"
        : action === "italic"
          ? "*"
          : action === "strike"
            ? "~~"
            : "`";
    const placeholder = action === "code" ? "code" : "text";
    const body = middle || placeholder;
    const next = `${before}${wrap}${body}${wrap}${after}`;
    const caretStart = start + wrap.length;
    const caretEnd = caretStart + body.length;
    commit(ta, setContent, next, caretStart, caretEnd);
    return;
  }
  if (action === "link") {
    if (middle.length === 0) {
      const placeholder = "text";
      const next = `${before}[${placeholder}](url)${after}`;
      commit(ta, setContent, next, start + 1, start + 1 + placeholder.length);
    } else {
      const next = `${before}[${middle}](url)${after}`;
      const caretStart = start + middle.length + 3;
      commit(ta, setContent, next, caretStart, caretStart + "url".length);
    }
    return;
  }

  // ---- Line actions ----
  // Find the start of the line containing `start` (look back for
  // a newline; default to 0). Apply the prefix toggle to every line
  // intersecting the selection.
  const prefix =
    action === "h1"
      ? "# "
      : action === "h2"
        ? "## "
        : action === "h3"
          ? "### "
          : action === "ul"
            ? "- "
            : action === "ol"
              ? "1. "
              : "> ";

  const lineStart = before.lastIndexOf("\n") + 1; // 0 when there's no prior newline
  // Selection covers from lineStart through `end`; everything we
  // touch lives between those two anchors.
  const block = value.slice(lineStart, end);
  const lines = block.split("\n");

  // Toggle the prefix on each line. Detection is forgiving — we
  // recognise any heading-marker variant when toggling H1/H2/H3 so a
  // second click on H1 over an H2 line still flips it back to plain.
  const toggled = lines.map((line) => {
    const headingMatch = /^#{1,6}\s+/;
    const ulMatch = /^[-*]\s+/;
    const olMatch = /^\d+\.\s+/;
    const quoteMatch = /^>\s+/;

    if (action === "h1" || action === "h2" || action === "h3") {
      if (headingMatch.test(line)) {
        // Already a heading — strip it. Clicking H2 on an H1 line
        // is intuitively "remove heading" in v1; users can click H2
        // a second time to apply.
        return line.replace(headingMatch, "");
      }
      return prefix + line;
    }
    if (action === "ul") {
      if (ulMatch.test(line)) {
        return line.replace(ulMatch, "");
      }
      return prefix + line;
    }
    if (action === "ol") {
      if (olMatch.test(line)) {
        return line.replace(olMatch, "");
      }
      return prefix + line;
    }
    if (action === "quote") {
      if (quoteMatch.test(line)) {
        return line.replace(quoteMatch, "");
      }
      return prefix + line;
    }
    return line;
  });

  const newBlock = toggled.join("\n");
  const next = `${value.slice(0, lineStart)}${newBlock}${after}`;
  // Re-select the entire toggled block so a subsequent click keeps
  // operating on the same range.
  commit(ta, setContent, next, lineStart, lineStart + newBlock.length);
}

/**
 * Shared "apply value, restore caret" helper. setContent triggers a
 * React re-render; we defer the selection-range restore to a
 * microtask so it runs against the post-render DOM.
 */
function commit(
  ta: HTMLTextAreaElement,
  setContent: (next: string) => void,
  next: string,
  caretStart: number,
  caretEnd: number
): void {
  setContent(next);
  queueMicrotask(() => {
    ta.focus();
    ta.setSelectionRange(caretStart, caretEnd);
  });
}

/**
 * Apply the Cmd/Ctrl+B / Cmd/Ctrl+I / Cmd/Ctrl+K markdown shortcuts
 * inside a textarea. Returns true when the event was handled (caller
 * should call preventDefault). Mirrors the shortcuts described in
 * https://privacytracker-docs.privacykey.org/develop/feature-flags.
 *
 *   Cmd+B → wraps selection in **double asterisks**
 *   Cmd+I → wraps selection in *single asterisks*
 *   Cmd+K → wraps selection as [selection](url) with cursor positioned
 *           inside the URL slot when the selection is non-empty, or as
 *           [text](url) with selection landing on `text` when empty.
 *
 * Now backed by `applyMarkdownAction` so the keyboard path and the
 * toolbar-button path produce identical results.
 */
function applyMarkdownShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  setContent: (value: string) => void
): boolean {
  const meta = event.metaKey || event.ctrlKey;
  if (!meta) {
    return false;
  }
  const key = event.key.toLowerCase();
  const action: MarkdownAction | null =
    key === "b" ? "bold" : key === "i" ? "italic" : key === "k" ? "link" : null;
  if (!action) {
    return false;
  }
  event.preventDefault();
  applyMarkdownAction(event.currentTarget, action, setContent);
  return true;
}

/** Tag values only — labels are resolved at render via the `annotations` translator
 *  (key: `tag_no_tag` / `tag_concern` / `tag_positive` / `tag_follow_up` / `tag_other`). */
const TAG_OPTIONS: Array<{ value: AnnotationTag | ""; key: string }> = [
  { value: "", key: "tag_no_tag" },
  { value: "concern", key: "tag_concern" },
  { value: "positive", key: "tag_positive" },
  { value: "follow_up", key: "tag_follow_up" },
  { value: "other", key: "tag_other" },
];

const SOFT_LIMIT = 2000;
const SOFT_LIMIT_WARN = 1800;
const AUTOSAVE_DELAY_MS = 1000;
const UNDO_WINDOW_MS = 30_000;

interface Props {
  appId: string;
  /** Initial annotation list — server-rendered if available, otherwise fetched on mount. */
  initialAnnotations?: Annotation[];
  /** When true, the sidebar starts expanded; otherwise collapsed. */
  initiallyExpanded?: boolean;
}

interface UndoToast {
  annotationId: string;
  expiresAt: number;
}

export default function AnnotationsSidebar({
  appId,
  initialAnnotations,
  initiallyExpanded = false,
}: Props) {
  // i18n — sidebar header, expand/collapse toggle, loading copy,
  // editor placeholder + aria-labels (markdown-supported variants).
  const t = useTranslations("annotations");
  const [annotations, setAnnotations] = useState<Annotation[]>(
    initialAnnotations ?? []
  );
  const [loading, setLoading] = useState(initialAnnotations === undefined);
  const [undoToast, setUndoToast] = useState<UndoToast | null>(null);

  /**
   * Accordion expand/collapse state. Initial value comes from the
   * server-resolved flag (`flag.detail.annotations_sidebar`); the user
   * can override it manually, and that override is persisted in
   * localStorage so the panel stays in their preferred state across
   * navigation. The flag default still wins on first-ever mount —
   * localStorage only kicks in once the user has actively toggled.
   */
  const EXPAND_STORAGE_KEY = "annotations-sidebar-expanded";
  const [expanded, setExpanded] = useState<boolean>(initiallyExpanded);
  // Hydrate from localStorage on mount (must run client-side; reading
  // localStorage during initial useState would mismatch the server-
  // rendered HTML).
  useEffect(() => {
    try {
      const stored = localStorage.getItem(EXPAND_STORAGE_KEY);
      if (stored === "true") {
        setExpanded(true);
      } else if (stored === "false") {
        setExpanded(false);
      }
      // null = never toggled; keep flag default
    } catch {
      // localStorage may be disabled — non-fatal, keep flag default
    }
  }, []);

  function toggleExpanded() {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(EXPAND_STORAGE_KEY, String(next));
      } catch {
        // ignore — same rationale as the read above
      }
      return next;
    });
  }

  // Mount: if we don't have initial data, fetch.
  useEffect(() => {
    if (initialAnnotations !== undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/annotations?appId=${encodeURIComponent(appId)}`
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { annotations: Annotation[] };
        if (!cancelled) {
          setAnnotations(data.annotations ?? []);
        }
      } catch (e) {
        console.warn("[AnnotationsSidebar] failed to load:", e);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId, initialAnnotations]);

  // Tick the undo-toast countdown — re-render every 250ms while it's active.
  useEffect(() => {
    if (!undoToast) {
      return;
    }
    const t = window.setInterval(() => {
      if (Date.now() >= undoToast.expiresAt) {
        setUndoToast(null);
      } else {
        // Force a re-render so the countdown updates.
        setUndoToast({ ...undoToast });
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [undoToast]);

  // -------------------------------------------------------------------------
  // CRUD callbacks
  // -------------------------------------------------------------------------

  async function handleCreate(content: string): Promise<Annotation | null> {
    if (!content.trim()) {
      return null;
    }
    try {
      const res = await fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, content }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { annotation: Annotation };
      setAnnotations((prev) => [data.annotation, ...prev]);
      return data.annotation;
    } catch (e) {
      console.error("[AnnotationsSidebar] create failed:", e);
      return null;
    }
  }

  async function handleUpdate(
    id: string,
    patch: Partial<Annotation>
  ): Promise<void> {
    // Optimistic update.
    setAnnotations((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a
      )
    );
    try {
      const body: Record<string, unknown> = {};
      if (patch.content !== undefined) {
        body.content = patch.content;
      }
      if (patch.tag !== undefined) {
        body.tag = patch.tag;
      }
      if (patch.visibility !== undefined) {
        body.visibility = patch.visibility;
      }
      const res = await fetch(`/api/annotations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[AnnotationsSidebar] update failed:", e);
      // On failure, refetch to recover the canonical state.
      void refetch();
    }
  }

  async function handleDelete(id: string): Promise<void> {
    // Optimistic: hide the row immediately, show undo toast.
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setUndoToast({ annotationId: id, expiresAt: Date.now() + UNDO_WINDOW_MS });

    try {
      const res = await fetch(`/api/annotations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[AnnotationsSidebar] delete failed:", e);
      void refetch();
      setUndoToast(null);
    }
  }

  async function handleUndo(id: string): Promise<void> {
    setUndoToast(null);
    try {
      const res = await fetch(`/api/annotations/${encodeURIComponent(id)}`, {
        method: "PUT",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { annotation: Annotation };
      setAnnotations((prev) => [
        data.annotation,
        ...prev.filter((a) => a.id !== id),
      ]);
    } catch (e) {
      console.error("[AnnotationsSidebar] undo failed:", e);
    }
  }

  async function refetch(): Promise<void> {
    try {
      const res = await fetch(
        `/api/annotations?appId=${encodeURIComponent(appId)}`
      );
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as { annotations: Annotation[] };
      setAnnotations(data.annotations ?? []);
    } catch {
      // ignore — leave optimistic state alone
    }
  }

  const undoTimeRemaining = undoToast
    ? Math.max(0, Math.ceil((undoToast.expiresAt - Date.now()) / 1000))
    : 0;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Cap visible notes at 5 (per Q7 — small library, no search needed).
  // Anything past that lives behind a "Show all (N)" expander so the
  // panel doesn't scroll forever once a user has been at this for a
  // while. Newest first, since the existing fetch path returns
  // created_at DESC.
  const MAX_VISIBLE_NOTES = 5;
  const [showAllNotes, setShowAllNotes] = useState(false);
  const visibleNotes = showAllNotes
    ? annotations
    : annotations.slice(0, MAX_VISIBLE_NOTES);
  const hiddenCount = Math.max(0, annotations.length - MAX_VISIBLE_NOTES);

  /**
   * Layout mode: when the composer is open, should it take 50% of the
   * panel width (with the list shown beside it on the right half) or
   * the full width (single column, list pushed below)? Persists in
   * localStorage so the user's choice survives navigation. Defaults
   * to 'split' — narrow composer + visible list reads cleaner than a
   * full-width text box that buries the list below.
   */
  const LAYOUT_STORAGE_KEY = "annotations-sidebar-layout";
  const [layout, setLayout] = useState<"split" | "wide">("split");
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (stored === "wide") {
        setLayout("wide");
      } else if (stored === "split") {
        setLayout("split");
      }
    } catch {
      /* ignore */
    }
  }, []);
  function toggleLayout() {
    setLayout((prev) => {
      const next = prev === "split" ? "wide" : "split";
      try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  /**
   * Cmd/Ctrl+Z to undo the most recent delete while the toast is
   * visible. Only listens when there's an actively-undoable
   * annotation, and only when focus isn't currently in an editable
   * surface (textarea/input/contenteditable) so we don't fight the
   * browser's own per-field undo. Fires the same path the toast's
   * Undo button does, so the visible+keyboard affordances stay in
   * sync.
   */
  useEffect(() => {
    if (!undoToast) {
      return;
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z"
      ) {
        const target = e.target as HTMLElement | null;
        if (target) {
          const tag = target.tagName;
          if (
            tag === "INPUT" ||
            tag === "TEXTAREA" ||
            target.isContentEditable
          ) {
            return;
          }
        }
        e.preventDefault();
        void handleUndo(undoToast.annotationId);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undoToast]);

  return (
    <aside
      aria-labelledby="annotations-sidebar-title"
      className={`annotations-sidebar ${expanded ? "is-expanded" : "is-collapsed"}`}
    >
      {/*
        Accordion header — chevron + title + count form one click
        target on the left; a layout toggle (split vs wide composer)
        sits on the right. The +Add note button used to live here
        too, but the composer is now permanently visible alongside
        the notes list, so a button to open it would be redundant.
      */}
      <header className="annotations-sidebar__header">
        <button
          aria-controls="annotations-sidebar-body"
          aria-expanded={expanded}
          className="annotations-sidebar__toggle"
          onClick={toggleExpanded}
          type="button"
        >
          <span aria-hidden="true" className="annotations-sidebar__chevron">
            <svg
              aria-hidden="true"
              fill="none"
              height="14"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
              width="14"
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </span>
          <h3
            className="annotations-sidebar__title"
            id="annotations-sidebar-title"
          >
            {t("sidebar_title")}
            {annotations.length > 0 && (
              <span
                aria-label={t("n_notes_aria", { count: annotations.length })}
                className="annotations-sidebar__count"
              >
                {annotations.length}
              </span>
            )}
          </h3>
        </button>
        {/*
          Header action cluster on the right — natural left-to-right
          reading puts the chevron + title on the left, the actions
          on the right. The layout toggle lets the user flip the
          permanently-visible composer between "side-by-side with the
          notes list" (split, default) and "full-width above the list"
          (wide). Clicking it stops propagation so it doesn't also
          fire the accordion toggle on the parent button.
        */}
        {expanded && (
          <div className="annotations-sidebar__header-actions">
            <button
              aria-label={
                layout === "split"
                  ? t("layout_wide_aria")
                  : t("layout_split_aria")
              }
              aria-pressed={layout === "split"}
              className="annotations-sidebar__layout-toggle"
              onClick={(e) => {
                e.stopPropagation();
                toggleLayout();
              }}
              title={
                layout === "split"
                  ? t("layout_wide_title")
                  : t("layout_split_title")
              }
              type="button"
            >
              {/* Two icons, swapped by `is-split`/`is-wide`: a
                  half-bar shape for split, a full-bar shape for
                  wide. SVG paths are tiny so we inline them. */}
              <svg
                aria-hidden="true"
                fill="none"
                height="14"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                width="14"
              >
                {layout === "split" ? (
                  <>
                    <rect height="14" rx="1.5" width="8" x="3" y="5" />
                    <rect height="14" rx="1.5" width="8" x="13" y="5" />
                  </>
                ) : (
                  <rect height="14" rx="1.5" width="18" x="3" y="5" />
                )}
              </svg>
            </button>
          </div>
        )}
      </header>

      {/*
        Animated body — `max-height` transition keeps the open/close
        smooth without needing a JS measure. The wrapper carries the
        `is-collapsed` class so the transition runs both directions;
        the inner content holds its own padding so the collapse
        animation reads as content-shrinking-out rather than a hard
        clip at zero height.
      */}
      <div
        // aria-hidden when collapsed so screen readers skip the list
        // entirely while it's not visible.
        aria-hidden={!expanded}
        className={
          "annotations-sidebar__body" +
          (layout === "split"
            ? " annotations-sidebar__body--composing-split"
            : "")
        }
        id="annotations-sidebar-body"
      >
        {/*
          Composer is permanently mounted alongside the notes list.
          In split layout it takes 50% width and the list scrolls
          alongside it on the right. In wide layout it takes the full
          width and the list stacks below. No `composing` toggle —
          the editor is always there, ready to be typed in.
        */}
        {!loading && (
          <div className="annotations-sidebar__composer-slot">
            <NewAnnotationForm onCreate={(content) => handleCreate(content)} />
          </div>
        )}
        <div aria-label={t("list_aria")} className="annotations-sidebar__list">
          {loading && (
            <p className="annotations-sidebar__loading">{t("loading")}</p>
          )}

          {!loading && annotations.length === 0 && (
            <div className="annotations-sidebar__empty">
              <p>{t("empty_title")}</p>
              <p className="annotations-sidebar__empty-sub">{t("empty_sub")}</p>
            </div>
          )}

          {!loading &&
            visibleNotes.map((annotation) => (
              <AnnotationCard
                annotation={annotation}
                key={annotation.id}
                onDelete={() => handleDelete(annotation.id)}
                onUpdate={(patch) => handleUpdate(annotation.id, patch)}
              />
            ))}

          {!loading && hiddenCount > 0 && (
            <button
              aria-expanded={showAllNotes}
              className="annotations-sidebar__show-all"
              onClick={() => setShowAllNotes((v) => !v)}
              type="button"
            >
              {showAllNotes
                ? t("show_fewer", { count: hiddenCount })
                : t("show_all", {
                    count: annotations.length,
                    hidden: hiddenCount,
                  })}
            </button>
          )}
        </div>

        {undoToast && (
          <div
            aria-live="polite"
            className="annotations-sidebar__undo-toast"
            role="status"
          >
            {t("undo_deleted")}{" "}
            <button
              className="annotations-sidebar__undo-btn"
              onClick={() => handleUndo(undoToast.annotationId)}
              type="button"
            >
              {t("undo_button")}
            </button>
            <span className="annotations-sidebar__undo-counter">
              {t("undo_counter", { sec: undoTimeRemaining })}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// AnnotationCard — single-note edit-in-place
// ---------------------------------------------------------------------------

interface CardProps {
  annotation: Annotation;
  onDelete: () => void;
  onUpdate: (patch: Partial<Annotation>) => void;
}

function AnnotationCard({ annotation, onUpdate, onDelete }: CardProps) {
  // i18n — captured at the top of this nested helper so the
  // edit-textarea aria-label, tag-select aria, and delete-button aria
  // referenced below resolve against the active locale.
  const t = useTranslations("annotations");
  const [content, setContent] = useState(annotation.content);
  const [editing, setEditing] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Edit / Preview tab inside the inline editor. Defaults to 'edit'
  // every time the user enters edit mode so the textarea is the first
  // thing they see. Switching to 'preview' renders the live markdown
  // result without saving — they can flip back to keep typing.
  const [editMode, setEditMode] = useState<"edit" | "preview">("edit");
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced auto-save on content edit.
  useEffect(() => {
    if (!editing) {
      return;
    }
    if (content === annotation.content) {
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      onUpdate({ content });
      setSavedAt(Date.now());
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [content, editing, annotation.content, onUpdate]);

  const renderedHtml = useMemo(
    () => renderAnnotation(annotation.content),
    [annotation.content]
  );

  const sourceLabel =
    annotation.source === "imported"
      ? t("source_imported", {
          name: annotation.sourceName ?? t("source_default_name"),
        })
      : t("source_self");

  const charCount = content.length;
  const charClass =
    charCount > SOFT_LIMIT
      ? "annotation-card__char-counter is-over"
      : charCount >= SOFT_LIMIT_WARN
        ? "annotation-card__char-counter is-warning"
        : "annotation-card__char-counter";

  function handleVisibilityToggle() {
    const next: AnnotationVisibility =
      annotation.visibility === "private" ? "export" : "private";
    onUpdate({ visibility: next });
  }

  function handleTagChange(value: string) {
    const next = value === "" ? null : (value as AnnotationTag);
    onUpdate({ tag: next });
  }

  return (
    <article
      aria-label={sourceLabel}
      className={`annotation-card annotation-card--${annotation.source} annotation-card--tag-${annotation.tag ?? "none"}`}
    >
      {/*
        Header — left side: source label · "·" · relative time, all
        with proper word-spacing so they read as a sentence rather
        than a mashed-up block. Right side: tag chip (always visible
        — the colour-coded affordance to set/change a tag is the
        card's primary metadata) plus an action cluster (lock /
        delete) tucked alongside it which fades in on hover.
      */}
      <header className="annotation-card__header">
        <div className="annotation-card__byline">
          <span className="annotation-card__source">{sourceLabel}</span>
          <span aria-hidden="true" className="annotation-card__byline-sep">
            ·
          </span>
          <span className="annotation-card__last-edited">
            {relativeTime(t, annotation.updatedAt)}
          </span>
        </div>
        <div className="annotation-card__header-right">
          <div className="annotation-card__header-actions">
            <button
              aria-label={
                annotation.visibility === "private"
                  ? t("visibility_private_aria")
                  : t("visibility_public_aria")
              }
              aria-pressed={annotation.visibility === "private"}
              className={`annotation-card__visibility ${annotation.visibility === "private" ? "is-private" : ""}`}
              onClick={handleVisibilityToggle}
              title={
                annotation.visibility === "private"
                  ? t("visibility_private_title")
                  : t("visibility_public_title")
              }
              type="button"
            >
              {annotation.visibility === "private" ? "🔒" : "🔓"}
            </button>
            <button
              aria-label={t("delete")}
              className="annotation-card__delete"
              onClick={onDelete}
              title={t("delete")}
              type="button"
            >
              🗑
            </button>
          </div>
          <span
            className={`annotation-card__tag-chip annotation-card__tag-chip--${annotation.tag ?? "none"}`}
          >
            <span aria-hidden="true" className="annotation-card__tag-chip-icon">
              🏷
            </span>
            <span className="annotation-card__tag-chip-label">
              {annotation.tag
                ? TAG_OPTIONS.find((o) => o.value === annotation.tag)?.key
                  ? t(TAG_OPTIONS.find((o) => o.value === annotation.tag)!.key)
                  : annotation.tag
                : t("tag_add")}
            </span>
            {/*
              Real <select> stacked on top of the chip with opacity:0
              so users click the visible pill and the native picker
              opens. Keeps keyboard / SR semantics clean — no manual
              menu logic.
            */}
            <select
              aria-label={t("tag_aria")}
              className="annotation-card__tag-chip-select"
              onChange={(e) => handleTagChange(e.target.value)}
              value={annotation.tag ?? ""}
            >
              {TAG_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.key)}
                </option>
              ))}
            </select>
          </span>
        </div>
      </header>

      {editing ? (
        // Inline editor reuses the same `.annotations-composer`
        // chrome as the new-note composer on the left of the sidebar
        // — bordered card, header strip carrying Write/Preview tabs
        // + markdown toolbar, padded textarea body. Keeps the typing
        // surface visually consistent across "create" and "edit"
        // flows. The card's existing footer below renders the char
        // counter + "Saved" flash, so we omit the composer's own
        // footer here.
        <div
          className="annotations-composer annotations-composer--inline"
          // Keep the inline editor "alive" while users interact with
          // the toolbar and tabs. The original onBlur on the textarea
          // closed the card whenever the user clicked anything else,
          // including the toolbar; we now close on blur of the whole
          // editing region instead, which fires only when focus
          // really leaves the card.
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setEditing(false);
            }
          }}
        >
          <div className="annotations-composer-header">
            <div
              aria-label={t("composer_tabs_aria")}
              className="annotations-composer-tabs"
              role="tablist"
            >
              <button
                aria-selected={editMode === "edit"}
                className={`annotations-composer-tab${editMode === "edit" ? " is-active" : ""}`}
                onClick={() => setEditMode("edit")}
                role="tab"
                type="button"
              >
                {t("write_tab")}
              </button>
              <button
                aria-selected={editMode === "preview"}
                className={`annotations-composer-tab${editMode === "preview" ? " is-active" : ""}`}
                disabled={!content.trim()}
                onClick={() => setEditMode("preview")}
                role="tab"
                title={
                  content.trim()
                    ? t("preview_enabled_title")
                    : t("preview_disabled_title")
                }
                type="button"
              >
                {t("preview_tab")}
              </button>
            </div>
            {editMode === "edit" && (
              <MarkdownToolbar
                setContent={setContent}
                textareaRef={editorRef}
              />
            )}
          </div>

          <div className="annotations-composer-body">
            {editMode === "edit" ? (
              <textarea
                aria-describedby="annotation-md-hint"
                // Advertise the keyboard shortcuts to AT users so they
                // hear "Bold (Cmd B), Italic (Cmd I), Link (Cmd K)" when
                // landing on the textarea.
                aria-keyshortcuts="Meta+B Meta+I Meta+K Control+B Control+I Control+K"
                aria-label={t("edit_note_aria")}
                className="annotations-composer-textarea"
                onChange={(e) => setContent(e.target.value)}
                // No autoFocus — the composer is permanent (mounts with the
                // sidebar on every app-page navigation), so an autoFocus
                // here would steal focus on every page load and scroll the
                // page down to the bottom of the sidebar. The user has to
                // click into the textarea to start typing — same affordance
                // as any other always-visible form control on the page.
                onKeyDown={(e) => applyMarkdownShortcut(e, setContent)}
                ref={editorRef}
                rows={6}
                value={content}
              />
            ) : (
              <section
                aria-label={t("markdown_preview_aria")}
                className="annotations-composer-preview"
                dangerouslySetInnerHTML={{ __html: renderAnnotation(content) }}
              />
            )}
          </div>
        </div>
      ) : (
        <div
          className="annotation-card__content"
          // Marked v15 dropped the legacy `sanitize` option. We
          // mitigate via the renderer override above (raw HTML
          // tokens render as `<code>`-wrapped escaped text, link
          // hrefs are filtered to http(s)/mailto/#-anchors only).
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setEditing(true);
            }
          }}
          role="button"
          tabIndex={0}
        />
      )}

      {/*
        Footer — only renders while the user is actively editing the
        note, carrying the char counter and the brief "Saved" flash.
        The tag chip moved to the header's top-right cluster, so
        idle cards don't render a footer at all (cleaner sticky-note
        silhouette).
      */}
      {editing && (
        <footer className="annotation-card__footer">
          <span className="annotation-card__editor-meta">
            <span aria-live="polite" className={charClass}>
              {charCount} / {SOFT_LIMIT}
            </span>
            {savedAt && Date.now() - savedAt < 2000 && (
              <span aria-live="polite" className="annotation-card__saved">
                {t("saved")}
              </span>
            )}
          </span>
        </footer>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// NewAnnotationForm — inline GitHub-style composer
// ---------------------------------------------------------------------------
//
// Rebuilt around the GitHub issue-comment composer aesthetic: a
// bordered card with a single header strip carrying Write / Preview
// tabs on the left and the markdown toolbar on the right, the
// textarea body below with comfortable internal padding, and a
// footer with the markdown hint, char counter, and Cancel / Add
// note actions. Lives inline at the bottom of the notes list (not
// in a drawer or sidebar overlay) so the editor sits in context.

interface NewProps {
  /** Called when the user dismisses the composer without saving. */
  onCancel?: () => void;
  onCreate: (content: string) => Promise<Annotation | null>;
}

function NewAnnotationForm({ onCreate, onCancel }: NewProps) {
  // i18n — for the new-note placeholder + aria-label.
  const t = useTranslations("annotations");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Edit / Preview tab. Defaults to 'edit' on each mount so the
  // textarea is the first thing the user sees when starting a new
  // note.
  const [editMode, setEditMode] = useState<"edit" | "preview">("edit");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // No auto-focus on mount. The composer is permanent — it mounts
  // alongside the notes list every time the sidebar appears (i.e.
  // every navigation to an app detail page). Auto-focusing on mount
  // steals focus from whatever the user was reading, scrolling the
  // page down to the bottom of the sidebar where the composer sits.
  // Users click into the textarea to start typing, same as any
  // other always-visible form control on the page.
  //
  // (Previous behaviour relied on this being a click-to-show composer
  // — autofocus made sense then because mounting WAS the user's
  // click. That's no longer true since the composer became permanent
  // earlier in the session.)

  // Esc to cancel — only meaningful when the user has wired an
  // onCancel handler (i.e. the inline composer in the sidebar). The
  // listener self-gates on focus inside the form so other Esc
  // handlers (modals, popovers) keep working everywhere else.
  useEffect(() => {
    if (!onCancel) {
      return;
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      const active = document.activeElement;
      if (active && textareaRef.current?.contains(active)) {
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function handleSubmit() {
    if (!content.trim() || submitting) {
      return;
    }
    setSubmitting(true);
    const result = await onCreate(content);
    if (result) {
      setContent("");
      setEditMode("edit");
    }
    setSubmitting(false);
  }

  const charCount = content.length;
  const charClass =
    charCount > SOFT_LIMIT
      ? "annotation-card__char-counter is-over"
      : charCount >= SOFT_LIMIT_WARN
        ? "annotation-card__char-counter is-warning"
        : "annotation-card__char-counter";

  return (
    <form
      className="annotations-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
    >
      {/*
        Header strip — Write / Preview tabs on the left, markdown
        toolbar on the right. One row, mirrors GitHub's composer.
        The toolbar is hidden in Preview mode because there's
        nothing to format when the textarea isn't visible.
      */}
      <div className="annotations-composer-header">
        <div
          aria-label={t("composer_tabs_aria_new")}
          className="annotations-composer-tabs"
          role="tablist"
        >
          <button
            aria-selected={editMode === "edit"}
            className={`annotations-composer-tab${editMode === "edit" ? " is-active" : ""}`}
            onClick={() => setEditMode("edit")}
            role="tab"
            type="button"
          >
            {t("write_tab")}
          </button>
          <button
            aria-selected={editMode === "preview"}
            className={`annotations-composer-tab${editMode === "preview" ? " is-active" : ""}`}
            disabled={!content.trim()}
            onClick={() => setEditMode("preview")}
            role="tab"
            title={
              content.trim()
                ? t("preview_enabled_title")
                : t("preview_disabled_title")
            }
            type="button"
          >
            {t("preview_tab")}
          </button>
        </div>
        {editMode === "edit" && (
          <MarkdownToolbar setContent={setContent} textareaRef={textareaRef} />
        )}
      </div>

      {/*
        Body — the textarea or the preview pane. Wrapped in a
        consistent padded container so flipping between modes
        doesn't reflow the card.
      */}
      <div className="annotations-composer-body">
        {editMode === "edit" ? (
          <textarea
            aria-describedby="annotation-md-hint-new"
            aria-keyshortcuts="Meta+B Meta+I Meta+K Control+B Control+I Control+K"
            aria-label={t("new_note_aria")}
            className="annotations-composer-textarea"
            disabled={submitting}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => applyMarkdownShortcut(e, setContent)}
            placeholder={t("editor_placeholder_md")}
            ref={textareaRef}
            rows={6}
            value={content}
          />
        ) : (
          <section
            aria-label={t("markdown_preview_aria")}
            className="annotations-composer-preview"
            dangerouslySetInnerHTML={{ __html: renderAnnotation(content) }}
          />
        )}
      </div>

      {/*
        Footer — markdown hint on the left, action cluster on the
        right. The hint surfaces as a quiet "Markdown supported" line
        rather than the full collapsible legend, since the toolbar
        already exposes every action visually. Char counter sits
        adjacent to the action cluster so the user sees the limit
        next to the Add button it gates.
      */}
      <div className="annotations-composer-footer">
        <span className="annotations-composer-hint">
          <span aria-hidden="true">📝</span> {t("markdown_supported")}
        </span>
        <div className="annotations-composer-actions">
          <span aria-live="polite" className={charClass}>
            {charCount} / {SOFT_LIMIT}
          </span>
          {onCancel && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={submitting}
              onClick={onCancel}
              type="button"
            >
              {t("cancel")}
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            disabled={!content.trim() || submitting}
            type="submit"
          >
            {submitting ? t("saving") : t("add_note")}
          </button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Markdown editing toolbar — sits above the textarea and gives users a
 * point-and-click path through the same actions the keyboard shortcuts
 * provide. Each button ends up calling `applyMarkdownAction` against
 * the connected textarea, so the toolbar and the keyboard path produce
 * identical edits.
 *
 * The toolbar is intentionally compact (icons + tight gaps) so it
 * doesn't dominate the editor on the narrow sidebar layout. Buttons
 * use `onMouseDown + preventDefault` so a click doesn't blur the
 * textarea (which would otherwise close the inline editor before the
 * action ran).
 */
interface ToolbarProps {
  setContent: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

function MarkdownToolbar({ textareaRef, setContent }: ToolbarProps) {
  const t = useTranslations("annotations");
  function run(action: MarkdownAction) {
    const ta = textareaRef.current;
    if (!ta) {
      return;
    }
    applyMarkdownAction(ta, action, setContent);
  }
  // Each button entry — `kind`, the icon glyph, and the translation key
  // for the human-readable label (rendered as both the title attr for
  // mouse hover and the aria-label for screen readers).
  const buttons: Array<{ action: MarkdownAction; icon: string; key: string }> =
    [
      { action: "bold", icon: "B", key: "toolbar_bold" },
      { action: "italic", icon: "I", key: "toolbar_italic" },
      { action: "strike", icon: "S", key: "toolbar_strike" },
      { action: "code", icon: "<>", key: "toolbar_code" },
      { action: "link", icon: "🔗", key: "toolbar_link" },
      { action: "h2", icon: "H", key: "toolbar_h2" },
      { action: "ul", icon: "•", key: "toolbar_ul" },
      { action: "ol", icon: "1.", key: "toolbar_ol" },
      { action: "quote", icon: "❝", key: "toolbar_quote" },
    ];
  return (
    <div
      aria-label={t("toolbar_aria")}
      className="annotation-toolbar"
      role="toolbar"
    >
      {buttons.map((b) => {
        const label = t(b.key);
        return (
          <button
            aria-label={label}
            className={`annotation-toolbar-btn annotation-toolbar-btn-${b.action}`}
            key={b.action}
            onClick={() => run(b.action)}
            // Prevent the textarea from losing focus on click — without
            // this, the inline-editor's blur handler closes the editor
            // before the action runs.
            onMouseDown={(e) => e.preventDefault()}
            title={label}
            type="button"
          >
            <span aria-hidden="true">{b.icon}</span>
          </button>
        );
      })}
    </div>
  );
}

type AnnT = (key: string, values?: Record<string, string | number>) => string;
function relativeTime(t: AnnT, ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) {
    return t("rel_just_now");
  }
  if (s < 3600) {
    return t("rel_minutes", { count: Math.floor(s / 60) });
  }
  if (s < 86_400) {
    return t("rel_hours", { count: Math.floor(s / 3600) });
  }
  const d = Math.floor(s / 86_400);
  if (d === 1) {
    return t("rel_yesterday");
  }
  if (d < 30) {
    return t("rel_days", { count: d });
  }
  return t("rel_months", { count: Math.floor(d / 30) });
}

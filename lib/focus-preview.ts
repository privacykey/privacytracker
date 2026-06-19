/**
 * sessionStorage-backed staging of audience/goals changes. The focus-edit
 * form stages a preview here; a banner offers Keep (POST /api/focus) or
 * Revert (drop). Server-rendered pages still resolve flags against the DB
 * during preview, so Keep triggers a full page reload.
 *
 * sessionStorage gives per-tab isolation (closing the tab implicitly reverts)
 * and survives same-tab refreshes. Helpers guard `typeof window` so they're
 * safe to call from SSR — they just return null.
 *
 * Docs: https://privacytracker-docs.privacykey.org/develop/feature-flags
 */

import { type AgeBandKey, isValidAgeBand } from "./age-rating";
import type { Audience } from "./feature-flag-rules";
import {
  type FocusWorkflow,
  inferFocusWorkflow,
  isFocusWorkflow,
} from "./focus-workflow";
import type { UserTaskId } from "./tasks";

const STORAGE_KEY = "focus_preview";
const HINT_KEY = "focus_preview_hint_shown";

/**
 * Custom event for in-tab preview mutations. The native `storage` event
 * only fires on OTHER tabs, so we need our own dispatch.
 */
const CHANGE_EVENT = "focus-preview-changed";

/**
 * Stored preview blob. Matches the POST `/api/focus` body shape so the
 * commit path can pass it through (minus `startedAt`).
 */
export interface FocusPreview {
  accessibility: boolean;
  audience: Audience;
  /** Guardian child age band. `undefined` = leave unchanged; `null` = clear. */
  childAgeBand?: AgeBandKey | null;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
  /** Epoch ms when the user staged this preview. Used by the banner. */
  startedAt: number;
  taskOptIns?: UserTaskId[];
  workflow: FocusWorkflow;
}

const PREVIEW_TASK_IDS: readonly UserTaskId[] = [
  "setup_background_mode",
  "remove_apps_from_phone",
  "export_audit_bundle",
];

/**
 * Read the current preview, or null when nothing's staged. Returns null
 * during SSR (no window) and on parse failures (treat malformed blobs as
 * "no preview" rather than crashing the banner).
 */
export function getPreviewFocus(): FocusPreview | null {
  if (typeof window === "undefined") {
    return null;
  }
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // sessionStorage throws in private-mode Safari and some hardened configs.
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const audience = parsed.audience;
    if (
      audience !== "self" &&
      audience !== "loved_one" &&
      audience !== "guardian"
    ) {
      return null;
    }
    const monitor = Boolean(parsed.monitor);
    const cleanup = Boolean(parsed.cleanup);
    const minimal = Boolean(parsed.minimal);
    return {
      audience,
      monitor,
      cleanup,
      minimal,
      accessibility: Boolean(parsed.accessibility),
      childAgeBand: isValidAgeBand(parsed.childAgeBand)
        ? parsed.childAgeBand
        : parsed.childAgeBand === null
          ? null
          : undefined,
      workflow: isFocusWorkflow(parsed.workflow)
        ? parsed.workflow
        : inferFocusWorkflow({ audience, monitor, cleanup, minimal }),
      taskOptIns: Array.isArray(parsed.taskOptIns)
        ? parsed.taskOptIns.filter((id: unknown): id is UserTaskId =>
            PREVIEW_TASK_IDS.includes(id as UserTaskId)
          )
        : undefined,
      startedAt:
        typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/** Stage a preview. Mirrors the POST `/api/focus` body shape. */
export function setPreviewFocus(focus: Omit<FocusPreview, "startedAt">): void {
  if (typeof window === "undefined") {
    return;
  }
  const blob: FocusPreview = { ...focus, startedAt: Date.now() };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    // Reset the hint tracker so it's shown once per preview session.
    window.sessionStorage.removeItem(HINT_KEY);
  } catch {
    return;
  }
  dispatchChange();
}

/** Drop the preview without committing. Used by Revert and post-commit cleanup. */
export function clearPreviewFocus(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(HINT_KEY);
  } catch {
    return;
  }
  dispatchChange();
}

/** Mark the "Closing this tab reverts" hint as shown for this preview session. */
export function markHintShown(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(HINT_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function isHintShown(): boolean {
  if (typeof window === "undefined") {
    return true; // SSR — render without hint
  }
  try {
    return window.sessionStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * Subscribe to in-tab preview state changes. Returns an unsubscribe fn.
 * Listens to a custom event for in-tab updates and the native `storage`
 * event for cross-tab clears.
 */
export function subscribePreview(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handler = () => callback();
  window.addEventListener(CHANGE_EVENT, handler);
  const storageHandler = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      callback();
    }
  };
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", storageHandler);
  };
}

function dispatchChange(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

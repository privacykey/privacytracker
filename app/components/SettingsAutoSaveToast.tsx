"use client";

/**
 * Bottom-center toast that confirms or surfaces failure for inline
 * settings auto-saves. Singleton pill — one toast, one position;
 * new pushes replace the message and reset the timer. Click-to-dismiss
 * via the pill body or the × button. Fades in, holds DEFAULT_HOLD_MS
 * (5 s), fades out.
 *
 * Driven imperatively via a window-event pub/sub so any callsite can
 * call `pushSettingsToast(...)` without context wiring. Mount once at
 * the top of `SettingsView`. When `mirrorToTaskCenter` is true, each
 * push also writes a synthetic auto-completed Task Center entry.
 */

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTaskCenter } from "./TaskCenter";

const TOAST_EVENT = "privacytracker:settings-toast";
/** How long the pill stays fully visible before auto-fading. */
const DEFAULT_HOLD_MS = 5000;
const FADE_MS = 200;

export type SettingsToastKind = "success" | "error" | "info";

export interface SettingsToastDetail {
  /** Optional override for hold duration in ms. Defaults to 2500. */
  holdMs?: number;
  kind: SettingsToastKind;
  /** Short user-facing message — keep under ~60 chars; the pill clamps wider strings. */
  message: string;
  /**
   * Optional Task Center label. When the user has the "Also log to
   * Task Center" preference on, this is what appears in the dropdown.
   * Falls back to `message` when omitted.
   */
  taskLabel?: string;
}

/**
 * Imperative push API. Any component can call this — the mounted toast
 * picks it up via a window event. Returns immediately.
 */
export function pushSettingsToast(detail: SettingsToastDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<SettingsToastDetail>(TOAST_EVENT, { detail })
  );
}

interface ToastState {
  detail: SettingsToastDetail;
  /** Monotonic id so identical messages re-trigger the fade animation. */
  id: number;
}

export default function SettingsAutoSaveToast({
  /** Whether to also mirror toasts as ephemeral Task Center entries. */
  mirrorToTaskCenter = false,
}: {
  mirrorToTaskCenter?: boolean;
}) {
  const t = useTranslations("autosave_toast");
  const [state, setState] = useState<ToastState | null>(null);
  const [fading, setFading] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);
  const taskCenter = useTaskCenter();

  // Keep the latest mirror flag in a ref so the event handler reads
  // the current value without forcing re-subscriptions on toggle.
  const mirrorRef = useRef(mirrorToTaskCenter);
  useEffect(() => {
    mirrorRef.current = mirrorToTaskCenter;
  }, [mirrorToTaskCenter]);

  const clearTimers = useCallback(() => {
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    if (removeTimerRef.current) {
      clearTimeout(removeTimerRef.current);
      removeTimerRef.current = null;
    }
  }, []);

  /**
   * Manually dismiss the toast. Cancels the hold timer, plays the fade,
   * and unmounts after FADE_MS. Idempotent.
   */
  const dismiss = useCallback(() => {
    clearTimers();
    setFading(true);
    removeTimerRef.current = setTimeout(() => {
      setState(null);
      setFading(false);
    }, FADE_MS);
  }, [clearTimers]);

  useEffect(() => {
    function onPush(e: Event) {
      const ce = e as CustomEvent<SettingsToastDetail>;
      const detail = ce.detail;
      if (!detail || typeof detail.message !== "string") {
        return;
      }

      // Replace whatever toast is currently visible.
      clearTimers();
      idRef.current += 1;
      setFading(false);
      setState({ detail, id: idRef.current });

      // Mirror to Task Center if opted in. Complete immediately so
      // it shows as a one-line entry rather than an in-progress card.
      if (mirrorRef.current) {
        try {
          const handle = taskCenter.startTask({
            title: detail.taskLabel ?? detail.message,
            kind: "sync", // generic — TaskCenter doesn't have a "settings" kind
          });
          handle.complete(
            detail.kind === "error" ? "error" : "done",
            detail.message
          );
        } catch {
          // TaskCenter unavailable — mirror is best-effort.
        }
      }

      const hold =
        typeof detail.holdMs === "number" && detail.holdMs > 0
          ? detail.holdMs
          : DEFAULT_HOLD_MS;
      fadeTimerRef.current = setTimeout(() => {
        setFading(true);
        removeTimerRef.current = setTimeout(() => {
          setState(null);
          setFading(false);
        }, FADE_MS);
      }, hold);
    }

    window.addEventListener(TOAST_EVENT, onPush);
    return () => {
      window.removeEventListener(TOAST_EVENT, onPush);
      clearTimers();
    };
  }, [clearTimers, taskCenter]);

  if (!state) {
    return null;
  }

  const { detail, id } = state;
  return (
    <div
      aria-live="polite"
      className={`settings-autosave-toast settings-autosave-toast--${detail.kind}${
        fading ? "is-fading" : ""
      }`}
      key={id}
      // Whole-pill click dismisses; the × button is the keyboard path.
      onClick={dismiss}
      role="status"
    >
      {detail.kind === "success" && <span aria-hidden="true">✓</span>}
      {detail.kind === "error" && <span aria-hidden="true">⚠</span>}
      {detail.kind === "info" && <span aria-hidden="true">ℹ</span>}
      <span className="settings-autosave-toast-text">{detail.message}</span>
      <button
        aria-label={t("dismiss")}
        className="settings-autosave-toast-dismiss"
        onClick={(e) => {
          // Don't bubble to the wrapper's onClick (dismiss would run twice).
          e.stopPropagation();
          dismiss();
        }}
        type="button"
      >
        ×
      </button>
    </div>
  );
}

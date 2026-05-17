"use client";

/**
 * Shared state hook for the dashboard layout editors. Both the
 * /dashboard/settings/layout page (list view) and the inline edit-mode
 * on /dashboard mount their own version of this hook, so the underlying
 * persist semantics (debounced PUT, preset POST, reset DELETE,
 * stale-response handling) stay in one place.
 *
 * The hook is intentionally UI-agnostic — callers wire their own DnD,
 * preset pills, toolbar, etc. on top of the returned values. ARIA live
 * announcements ARE generated here because they're tightly coupled to
 * which state transition just happened; consumers render them into a
 * polite live region of their choice.
 */

import { arrayMove } from "@dnd-kit/sortable";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DashboardCardId,
  type DashboardLayout,
  type DashboardPresetKey,
  FIRST_CLASS_CARDS,
  matchDashboardPreset,
} from "./dashboard-layout";

const SAVE_DEBOUNCE_MS = 250;
const SAVED_BADGE_MS = 1400;

export type LayoutSaverState = "idle" | "saving" | "saved" | "error";

export interface UseDashboardLayoutSaverResult {
  activePreset: DashboardPresetKey | null;
  applyPreset: (
    preset: DashboardPresetKey,
    viaConfirm?: boolean
  ) => Promise<void>;
  cancelPendingPreset: () => void;
  errorMsg: string | null;
  hiddenSet: ReadonlySet<DashboardCardId>;
  layout: DashboardLayout;
  liveMessage: string;
  pendingPreset: DashboardPresetKey | null;
  reorder: (activeId: DashboardCardId, overId: DashboardCardId) => void;
  resetLayout: () => Promise<void>;
  savingState: LayoutSaverState;
  toggleVisibility: (id: DashboardCardId) => void;
}

export function useDashboardLayoutSaver(
  initialLayout: DashboardLayout
): UseDashboardLayoutSaverResult {
  const t = useTranslations("dashboard.layout_editor");
  const tPresetLabel = useTranslations(
    "dashboard.layout_editor.presets.labels"
  );
  const tCardLabel = useTranslations("dashboard.layout_editor.cards.labels");

  const [layout, setLayout] = useState<DashboardLayout>(initialLayout);
  const [pendingPreset, setPendingPreset] = useState<DashboardPresetKey | null>(
    null
  );
  const [savingState, setSavingState] = useState<LayoutSaverState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState("");

  // Debounce window for the PUT after an edit. Tracks the active timer
  // so a rapid sequence collapses into a single save.
  const debounceTimer = useRef<number | null>(null);
  // Stale-response guard — if a newer request lands first we ignore
  // older ones.
  const lastSeqRef = useRef(0);

  const activePreset = useMemo(() => matchDashboardPreset(layout), [layout]);
  const hiddenSet = useMemo<ReadonlySet<DashboardCardId>>(
    () => new Set(layout.hidden),
    [layout]
  );

  const announce = useCallback((msg: string) => {
    // Always reassign even if the string is identical — SR engines
    // de-dupe consecutive identical text on live regions.
    setLiveMessage(msg);
  }, []);

  const flashSaved = useCallback((seq: number) => {
    setSavingState("saved");
    window.setTimeout(() => {
      if (seq === lastSeqRef.current) {
        setSavingState("idle");
      }
    }, SAVED_BADGE_MS);
  }, []);

  const persistLayout = useCallback(
    (next: DashboardLayout) => {
      setSavingState("saving");
      setErrorMsg(null);
      if (debounceTimer.current !== null) {
        window.clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = window.setTimeout(async () => {
        const seq = ++lastSeqRef.current;
        try {
          const res = await fetch("/api/dashboard/layout", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ layout: next }),
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          if (seq !== lastSeqRef.current) {
            return;
          }
          announce(t("saved_live"));
          flashSaved(seq);
        } catch (err) {
          if (seq !== lastSeqRef.current) {
            return;
          }
          setSavingState("error");
          setErrorMsg((err as Error).message);
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [announce, flashSaved, t]
  );

  useEffect(
    () => () => {
      if (debounceTimer.current !== null) {
        window.clearTimeout(debounceTimer.current);
      }
    },
    []
  );

  const applyPreset = useCallback(
    async (presetKey: DashboardPresetKey, viaConfirm = false) => {
      if (activePreset === presetKey) {
        setPendingPreset(null);
        return;
      }
      // Confirm before clobbering a customised (non-preset) layout.
      if (!viaConfirm && activePreset === null) {
        setPendingPreset(presetKey);
        return;
      }
      setPendingPreset(null);
      setSavingState("saving");
      setErrorMsg(null);
      const seq = ++lastSeqRef.current;
      try {
        const res = await fetch("/api/dashboard/layout/preset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset: presetKey }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { layout: DashboardLayout };
        if (seq !== lastSeqRef.current) {
          return;
        }
        setLayout(data.layout);
        announce(t("preset_applied_live", { name: tPresetLabel(presetKey) }));
        flashSaved(seq);
      } catch (err) {
        if (seq !== lastSeqRef.current) {
          return;
        }
        setSavingState("error");
        setErrorMsg((err as Error).message);
      }
    },
    [activePreset, announce, flashSaved, t, tPresetLabel]
  );

  const cancelPendingPreset = useCallback(() => {
    setPendingPreset(null);
  }, []);

  const resetLayout = useCallback(async () => {
    setSavingState("saving");
    setErrorMsg(null);
    const seq = ++lastSeqRef.current;
    try {
      const res = await fetch("/api/dashboard/layout", { method: "DELETE" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { layout: DashboardLayout };
      if (seq !== lastSeqRef.current) {
        return;
      }
      setLayout(data.layout);
      announce(t("reset_live"));
      flashSaved(seq);
    } catch (err) {
      if (seq !== lastSeqRef.current) {
        return;
      }
      setSavingState("error");
      setErrorMsg((err as Error).message);
    }
  }, [announce, flashSaved, t]);

  const toggleVisibility = useCallback(
    (id: DashboardCardId) => {
      // No-op for callouts — they're reorder-only.
      if (!FIRST_CLASS_CARDS.has(id)) {
        return;
      }
      const isHidden = hiddenSet.has(id);
      const nextHidden = isHidden
        ? layout.hidden.filter((x) => x !== id)
        : [...layout.hidden, id];
      const next: DashboardLayout = {
        v: 1,
        order: layout.order,
        hidden: nextHidden,
      };
      setLayout(next);
      announce(
        isHidden
          ? t("shown_live", { name: tCardLabel(id) })
          : t("hidden_live", { name: tCardLabel(id) })
      );
      persistLayout(next);
    },
    [layout, hiddenSet, persistLayout, announce, t, tCardLabel]
  );

  const reorder = useCallback(
    (activeId: DashboardCardId, overId: DashboardCardId) => {
      if (activeId === overId) {
        return;
      }
      const oldIndex = layout.order.indexOf(activeId);
      const newIndex = layout.order.indexOf(overId);
      if (oldIndex < 0 || newIndex < 0) {
        return;
      }
      const nextOrder = arrayMove(layout.order, oldIndex, newIndex);
      const next: DashboardLayout = {
        v: 1,
        order: nextOrder,
        hidden: layout.hidden,
      };
      setLayout(next);
      announce(
        t("moved_live", {
          name: tCardLabel(activeId),
          position: newIndex + 1,
          total: layout.order.length,
        })
      );
      persistLayout(next);
    },
    [layout, persistLayout, announce, t, tCardLabel]
  );

  return {
    layout,
    activePreset,
    hiddenSet,
    savingState,
    errorMsg,
    liveMessage,
    pendingPreset,
    applyPreset,
    cancelPendingPreset,
    resetLayout,
    toggleVisibility,
    reorder,
  };
}

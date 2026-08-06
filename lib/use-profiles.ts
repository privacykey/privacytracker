"use client";

/**
 * The privacy + accessibility profile editors' state machine: both
 * profiles, their enabled switches, debounced auto-saves, the shared undo
 * stack with its `app:undo` keybinding, and the loaders.
 *
 * One hook for both profiles, not two — they share the undo stack and the
 * same save/refresh choreography, and the accessibility editor's timer
 * cleanup was already interleaved with the privacy one's in SettingsView.
 * Splitting them would have meant a shared-undo third module.
 *
 * `router.refresh()` runs after saves so server components (dashboard
 * banners, the detail chip) pick up the new profile without a reload —
 * the hook takes the router rather than calling useRouter so the caller
 * keeps a single router identity across its subsystems.
 */

import type { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AccessibilityProfile,
  DEFAULT_A11Y_PROFILE,
  sanitizeA11yProfile,
} from "@/lib/accessibility-profile";
import {
  DEFAULT_PROFILE,
  type PrivacyProfile,
  sanitizeProfile,
} from "@/lib/privacy-profile";
import { useSettingsAutoSave } from "@/lib/use-settings-auto-save";

export function useProfiles({
  router,
}: {
  router: ReturnType<typeof useRouter>;
}) {
  const tPrivProfile = useTranslations("settings.privacy_profile_card");
  const tA11yProfile = useTranslations("settings.accessibility_profile_card");

  // Privacy profile — optional per-category threshold picker. The "enabled"
  // toggle is a UI-only flag: when off, we save `null` (no profile) on Save.
  // When on, we save whatever the editor has. `savedProfile` is what the
  // server last confirmed; `profile` is the working copy the editor mutates.
  const [profileEnabled, setProfileEnabled] = useState(false);
  const [profile, setProfile] = useState<PrivacyProfile>({
    ...DEFAULT_PROFILE,
  });
  const [savedProfile, setSavedProfile] = useState<PrivacyProfile | null>(null);
  // Privacy-profile saving flag now lives on `privacyProfileAutoSave.saving`.

  // ── Cmd+Z undo for privacy-profile + accessibility-profile changes ──
  // Each successful PUT to /api/privacy-profile or /api/accessibility-profile
  // pushes the PRIOR persisted value onto a bounded undo stack. The
  // window-level `app:undo` event (dispatched by KeyboardShortcuts.tsx
  // outside text inputs) replays the top op via the same auto-save
  // pipeline, which keeps the success/error UX consistent with a normal
  // edit. Every category tweak is its own undo step rather than the
  // whole "session of edits", matching the expectation set by the
  // ShortlistView / ChangeReviewPanel undo stacks. We use a ref-backed
  // ring rather than React state because the undo handler reads the
  // stack inside a `useEffect` listener — state would force a fresh
  // listener on every push, the ref doesn't.
  type ProfileUndoOp =
    | { kind: "privacy"; prior: PrivacyProfile | null }
    | { kind: "accessibility"; prior: AccessibilityProfile | null };
  const MAX_PROFILE_UNDO_OPS = 20;
  const profileUndoStackRef = useRef<ProfileUndoOp[]>([]);
  const pushProfileUndo = useCallback((op: ProfileUndoOp) => {
    const stack = profileUndoStackRef.current;
    stack.push(op);
    if (stack.length > MAX_PROFILE_UNDO_OPS) {
      stack.shift();
    }
  }, []);

  // Accessibility profile — per-feature required/nice picker. Mirrors the
  // privacy profile state machine: the toggle is a UI-only flag that gates
  // whether we save `null` (no profile) or the sanitised editor contents.
  const [a11yProfileEnabled, setA11yProfileEnabled] = useState(false);
  const [a11yProfile, setA11yProfile] = useState<AccessibilityProfile>({
    ...DEFAULT_A11Y_PROFILE,
  });
  const [savedA11yProfile, setSavedA11yProfile] =
    useState<AccessibilityProfile | null>(null);

  /**
   * Pull the saved privacy profile from its own endpoint. Missing / cleared
   * profiles come back as `null`; in that case we pre-seed the editor with
   * the DEFAULT_PROFILE so the user sees a sensible starting point the
   * moment they flip the toggle on.
   */
  const loadPrivacyProfile = async () => {
    try {
      const res = await fetch("/api/privacy-profile");
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      // API returns `{ profile: PrivacyProfile | null }` as an already-parsed
      // object, not a JSON string. sanitise to drop any stale/unknown keys
      // before we let the editor render them.
      const rawProfile = data?.profile;
      const parsed = rawProfile ? sanitizeProfile(rawProfile) : null;
      if (parsed && Object.values(parsed).some((v) => typeof v === "string")) {
        setProfile(parsed);
        setSavedProfile(parsed);
        setProfileEnabled(true);
      } else {
        // No profile stored — leave the seed profile in place but mark the
        // toggle off so the editor stays collapsed until the user opts in.
        setSavedProfile(null);
        setProfileEnabled(false);
      }
    } catch (error) {
      console.warn("[settings] loadPrivacyProfile failed:", error);
    }
  };

  /**
   * Auto-save hook for the Privacy Profile editor. The save shape is
   * the union `PrivacyProfile | null`: `null` means "profile disabled",
   * otherwise it's the sanitized field map. We send the whole thing on
   * every save (the route doesn't support patches) and the server
   * returns the persisted profile so we can re-baseline `savedProfile`.
   *
   * `router.refresh()` runs in onSaved to re-render server components
   * that render the profile chip / mismatch banner with the new data.
   */
  const privacyProfileAutoSave = useSettingsAutoSave<PrivacyProfile | null>({
    endpoint: "/api/privacy-profile",
    method: "PUT",
    buildBody: (value) => ({ profile: value }),
    successMessage: (value) =>
      value ? tPrivProfile("toast_saved") : tPrivProfile("toast_cleared"),
    taskLabel: (value) =>
      value
        ? tPrivProfile("task_label_updated")
        : tPrivProfile("task_label_cleared"),
    onSaved: (value) => {
      // Capture what was on the server BEFORE this save committed so
      // Cmd-Z can replay it. We read off `savedProfile` (the watermark
      // we maintain in this component) and only push when the new
      // value actually differs — saves triggered by unrelated state
      // changes shouldn't pollute the undo stack with no-op ops the
      // user has no mental model for.
      setSavedProfile((prev) => {
        const isDifferent = JSON.stringify(prev) !== JSON.stringify(value);
        if (isDifferent) {
          pushProfileUndo({ kind: "privacy", prior: prev });
        }
        return value;
      });
      router.refresh();
    },
  });

  /**
   * Decide whether the current Privacy Profile state warrants a save,
   * and fire it if so. Skips no-op cases:
   *   - clean (matches savedProfile) → nothing to do
   *   - enabled with all-blank fields → nothing meaningful to persist;
   *     the empty-warning chip in the JSX surfaces this to the user.
   * Called from both the master toggle (immediate, debounce ignored)
   * and the editor onChange (debounced via privacyProfileSaveTimer).
   */
  const runPrivacyProfileSave = useCallback(
    (nextEnabled: boolean, nextProfile: PrivacyProfile) => {
      const payload: PrivacyProfile | null = nextEnabled
        ? sanitizeProfile(nextProfile)
        : null;
      const isDirty = JSON.stringify(payload) !== JSON.stringify(savedProfile);
      if (!isDirty) {
        return;
      }
      const emptyEnabled =
        nextEnabled &&
        Object.values(nextProfile).every((v) => typeof v !== "string");
      if (emptyEnabled) {
        return;
      }
      void privacyProfileAutoSave.save(payload);
    },
    [privacyProfileAutoSave, savedProfile]
  );

  const privacyProfileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const schedulePrivacyProfileSave = useCallback(
    (nextEnabled: boolean, nextProfile: PrivacyProfile) => {
      if (privacyProfileSaveTimer.current) {
        clearTimeout(privacyProfileSaveTimer.current);
      }
      privacyProfileSaveTimer.current = setTimeout(() => {
        privacyProfileSaveTimer.current = null;
        runPrivacyProfileSave(nextEnabled, nextProfile);
      }, 500);
    },
    [runPrivacyProfileSave]
  );

  /**
   * Pull the saved accessibility profile. Mirrors loadPrivacyProfile — missing
   * profiles come back as `null` and we leave the DEFAULT_A11Y_PROFILE seed in
   * the editor so the moment the user flips the toggle on they see a sensible
   * starting point.
   */
  const loadA11yProfile = async () => {
    try {
      const res = await fetch("/api/accessibility-profile");
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      const rawProfile = data?.profile;
      const parsed = rawProfile ? sanitizeA11yProfile(rawProfile) : null;
      if (parsed && Object.values(parsed).some((v) => typeof v === "string")) {
        setA11yProfile(parsed);
        setSavedA11yProfile(parsed);
        setA11yProfileEnabled(true);
      } else {
        setSavedA11yProfile(null);
        setA11yProfileEnabled(false);
      }
    } catch (error) {
      console.warn("[settings] loadA11yProfile failed:", error);
    }
  };

  /**
   * Auto-save hook for the Accessibility Profile editor. Mirrors
   * Privacy Profile in shape and lifecycle — same skip rules in
   * `runA11yProfileSave`, same 500 ms debounce on field edits, same
   * router.refresh() on success so the chip / banner pick up the new
   * mismatch counts immediately.
   */
  const a11yProfileAutoSave = useSettingsAutoSave<AccessibilityProfile | null>({
    endpoint: "/api/accessibility-profile",
    method: "PUT",
    buildBody: (value) => ({ profile: value }),
    successMessage: (value) =>
      value ? tA11yProfile("toast_saved") : tA11yProfile("toast_cleared"),
    taskLabel: (value) =>
      value
        ? tA11yProfile("task_label_updated")
        : tA11yProfile("task_label_cleared"),
    onSaved: (value) => {
      // Mirror the privacy-profile undo capture above. Pushing onto
      // the same stack lets a single Cmd-Z handler replay either
      // kind without us having to grow per-profile listeners that
      // race each other.
      setSavedA11yProfile((prev) => {
        const isDifferent = JSON.stringify(prev) !== JSON.stringify(value);
        if (isDifferent) {
          pushProfileUndo({ kind: "accessibility", prior: prev });
        }
        return value;
      });
      router.refresh();
    },
  });

  const runA11yProfileSave = useCallback(
    (nextEnabled: boolean, nextProfile: AccessibilityProfile) => {
      const payload: AccessibilityProfile | null = nextEnabled
        ? sanitizeA11yProfile(nextProfile)
        : null;
      const isDirty =
        JSON.stringify(payload) !== JSON.stringify(savedA11yProfile);
      if (!isDirty) {
        return;
      }
      const emptyEnabled =
        nextEnabled &&
        Object.values(nextProfile).every((v) => typeof v !== "string");
      if (emptyEnabled) {
        return;
      }
      void a11yProfileAutoSave.save(payload);
    },
    [a11yProfileAutoSave, savedA11yProfile]
  );

  const a11yProfileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const scheduleA11yProfileSave = useCallback(
    (nextEnabled: boolean, nextProfile: AccessibilityProfile) => {
      if (a11yProfileSaveTimer.current) {
        clearTimeout(a11yProfileSaveTimer.current);
      }
      a11yProfileSaveTimer.current = setTimeout(() => {
        a11yProfileSaveTimer.current = null;
        runA11yProfileSave(nextEnabled, nextProfile);
      }, 500);
    },
    [runA11yProfileSave]
  );
  useEffect(
    () => () => {
      if (a11yProfileSaveTimer.current) {
        clearTimeout(a11yProfileSaveTimer.current);
        a11yProfileSaveTimer.current = null;
      }
    },
    []
  );

  // Cmd-Z handler for the profile-undo stack. Pops the top op and
  // replays its prior value through the same auto-save pipeline, which
  // means the success/error toast UX is identical to a normal user
  // edit (no special-case "this came from undo" wording on the
  // server-side activity log either). The handler also re-syncs the
  // editor state — `setProfile`/`setA11yProfile` and the
  // *Enabled toggles — so the UI immediately reflects the restored
  // value without waiting for the auto-save's onSaved to fire.
  //
  // Race note: the user can keep editing while an undo is in flight.
  // The auto-save hook serialises its own writes (latest-wins), so a
  // mid-flight undo can't get clobbered by a fresh edit landing first
  // — both are PUTs to the same endpoint, and the server's UPSERT key
  // collapses them in submission order.
  const handleProfileUndo = useCallback(() => {
    const stack = profileUndoStackRef.current;
    if (stack.length === 0) {
      return;
    }
    const top = stack.pop()!;
    if (top.kind === "privacy") {
      const restored = top.prior;
      // Re-baseline the editor + the enabled toggle so the panel
      // re-paints with the restored values *before* the round-trip
      // returns. This avoids a flash of the post-action state while
      // the PUT is in flight.
      setProfile(restored ?? { ...DEFAULT_PROFILE });
      setProfileEnabled(restored !== null);
      // Same auto-save call the editor uses — it will fire onSaved
      // again with `restored` and naturally push ANOTHER undo op
      // capturing what we're now replacing (i.e. redo via Cmd-Z works
      // out of the box).
      void privacyProfileAutoSave.save(restored);
    } else {
      const restored = top.prior;
      setA11yProfile(restored ?? { ...DEFAULT_A11Y_PROFILE });
      setA11yProfileEnabled(restored !== null);
      void a11yProfileAutoSave.save(restored);
    }
  }, [privacyProfileAutoSave, a11yProfileAutoSave]);

  useEffect(() => {
    const handler = () => {
      handleProfileUndo();
    };
    window.addEventListener("app:undo", handler);
    return () => window.removeEventListener("app:undo", handler);
  }, [handleProfileUndo]);
  // The profiles load themselves on mount — SettingsView's shared loader
  // no longer knows they exist.
  useEffect(() => {
    void loadPrivacyProfile();
    void loadA11yProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once effect
  }, []);

  return {
    profileEnabled,
    setProfileEnabled,
    profile,
    setProfile,
    savedProfile,
    setSavedProfile,
    profileUndoStackRef,
    pushProfileUndo,
    a11yProfileEnabled,
    setA11yProfileEnabled,
    a11yProfile,
    setA11yProfile,
    savedA11yProfile,
    setSavedA11yProfile,
    loadPrivacyProfile,
    privacyProfileAutoSave,
    runPrivacyProfileSave,
    privacyProfileSaveTimer,
    schedulePrivacyProfileSave,
    loadA11yProfile,
    a11yProfileAutoSave,
    runA11yProfileSave,
    a11yProfileSaveTimer,
    scheduleA11yProfileSave,
    handleProfileUndo,
  };
}

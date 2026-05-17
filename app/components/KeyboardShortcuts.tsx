"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFlag } from "../../lib/feature-flags-hooks";

// ── Shortcut catalogue (mirrored in the help overlay) ────────────────────
interface NavShortcut {
  href: string;
  keys: string; // display label (e.g. "g then d")
  /** Translation key under `kbd_help`. Resolved at render via the translator. */
  labelKey: string;
  step: string; // second key in a "g x" sequence
}

const NAV_SHORTCUTS: NavShortcut[] = [
  { keys: "g then d", step: "d", labelKey: "nav_home", href: "/dashboard" },
  {
    keys: "g then a",
    step: "a",
    labelKey: "nav_apps",
    href: "/dashboard/apps",
  },
  {
    keys: "g then p",
    step: "p",
    labelKey: "nav_privacy_map",
    href: "/dashboard/privacy",
  },
  {
    keys: "g then t",
    step: "t",
    labelKey: "nav_stats",
    href: "/dashboard/stats",
  },
  {
    keys: "g then c",
    step: "c",
    labelKey: "nav_compare",
    href: "/dashboard/compare",
  },
  {
    keys: "g then s",
    step: "s",
    labelKey: "nav_settings",
    href: "/dashboard/settings",
  },
  { keys: "g then n", step: "n", labelKey: "nav_add_apps", href: "/onboard" },
  {
    keys: "g then h",
    step: "h",
    labelKey: "nav_help",
    href: "/help/definitions",
  },
];

// Dev-only nav shortcuts. Merged into NAV_SHORTCUTS at runtime when
// `flag.devopts.visible === 'on'` so the catalogue grows for power users
// and stays out of the help overlay for everyone else. The href deep-links
// straight into the Settings page anchor that hosts the flag panel — no
// scroll-to-top hop because the same anchor is used by SettingsView's
// hash effect (cf. the #ai-summaries pulse pattern).
const DEV_NAV_SHORTCUTS: NavShortcut[] = [
  {
    keys: "g then f",
    step: "f",
    labelKey: "nav_feature_flags_dev",
    href: "/dashboard/settings#developer",
  },
];

// g-sequences that don't navigate but fire an app-level event. Kept separate
// from NAV_SHORTCUTS because the runStep dispatcher branches on "route vs.
// dispatch" — a single list would force every entry to carry an unused
// `href` or `event` field. Shown in the help overlay alongside nav keys.
interface ActionShortcut {
  event: string;
  keys: string;
  labelKey: string;
  step: string;
}

const ACTION_SHORTCUTS: ActionShortcut[] = [
  {
    keys: "g then u",
    step: "u",
    labelKey: "action_open_a11y_menu",
    event: "a11y-quick-toggles:open",
  },
];

// Dev-only action shortcuts. Same pattern as DEV_NAV_SHORTCUTS — merged
// into ACTION_SHORTCUTS at runtime when devmode is on so the help overlay
// only mentions them when they're actually wired. The DevMenu component
// listens for `dev-menu:open` and toggles its popover; the shortcut is
// effectively a no-op when devmode or the per-device opt-in is off
// (DevMenu just doesn't react), so it's safe to merge once devmode is
// resolved on the client.
const DEV_ACTION_SHORTCUTS: ActionShortcut[] = [
  {
    keys: "g then x",
    step: "x",
    labelKey: "action_open_dev_menu",
    event: "dev-menu:open",
  },
];

const GENERAL_SHORTCUTS: Array<{ keys: string; labelKey: string }> = [
  { keys: "/", labelKey: "general_focus_search_page" },
  { keys: "Ctrl + K", labelKey: "general_focus_search" },
  { keys: "Ctrl + Z", labelKey: "general_undo_shortlist" },
  { keys: "?", labelKey: "general_toggle_cheatsheet" },
  { keys: "Esc", labelKey: "general_close_dialogs" },
];

// How long we wait for the second key in a "g x" sequence before dropping it.
const SEQUENCE_WINDOW_MS = 1500;

// Heuristic: is the user actively typing somewhere? If so the shortcut
// handler should stay out of the way and let the keystroke flow into the
// field. We allow `?` and `Escape` to pass even while editing because those
// are the canonical "bail out" signals, plus `Cmd/Ctrl+K` (command palette
// style) which should always work.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  return false;
}

function focusFirstSearchInput(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const candidates = document.querySelectorAll<HTMLInputElement>(
    'input[type="search"]:not([disabled]), input[data-shortcut-search]:not([disabled])'
  );
  for (const input of candidates) {
    // Skip inputs parked inside `display: none` ancestors.
    const visible =
      input.offsetParent !== null || input.getClientRects().length > 0;
    if (!visible) {
      continue;
    }
    input.focus();
    input.select();
    return true;
  }
  return false;
}

// Focusable-element selector for the modal focus trap. Covers the common
// interactive elements; we filter out hidden ones at runtime.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function collectFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
}

// How long the "Navigating to X" confirmation toast lingers after a
// shortcut fires. Short enough that it doesn't linger over the new page,
// long enough that a user glancing at the indicator can read it.
const ACTIVATION_DISPLAY_MS = 1400;

// Verb used in the activation feedback toast. Nav shortcuts "navigate to"
// a page; action shortcuts "open" something in-place. Kept as a small
// map so future shortcut kinds (e.g. "toggling", "copying") slot in
// without reshaping the toast markup.
type ActivationKind = "nav" | "action";
const ACTIVATION_VERB_KEY: Record<ActivationKind, string> = {
  nav: "verb_navigating",
  action: "verb_opening",
};

export default function KeyboardShortcuts() {
  const t = useTranslations("kbd_help");
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);

  // Devmode flag drives whether dev-only shortcuts (currently `g then f`
  // for the feature-flag panel) appear in the catalogue + the help
  // overlay. When the flag is off, the shortcut simply doesn't exist for
  // users — pressing `g f` becomes a no-op and the help overlay doesn't
  // mention it. Resolved client-side via useFlag so a developer flipping
  // the flag in Settings sees the shortcut light up without a reload.
  const devOptsVisible = useFlag("flag.devopts.visible") === "on";
  const navShortcuts = useMemo<NavShortcut[]>(
    () =>
      devOptsVisible ? [...NAV_SHORTCUTS, ...DEV_NAV_SHORTCUTS] : NAV_SHORTCUTS,
    [devOptsVisible]
  );
  const actionShortcuts = useMemo<ActionShortcut[]>(
    () =>
      devOptsVisible
        ? [...ACTION_SHORTCUTS, ...DEV_ACTION_SHORTCUTS]
        : ACTION_SHORTCUTS,
    [devOptsVisible]
  );
  // Mirrors pendingSequence.current for the on-screen indicator; we keep
  // both because the ref stays pointer-stable for the keydown handler while
  // the state drives rendering.
  const [sequenceVisible, setSequenceVisible] = useState(false);

  // Post-activation feedback — populated when runStep matches, cleared
  // after ACTIVATION_DISPLAY_MS. Drives the "g then d · Navigating to
  // Home" replacement of the pending-sequence dots so users get a clear
  // confirmation the shortcut actually fired (especially on slow page
  // transitions where the route change alone is ambiguous).
  const [activation, setActivation] = useState<{
    step: string;
    label: string;
    kind: ActivationKind;
  } | null>(null);

  // `pendingSequence` tracks whether we're mid "g x" sequence. Using a ref
  // instead of state keeps the keydown listener pointer-stable and avoids
  // re-installing it on every key press.
  const pendingSequence = useRef<{ key: string; expiresAt: number } | null>(
    null
  );
  const sequenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);

  const clearPending = useCallback(() => {
    pendingSequence.current = null;
    if (sequenceTimer.current) {
      clearTimeout(sequenceTimer.current);
      sequenceTimer.current = null;
    }
    setSequenceVisible(false);
  }, []);

  const startPending = useCallback(() => {
    const now = Date.now();
    pendingSequence.current = { key: "g", expiresAt: now + SEQUENCE_WINDOW_MS };
    setSequenceVisible(true);
    if (sequenceTimer.current) {
      clearTimeout(sequenceTimer.current);
    }
    sequenceTimer.current = setTimeout(() => {
      pendingSequence.current = null;
      sequenceTimer.current = null;
      setSequenceVisible(false);
    }, SEQUENCE_WINDOW_MS);
  }, []);

  // Flash the "Navigating to X" / "Opening X" toast in place of the
  // pending indicator. We don't wait for the pending indicator to
  // disappear first — clearPending() is still called after runStep so
  // the pending dots get replaced immediately by the activation content.
  const showActivation = useCallback(
    (step: string, label: string, kind: ActivationKind) => {
      if (activationTimer.current) {
        clearTimeout(activationTimer.current);
      }
      setActivation({ step, label, kind });
      activationTimer.current = setTimeout(() => {
        setActivation(null);
        activationTimer.current = null;
      }, ACTIVATION_DISPLAY_MS);
    },
    []
  );

  const runStep = useCallback(
    (step: string) => {
      // Nav shortcuts first — they're the common case. If we match one we
      // push its route and return. Otherwise check ACTION_SHORTCUTS, which
      // fire a window event so the relevant component (e.g. the
      // accessibility quick-toggles popover) can react without importing
      // this module.
      const navEntry = navShortcuts.find((nav) => nav.step === step);
      if (navEntry) {
        router.push(navEntry.href);
        showActivation(step, t(navEntry.labelKey), "nav");
        return true;
      }
      const actionEntry = actionShortcuts.find(
        (action) => action.step === step
      );
      if (actionEntry) {
        window.dispatchEvent(new CustomEvent(actionEntry.event));
        showActivation(step, t(actionEntry.labelKey), "action");
        return true;
      }
      return false;
    },
    [router, showActivation, navShortcuts, actionShortcuts, t]
  );

  const closeHelp = useCallback(() => setHelpOpen(false), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = isEditableTarget(target);

      // Escape always clears pending sequences and closes the help sheet,
      // even inside inputs.
      if (event.key === "Escape") {
        if (helpOpen) {
          event.preventDefault();
          setHelpOpen(false);
        }
        clearPending();
        return;
      }

      // Cmd/Ctrl+K → focus search. Works everywhere, including inside text
      // fields, because this is a global "jump to search" command.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === "k" || event.key === "K")
      ) {
        const found = focusFirstSearchInput();
        if (found) {
          event.preventDefault();
          clearPending();
        }
        return;
      }

      // Cmd/Ctrl+Z → app-level undo. Dispatched as a custom event so any
      // page-level component can subscribe without threading handlers through
      // the tree (today just the Shortlist page undoes the last delete). We
      // intentionally skip this when the user is typing in a field so native
      // text undo still works there — the field should win Cmd+Z.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === "z" || event.key === "Z")
      ) {
        if (editing) {
          return;
        }
        // Only preventDefault when *something* is listening — otherwise
        // we'd suppress the browser's default with nothing to replace it.
        // A simple `dispatchEvent` returns true if no listener cancelled,
        // which isn't quite the right signal, so we always dispatch and
        // always preventDefault outside inputs: the pages that don't
        // listen just no-op. The net effect is "Cmd+Z is reserved for our
        // app outside text fields", which is the documented behaviour.
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("app:undo"));
        clearPending();
        return;
      }

      // Let the browser handle other Cmd/Ctrl/Alt combos — they belong to
      // native or other app-level shortcuts.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      // Help overlay: Shift+/ produces `?` on US layouts. We accept both the
      // symbol and the shifted-slash combo so non-US keyboards can still
      // reach it (Shift + / works regardless of the output char).
      if (
        !editing &&
        (event.key === "?" || (event.shiftKey && event.key === "/"))
      ) {
        event.preventDefault();
        setHelpOpen((open) => !open);
        clearPending();
        return;
      }

      // While the help sheet is open, swallow everything but Escape so no
      // shortcut fires behind it.
      if (helpOpen) {
        return;
      }

      // `/` focuses the first search input on the page — but only when the
      // user isn't already typing, to avoid stealing slashes from URLs,
      // regex searches, etc.
      if (!editing && event.key === "/" && !event.shiftKey) {
        const found = focusFirstSearchInput();
        if (found) {
          event.preventDefault();
          clearPending();
        }
        return;
      }

      if (editing) {
        // In an input field we don't handle g-sequences or any other letter
        // shortcuts — that's what Escape is for.
        return;
      }

      const now = Date.now();
      const pending = pendingSequence.current;

      // Step 2 of a "g x" sequence.
      if (pending && pending.key === "g" && now < pending.expiresAt) {
        const step = event.key.toLowerCase();
        if (runStep(step)) {
          event.preventDefault();
        }
        clearPending();
        return;
      }

      // Step 1: user just tapped `g` alone.
      if (event.key === "g" || event.key === "G") {
        startPending();
        // Don't preventDefault here — if the user wasn't actually trying to
        // start a sequence, `g` should still fall through to browser find etc.
        return;
      }

      // Any other key breaks a pending sequence (but only if the window
      // hasn't already elapsed).
      if (pending && now >= pending.expiresAt) {
        clearPending();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearPending, helpOpen, runStep, startPending]);

  // Listen for a custom event so non-keyboard UI (like the footer hint) can
  // request the help overlay without importing this component's state.
  useEffect(() => {
    const onRequestOpen = () => setHelpOpen(true);
    window.addEventListener("kbd-help:open", onRequestOpen);
    return () => window.removeEventListener("kbd-help:open", onRequestOpen);
  }, []);

  // Clean up any pending sequence + activation timers on unmount.
  useEffect(
    () => () => {
      if (sequenceTimer.current) {
        clearTimeout(sequenceTimer.current);
      }
      if (activationTimer.current) {
        clearTimeout(activationTimer.current);
      }
    },
    []
  );

  // Focus management for the modal: capture the previously-focused element
  // on open, restore it on close, and trap Tab while the sheet is up.
  useEffect(() => {
    if (!helpOpen) {
      return;
    }

    lastFocused.current = (document.activeElement as HTMLElement) ?? null;

    // Defer focus to the next tick so the card has mounted.
    const id = requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card) {
        return;
      }
      const focusables = collectFocusable(card);
      (focusables[0] ?? card).focus();
    });

    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }
      const card = cardRef.current;
      if (!card) {
        return;
      }
      const focusables = collectFocusable(card);
      if (focusables.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (!active || active === first || !card.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", trap);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", trap);
      const prev = lastFocused.current;
      lastFocused.current = null;
      if (
        prev &&
        typeof prev.focus === "function" &&
        // Only restore focus if the element is still in the DOM.
        document.contains(prev)
      ) {
        prev.focus();
      }
    };
  }, [helpOpen]);

  return (
    <>
      {(sequenceVisible || activation) && !helpOpen && (
        <div
          aria-live="polite"
          className={`kbd-sequence-indicator${activation ? "kbd-sequence-indicator-activated" : ""}`}
          role="status"
        >
          <kbd className="kbd">g</kbd>
          {activation ? (
            <>
              <span className="kbd-sequence-sep">then</span>
              <kbd className="kbd">{activation.step}</kbd>
              <span className="kbd-sequence-feedback">
                {t(ACTIVATION_VERB_KEY[activation.kind])}{" "}
                <strong>{activation.label}</strong>
              </span>
            </>
          ) : (
            <span className="kbd-sequence-dots">…</span>
          )}
        </div>
      )}

      {helpOpen && (
        <div
          aria-labelledby="kbd-help-title"
          aria-modal="true"
          className="kbd-help-scrim"
          onClick={closeHelp}
          role="dialog"
        >
          <div
            className="kbd-help-card"
            onClick={(e) => e.stopPropagation()}
            ref={cardRef}
            tabIndex={-1}
          >
            <div className="kbd-help-header">
              <h2 className="kbd-help-title" id="kbd-help-title">
                {t("title")}
              </h2>
              <button
                aria-label={t("close_aria")}
                className="kbd-help-close"
                onClick={closeHelp}
                type="button"
              >
                ✕
              </button>
            </div>

            <div className="kbd-help-section">
              <div className="kbd-help-section-title">
                {t("section_navigation")}
              </div>
              <ul className="kbd-help-list">
                {navShortcuts.map((entry) => (
                  <li className="kbd-help-row" key={entry.href}>
                    <KbdKeys combo={entry.keys} />
                    <span className="kbd-help-label">{t(entry.labelKey)}</span>
                  </li>
                ))}
                {actionShortcuts.map((entry) => (
                  <li className="kbd-help-row" key={entry.event}>
                    <KbdKeys combo={entry.keys} />
                    <span className="kbd-help-label">{t(entry.labelKey)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="kbd-help-section">
              <div className="kbd-help-section-title">
                {t("section_general")}
              </div>
              <ul className="kbd-help-list">
                {GENERAL_SHORTCUTS.map((entry) => (
                  <li className="kbd-help-row" key={entry.keys}>
                    <KbdKeys combo={entry.keys} />
                    <span className="kbd-help-label">{t(entry.labelKey)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="kbd-help-footnote">
              Tip: press <KbdKeys combo="?" /> anywhere outside a text field to
              reopen this sheet.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

// Convenience helper so non-keyboard affordances (like the footer hint) can
// open the overlay without wiring refs all the way through the tree.
export function openKeyboardHelp() {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent("kbd-help:open"));
}

function KbdKeys({ combo }: { combo: string }) {
  // Split on " then " so "g then d" renders as two <kbd> pills joined by "then".
  // Also split on " + " so "Ctrl + K" renders as two pills joined by "+".
  const thenParts = combo.split(/\s+then\s+/i);
  return (
    <span className="kbd-combo">
      {thenParts.map((thenPart, thenIndex) => {
        const plusParts = thenPart.split(/\s*\+\s*/);
        return (
          <span className="kbd-combo-part" key={`${thenPart}-${thenIndex}`}>
            {thenIndex > 0 && <span className="kbd-combo-sep">then</span>}
            {plusParts.map((part, plusIndex) => (
              <span className="kbd-combo-plus" key={`${part}-${plusIndex}`}>
                {plusIndex > 0 && <span className="kbd-combo-sep">+</span>}
                <kbd className="kbd">{part}</kbd>
              </span>
            ))}
          </span>
        );
      })}
    </span>
  );
}

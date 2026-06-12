"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { isDesktop, openMacAccessibilitySettings } from "../../lib/desktop";

/**
 * Footer-pill accessibility quick-toggles. Sits next to the keyboard-hint
 * pill in the bottom-right corner and opens a small popover with four
 * controls the user can flip without leaving the page they're on:
 *
 *   1. Dyslexia-friendly font (toggle)     → swaps the global --font stack
 *      for OpenDyslexic + system fallbacks (Comic Sans MS, Verdana).
 *   2. Larger text (3-step cycle)          → drives an html root font-size
 *      multiplier (100% / 115% / 130%). Everything in the app sized in rem /
 *      percentages scales with this automatically; the few px-sized pieces
 *      are intentional fixed sizes and will stay unchanged.
 *   3. Theme cycle                         → system → light → dark →
 *      high-contrast → system. Hands the mode straight to the existing
 *      applyThemeOverride() helper and persists through the same
 *      data-theme-override attribute so the rest of the app Just Works.
 *   4. Shape markers (toggle)              → repaints the .change-dot
 *      privacy / accessibility circles as distinct shapes (privacy =
 *      triangle, accessibility = star) so colour-blind users can tell them
 *      apart without depending on orange-vs-blue.
 *
 * When running inside Tauri on macOS we surface a "Open macOS Accessibility
 * settings" shortcut that deep-links into System Settings → Accessibility so
 * native OS features (VoiceOver, Zoom, Increase Contrast, Reduce Motion)
 * stay one click away.
 *
 * Preferences are stored in localStorage under four distinct keys so the
 * pre-hydration bootstrapper in app/layout.tsx can apply them synchronously
 * before React paints — preventing a flash of the wrong font/theme/scale.
 * The three that are CSS-only (font, scale, shapes) set data-* attributes on
 * <html>; the theme reuses the existing `data-theme-override` attribute.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Preference types + storage keys. Exported for the pre-hydration script in
// layout.tsx, which reads the same keys on page load to avoid a FOUC.
// ─────────────────────────────────────────────────────────────────────────────

export type A11yFontMode = "default" | "dyslexic";
export type A11yScaleMode = "default" | "large" | "x-large";
export type A11yThemeMode = "system" | "light" | "dark" | "high-contrast";
export type A11yShapesMode = "off" | "on";
export type A11ySolidMode = "off" | "on";

export const A11Y_STORAGE_KEYS = {
  font: "a11y-quick-font",
  scale: "a11y-quick-scale",
  theme: "a11y-quick-theme",
  shapes: "a11y-quick-shapes",
  solid: "a11y-quick-solid",
} as const;

const SCALE_ORDER: A11yScaleMode[] = ["default", "large", "x-large"];
const THEME_ORDER: A11yThemeMode[] = [
  "system",
  "light",
  "dark",
  "high-contrast",
];

const THEME_GLYPH: Record<A11yThemeMode, string> = {
  system: "🌓",
  light: "☀️",
  dark: "🌙",
  "high-contrast": "◐",
};

// ─────────────────────────────────────────────────────────────────────────────
// Applicators. Each one writes both the attribute on <html> and the
// localStorage value so the next page load picks up the same state. Kept as
// plain functions so the bootstrapper in layout.tsx can share the same
// attribute names without importing React.
// ─────────────────────────────────────────────────────────────────────────────

function applyFont(mode: A11yFontMode) {
  if (typeof document === "undefined") {
    return;
  }
  const html = document.documentElement;
  if (mode === "dyslexic") {
    html.setAttribute("data-a11y-font", "dyslexic");
  } else {
    html.removeAttribute("data-a11y-font");
  }
  try {
    if (mode === "default") {
      localStorage.removeItem(A11Y_STORAGE_KEYS.font);
    } else {
      localStorage.setItem(A11Y_STORAGE_KEYS.font, mode);
    }
  } catch {
    /* storage may be unavailable in private mode — attribute still applies */
  }
}

function applyScale(mode: A11yScaleMode) {
  if (typeof document === "undefined") {
    return;
  }
  const html = document.documentElement;
  if (mode === "default") {
    html.removeAttribute("data-a11y-scale");
  } else {
    html.setAttribute("data-a11y-scale", mode);
  }
  try {
    if (mode === "default") {
      localStorage.removeItem(A11Y_STORAGE_KEYS.scale);
    } else {
      localStorage.setItem(A11Y_STORAGE_KEYS.scale, mode);
    }
  } catch {
    /* noop */
  }
}

function applyTheme(mode: A11yThemeMode) {
  if (typeof document === "undefined") {
    return;
  }
  const html = document.documentElement;
  html.removeAttribute("data-theme-override");
  if (mode === "light" || mode === "dark" || mode === "high-contrast") {
    html.setAttribute("data-theme-override", mode);
  }
  try {
    if (mode === "system") {
      localStorage.removeItem(A11Y_STORAGE_KEYS.theme);
    } else {
      localStorage.setItem(A11Y_STORAGE_KEYS.theme, mode);
    }
  } catch {
    /* noop */
  }
}

function applyShapes(mode: A11yShapesMode) {
  if (typeof document === "undefined") {
    return;
  }
  const html = document.documentElement;
  if (mode === "on") {
    html.setAttribute("data-a11y-shapes", "on");
  } else {
    html.removeAttribute("data-a11y-shapes");
  }
  try {
    if (mode === "off") {
      localStorage.removeItem(A11Y_STORAGE_KEYS.shapes);
    } else {
      localStorage.setItem(A11Y_STORAGE_KEYS.shapes, mode);
    }
  } catch {
    /* noop */
  }
}

function applySolid(mode: A11ySolidMode) {
  if (typeof document === "undefined") {
    return;
  }
  const html = document.documentElement;
  if (mode === "on") {
    html.setAttribute("data-a11y-solid", "on");
  } else {
    html.removeAttribute("data-a11y-solid");
  }
  try {
    if (mode === "off") {
      localStorage.removeItem(A11Y_STORAGE_KEYS.solid);
    } else {
      localStorage.setItem(A11Y_STORAGE_KEYS.solid, mode);
    }
  } catch {
    /* noop */
  }
}

function readInitial(): {
  font: A11yFontMode;
  scale: A11yScaleMode;
  theme: A11yThemeMode;
  shapes: A11yShapesMode;
  solid: A11ySolidMode;
} {
  if (typeof window === "undefined") {
    return {
      font: "default",
      scale: "default",
      theme: "system",
      shapes: "off",
      solid: "off",
    };
  }
  try {
    const font = localStorage.getItem(A11Y_STORAGE_KEYS.font);
    const scale = localStorage.getItem(A11Y_STORAGE_KEYS.scale);
    const theme = localStorage.getItem(A11Y_STORAGE_KEYS.theme);
    const shapes = localStorage.getItem(A11Y_STORAGE_KEYS.shapes);
    const solid = localStorage.getItem(A11Y_STORAGE_KEYS.solid);
    return {
      font: font === "dyslexic" ? "dyslexic" : "default",
      scale:
        scale === "large" || scale === "x-large"
          ? (scale as A11yScaleMode)
          : "default",
      theme:
        theme === "light" || theme === "dark" || theme === "high-contrast"
          ? (theme as A11yThemeMode)
          : "system",
      shapes: shapes === "on" ? "on" : "off",
      solid: solid === "on" ? "on" : "off",
    };
  } catch {
    return {
      font: "default",
      scale: "default",
      theme: "system",
      shapes: "off",
      solid: "off",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function AccessibilityQuickToggles() {
  // i18n — every visible label, hint, aria-label, and tooltip on the
  // popover reads from `a11y_quick.*`; inline helpers keep the keys typed
  // against the existing enum unions.
  const t = useTranslations("a11y_quick");

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [font, setFont] = useState<A11yFontMode>("default");
  const [scale, setScale] = useState<A11yScaleMode>("default");
  const [theme, setTheme] = useState<A11yThemeMode>("system");
  const [shapes, setShapes] = useState<A11yShapesMode>("off");
  const [solid, setSolid] = useState<A11ySolidMode>("off");
  const [desktop, setDesktop] = useState(false);
  const [openingMac, setOpeningMac] = useState(false);
  const [macOpenError, setMacOpenError] = useState<string | null>(null);

  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Load persisted state on mount. The pre-hydration script already applied
  // the attributes to <html>, so we're just syncing React state here — no
  // second re-apply flash.
  useEffect(() => {
    setMounted(true);
    const initial = readInitial();
    setFont(initial.font);
    setScale(initial.scale);
    setTheme(initial.theme);
    setShapes(initial.shapes);
    setSolid(initial.solid);
    setDesktop(isDesktop());
  }, []);

  // Outside-click + Escape to dismiss. Guarded by `open` so the listener is
  // only attached while the popover is visible.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) {
        return;
      }
      if (popoverRef.current?.contains(target)) {
        return;
      }
      if (triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // `pointerdown` (not `mousedown`) so the popover closes on iOS
    // Safari taps-outside. See `AppDetailView.tsx` outside-click handler
    // for the canonical comment on the iOS mouse-event quirk — this is
    // the same pattern used across every popover trigger in the app.
    window.addEventListener("pointerdown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Global keyboard shortcut bridge. The `g then u` sequence in
  // KeyboardShortcuts.tsx dispatches this custom event so the shortcut
  // catalogue doesn't need to import this component's state. When fired we
  // open the popover and push focus to the close button so keyboard users
  // land inside the dialog rather than on the trigger they can't see.
  useEffect(() => {
    const onRequestOpen = () => {
      setOpen(true);
      // Defer focus until after render so the popover node exists. We target
      // the first focusable inside the popover (the close button) rather
      // than the popover container itself.
      requestAnimationFrame(() => {
        const closeBtn = popoverRef.current?.querySelector<HTMLButtonElement>(
          ".a11y-quick-popover-close"
        );
        closeBtn?.focus();
      });
    };
    window.addEventListener("a11y-quick-toggles:open", onRequestOpen);
    return () => {
      window.removeEventListener("a11y-quick-toggles:open", onRequestOpen);
    };
  }, []);

  // Step-in-either-direction scale controls. Replaces the single cycling
  // button with two buttons (smaller / larger) so users don't have to
  // round-trip through x-large to go back to default. Each button is
  // disabled at its end of the scale and announces its next target in the
  // aria-label for screen readers.
  const canShrinkScale = SCALE_ORDER.indexOf(scale) > 0;
  const canGrowScale = SCALE_ORDER.indexOf(scale) < SCALE_ORDER.length - 1;

  const shrinkScale = useCallback(() => {
    const idx = SCALE_ORDER.indexOf(scale);
    if (idx <= 0) {
      return;
    }
    const next = SCALE_ORDER[idx - 1];
    setScale(next);
    applyScale(next);
  }, [scale]);

  const growScale = useCallback(() => {
    const idx = SCALE_ORDER.indexOf(scale);
    if (idx >= SCALE_ORDER.length - 1) {
      return;
    }
    const next = SCALE_ORDER[idx + 1];
    setScale(next);
    applyScale(next);
  }, [scale]);

  // Reset-only helper for the text-size row. Mirrors the "reset all" link
  // in the footer but scoped to just the scale control so users who only
  // want to undo one of the three accessibility prefs don't have to wipe
  // their theme + font choices too.
  const resetScale = useCallback(() => {
    setScale("default");
    applyScale("default");
  }, []);

  const chooseTheme = useCallback((mode: A11yThemeMode) => {
    setTheme(mode);
    applyTheme(mode);
  }, []);

  const toggleFont = useCallback(() => {
    const next: A11yFontMode = font === "dyslexic" ? "default" : "dyslexic";
    setFont(next);
    applyFont(next);
  }, [font]);

  const toggleShapes = useCallback(() => {
    const next: A11yShapesMode = shapes === "on" ? "off" : "on";
    setShapes(next);
    applyShapes(next);
  }, [shapes]);

  const toggleSolid = useCallback(() => {
    const next: A11ySolidMode = solid === "on" ? "off" : "on";
    setSolid(next);
    applySolid(next);
  }, [solid]);

  const handleResetAll = () => {
    applyFont("default");
    applyScale("default");
    applyTheme("system");
    applyShapes("off");
    applySolid("off");
    setFont("default");
    setScale("default");
    setTheme("system");
    setShapes("off");
    setSolid("off");
  };

  const openMacPane = async () => {
    setOpeningMac(true);
    setMacOpenError(null);
    try {
      const ok = await openMacAccessibilitySettings();
      if (!ok) {
        setMacOpenError(t("mac_open_error"));
      }
    } finally {
      setOpeningMac(false);
    }
  };

  // Defer render until mount (localStorage needs the client anyway); also
  // avoids a hydration mismatch on the count / glyph values that depend on
  // state the server cannot know.
  if (!mounted) {
    return null;
  }

  const anyActive =
    font !== "default" ||
    scale !== "default" ||
    theme !== "system" ||
    shapes !== "off" ||
    solid !== "off";

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          anyActive ? t("trigger_aria_active") : t("trigger_aria_idle")
        }
        className={`a11y-quick-trigger${anyActive ? " is-active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        ref={triggerRef}
        title={t("trigger_title")}
        type="button"
      >
        {/* Matches the accessibility badge used in AppDetailView (detail-a11y-chip)
            — a circle with a person figure inside — so the footer trigger reads
            as the same "accessibility surface" users already recognise. */}
        <svg
          aria-hidden="true"
          className="a11y-quick-trigger-glyph"
          fill="none"
          height="18"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="18"
        >
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="7.2" fill="currentColor" r="1.4" />
          <path d="M6.5 10.5h11" />
          <path d="M12 10.5v4" />
          <path d="M9 18l3-3.5L15 18" />
        </svg>
        {anyActive && (
          <span
            aria-hidden="true"
            className={`a11y-quick-trigger-dot${
              shapes === "on" ? " a11y-quick-trigger-dot-tick" : ""
            }`}
          >
            {/* Tick glyph only when Shape change markers is on — same
                colour-blind-friendly rationale: users who opt into the
                shape language get shapes applied across every "is-active"
                surface (cards, footer trigger) instead of plain dots. When
                shapes are off this span renders as the original 7×7 teal
                dot with no SVG. */}
            {shapes === "on" && (
              <svg
                aria-hidden="true"
                fill="none"
                height="8"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.2"
                viewBox="0 0 10 10"
                width="8"
              >
                <polyline points="2,5.3 4.2,7.2 8,3" />
              </svg>
            )}
          </span>
        )}
      </button>

      {/* Deliberately a NON-modal dialog — no `aria-modal`, no focus trap.
          The toggles apply to the page live, so users need to see (and reach)
          the background while flipping them; pruning it from the accessibility
          tree or fencing Tab inside would defeat the point. The popover sits
          in DOM order directly after its trigger, so Tab/Shift+Tab walk in and
          out naturally without a trap. The keyboard contract is still
          complete: Escape and the ✕ button close and restore focus to the
          trigger; outside-click closes and leaves focus where the user
          clicked; the `g u` shortcut path moves focus onto the ✕ button on
          open (trigger-click opens keep focus on the trigger,
          disclosure-style). */}
      {open && (
        <div
          aria-label={t("popover_aria")}
          className="a11y-quick-popover"
          ref={popoverRef}
          role="dialog"
        >
          <div className="a11y-quick-popover-header">
            <strong className="a11y-quick-popover-title">
              {t("popover_title")}
            </strong>
            <button
              aria-label={t("close_aria")}
              className="a11y-quick-popover-close"
              onClick={() => {
                setOpen(false);
                // Keyboard-close path: put focus back on the trigger, same as
                // Escape — otherwise focus falls to <body> when this button
                // unmounts.
                triggerRef.current?.focus();
              }}
              type="button"
            >
              ✕
            </button>
          </div>

          <div className="a11y-quick-popover-body">
            {/* 1. Dyslexia-friendly font */}
            <label className="a11y-quick-row">
              <div className="a11y-quick-row-text">
                <div className="a11y-quick-row-title">{t("font_title")}</div>
                <div className="a11y-quick-row-hint">{t("font_hint")}</div>
              </div>
              <button
                aria-checked={font === "dyslexic"}
                className={`switch-toggle${font === "dyslexic" ? " is-on" : ""}`}
                onClick={toggleFont}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="switch-toggle-thumb" />
              </button>
            </label>

            {/* 2. Font-size stepper — two buttons (smaller / larger) with a
                vertical divider, mirroring how iOS / macOS Text Size picks
                from a range rather than cycling one-way. Each direction is
                disabled at the end of the scale so keyboard users don't
                hit a no-op. A small "Reset" button sits under the row so
                users can jump straight back to default without having to
                step through each size in reverse. */}
            <div className="a11y-quick-row a11y-quick-row-text-size">
              <div className="a11y-quick-row-text">
                <div className="a11y-quick-row-title">{t("scale_title")}</div>
                <div className="a11y-quick-row-hint">
                  {t.rich("scale_hint", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    label: t(
                      scale === "default"
                        ? "scale_default"
                        : scale === "large"
                          ? "scale_large"
                          : "scale_x_large"
                    ),
                  })}
                </div>
              </div>
              <div
                aria-label={t("scale_aria")}
                className="a11y-quick-stepper"
                role="group"
              >
                <button
                  aria-label={t("scale_smaller_aria")}
                  className="a11y-quick-stepper-btn"
                  disabled={!canShrinkScale}
                  onClick={shrinkScale}
                  title={t("scale_smaller_title")}
                  type="button"
                >
                  <span aria-hidden="true" className="a11y-quick-stepper-small">
                    A
                  </span>
                </button>
                <span
                  aria-hidden="true"
                  className="a11y-quick-stepper-divider"
                />
                <button
                  aria-label={t("scale_larger_aria")}
                  className="a11y-quick-stepper-btn"
                  disabled={!canGrowScale}
                  onClick={growScale}
                  title={t("scale_larger_title")}
                  type="button"
                >
                  <span aria-hidden="true" className="a11y-quick-stepper-big">
                    A
                  </span>
                </button>
              </div>
              <div className="a11y-quick-row-reset-wrap">
                <button
                  aria-label={t("scale_reset_aria")}
                  className="a11y-quick-inline-reset"
                  disabled={scale === "default"}
                  onClick={resetScale}
                  type="button"
                >
                  {t("scale_reset")}
                </button>
              </div>
            </div>

            {/* 3. Theme picker — 4-way segmented control so every option is
                one click away (no cycling through Dark to reach High
                Contrast). System stays as the default "match OS" option. */}
            <div className="a11y-quick-row a11y-quick-row-theme">
              <div className="a11y-quick-row-text">
                <div className="a11y-quick-row-title">{t("theme_title")}</div>
                <div className="a11y-quick-row-hint">{t("theme_hint")}</div>
              </div>
              <div
                aria-label={t("theme_aria")}
                className="a11y-quick-theme-grid"
                role="radiogroup"
              >
                {THEME_ORDER.map((mode) => {
                  // Map the kebab-case enum value to the snake_case
                  // translation key suffix (`high-contrast` →
                  // `high_contrast`).
                  const tKey = mode.replace(/-/g, "_");
                  return (
                    <button
                      aria-checked={theme === mode}
                      className={`a11y-quick-theme-btn${theme === mode ? " is-active" : ""}`}
                      key={mode}
                      onClick={() => chooseTheme(mode)}
                      role="radio"
                      title={t(`theme_${tKey}_full`)}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="a11y-quick-theme-btn-glyph"
                      >
                        {THEME_GLYPH[mode]}
                      </span>
                      <span className="a11y-quick-theme-btn-label">
                        {t(`theme_${tKey}_short`)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 4. Shape markers — uses the same triangle / star shapes the
                change-dots actually render so users can visually preview what
                they'll see on the cards. Each shape has an aria-label and a
                title attribute so assistive tech and hover tooltips describe
                the mapping explicitly. */}
            <label className="a11y-quick-row">
              <div className="a11y-quick-row-text">
                <div className="a11y-quick-row-title">{t("shapes_title")}</div>
                <div className="a11y-quick-row-hint a11y-quick-row-hint-shapes">
                  {t("shapes_hint")}
                </div>
                <div aria-hidden="false" className="a11y-quick-shape-legend">
                  {/* Each shape+label is wrapped in its own inline-flex pair
                      so flex-wrap on the parent breaks between pairs only
                      — never between a glyph and the text describing it. */}
                  <span className="a11y-quick-shape-pair">
                    <span
                      aria-label={t("shapes_legend_privacy_aria")}
                      className="a11y-quick-shape a11y-quick-shape-privacy"
                      role="img"
                      title={t("shapes_legend_privacy_title")}
                    />
                    <span className="a11y-quick-shape-text">
                      {t("shapes_legend_privacy_text")}
                    </span>
                  </span>
                  <span className="a11y-quick-shape-pair">
                    <span
                      aria-label={t("shapes_legend_a11y_aria")}
                      className="a11y-quick-shape a11y-quick-shape-accessibility"
                      role="img"
                      title={t("shapes_legend_a11y_title")}
                    />
                    <span className="a11y-quick-shape-text">
                      {t("shapes_legend_a11y_text")}
                    </span>
                  </span>
                  {/* Third legend entry covers the ChangelogTimeline rail:
                      first-sync rows render as a diamond when shape mode is
                      on (see globals.css `.timeline-dot.first-sync`). The
                      remaining timeline classes — has-changes / no-changes
                      / wayback — already map to glyphs from the AppGrid
                      vocabulary (triangle, square, plus), so adding them
                      here would just bloat the legend. */}
                  <span className="a11y-quick-shape-pair">
                    <span
                      aria-label={t("shapes_legend_timeline_aria")}
                      className="a11y-quick-shape a11y-quick-shape-timeline"
                      role="img"
                      title={t("shapes_legend_timeline_title")}
                    />
                    <span className="a11y-quick-shape-text">
                      {t("shapes_legend_timeline_text")}
                    </span>
                  </span>
                </div>
              </div>
              <button
                aria-checked={shapes === "on"}
                className={`switch-toggle${shapes === "on" ? " is-on" : ""}`}
                onClick={toggleShapes}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="switch-toggle-thumb" />
              </button>
            </label>

            {/* 5. Remove Transparency — drives data-a11y-solid on <html>, which
                every translucent surface reads from in globals.css to swap to
                its solid equivalent. Helps users with low vision / visual
                processing difficulties who find backdrop-blur surfaces hard to
                parse. */}
            <label className="a11y-quick-row">
              <div className="a11y-quick-row-text">
                <div className="a11y-quick-row-title">{t("solid_title")}</div>
                <div className="a11y-quick-row-hint">{t("solid_hint")}</div>
              </div>
              <button
                aria-checked={solid === "on"}
                className={`switch-toggle${solid === "on" ? " is-on" : ""}`}
                onClick={toggleSolid}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="switch-toggle-thumb" />
              </button>
            </label>

            {/* Desktop-only native hook. Hidden in the browser build — there's
                no way to deep-link into macOS system settings from a web
                origin, and a dead button is worse than no button. */}
            {desktop && (
              <div className="a11y-quick-row a11y-quick-row-native">
                <div className="a11y-quick-row-text">
                  <div className="a11y-quick-row-title">
                    {t("native_title")}
                  </div>
                  <div className="a11y-quick-row-hint">{t("native_hint")}</div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={openingMac}
                  onClick={() => void openMacPane()}
                  type="button"
                >
                  {openingMac ? t("native_opening") : t("native_open")}
                </button>
              </div>
            )}

            {macOpenError && (
              <div className="a11y-quick-error" role="alert">
                {macOpenError}
              </div>
            )}
          </div>

          <div className="a11y-quick-popover-footer">
            <button
              className="a11y-quick-reset"
              disabled={!anyActive}
              onClick={handleResetAll}
              type="button"
            >
              {t("reset_all")}
            </button>
            <span className="a11y-quick-footer-hint">{t("footer_hint")}</span>
          </div>
        </div>
      )}
    </>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { type RefObject, useRef } from "react";
import {
  closeA11yQuickToggles,
  openA11yQuickToggles,
  useA11yQuickTogglesState,
} from "@/lib/use-a11y-quick-toggles";

/** The accessibility figure the quick-toggles trigger uses. */
export function A11yGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
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
  );
}

/**
 * A second way into the accessibility quick-toggles panel, for phones.
 *
 * Below 480px the panel's own button sits at the end of the page, where
 * it can never cover a control but is also far from where someone who
 * needs larger text or more contrast starts. This entry sits near the
 * top instead (in the nav drawer, the sample-mode nav, or above the
 * content on pages without a nav) and opens the SAME panel; Escape and ✕
 * bring focus back here. Renders nothing when the panel is not mounted
 * (its flag is off), so it never offers a control that does nothing.
 */
export default function AccessibilityEntryButton({
  className,
  fallbackRef,
  iconOnly = false,
  role,
  testId,
}: {
  className?: string;
  /** Focus target if this button cannot take focus back when the panel
   *  closes (e.g. the drawer it lives in was closed): the menu button. */
  fallbackRef?: RefObject<HTMLElement | null>;
  iconOnly?: boolean;
  role?: "menuitem";
  testId?: string;
}) {
  const t = useTranslations("nav");
  const { available, open } = useA11yQuickTogglesState();
  const ref = useRef<HTMLButtonElement | null>(null);
  if (!available) {
    return null;
  }
  const label = t("accessibility_entry");
  return (
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={iconOnly ? label : undefined}
      className={className}
      data-testid={testId}
      onClick={() => {
        if (open) {
          closeA11yQuickToggles();
          return;
        }
        openA11yQuickToggles({
          opener: ref.current,
          fallback: fallbackRef?.current ?? null,
        });
      }}
      ref={ref}
      role={role}
      title={iconOnly ? label : undefined}
      type="button"
    >
      <A11yGlyph className="a11y-entry-glyph" />
      {iconOnly ? null : <span>{label}</span>}
    </button>
  );
}

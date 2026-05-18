import type { Decorator } from "@storybook/nextjs";

type ThemeValue = "system" | "light" | "dark" | "high-contrast";

/**
 * Mirrors the **Theme** toolbar value onto `<html data-theme-override>`.
 *
 * Applies the attribute synchronously during render rather than via
 * `useLayoutEffect`. Effect-based cleanup briefly removes the attribute
 * between cleanup and the next effect run, which can cause the canvas to
 * flicker back to OS preference during a toolbar flip. Setting it eagerly
 * means it's already in place before the story mounts, and we never wipe
 * it — every render asserts the right value, so subsequent stories
 * inherit cleanly.
 */
export const withTheme: Decorator = (Story, context) => {
  const theme = (context.globals.theme as ThemeValue) || "system";
  if (typeof document !== "undefined") {
    const html = document.documentElement;
    const current = html.getAttribute("data-theme-override");
    const next = theme === "system" ? null : theme;
    if (current !== next) {
      if (next === null) {
        html.removeAttribute("data-theme-override");
      } else {
        html.setAttribute("data-theme-override", next);
      }
    }
  }
  return <Story />;
};

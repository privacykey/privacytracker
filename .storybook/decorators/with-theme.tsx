import type { Decorator } from "@storybook/nextjs";
import { useGlobals } from "storybook/preview-api";

type ThemeValue = "system" | "light" | "dark" | "high-contrast";

/**
 * Mirrors the **Theme** toolbar value onto `<html data-theme-override>`.
 *
 * Uses `useGlobals()` (allowed inside decorators) so the decorator
 * actually re-renders when the user flips the toolbar — reading
 * `context.globals.theme` alone doesn't subscribe to changes in
 * Storybook 10, which is why the previous version got stuck on the
 * first selection.
 *
 * Applies the attribute synchronously during render rather than via
 * `useLayoutEffect`. Effect cleanup briefly removes the attribute
 * between cleanup and the next effect run, causing the canvas to
 * flicker back to OS preference on flips. Eager apply means it's on
 * `<html>` before the story mounts and we only ever overwrite it.
 */
export const withTheme: Decorator = (Story) => {
  const [globals] = useGlobals();
  const theme = ((globals.theme as ThemeValue) ?? "system") as ThemeValue;

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

import { useLayoutEffect } from "react";
import { useGlobals } from "storybook/preview-api";

/**
 * Bridges the Storybook **Theme** toolbar value into the MDX docs iframe.
 *
 * Stories already inherit the theme via the `withTheme` decorator
 * registered in `preview.tsx`, but standalone MDX foundation pages don't
 * run story decorators — so inline `var(--*)` reads in those pages fall
 * back to the OS preference (which can flip-flop against Storybook's
 * docs chrome). Mount `<ThemeBridge />` at the top of every MDX page to
 * keep them in sync with the toolbar.
 */
export function ThemeBridge() {
  const [globals] = useGlobals();
  const theme = (globals?.theme as string) ?? "system";

  useLayoutEffect(() => {
    const html = document.documentElement;
    if (theme === "system") {
      html.removeAttribute("data-theme-override");
    } else {
      html.setAttribute("data-theme-override", theme);
    }
    return () => {
      html.removeAttribute("data-theme-override");
    };
  }, [theme]);

  return null;
}

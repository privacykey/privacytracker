import { useLayoutEffect } from "react";

/**
 * Bridges the Storybook **Theme** toolbar value into the MDX docs iframe.
 *
 * Stories already inherit the theme via the `withTheme` decorator
 * registered in `preview.tsx`, but standalone MDX foundation pages don't
 * run story decorators — so inline `var(--*)` reads in those pages fall
 * back to the OS preference (which can flip-flop against Storybook's
 * docs chrome).
 *
 * Storybook preview hooks (`useGlobals`) can only run inside decorators
 * or story render functions, so this bridge reads the toolbar value
 * directly from the URL — Storybook encodes globals as
 * `?globals=theme:dark;locale:zh`. We poll the URL on a short interval
 * so a toolbar flip is reflected in the docs page within ~200 ms.
 */
function readTheme(): string {
  if (typeof window === "undefined") {
    return "system";
  }
  const globals =
    new URL(window.location.href).searchParams.get("globals") ?? "";
  return /(?:^|;)theme:([^;]+)/.exec(globals)?.[1] ?? "system";
}

function applyTheme(theme: string): void {
  const html = document.documentElement;
  if (theme === "system") {
    html.removeAttribute("data-theme-override");
  } else {
    html.setAttribute("data-theme-override", theme);
  }
}

export function ThemeBridge() {
  useLayoutEffect(() => {
    applyTheme(readTheme());

    let last = readTheme();
    const id = window.setInterval(() => {
      const next = readTheme();
      if (next !== last) {
        last = next;
        applyTheme(next);
      }
    }, 200);

    return () => {
      window.clearInterval(id);
      document.documentElement.removeAttribute("data-theme-override");
    };
  }, []);

  return null;
}

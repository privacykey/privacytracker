import type { Decorator } from "@storybook/nextjs";
import { useLayoutEffect } from "react";

type ThemeValue = "system" | "light" | "dark" | "high-contrast";

export const withTheme: Decorator = (Story, context) => {
  const theme = (context.globals.theme as ThemeValue) || "system";

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

  return <Story />;
};

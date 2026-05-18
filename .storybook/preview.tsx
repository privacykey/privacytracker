import type { Preview } from "@storybook/nextjs";
import "../app/globals.css";
import { withFeatureFlags } from "./decorators/with-feature-flags";
import { withNextIntl } from "./decorators/with-next-intl";
import { withTauriEnv } from "./decorators/with-tauri-env";
import { withTheme } from "./decorators/with-theme";

const preview: Preview = {
  parameters: {
    layout: "centered",
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      values: [
        { name: "app", value: "var(--bg)" },
        { name: "card", value: "var(--bg-2)" },
        { name: "elevated", value: "var(--bg-3)" },
      ],
      default: "app",
    },
    a11y: {
      // Keep the default ruleset; surface violations inline for review.
      test: "todo",
    },
    // App Router mocks for `next/navigation` (`useRouter`, `usePathname`,
    // `useSearchParams`). Without this every component that imports from
    // `next/navigation` throws "router mocks not created yet" on render.
    // Stories can override per-story via `parameters.nextjs.navigation`
    // (pathname, query, segments, …) when they need a specific URL.
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: "/dashboard",
      },
    },
  },
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Theme override (matches data-theme-override)",
      defaultValue: "system",
      toolbar: {
        icon: "paintbrush",
        items: [
          { value: "system", title: "System" },
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
          { value: "high-contrast", title: "High contrast" },
        ],
        dynamicTitle: true,
      },
    },
    locale: {
      name: "Locale",
      description: "next-intl locale",
      defaultValue: "en",
      toolbar: {
        icon: "globe",
        items: [
          { value: "en", title: "English" },
          { value: "zh", title: "中文" },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [withTheme, withNextIntl, withFeatureFlags, withTauriEnv],
};

export default preview;

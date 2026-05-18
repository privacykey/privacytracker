import type { Decorator } from "@storybook/nextjs";
import { useLayoutEffect } from "react";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const withTauriEnv: Decorator = (Story, context) => {
  const enabled = context.parameters?.runtimeEnvironment === "desktop";

  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }
    const prior = window.__TAURI_INTERNALS__;
    if (!prior) {
      window.__TAURI_INTERNALS__ = { __storybookStub: true };
    }
    return () => {
      if (!prior) {
        window.__TAURI_INTERNALS__ = undefined;
      }
    };
  }, [enabled]);

  return <Story />;
};

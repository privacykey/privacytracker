import type { Decorator } from "@storybook/nextjs";
import type {
  FlagKey,
  FlagValue,
  FocusState,
} from "../../lib/feature-flag-rules";
import { setResolverContext } from "../../lib/feature-flags";
import { FALLBACK_FOCUS } from "../fixtures/focus";

interface FlagStoryParameters {
  flagOverrides?: Map<FlagKey, FlagValue>;
  focus?: FocusState;
  killSwitchOff?: boolean;
  runtimeEnvironment?: "desktop";
}

export const withFeatureFlags: Decorator = (Story, context) => {
  const params = (context.parameters ?? {}) as FlagStoryParameters;
  const focus = params.focus ?? FALLBACK_FOCUS;
  const overrides = params.flagOverrides ?? new Map();

  setResolverContext({
    focus,
    overrides,
    killSwitchOff: Boolean(params.killSwitchOff),
    runtimeEnvironment: params.runtimeEnvironment,
  });

  return <Story />;
};

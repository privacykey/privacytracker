import type { Meta, StoryObj } from "@storybook/nextjs";
import { OVERRIDES_DEVOPTS_VISIBLE } from "../../.storybook/fixtures/flags";
import { FOCUS_SELF_UNDERSTAND } from "../../.storybook/fixtures/focus";
import DevOptionsFeatureFlagPanel from "./DevOptionsFeatureFlagPanel";

const meta: Meta<typeof DevOptionsFeatureFlagPanel> = {
  title: "F/DevOptionsFeatureFlagPanel",
  component: DevOptionsFeatureFlagPanel,
  parameters: {
    layout: "padded",
    focus: FOCUS_SELF_UNDERSTAND,
    flagOverrides: OVERRIDES_DEVOPTS_VISIBLE,
    docs: {
      description: {
        component:
          "The full feature-flag matrix editor under Dev Options. Reads " +
          "`flag.devopts.feature_flag_panel` for visibility and fetches " +
          "`/api/feature-flags` for the current override map; in Storybook " +
          "the fetch fails and the panel renders with the resolver defaults.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof DevOptionsFeatureFlagPanel>;

export const Default: Story = {};

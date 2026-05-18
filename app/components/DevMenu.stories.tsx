import type { Meta, StoryObj } from "@storybook/nextjs";
import { OVERRIDES_DEVOPTS_VISIBLE } from "../../.storybook/fixtures/flags";
import { FOCUS_SELF_UNDERSTAND } from "../../.storybook/fixtures/focus";
import DevMenu from "./DevMenu";

const meta: Meta<typeof DevMenu> = {
  title: "F/DevMenu",
  component: DevMenu,
  parameters: {
    layout: "fullscreen",
    focus: FOCUS_SELF_UNDERSTAND,
    flagOverrides: OVERRIDES_DEVOPTS_VISIBLE,
    docs: {
      description: {
        component:
          "Hidden ⌘+Shift+. developer overlay. Visible only when " +
          "`flag.devopts.visible` resolves to `on`. Fetches several " +
          "diagnostic endpoints when opened; in Storybook those fail " +
          "gracefully.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof DevMenu>;

export const Default: Story = {};

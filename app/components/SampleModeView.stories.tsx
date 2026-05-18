import type { Meta, StoryObj } from "@storybook/nextjs";
import { OVERRIDES_DEVOPTS_VISIBLE } from "../../.storybook/fixtures/flags";
import { FOCUS_SELF_UNDERSTAND } from "../../.storybook/fixtures/focus";
import SampleModeView from "./SampleModeView";

const meta: Meta<typeof SampleModeView> = {
  title: "F/SampleModeView",
  component: SampleModeView,
  parameters: {
    layout: "padded",
    focus: FOCUS_SELF_UNDERSTAND,
    flagOverrides: OVERRIDES_DEVOPTS_VISIBLE,
    docs: {
      description: {
        component:
          "Dev-options page showing the sample-mode controls. Fetches " +
          "`/api/sample` for status; without a backend it renders the " +
          "default no-sample state.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof SampleModeView>;

export const Default: Story = {};

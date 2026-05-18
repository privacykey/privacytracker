import type { Meta, StoryObj } from "@storybook/nextjs";
import {
  FOCUS_GUARDIAN_DECLUTTER,
  FOCUS_SELF_UNDERSTAND,
} from "../../.storybook/fixtures/focus";
import InfoTooltip from "./InfoTooltip";

const meta = {
  title: "F/InfoTooltip",
  component: InfoTooltip,
  parameters: {
    docs: {
      description: {
        component:
          "Reads `flag.global.info_tooltips`. Renders the `i` trigger when the " +
          "flag is `on` (default for `self`), and nothing when it is `off` (default for `guardian`).",
      },
    },
    focus: FOCUS_SELF_UNDERSTAND,
  },
  argTypes: {
    side: { control: "inline-radio", options: ["top", "right"] },
  },
  args: {
    text: "Privacy labels are written by the developer, not Apple. They reflect what the developer says the app collects.",
    side: "top",
    label: "More information",
  },
} satisfies Meta<typeof InfoTooltip>;
export default meta;

type Story = StoryObj<typeof meta>;

export const TooltipsOn: Story = {
  parameters: { focus: FOCUS_SELF_UNDERSTAND },
};

export const TooltipsOffViaGuardian: Story = {
  parameters: { focus: FOCUS_GUARDIAN_DECLUTTER },
};

export const RightSide: Story = {
  args: { side: "right" },
};

export const LongText: Story = {
  args: {
    text: "This setting controls the lens grid on the policy tab. Each lens summarises one aspect of the privacy policy (data scope, third-party sharing, retention, etc.) so you can spot-check a developer’s claims at a glance without reading the whole document.",
  },
};

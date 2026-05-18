import type { Meta, StoryObj } from "@storybook/nextjs";
import {
  FOCUS_SELF_ACCESSIBILITY,
  FOCUS_SELF_UNDERSTAND,
} from "../../.storybook/fixtures/focus";
import LiveTextModal from "./LiveTextModal";

const meta = {
  title: "F/LiveTextModal",
  component: LiveTextModal,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Onboarding helper modal — gated by `flag.global.live_text_modal`. " +
          "Renders nothing when the modal is closed OR when the flag is off.",
      },
    },
    focus: FOCUS_SELF_UNDERSTAND,
  },
  args: {
    open: true,
    onClose: () => {
      // eslint-disable-next-line no-console
      console.log("LiveTextModal.onClose");
    },
  },
} satisfies Meta<typeof LiveTextModal>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Closed: Story = {
  args: { open: false },
};

export const FlagOff: Story = {
  parameters: { focus: FOCUS_SELF_ACCESSIBILITY },
  args: { open: true },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

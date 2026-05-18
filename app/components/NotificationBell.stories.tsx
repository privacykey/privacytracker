import type { Meta, StoryObj } from "@storybook/nextjs";
import {
  FOCUS_GUARDIAN_DECLUTTER,
  FOCUS_SELF_UNDERSTAND,
} from "../../.storybook/fixtures/focus";
import NotificationBell from "./NotificationBell";

const meta: Meta<typeof NotificationBell> = {
  title: "F/NotificationBell",
  component: NotificationBell,
  parameters: {
    layout: "centered",
    focus: FOCUS_SELF_UNDERSTAND,
    docs: {
      description: {
        component:
          "Bell + dropdown for notification rows. Polls `/api/notifications` " +
          "when `pollingEnabled` is true; stories pass `false` to keep things " +
          "quiet. Without a backend the bell renders with no unread count.",
      },
    },
  },
  args: { pollingEnabled: false },
};
export default meta;

type Story = StoryObj<typeof NotificationBell>;

export const Default: Story = {};

export const GuardianFocus: Story = {
  parameters: { focus: FOCUS_GUARDIAN_DECLUTTER },
};

export const PollingOn: Story = {
  args: { pollingEnabled: true },
};

import type { Meta, StoryObj } from "@storybook/nextjs";
import {
  FOCUS_SELF_UNDERSTAND,
  FOCUS_SELF_UNDERSTAND_DECLUTTER,
} from "../../.storybook/fixtures/focus";
import CoachmarkTour from "./CoachmarkTour";

const meta: Meta<typeof CoachmarkTour> = {
  title: "F/CoachmarkTour",
  component: CoachmarkTour,
  parameters: {
    layout: "fullscreen",
    focus: FOCUS_SELF_UNDERSTAND,
    docs: {
      description: {
        component:
          "react-joyride-driven coachmark tour. Stories pass `enabled` and " +
          "the focus state used to filter steps. Without real `data-tour=*` " +
          "targets on the page the tour skips steps gracefully.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof CoachmarkTour>;

export const EnabledUnderstand: Story = {
  args: {
    enabled: true,
    audience: "self",
    aiConfigured: false,
    goals: new Set(["monitor"]),
  },
};

export const EnabledUnderstandDeclutter: Story = {
  parameters: { focus: FOCUS_SELF_UNDERSTAND_DECLUTTER },
  args: {
    enabled: true,
    audience: "self",
    aiConfigured: true,
    goals: new Set(["monitor", "cleanup"]),
  },
};

export const Disabled: Story = {
  args: {
    enabled: false,
    audience: "self",
    aiConfigured: false,
    goals: new Set(["monitor"]),
  },
};

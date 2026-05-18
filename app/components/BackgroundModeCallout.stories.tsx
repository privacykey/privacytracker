import type { Meta, StoryObj } from "@storybook/nextjs";
import {
  FOCUS_GUARDIAN_DECLUTTER,
  FOCUS_SELF_UNDERSTAND,
} from "../../.storybook/fixtures/focus";
import BackgroundModeCallout from "./BackgroundModeCallout";

const meta: Meta<typeof BackgroundModeCallout> = {
  title: "F/BackgroundModeCallout",
  component: BackgroundModeCallout,
  parameters: {
    layout: "padded",
    focus: FOCUS_SELF_UNDERSTAND,
    runtimeEnvironment: "desktop",
    docs: {
      description: {
        component:
          "Compact dashboard callout that promotes the Tauri background-mode " +
          "wizard. Gated by both `flag.dashboard.background_mode_wizard` and a " +
          "runtime check (`isDesktop()`). Stories force a desktop runtime so " +
          "the callout renders in web Storybook too.",
      },
    },
  },
  args: { initiallyVisible: true },
};
export default meta;

type Story = StoryObj<typeof BackgroundModeCallout>;

export const Default: Story = {};

export const GuardianFocus: Story = {
  parameters: {
    focus: FOCUS_GUARDIAN_DECLUTTER,
    runtimeEnvironment: "desktop",
  },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

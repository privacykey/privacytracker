import type { Meta, StoryObj } from "@storybook/nextjs";
import { useEffect } from "react";
import {
  FOCUS_GUARDIAN_DECLUTTER,
  FOCUS_SELF_UNDERSTAND,
} from "../../.storybook/fixtures/focus";
import KeyboardShortcuts, { openKeyboardHelp } from "./KeyboardShortcuts";

const meta = {
  title: "F/KeyboardShortcuts",
  component: KeyboardShortcuts,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Global keyboard shortcuts overlay. Opens via `openKeyboardHelp()` event. " +
          "Hides under audiences/goals that resolve `flag.global.keyboard_shortcuts` to off (e.g. guardian).",
      },
    },
    focus: FOCUS_SELF_UNDERSTAND,
  },
} satisfies Meta<typeof KeyboardShortcuts>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

function AutoOpen() {
  useEffect(() => {
    openKeyboardHelp();
  }, []);
  return <KeyboardShortcuts />;
}

export const OpenSelfFocus: Story = {
  parameters: { focus: FOCUS_SELF_UNDERSTAND },
  render: () => <AutoOpen />,
};

export const OpenGuardianFocus: Story = {
  parameters: { focus: FOCUS_GUARDIAN_DECLUTTER },
  render: () => <AutoOpen />,
};

export const OpenChinese: Story = {
  globals: { locale: "zh" },
  render: () => <AutoOpen />,
};

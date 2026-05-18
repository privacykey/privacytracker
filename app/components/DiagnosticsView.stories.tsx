import type { Meta, StoryObj } from "@storybook/nextjs";
import { OVERRIDES_DEVOPTS_VISIBLE } from "../../.storybook/fixtures/flags";
import { FOCUS_SELF_UNDERSTAND } from "../../.storybook/fixtures/focus";
import DiagnosticsView from "./DiagnosticsView";

const meta: Meta<typeof DiagnosticsView> = {
  title: "F/DiagnosticsView",
  component: DiagnosticsView,
  parameters: {
    layout: "padded",
    focus: FOCUS_SELF_UNDERSTAND,
    flagOverrides: OVERRIDES_DEVOPTS_VISIBLE,
    docs: {
      description: {
        component:
          "Live metrics dashboard under Dev Options. Polls several " +
          "`/api/diagnostics/*` endpoints; without a backend it renders " +
          "the no-data state with the polling spinners cleared.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof DiagnosticsView>;

export const Default: Story = {};

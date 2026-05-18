import type { Meta, StoryObj } from "@storybook/nextjs";
import type { FlagKey, FlagValue } from "../../lib/feature-flag-rules";
import FocusFlagMatrix from "./FocusFlagMatrix";

interface Row {
  hardDefault: FlagValue;
  key: FlagKey;
  surface: string;
}

const SAMPLE_ROWS: Row[] = [
  {
    key: "flag.dashboard.callout.declutter",
    surface: "dashboard",
    hardDefault: "off",
  },
  {
    key: "flag.dashboard.callout.guardian",
    surface: "dashboard",
    hardDefault: "off",
  },
  {
    key: "flag.detail.policy.ai_summary",
    surface: "detail.policy",
    hardDefault: "off",
  },
  {
    key: "flag.global.keyboard_shortcuts",
    surface: "global",
    hardDefault: "on",
  },
  { key: "flag.global.info_tooltips", surface: "global", hardDefault: "on" },
  {
    key: "flag.appgrid.filter.accessibility",
    surface: "appgrid",
    hardDefault: "off",
  },
  { key: "flag.page.compare", surface: "page", hardDefault: "on" },
  { key: "flag.devopts.visible", surface: "devopts", hardDefault: "on" },
];

const meta: Meta<typeof FocusFlagMatrix> = {
  title: "I/FocusFlagMatrix",
  component: FocusFlagMatrix,
  parameters: { layout: "padded" },
  args: { rows: SAMPLE_ROWS },
};
export default meta;

type Story = StoryObj<typeof FocusFlagMatrix>;

export const Default: Story = {};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

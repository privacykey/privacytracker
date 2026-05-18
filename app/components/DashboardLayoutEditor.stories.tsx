import type { Meta, StoryObj } from "@storybook/nextjs";
import type { DashboardLayout } from "../../lib/dashboard-layout";
import DashboardLayoutEditor from "./DashboardLayoutEditor";

const DEFAULT_LAYOUT: DashboardLayout = {
  v: 1,
  hidden: [],
  order: [
    "task_list",
    "review_cta",
    "focus_strip",
    "background_mode_wizard",
    "risk_section",
    "hero",
    "cleanup_callout",
    "family_callout",
    "third_party_callout",
    "glance_section",
    "definitions_callout",
    "review_section",
    "profile_mismatch_section",
    "stale_section",
    "activity_section",
    "risk_tier_legend",
    "manual_apps_banner",
  ],
};

const MINIMAL_LAYOUT: DashboardLayout = {
  v: 1,
  hidden: [
    "glance_section",
    "activity_section",
    "stale_section",
    "risk_tier_legend",
  ],
  order: DEFAULT_LAYOUT.order,
};

const meta: Meta<typeof DashboardLayoutEditor> = {
  title: "I/DashboardLayoutEditor",
  component: DashboardLayoutEditor,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof DashboardLayoutEditor>;

export const DefaultLayout: Story = {
  args: { initialLayout: DEFAULT_LAYOUT },
};

export const MinimalLayout: Story = {
  args: { initialLayout: MINIMAL_LAYOUT },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: { initialLayout: DEFAULT_LAYOUT },
};

import type { Meta, StoryObj } from "@storybook/nextjs";
import type { DashboardCardId } from "../../lib/dashboard-layout";
import { CardThumbnail } from "./DashboardCardThumbnail";

const ALL_IDS: DashboardCardId[] = [
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
];

const meta = {
  title: "L/DashboardCardThumbnail",
  component: CardThumbnail,
  argTypes: {
    id: { control: "select", options: ALL_IDS },
  },
} satisfies Meta<typeof CardThumbnail>;
export default meta;

type Story = StoryObj<typeof meta>;

export const TaskList: Story = { args: { id: "task_list" } };
export const Hero: Story = { args: { id: "hero" } };
export const RiskSection: Story = { args: { id: "risk_section" } };
export const ActivitySection: Story = { args: { id: "activity_section" } };
export const GlanceSection: Story = { args: { id: "glance_section" } };

export const AllThumbnails: Story = {
  args: { id: "task_list" },
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, max-content)",
        gap: 16,
        alignItems: "start",
      }}
    >
      {ALL_IDS.map((id) => (
        <div
          key={id}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <CardThumbnail id={id} />
          <code style={{ fontSize: 11, color: "var(--text-2)" }}>{id}</code>
        </div>
      ))}
    </div>
  ),
};

import type { Meta, StoryObj } from "@storybook/nextjs";
import VerdictPill from "./VerdictPill";

const meta = {
  title: "I/VerdictPill",
  component: VerdictPill,
  argTypes: {
    verdict: {
      control: "inline-radio",
      options: ["safe", "replace", "uninstall"],
    },
    size: { control: "inline-radio", options: ["sm", "md"] },
    iconOnly: { control: "boolean" },
  },
} satisfies Meta<typeof VerdictPill>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Safe: Story = { args: { verdict: "safe", size: "sm" } };
export const Replace: Story = { args: { verdict: "replace", size: "sm" } };
export const Uninstall: Story = { args: { verdict: "uninstall", size: "sm" } };

export const MediumSize: Story = { args: { verdict: "replace", size: "md" } };

export const IconOnly: Story = {
  args: { verdict: "uninstall", size: "sm", iconOnly: true },
};

export const RecommendedBy: Story = {
  args: { verdict: "safe", size: "md", sourceName: "Alex" },
};

export const AllVerdicts: Story = {
  args: { verdict: "safe" },
  render: () => (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <VerdictPill verdict="safe" />
      <VerdictPill verdict="replace" />
      <VerdictPill verdict="uninstall" />
      <VerdictPill size="md" verdict="safe" />
      <VerdictPill size="md" verdict="replace" />
      <VerdictPill size="md" verdict="uninstall" />
    </div>
  ),
};

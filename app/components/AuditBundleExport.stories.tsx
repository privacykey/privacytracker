import type { Meta, StoryObj } from "@storybook/nextjs";
import AuditBundleExport from "./AuditBundleExport";

const meta: Meta<typeof AuditBundleExport> = {
  title: "I/AuditBundleExport",
  component: AuditBundleExport,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Settings affordance that generates and downloads an audit-bundle " +
          "tarball. The export hits `/api/audit-bundle` on click; without a " +
          "backend the story documents the resting UI state.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof AuditBundleExport>;

export const Default: Story = {};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

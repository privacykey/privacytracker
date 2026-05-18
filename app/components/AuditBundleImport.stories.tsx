import type { Meta, StoryObj } from "@storybook/nextjs";
import AuditBundleImport from "./AuditBundleImport";

const meta: Meta<typeof AuditBundleImport> = {
  title: "I/AuditBundleImport",
  component: AuditBundleImport,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Onboarding affordance that accepts an audit-bundle file, validates " +
          "it, and previews what would be imported. Without a backend the story " +
          "documents the resting (no file selected) state.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof AuditBundleImport>;

export const Default: Story = {};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

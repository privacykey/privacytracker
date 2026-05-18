import type { Meta, StoryObj } from "@storybook/nextjs";
import BundleImportProvenanceBanner from "./BundleImportProvenanceBanner";

const meta = {
  title: "I/BundleImportProvenanceBanner",
  component: BundleImportProvenanceBanner,
  parameters: { layout: "padded" },
  args: {
    importedAt: Date.now() - 1000 * 60 * 60 * 2,
    recommenderName: "Alex",
    appsAdded: 6,
    appsUpdated: 3,
    annotationsAdded: 4,
  },
} satisfies Meta<typeof BundleImportProvenanceBanner>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoAnnotations: Story = {
  args: { annotationsAdded: 0 },
};

export const HeavyUpdates: Story = {
  args: { appsAdded: 24, appsUpdated: 18, annotationsAdded: 32 },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

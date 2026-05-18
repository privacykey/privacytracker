import type { Meta, StoryObj } from "@storybook/nextjs";
import VerdictPicker from "./VerdictPicker";

const meta: Meta<typeof VerdictPicker> = {
  title: "I/VerdictPicker",
  component: VerdictPicker,
  parameters: { layout: "padded" },
  args: {
    appId: "389801252",
    appName: "Instagram",
    compact: false,
    onChange: (verdict: string | null) => {
      // eslint-disable-next-line no-console
      console.log("VerdictPicker.onChange", verdict);
    },
  },
};
export default meta;

type Story = StoryObj<typeof VerdictPicker>;

export const Default: Story = {};

export const Compact: Story = {
  args: { compact: true },
};

export const WithImportedRecommendation: Story = {
  args: {
    initialVerdicts: [
      {
        id: "v1",
        appId: "389801252",
        verdict: "replace",
        source: "imported",
        sourceName: "Alex",
        rationale: "Found a less-trackery alternative — see the shortlist.",
        setAt: Date.now() - 1000 * 60 * 60 * 24,
        updatedAt: Date.now() - 1000 * 60 * 60 * 24,
      },
    ],
  },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

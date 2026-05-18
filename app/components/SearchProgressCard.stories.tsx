import type { Meta, StoryObj } from "@storybook/nextjs";
import SearchProgressCard from "./SearchProgressCard";

const meta = {
  title: "I/SearchProgressCard",
  component: SearchProgressCard,
  parameters: { layout: "padded" },
  args: {
    progress: { matched: 0, total: 50, currentBatch: 0, totalBatches: 5 },
    onCancel: () => {
      // eslint-disable-next-line no-console
      console.log("SearchProgressCard.onCancel");
    },
  },
} satisfies Meta<typeof SearchProgressCard>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Starting: Story = {};

export const HalfWay: Story = {
  args: {
    progress: { matched: 23, total: 50, currentBatch: 3, totalBatches: 5 },
  },
};

export const Finishing: Story = {
  args: {
    progress: { matched: 47, total: 50, currentBatch: 5, totalBatches: 5 },
  },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: {
    progress: { matched: 12, total: 50, currentBatch: 2, totalBatches: 5 },
  },
};

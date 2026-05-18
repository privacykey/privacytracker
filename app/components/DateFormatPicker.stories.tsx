import type { Meta, StoryObj } from "@storybook/nextjs";
import DateFormatPicker from "./DateFormatPicker";

const meta: Meta<typeof DateFormatPicker> = {
  title: "I/DateFormatPicker",
  component: DateFormatPicker,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Reads/writes `/api/date-format` for the user's date-format " +
          "preference. In Storybook the fetch fails, so this documents the " +
          "default (auto) state.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof DateFormatPicker>;

export const Default: Story = {};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

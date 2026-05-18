import type { Meta, StoryObj } from "@storybook/nextjs";
import TasksResetRow from "./TasksResetRow";

const meta: Meta<typeof TasksResetRow> = {
  title: "I/TasksResetRow",
  component: TasksResetRow,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof TasksResetRow>;

export const Default: Story = {};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

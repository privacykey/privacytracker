import type { Meta, StoryObj } from "@storybook/nextjs";
import WelcomeSplash from "./WelcomeSplash";

const meta: Meta<typeof WelcomeSplash> = {
  title: "F/WelcomeSplash",
  component: WelcomeSplash,
  parameters: { layout: "fullscreen" },
  args: { initialAudience: "self" },
};
export default meta;

type Story = StoryObj<typeof WelcomeSplash>;

export const Self: Story = {};

export const LovedOne: Story = {
  args: { initialAudience: "loved_one" },
};

export const Guardian: Story = {
  args: { initialAudience: "guardian" },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

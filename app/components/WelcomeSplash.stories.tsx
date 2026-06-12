import type { Meta, StoryObj } from "@storybook/nextjs";
import WelcomeSplash from "./WelcomeSplash";

const meta: Meta<typeof WelcomeSplash> = {
  title: "F/WelcomeSplash",
  component: WelcomeSplash,
  parameters: { layout: "fullscreen" },
  args: {
    initialChildAgeBand: null,
    initialFocus: {
      audience: "self",
      understand: true,
      declutter: false,
      minimal: false,
      accessibility: false,
      workflow: "self_monitor",
    },
  },
};
export default meta;

type Story = StoryObj<typeof WelcomeSplash>;

export const Self: Story = {};

export const LovedOne: Story = {
  args: {
    initialFocus: {
      audience: "loved_one",
      understand: true,
      declutter: true,
      minimal: false,
      accessibility: false,
      workflow: "other_handoff",
    },
  },
};

export const Guardian: Story = {
  args: {
    initialFocus: {
      audience: "guardian",
      understand: true,
      declutter: true,
      minimal: false,
      accessibility: false,
      workflow: "other_monitor",
    },
  },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

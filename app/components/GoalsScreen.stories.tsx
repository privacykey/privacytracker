import type { Meta, StoryObj } from "@storybook/nextjs";
import GoalsScreen from "./GoalsScreen";

const meta: Meta<typeof GoalsScreen> = {
  title: "F/GoalsScreen",
  component: GoalsScreen,
  parameters: { layout: "fullscreen" },
  args: { audience: "self" },
};
export default meta;

type Story = StoryObj<typeof GoalsScreen>;

export const SelfDefaults: Story = {};

export const SelfPrefilled: Story = {
  args: { initialUnderstand: true, initialDeclutter: true },
};

export const LovedOne: Story = {
  args: { audience: "loved_one", initialUnderstand: true },
};

export const Guardian: Story = {
  args: { audience: "guardian", initialUnderstand: true },
};

export const WithAccessibility: Story = {
  args: { initialUnderstand: true, initialAccessibility: true },
};

import type { Meta, StoryObj } from "@storybook/nextjs";
import FocusEditForm from "./FocusEditForm";

const meta = {
  title: "I/FocusEditForm",
  component: FocusEditForm,
  parameters: { layout: "padded" },
  args: {
    initialAudience: "self",
    initialUnderstand: true,
    initialDeclutter: false,
    initialMinimal: false,
    initialAccessibility: false,
  },
} satisfies Meta<typeof FocusEditForm>;
export default meta;

type Story = StoryObj<typeof meta>;

export const SelfUnderstand: Story = {};

export const SelfDeclutter: Story = {
  args: { initialUnderstand: false, initialDeclutter: true },
};

export const LovedOneDeclutter: Story = {
  args: {
    initialAudience: "loved_one",
    initialUnderstand: false,
    initialDeclutter: true,
  },
};

export const GuardianMinimal: Story = {
  args: {
    initialAudience: "guardian",
    initialUnderstand: false,
    initialMinimal: true,
  },
};

export const WithAccessibility: Story = {
  args: { initialAccessibility: true },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

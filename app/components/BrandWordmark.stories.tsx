import type { Meta, StoryObj } from "@storybook/nextjs";
import BrandWordmark from "./BrandWordmark";

const meta = {
  title: "L/BrandWordmark",
  component: BrandWordmark,
  argTypes: {
    height: { control: { type: "number", min: 16, max: 96, step: 2 } },
  },
} satisfies Meta<typeof BrandWordmark>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { height: 28 },
};

export const Large: Story = {
  args: { height: 64 },
};

export const WithAriaLabel: Story = {
  args: { height: 32, ariaLabel: "privacytracker" },
};

export const Stack: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <BrandWordmark height={20} />
      <BrandWordmark height={28} />
      <BrandWordmark height={40} />
      <BrandWordmark height={56} />
    </div>
  ),
};

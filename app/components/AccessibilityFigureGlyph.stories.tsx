import type { Meta, StoryObj } from "@storybook/nextjs";
import AccessibilityFigureGlyph from "./AccessibilityFigureGlyph";

const meta = {
  title: "L/AccessibilityFigureGlyph",
  component: AccessibilityFigureGlyph,
  argTypes: {
    size: { control: { type: "number", min: 8, max: 96, step: 2 } },
  },
} satisfies Meta<typeof AccessibilityFigureGlyph>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { size: 18 },
};

export const Large: Story = {
  args: { size: 48 },
};

export const WithAriaLabel: Story = {
  args: { size: 24, ariaLabel: "Accessibility profile" },
};

export const TealAccent: Story = {
  args: { size: 36, style: { color: "var(--teal)" } },
};

export const SizeMatrix: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
      {[12, 18, 24, 36, 48, 64].map((size) => (
        <AccessibilityFigureGlyph key={size} size={size} />
      ))}
    </div>
  ),
};

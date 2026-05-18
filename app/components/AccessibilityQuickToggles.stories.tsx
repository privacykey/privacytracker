import type { Meta, StoryObj } from "@storybook/nextjs";
import AccessibilityQuickToggles from "./AccessibilityQuickToggles";

const meta = {
  title: "I/AccessibilityQuickToggles",
  component: AccessibilityQuickToggles,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Hovering bottom-right popover for a11y quick toggles (motion, " +
          "contrast, shapes overlay). Renders the trigger pill on every " +
          "viewport; click to expand the popover.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ position: "relative", minHeight: 320, padding: 24 }}>
        <p style={{ color: "var(--text-2)", fontSize: 13 }}>
          The quick-toggles trigger is positioned bottom-right in the real app.
          Click it to open the popover.
        </p>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AccessibilityQuickToggles>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

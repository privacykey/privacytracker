import type { Meta, StoryObj } from "@storybook/nextjs";
import KeyboardHint from "./KeyboardHint";

const meta = {
  title: "I/KeyboardHint",
  component: KeyboardHint,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          minHeight: 240,
          padding: 24,
          background: "var(--bg-2)",
          borderRadius: "var(--r-md)",
        }}
      >
        <p style={{ color: "var(--text-2)", fontSize: 13 }}>
          KeyboardHint is normally pinned bottom-right inside the footer of
          every dashboard page. The button below also opens the global
          KeyboardShortcuts overlay.
        </p>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof KeyboardHint>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};

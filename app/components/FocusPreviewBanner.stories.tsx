import type { Meta, StoryObj } from "@storybook/nextjs";
import FocusPreviewBanner from "./FocusPreviewBanner";

const meta: Meta<typeof FocusPreviewBanner> = {
  title: "I/FocusPreviewBanner",
  component: FocusPreviewBanner,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Banner shown when the user is previewing a different focus state " +
          "than their saved one. Fetches `/api/focus/preview-state` on mount; " +
          "without a backend it stays in the no-preview state and renders nothing.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof FocusPreviewBanner>;

export const NoBackend: Story = {};

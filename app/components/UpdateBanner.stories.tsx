import type { Meta, StoryObj } from "@storybook/nextjs";
import UpdateBanner from "./UpdateBanner";

const meta = {
  title: "I/UpdateBanner",
  component: UpdateBanner,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Banner that polls `/api/update-status` on mount. In Storybook the " +
          "fetch will fail (no backend) so this story documents the " +
          "no-update-available no-op state — the banner renders nothing.",
      },
    },
  },
} satisfies Meta<typeof UpdateBanner>;
export default meta;

type Story = StoryObj<typeof meta>;

export const NoBackend: Story = {};

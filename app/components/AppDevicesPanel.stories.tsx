import type { Meta, StoryObj } from "@storybook/nextjs";
import AppDevicesPanel from "./AppDevicesPanel";

const meta: Meta<typeof AppDevicesPanel> = {
  title: "I/AppDevicesPanel",
  component: AppDevicesPanel,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Fetches `/api/apps/[id]/devices` on mount. In Storybook the " +
          "fetch fails (no backend), so this story documents the empty/loading state.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof AppDevicesPanel>;

export const NoBackend: Story = {
  args: { appId: "389801252" },
};

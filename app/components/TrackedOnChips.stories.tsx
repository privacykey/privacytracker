import type { Meta, StoryObj } from "@storybook/nextjs";
import TrackedOnChips from "./TrackedOnChips";

const meta: Meta<typeof TrackedOnChips> = {
  title: "I/TrackedOnChips",
  component: TrackedOnChips,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Fetches `/api/devices/for-app?appId=…` on mount to populate the " +
          '"Tracked on: iPhone · iPad" chip strip. In Storybook the fetch ' +
          "fails (no backend), so this story documents the empty/loading state.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof TrackedOnChips>;

export const NoBackend: Story = {
  args: { appId: "389801252" },
};

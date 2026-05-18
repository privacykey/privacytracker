import type { Meta, StoryObj } from "@storybook/nextjs";
import DeviceConnectedToast from "./DeviceConnectedToast";

const meta: Meta<typeof DeviceConnectedToast> = {
  title: "I/DeviceConnectedToast",
  component: DeviceConnectedToast,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Bottom-right toast that fires when the Tauri shell sees a new " +
          "iOS device plugged in. Polls `listConnectedDevices()` (Rust IPC); " +
          "in the web/Storybook build that returns null and the toast stays hidden.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof DeviceConnectedToast>;

export const WebRender: Story = {};

export const DesktopRender: Story = {
  parameters: { runtimeEnvironment: "desktop" },
};

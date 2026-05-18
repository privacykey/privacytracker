import type { Meta, StoryObj } from "@storybook/nextjs";
import DesktopAppSection from "./DesktopAppSection";

const meta: Meta<typeof DesktopAppSection> = {
  title: "I/DesktopAppSection",
  component: DesktopAppSection,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Settings section that's only visible in the Tauri desktop build. " +
          "The web build returns null. Story documents the no-op web state; " +
          "to preview the desktop chrome, set `parameters.runtimeEnvironment = 'desktop'`.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof DesktopAppSection>;

export const WebRender: Story = {};

export const DesktopRender: Story = {
  parameters: { runtimeEnvironment: "desktop" },
};
